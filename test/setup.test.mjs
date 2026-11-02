// 누구 PC 에서나: 처음 설정(프로필 초안·팀장 폴더 찾기), 설치된 스킬 읽기, ctl.mjs 로 켜기·현황·예산·모델·끄기를 임시 폴더에서 시험한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildProfiles, detectLead, purposeOf, teamOf } from '../scripts/setup.mjs';
import { scanLocalSkills } from '../server/skilldb.mjs';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const ctl = path.join(here, '..', 'scripts', 'ctl.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'amc-setup-'));
const line = (o) => JSON.stringify(o) + '\n';

test('프로필 초안: 설명에서 팀 이름·목적을 뽑고, 이미 고쳐 둔 직원은 그대로 둔다', () => {
  assert.equal(teamOf('book-author', '스킬팀 집필팀 직원. 원고를 쓴다.'), '집필팀');
  assert.equal(teamOf('data-cruncher', 'Crunches numbers.'), 'Data Cruncher');
  assert.equal(purposeOf('스킬팀 집필팀 직원. 기획서로 원고를 쓴다. 문체도 고친다.'), '기획서로 원고를 쓴다.');
  const staff = [{ name: 'book-author', description: '스킬팀 집필팀 직원. 원고를 쓴다.' }, { name: 'data-cruncher', description: 'Crunches numbers.' }];
  const existing = { owner: '대표님', agents: { 'book-author': { team: '내가 고친 팀', color: '#2a78d6', purpose: '내가 쓴 목적' } }, lead: { project: 'hq' } };
  const { profiles, added } = buildProfiles(staff, existing, {});
  assert.deepEqual(added, ['data-cruncher']);
  assert.equal(profiles.agents['book-author'].team, '내가 고친 팀');
  assert.equal(profiles.owner, '대표님');
  assert.equal(profiles.lead.project, 'hq');
  assert.notEqual(profiles.agents['data-cruncher'].color, '#2a78d6', '이미 쓴 색은 피한다');
  assert.equal(buildProfiles(staff, {}, {}).profiles.owner, '사용자');
});

test('팀장 폴더 찾기: 직원에게 일을 가장 많이 맡긴 프로젝트의 작업 폴더 이름', () => {
  const projects = tmp();
  const mk = (key, cwd, subs) => {
    const p = path.join(projects, key);
    fs.mkdirSync(path.join(p, 's1', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(p, 's1.jsonl'), line({ type: 'summary' }) + line({ type: 'user', cwd, message: { content: 'hi' } }));
    subs.forEach((t, i) => fs.writeFileSync(path.join(p, 's1', 'subagents', `agent-${i}.meta.json`), JSON.stringify({ agentType: t })));
  };
  mk('C--work-my-team', 'C:\\work\\my-team', ['writer', 'writer', 'Explore']);
  mk('C--work-other', 'C:\\work\\other', ['writer', 'general-purpose', 'Explore', 'Explore']);
  const lead = detectLead(projects, new Set(['writer']));
  assert.deepEqual(lead, { project: 'my-team', key: 'C--work-my-team', runs: 2 });
  assert.equal(detectLead(projects, new Set(['nobody'])), null);
});

test('설치된 스킬: 내 스킬과 설치한 플러그인의 스킬만 읽고(마켓 목록은 뺀다), 여러 줄 설명도 읽는다', () => {
  const root = tmp();
  const skills = path.join(root, 'skills');
  const plugins = path.join(root, 'plugins');
  const skill = (dir, name, front) => { fs.mkdirSync(path.join(dir, name), { recursive: true }); fs.writeFileSync(path.join(dir, name, 'SKILL.md'), `---\n${front}\n---\n본문`); };
  skill(skills, 'my-skill', 'name: my-skill\ndescription: >\n  두 줄로\n  쓴 설명\nversion: 1.2.0');
  const install = path.join(plugins, 'cache', 'mkt', 'good-plugin', '1.0.0');
  skill(path.join(install, 'skills'), 'plug-skill', 'name: plug-skill\ndescription: "플러그인 스킬"');
  skill(path.join(plugins, 'marketplaces', 'mkt', 'plugins', 'not-installed', 'skills'), 'nope', 'name: nope\ndescription: x');
  fs.writeFileSync(path.join(plugins, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'good-plugin@mkt': [{ installPath: install, version: '1.0.0' }] } }));
  const d = scanLocalSkills({ skillsDir: skills, pluginsDir: plugins });
  assert.equal(d.source, 'local');
  assert.deepEqual(d.rows.map((r) => [r.id, r.category]), [['my-skill', '내 스킬'], ['plug-skill', '플러그인: good-plugin']]);
  assert.equal(d.rows[0].purpose, '두 줄로 쓴 설명');
  assert.equal(d.rows[0].version, '1.2.0');
  assert.equal(d.rows[1].purpose, '플러그인 스킬');
});

test('ctl.mjs: 빈 PC 에서 설정 → 켜기 → 현황·예산·모델 바꾸기 → 끄기', async (t) => {
  const root = tmp();
  const claude = path.join(root, 'claude');
  fs.mkdirSync(path.join(claude, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(claude, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(claude, 'agents', 'writer.md'), '---\r\nname: writer\r\ndescription: 글팀 직원. 글을 쓴다.\r\n---\r\n본문\r\n');
  const env = {
    ...process.env, CLAUDE_CONFIG_DIR: claude, AMC_HOME: path.join(root, 'state'), AMC_CONFIG_DIR: path.join(root, 'state', 'config'),
    AMC_REPORTS_DIR: path.join(root, 'reports'), PORT: String(48000 + Math.floor(Math.random() * 1000)), CLAUDE_OFFICE_PORT: '1',
  };
  const ctlRun = (...args) => run(process.execPath, [ctl, ...args], { env, timeout: 60000 }).then((r) => r.stdout);
  t.after(() => run(process.execPath, [ctl, 'stop'], { env }).catch(() => {}));

  const setup = await ctlRun('setup', '--owner', '팀장님');
  assert.match(setup, /직원 1명/);
  assert.match(setup, /글팀\(writer\)/);
  assert.match(setup, /부르는 이름: 팀장님/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'state', 'config', 'profiles.json'), 'utf8')).agents.writer.team, '글팀');

  const started = await ctlRun('start', '--no-open');
  assert.match(started, /켜져 있어요/);
  const status = await ctlRun('status', '--range', 'today');
  assert.match(status, /Claude Skill Team Control Center · 오늘/);
  assert.match(status, /팀장님 요청 0회/);
  assert.match(status, /월 예산 없음/);

  assert.match(await ctlRun('budget', '--monthly', '50', '--staff', 'writer=5'), /월 예산: \$50\.00/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'state', 'config', 'budget.json'), 'utf8')).staff.writer, 5);

  assert.match(await ctlRun('model', 'writer', 'sonnet'), /writer: model: sonnet/);
  const md = fs.readFileSync(path.join(claude, 'agents', 'writer.md'), 'utf8');
  assert.ok(md.includes('description: 글팀 직원. 글을 쓴다.\r\nmodel: sonnet\r\n---'), 'CRLF 를 지키며 model 줄을 넣는다');
  await ctlRun('model', 'writer', 'default');
  assert.ok(!fs.readFileSync(path.join(claude, 'agents', 'writer.md'), 'utf8').includes('model:'));
  await assert.rejects(ctlRun('model', 'writer', 'gpt-4'), /모델 값이 맞지 않아요/);

  assert.match(await ctlRun('stop'), /서버를 껐어요/);
});
