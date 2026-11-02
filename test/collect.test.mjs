// 가짜 기록 폴더로 수집·집계를 시험한다. 진짜 ~/.claude 는 건드리지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe as describeBlock, scanAll } from '../server/collect.mjs';
import { loadRegistry, summarize } from '../server/aggregate.mjs';
import { buildLive } from '../server/live.mjs';

const pricing = {
  usdToKrw: 1400, monthlyBudgetUsd: null, fallbackModel: 'claude-opus-5-5',
  models: { 'claude-opus-5-5': { input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2 } },
};
const profiles = {
  agents: { 'book-author': { team: '집필팀', color: '#eb6834', purpose: '원고 집필' } },
  lead: { name: '팀장', project: 'skill-team' },
};

const line = (o) => JSON.stringify(o) + '\n';
const usage = (o = {}) => ({
  input_tokens: 10, output_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: 5000,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 }, ...o,
});
const assistant = (id, ts, content = [], u = usage()) => line({
  type: 'assistant', timestamp: ts, cwd: 'C:\\work\\skill-team', requestId: 'req_' + id,
  message: { id, model: 'claude-opus-5-5', usage: u, content },
});
const user = (ts, content, extra = {}) => line({ type: 'user', timestamp: ts, cwd: 'C:\\work\\skill-team', message: { role: 'user', content }, ...extra });

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amc-test-'));
  const projects = path.join(root, 'projects');
  const agents = path.join(root, 'agents');
  const proj = path.join(projects, 'C--work-skill-team');
  const sid = 'sess-1';
  fs.mkdirSync(path.join(proj, sid, 'subagents'), { recursive: true });
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, 'book-author.md'),
    '---\r\nname: book-author\r\ndescription: 집필팀 직원\r\n---\r\n\r\n| 스킬 | 언제 |\r\n|---|---|\r\n| `anthropic-skills:book-writer-two` | 집필 |\r\n| `anthropic-skills:book-writer-human` | 문체 |\r\n');

  const now = Date.now();
  const t = (min) => new Date(now - min * 60000).toISOString();
  // 팀장 세션: 사람 요청 1회, 같은 응답이 두 줄로 나뉨, 작업 알림은 요청으로 세지 않음
  fs.writeFileSync(path.join(proj, sid + '.jsonl'),
    user(t(30), '1장 써 줘')
    + assistant('msg_a', t(29), [{ type: 'thinking', thinking: '' }])
    + assistant('msg_a', t(29), [{ type: 'tool_use', name: 'Agent', input: { subagent_type: 'book-author' } }])
    + user(t(28), [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }])
    + user(t(10), '<task-notification>done</task-notification>')
    + line({ type: 'custom-title', customTitle: '1장 집필' }));
  // 직원 작업: 스킬을 부른 뒤의 응답 토큰은 스킬 몫
  const sub = path.join(proj, sid, 'subagents', 'agent-1.jsonl');
  fs.writeFileSync(sub,
    user(t(28), '1장을 써라')
    + assistant('msg_s1', t(27), [{ type: 'tool_use', name: 'Skill', input: { skill: 'anthropic-skills:book-writer-two' } }])
    + user(t(27), [{ type: 'tool_result', tool_use_id: 'y', content: 'skill loaded' }])
    + assistant('msg_s2', t(20), [{ type: 'text', text: '다 썼어요' }]));
  fs.writeFileSync(sub.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType: 'book-author', description: '1장 집필', finished: true }));
  return { root, projects, agents, sub, now };
}

const oneEventCost = (10 * 4 + 100 * 20 + 1000 * 8 + 5000 * 0.2) / 1e6;

test('같은 응답의 여러 줄은 한 번만 세고, 직원·스킬·팀장으로 나눈다', async () => {
  const f = makeFixture();
  const cacheFile = path.join(f.root, 'state', 'cache.json');
  const cache = await scanAll({ projectsDir: f.projects, cacheFile });
  const staff = loadRegistry(f.agents, profiles);
  assert.deepEqual(staff[0].skills, ['anthropic-skills:book-writer-two', 'anthropic-skills:book-writer-human']);

  const s = summarize({ cache, staff, profiles, pricing, range: '7d', now: f.now });
  assert.equal(s.kpi.staffRuns, 1);
  assert.equal(s.kpi.staffDone, 1);
  assert.equal(s.kpi.prompts, 1, '작업 알림은 사람 요청이 아니다');
  assert.equal(s.lead.prompts, 1);
  assert.ok(Math.abs(s.lead.cost - oneEventCost) < 1e-9, '팀장 응답은 한 번만 센다');
  assert.ok(Math.abs(s.staff[0].cost - 2 * oneEventCost) < 1e-9);
  assert.equal(s.staff[0].runs, 1);
  assert.equal(s.staff[0].skills[0].calls, 1);
  assert.equal(s.staff[0].skills[1].calls, 0);
  assert.equal(s.skills[0].calls, 1);
  assert.ok(Math.abs(s.skills[0].cost - oneEventCost) < 1e-9, '스킬을 부른 뒤의 응답만 스킬 몫');
  assert.deepEqual(s.unusedSkills.map((u) => u.skill), ['anthropic-skills:book-writer-human']);
  assert.equal(s.runs[0].durationMs, 8 * 60000);
  assert.equal(s.runs[0].lead, true);
  assert.equal(s.buckets.length, 7);
});

test('새로 붙은 줄만 읽고, 끝나지 않은 마지막 줄은 다음에 읽는다', async () => {
  const f = makeFixture();
  const cacheFile = path.join(f.root, 'state', 'cache.json');
  let cache = await scanAll({ projectsDir: f.projects, cacheFile });
  const key = Object.keys(cache.files).find((k) => k.endsWith('agent-1.jsonl'));
  assert.equal(cache.files[key].events.length, 2);

  const extra = assistant('msg_s3', new Date(f.now - 5 * 60000).toISOString(), []);
  fs.appendFileSync(f.sub, extra.slice(0, 40)); // 쓰는 중인 줄
  cache = await scanAll({ projectsDir: f.projects, cacheFile, cache });
  assert.equal(cache.files[key].events.length, 2);

  fs.appendFileSync(f.sub, extra.slice(40));
  cache = await scanAll({ projectsDir: f.projects, cacheFile, cache });
  assert.equal(cache.files[key].events.length, 3);
  assert.equal(cache.files[key].events[2][7], 0, '사람 요청 전까지는 앞서 부른 스킬 몫');

  // 캐시 파일에서 다시 읽어도 같다
  const again = await scanAll({ projectsDir: f.projects, cacheFile });
  assert.equal(again.files[key].events.length, 3);
});

test('활동 기록: 도구·스킬·요청·작업 시작과 끝을 남기고, 명령 원문은 감춘다', async () => {
  assert.deepEqual(describeBlock({ type: 'tool_use', name: 'Bash', input: { command: 'curl -H "x-api-key: sk-secret" …' } }), { k: 'bash', a: 'Bash' });
  assert.deepEqual(describeBlock({ type: 'tool_use', name: 'Read', input: { file_path: 'C:\\a\\b\\app.js' } }), { k: 'read', a: 'app.js' });
  assert.deepEqual(describeBlock({ type: 'tool_use', name: 'mcp__ccd_turn__update_plan', input: {} }), { k: 'mcp', a: 'update_plan' });
  assert.equal(describeBlock({ type: 'thinking', thinking: '' }), null);

  const f = makeFixture();
  const cache = await scanAll({ projectsDir: f.projects, cacheFile: path.join(f.root, 'state', 'cache.json') });
  const kinds = cache.activity.map((a) => a.k);
  for (const k of ['prompt', 'agent', 'start', 'skill', 'text', 'done']) assert.ok(kinds.includes(k), k + ' 활동이 있어야 한다');
  assert.equal(kinds.filter((k) => k === 'prompt').length, 2, '팀장 요청 1 + 직원이 받은 일 1, 작업 알림은 뺀다');
  assert.ok(cache.activity.every((a, i, arr) => i === 0 || arr[i - 1].t <= a.t), '시간 순');

  // 끝나지 않은 직원 작업 → 일하는 중, 지금 하는 일 = 마지막 도구
  const sub2 = path.join(path.dirname(f.sub), 'agent-2.jsonl');
  const ts = new Date(f.now - 60000).toISOString();
  fs.writeFileSync(sub2, user(ts, '2장을 써라')
    + assistant('msg_x', ts, [{ type: 'tool_use', name: 'Write', input: { file_path: 'C:\\out\\2장.docx' } }]));
  fs.writeFileSync(sub2.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType: 'book-author', description: '2장 집필' }));
  await scanAll({ projectsDir: f.projects, cache, persist: false });
  const staff = loadRegistry(f.agents, profiles);
  const live = buildLive({ cache, staff, profiles, pricing, office: null, officeUrl: 'http://127.0.0.1:4777', now: f.now });
  assert.equal(live.office.up, false);
  assert.equal(live.office.installed, false, '3D 사무실을 설치하지 않았으면 화면이 설치 안내를 보인다');
  assert.equal(buildLive({ cache, staff, profiles, pricing, office: null, officeUrl: 'x', officeInstalled: true, now: f.now }).office.installed, true);
  assert.equal(live.staff['book-author'].state, 'working');
  assert.equal(live.staff['book-author'].desc, '2장 집필');
  assert.deepEqual(live.staff['book-author'].doing, { k: 'write', a: '2장.docx' });
  assert.equal(live.counts.working, 1);
  assert.ok(live.feedTeam.length > 0 && live.feedTeam.every((it) => ['staff', 'lead', 'office'].includes(it.who.group)));
  const done = live.feed.find((it) => it.k === 'done');
  assert.equal(done.dur, 8 * 60000);
  assert.ok(Math.abs(done.cost - 2 * oneEventCost) < 1e-9);

  // 3D 사무실이 켜져 있으면 승인 대기·팀장 상태를 그쪽에서 받는다
  const office = { hooks: true, people: [{ name: 'skill-team', path: 'C:\\work\\skill-team', status: 'decision', ask: 'Bash 사용 승인', subs: [] }] };
  const live2 = buildLive({ cache, staff, profiles, pricing, office, officeUrl: 'x', now: f.now });
  assert.equal(live2.lead.state, 'decision');
  assert.equal(live2.office.installed, true, '켜져 있으면 설치된 것');
  assert.equal(live2.counts.decision, 1);
  assert.equal(live2.people[0].lead, true);
});

test('3D 사무실이 끝난 직원을 아직 일하는 중으로 보내도 우리 기록(meta finished)으로 걸러 낸다', async () => {
  const f = makeFixture();
  const cache = await scanAll({ projectsDir: f.projects, cacheFile: path.join(f.root, 'state', 'cache.json') });
  const staff = loadRegistry(f.agents, profiles);
  const office = { hooks: true, people: [{ name: 'skill-team', path: 'C:/work/skill-team', status: 'working', subCount: 1,
    subs: [{ id: '1', type: 'book-author', desc: '1장 집필', doing: { k: 'tool', a: 'SubagentHandback' } }] }] };
  const live = buildLive({ cache, staff, profiles, pricing, office, officeUrl: 'x', now: f.now });
  assert.equal(live.staff['book-author'].state, 'idle');
  assert.equal(live.people[0].subs.length, 0);
  assert.equal(live.people[0].subCount, 0);
});
