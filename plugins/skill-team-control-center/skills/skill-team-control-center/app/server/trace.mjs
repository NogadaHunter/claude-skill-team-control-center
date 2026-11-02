// 실행 한 건의 단계 타임라인(트레이스)과 직원별 작업 패턴.
// 직원 작업은 그 기록 파일 전체를, 세션은 사람 요청 한 번(다음 요청 전까지)만 그때그때 읽는다. 끝난 실행은 메모리에 잠깐 둔다.
import fs from 'node:fs';
import { describe, fileId, isHumanPrompt, oneLine, splitUsage } from './collect.mjs';
import { evCost, fileCost, folderName, isProject, priceTable, runStatus } from './aggregate.mjs';
import { whoOf } from './live.mjs';

const MAX_READ = 48 << 20; // 요청 하나가 이보다 크면 앞부분만 읽는다
const RUNNING_MS = 10 * 60000;
const MEMO_N = 120;
const NL = 0x0a;
const PAT = {
  assistant: Buffer.from('"type":"assistant"'),
  user: Buffer.from('"type":"user"'),
  req: Buffer.from('"type":"api-request"'), // 닫는 따옴표까지 넣어 api-request-blob 줄은 거른다
};

// 도구 종류 → 묶음(색). 응답을 만드는 동안은 think, 아무것도 안 돌 때는 idle
const CAT = {
  read: 'look', grep: 'look', glob: 'look', edit: 'write', write: 'write', bash: 'bash',
  skill: 'skill', fetch: 'web', search: 'web', agent: 'agent',
};
export const catOf = (k) => CAT[k] || 'other';
const ORDER_CATS = ['look', 'write', 'bash', 'skill', 'web', 'agent'];

const memo = new Map(); // 끝난 실행: `${파일}|${시작}|${끝}` → 단계
function remember(key, v) {
  memo.set(key, v);
  if (memo.size > MEMO_N) memo.delete(memo.keys().next().value);
}

async function readRange(file, from, to) {
  const len = Math.max(0, Math.min(to - from, MAX_READ));
  const fd = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(len);
    const { bytesRead } = await fd.read(buf, 0, len, from);
    return { buf: buf.subarray(0, bytesRead), truncated: to - from > MAX_READ };
  } finally {
    await fd.close();
  }
}

function forEachLine(buf, fn) {
  let start = 0;
  while (start < buf.length) {
    let nl = buf.indexOf(NL, start);
    if (nl === -1) nl = buf.length;
    const line = buf.subarray(start, nl);
    start = nl + 1;
    if (line.indexOf(PAT.assistant) === -1 && line.indexOf(PAT.user) === -1 && line.indexOf(PAT.req) === -1) continue;
    let o;
    try { o = JSON.parse(line.toString('utf8')); } catch { continue; } // 앞부분만 읽어 잘린 줄
    fn(o);
  }
}

const textOf = (c) => (typeof c === 'string' ? c
  : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '');
const tag = (text, name) => { const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text); return m ? m[1].trim() : ''; };

// 기록 줄 → 단계. 응답(llm)은 요청을 보낸 때(api-request)부터 마지막 내용 블록까지,
// 도구는 부른 때부터 결과가 돌아온 때까지(승인 기다림 포함).
export function buildSteps(buf, pricing) {
  const steps = [];
  const marks = [];
  const reqTs = new Map();
  const msgs = new Map();
  const tools = new Map();
  const models = [];
  let prompt = null;
  let lastIn = 0;

  forEachLine(buf, (o) => {
    const ts = Date.parse(o.timestamp) || 0;
    if (o.type === 'api-request') { if (o.id && ts) reqTs.set(o.id, ts); return; }

    if (o.type === 'user') {
      if (o.isMeta || o.isCompactSummary) return;
      const c = o.message && o.message.content;
      if (Array.isArray(c) && c.some((b) => b && b.type === 'tool_result')) {
        for (const b of c) {
          if (!b || b.type !== 'tool_result') continue;
          const t = tools.get(b.tool_use_id);
          if (t && !t.t1) { t.t1 = Math.max(ts, t.t0); if (b.is_error) t.err = true; }
        }
        if (ts > lastIn) lastIn = ts;
        return;
      }
      const text = textOf(c);
      if (ts > lastIn) lastIn = ts;
      if (isHumanPrompt(text)) {
        if (!prompt) prompt = { t: ts, text: oneLine(text, 600) };
        else marks.push({ type: 'mark', k: 'prompt', t0: ts, a: oneLine(text, 80) });
      } else if (text.trimStart().startsWith('<task-notification')) {
        const sum = tag(text, 'summary').replace(/^Agent\s+"(.*)"\s+(\w+)$/, '$1');
        marks.push({ type: 'mark', k: 'notify', t0: ts, a: oneLine(sum, 60), useId: tag(text, 'tool-use-id'), status: tag(text, 'status') });
      }
      return;
    }

    if (o.type !== 'assistant') return;
    const m = o.message;
    if (!m || !m.usage || String(m.model || '').startsWith('<')) return; // <synthetic> 은 API를 부르지 않았다
    const id = m.id || o.requestId || o.uuid;
    let s = msgs.get(id);
    if (!s) {
      s = {
        type: 'llm', cat: 'think', i: steps.length, t0: (o.requestRef && reqTs.get(o.requestRef)) || lastIn || ts, t1: ts,
        model: m.model || 'unknown', u: null, think: 0, say: '', tools: 0,
      };
      if (!models.includes(s.model)) models.push(s.model);
      msgs.set(id, s);
      steps.push(s);
    }
    if (ts > s.t1) s.t1 = ts;
    s.u = m.usage; // 같은 응답의 마지막 줄 usage 가 최종값
    if (o.thinkingDurationMs) s.think += o.thinkingDurationMs;
    for (const b of m.content || []) {
      if (!b) continue;
      if (b.type === 'text' && !s.say) s.say = oneLine(String(b.text || '').replace(/\*\*|__|`+|^#+\s*|\n#+\s*/g, ' '), 200);
      if (b.type !== 'tool_use') continue;
      const d = describe(b) || { k: 'tool', a: String(b.name || '') };
      const t = { type: 'tool', cat: catOf(d.k), i: steps.length, parent: s.i, t0: ts, t1: 0, k: d.k, a: d.a, name: String(b.name || '') };
      if (d.to) t.to = d.to;
      if (d.k === 'agent' && b.id) t.useId = b.id;
      if (b.id) tools.set(b.id, t);
      steps.push(t);
      s.tools++;
    }
  });

  const prices = priceTable(pricing, models);
  for (const s of steps) {
    if (s.type !== 'llm') continue;
    const [inp, out, cw5, cw1h, cr] = splitUsage(s.u || {});
    s.tok = { in: inp, out, cw: cw5 + cw1h, cr };
    s.cost = evCost([0, 0, inp, out, cw5, cw1h, cr, -1], prices[models.indexOf(s.model)].p);
    delete s.u;
  }
  return { steps, marks, prompt, models };
}

// 시간을 잘게 나눠 그 순간 하던 일 하나를 고른다: 도구가 돌고 있으면 도구, 아니면 응답, 둘 다 아니면 기다림
export function sweep(steps, T0, T1) {
  const clamp = (t) => Math.min(T1, Math.max(T0, t));
  const xs = [...new Set([T0, T1, ...steps.flatMap((s) => [clamp(s.t0), clamp(s.t1)])])].sort((a, b) => a - b);
  const segs = [];
  for (let i = 0; i < xs.length - 1; i++) {
    const a = xs[i];
    const b = xs[i + 1];
    const mid = (a + b) / 2;
    let cat = 'idle';
    let pri = 0;
    for (const s of steps) {
      if (s.t0 <= mid && mid < s.t1) {
        const p = s.type === 'tool' ? 2 : 1;
        if (p > pri) { pri = p; cat = s.cat; }
      }
    }
    const last = segs[segs.length - 1];
    if (last && last.cat === cat) last.ms += b - a;
    else segs.push({ cat, at: a, ms: b - a });
  }
  return segs;
}

// 실행 하나를 가리키는 일감: 직원 작업은 파일 전체, 세션은 요청 한 번
function jobFor(cache, id, at) {
  for (const [file, st] of Object.entries(cache.files)) {
    if (fileId(st) !== id) continue;
    if (st.kind === 'sub') return { file, st, from: 0, to: st.offset, turn: -1 };
    const turns = st.turns || [];
    if (!turns.length) return null;
    let i = turns.length - 1;
    if (at) { i = 0; for (let j = 0; j < turns.length; j++) if (turns[j][0] <= at) i = j; }
    return { file, st, from: turns[i][1], to: i + 1 < turns.length ? turns[i + 1][1] : st.offset, turn: i };
  }
  return null;
}

function context({ cache, staff, profiles = {}, pricing, now = Date.now() }) {
  const byUse = new Map();
  for (const st of Object.values(cache.files)) if (st.kind === 'sub' && st.meta && st.meta.toolUseId) byUse.set(st.meta.toolUseId, st);
  return {
    cache, pricing, now, byUse,
    staffNames: new Set(staff.map((s) => s.name)),
    leadProject: (profiles.lead && profiles.lead.project) || 'skill-team',
  };
}

async function traceOf(job, ctx) {
  const { file, st, from, to, turn } = job;
  const { now } = ctx;
  const turns = st.turns || [];
  const status = st.kind === 'sub' ? runStatus(st, now)
    : turn === turns.length - 1 && now - st.lastTs < RUNNING_MS ? 'running' : 'done';
  const key = `${file}|${from}|${to}`;
  let base = status === 'running' ? null : memo.get(key);
  if (!base) {
    const { buf, truncated } = await readRange(file, from, to);
    base = { ...buildSteps(buf, ctx.pricing), truncated };
    if (status !== 'running') remember(key, base);
  }

  const steps = base.steps.map((s) => ({ ...s }));
  for (const t of steps) {
    if (t.type !== 'tool' || t.t1) continue;
    if (status === 'running') { t.t1 = now; t.running = true; } else { t.t1 = t.t0; t.open = true; } // 결과가 안 남은 도구
  }
  const childInfo = (c) => ({
    id: c.agentId, who: whoOf(c, ctx.staffNames, ctx.leadProject), desc: (c.meta && c.meta.description) || '',
    t0: c.firstTs, t1: c.lastTs, status: runStatus(c, now), cost: fileCost(c, ctx.pricing),
  });
  for (const t of steps) {
    const c = t.useId && ctx.byUse.get(t.useId);
    if (c) t.child = childInfo(c);
  }
  const marks = base.marks.map((m) => {
    const c = m.useId && ctx.byUse.get(m.useId);
    return c ? { ...m, child: { id: c.agentId, who: whoOf(c, ctx.staffNames, ctx.leadProject), desc: (c.meta && c.meta.description) || '' } } : m;
  });

  const ts = [...steps.flatMap((s) => [s.t0, s.t1]), ...marks.map((m) => m.t0)].filter(Boolean);
  const T0 = base.prompt ? base.prompt.t : ts.length ? Math.min(...ts) : st.firstTs;
  const T1 = Math.max(T0, ...ts, status === 'running' ? now : 0);
  const view1 = Math.max(T1, ...steps.filter((s) => s.child).map((s) => s.child.t1 || 0));
  const segs = sweep(steps, T0, T1);
  const share = {};
  for (const s of segs) share[s.cat] = (share[s.cat] || 0) + s.ms;

  const llm = steps.filter((s) => s.type === 'llm');
  const tok = { in: 0, out: 0, cw: 0, cr: 0, total: 0 };
  let cost = 0;
  let think = 0;
  for (const s of llm) {
    for (const k of ['in', 'out', 'cw', 'cr']) { tok[k] += s.tok[k]; tok.total += s.tok[k]; }
    cost += s.cost;
    think += s.think;
  }

  const who = whoOf(st, ctx.staffNames, ctx.leadProject);
  let parent = null;
  if (st.kind === 'sub') {
    const p = Object.values(ctx.cache.files).find((x) => x.kind === 'main' && x.sessionId === st.sessionId && x.projectKey === st.projectKey);
    if (p && p.turns && p.turns.length) {
      let pi = 0;
      for (let j = 0; j < p.turns.length; j++) if (p.turns[j][0] <= st.firstTs) pi = j;
      parent = { id: p.sessionId, at: p.turns[pi][0], prompt: p.turns[pi][2], who: whoOf(p, ctx.staffNames, ctx.leadProject) };
    }
  }

  return {
    id: fileId(st), kind: st.kind, who, folder: folderName(st), status,
    title: st.kind === 'sub' ? (st.meta && st.meta.description) || '' : (turns[turn] && turns[turn][2]) || '',
    prompt: base.prompt ? base.prompt.text : '',
    t0: T0, t1: T1, view1, durationMs: T1 - T0, models: base.models, truncated: base.truncated,
    turn: st.kind === 'main' ? { index: turn, count: turns.length, prev: turn > 0 ? turns[turn - 1][0] : 0, next: turn + 1 < turns.length ? turns[turn + 1][0] : 0 } : null,
    parent,
    totals: {
      llm: llm.length, tools: steps.length - llm.length, errors: steps.filter((s) => s.err).length,
      tokens: tok, cost, thinkMs: think, share,
      skills: [...new Set(steps.filter((s) => s.k === 'skill').map((s) => s.a))],
    },
    segs,
    steps,
    marks,
  };
}

/** 화면에서 누른 실행 하나의 트레이스. id = 직원 작업(agent-…)이나 세션 id, at = 그 세션의 몇 시 요청인지 */
export async function traceFor({ id, at, ...rest }) {
  const ctx = context(rest);
  const job = jobFor(ctx.cache, String(id || ''), Number(at) || 0);
  return job ? traceOf(job, ctx) : null;
}

/** 직원(또는 팀장 '__lead')의 최근 실행 n건으로 본 실제 작업 패턴 */
export async function patternFor({ agent, n = 12, ...rest }) {
  const ctx = context(rest);
  const jobs = [];
  for (const [file, st] of Object.entries(ctx.cache.files)) {
    if (agent === '__lead') {
      if (st.kind !== 'main' || !isProject(st, ctx.leadProject) || !st.turns) continue;
      st.turns.forEach(([t, off], i) => jobs.push({
        file, st, from: off, to: i + 1 < st.turns.length ? st.turns[i + 1][1] : st.offset, turn: i, start: t,
      }));
    } else if (st.kind === 'sub' && st.meta && st.meta.agentType === agent && st.firstTs) {
      jobs.push({ file, st, from: 0, to: st.offset, turn: -1, start: st.firstTs });
    }
  }
  jobs.sort((a, b) => b.start - a.start);

  const runs = [];
  const share = {};
  const centers = {};
  for (const job of jobs.slice(0, n)) {
    const tr = await traceOf(job, ctx);
    const T = tr.t1 - tr.t0;
    const cs = {};
    for (const s of tr.segs) {
      share[s.cat] = (share[s.cat] || 0) + s.ms;
      if (!T || !ORDER_CATS.includes(s.cat)) continue;
      const c = (cs[s.cat] ||= { w: 0, m: 0 });
      c.w += s.ms;
      c.m += ((s.at + s.ms / 2 - tr.t0) / T) * s.ms;
    }
    for (const [cat, c] of Object.entries(cs)) (centers[cat] ||= []).push(c.m / c.w);
    runs.push({
      id: tr.id, at: tr.t0, title: tr.title || tr.prompt, status: tr.status, durationMs: tr.durationMs,
      cost: tr.totals.cost, steps: tr.steps.length,
      strip: T ? mergeStrip(tr.segs, T) : [],
    });
  }
  const order = Object.entries(centers)
    .map(([cat, list]) => ({ cat, pos: list.reduce((a, b) => a + b, 0) / list.length, runs: list.length, ms: share[cat] || 0 }))
    .sort((a, b) => a.pos - b.pos);
  return { agent, n: runs.length, total: jobs.length, runs, share, order };
}

// 띠 그래프용: 너무 짧은 조각(0.4% 미만)은 앞 조각에 붙인다
function mergeStrip(segs, T) {
  const out = [];
  for (const s of segs) {
    const w = s.ms / T;
    const last = out[out.length - 1];
    if (last && (last.c === s.cat || w < 0.004)) last.w += w;
    else out.push({ c: s.cat, w });
  }
  return out.map((x) => ({ c: x.c, w: Math.round(x.w * 10000) / 10000 }));
}
