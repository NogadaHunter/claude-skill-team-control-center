// 수집한 기록을 기간·직원·스킬별로 묶고, 토큰을 API 단가로 환산한다.
import fs from 'node:fs';
import path from 'node:path';
import { EV, fileId } from './collect.mjs';

const DAY = 86400000;
const HOUR = 3600000;
const RUNNING_WINDOW = 10 * 60000; // 끝나지 않은 직원 작업이 10분 안에 움직였으면 '진행 중'

export const GROUPS = [
  { key: 'staff', label: '직원', color: '#6250d6' },
  { key: 'lead', label: '팀장', color: '#1baf7a' },
  { key: 'builtin', label: '기본 에이전트', color: '#eda100' },
  { key: 'other', label: '그 밖의 세션', color: '#9a9893' },
];

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

const shortSkill = (s) => String(s).split(':').pop().toLowerCase();

// ~/.claude/agents/*.md 에서 직원 명부와 맡은 스킬(표 첫 칸의 `이름`)을 읽는다
export function loadRegistry(agentsDir, profiles = {}) {
  const staff = [];
  let files = [];
  try { files = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md')); } catch { /* 직원 없음 */ }
  for (const f of files) {
    const text = fs.readFileSync(path.join(agentsDir, f), 'utf8');
    const fm = /^---\s*\n([\s\S]*?)\n---/.exec(text);
    const field = (k) => (fm && new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(fm[1])?.[1].trim()) || '';
    const name = field('name') || f.slice(0, -3);
    const skills = [...new Set([...text.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map((m) => m[1]))];
    const p = (profiles.agents && profiles.agents[name]) || {};
    staff.push({
      name, description: field('description'), skills, model: field('model'), // model 이 비면 세션 모델을 그대로 쓴다
      team: p.team || '', color: p.color || '#888780',
      purpose: p.purpose || field('description'), goals: p.goals || [], workflow: p.workflow || [],
    });
  }
  const order = Object.keys(profiles.agents || {});
  const rank = (n) => (order.includes(n) ? order.indexOf(n) : order.length);
  staff.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
  return staff;
}

export function priceTable(pricing, models) {
  const fb = pricing.models[pricing.fallbackModel] || { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
  return models.map((m) => {
    const p = pricing.models[m] || pricing.models[m.replace(/-\d{8}$/, '')];
    return { p: p || fb, known: !!p };
  });
}

const emptyTok = () => ({ in: 0, out: 0, cw: 0, cr: 0, total: 0 });
function addTok(t, e) {
  t.in += e[EV.IN]; t.out += e[EV.OUT]; t.cw += e[EV.CW5] + e[EV.CW1H]; t.cr += e[EV.CR];
  t.total += e[EV.IN] + e[EV.OUT] + e[EV.CW5] + e[EV.CW1H] + e[EV.CR];
}
export function evCost(e, p) {
  return (e[EV.IN] * p.input + e[EV.OUT] * p.output + e[EV.CW5] * p.cacheWrite5m
    + e[EV.CW1H] * p.cacheWrite1h + e[EV.CR] * p.cacheRead) / 1e6;
}

/** 기록 파일 하나의 API 환산 비용 */
export function fileCost(st, pricing) {
  const prices = priceTable(pricing, st.models);
  let c = 0;
  for (const e of st.events) c += evCost(e, prices[e[EV.MODEL]].p);
  return c;
}

/** 직원 작업의 상태: 끝남 · 진행 중(10분 안에 움직임) · 중단 */
export function runStatus(st, now) {
  if (st.meta && st.meta.finished) return 'done';
  return now - st.lastTs < RUNNING_WINDOW ? 'running' : 'stopped';
}

const dayStart = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };

export function rangeStart(range, now) {
  const d = new Date(now); d.setHours(0, 0, 0, 0);
  if (range === 'today') return d.getTime();
  if (range === '7d') { d.setDate(d.getDate() - 6); return d.getTime(); }
  if (range === '30d') { d.setDate(d.getDate() - 29); return d.getTime(); }
  if (range === 'month') { d.setDate(1); return d.getTime(); } // 이번 달 1일부터(리포트용)
  return 0;
}

// 작업 폴더 이름(세션 중에 cd 하면 바뀌므로 표시용으로만 쓴다)
export function folderName(st) {
  if (st.cwd) return st.cwd.split(/[\\/]/).filter(Boolean).pop();
  return st.projectKey;
}

// 프로젝트 폴더 키는 경로의 영숫자 밖 글자를 '-'로 바꾼 것이다(C--Users-...-skill-team)
export function isProject(st, name) {
  const enc = name.replace(/[^A-Za-z0-9]/g, '-');
  return st.projectKey === enc || st.projectKey.endsWith('-' + enc);
}

function buildBuckets(range, from, now, firstTs) {
  const buckets = [];
  if (range === 'today') {
    for (let h = 0; h < 24; h++) buckets.push(from + h * HOUR);
    return { unit: 'hour', buckets };
  }
  let d = dayStart(range === 'all' ? (firstTs || now) : from);
  const end = dayStart(now);
  while (d <= end) {
    buckets.push(d);
    const n = new Date(d); n.setDate(n.getDate() + 1); d = n.getTime();
  }
  return { unit: 'day', buckets };
}

// 시각이 들어갈 칸 번호(날짜 칸은 서머타임 없이 하루씩 늘어난다고 보고 이분 탐색)
function bucketIndex(buckets, ts) {
  let lo = 0; let hi = buckets.length - 1;
  if (ts < buckets[0]) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (buckets[mid] <= ts) lo = mid; else hi = mid - 1;
  }
  return lo;
}

export function summarize({ cache, staff, profiles = {}, pricing, range = '7d', now = Date.now(), allSkills = false }) {
  const from = rangeStart(range, now);
  const staffNames = new Set(staff.map((s) => s.name));
  const leadProject = (profiles.lead && profiles.lead.project) || 'skill-team';
  const files = Object.values(cache.files);
  const firstTs = files.reduce((m, st) => (st.firstTs && (!m || st.firstTs < m) ? st.firstTs : m), 0);
  const { unit, buckets } = buildBuckets(range, from, now, firstTs);
  const sparkFrom = dayStart(now) - 13 * DAY;
  const monthFrom = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), 1).getTime();

  // 칸마다 쌓을 계열: 그룹 4개 + 직원별
  const seriesKeys = [...GROUPS.map((g) => 'g:' + g.key), ...staff.map((s) => 's:' + s.name)];
  const series = Object.fromEntries(seriesKeys.map((k) => [k, { tokens: buckets.map(() => 0), cost: buckets.map(() => 0) }]));

  const groupTot = Object.fromEntries(GROUPS.map((g) => [g.key, { tokens: emptyTok(), cost: 0 }]));
  const modelTot = {};
  const total = { tokens: emptyTok(), cost: 0 };
  let monthCost = 0;
  let unknownModels = new Set();

  const actors = {}; // key → 직원·팀장·기본 에이전트·프로젝트별 합계
  const actor = (group, key) => {
    const id = group + ':' + key;
    if (!actors[id]) {
      actors[id] = {
        group, key, tokens: emptyTok(), cost: 0, runs: 0, done: 0, open: 0, sessions: new Set(),
        prompts: 0, lastActive: 0, month: 0, spark: Array(14).fill(0), skillCalls: {}, skillCallsAll: {}, skillLast: {},
      };
    }
    return actors[id];
  };

  const skillTot = {};
  const skillRow = (name) => {
    const k = shortSkill(name);
    if (!skillTot[k]) skillTot[k] = { skill: name, calls: 0, callsAll: 0, tokens: 0, cost: 0, lastUsed: 0, callers: {} };
    return skillTot[k];
  };

  const runs = [];
  const runDurations = [];

  for (const st of files) {
    let group; let key;
    if (st.kind === 'sub') {
      key = (st.meta && st.meta.agentType) || 'unknown';
      group = staffNames.has(key) ? 'staff' : 'builtin';
    } else if (isProject(st, leadProject)) {
      group = 'lead'; key = 'lead';
    } else {
      group = 'other'; key = folderName(st);
    }
    const a = actor(group, key);
    if (st.lastTs >= from) a.sessions.add(st.sessionId);
    if (st.lastTs > a.lastActive) a.lastActive = st.lastTs;
    const prices = priceTable(pricing, st.models);
    st.models.forEach((m, i) => { if (!prices[i].known) unknownModels.add(m); });

    let fileTok = 0; let fileCost = 0;
    for (const e of st.events) {
      const ts = e[EV.TS];
      const c = evCost(e, prices[e[EV.MODEL]].p);
      const tok = e[EV.IN] + e[EV.OUT] + e[EV.CW5] + e[EV.CW1H] + e[EV.CR];
      fileTok += tok; fileCost += c;
      if (ts >= monthFrom) { monthCost += c; a.month += c; }
      if (ts >= sparkFrom) a.spark[Math.min(13, Math.floor((ts - sparkFrom) / DAY))] += c;
      if (ts < from) continue;
      addTok(a.tokens, e); a.cost += c;
      addTok(groupTot[group].tokens, e); groupTot[group].cost += c;
      addTok(total.tokens, e); total.cost += c;
      const mname = st.models[e[EV.MODEL]];
      if (!modelTot[mname]) modelTot[mname] = { model: mname, tokens: 0, cost: 0 };
      modelTot[mname].tokens += tok; modelTot[mname].cost += c;
      const bi = bucketIndex(buckets, ts);
      if (bi >= 0) {
        series['g:' + group].tokens[bi] += tok; series['g:' + group].cost[bi] += c;
        if (group === 'staff') { series['s:' + key].tokens[bi] += tok; series['s:' + key].cost[bi] += c; }
      }
      if (e[EV.SKILL] >= 0) {
        const r = skillRow(st.skills[e[EV.SKILL]]);
        r.tokens += tok; r.cost += c;
      }
    }

    for (const [ts, si] of st.skillCalls) {
      const name = st.skills[si];
      const r = skillRow(name);
      const sk = shortSkill(name);
      r.callsAll++;
      a.skillCallsAll[sk] = (a.skillCallsAll[sk] || 0) + 1;
      if (ts > (a.skillLast[sk] || 0)) a.skillLast[sk] = ts;
      if (ts > r.lastUsed) r.lastUsed = ts;
      if (ts >= from) {
        r.calls++;
        a.skillCalls[sk] = (a.skillCalls[sk] || 0) + 1;
        const who = group === 'staff' || group === 'builtin' ? key : group === 'lead' ? '팀장' : '그 밖의 세션';
        r.callers[who] = (r.callers[who] || 0) + 1;
      }
    }

    a.prompts += st.prompts.filter((ts) => ts >= from).length;

    if (st.kind === 'sub' && st.firstTs) {
      const status = runStatus(st, now);
      const run = {
        id: fileId(st), parent: st.sessionId,
        agent: key, group, description: (st.meta && st.meta.description) || '',
        start: st.firstTs, end: st.lastTs, durationMs: Math.max(0, st.lastTs - st.firstTs),
        tokens: fileTok, cost: fileCost, status, skills: [...new Set(st.skillCalls.map(([, si]) => st.skills[si]))],
        folder: folderName(st), lead: isProject(st, leadProject),
      };
      runs.push(run);
      if (st.firstTs >= from) {
        a.runs++;
        if (status === 'done') { a.done++; if (group === 'staff') runDurations.push(run.durationMs); } else a.open++;
      }
    }
  }

  // 팀장 요청 한 번(사람 요청 → 다음 요청 전까지)마다 비용·걸린 시간·맡긴 직원
  const leadTurns = [];
  for (const st of files) {
    if (st.kind !== 'main' || !isProject(st, leadProject) || !st.turns || !st.turns.length) continue;
    const prices = priceTable(pricing, st.models);
    const turns = st.turns;
    const acc = turns.map(() => ({ cost: 0, tokens: 0, end: 0 }));
    for (const e of st.events) {
      const ts = e[EV.TS];
      let lo = 0; let hi = turns.length - 1;
      if (ts < turns[0][0]) continue;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (turns[mid][0] <= ts) lo = mid; else hi = mid - 1; }
      acc[lo].cost += evCost(e, prices[e[EV.MODEL]].p);
      acc[lo].tokens += e[EV.IN] + e[EV.OUT] + e[EV.CW5] + e[EV.CW1H] + e[EV.CR];
      if (ts > acc[lo].end) acc[lo].end = ts;
    }
    turns.forEach(([ts, , prompt], i) => {
      if (ts < from) return;
      const next = i + 1 < turns.length ? turns[i + 1][0] : Infinity;
      const mine = runs.filter((r) => r.parent === st.sessionId && r.start >= ts && r.start < next);
      const end = Math.max(acc[i].end, ...mine.map((r) => r.end), ts);
      leadTurns.push({
        id: st.sessionId, at: ts, prompt, end, durationMs: end - ts, cost: acc[i].cost, tokens: acc[i].tokens,
        agents: [...new Set(mine.map((r) => r.agent))],
        status: i === turns.length - 1 && now - st.lastTs < RUNNING_WINDOW ? 'running' : 'done',
      });
    });
  }
  leadTurns.sort((x, y) => y.at - x.at);

  const fmtActor = (a) => a && ({
    tokens: a.tokens, cost: a.cost, runs: a.runs, done: a.done, open: a.open,
    sessions: a.sessions.size, prompts: a.prompts, lastActive: a.lastActive, month: a.month, spark: a.spark,
  });
  const emptyActor = { tokens: emptyTok(), cost: 0, runs: 0, done: 0, open: 0, sessions: 0, prompts: 0, lastActive: 0, month: 0, spark: Array(14).fill(0) };

  runs.sort((x, y) => y.start - x.start);
  const owners = {};
  for (const s of staff) for (const k of s.skills) owners[shortSkill(k)] = s.team || s.name;

  const staffOut = staff.map((s) => {
    const a = actors['staff:' + s.name];
    return {
      ...s,
      ...(fmtActor(a) || emptyActor),
      skills: s.skills.map((k) => {
        const sk = shortSkill(k);
        return { name: k, calls: (a && a.skillCalls[sk]) || 0, callsAll: (a && a.skillCallsAll[sk]) || 0, lastUsed: (a && a.skillLast[sk]) || 0 };
      }),
      recentRuns: runs.filter((r) => r.agent === s.name).slice(0, 12),
    };
  });

  const staffRuns = runs.filter((r) => r.group === 'staff' && r.start >= from);

  // 워크플로 지도: 사용자 → 팀장·다른 세션 → 직원·기본 에이전트 → 스킬
  const links = {};
  for (const r of runs) {
    if (r.start < from || (r.group !== 'staff' && r.group !== 'builtin')) continue;
    const src = r.lead ? 'lead' : 'other';
    const dst = r.group === 'staff' ? r.agent : 'builtin';
    const k = src + '>' + dst;
    if (!links[k]) links[k] = { from: src, to: dst, runs: 0, cost: 0, kinds: {} };
    links[k].runs++; links[k].cost += r.cost;
    if (r.group === 'builtin') links[k].kinds[r.agent] = (links[k].kinds[r.agent] || 0) + 1;
  }
  const skillLinks = [];
  for (const a of Object.values(actors)) {
    if (a.group !== 'staff' && a.group !== 'lead') continue;
    for (const [sk, calls] of Object.entries(a.skillCalls)) {
      skillLinks.push({ from: a.group === 'lead' ? 'lead' : a.key, skill: skillTot[sk] ? skillTot[sk].skill : sk, calls });
    }
  }
  const otherPrompts = Object.values(actors).reduce((sum, a) => sum + (a.group === 'other' ? a.prompts : 0), 0);
  const avgRunMs = runDurations.length ? runDurations.reduce((x, y) => x + y, 0) / runDurations.length : 0;
  const daysInMonth = new Date(new Date(now).getFullYear(), new Date(now).getMonth() + 1, 0).getDate();
  const dayOfMonth = new Date(now).getDate() - 1 + (now - dayStart(now)) / DAY;
  const usedSkills = new Set(Object.keys(skillTot).filter((k) => skillTot[k].callsAll > 0));
  const allPrompts = Object.values(actors).reduce((s, a) => s + (a.group === 'lead' || a.group === 'other' ? a.prompts : 0), 0);

  return {
    generatedAt: now, range, from, unit, buckets,
    owner: profiles.owner || '사용자', // 화면·리포트에서 사용자를 부르는 이름(예: 대표님)
    currency: { usdToKrw: pricing.usdToKrw || 0 },
    month: {
      cost: monthCost,
      projected: dayOfMonth > 0.5 ? (monthCost / dayOfMonth) * daysInMonth : null,
      budget: pricing.monthlyBudgetUsd || null,
    },
    kpi: {
      staffRuns: staffRuns.length,
      staffDone: staffRuns.filter((r) => r.status === 'done').length,
      staffRunning: staffRuns.filter((r) => r.status === 'running').length,
      staffStopped: staffRuns.filter((r) => r.status === 'stopped').length,
      avgRunMs, tokens: total.tokens, cost: total.cost, prompts: allPrompts,
    },
    groups: GROUPS.map((g) => ({ ...g, ...groupTot[g.key] })),
    models: Object.values(modelTot).sort((x, y) => y.cost - x.cost),
    unknownModels: [...unknownModels],
    series: {
      group: GROUPS.map((g) => ({ key: g.key, label: g.label, color: g.color, ...series['g:' + g.key] })),
      staff: staff.map((s) => ({ key: s.name, label: s.team || s.name, color: s.color, ...series['s:' + s.name] })),
    },
    staff: staffOut,
    lead: {
      ...(profiles.lead || { name: '팀장' }),
      ...(fmtActor(actors['lead:lead']) || emptyActor),
    },
    builtin: Object.values(actors).filter((a) => a.group === 'builtin' && (a.runs || a.cost))
      .map((a) => ({ key: a.key, ...fmtActor(a) })).sort((x, y) => y.cost - x.cost),
    others: Object.values(actors).filter((a) => a.group === 'other')
      .map((a) => ({ key: a.key, ...fmtActor(a) })).sort((x, y) => y.cost - x.cost),
    skills: Object.values(skillTot).filter((r) => r.calls > 0)
      .map((r) => ({ ...r, owner: owners[shortSkill(r.skill)] || '' }))
      .sort((x, y) => y.calls - x.calls || y.cost - x.cost),
    unusedSkills: staff.flatMap((s) => s.skills.filter((k) => !usedSkills.has(shortSkill(k))).map((k) => ({ skill: k, owner: s.team || s.name }))),
    runs: runs.filter((r) => r.group === 'staff' || r.group === 'builtin').slice(0, 60),
    leadTurns: leadTurns.slice(0, 40),
    ...(allSkills ? { skillUsage: Object.values(skillTot) } : {}), // 스킬 DB 엑셀과 짝지을 때만
    flow: {
      leadPrompts: actors['lead:lead'] ? actors['lead:lead'].prompts : 0,
      otherPrompts,
      links: Object.values(links),
      skillLinks: skillLinks.sort((x, y) => y.calls - x.calls),
    },
  };
}
