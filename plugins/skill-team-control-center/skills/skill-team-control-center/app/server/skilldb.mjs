// 스킬 DB 엑셀(현황관리DB)을 읽어 이 PC의 실제 사용 기록과 짝짓는다. 엑셀은 읽기만 하고, 사용 현황은 새 엑셀로 내려받게 한다.
// 엑셀이 없으면 이 PC에 설치된 스킬(~/.claude/skills, 플러그인 스킬)을 읽어 같은 모양으로 보여 준다.
import fs from 'node:fs';
import path from 'node:path';
import { readXlsx } from './xlsx.mjs';
import { writeXlsx } from './xlsx-write.mjs';
import { pluginsDir as defaultPluginsDir, skillsDir as defaultSkillsDir } from './paths.mjs';

// 엑셀 열 이름(config/skilldb.json 의 columns 로 바꿀 수 있다)
export const DEFAULT_COLUMNS = {
  id: '스킬 ID', name: '한글명', category: '카테고리', team: '담당 스킬팀', purpose: '주요 용도', status: '운영 상태',
  active: '활성화', version: '버전', updated: '최종 업데이트', check: '등록본 점검', freq: '사용 빈도', importance: '중요도',
  triggers: '대표 트리거', links: '연계 스킬', memo: '관리 메모', ideas: '개선 아이디어', type: '등록 형태', claudeId: 'claude.ai ID',
};
const shortSkill = (s) => String(s || '').split(':').pop().trim().toLowerCase();

/** 설정에서 엑셀 파일 찾기: xlsx 가 있으면 그것, 없으면 searchDir 아래(두 단계까지)에서 pattern 이 든 가장 새 파일 */
export function findSkillDb(cfg = {}) {
  if (cfg.xlsx && fs.existsSync(cfg.xlsx)) return cfg.xlsx;
  if (!cfg.searchDir) return null;
  const pat = cfg.pattern || '현황관리DB';
  let best = null;
  const visit = (dir, depth) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth > 0) visit(p, depth - 1);
      else if (e.isFile() && e.name.endsWith('.xlsx') && e.name.includes(pat) && !e.name.startsWith('~$')) {
        const m = fs.statSync(p).mtimeMs;
        if (!best || m > best.m) best = { p, m };
      }
    }
  };
  visit(cfg.searchDir, 2);
  return best && best.p;
}

// 엑셀 날짜 일련번호 → 'YYYY-MM-DD'
const excelDate = (v) => {
  if (typeof v !== 'number') return v == null ? '' : String(v);
  const d = new Date(Math.round((v - 25569) * 86400000));
  return d.toISOString().slice(0, 10);
};

// 엑셀 '표'로 만들지 않은 시트: 첫 열 머리글 중 idCol 이 있는 줄을 머리줄로 보고 그 아래를 읽는다
function headerTable(sheets, idCol) {
  for (const sh of sheets) {
    const h = sh.rows.findIndex((r) => r && r.includes(idCol));
    if (h < 0) continue;
    const columns = sh.rows[h].map((c) => (c == null ? '' : String(c)));
    const rows = sh.rows.slice(h + 1).filter(Boolean).map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]]).filter(([c, v]) => c && v != null)));
    return { name: sh.name, sheet: sh.name, columns, rows };
  }
  return null;
}

let memo = { file: null, mtime: 0, data: null };
/** 엑셀 → { file, mtime, rows: [{ id, name, … }] }. 파일이 안 바뀌었으면 다시 읽지 않는다 */
// SKILL.md 머리(frontmatter)에서 한 줄 값 또는 > | 로 이어지는 여러 줄 값
function frontField(text, key) {
  const fm = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!fm) return '';
  const lines = fm[1].split(/\r?\n/);
  const i = lines.findIndex((l) => new RegExp(`^${key}:`).test(l));
  if (i < 0) return '';
  let v = lines[i].slice(key.length + 1).trim();
  if (/^[>|][-+]?$/.test(v)) {
    const more = [];
    for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) more.push(lines[j].trim());
    v = more.join(' ');
  }
  return v.replace(/^["']|["']$/g, '');
}

const LOCAL_TTL = 60000;
let localMemo = { at: 0, key: '', data: null };
/** 설치된 스킬: ~/.claude/skills/<이름>/SKILL.md 와 플러그인 안의 skills/<이름>/SKILL.md (같은 이름은 한 번만) */
export function scanLocalSkills({ skillsDir = defaultSkillsDir, pluginsDir = defaultPluginsDir } = {}) {
  const key = skillsDir + '|' + pluginsDir;
  if (localMemo.key === key && Date.now() - localMemo.at < LOCAL_TTL) return localMemo.data;
  const rows = [];
  const seen = new Set();
  const addDir = (dir, category, type) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const file = path.join(dir, e.name, 'SKILL.md');
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const id = frontField(text, 'name') || e.name;
      if (seen.has(id.toLowerCase())) continue;
      seen.add(id.toLowerCase());
      const desc = frontField(text, 'description');
      rows.push({
        id, name: '', category, team: '', purpose: Array.from(desc).length > 160 ? Array.from(desc).slice(0, 159).join('') + '…' : desc,
        status: '설치됨', active: 'ON', version: frontField(text, 'version'), updated: excelDate(fs.statSync(file).mtimeMs / 86400000 + 25569),
        check: '', freq: '', importance: '', triggers: '', links: '', memo: '', ideas: '', type, claudeId: '',
      });
    }
  };
  addDir(skillsDir, '내 스킬', '스킬');
  // 플러그인: 설치 목록(installed_plugins.json)의 설치 위치/skills. 목록이 없으면 cache 아래를 찾는다(마켓 목록은 설치한 게 아니라서 뺀다)
  let installed = null;
  try { installed = JSON.parse(fs.readFileSync(path.join(pluginsDir, 'installed_plugins.json'), 'utf8')).plugins; } catch { /* 옛 판이거나 없음 */ }
  if (installed && typeof installed === 'object') {
    for (const [key, list] of Object.entries(installed)) {
      for (const it of Array.isArray(list) ? list : [list]) {
        if (it && it.installPath) addDir(path.join(it.installPath, 'skills'), '플러그인: ' + key.split('@')[0], '플러그인');
      }
    }
    rows.sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id));
    const data = { file: null, source: 'local', table: '설치된 스킬', mtime: Date.now(), rows };
    localMemo = { at: Date.now(), key, data };
    return data;
  }
  // …/<플러그인>/[<판>/]skills/<스킬>/SKILL.md 를 여섯 단계까지 찾는다
  const walk = (dir, depth, trail) => {
    if (depth < 0) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.name === 'skills') {
        const plugin = [...trail].reverse().find((t) => !/^v?\d+(\.\d+)*$/.test(t) && !/^[0-9a-f]{7,}$/.test(t)) || '플러그인';
        addDir(p, '플러그인: ' + plugin, '플러그인');
      } else walk(p, depth - 1, [...trail, e.name]);
    }
  };
  walk(path.join(pluginsDir, 'cache'), 6, []);
  rows.sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id));
  const data = { file: null, source: 'local', table: '설치된 스킬', mtime: Date.now(), rows };
  localMemo = { at: Date.now(), key, data };
  return data;
}

export function loadSkillDb(cfg = {}, dirs = {}) {
  const file = findSkillDb(cfg);
  if (!file) {
    // 엑셀이 없으면 설치된 스킬로(엑셀 위치를 적어 두었는데 못 찾았으면 그렇다고 알린다)
    const local = scanLocalSkills(dirs);
    return { ...local, notice: cfg.xlsx ? `스킬 DB 엑셀을 찾지 못해 설치된 스킬을 보여 줘요: ${cfg.xlsx}` : '' };
  }
  let mtime;
  try { mtime = fs.statSync(file).mtimeMs; } catch (err) { return { error: String(err.message), rows: [] }; }
  if (memo.file === file && memo.mtime === mtime) return memo.data;
  let data;
  try {
    const x = readXlsx(file);
    const col = { ...DEFAULT_COLUMNS, ...(cfg.columns || {}) };
    const table = x.tables.find((t) => t.name === (cfg.table || 'SkillDB')) || x.tables[0] || headerTable(x.sheets, col.id);
    if (!table) throw new Error(`엑셀에서 '${col.id}' 열이 있는 표를 찾지 못했어요`);
    const rows = table.rows.filter((r) => r[col.id]).map((r) => {
      const o = {};
      for (const [k, c] of Object.entries(col)) o[k] = r[c] ?? '';
      o.id = String(o.id).trim();
      o.updated = excelDate(o.updated);
      o.version = o.version === '' ? '' : String(o.version);
      return o;
    });
    data = { file, mtime, table: table.name, sheet: table.sheet, rows };
  } catch (err) {
    data = { file, mtime, error: '엑셀을 읽지 못했어요: ' + (err.message || err), rows: [] };
  }
  memo = { file, mtime, data };
  return data;
}

const freqOf = (calls30) => (calls30 >= 10 ? '높음' : calls30 >= 3 ? '보통' : calls30 >= 1 ? '낮음' : '안 씀');

/**
 * 엑셀 행 + 사용 기록 + 직원 명부를 짝짓는다.
 * usage: summarize(..., { allSkills: true }).skillUsage, usage30: 같은 것의 최근 30일
 */
export function mergeSkillDb({ db, usage = [], usage30 = [], staff = [], now = Date.now() }) {
  const use = new Map(usage.map((u) => [shortSkill(u.skill), u]));
  const use30 = new Map(usage30.map((u) => [shortSkill(u.skill), u]));
  const owners = new Map(); // 스킬 → 맡은 직원(명부)
  for (const s of staff) for (const k of s.skills) owners.set(shortSkill(k), s);
  const seen = new Set();

  const rows = db.rows.map((r) => {
    const key = shortSkill(r.id);
    seen.add(key);
    const u = use.get(key);
    const u30 = use30.get(key);
    const owner = owners.get(key);
    const live = /운영|설치/.test(String(r.status)) && !/OFF|끔/i.test(String(r.active));
    const flags = [];
    if (r.check && !/정상/.test(String(r.check))) flags.push({ k: 'check', t: String(r.check) });
    if (r.team && owner && owner.team && owner.team !== r.team) flags.push({ k: 'team', t: `명부에는 ${owner.team}` });
    if (r.team && !owner) flags.push({ k: 'owner', t: '직원 명부에 없음' });
    if (!live && u30 && u30.calls) flags.push({ k: 'inactive', t: '운영 중이 아닌데 최근 씀' });
    return {
      ...r, key, owner: owner ? { name: owner.name, team: owner.team, color: owner.color } : null,
      calls: u ? u.calls : 0, callsAll: u ? u.callsAll : 0, lastUsed: u ? u.lastUsed : 0,
      tokens: u ? u.tokens : 0, cost: u ? u.cost : 0, callers: u ? u.callers : {},
      calls30: u30 ? u30.calls : 0, freqSuggest: freqOf(u30 ? u30.calls : 0), live, flags,
    };
  });

  // 엑셀에 없는데 이 PC에서 쓰였거나 직원이 맡은 스킬
  const missing = [];
  for (const [key, u] of use) if (!seen.has(key)) missing.push({ key, skill: u.skill, callsAll: u.callsAll, calls: u.calls, lastUsed: u.lastUsed, owner: owners.get(key)?.team || '' });
  for (const [key, s] of owners) if (!seen.has(key) && !use.has(key)) missing.push({ key, skill: key, callsAll: 0, calls: 0, lastUsed: 0, owner: s.team || s.name });
  missing.sort((a, b) => b.callsAll - a.callsAll || a.key.localeCompare(b.key));

  const cats = {};
  for (const r of rows) {
    const c = (cats[r.category || '(분류 없음)'] ||= { category: r.category || '(분류 없음)', skills: 0, used: 0, calls: 0, cost: 0 });
    c.skills++;
    if (r.calls) c.used++;
    c.calls += r.calls;
    c.cost += r.cost;
  }
  return {
    file: db.file, name: db.file ? path.basename(db.file) : '설치된 스킬(~/.claude/skills·플러그인)', source: db.source || 'excel', notice: db.notice || '',
    mtime: db.mtime, table: db.table, error: db.error || null, now,
    rows, missing,
    categories: Object.values(cats).sort((a, b) => b.skills - a.skills),
    counts: {
      skills: rows.length, live: rows.filter((r) => r.live).length, used: rows.filter((r) => r.calls).length,
      usedAll: rows.filter((r) => r.callsAll).length, flagged: rows.filter((r) => r.flags.length).length, missing: missing.length,
    },
  };
}

const ymd = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** 짝지은 결과 → 내려받을 엑셀(Buffer) */
export function skillUsageXlsx(merged, { rangeLabel, usdToKrw = 0 }) {
  const rows = merged.rows.map((r) => [
    r.id, r.name, r.category, r.team, r.owner ? r.owner.team : '', r.status, r.version,
    r.calls, r.calls30, r.callsAll, ymd(r.lastUsed), Math.round(r.tokens), Math.round(r.cost * 100) / 100,
    usdToKrw ? Math.round(r.cost * usdToKrw) : null, r.freqSuggest, String(r.freq || ''),
    Object.entries(r.callers).map(([k, v]) => `${k} ${v}`).join(', '), r.flags.map((f) => f.t).join(' / '),
  ]);
  const sheets = [{
    name: '스킬사용현황',
    note: `Claude Skill Team Control Center가 이 PC의 Claude Code 기록으로 센 값이에요(${rangeLabel} 기준, ${ymd(merged.now)} 만듦). claude.ai 웹·앱에서 쓴 것은 빠져요. 토큰·비용은 스킬을 부른 뒤 다음 요청까지를 그 스킬 몫으로 본 추정값이에요.`,
    columns: [
      { name: '스킬 ID', width: 30 }, { name: '한글명', width: 22 }, { name: '카테고리', width: 16 }, { name: '담당 스킬팀(엑셀)', width: 14 },
      { name: '맡은 직원(명부)', width: 14 }, { name: '운영 상태', width: 10 }, { name: '버전', width: 8 },
      { name: `호출(${rangeLabel})`, width: 12, type: 'int' }, { name: '호출(최근 30일)', width: 13, type: 'int' }, { name: '호출(전체)', width: 10, type: 'int' },
      { name: '마지막 사용', width: 17 }, { name: '추정 토큰', width: 13, type: 'int' }, { name: '추정 비용($)', width: 12, type: 'money' },
      { name: '추정 비용(원)', width: 13, type: 'int' }, { name: '사용 빈도(제안)', width: 13 }, { name: '사용 빈도(엑셀)', width: 13 },
      { name: '누가 불렀나', width: 28 }, { name: '확인할 점', width: 36, type: 'wrap' },
    ],
    rows,
  }];
  if (merged.missing.length) {
    sheets.push({
      name: 'DB에 없는 스킬',
      note: '이 PC에서 쓰였거나 직원 명부(~/.claude/agents)에 있는데 스킬 DB 엑셀에는 없는 스킬이에요.',
      columns: [{ name: '스킬', width: 36 }, { name: '맡은 직원', width: 14 }, { name: `호출(${rangeLabel})`, width: 12, type: 'int' }, { name: '호출(전체)', width: 10, type: 'int' }, { name: '마지막 사용', width: 17 }],
      rows: merged.missing.map((m) => [m.skill, m.owner, m.calls, m.callsAll, ymd(m.lastUsed)]),
    });
  }
  return writeXlsx(sheets);
}
