// 실시간 상태: 3D 사무실 API(/api/office)의 세션 상태 + 우리 기록의 진행 중 작업과 활동을 합친다.
// 3D 사무실이 꺼져 있어도 대화 기록만으로 '일하는 중'은 판단한다(승인 대기는 사무실 훅이 있어야 안다).
import http from 'node:http';
import { fileId } from './collect.mjs';
import { fileCost, folderName, isProject } from './aggregate.mjs';

const RUNNING_MS = 10 * 60000; // 끝나지 않은 직원 작업이 10분 안에 움직였으면 일하는 중
const LEAD_ACTIVE_MS = 3 * 60000; // 사무실이 꺼졌을 때 팀장 세션이 3분 안에 움직였으면 일하는 중
const FEED_N = 80;

/** 3D 사무실 서버에서 사람(프로젝트)별 상태를 가져온다. 꺼져 있으면 null */
export function fetchOffice(baseUrl, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(baseUrl + '/api/office', { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';

/** 기록 파일 하나가 누구 것인지 */
export function whoOf(st, staffNames, leadProject) {
  if (st.kind === 'sub') {
    const key = (st.meta && st.meta.agentType) || 'unknown';
    return { group: staffNames.has(key) ? 'staff' : 'builtin', key };
  }
  if (isProject(st, leadProject)) return { group: 'lead', key: 'lead' };
  return { group: 'other', key: folderName(st) };
}

export function buildLive({ cache, staff, profiles = {}, pricing, office, officeUrl, officeInstalled = false, officeRepo = '', now = Date.now() }) {
  const staffNames = new Set(staff.map((s) => s.name));
  const leadProject = (profiles.lead && profiles.lead.project) || 'skill-team';

  // 파일별 마지막 활동(지금 하는 일)
  const lastAct = new Map();
  for (let i = cache.activity.length - 1; i >= 0; i--) {
    const a = cache.activity[i];
    if (a.f && !lastAct.has(a.f) && a.k !== 'start' && a.k !== 'done' && a.k !== 'prompt') lastAct.set(a.f, a);
  }

  const staffLive = Object.fromEntries(staff.map((s) => [s.name, { state: 'idle', doing: null, desc: '', since: 0, running: 0 }]));
  const builtinRunning = [];
  let leadFallback = 0;

  for (const [file, st] of Object.entries(cache.files)) {
    if (st.kind === 'main') {
      if (isProject(st, leadProject) && st.lastTs > leadFallback) leadFallback = st.lastTs;
      continue;
    }
    if (st.meta && st.meta.finished) continue;
    if (!st.lastTs || now - st.lastTs > RUNNING_MS) continue;
    const who = whoOf(st, staffNames, leadProject);
    const act = lastAct.get(file);
    const item = { desc: (st.meta && st.meta.description) || '', since: st.firstTs, doing: act ? { k: act.k, a: act.a } : null };
    if (who.group === 'staff') {
      const s = staffLive[who.key];
      s.state = 'working'; s.running++;
      if (!s.since || item.since > s.since) Object.assign(s, item);
    } else {
      builtinRunning.push({ key: who.key, ...item });
    }
  }

  // 3D 사무실이 켜져 있으면 그쪽 판단(훅·생존 판정)을 함께 쓴다.
  // 사무실은 서브에이전트 meta 의 finished 를 보지 않아 끝난 직원을 30분까지 일하는 중으로 둔다 → 우리 기록으로 걸러 낸다.
  const finishedSubs = new Set();
  for (const st of Object.values(cache.files)) if (st.kind === 'sub' && st.meta && st.meta.finished) finishedSubs.add(st.agentId);
  const liveSubs = (p) => (p.subs || []).filter((s) => !finishedSubs.has('agent-' + s.id));
  const people = (office && Array.isArray(office.people) ? office.people : [])
    .map((p) => ({ ...p, subs: liveSubs(p), subCount: Math.max(0, (p.subCount || 0) - ((p.subs || []).length - liveSubs(p).length)) }));
  const counts = { working: 0, decision: 0, rest: 0 };
  let lead = { state: now - leadFallback < LEAD_ACTIVE_MS ? 'working' : 'rest', doing: null, ask: '', lastActive: leadFallback };
  for (const p of people) {
    if (counts[p.status] != null) counts[p.status]++;
    if (baseName(p.path || p.name) === leadProject) {
      lead = { state: p.status, doing: p.doing || null, ask: p.ask || '', lastActive: leadFallback };
    }
    for (const sub of p.subs || []) {
      const s = staffLive[sub.type];
      if (!s) continue;
      s.state = 'working';
      if (!s.running) s.running = 1;
      if (sub.doing) s.doing = sub.doing;
      if (sub.desc && !s.desc) s.desc = sub.desc;
    }
  }
  // '일하는 중' = 일하는 세션(사무실이 꺼졌으면 팀장 세션만) + 일하는 직원·서브에이전트
  const subsWorking = Object.values(staffLive).filter((s) => s.state === 'working').length + builtinRunning.length;
  counts.sessions = office ? counts.working : lead.state === 'working' ? 1 : 0;
  counts.subs = subsWorking;
  counts.working = counts.sessions + subsWorking;

  // 활동 기록 — 최신이 앞. 전체(feed)와 직원·팀장·승인 대기만(feedTeam)을 따로 채운다.
  const feed = [];
  const feedTeam = [];
  const acts = cache.activity;
  for (let i = acts.length - 1; i >= 0 && (feed.length < FEED_N || feedTeam.length < FEED_N); i--) {
    const a = acts[i];
    let who;
    let extra = {};
    if (a.f) {
      const st = cache.files[a.f];
      if (!st) continue;
      who = whoOf(st, staffNames, leadProject);
      extra.ref = { id: fileId(st), at: a.t }; // 누르면 이 실행의 단계 타임라인을 연다
      if (a.k === 'done') Object.assign(extra, { dur: Math.max(0, st.lastTs - st.firstTs), cost: fileCost(st, pricing) });
    } else {
      who = { group: 'office', key: a.p || '' };
    }
    const item = { t: a.t, k: a.k, a: a.a, to: a.to, who, ...extra };
    if (feed.length < FEED_N) feed.push(item);
    if (feedTeam.length < FEED_N && (who.group === 'staff' || who.group === 'lead' || who.group === 'office')) feedTeam.push(item);
  }

  return {
    now,
    office: { up: !!office, hooks: !!(office && office.hooks), url: officeUrl, installed: !!office || officeInstalled, repo: officeRepo },
    counts,
    staff: staffLive,
    lead,
    builtin: builtinRunning,
    people: people.map((p) => ({
      name: p.name, path: p.path, status: p.status, pending: p.pending || 0, ask: p.ask || '',
      sessions: p.sessions || 0, source: p.source, doing: p.doing || null,
      subs: (p.subs || []).map((s) => ({ type: s.type, desc: s.desc, doing: s.doing || null })),
      subCount: p.subCount || 0, log: (p.log || []).slice(-8),
      lead: baseName(p.path || p.name) === leadProject,
    })),
    feed,
    feedTeam,
  };
}
