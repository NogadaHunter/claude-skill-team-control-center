// Claude Skill Team Control Center 조작 도구. 스킬(SKILL.md)이 Claude 에게 이 명령을 쓰게 하고, 사람이 터미널에서 써도 된다.
// 서버가 꺼져 있으면 알아서 켠다(처음이면 설정도 만든다). 결과는 Claude 가 그대로 전하기 좋은 한국어 글로 찍는다.
//   node scripts/ctl.mjs help
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { agentsDir, appDir, appVersion, claudeDir, configDir, logFile, projectsDir, reportsDir, stateDir } from '../server/paths.mjs';
import { findBrowser, openWindow } from '../server/browser.mjs';
import { dur, krw as krwText, pct, prettyModel, tok, usd } from '../server/fmt.mjs';
import { loadRegistry, readJson } from '../server/aggregate.mjs';
import { runSetup, setupReport } from './setup.mjs';

const APP = 'Claude Skill Team Control Center';
const PORT = Number(process.env.PORT) || 4790;
const BASE = `http://127.0.0.1:${PORT}`;
const RANGES = { today: '오늘', '7d': '최근 7일', '30d': '최근 30일', month: '이번 달', all: '전체 기간' };
const LEVEL = { high: '우선', mid: '권장', low: '참고', bad: '넘음', warn: '주의', info: '알림' };
const MODEL_OK = /^(opus|sonnet|haiku|fable|inherit|claude-[a-z0-9.-]+)$/;

const HELP = `${APP} — 조작 도구

  node scripts/ctl.mjs <명령> [옵션]

  start [--no-open]        서버 켜기(처음이면 설정부터) + 관제판 창 열기
  open                     관제판 창 열기
  stop                     서버 끄기
  status [--range 7d]      현황 요약(비용·직원·이번 달 예산·지금 상태·알림·우선 제언)
  staff [--range 7d]       직원별 현황
  advice [--range 7d]      운영 제언 전부(근거·실행·기대 효과)
  alerts [--read all]      알림 목록(--read all 이면 모두 읽음)
  budget                   예산 보기
  budget --monthly 500 [--run 5] [--warn 50,80,100] [--spike 3] [--min 20] [--staff 이름=20,…]
                           예산·알림 기준 정하기(빈 값 '' 이면 그 알림 끔)
  report [--range month] [--open]   A4 리포트 PDF 저장(경로를 알려 줌)
  export-skills [--range 30d] [--out 파일.xlsx]   스킬 사용 현황 엑셀 저장
  skills                   스킬 목록 점검(확인할 것·DB 밖 스킬)
  model <직원|all> <opus|sonnet|haiku|claude-…|default>   직원 모델 바꾸기(새 세션부터)
  setup [--owner 대표님] [--lead 폴더] [--skilldb 엑셀] [--force]   설정 만들기·새 직원 더하기
  doctor                   설치·환경 점검

  기간(--range): today · 7d · 30d · month · all`;

// ── 인자 ──
const argv = process.argv.slice(2);
const cmd = argv[0] || 'help';
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const flag = (k) => argv.includes('--' + k);
const range = () => { const r = opt('range', '7d'); if (!RANGES[r]) throw new Error(`기간은 ${Object.keys(RANGES).join(' · ')} 중 하나예요`); return r; };

// ── 서버 ──
async function health() {
  try {
    const res = await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(1500) });
    const j = await res.json();
    return j && j.ok ? j : null;
  } catch {
    return null;
  }
}

async function ensureServer({ open = false } = {}) {
  let h = await health();
  if (h && h.app === 'claude-skill-team-control-center' && h.version !== appVersion) {
    // 플러그인·스킬을 새 판으로 바꿨는데 예전 판 서버가 돌고 있으면 끄고 이 판으로 다시 켠다
    console.log(`예전 판(${h.version || '1.0.0'}) 서버를 끄고 ${appVersion} 판으로 다시 켜요.`);
    await post('/api/shutdown', {}).catch(() => {});
    for (let i = 0; i < 20 && (await health()); i++) await new Promise((r) => setTimeout(r, 300));
    h = null;
  }
  if (h) {
    if (open) openWindow(BASE);
    if (h.ready) return h;
  } else {
    if (!fs.existsSync(path.join(configDir, 'profiles.json'))) {
      console.log('처음이라 설정부터 만들어요.\n' + setupReport(runSetup({})) + '\n');
    }
    fs.mkdirSync(stateDir, { recursive: true });
    const out = fs.openSync(logFile, 'a');
    spawn(process.execPath, [path.join(appDir, 'server', 'server.mjs'), ...(open ? ['--open'] : [])], {
      detached: true, stdio: ['ignore', out, out], windowsHide: true, env: process.env,
    }).unref();
  }
  // 처음에는 대화 기록을 다 읽느라 시간이 걸린다(1GB 에 20초쯤)
  const t0 = Date.now();
  let said = 0;
  while (Date.now() - t0 < 300000) {
    await new Promise((r) => setTimeout(r, 700));
    h = await health();
    if (h && h.ready) return h;
    if (Date.now() - said > 5000) {
      said = Date.now();
      const p = h && h.progress;
      console.log(h ? `대화 기록을 읽는 중… ${p && p.total ? Math.round((p.done / p.total) * 100) + '%' : ''}` : '서버를 켜는 중…');
    }
  }
  throw new Error(`서버가 켜지지 않았어요. 로그: ${logFile}\n${PORT} 포트를 다른 프로그램이 쓰고 있으면 PORT=4791 처럼 다른 포트로 실행해 주세요.`);
}

async function getJSON(p) {
  for (let i = 0; i < 400; i++) {
    const res = await fetch(BASE + p);
    const j = await res.json();
    if (!j.loading) { if (j.error) throw new Error(j.error); return j; }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error('서버가 아직 기록을 읽고 있어요. 잠시 뒤 다시 해 주세요.');
}

async function post(p, body) {
  const res = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AMC': '1' }, body: JSON.stringify(body) });
  const j = await res.json();
  if (!res.ok || j.error) throw new Error(j.error || `요청 실패(${res.status})`);
  return j;
}

const ago = (ts) => {
  if (!ts) return '기록 없음';
  const d = Date.now() - ts;
  if (d < 60000) return '방금';
  if (d < 3600000) return Math.floor(d / 60000) + '분 전';
  if (d < 86400000) return Math.floor(d / 3600000) + '시간 전';
  return Math.floor(d / 86400000) + '일 전';
};
const krw = (d, n) => (d.currency && d.currency.usdToKrw && n ? ` (${krwText(n, d.currency.usdToKrw)})` : '');
const openFile = (file) => {
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', file], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [file], { detached: true, stdio: 'ignore' }).unref();
};

// ── 명령 ──
async function status() {
  const r = range();
  await ensureServer();
  const [d, L, A] = await Promise.all([getJSON(`/api/summary?range=${r}`), getJSON('/api/live'), getJSON('/api/alerts')]);
  const k = d.kpi;
  const m = d.month;
  const busy = d.staff.filter((s) => s.runs).length;
  const working = Object.entries(L.staff || {}).filter(([, s]) => s.state === 'working')
    .map(([n, s]) => `${(d.staff.find((x) => x.name === n) || {}).team || n}${s.desc ? `(${s.desc})` : ''}`);
  const unread = A.alerts.filter((a) => !a.read);
  const lines = [
    `${APP} · ${RANGES[r]}`,
    `· API 환산 비용 ${usd(k.cost)}${krw(d, k.cost)} · 토큰 ${tok(k.tokens.total)}(캐시 읽기 ${pct(k.tokens.cr, k.tokens.total)}%)`,
    `· 직원 ${d.staff.length}명 중 ${busy}명 가동 · 작업 ${k.staffRuns}건(완료 ${k.staffDone}, 진행 ${k.staffRunning}, 중단 ${k.staffStopped}) · 평균 ${dur(k.avgRunMs)}`,
    `· ${d.owner || '사용자'} 요청 ${k.prompts.toLocaleString()}회(팀장에게 ${d.lead.prompts || 0}회)`,
    `· 이번 달 ${usd(m.cost)}${m.budget ? ` / 예산 ${usd(m.budget)}(${pct(m.cost, m.budget)}%)` : '(월 예산 없음)'}${m.projected != null ? ` · 월말 예상 ${usd(m.projected)}` : ''}`,
    `· 지금: 일하는 중 ${L.counts.working}${working.length ? ` — ${working.join(', ')}` : ''} · 승인 대기 ${L.office.up ? L.counts.decision : '알 수 없음(3D 사무실 꺼짐)'}`,
    `· 읽지 않은 알림 ${unread.length}건${unread.length ? ': ' + unread.slice(0, 3).map((a) => a.title).join(' / ') : ''}`,
    ...(d.advice && d.advice.length ? ['· 우선 제언:', ...d.advice.slice(0, 3).map((a, i) => `  ${i + 1}. [${LEVEL[a.level]}] ${a.title}`)] : []),
    `관제판: ${BASE}`,
  ];
  console.log(lines.join('\n'));
}

async function staff() {
  const r = range();
  await ensureServer();
  const [d, L] = await Promise.all([getJSON(`/api/summary?range=${r}`), getJSON('/api/live')]);
  console.log(`직원 ${d.staff.length}명 · ${RANGES[r]}`);
  for (const s of d.staff) {
    const l = L.staff && L.staff[s.name];
    const usedSkills = s.skills.filter((x) => x.calls > 0).length;
    console.log(`- ${s.team || s.name}(${s.name} · ${s.model ? prettyModel(s.model) : '세션 모델'}) — 작업 ${s.runs}건 · ${usd(s.cost)} · 토큰 ${tok(s.tokens.total)} · 이번 달 ${usd(s.month)} · 마지막 ${ago(s.lastActive)}${l && l.state === 'working' ? ` · 지금 일하는 중${l.desc ? `: ${l.desc}` : ''}` : ''}`);
    console.log(`  목적: ${s.purpose || '—'} · 맡은 스킬 ${s.skills.length}개(이 기간 쓴 것 ${usedSkills}개)`);
  }
}

async function advice() {
  const r = range();
  await ensureServer();
  const d = await getJSON(`/api/summary?range=${r}`);
  if (!d.advice || !d.advice.length) { console.log(`${RANGES[r]} 기록으로는 따로 드릴 제언이 없어요.`); return; }
  console.log(`운영 제언 ${d.advice.length}가지 · ${RANGES[r]}`);
  d.advice.forEach((a, i) => {
    console.log(`\n${i + 1}. [${LEVEL[a.level]}·${a.area}] ${a.title}\n   근거: ${a.evidence}`);
    for (const x of a.actions) console.log(`   - ${x}`);
    console.log(`   기대 효과: ${a.effect}`);
  });
}

async function alerts() {
  await ensureServer();
  if (opt('read') === 'all') { const j = await post('/api/alerts/read', { all: true }); console.log(`알림 ${j.read}건을 읽음으로 했어요.`); return; }
  const A = await getJSON('/api/alerts');
  if (!A.alerts.length) { console.log('지금 켜진 알림이 없어요.'); return; }
  console.log(`알림 ${A.alerts.length}건(새 알림 ${A.unread}건)`);
  for (const a of [...A.alerts].sort((x, y) => Number(x.read) - Number(y.read))) {
    console.log(`- [${LEVEL[a.level] || a.level}]${a.read ? '' : ' 새'} ${a.title} — ${a.body}`);
  }
}

async function budget() {
  await ensureServer();
  const A = await getJSON('/api/alerts');
  const b = { ...A.budget };
  const keys = { monthly: 'monthlyUsd', run: 'runUsd', warn: 'warnAt', spike: 'dailySpike', min: 'dailyMinUsd' };
  let changed = false;
  for (const [k, field] of Object.entries(keys)) {
    const v = opt(k);
    if (v !== undefined) { b[field] = v; changed = true; }
  }
  const st = opt('staff');
  if (st !== undefined) {
    b.staff = { ...(b.staff || {}) };
    for (const pair of st.split(',').filter(Boolean)) {
      const [name, v] = pair.split('=');
      if (!v) delete b.staff[name.trim()]; else b.staff[name.trim()] = v.trim();
    }
    changed = true;
  }
  const show = (x) => [
    `월 예산: ${x.monthlyUsd ? usd(x.monthlyUsd) : '없음'} · 알림 단계: ${(x.warnAt || []).join(', ')}%`,
    `비싼 작업 기준: ${x.runUsd ? usd(x.runUsd) : '끔'} · 갑자기 많이 쓴 날: ${x.dailySpike ? `평소의 ${x.dailySpike}배 이상, ${usd(x.dailyMinUsd || 0)} 이상` : '끔'}`,
    `직원별 월 예산: ${Object.entries(x.staff || {}).map(([n, v]) => `${n} ${usd(Number(v))}`).join(', ') || '없음'}`,
  ].join('\n');
  if (!changed) { console.log(show(b) + `\n(이번 달 ${usd(A.month || 0)} 사용 · 바꾸려면 budget --monthly 500 처럼)`); return; }
  const r = await post('/api/budget', b);
  console.log('예산을 저장했어요.\n' + show(r.budget));
}

async function report() {
  const r = opt('range', 'month');
  if (!RANGES[r]) throw new Error(`기간은 ${Object.keys(RANGES).join(' · ')} 중 하나예요`);
  await ensureServer();
  console.log(`A4 리포트(${RANGES[r]})를 만들고 있어요…`);
  const j = await post('/api/report/pdf', { range: r });
  console.log(`저장했어요: ${j.path}`);
  if (flag('open')) openFile(j.path);
}

async function exportSkills() {
  const r = opt('range', '30d');
  if (!RANGES[r]) throw new Error(`기간은 ${Object.keys(RANGES).join(' · ')} 중 하나예요`);
  await ensureServer();
  const res = await fetch(`${BASE}/api/export/skills.xlsx?range=${r}`);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `내보내기 실패(${res.status})`);
  const d = new Date();
  const out = opt('out') || path.join(reportsDir, `스킬사용현황_${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.xlsx`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  console.log(`저장했어요: ${out}`);
}

async function skills() {
  await ensureServer();
  const S = await getJSON('/api/skilldb?range=30d');
  const c = S.counts || {};
  console.log(`${S.name || '스킬 목록'} · 스킬 ${c.skills || 0}개(운영 중 ${c.live || 0}) · 최근 30일 쓴 스킬 ${c.used || 0}개 · 확인할 것 ${c.flagged || 0}개 · DB 밖 스킬 ${c.missing || 0}개`);
  const used = (S.rows || []).filter((x) => x.calls).sort((a, b) => b.calls - a.calls).slice(0, 8);
  if (used.length) console.log('많이 쓴 스킬: ' + used.map((x) => `${x.name || x.id} ${x.calls}회`).join(', '));
  for (const x of (S.rows || []).filter((y) => y.flags.length).slice(0, 15)) console.log(`- 확인: ${x.name || x.id}(${x.id}) — ${x.flags.map((f) => f.t).join(' / ')}`);
  const missing = (S.missing || []).slice(0, 10);
  if (missing.length) console.log('DB 밖 스킬: ' + missing.map((x) => `${x.key}${x.callsAll ? ` ${x.callsAll}회` : ''}${x.owner ? `(${x.owner})` : ''}`).join(', '));
}

function model() {
  const who = argv[1];
  const value = argv[2];
  if (!who || !value) throw new Error('쓰는 법: model <직원 이름|all> <opus|sonnet|haiku|claude-…|default>');
  const remove = value === 'default' || value === 'none';
  if (!remove && !MODEL_OK.test(value)) throw new Error(`모델 값이 맞지 않아요: ${value} (opus·sonnet·haiku·fable·inherit 또는 claude-opus-5-5 같은 전체 이름)`);
  const staffList = loadRegistry(agentsDir, {});
  const targets = who === 'all' ? staffList : staffList.filter((s) => s.name === who);
  if (!targets.length) throw new Error(`그런 직원이 없어요: ${who} (있는 직원: ${staffList.map((s) => s.name).join(', ')})`);
  for (const s of targets) {
    const file = path.join(agentsDir, s.name + '.md');
    const text = fs.readFileSync(file, 'utf8');
    const nl = text.includes('\r\n') ? '\r\n' : '\n';
    if (!text.startsWith('---')) { console.log(`- ${s.name}: 머리(---)가 없어 건너뜀`); continue; }
    const end = text.indexOf(nl + '---', 3);
    let head = text.slice(0, end);
    // 줄 끝(CRLF·LF)은 그대로 두고 model 값만 바꾼다
    if (/^model:/m.test(head)) head = remove ? head.replace(/\r?\nmodel:[^\r\n]*/, '') : head.replace(/^model:[^\r\n]*/m, `model: ${value}`);
    else if (!remove) head += `${nl}model: ${value}`;
    fs.writeFileSync(file, head + text.slice(end));
    console.log(`- ${s.name}: ${remove ? '세션 모델 따름(model 줄 지움)' : `model: ${value}`}`);
  }
  console.log('새 Claude Code 세션부터 적용돼요.');
}

async function doctor() {
  const [major] = process.versions.node.split('.').map(Number);
  const h = await health();
  const staffList = loadRegistry(agentsDir, readJson(path.join(configDir, 'profiles.json'), {}));
  let projects = 0;
  try { projects = fs.readdirSync(projectsDir).length; } catch { /* 없음 */ }
  const lines = [
    `Node.js ${process.versions.node} ${major >= 18 ? '✓' : '✗ 18 이상이 필요해요'}`,
    `Claude 폴더: ${claudeDir} ${fs.existsSync(claudeDir) ? '✓' : '✗ 없음(Claude Code 를 한 번 써야 생겨요)'}`,
    `대화 기록: 프로젝트 ${projects}개(${projectsDir})`,
    `직원: ${staffList.length}명${staffList.length ? ' — ' + staffList.map((s) => s.name).join(', ') : '(~/.claude/agents 에 직원 .md 를 만들면 나타나요)'}`,
    `설정 폴더: ${configDir} ${fs.existsSync(path.join(configDir, 'profiles.json')) ? '✓' : '(아직 없음 — setup 또는 start 가 만들어요)'}`,
    `리포트 폴더: ${reportsDir}`,
    `PDF 만들 브라우저: ${findBrowser({ edge: true }) || '없음(인쇄 창의 PDF로 저장은 돼요)'}`,
    `서버: ${h ? `켜짐 ${BASE}${h.ready ? '' : ' (기록 읽는 중)'}` : `꺼짐 — start 로 켜요`}`,
  ];
  console.log(lines.join('\n'));
}

async function main() {
  switch (cmd) {
    case 'start': await ensureServer({ open: !flag('no-open') }); console.log(`켜져 있어요: ${BASE}`); break;
    case 'open': await ensureServer({ open: true }); console.log(`관제판 창을 열었어요: ${BASE}`); break;
    case 'stop':
      if (!(await health())) { console.log('이미 꺼져 있어요.'); break; }
      await post('/api/shutdown', {});
      console.log('서버를 껐어요.');
      break;
    case 'status': await status(); break;
    case 'staff': await staff(); break;
    case 'advice': await advice(); break;
    case 'alerts': await alerts(); break;
    case 'budget': await budget(); break;
    case 'report': await report(); break;
    case 'export-skills': await exportSkills(); break;
    case 'skills': await skills(); break;
    case 'model': model(); break;
    case 'setup': console.log(setupReport(runSetup({ owner: opt('owner'), lead: opt('lead'), skilldb: opt('skilldb'), force: flag('force') }))); break;
    case 'doctor': await doctor(); break;
    default: console.log(HELP);
  }
}

main().catch((err) => {
  console.error('실패: ' + (err.message || err));
  process.exit(1);
});
