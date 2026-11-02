// 가상 데이터로 관제판을 띄운다 — README 화면 사진·설치 전 구경용. 진짜 ~/.claude 와 ~/.agent-mission-control 은 건드리지 않는다.
// 가짜 직원 5명·스킬 13개·4주치 작업 기록(팀장 세션, 직원 작업, 기본 에이전트, 멈춘 작업, 지금 진행 중인 작업)을 임시 폴더에 만든다.
//   node tools/demo.mjs [--port 4795] [--dir 폴더] [--no-serve]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const here = path.dirname(fileURLToPath(import.meta.url));
// 개발 폴더(tools/ 옆에 server/)와 GitHub 저장소(plugins/… 아래 app/) 둘 다에서 돈다
const appDir = [path.join(here, '..'), path.join(here, '..', 'plugins', 'skill-team-control-center', 'skills', 'skill-team-control-center', 'app')]
  .find((d) => fs.existsSync(path.join(d, 'server', 'server.mjs')));
if (!appDir) throw new Error('server/server.mjs 를 찾지 못했어요');

const root = path.resolve(opt('dir', path.join(os.tmpdir(), 'amc-demo')));
const MARK = path.join(root, '.amc-demo');
if (fs.existsSync(root) && !fs.existsSync(MARK) && fs.readdirSync(root).length) throw new Error(`비어 있지 않은 폴더라 쓰지 않아요: ${root}`);
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(MARK, '이 폴더는 tools/demo.mjs 가 만든 가상 데이터예요. 지워도 돼요.\n');
const claude = path.join(root, 'claude');
const state = path.join(root, 'state');

// ── 같은 결과가 나오는 난수 ──
let seed = 20261102;
const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];

const MIN = 60000;
const DAY = 86400000;
const now = Date.now();
const LEAD_MODEL = 'claude-opus-5-5';

const STAFF = [
  { name: 'report-writer', model: 'claude-opus-5-5', weight: 5,
    desc: '스킬팀 보고서팀 직원. 주간 업무 보고서·회의록·결재 문서를 만든다. 보고서가 필요할 때 맡긴다.',
    skills: { 'weekly-report': '한 주 업무를 모아 주간 보고서 DOCX를 만든다.', 'meeting-minutes': '회의 메모·녹취로 회의록을 정리한다.' },
    jobs: ['주간 업무 보고서 작성', '팀 회의록 정리', '분기 실적 보고서 초안', '결재 문서 정리'],
    goals: ['매주 월요일 10시 전 주간 보고 마감', '회의 끝나고 1시간 안에 회의록 공유'] },
  { name: 'content-writer', model: 'claude-sonnet-5-5', weight: 4,
    desc: '스킬팀 콘텐츠팀 직원. 블로그 글·뉴스레터·SNS 홍보 문구를 쓴다.',
    skills: { 'blog-post': '주제와 키워드로 검색에 잘 걸리는 블로그 글을 쓴다.', newsletter: '한 달 소식을 뉴스레터로 엮는다.' },
    jobs: ['블로그 글 작성', '월간 뉴스레터 작성', 'SNS 홍보 문구 5종', '신제품 소개 글'],
    goals: ['블로그 주 2편', '뉴스레터 매월 1일 발송'] },
  { name: 'researcher', model: 'claude-opus-5-5', weight: 3, heavy: true,
    desc: '스킬팀 리서치팀 직원. 시장·경쟁사 조사와 자료 요약을 맡는다.',
    skills: { 'deep-research': '여러 출처를 찾아 읽고 근거를 붙인 조사 보고서를 쓴다.', 'data-summary': '표·설문 결과를 요약하고 그래프로 보여 준다.' },
    jobs: ['경쟁사 가격 조사', '시장 동향 리서치', '고객 설문 결과 요약', '업계 뉴스 요약'],
    goals: ['조사마다 출처 5개 이상'] },
  { name: 'slide-designer', model: 'claude-opus-5-5', weight: 2,
    desc: '스킬팀 디자인팀 직원. 발표 슬라이드와 카드뉴스 이미지를 만든다.',
    skills: { 'slide-deck': '내용을 받아 발표 슬라이드 PPTX를 만든다.', 'card-news': '핵심 메시지로 카드뉴스 이미지를 만든다.' },
    jobs: ['제안 발표 슬라이드', '카드뉴스 8장', '교육 소개 슬라이드'],
    goals: [] },
  { name: 'course-planner', model: '', weight: 2,
    desc: '스킬팀 교육팀 직원. 강의 커리큘럼과 강의안을 짠다.',
    skills: { curriculum: '대상·시간에 맞춘 강의 커리큘럼을 짠다.', 'lecture-notes': '커리큘럼으로 차시별 강의안을 쓴다.' },
    jobs: ['AI 활용 강의 커리큘럼', '3시간 강의안', '실습 과제 설계'],
    goals: [] },
];
const EXTRA_SKILLS = {
  'invoice-maker': '거래 내역으로 청구서를 만든다.',
  'email-polish': '이메일 초안을 정중한 문장으로 다듬는다.',
  'translate-ko-en': '한국어 문서를 영어로 옮긴다.',
};

// ── 직원 .md · 스킬 폴더 ──
fs.mkdirSync(path.join(claude, 'agents'), { recursive: true });
for (const s of STAFF) {
  const rows = Object.entries(s.skills).map(([k, v]) => `| \`${k}\` | ${v} |`).join('\n');
  fs.writeFileSync(path.join(claude, 'agents', `${s.name}.md`),
    `---\nname: ${s.name}\ndescription: ${s.desc}\n${s.model ? `model: ${s.model}\n` : ''}---\n\n# ${s.name}\n\n| 스킬 | 하는 일 |\n|---|---|\n${rows}\n`);
}
for (const [k, v] of [...STAFF.flatMap((s) => Object.entries(s.skills)), ...Object.entries(EXTRA_SKILLS)]) {
  fs.mkdirSync(path.join(claude, 'skills', k), { recursive: true });
  fs.writeFileSync(path.join(claude, 'skills', k, 'SKILL.md'), `---\nname: ${k}\ndescription: ${v}\n---\n\n# ${k}\n`);
}

// ── 대화 기록 ──
let n = 0;
const id = (p) => `${p}_demo${(++n).toString(36).padStart(5, '0')}`;
const iso = (ms) => new Date(ms).toISOString();
function usage(big = 1) {
  const cw = int(1500, 9000) * big;
  return { input_tokens: int(3, 40), output_tokens: int(250, 2200) * big, cache_creation_input_tokens: cw, cache_read_input_tokens: int(18000, 90000) * big,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: cw } };
}
function jsonl(cwd) {
  const out = [];
  return {
    user: (ts, content) => out.push({ type: 'user', timestamp: iso(ts), cwd, message: { role: 'user', content } }),
    req: (ts) => { const r = id('req'); out.push({ type: 'api-request', id: r, timestamp: iso(ts) }); return r; },
    ai: (ts, model, content, ref, big) => out.push({ type: 'assistant', timestamp: iso(ts), cwd, message: { id: id('msg'), model, usage: usage(big), content }, ...(ref ? { requestRef: ref } : {}) }),
    result: (ts, tu) => out.push({ type: 'user', timestamp: iso(ts), cwd, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu, content: 'ok' }] } }),
    title: (t) => out.push({ type: 'custom-title', customTitle: t }),
    save: (file) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, out.map((o) => JSON.stringify(o)).join('\n') + '\n'); },
  };
}

const TEAM = { key: 'C--work-my-team', cwd: 'C:\\work\\my-team' };
const SIDE = { key: 'C--work-homepage', cwd: 'C:\\work\\homepage' };
const projDir = (p) => path.join(claude, 'projects', p.key);

function workTool(job) {
  const doc = `${job.replace(/\s+/g, '-')}.docx`;
  return pick([
    () => ({ name: 'Read', input: { file_path: `${TEAM.cwd}\\자료\\${pick(['지난주-메모.md', '고객-목록.xlsx', '설문-결과.csv', '기획-초안.md'])}` }, ms: int(1, 4) * 1000 }),
    () => ({ name: 'WebSearch', input: { query: `${job} 2026` }, ms: int(5, 20) * 1000 }),
    () => ({ name: 'Write', input: { file_path: `${TEAM.cwd}\\output\\${doc}` }, ms: int(1, 3) * 1000 }),
    () => ({ name: 'Bash', input: { command: 'python tools/make_docx.py', description: '문서 파일 만들기' }, ms: int(20, 90) * 1000 }),
    () => ({ name: 'Edit', input: { file_path: `${TEAM.cwd}\\output\\${doc}` }, ms: 800 }),
  ])();
}

/** 직원 작업 한 건. 끝난 때(ms)를 돌려준다 */
function staffRun({ sid, who, job, t0, steps, toolUseId, finished = true, cutAt = null, big = 1 }) {
  const agentId = id('agent');
  const model = who.model || LEAD_MODEL;
  const f = jsonl(TEAM.cwd);
  f.user(t0, `${job}을(를) 맡아 줘. 자료는 자료 폴더에 있고, 결과는 output 폴더에 저장한 뒤 세 줄로 요약해 줘.`);
  let t = t0 + 2000;
  const skills = Object.keys(who.skills || {});
  for (let i = 0; i < steps; i++) {
    const r = f.req(t);
    t += int(4, 28) * 1000;
    const tool = i === 0 && skills.length ? { name: 'Skill', input: { skill: pick(skills) }, ms: 1500 } : workTool(job);
    const tu = id('toolu');
    f.ai(t, model, [{ type: 'tool_use', id: tu, name: tool.name, input: tool.input }], r, big);
    if (cutAt && t + tool.ms > cutAt) { t = cutAt; break; } // 아직 결과가 안 온 도구(진행 중)
    t += tool.ms;
    f.result(t, tu);
    t += 400;
  }
  if (finished) { const r = f.req(t); t += int(6, 15) * 1000; f.ai(t, model, [{ type: 'text', text: `${job}을(를) 마쳤어요. output 폴더에 저장했어요.` }], r); }
  const file = path.join(projDir(TEAM), sid, 'subagents', `agent-${agentId}.jsonl`);
  f.save(file);
  fs.writeFileSync(file.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType: who.name, description: job, ...(finished ? { finished: true } : {}), toolUseId }));
  return t;
}

const BUILTIN = { name: 'Explore', model: 'claude-haiku-5-5' };
const weighted = STAFF.flatMap((s) => Array(s.weight).fill(s));
const dayAt = (d, h) => { const x = new Date(now - d * DAY); x.setHours(0, 0, 0, 0); return x.getTime() + h * 3600000; };

/** 팀장이 직원에게 맡기는 요청 한 건 */
function delegate(f, sid, t, who, { steps, finished = true, cutAt = null, big = 1, notify = true } = {}) {
  const job = pick(who.jobs || ['자료 폴더 훑어보기']);
  f.user(t, `${job} 부탁해`);
  const r = f.req(t + 800);
  const tu = id('toolu');
  f.ai(t + 6000, LEAD_MODEL, [{ type: 'tool_use', id: tu, name: 'Agent', input: { subagent_type: who.name, description: job, run_in_background: true } }], r);
  f.result(t + 6500, tu);
  f.ai(t + 11000, LEAD_MODEL, [{ type: 'text', text: `${job}을(를) 맡겼어요. 끝나면 알려 드릴게요.` }]);
  const end = staffRun({ sid, who, job, t0: t + 6500, steps: steps ?? (who.heavy ? int(8, 13) : int(4, 8)), toolUseId: tu, finished, cutAt, big });
  if (finished && notify) {
    f.user(end + 2000, `<task-notification>\n<tool-use-id>${tu}</tool-use-id>\n<status>completed</status>\n<summary>Agent "${job}" finished</summary>\n</task-notification>`);
    f.ai(end + 9000, LEAD_MODEL, [{ type: 'text', text: `${job} 결과를 받아 정리했어요.` }]);
    return end + 9000;
  }
  return end;
}

/** 팀장 세션이 직접 하는 일(직원에게 안 맡김) */
function direct(f, t, model, prompt, cwd) {
  f.user(t, prompt);
  for (let i = 0; i < int(3, 6); i++) {
    const r = f.req(t + 500);
    t += int(5, 30) * 1000;
    const tu = id('toolu');
    const tool = pick([
      { name: 'Read', input: { file_path: `${cwd}\\${pick(['index.html', 'style.css', 'README.md', 'notes.md'])}` } },
      { name: 'Edit', input: { file_path: `${cwd}\\${pick(['index.html', 'style.css', 'app.js'])}` } },
      { name: 'Bash', input: { command: 'npm test', description: '시험 돌리기' } },
    ]);
    f.ai(t, model, [{ type: 'tool_use', id: tu, ...tool }], r);
    t += int(1, 20) * 1000;
    f.result(t, tu);
  }
  f.ai(t + 8000, model, [{ type: 'text', text: '고쳤어요.' }]);
  return t + 8000;
}

// 4주치 팀장 세션: 하루 1~3건, 사흘 전은 몰린 날, 이틀 전은 비싼 조사, 어제는 멈춘 작업
for (let d = 27; d >= 1; d--) {
  const wd = new Date(dayAt(d, 12)).getDay();
  if ((wd === 0 || wd === 6) && d > 3) continue; // 주말은 쉬되, 최근 사흘은 특별한 날이라 남긴다
  const sid = `demo-team-${String(d).padStart(2, '0')}`;
  const f = jsonl(TEAM.cwd);
  f.title(pick(['주간 보고·블로그 업무', '고객 제안 준비', '교육 과정 기획', '마케팅 자료 만들기', '조사·정리 업무']));
  let t = dayAt(d, 9 + rnd() * 1.5);
  const turns = d === 3 ? 7 : int(1, 3);
  for (let k = 0; k < turns; k++) {
    if (d === 2 && k === 0) t = delegate(f, sid, t, STAFF[2], { steps: 42, big: 2 });
    else if (d === 1 && k === 0) t = delegate(f, sid, t, STAFF[1], { steps: 3, finished: false });
    else if (rnd() < 0.12) t = delegate(f, sid, t, BUILTIN, { steps: int(3, 5) });
    else if (rnd() < 0.15) t = direct(f, t, LEAD_MODEL, '보고서 폴더 이름을 날짜순으로 정리해 줘', TEAM.cwd);
    else t = delegate(f, sid, t, pick(weighted));
    t += int(20, 90) * MIN;
  }
  f.save(path.join(projDir(TEAM), `${sid}.jsonl`));
}

// 오늘: 끝난 일 하나 + 지금 리서치팀이 일하는 중
{
  const sid = 'demo-team-00';
  const f = jsonl(TEAM.cwd);
  f.title('이번 주 업무');
  delegate(f, sid, now - 95 * MIN, STAFF[0], { steps: 5 });
  delegate(f, sid, now - 9 * MIN, STAFF[2], { steps: 30, finished: false, cutAt: now - 40000 });
  const tu = id('toolu');
  const r = f.req(now - 100000);
  f.ai(now - 90000, LEAD_MODEL, [{ type: 'tool_use', id: tu, name: 'Read', input: { file_path: `${TEAM.cwd}\\자료\\고객-목록.xlsx` } }], r);
  f.result(now - 88000, tu);
  f.save(path.join(projDir(TEAM), `${sid}.jsonl`));
}

// 다른 프로젝트: 홈페이지를 직접 고치는 세션(Sonnet)
for (const d of [20, 13, 9, 6, 2]) {
  const f = jsonl(SIDE.cwd);
  f.title(pick(['문의 폼 고치기', '첫 화면 문구 바꾸기', '휴대폰 화면 손보기']));
  let t = dayAt(d, 19 + rnd());
  for (let k = 0; k < int(1, 2); k++) t = direct(f, t, 'claude-sonnet-5-5', pick(['문의 폼 전송이 안 돼, 고쳐 줘', '첫 화면 문구를 더 짧게', '휴대폰에서 메뉴가 겹쳐']), SIDE.cwd) + 30 * MIN;
  f.save(path.join(projDir(SIDE), `demo-home-${d}.jsonl`));
}

// ── 설정: 부르는 이름·목표·예산 ──
process.env.CLAUDE_CONFIG_DIR = claude;
process.env.AMC_HOME = state;
process.env.AMC_CONFIG_DIR = path.join(state, 'config');
process.env.AMC_REPORTS_DIR = path.join(state, 'reports');
process.env.CLAUDE_OFFICE_HOME = path.join(root, 'no-office'); // 3D 사무실은 설치 안 한 것으로
process.env.CLAUDE_OFFICE_PORT = '1';
process.env.PORT = opt('port', '4795');

const { runSetup } = await import(pathToFileURL(path.join(appDir, 'scripts', 'setup.mjs')));
const r = runSetup({ owner: '팀장님' });
const profiles = JSON.parse(fs.readFileSync(r.file, 'utf8'));
for (const s of STAFF) if (profiles.agents[s.name]) profiles.agents[s.name].goals = s.goals;
fs.writeFileSync(r.file, JSON.stringify(profiles, null, 2) + '\n');
fs.writeFileSync(path.join(state, 'config', 'budget.json'), JSON.stringify({ monthlyUsd: 60, warnAt: [50, 80, 100], staff: { researcher: 15 }, runUsd: 5, dailySpike: 3, dailyMinUsd: 5 }, null, 2) + '\n');
// 알림이 '처음 설치'로 모두 읽음 처리되지 않게(구경할 때 🔔 에 새 알림이 보이도록)
fs.writeFileSync(path.join(state, 'alerts.json'), JSON.stringify({ v: 1, seen: { 'demo-start': { first: now, read: now } } }));

console.log(`가상 데이터를 만들었어요: ${root}\n직원 ${r.staff.length}명 · 팀장 폴더 ${r.lead || '(없음)'} · 부르는 이름 ${r.owner}`);
if (!argv.includes('--no-serve')) {
  await import(pathToFileURL(path.join(appDir, 'server', 'server.mjs')));
  console.log(`구경: http://127.0.0.1:${process.env.PORT}  (끄려면 Ctrl+C)`);
}
