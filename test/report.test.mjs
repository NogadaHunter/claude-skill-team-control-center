// A4 리포트: 기간 '이번 달', 섹션·요약 문장, 글자 이스케이프를 시험한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanAll } from '../server/collect.mjs';
import { loadRegistry, rangeStart, summarize } from '../server/aggregate.mjs';
import { renderReport, reportTitle } from '../server/report.mjs';

const pricing = { usdToKrw: 1400, fallbackModel: 'm', models: { m: { input: 1e6, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } } };
const profiles = { agents: { 'report-manager': { team: '보고서팀', color: '#e87ba4' } }, lead: { name: '팀장', project: 'skill-team' } };
const line = (o) => JSON.stringify(o) + '\n';

test('기간 "이번 달"은 그달 1일 0시부터', () => {
  const now = new Date(2026, 10, 20, 15, 30).getTime();
  assert.equal(rangeStart('month', now), new Date(2026, 10, 1).getTime());
});

test('리포트: 기간·요약·직원 표가 들어가고, 기록에서 온 글자는 이스케이프한다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amc-report-'));
  const proj = path.join(root, 'projects', 'C--work-skill-team');
  fs.mkdirSync(path.join(proj, 's1', 'subagents'), { recursive: true });
  fs.mkdirSync(path.join(root, 'agents'));
  fs.writeFileSync(path.join(root, 'agents', 'report-manager.md'), '---\nname: report-manager\n---\n| `meeting-minutes-pro` | 회의록 |\n');
  const now = Date.now();
  const t = (min) => new Date(now - min * 60000).toISOString();
  const usage = { input_tokens: 2, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  fs.writeFileSync(path.join(proj, 's1.jsonl'),
    line({ type: 'user', timestamp: t(30), message: { role: 'user', content: '회의록 <b>굵게</b> 정리해 줘' } })
    + line({ type: 'assistant', timestamp: t(29), message: { id: 'a1', model: 'm', usage, content: [] } }));
  const sub = path.join(proj, 's1', 'subagents', 'agent-x.jsonl');
  fs.writeFileSync(sub, line({ type: 'user', timestamp: t(28), message: { role: 'user', content: '정리하라' } })
    + line({ type: 'assistant', timestamp: t(20), message: { id: 'b1', model: 'm', usage, content: [] } }));
  fs.writeFileSync(sub.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType: 'report-manager', description: '<script>alert(1)</script> 회의록', finished: true }));

  const cache = await scanAll({ projectsDir: path.join(root, 'projects'), cacheFile: path.join(root, 'cache.json') });
  const staff = loadRegistry(path.join(root, 'agents'), profiles);
  const summary = summarize({ cache, staff, profiles, pricing, range: 'month', now });
  summary.month.budget = 10;
  summary.budget = { staff: { 'report-manager': 1 } };
  const alerts = { unread: 1, alerts: [{ id: 'x', level: 'bad', title: '보고서팀이 이번 달 예산을 넘었어요', body: '$2.00 / 예산 $1.00 (200%)', read: false }] };
  const html = renderReport({ summary, alerts, db: { error: '엑셀 없음' }, live: null, rangeLabel: '이번 달', usdToKrw: 1400, now });

  for (const s of ['스킬팀 운영 현황 리포트', '한눈에 보기', '비용 흐름', '직원 현황', '팀장 요청과 일 맡기기', '최근 직원 작업', '스킬 사용', '예산과 알림', '/report.css']) {
    assert.ok(html.includes(s), s + ' 가 있어야 한다');
  }
  assert.ok(html.includes('이번 달 · '), '기간 이름과 날짜');
  assert.ok(html.includes(`<title>${reportTitle('이번 달', now)}</title>`), '인쇄 창의 기본 파일 이름');
  assert.ok(html.includes('API 환산 비용 <b>$4.00</b>'), '요약 첫 줄: 팀장 $2 + 직원 $2');
  assert.ok(html.includes('직원 1명 중 <b>1명 가동</b>'));
  assert.ok(html.includes(`예산 $10.00의 ${Math.round(summary.month.cost * 10)}%`), '이번 달 예산 사용률');
  assert.ok(html.includes('$2.00 / $1.00'), '직원별 예산');
  assert.ok(html.includes('읽지 않은 알림 1건'));
  assert.ok(!html.includes('<script>alert(1)'), '기록의 글은 태그로 들어가지 않는다');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; 회의록'));
  assert.ok(html.includes('&lt;b&gt;굵게&lt;/b&gt;'), '요청 글도 이스케이프');
  assert.ok(html.includes('스킬 DB 엑셀을 읽지 못했어요: 엑셀 없음'));
});
