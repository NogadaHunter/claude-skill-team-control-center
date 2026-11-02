// Claude Code 대화 기록(JSONL)을 읽어 토큰 사용량·스킬 호출·작업 시간·활동 기록을 뽑는다.
// 기록 파일은 뒤에 덧붙기만 하므로, 읽은 위치(offset)를 캐시에 남기고 새로 붙은 줄만 읽는다.
import fs from 'node:fs';
import path from 'node:path';
import { projectsDir as defaultProjectsDir, cacheFile as defaultCacheFile } from './paths.mjs';

export const CACHE_VERSION = 5; // 2: 활동 기록 추가, 3: 파일별 활동 보존, 4: 요청 위치(트레이스)·맡긴 도구 id, 5: 대화 요약은 요청이 아님
const NL = 0x0a;
const CHUNK = 4 << 20;
const ACT_KEEP = 600; // 파일과 상관없이 남기는 최근 활동 수
const ACT_PER_FILE = 30; // 바쁜 세션에 밀려 직원 기록이 사라지지 않게 파일마다 따로 남기는 수
const ACT_TRIM = 8000; // 이만큼 쌓이면 바로 줄인다
// JSON.parse 전에 바이트로 줄 종류를 거른다. 문자열 안의 따옴표는 \" 로 이스케이프되므로 오탐이 없다.
const PAT = {
  assistant: Buffer.from('"type":"assistant"'),
  user: Buffer.from('"type":"user"'),
  title: Buffer.from('"type":"custom-title"'),
  agentName: Buffer.from('"type":"agent-name"'),
  toolResult: Buffer.from('"tool_use_id"'),
};

// 이벤트 한 건 = [시각ms, 모델번호, 입력, 출력, 캐시쓰기5분, 캐시쓰기1시간, 캐시읽기, 스킬번호(-1=없음)]
export const EV = { TS: 0, MODEL: 1, IN: 2, OUT: 3, CW5: 4, CW1H: 5, CR: 6, SKILL: 7 };

/** 화면·트레이스에서 기록 파일을 가리키는 이름: 직원 작업은 agent-…, 세션은 세션 id */
export const fileId = (st) => (st.kind === 'sub' ? st.agentId : st.sessionId);

/** usage → [입력, 출력, 캐시쓰기5분, 캐시쓰기1시간, 캐시읽기] */
export function splitUsage(u) {
  const cc = u.cache_creation;
  const cwTotal = u.cache_creation_input_tokens || 0;
  const cw1h = cc ? (cc.ephemeral_1h_input_tokens || 0) : 0;
  const cw5 = Math.max(cc ? (cc.ephemeral_5m_input_tokens || 0) : cwTotal, cwTotal - cw1h);
  return [u.input_tokens || 0, u.output_tokens || 0, cw5, cw1h, u.cache_read_input_tokens || 0];
}

function readdir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

export function listTranscripts(projectsDir = defaultProjectsDir) {
  const out = [];
  for (const proj of readdir(projectsDir)) {
    if (!proj.isDirectory()) continue;
    const pdir = path.join(projectsDir, proj.name);
    for (const ent of readdir(pdir)) {
      const p = path.join(pdir, ent.name);
      if (ent.isFile() && ent.name.endsWith('.jsonl')) {
        out.push({ file: p, kind: 'main', sessionId: ent.name.slice(0, -6), projectKey: proj.name });
      } else if (ent.isDirectory()) {
        for (const s of readdir(path.join(p, 'subagents'))) {
          if (!s.isFile() || !s.name.endsWith('.jsonl')) continue;
          out.push({
            file: path.join(p, 'subagents', s.name), kind: 'sub',
            sessionId: ent.name, agentId: s.name.slice(0, -6), projectKey: proj.name,
          });
        }
      }
    }
  }
  return out;
}

function newState(t) {
  return {
    kind: t.kind, sessionId: t.sessionId, agentId: t.agentId || null, projectKey: t.projectKey,
    offset: 0, cwd: null, title: null, firstTs: 0, lastTs: 0,
    models: [], skills: [], events: [], recent: [], activeSkill: -1,
    prompts: [], skillCalls: [], meta: null,
    turns: [], // 세션만: 사람 요청마다 [시각, 그 줄의 바이트 위치, 요청 앞부분]
  };
}

function intern(list, name) {
  let i = list.indexOf(name);
  if (i < 0) { i = list.length; list.push(name); }
  return i;
}

function touch(st, ts, cwd) {
  if (ts) {
    if (!st.firstTs || ts < st.firstTs) st.firstTs = ts;
    if (ts > st.lastTs) st.lastTs = ts;
  }
  if (!st.cwd && cwd) st.cwd = cwd;
}

/** 공백을 접어 한 줄로, n 글자 넘으면 말줄임 */
export function oneLine(text, n) {
  const cps = Array.from(String(text || '').split(/\s+/).filter(Boolean).join(' '));
  return cps.length <= n ? cps.join('') : cps.slice(0, n - 1).join('') + '…';
}
const baseName = (p) => String(p || '').split(/[\\/]/).pop();
const hostOf = (u) => { try { return new URL(String(u || '')).hostname; } catch { return ''; } };

// assistant 내용 블록 하나 → 활동 {k, a}. 3D 사무실(docs/CONTRACT.md 'Act')과 같은 낱말을 쓴다.
// Bash·PowerShell 은 명령 원문에 비밀값이 섞일 수 있어 사람이 쓴 description 만 보여 준다.
export function describe(block) {
  if (!block || typeof block !== 'object') return null;
  if (block.type === 'text') {
    const a = oneLine(String(block.text || '').replace(/\*\*|__|`+|^#+\s*|\n#+\s*/g, ' '), 60);
    return a ? { k: 'text', a } : null;
  }
  if (block.type !== 'tool_use') return null;
  const name = String(block.name || '');
  const inp = block.input && typeof block.input === 'object' ? block.input : {};
  switch (name) {
    case 'Read': return { k: 'read', a: baseName(inp.file_path) };
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return { k: 'edit', a: baseName(inp.file_path || inp.notebook_path) };
    case 'Write': return { k: 'write', a: baseName(inp.file_path) };
    case 'Bash': case 'PowerShell': return { k: 'bash', a: oneLine(inp.description, 44) || name };
    case 'Grep': return { k: 'grep', a: oneLine(inp.pattern, 24) };
    case 'Glob': return { k: 'glob', a: oneLine(inp.pattern, 28) };
    case 'WebFetch': return { k: 'fetch', a: hostOf(inp.url) };
    case 'WebSearch': return { k: 'search', a: oneLine(inp.query, 24) };
    case 'Agent': case 'Task': return { k: 'agent', a: oneLine(inp.description, 30), to: String(inp.subagent_type || '') };
    case 'TodoWrite': return { k: 'todo', a: '' };
    case 'Skill': return { k: 'skill', a: oneLine(String(inp.skill || '').split(':').pop(), 28) };
    default:
      if (name.startsWith('mcp__')) return { k: 'mcp', a: oneLine(name.split('__').pop(), 24) };
      return { k: 'tool', a: oneLine(name, 24) };
  }
}

// 사람이 직접 보낸 요청인지(작업 알림·다른 세션 메시지·명령 출력은 뺀다)
export function isHumanPrompt(text) {
  const t = text.trimStart();
  return t.length > 0 && !t.startsWith('<') && !t.startsWith('Another Claude session')
    && !t.startsWith('Caveat:') && !t.startsWith('[Request interrupted');
}

function onAssistant(st, o, emit) {
  const m = o.message;
  if (!m || !m.usage) return;
  const model = m.model || 'unknown';
  if (model.startsWith('<')) return; // <synthetic> 응답은 API를 부르지 않았다
  const ts = Date.parse(o.timestamp) || 0;
  touch(st, ts, o.cwd);

  const ev = [ts, intern(st.models, model), ...splitUsage(m.usage), st.activeSkill];

  // 응답 하나가 내용 블록마다 줄로 나뉘어 같은 usage가 되풀이된다 → message.id로 한 번만 센다
  const id = m.id || o.requestId;
  const hit = id ? st.recent.find((r) => r[0] === id) : null;
  if (hit) {
    const prev = st.events[hit[1]];
    ev[EV.TS] = prev[EV.TS];
    ev[EV.SKILL] = prev[EV.SKILL];
    st.events[hit[1]] = ev;
  } else {
    st.events.push(ev);
    if (id) {
      st.recent.push([id, st.events.length - 1]);
      if (st.recent.length > 64) st.recent.shift();
    }
  }

  // Skill 호출 뒤에 오는 응답의 토큰은 그 스킬 몫으로 본다(다음 사람 요청까지)
  for (const c of m.content || []) {
    if (c && c.type === 'tool_use' && c.name === 'Skill' && c.input && c.input.skill) {
      const si = intern(st.skills, String(c.input.skill));
      st.skillCalls.push([ts, si]);
      st.activeSkill = si;
    }
    const act = describe(c);
    if (act && ts) emit({ t: ts, ...act });
  }
}

function onUser(st, o, emit, off) {
  if (o.isMeta || o.isCompactSummary) return; // 대화가 길어져 접힐 때 남는 요약은 사람 요청이 아니다
  const c = o.message && o.message.content;
  let text = '';
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    if (c.some((b) => b && b.type === 'tool_result')) return;
    text = c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
  }
  const ts = Date.parse(o.timestamp) || 0;
  touch(st, ts, o.cwd);
  st.activeSkill = -1;
  if (isHumanPrompt(text)) {
    st.prompts.push(ts);
    if (st.kind === 'main' && ts) st.turns.push([ts, off, oneLine(text, 60)]);
    if (ts) emit({ t: ts, k: 'prompt', a: oneLine(text, 50) });
  }
}

function onLine(st, line, emit, off) {
  if (line.length < 2) return;
  let kind;
  if (line.indexOf(PAT.assistant) !== -1) kind = 'assistant';
  else if (line.indexOf(PAT.user) !== -1) {
    if (line.indexOf(PAT.toolResult) !== -1) return; // 도구 결과 줄은 크고 쓸 게 없다
    kind = 'user';
  } else if (line.indexOf(PAT.title) !== -1 || line.indexOf(PAT.agentName) !== -1) kind = 'title';
  else return;

  let o;
  try { o = JSON.parse(line.toString('utf8')); } catch { return; }
  if (o.type === 'assistant') onAssistant(st, o, emit);
  else if (o.type === 'user') onUser(st, o, emit, off);
  else if (o.type === 'custom-title' && o.customTitle) st.title = o.customTitle;
  else if (o.type === 'agent-name' && o.agentName && !st.title) st.title = o.agentName;
}

async function parseFrom(file, st, size, emit) {
  const fd = await fs.promises.open(file, 'r');
  const buf = Buffer.allocUnsafe(CHUNK);
  let pos = st.offset;
  let carry = [];
  let carryLen = 0;
  try {
    while (pos < size) {
      const base = pos; // 이 조각이 파일에서 시작하는 위치(줄 위치를 남기려고)
      const { bytesRead } = await fd.read(buf, 0, Math.min(CHUNK, size - pos), pos);
      if (!bytesRead) break;
      pos += bytesRead;
      const chunk = buf.subarray(0, bytesRead);
      let start = 0;
      let nl;
      while ((nl = chunk.indexOf(NL, start)) !== -1) {
        if (carryLen) {
          onLine(st, Buffer.concat([...carry, chunk.subarray(start, nl)]), emit, base - carryLen);
          carry = []; carryLen = 0;
        } else {
          onLine(st, chunk.subarray(start, nl), emit, base + start);
        }
        start = nl + 1;
      }
      if (start < bytesRead) {
        carry.push(Buffer.from(chunk.subarray(start))); // buf를 다시 쓰므로 복사
        carryLen += bytesRead - start;
      }
      st.offset = pos - carryLen; // 끝나지 않은 마지막 줄은 다음에 다시 읽는다
    }
  } finally {
    await fd.close();
  }
}

function readMeta(file) {
  try {
    const m = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
    return { agentType: m.agentType || null, description: m.description || '', finished: m.finished === true, toolUseId: m.toolUseId || null };
  } catch {
    return null;
  }
}

export function loadCache(cacheFile = defaultCacheFile) {
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (c && c.v === CACHE_VERSION && c.files) return { activity: [], rev: 0, ...c };
  } catch { /* 없거나 깨졌으면 새로 만든다 */ }
  return { v: CACHE_VERSION, rev: 0, files: {}, activity: [] };
}

export function saveCache(cacheFile, cache) {
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  const tmp = cacheFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache));
  fs.renameSync(tmp, cacheFile);
}

/** 활동 한 건을 넣는다. f = 기록 파일(없으면 p = 3D 사무실의 사람 이름) */
export function pushActivity(cache, act) {
  cache.activity.push(act);
  if (cache.activity.length > ACT_TRIM) trimActivity(cache);
}
function trimActivity(cache) {
  const acts = cache.activity.sort((a, b) => a.t - b.t);
  if (acts.length <= ACT_KEEP) return;
  const perFile = new Map();
  const keep = new Array(acts.length).fill(false);
  for (let i = acts.length - 1; i >= 0; i--) {
    const key = acts[i].f || 'p:' + acts[i].p;
    const n = perFile.get(key) || 0;
    if (acts.length - 1 - i < ACT_KEEP || n < ACT_PER_FILE) { keep[i] = true; perFile.set(key, n + 1); }
  }
  cache.activity = acts.filter((_, i) => keep[i]);
}

// 모든 기록을 훑어 캐시를 최신으로 만든다. 바뀐 게 있으면 cache.rev 가 1 늘어난다.
// onProgress(읽은 바이트, 읽을 바이트). persist=false 면 파일에 쓰지 않는다(서버가 모아서 쓴다).
export async function scanAll({ projectsDir = defaultProjectsDir, cacheFile = defaultCacheFile, cache, onProgress, persist = true } = {}) {
  cache = cache || loadCache(cacheFile);
  const list = listTranscripts(projectsDir);
  const jobs = [];
  let changed = false;
  for (const t of list) {
    let stat;
    try { stat = fs.statSync(t.file); } catch { continue; }
    let st = cache.files[t.file];
    if (!st || stat.size < st.offset) { st = newState(t); cache.files[t.file] = st; changed = true; }
    jobs.push({ t, st, size: stat.size });
  }
  const live = new Set(jobs.map((j) => j.t.file));
  for (const f of Object.keys(cache.files)) {
    if (!live.has(f)) { delete cache.files[f]; changed = true; }
  }

  const total = jobs.reduce((s, j) => s + Math.max(0, j.size - j.st.offset), 0);
  let done = 0;
  for (const { t, st, size } of jobs) {
    const emit = (act) => pushActivity(cache, { ...act, f: t.file });
    if (size > st.offset) {
      const before = st.offset;
      await parseFrom(t.file, st, size, emit);
      done += size - before;
      changed = true;
      if (onProgress) onProgress(done, total);
    }
    if (t.kind !== 'sub') continue;
    // 끝난 작업의 meta 는 더 바뀌지 않는다. 끝나지 않은 것만 매번 읽는다.
    if (!(st.meta && st.meta.finished)) {
      const meta = readMeta(t.file);
      if (JSON.stringify(meta) !== JSON.stringify(st.meta)) { st.meta = meta; changed = true; }
    }
    const desc = (st.meta && st.meta.description) || '';
    if (!st.startEmitted && st.firstTs) { emit({ t: st.firstTs, k: 'start', a: desc }); st.startEmitted = true; changed = true; }
    if (!st.doneEmitted && st.meta && st.meta.finished && st.lastTs) {
      emit({ t: st.lastTs, k: 'done', a: desc }); st.doneEmitted = true; changed = true;
    }
  }
  if (changed) {
    trimActivity(cache);
    cache.rev = (cache.rev || 0) + 1;
    if (persist) saveCache(cacheFile, cache);
  }
  return cache;
}
