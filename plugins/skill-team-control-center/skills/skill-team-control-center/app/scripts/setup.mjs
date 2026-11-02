// 처음 설정: 이 PC의 직원(~/.claude/agents)을 읽어 프로필을 만들고, 일을 가장 많이 맡긴 프로젝트를 '팀장'으로 잡는다.
// 이미 설정이 있으면 새로 생긴 직원만 더한다(고쳐 둔 목적·색은 그대로). 쓰는 곳은 server/paths.mjs 의 configDir.
//   node scripts/setup.mjs [--owner 대표님] [--lead 폴더이름] [--skilldb 엑셀경로] [--force]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { agentsDir, configDir, defaultConfigDir, projectsDir, skilldbFile } from '../server/paths.mjs';
import { loadRegistry, readJson } from '../server/aggregate.mjs';

const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#d55181', '#4a9bb5', '#9a6b2f'];
const DEFAULT_WORKFLOW = ['요청 받기', '자료 확인', '스킬·도구로 작업', '결과 점검', '보고'];

// 설명에서 팀 이름 고르기: '…팀'이 있으면(묶음 이름 '스킬팀'은 빼고) 그것, 없으면 영문 이름을 보기 좋게
export function teamOf(name, description) {
  const teams = [...String(description || '').matchAll(/([가-힣A-Za-z0-9]+팀)/g)].map((m) => m[1]).filter((t) => t !== '스킬팀');
  if (teams.length) return teams[0];
  return name.split(/[-_]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

// 목적: 설명의 첫 문장(앞에 붙은 '…팀 직원.' 같은 소개는 뺀다), 80자까지
export function purposeOf(description) {
  let d = String(description || '').replace(/\s+/g, ' ').trim();
  d = d.replace(/^[^.。]*팀 직원[.。]\s*/, '');
  const first = d.split(/(?<=[.。!?])\s/)[0] || d;
  const cps = Array.from(first);
  return cps.length > 80 ? cps.slice(0, 79).join('') + '…' : first;
}

/** 직원 명부 → 프로필(이미 있는 것은 그대로 두고 새 직원만 더한다) */
export function buildProfiles(staff, existing = {}, { owner, lead } = {}) {
  const out = { ...existing };
  out._안내 = out._안내 || '직원 프로필이에요. 목적·목표·워크플로·팀 이름·색은 자유롭게 고치세요. 맡은 스킬은 ~/.claude/agents/<이름>.md 의 표에서 자동으로 읽어요. owner 는 화면·리포트에서 사용자를 부르는 이름이에요.';
  if (owner) out.owner = owner;
  out.owner = out.owner || '사용자';
  out.agents = { ...(existing.agents || {}) };
  const used = new Set(Object.values(out.agents).map((a) => a.color));
  let ci = 0;
  const nextColor = () => {
    for (let k = 0; k < PALETTE.length; k++) { const c = PALETTE[(ci + k) % PALETTE.length]; if (!used.has(c)) { ci += k + 1; used.add(c); return c; } }
    return PALETTE[ci++ % PALETTE.length];
  };
  const added = [];
  for (const s of staff) {
    if (out.agents[s.name]) continue;
    out.agents[s.name] = { team: teamOf(s.name, s.description), color: nextColor(), purpose: purposeOf(s.description), goals: [], workflow: DEFAULT_WORKFLOW };
    added.push(s.name);
  }
  out.lead = { name: '팀장', purpose: '요청을 쪼개 직원에게 맡기고 결과를 모아 보고해요', workflow: ['요청 받기', '맡을 직원 고르기', '직원에게 일 맡기기', '결과 모아 점검', '보고'], ...(existing.lead || {}) };
  if (lead !== undefined) out.lead.project = lead;
  return { profiles: out, added };
}

// 앞부분만 읽어 cwd 가 적힌 첫 줄에서 작업 폴더 이름을 얻는다
function folderOfProject(dir) {
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
    let fd;
    try {
      fd = fs.openSync(path.join(dir, f), 'r');
      const buf = Buffer.alloc(256 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
        if (!line.includes('"cwd"')) continue;
        try { const cwd = JSON.parse(line).cwd; if (cwd) return path.basename(cwd); } catch { /* 잘린 줄 */ }
      }
    } catch { /* 못 읽는 파일 */ } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  return null;
}

/** 직원에게 일을 가장 많이 맡긴 프로젝트(= 팀장 세션이 도는 폴더). 없으면 null */
export function detectLead(dir, staffNames) {
  let best = null;
  let projects = [];
  try { projects = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { return null; }
  for (const p of projects) {
    const pdir = path.join(dir, p.name);
    let n = 0;
    for (const s of fs.readdirSync(pdir, { withFileTypes: true })) {
      if (!s.isDirectory()) continue;
      const sub = path.join(pdir, s.name, 'subagents');
      let metas = [];
      try { metas = fs.readdirSync(sub).filter((x) => x.endsWith('.meta.json')); } catch { continue; }
      for (const m of metas) {
        try { if (staffNames.has(JSON.parse(fs.readFileSync(path.join(sub, m), 'utf8')).agentType)) n++; } catch { /* 깨진 meta */ }
      }
    }
    if (n && (!best || n > best.runs)) best = { key: p.name, runs: n, dir: pdir };
  }
  if (!best) return null;
  return { project: folderOfProject(best.dir) || best.key.split('-').filter(Boolean).pop(), key: best.key, runs: best.runs };
}

export function runSetup({ owner, lead, skilldb, force = false } = {}) {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 18) throw new Error(`Node.js 18 이상이 필요해요(지금 ${process.versions.node}). https://nodejs.org 에서 LTS 를 설치해 주세요.`);
  fs.mkdirSync(configDir, { recursive: true });
  const file = path.join(configDir, 'profiles.json');
  const existing = force ? {} : readJson(file, {});
  const staff = loadRegistry(agentsDir, existing);
  let leadInfo = null;
  if (lead === undefined && !(existing.lead && existing.lead.project)) {
    leadInfo = detectLead(projectsDir, new Set(staff.map((s) => s.name)));
    lead = leadInfo ? leadInfo.project : '';
  }
  const { profiles, added } = buildProfiles(staff, existing, { owner, lead });
  fs.writeFileSync(file, JSON.stringify(profiles, null, 2) + '\n');
  if (skilldb) {
    fs.writeFileSync(skilldbFile, JSON.stringify({ _안내: '스킬 DB 엑셀(표 SkillDB) 위치예요. 읽기만 해요.', xlsx: skilldb.replace(/\\/g, '/'), table: 'SkillDB', columns: {} }, null, 2) + '\n');
  }
  return {
    configDir, file, staff: staff.map((s) => ({ name: s.name, team: profiles.agents[s.name].team, model: s.model || '' })), added,
    owner: profiles.owner, lead: profiles.lead.project || '', leadInfo,
    skillSource: fs.existsSync(skilldbFile) ? '스킬 DB 엑셀' : '설치된 스킬(~/.claude/skills·플러그인)',
    pricing: fs.existsSync(path.join(configDir, 'pricing.json')) ? path.join(configDir, 'pricing.json') : path.join(defaultConfigDir, 'pricing.json'),
  };
}

export function setupReport(r) {
  return [
    `설정 폴더: ${r.configDir}`,
    `직원 ${r.staff.length}명${r.added.length ? ` (새로 더함 ${r.added.length}명)` : ''}: ${r.staff.map((s) => `${s.team}(${s.name}${s.model ? ', ' + s.model : ''})`).join(', ') || '아직 없음 — ~/.claude/agents 에 직원을 만들면 나타나요'}`,
    `부르는 이름: ${r.owner}`,
    `팀장 세션 폴더: ${r.lead || '못 찾음(직원에게 일을 맡긴 기록이 없어요)'}${r.leadInfo ? ` — 직원 작업 ${r.leadInfo.runs}건을 맡긴 폴더` : ''}`,
    `스킬 목록: ${r.skillSource}`,
    `단가표: ${r.pricing}`,
  ].join('\n');
}

// 직접 실행할 때
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined; };
  try {
    console.log(setupReport(runSetup({ owner: opt('owner'), lead: opt('lead'), skilldb: opt('skilldb'), force: args.includes('--force') })));
  } catch (err) {
    console.error('설정 실패: ' + (err.message || err));
    process.exit(1);
  }
}
