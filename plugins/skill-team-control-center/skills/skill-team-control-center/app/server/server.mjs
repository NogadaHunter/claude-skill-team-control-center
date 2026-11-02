// Claude Skill Team Control Center 로컬 서버. 127.0.0.1 에만 붙고, 외부 의존성 없이 Node.js 표준 라이브러리만 쓴다.
// 화면이 열려 있는 동안 2초마다 새 기록과 3D 사무실 상태를 읽어 SSE(/api/stream)로 밀어 준다.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { agentsDir, alertsFile, appDir, appVersion, budgetFile, cacheFile, configDir, defaultConfigDir, homeShort, officeInstalled, officeRepo, officeUrl, projectsDir, reportsDir, skilldbFile, stateDir, webDir } from './paths.mjs';
import { loadCache, pushActivity, saveCache, scanAll } from './collect.mjs';
import { loadRegistry, readJson, summarize } from './aggregate.mjs';
import { buildLive, fetchOffice } from './live.mjs';
import { patternFor, traceFor } from './trace.mjs';
import { evaluateAlerts, loadAlertState, loadBudget, markRead, mergeAlerts, normalizeBudget, saveAlertState, saveBudget } from './alerts.mjs';
import { loadSkillDb, mergeSkillDb, skillUsageXlsx } from './skilldb.mjs';
import { renderReport, reportTitle } from './report.mjs';
import { advise } from './advice.mjs';
import { findBrowser, openWindow } from './browser.mjs';

const PORT = Number(process.env.PORT) || 4790;
const HOST = '127.0.0.1';
const RESCAN_MS = 15000; // 화면이 없을 때 요약을 줄 때 이보다 오래됐으면 다시 읽는다
const TICK_LIVE_MS = 2000; // 화면이 열려 있을 때
const TICK_IDLE_MS = 20000; // 아무도 안 볼 때
const SAVE_MS = 30000; // 캐시 파일은 이 간격으로 모아서 쓴다
const RANGES = new Set(['today', '7d', '30d', 'month', 'all']);
const RANGE_LABEL = { today: '오늘', '7d': '최근 7일', '30d': '최근 30일', month: '이번 달', all: '전체 기간' };
const ALERT_EVERY_MS = 60000; // 기록이 안 바뀌어도 이 간격으로 다시 따진다(날짜·월이 바뀌니까)
const MAX_BODY = 32 * 1024;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

let cache = loadCache(cacheFile);
let ready = false;
let lastScan = 0;
let scanning = null;
let progress = { done: 0, total: 0 };
let lastError = null;
let savedRev = cache.rev;
let lastSave = Date.now();

let live = null;
let liveJson = '';
let sentRev = cache.rev;
const officeStatus = new Map(); // 사람 이름 → 직전 상태(승인 대기로 바뀐 순간을 활동으로 남긴다)
const clients = new Set();

function config() {
  const profiles = readJson(path.join(configDir, 'profiles.json'), {});
  // 단가표는 사용자가 따로 고쳐 둔 것이 있으면 그것, 없으면 앱에 딸린 최신 단가표
  const pricing = readJson(path.join(configDir, 'pricing.json'), null) || readJson(path.join(defaultConfigDir, 'pricing.json'), { models: {} });
  return {
    profiles, pricing, staff: loadRegistry(agentsDir, profiles),
    budget: loadBudget(budgetFile, pricing), skilldb: readJson(skilldbFile, {}),
  };
}

function persist(force = false) {
  if (cache.rev === savedRev) return;
  if (!force && Date.now() - lastSave < SAVE_MS) return;
  try {
    saveCache(cacheFile, cache);
    savedRev = cache.rev;
    lastSave = Date.now();
  } catch (err) {
    console.error('[Control Center] 캐시 저장 실패:', err.message);
  }
}

function scan() {
  if (scanning) return scanning;
  const first = !ready;
  scanning = scanAll({ projectsDir, cacheFile, cache, persist: false, onProgress: (done, total) => { progress = { done, total }; } })
    .then((c) => {
      cache = c; ready = true; lastScan = Date.now(); lastError = null;
      persist(first);
    })
    .catch((err) => { lastError = String(err && err.message || err); console.error('[Control Center] 기록 읽기 실패:', err); })
    .finally(() => { scanning = null; });
  return scanning;
}

// 요약 + 예산 + 스킬 한글명 + 스킬 DB 짝짓기 + 운영 제언. 관제판과 리포트가 함께 쓴다
function buildView(range) {
  const { profiles, pricing, staff, budget, skilldb } = config();
  const s = summarize({ cache, staff, profiles, pricing, range, allSkills: true });
  s.month.budget = budget.monthlyUsd;
  s.budget = budget;
  const dbRaw = loadSkillDb(skilldb);
  s.skillNames = Object.fromEntries(dbRaw.rows.map((r) => [r.id.toLowerCase(), r.name]));
  const db = dbRaw.error && !dbRaw.rows.length ? { error: dbRaw.error }
    : mergeSkillDb({ db: dbRaw, usage: s.skillUsage, usage30: s.skillUsage, staff });
  s.advice = advise({ d: s, db, cache, pricing, staff, profiles });
  delete s.skillUsage; // 화면에는 보내지 않는다(스킬 DB 탭은 /api/skilldb 로 따로 받는다)
  return { s, db, pricing };
}

async function getSummary(range) {
  if (Date.now() - lastScan > RESCAN_MS) await scan();
  return { ...buildView(range).s, officeUrl };
}

// ── 예산·이상 알림 ──
let alertState = loadAlertState(alertsFile);
let alertsOut = { alerts: [], unread: 0, fresh: [] };
let alertsSig = '';
let alertsRev = -1;
let alertsAt = 0;
let alertsFirst = true; // 서버를 켠 뒤 처음 따질 때는 바탕화면 알림을 띄우지 않는다(밀린 알림 폭탄 막기)

function checkAlerts({ force = false } = {}) {
  const now = Date.now();
  if (!ready || (!force && cache.rev === alertsRev && now - alertsAt < ALERT_EVERY_MS)) return;
  alertsRev = cache.rev;
  alertsAt = now;
  const { pricing, staff, budget } = config();
  const ev = evaluateAlerts({ cache, staff, pricing, budget, now });
  const brandNew = Object.keys(alertState.seen).length === 0;
  const m = mergeAlerts(ev.alerts, alertState, now);
  if (brandNew && m.alerts.length) { // 처음 설치했을 때 이미 지난 일들은 읽은 것으로 둔다
    markRead(alertState, m.alerts.map((a) => a.id), now);
    for (const a of m.alerts) a.read = true;
    m.unread = 0;
  }
  if (m.changed) { try { saveAlertState(alertsFile, alertState); } catch (err) { console.error('[Control Center] 알림 상태 저장 실패:', err.message); } }
  const fresh = alertsFirst ? [] : m.fresh;
  alertsFirst = false;
  alertsOut = { alerts: m.alerts, unread: m.unread, budget, month: ev.month, projected: ev.projected, staffMonth: ev.staffMonth };
  const sig = JSON.stringify(alertsOut);
  if (sig !== alertsSig || fresh.length) {
    alertsSig = sig;
    broadcast('alerts', JSON.stringify({ ...alertsOut, fresh }));
  }
}

// ── 스킬 DB 엑셀 ──
function skillDbView(range) {
  const { profiles, pricing, staff, skilldb } = config();
  const db = loadSkillDb(skilldb);
  const usage = summarize({ cache, staff, profiles, pricing, range, allSkills: true }).skillUsage;
  const usage30 = range === '30d' ? usage : summarize({ cache, staff, profiles, pricing, range: '30d', allSkills: true }).skillUsage;
  return { merged: mergeSkillDb({ db, usage, usage30, staff }), pricing };
}

// ── A4 리포트 ──
async function reportHtml(range) {
  if (Date.now() - lastScan > RESCAN_MS) await scan();
  const { s, db, pricing } = buildView(range);
  checkAlerts();
  return renderReport({ summary: s, alerts: alertsOut, db, live, rangeLabel: RANGE_LABEL[range], usdToKrw: pricing.usdToKrw, saveDir: homeShort(reportsDir) });
}

let pdfBusy = false;
async function saveReportPdf(range) {
  const browser = findBrowser({ edge: true });
  if (!browser) throw new Error('PDF를 만들 Chrome·Edge를 찾지 못했어요');
  if (pdfBusy) throw new Error('다른 PDF를 만드는 중이에요. 잠시 뒤 다시 눌러 주세요');
  pdfBusy = true;
  try {
    fs.mkdirSync(reportsDir, { recursive: true });
    const now = new Date();
    const hhmm = String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0');
    const file = `${reportTitle(RANGE_LABEL[range], now.getTime())}-${hhmm}.pdf`;
    const out = path.join(reportsDir, file);
    try { fs.unlinkSync(out); } catch { /* 같은 분에 다시 만들면 덮어쓴다 */ }
    // 따로 쓰는 프로필로 띄워야 열려 있는 Chrome 에 일을 넘기지 않고 직접 인쇄한다
    const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
      `--user-data-dir=${path.join(stateDir, 'pdf-profile')}`, '--no-pdf-header-footer', '--print-to-pdf-no-header',
      `--print-to-pdf=${out}`, `http://${HOST}:${PORT}/report?range=${range}`];
    await new Promise((resolve, reject) => {
      const p = spawn(browser, args, { stdio: 'ignore', windowsHide: true });
      const timer = setTimeout(() => { p.kill(); reject(new Error('PDF 만들기가 60초 넘게 걸려 멈췄어요')); }, 60000);
      p.on('error', (err) => { clearTimeout(timer); reject(err); });
      p.on('exit', () => { clearTimeout(timer); resolve(); });
    });
    if (!fs.existsSync(out) || fs.statSync(out).size === 0) throw new Error('PDF 파일이 만들어지지 않았어요');
    return { file, path: out, size: fs.statSync(out).size };
  } finally {
    pdfBusy = false;
  }
}

// reports 폴더 안의 PDF 만 가리키게 한다
function reportFile(name) {
  const file = path.resolve(reportsDir, String(name || ''));
  if (!file.startsWith(reportsDir + path.sep) || path.extname(file).toLowerCase() !== '.pdf' || !fs.existsSync(file)) return null;
  return file;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('너무 커요')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('JSON 이 아니에요')); } });
    req.on('error', reject);
  });
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${data}\n\n`);
}
function broadcast(event, data) {
  for (const res of clients) sse(res, event, data);
}

// 새 기록 읽기 → 3D 사무실 상태 → 실시간 상태 만들기 → 바뀌었으면 화면에 보내기
async function tick() {
  await scan();
  if (!ready) return;
  const office = await fetchOffice(officeUrl);
  const now = Date.now();
  for (const p of (office && office.people) || []) {
    const prev = officeStatus.get(p.name);
    if (p.status === 'decision' && prev !== 'decision') {
      pushActivity(cache, { t: now, k: 'wait', a: p.ask || '', p: p.name });
      cache.rev++;
    }
    officeStatus.set(p.name, p.status);
  }
  const { profiles, pricing, staff } = config();
  live = buildLive({ cache, staff, profiles, pricing, office, officeUrl, officeInstalled: officeInstalled(), officeRepo, now });
  checkAlerts();
  const json = JSON.stringify({ ...live, now: 0 });
  if (json !== liveJson) {
    liveJson = json;
    broadcast('live', JSON.stringify(live));
  }
  if (cache.rev !== sentRev) {
    sentRev = cache.rev;
    broadcast('changed', String(cache.rev));
  }
  persist();
}

let timer = null;
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    try { await tick(); } catch (err) { console.error('[Control Center] 실시간 갱신 실패:', err); }
    schedule();
  }, clients.size ? TICK_LIVE_MS : TICK_IDLE_MS);
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  // DNS 리바인딩 막기: 이 컴퓨터 주소로 들어온 요청만 받는다
  const host = (req.headers.host || '').toLowerCase();
  if (host !== `${HOST}:${PORT}` && host !== `localhost:${PORT}`) return send(res, 403, 'Forbidden', 'text/plain');
  const url = new URL(req.url, `http://${host}`);
  if (req.method === 'POST') {
    // 고치는 요청은 이 화면에서 온 것만: 다른 사이트는 이 머리글을 붙여 보낼 수 없다(CORS 사전 요청에 답하지 않으므로)
    const origin = req.headers.origin;
    if (req.headers['x-amc'] !== '1' || !String(req.headers['content-type'] || '').startsWith('application/json')
      || (origin && origin !== `http://${HOST}:${PORT}` && origin !== `http://localhost:${PORT}`)) {
      return send(res, 403, JSON.stringify({ error: '이 화면에서만 바꿀 수 있어요' }));
    }
    let body;
    try { body = await readBody(req); } catch (err) { return send(res, 400, JSON.stringify({ error: err.message })); }
    if (url.pathname === '/api/budget') {
      try {
        const { staff } = config();
        const budget = normalizeBudget(body, new Set(staff.map((x) => x.name)));
        saveBudget(budgetFile, budget);
        checkAlerts({ force: true });
        return send(res, 200, JSON.stringify({ ok: true, budget }));
      } catch (err) {
        return send(res, 400, JSON.stringify({ error: String(err.message || err) }));
      }
    }
    if (url.pathname === '/api/report/pdf') {
      if (!ready) return send(res, 503, JSON.stringify({ error: '아직 기록을 읽는 중이에요' }));
      const range = RANGES.has(body.range) ? body.range : '7d';
      try {
        const r = await saveReportPdf(range);
        console.log(`[Control Center] 리포트 PDF 저장: ${r.path}`);
        return send(res, 200, JSON.stringify({ ok: true, file: r.file, path: r.path, size: r.size }));
      } catch (err) {
        console.error('[Control Center] 리포트 PDF 실패:', err);
        return send(res, 500, JSON.stringify({ error: String(err.message || err) }));
      }
    }
    if (url.pathname === '/api/report/reveal') {
      const file = reportFile(body.file);
      if (!file) return send(res, 404, JSON.stringify({ error: '그 PDF를 찾지 못했어요' }));
      if (process.platform === 'win32') spawn('explorer.exe', [`/select,${file}`], { detached: true, stdio: 'ignore' }).unref();
      else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [reportsDir], { detached: true, stdio: 'ignore' }).unref();
      return send(res, 200, JSON.stringify({ ok: true }));
    }
    if (url.pathname === '/api/shutdown') {
      // ctl.mjs stop: 캐시를 저장하고 끈다
      send(res, 200, JSON.stringify({ ok: true }));
      persist(true);
      setTimeout(() => process.exit(0), 100);
      return;
    }
    if (url.pathname === '/api/alerts/read') {
      const ids = body.all ? alertsOut.alerts.map((a) => a.id) : Array.isArray(body.ids) ? body.ids.map(String) : [];
      const n = markRead(alertState, ids);
      if (n) { try { saveAlertState(alertsFile, alertState); } catch { /* 다음에 다시 저장 */ } }
      checkAlerts({ force: true });
      return send(res, 200, JSON.stringify({ ok: true, read: n, unread: alertsOut.unread }));
    }
    return send(res, 404, JSON.stringify({ error: 'Not found' }));
  }
  if (req.method !== 'GET') return send(res, 405, 'Method Not Allowed', 'text/plain');

  if (url.pathname === '/api/summary') {
    if (!ready) {
      scan();
      return send(res, 200, JSON.stringify({ loading: true, progress, error: lastError }));
    }
    const range = RANGES.has(url.searchParams.get('range')) ? url.searchParams.get('range') : '7d';
    try {
      return send(res, 200, JSON.stringify(await getSummary(range)));
    } catch (err) {
      console.error('[Control Center] 집계 실패:', err);
      return send(res, 500, JSON.stringify({ error: String(err && err.message || err) }));
    }
  }
  if (url.pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store',
      Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff',
    });
    res.write('retry: 3000\n\n');
    if (live) sse(res, 'live', JSON.stringify(live));
    if (ready) sse(res, 'alerts', JSON.stringify({ ...alertsOut, fresh: [] }));
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    if (clients.size === 1) { clearTimeout(timer); tick().catch(() => {}).finally(schedule); } // 첫 화면이면 바로 갱신
    return;
  }
  if (url.pathname === '/api/trace' || url.pathname === '/api/pattern') {
    if (!ready) return send(res, 503, JSON.stringify({ loading: true, progress }));
    const { profiles, pricing, staff } = config();
    const q = url.searchParams;
    try {
      const out = url.pathname === '/api/trace'
        ? await traceFor({ cache, staff, profiles, pricing, id: q.get('id'), at: q.get('at') })
        : await patternFor({ cache, staff, profiles, pricing, agent: q.get('agent') || '' });
      return out ? send(res, 200, JSON.stringify(out)) : send(res, 404, JSON.stringify({ error: '그 실행 기록을 찾지 못했어요' }));
    } catch (err) {
      console.error('[Control Center] 트레이스 실패:', err);
      return send(res, 500, JSON.stringify({ error: String(err && err.message || err) }));
    }
  }
  if (url.pathname === '/report') {
    if (!ready) return send(res, 503, '아직 기록을 읽는 중이에요. 잠시 뒤 새로 고쳐 주세요.', 'text/plain; charset=utf-8');
    const range = RANGES.has(url.searchParams.get('range')) ? url.searchParams.get('range') : '7d';
    try {
      return send(res, 200, await reportHtml(range), 'text/html; charset=utf-8');
    } catch (err) {
      console.error('[Control Center] 리포트 실패:', err);
      return send(res, 500, '리포트를 만들지 못했어요: ' + String(err && err.message || err), 'text/plain; charset=utf-8');
    }
  }
  if (url.pathname.startsWith('/reports/')) {
    const file = reportFile(decodeURIComponent(url.pathname.slice('/reports/'.length)));
    if (!file) return send(res, 404, 'Not found', 'text/plain');
    res.writeHead(200, {
      'Content-Type': 'application/pdf', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `inline; filename="report.pdf"; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,
    });
    return fs.createReadStream(file).pipe(res);
  }
  if (url.pathname === '/api/alerts') {
    if (!ready) return send(res, 503, JSON.stringify({ loading: true }));
    checkAlerts();
    return send(res, 200, JSON.stringify(alertsOut));
  }
  if (url.pathname === '/api/skilldb' || url.pathname === '/api/export/skills.xlsx') {
    if (!ready) return send(res, 503, JSON.stringify({ loading: true }));
    const range = RANGES.has(url.searchParams.get('range')) ? url.searchParams.get('range') : '30d';
    try {
      const { merged, pricing } = skillDbView(range);
      if (url.pathname === '/api/skilldb') return send(res, 200, JSON.stringify({ ...merged, range }));
      if (merged.error && !merged.rows.length) return send(res, 404, JSON.stringify({ error: merged.error }));
      const buf = skillUsageXlsx(merged, { rangeLabel: RANGE_LABEL[range], usdToKrw: pricing.usdToKrw });
      const d = new Date();
      const name = `스킬사용현황_${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.xlsx`;
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="skill-usage.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      });
      return res.end(buf);
    } catch (err) {
      console.error('[Control Center] 스킬 DB 실패:', err);
      return send(res, 500, JSON.stringify({ error: String(err && err.message || err) }));
    }
  }
  if (url.pathname === '/api/live') {
    if (!live) await tick();
    return send(res, 200, JSON.stringify(live || { loading: true }));
  }
  if (url.pathname === '/api/health') return send(res, 200, JSON.stringify({ ok: true, app: 'claude-skill-team-control-center', version: appVersion, appDir, ready, lastScan, clients: clients.size, progress, configDir, reportsDir }));

  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(webDir, rel);
  if (!file.startsWith(webDir + path.sep) || !TYPES[path.extname(file)] || !fs.existsSync(file)) {
    return send(res, 404, 'Not found', 'text/plain');
  }
  send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)]);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // 이미 켜져 있으면 창만 연다
    console.error(`[Control Center] ${PORT} 포트에서 이미 켜져 있어요: http://${HOST}:${PORT}`);
    if (process.argv.includes('--open')) { openWindow(`http://${HOST}:${PORT}`); process.exit(0); }
  } else console.error('[Control Center] 서버 오류:', err);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(sig, () => { persist(true); process.exit(0); });
}

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`[Control Center] ${url} 에서 열려 있어요. 기록 폴더: ${projectsDir}`);
  scan().then(() => {
    console.log(`[Control Center] 기록 읽기 끝 (${Object.keys(cache.files).length}개 파일)`);
    checkAlerts({ force: true });
    schedule();
  });
  if (process.argv.includes('--open')) openWindow(url);
});
