// 운영 제언: 기록을 보고 예산·모델·일 맡기기·긴 작업·멈춘 작업 제언이 나오는지, 리포트에 안전하게 들어가는지 시험한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanAll } from '../server/collect.mjs';
import { loadRegistry, summarize } from '../server/aggregate.mjs';
import { advise } from '../server/advice.mjs';
import { renderReport } from '../server/report.mjs';

// 토큰 1개 = 1달러(Opus), Sonnet 은 그 절반
const pricing = {
  usdToKrw: 1400, fallbackModel: 'claude-opus-5-5',
  models: {
    'claude-opus-5-5': { input: 1e6, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
    'claude-sonnet-5-5': { input: 5e5, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
  },
};
const profiles = {
  agents: {
    'video-creator': { team: '영상제작팀', color: '#008300', purpose: '대본·쇼츠·홍보 영상을 만들어요' },
    'report-manager': { team: '보고서팀', color: '#e87ba4', purpose: '보고서·회의록을 만들어요' },
  },
  lead: { name: '팀장', project: 'skill-team' },
};
const line = (o) => JSON.stringify(o) + '\n';
const asst = (id, ts, usd) => line({ type: 'assistant', timestamp: ts, message: { id, model: 'claude-opus-5-5', usage: { input_tokens: usd, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, content: [] } });
const user = (ts, text) => line({ type: 'user', timestamp: ts, message: { role: 'user', content: text } });

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amc-advice-'));
  const agents = path.join(root, 'agents');
  fs.mkdirSync(agents);
  for (const n of ['video-creator', 'report-manager']) fs.writeFileSync(path.join(agents, n + '.md'), `---\nname: ${n}\n---\n| \`${n}-skill\` | 일 |\n`);
  const proj = path.join(root, 'projects', 'C--work-app');
  const subs = path.join(proj, 's1', 'subagents');
  fs.mkdirSync(subs, { recursive: true });
  const now = Date.now();
  const t = (min) => new Date(now - min * 60000).toISOString();
  // 직접 연 세션: 비싸고, 제목에 태그가 섞여 있다
  fs.writeFileSync(path.join(proj, 's1.jsonl'), user(t(300), '홍보 영상 만들어 줘') + asst('m1', t(299), 100)
    + line({ type: 'custom-title', customTitle: '<script>x</script> 홍보 영상 만들기' }));
  const sub = (id, desc, startMin, endMin, usd, meta = {}) => {
    fs.writeFileSync(path.join(subs, id + '.jsonl'), user(t(startMin), desc) + asst(id + '-a', t(endMin), usd));
    fs.writeFileSync(path.join(subs, id + '.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: desc, finished: true, ...meta }));
  };
  sub('agent-g1', 'Build promo video A', 250, 120, 3); // 2시간 넘게 걸린 작업
  sub('agent-g2', 'Build promo video B', 100, 90, 3);
  sub('agent-g3', 'Write card copy', 80, 75, 3);
  sub('agent-r1', '주간 보고서', 60, 30, 1, { agentType: 'report-manager', finished: false }); // 30분 넘게 멈춤
  const cache = await scanAll({ projectsDir: path.join(root, 'projects'), cacheFile: path.join(root, 'cache.json') });
  const staff = loadRegistry(agents, profiles);
  return { cache, staff, now };
}

function view({ cache, staff, now }, budget) {
  const d = summarize({ cache, staff, profiles, pricing, range: '7d', now, allSkills: true });
  d.month.budget = budget;
  d.budget = { monthlyUsd: budget, staff: {} };
  return d;
}

test('제언: 예산 없음·멈춘 작업·모델·직접 작업·기본 에이전트·긴 작업을 근거 숫자와 함께', async () => {
  const f = await fixture();
  const d = view(f, null);
  const list = advise({ d, db: null, cache: f.cache, pricing, staff: f.staff, profiles, now: f.now });
  const by = Object.fromEntries(list.map((a) => [a.id, a]));
  for (const id of ['budget-unset', 'stopped', 'model-light', 'delegate', 'builtin-to-staff', 'long-runs']) assert.ok(by[id], id + ' 제언이 있어야 한다');
  assert.equal(list[0].level, 'high', '우선순위가 높은 것부터');
  assert.equal(by.stopped.links[0].id, 'agent-r1', '멈춘 작업 타임라인으로 바로 가기');
  assert.match(by['model-light'].evidence, /\$110 → \$55\.00/, '전체를 Sonnet 단가로 다시 셈');
  assert.ok(by.delegate.evidence.includes('비용 큰 세션: 「<script>x</script> 홍보'), '비용 큰 세션을 제목으로(길면 줄임)');
  assert.ok(by.delegate.actions[0].includes('영상제작팀(video-creator)'), '세션 제목에 맞는 직원을 콕 집는다');
  assert.ok(by['builtin-to-staff'].title.includes('general-purpose') && by['builtin-to-staff'].actions[0].includes('subagent_type: video-creator'));
  assert.equal(by['long-runs'].links[0].id, 'agent-g1');
  for (const a of list) {
    assert.ok(a.title && a.evidence && a.actions.length && a.effect, a.id + ': 제목·근거·실행·효과가 다 있다');
  }
});

test('제언: 직원 일부를 이미 Sonnet 으로 바꿨으면 남긴 직원은 그대로 두고 직접 세션·결과 비교를 권한다', async () => {
  const f = await fixture();
  const staff = f.staff.map((s) => (s.name === 'video-creator' ? { ...s, model: 'sonnet' } : s));
  const d = view(f, null);
  const a = advise({ d, db: null, cache: f.cache, pricing, staff, profiles, now: f.now }).find((x) => x.id === 'model-light');
  assert.ok(a.title.startsWith('직접 여는 세션도'));
  assert.ok(a.evidence.includes('이미 가벼운 모델(영상제작팀)') && a.evidence.includes('보고서팀은 세션 모델 유지'));
  assert.ok(!a.actions.some((x) => x.includes('머리에 model: sonnet 넣기')), '남긴 직원을 다시 바꾸라고 하지 않는다');
});

test('제언: 직원 모두 모델을 Opus 5.5 로 정해 두었으면 직원 모델은 그대로 두고 직접 세션만 권한다', async () => {
  const f = await fixture();
  const staff = f.staff.map((s) => ({ ...s, model: 'claude-opus-5-5' }));
  const d = view(f, null);
  const a = advise({ d, db: null, cache: f.cache, pricing, staff, profiles, now: f.now }).find((x) => x.id === 'model-light');
  assert.ok(a.title.startsWith('직접 여는 세션도'));
  assert.ok(a.evidence.startsWith('직원 모두 Opus 5.5로 정해 둠'), a.evidence);
  assert.ok(!a.actions.some((x) => x.includes('머리에 model: sonnet')));
  assert.ok(a.actions.some((x) => x.startsWith('직원 모델은 정해 둔 대로 유지')));
});

test('제언: 월말 예산을 넘을 것 같으면 하루 한도와 함께 맨 위에', async () => {
  const f = await fixture();
  const d = view(f, 10);
  const list = advise({ d, db: null, cache: f.cache, pricing, staff: f.staff, profiles, now: f.now });
  assert.equal(list[0].id, 'budget-forecast');
  assert.ok(!list.some((a) => a.id === 'budget-unset'));
});

test('리포트: 우선 제언 상자와 8장(실행 계획·근거)이 들어가고, 기록에서 온 글자는 이스케이프한다', async () => {
  const f = await fixture();
  const d = view(f, null);
  d.advice = advise({ d, db: null, cache: f.cache, pricing, staff: f.staff, profiles, now: f.now });
  const html = renderReport({ summary: d, alerts: { unread: 0, alerts: [] }, db: { error: '없음' }, live: null, rangeLabel: '최근 7일', usdToKrw: 1400, now: f.now });
  for (const s of ['우선 제언', '더 잘 운영하기 위한 제언', '실행 계획', '제언별 근거와 실행 방법', '권장 기한', '이번 주']) assert.ok(html.includes(s), s);
  assert.ok(!html.includes('<script>x</script>'), '세션 제목의 태그는 그대로 들어가지 않는다');
  assert.ok(html.includes('&lt;script&gt;x&lt;/script&gt;'));
});
