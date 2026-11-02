// 예산·이상 알림. 기록(캐시)과 예산 설정(config/budget.json)으로 지금 켜져 있어야 할 알림을 만든다.
// 알림마다 고정 id 가 있어서 처음 본 때·읽은 때를 상태 파일(~/.agent-mission-control/alerts.json)에 남긴다.
import fs from 'node:fs';
import path from 'node:path';
import { EV, fileId } from './collect.mjs';
import { evCost, fileCost, priceTable, runStatus } from './aggregate.mjs';

const DAY = 86400000;
const RUN_LOOKBACK = 7 * DAY; // 비싼 작업은 최근 7일 안에 시작한 것만
const STOP_LOOKBACK = 2 * DAY; // 멈춘 작업은 최근 이틀 안에 움직인 것만
const KEEP_STATE = 60 * DAY;

export const DEFAULT_BUDGET = {
  monthlyUsd: null, // 이번 달 전체 예산(API 환산 달러). null 이면 예산 알림을 끈다
  warnAt: [50, 80, 100], // 이 비율(%)을 넘을 때마다 알린다
  staff: {}, // 직원별 월 예산 { 'report-manager': 20 }
  runUsd: 5, // 직원 작업 한 건이 이 금액을 넘으면 알린다(null=끔)
  dailySpike: 3, // 오늘 비용이 최근 7일 하루 평균의 이 배수를 넘으면 알린다(null=끔)
  dailyMinUsd: 20, // …그리고 오늘 비용이 이 금액 이상일 때만
};

const num = (v, { min = 0, max = 1e7 } = {}) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`숫자가 맞지 않아요: ${v}`);
  return Math.round(n * 100) / 100;
};

/** 화면에서 받은 예산 설정을 검사해 깔끔한 모양으로. 틀리면 Error */
export function normalizeBudget(raw, staffNames = null) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const out = { ...DEFAULT_BUDGET };
  if ('monthlyUsd' in r) out.monthlyUsd = num(r.monthlyUsd);
  if ('warnAt' in r) {
    const list = (Array.isArray(r.warnAt) ? r.warnAt : String(r.warnAt).split(/[\s,]+/)).filter((x) => x !== '');
    const nums = [...new Set(list.map((x) => num(x, { min: 1, max: 300 })))].sort((a, b) => a - b);
    if (!nums.length || nums.length > 6) throw new Error('알림 단계는 1~6개로 적어 주세요');
    out.warnAt = nums;
  }
  if ('runUsd' in r) out.runUsd = num(r.runUsd);
  if ('dailySpike' in r) out.dailySpike = num(r.dailySpike, { min: 1.2, max: 100 });
  if ('dailyMinUsd' in r) out.dailyMinUsd = num(r.dailyMinUsd) ?? 0;
  out.staff = {};
  for (const [k, v] of Object.entries(r.staff && typeof r.staff === 'object' ? r.staff : {})) {
    if (staffNames && !staffNames.has(k)) continue; // 명부에 없는 직원은 버린다
    const n = num(v);
    if (n) out.staff[k] = n;
  }
  return out;
}

/** config/budget.json. 없으면 예전 pricing.json 의 monthlyBudgetUsd 를 이어받는다 */
export function loadBudget(file, pricing = {}) {
  try {
    return normalizeBudget(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return { ...DEFAULT_BUDGET, monthlyUsd: pricing.monthlyBudgetUsd ?? null };
  }
}

export function saveBudget(file, budget) {
  const body = { _안내: 'Control Center 화면의 🔔 알림 → 예산 설정에서 고쳐요. 금액은 API 환산 달러예요.', ...budget };
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

const monthKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const dayStart = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
const usd = (n) => (n >= 1000 ? '$' + Math.round(n).toLocaleString('en-US') : '$' + n.toFixed(2));
const dur = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? `${Math.max(1, m)}분` : `${Math.floor(m / 60)}시간 ${m % 60}분`; };

/** 지금 켜져 있어야 할 알림 목록(새 것부터) */
export function evaluateAlerts({ cache, staff, pricing, budget, now = Date.now() }) {
  const staffNames = new Set(staff.map((s) => s.name));
  const label = (name) => {
    const s = staff.find((x) => x.name === name);
    return s ? s.team || s.name : name === 'unknown' ? '알 수 없는 에이전트' : '기본 에이전트 ' + name;
  };
  const monthFrom = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), 1).getTime();
  const today = dayStart(now);
  const weekFrom = today - 7 * DAY;
  const mk = monthKey(now);

  let month = 0;
  let todayCost = 0;
  let weekCost = 0;
  let firstTs = 0;
  const staffMonth = {};
  const alerts = [];
  for (const st of Object.values(cache.files)) {
    const prices = priceTable(pricing, st.models);
    const agent = st.kind === 'sub' && st.meta ? st.meta.agentType : null;
    if (st.firstTs && (!firstTs || st.firstTs < firstTs)) firstTs = st.firstTs;
    let c = 0;
    for (const e of st.events) {
      const ts = e[EV.TS];
      if (ts < weekFrom && ts < monthFrom) continue;
      const v = evCost(e, prices[e[EV.MODEL]].p);
      if (ts >= monthFrom) { month += v; c += v; }
      if (ts >= today) todayCost += v;
      else if (ts >= weekFrom) weekCost += v;
    }
    if (agent && staffNames.has(agent)) staffMonth[agent] = (staffMonth[agent] || 0) + c;

    if (st.kind !== 'sub' || !st.firstTs) continue;
    const status = runStatus(st, now);
    const who = agent || 'unknown';
    const desc = (st.meta && st.meta.description) || '';
    if (budget.runUsd && st.firstTs >= now - RUN_LOOKBACK) {
      const cost = fileCost(st, pricing);
      if (cost > budget.runUsd) {
        alerts.push({
          id: 'run-' + st.agentId, level: 'warn', kind: 'run', at: st.lastTs, agent: who,
          title: `비싼 작업: ${label(who)}${desc ? ` 「${desc}」` : ''}`,
          body: `${usd(cost)} · ${dur(st.lastTs - st.firstTs)} 걸림 (한 건 기준 ${usd(budget.runUsd)})`,
          ref: { id: fileId(st), at: 0 },
        });
      }
    }
    if (status === 'stopped' && st.lastTs >= now - STOP_LOOKBACK && staffNames.has(who)) {
      alerts.push({
        id: 'stopped-' + st.agentId, level: 'info', kind: 'stopped', at: st.lastTs, agent: who,
        title: `끝나지 않고 멈춘 작업: ${label(who)}${desc ? ` 「${desc}」` : ''}`,
        body: `마지막으로 움직인 지 ${dur(now - st.lastTs)} 지났어요. 끊겼거나 승인을 기다리다 멈췄을 수 있어요.`,
        ref: { id: fileId(st), at: 0 },
      });
    }
  }

  // 이번 달 예산: 넘은 단계 중 가장 높은 것 하나(단계를 새로 넘을 때마다 새 알림)
  const elapsedDays = (now - monthFrom) / DAY;
  const daysInMonth = new Date(new Date(now).getFullYear(), new Date(now).getMonth() + 1, 0).getDate();
  const projected = elapsedDays >= 1 ? (month / elapsedDays) * daysInMonth : null;
  if (budget.monthlyUsd) {
    const p = (month / budget.monthlyUsd) * 100;
    const hit = budget.warnAt.filter((t) => p >= t).pop();
    if (hit) {
      alerts.push({
        id: `month-${mk}-${hit}`, level: hit >= 100 ? 'bad' : 'warn', kind: 'month', at: now,
        title: hit >= 100 ? '이번 달 예산을 넘었어요' : `이번 달 예산의 ${hit}%를 썼어요`,
        body: `${usd(month)} / 예산 ${usd(budget.monthlyUsd)} (${Math.round(p)}%)${projected ? ` · 월말 예상 ${usd(projected)}` : ''}`,
      });
    }
    if (p < 100 && projected && projected > budget.monthlyUsd) {
      alerts.push({
        id: `forecast-${mk}`, level: 'warn', kind: 'forecast', at: now,
        title: '이대로면 월말에 예산을 넘어요',
        body: `월말 예상 ${usd(projected)} (예산의 ${Math.round((projected / budget.monthlyUsd) * 100)}%) · 지금 ${usd(month)}`,
      });
    }
  }
  for (const [name, cap] of Object.entries(budget.staff || {})) {
    const used = staffMonth[name] || 0;
    const p = (used / cap) * 100;
    const hit = budget.warnAt.filter((t) => p >= t).pop();
    if (!hit) continue;
    alerts.push({
      id: `staff-${name}-${mk}-${hit}`, level: hit >= 100 ? 'bad' : 'warn', kind: 'staff', at: now, agent: name,
      title: hit >= 100 ? `${label(name)}이 이번 달 예산을 넘었어요` : `${label(name)}이 이번 달 예산의 ${hit}%를 썼어요`,
      body: `${usd(used)} / 예산 ${usd(cap)} (${Math.round(p)}%)`,
    });
  }

  // 갑자기 많이 쓴 날: 최근 7일(오늘 빼고) 하루 평균과 견준다. 기록이 사흘도 안 되면 견주지 않는다
  const baseDays = firstTs ? Math.min(7, Math.floor((today - dayStart(firstTs)) / DAY)) : 0;
  const avg = baseDays >= 3 ? weekCost / baseDays : 0;
  if (budget.dailySpike && avg > 0 && todayCost >= (budget.dailyMinUsd || 0) && todayCost > avg * budget.dailySpike) {
    alerts.push({
      id: `spike-${new Date(today).toISOString().slice(0, 10)}`, level: 'warn', kind: 'spike', at: now,
      title: `오늘 사용량이 평소의 ${(todayCost / avg).toFixed(1)}배예요`,
      body: `오늘 ${usd(todayCost)} · 최근 ${baseDays}일 하루 평균 ${usd(avg)}`,
    });
  }

  const rank = { bad: 0, warn: 1, info: 2 };
  alerts.sort((a, b) => rank[a.level] - rank[b.level] || b.at - a.at);
  return { alerts, month, projected, staffMonth, today: todayCost, avg };
}

// ── 읽음 상태 ──
export function loadAlertState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (s && s.v === 1 && s.seen) return s;
  } catch { /* 처음 */ }
  return { v: 1, seen: {} };
}

export function saveAlertState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, file);
}

/** 지금 알림에 처음 본 때·읽음을 붙인다. fresh = 이번에 처음 본 id. 오래된 기록은 지운다 */
export function mergeAlerts(alerts, state, now = Date.now()) {
  const fresh = [];
  let changed = false;
  const active = new Set();
  const out = alerts.map((a) => {
    active.add(a.id);
    let s = state.seen[a.id];
    if (!s) { s = state.seen[a.id] = { first: now, read: 0 }; fresh.push(a.id); changed = true; }
    return { ...a, first: s.first, read: !!s.read };
  });
  for (const [id, s] of Object.entries(state.seen)) {
    if (!active.has(id) && now - s.first > KEEP_STATE) { delete state.seen[id]; changed = true; }
  }
  return { alerts: out, fresh, changed, unread: out.filter((a) => !a.read).length };
}

export function markRead(state, ids, now = Date.now()) {
  let n = 0;
  for (const id of ids) {
    const s = state.seen[id];
    if (s && !s.read) { s.read = now; n++; }
  }
  return n;
}
