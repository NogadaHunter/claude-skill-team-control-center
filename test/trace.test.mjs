// 트레이스(단계 타임라인)·작업 패턴·워크플로 지도 데이터를 가짜 기록으로 시험한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanAll } from '../server/collect.mjs';
import { loadRegistry, summarize } from '../server/aggregate.mjs';
import { buildLive } from '../server/live.mjs';
import { patternFor, traceFor } from '../server/trace.mjs';

const pricing = {
  usdToKrw: 1400, monthlyBudgetUsd: null, fallbackModel: 'claude-opus-5-5',
  models: { 'claude-opus-5-5': { input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2 } },
};
const profiles = { agents: { 'book-author': { team: '집필팀', color: '#eb6834' } }, lead: { name: '팀장', project: 'skill-team' } };
const usage = { input_tokens: 10, output_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: 5000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 } };
const oneEventCost = (10 * 4 + 100 * 20 + 1000 * 8 + 5000 * 0.2) / 1e6;

const line = (o) => JSON.stringify(o) + '\n';
const assistant = (id, ts, content, extra = {}) => line({ type: 'assistant', timestamp: ts, message: { id, model: 'claude-opus-5-5', usage, content }, ...extra });
const user = (ts, content) => line({ type: 'user', timestamp: ts, message: { role: 'user', content } });
const result = (ts, id, extra = {}) => user(ts, [{ type: 'tool_result', tool_use_id: id, content: 'ok', ...extra }]);
const apiReq = (id, ts) => line({ type: 'api-request', id, timestamp: ts });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amc-trace-'));
  const projects = path.join(root, 'projects');
  const agents = path.join(root, 'agents');
  const proj = path.join(projects, 'C--work-skill-team');
  fs.mkdirSync(path.join(proj, 'sess-t', 'subagents'), { recursive: true });
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, 'book-author.md'), '---\nname: book-author\ndescription: 집필팀\n---\n| `anthropic-skills:book-writer-two` | 집필 |\n');
  const now = Date.now();
  const t = (min) => new Date(now - min * 60000).toISOString();
  const ms = (min) => Date.parse(t(min));

  const leadFile = path.join(proj, 'sess-t.jsonl');
  fs.writeFileSync(leadFile,
    user(t(30), '1장 써 줘')
    + apiReq('r1', t(29.9))
    + assistant('msg_a', t(29.5), [{ type: 'thinking', thinking: '' }], { requestRef: 'r1' })
    + assistant('msg_a', t(29.4), [{ type: 'tool_use', id: 'toolu_1', name: 'Agent', input: { subagent_type: 'book-author', description: '1장 집필' } }], { requestRef: 'r1' })
    + result(t(29.3), 'toolu_1')
    + assistant('msg_b', t(29), [{ type: 'text', text: '집필팀에 맡겼어요' }])
    + user(t(10), '<task-notification>\n<tool-use-id>toolu_1</tool-use-id>\n<status>completed</status>\n<summary>Agent "1장 집필" finished</summary>\n</task-notification>')
    + assistant('msg_c', t(9.5), [{ type: 'text', text: '1장이 끝났어요' }])
    + line({ type: 'user', isCompactSummary: true, timestamp: t(9), message: { role: 'user', content: 'This session is being continued from a previous conversation' } })
    + user(t(5), '2장도 써 줘')
    + assistant('msg_d', t(4), [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'curl -H "x-api-key: sk-secret"', description: '목록 보기' } }])
    + result(t(3), 'toolu_2', { is_error: true }));

  const sub = path.join(proj, 'sess-t', 'subagents', 'agent-1.jsonl');
  fs.writeFileSync(sub,
    user(t(28), '1장을 써라. 기획서는 docs/plan.docx')
    + apiReq('r2', t(27.9))
    + assistant('msg_s1', t(27), [{ type: 'tool_use', id: 'toolu_s1', name: 'Skill', input: { skill: 'anthropic-skills:book-writer-two' } }], { requestRef: 'r2' })
    + result(t(26), 'toolu_s1')
    + assistant('msg_s2', t(20), [{ type: 'tool_use', id: 'toolu_w', name: 'Write', input: { file_path: 'C:\\out\\1장.docx' } }])
    + result(t(12), 'toolu_w')
    + assistant('msg_s3', t(11), [{ type: 'text', text: '다 썼어요' }]));
  fs.writeFileSync(sub.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType: 'book-author', description: '1장 집필', finished: true, toolUseId: 'toolu_1' }));
  return { root, projects, agents, leadFile, now, ms };
}

async function load() {
  const f = fixture();
  const cache = await scanAll({ projectsDir: f.projects, cacheFile: path.join(f.root, 'state', 'cache.json') });
  const staff = loadRegistry(f.agents, profiles);
  return { ...f, cache, staff, ctx: { cache, staff, profiles, pricing, now: f.now } };
}

test('세션의 사람 요청마다 바이트 위치를 남기고, 직원 meta 의 맡긴 도구 id 를 읽는다', async () => {
  const { cache, leadFile } = await load();
  const lead = cache.files[leadFile];
  assert.equal(lead.turns.length, 2, '작업 알림은 요청이 아니다');
  assert.deepEqual(lead.turns.map((x) => x[2]), ['1장 써 줘', '2장도 써 줘']);
  const buf = fs.readFileSync(leadFile);
  for (const [, off, prompt] of lead.turns) {
    const first = buf.subarray(off, buf.indexOf(0x0a, off)).toString('utf8');
    assert.ok(first.startsWith('{"type":"user"') && first.includes(prompt), '위치가 그 요청 줄의 처음을 가리킨다');
  }
  const sub = Object.values(cache.files).find((s) => s.kind === 'sub');
  assert.equal(sub.meta.toolUseId, 'toolu_1');
});

test('직원 작업 트레이스: 응답은 요청 보낸 때부터, 도구는 결과가 올 때까지 재고 맡긴 곳을 잇는다', async () => {
  const { ctx, ms } = await load();
  const tr = await traceFor({ ...ctx, id: 'agent-1' });
  assert.equal(tr.status, 'done');
  assert.equal(tr.title, '1장 집필');
  assert.ok(tr.prompt.startsWith('1장을 써라'));
  assert.equal(tr.totals.llm, 3);
  assert.equal(tr.totals.tools, 2);
  const [s1, skill, s2, write] = tr.steps;
  assert.equal(s1.type, 'llm');
  assert.equal(s1.t0, ms(27.9), 'api-request 시각이 응답의 시작');
  assert.equal(s2.t0, ms(26), 'api-request 가 없으면 직전 도구 결과 시각');
  assert.equal(skill.k, 'skill');
  assert.equal(skill.parent, s1.i);
  assert.equal(write.cat, 'write');
  assert.equal(write.t1 - write.t0, 8 * 60000);
  assert.ok(Math.abs(tr.totals.cost - 3 * oneEventCost) < 1e-9);
  assert.equal(tr.totals.share.write, 8 * 60000, '쓰기 도구가 돈 8분');
  assert.equal(tr.durationMs, 17 * 60000, '지시를 받은 때부터 마지막 응답까지');
  assert.deepEqual(tr.totals.skills, ['book-writer-two']);
  assert.equal(tr.parent.id, 'sess-t');
  assert.equal(tr.parent.prompt, '1장 써 줘');
  assert.equal(tr.parent.who.group, 'lead');
});

test('팀장 요청 트레이스: 그 요청 범위만 읽고, 맡긴 직원 작업과 끝 알림을 잇는다', async () => {
  const { ctx, ms } = await load();
  const t1 = await traceFor({ ...ctx, id: 'sess-t', at: ms(30) });
  assert.equal(t1.kind, 'main');
  assert.equal(t1.title, '1장 써 줘');
  assert.equal(t1.turn.index, 0);
  assert.equal(t1.turn.next, ms(5));
  const llms = t1.steps.filter((s) => s.type === 'llm');
  assert.equal(llms.length, 3, '같은 응답의 두 줄은 한 단계, 다음 요청의 응답은 빠진다');
  assert.equal(llms[0].t0, ms(29.9));
  assert.equal(llms[0].t1, ms(29.4));
  assert.equal(llms[1].t0, ms(29.3));
  const agent = t1.steps.find((s) => s.k === 'agent');
  assert.equal(agent.child.id, 'agent-1');
  assert.equal(agent.child.who.key, 'book-author');
  assert.equal(agent.child.status, 'done');
  assert.ok(t1.view1 >= agent.child.t1);
  assert.equal(t1.marks.length, 1);
  assert.equal(t1.marks[0].k, 'notify');
  assert.equal(t1.marks[0].a, '1장 집필');
  assert.equal(t1.marks[0].child.id, 'agent-1');

  const t2 = await traceFor({ ...ctx, id: 'sess-t', at: ms(5) });
  assert.equal(t2.turn.index, 1);
  assert.equal(t2.turn.prev, ms(30));
  assert.equal(t2.totals.errors, 1);
  const bash = t2.steps.find((s) => s.type === 'tool');
  assert.equal(bash.a, '목록 보기');
  assert.ok(!JSON.stringify(t2).includes('sk-secret'), '명령 원문은 트레이스에 없다');
  assert.equal(await traceFor({ ...ctx, id: 'nope' }), null);
});

test('작업 패턴: 실행마다 시간 띠를 만들고, 하는 일이 나오는 순서를 잡는다', async () => {
  const { ctx } = await load();
  const p = await patternFor({ ...ctx, agent: 'book-author' });
  assert.equal(p.n, 1);
  const sum = p.runs[0].strip.reduce((a, x) => a + x.w, 0);
  assert.ok(Math.abs(sum - 1) < 0.01, '띠 너비를 다 더하면 1');
  const cats = p.order.map((o) => o.cat);
  assert.ok(cats.indexOf('skill') < cats.indexOf('write'), '스킬을 먼저 펴고 나중에 쓴다');
  const lead = await patternFor({ ...ctx, agent: '__lead' });
  assert.equal(lead.n, 2);
});

test('요약: 팀장 요청별 비용·맡긴 직원, 워크플로 지도 연결, 피드 항목의 트레이스 링크', async () => {
  const { ctx, cache, staff, now, ms } = await load();
  const s = summarize({ cache, staff, profiles, pricing, range: '7d', now });
  assert.equal(s.leadTurns.length, 2);
  const [second, first] = s.leadTurns;
  assert.equal(second.prompt, '2장도 써 줘');
  assert.deepEqual(first.agents, ['book-author']);
  assert.equal(first.at, ms(30));
  assert.ok(Math.abs(first.cost - 3 * oneEventCost) < 1e-9, '첫 요청의 응답 3개');
  assert.equal(s.runs[0].id, 'agent-1');
  assert.deepEqual(s.flow.links.map((l) => [l.from, l.to, l.runs]), [['lead', 'book-author', 1]]);
  assert.deepEqual(s.flow.skillLinks.map((l) => [l.from, l.skill, l.calls]), [['book-author', 'anthropic-skills:book-writer-two', 1]]);
  assert.equal(s.flow.leadPrompts, 2);

  const live = buildLive({ ...ctx, office: null, officeUrl: 'x' });
  const start = live.feed.find((it) => it.k === 'start');
  assert.deepEqual(start.ref, { id: 'agent-1', at: start.t });
  assert.equal(live.feed.find((it) => it.k === 'prompt' && it.a === '2장도 써 줘').ref.id, 'sess-t');
});
