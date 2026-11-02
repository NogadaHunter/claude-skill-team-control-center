// 예산·알림, 스킬 DB 엑셀 읽기·내보내기, 서버의 고치기 요청 보호를 시험한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluateAlerts, loadBudget, markRead, mergeAlerts, normalizeBudget, DEFAULT_BUDGET } from '../server/alerts.mjs';
import { cellRef, readXlsx, unescapeXml } from '../server/xlsx.mjs';
import { writeXlsx } from '../server/xlsx-write.mjs';
import { loadSkillDb, mergeSkillDb, skillUsageXlsx } from '../server/skilldb.mjs';

const DAY = 86400000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'amc-budget-'));
// 토큰 1개 = 1달러인 가짜 단가로 금액을 손쉽게 맞춘다
const pricing = { fallbackModel: 'm', models: { m: { input: 1e6, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } } };
const ev = (ts, usd) => [ts, 0, usd, 0, 0, 0, 0, -1];
const staff = [{ name: 'report-manager', team: '보고서팀', skills: ['anthropic-skills:meeting-minutes-pro'], color: '#e87ba4' }];

test('예산 설정은 숫자·단계를 검사해 깔끔하게 만들고, 없으면 pricing 의 옛 월 예산을 이어받는다', () => {
  const b = normalizeBudget({ monthlyUsd: '100', warnAt: '80, 50,100', runUsd: '', dailySpike: '2.5', staff: { 'report-manager': '5', ghost: 3 } }, new Set(['report-manager']));
  assert.equal(b.monthlyUsd, 100);
  assert.deepEqual(b.warnAt, [50, 80, 100]);
  assert.equal(b.runUsd, null, '비우면 그 알림을 끈다');
  assert.equal(b.dailySpike, 2.5);
  assert.deepEqual(b.staff, { 'report-manager': 5 }, '명부에 없는 직원은 버린다');
  assert.throws(() => normalizeBudget({ warnAt: '' }), /1~6개/);
  assert.throws(() => normalizeBudget({ monthlyUsd: -1 }), /숫자/);
  assert.throws(() => normalizeBudget({ dailySpike: 1 }), /숫자/);
  assert.equal(loadBudget(path.join(tmp(), 'none.json'), { monthlyBudgetUsd: 300 }).monthlyUsd, 300);
});

test('알림: 월 예산 단계·월말 예상·직원 예산·비싼 작업·멈춘 작업·갑자기 많이 쓴 날', () => {
  const now = new Date(2026, 10, 20, 12, 0, 0).getTime(); // 11월 20일 정오
  const today = new Date(2026, 10, 20).getTime();
  const lead = { kind: 'main', sessionId: 's1', projectKey: 'C--x-skill-team', models: ['m'], firstTs: today - 8 * DAY, lastTs: now, events: [] };
  for (let i = 1; i <= 7; i++) lead.events.push(ev(today - i * DAY + 3600000, 5)); // 지난 7일 하루 $5
  lead.events.push(ev(today + 3600000, 50)); // 오늘 $50
  const sub = (agentId, agentType, usd, { finished = true, startAgo = DAY, lastAgo = DAY - 600000 } = {}) => ({
    kind: 'sub', sessionId: 's1', agentId, projectKey: 'C--x-skill-team', models: ['m'],
    firstTs: now - startAgo, lastTs: now - lastAgo, events: [ev(now - lastAgo, usd)],
    meta: { agentType, description: agentId + ' 일', finished },
  });
  const cache = {
    files: {
      a: lead,
      b: sub('agent-big', 'report-manager', 6),
      c: sub('agent-stop', 'report-manager', 0.5, { finished: false, startAgo: 4 * 3600000, lastAgo: 3 * 3600000 }),
      d: sub('agent-explore', 'Explore', 7),
    },
  };
  const budget = { ...DEFAULT_BUDGET, monthlyUsd: 120, staff: { 'report-manager': 5 } };
  const r = evaluateAlerts({ cache, staff, pricing, budget, now });
  const byId = Object.fromEntries(r.alerts.map((a) => [a.id, a]));
  assert.ok(Math.abs(r.month - (50 + 35 + 6 + 0.5 + 7)) < 1e-9, '이번 달 합계 $98.5');
  assert.ok(byId['month-2026-11-80'], '98.5/120 = 82% → 80% 단계');
  assert.ok(!byId['month-2026-11-50'], '넘은 단계 중 가장 높은 것 하나만');
  assert.ok(byId['forecast-2026-11'], '월말 예상이 예산을 넘는다');
  assert.equal(byId['staff-report-manager-2026-11-100'].level, 'bad', '보고서팀 $6.5 / $5');
  assert.ok(byId['run-agent-big'].title.includes('보고서팀'));
  assert.ok(byId['run-agent-explore'].title.includes('기본 에이전트 Explore'));
  assert.deepEqual(byId['run-agent-big'].ref, { id: 'agent-big', at: 0 });
  assert.equal(byId['stopped-agent-stop'].level, 'info');
  assert.ok(byId['spike-' + new Date(today).toISOString().slice(0, 10)], '오늘 $50 > 평소 $5 × 3');
  assert.equal(r.alerts[0].level, 'bad', '심한 것부터');

  const quiet = evaluateAlerts({ cache, staff, pricing, budget: { ...DEFAULT_BUDGET, runUsd: null, dailySpike: null }, now });
  assert.deepEqual(quiet.alerts.map((a) => a.kind), ['stopped'], '예산·기준을 비우면 그 알림은 없다');
});

test('알림 상태: 처음 본 것만 fresh, 읽음 표시는 남고, 사라진 지 오래된 기록은 지운다', () => {
  const state = { v: 1, seen: { old: { first: Date.now() - 61 * DAY, read: 0 } } };
  const list = [{ id: 'a', level: 'warn' }, { id: 'b', level: 'info' }];
  const m1 = mergeAlerts(list, state);
  assert.deepEqual(m1.fresh, ['a', 'b']);
  assert.equal(m1.unread, 2);
  assert.ok(!state.seen.old);
  assert.equal(mergeAlerts(list, state).fresh.length, 0);
  assert.equal(markRead(state, ['a', 'zzz']), 1);
  const m3 = mergeAlerts(list, state);
  assert.equal(m3.unread, 1);
  assert.equal(m3.alerts.find((x) => x.id === 'a').read, true);
});

test('엑셀: 만든 파일을 다시 읽으면 같고, 표가 아닌 시트도 머리줄로 스킬 DB를 읽는다', () => {
  assert.deepEqual(cellRef('AB12'), [11, 27]);
  assert.equal(unescapeXml('a&amp;b_x000D_&#44608;'), 'a&b\r김');
  const dir = tmp();
  const file = path.join(dir, '피플웨어_스킬_현황관리DB.xlsx');
  fs.writeFileSync(file, writeXlsx([{
    name: '스킬목록', note: '설명 한 줄',
    columns: [{ name: '스킬 ID' }, { name: '한글명' }, { name: '카테고리' }, { name: '담당 스킬팀' }, { name: '운영 상태' }, { name: '등록본 점검' }, { name: '최종 업데이트', type: 'int' }],
    rows: [
      ['meeting-minutes-pro', '회의록 프로', '비즈니스 문서', '보고서팀', '운영중', '정상', 46139],
      ['book-writer-two', '책 쓰기 2', '책·출판', '집필팀', '운영중', '재업로드 필요', 46139],
      ['old-skill', '옛 스킬', '책·출판', '', '보관', '정상', 46000],
    ],
  }]));
  const db = loadSkillDb({ xlsx: path.join(dir, 'nope.xlsx'), searchDir: dir, pattern: '현황관리DB' });
  assert.equal(db.error, undefined);
  assert.equal(db.rows.length, 3);
  assert.equal(db.rows[0].updated, '2026-04-27', '엑셀 날짜 일련번호를 날짜로');

  const usage = [
    { skill: 'anthropic-skills:meeting-minutes-pro', calls: 4, callsAll: 9, lastUsed: 1, tokens: 100, cost: 1.5, callers: { 'report-manager': 4 } },
    { skill: 'old-skill', calls: 1, callsAll: 1, lastUsed: 2, tokens: 10, cost: 0.1, callers: {} },
    { skill: 'docx', calls: 2, callsAll: 2, lastUsed: 3, tokens: 1, cost: 0, callers: {} },
  ];
  const m = mergeSkillDb({ db, usage, usage30: usage, staff });
  const by = Object.fromEntries(m.rows.map((r) => [r.id, r]));
  assert.equal(by['meeting-minutes-pro'].calls, 4, '접두어(anthropic-skills:)는 떼고 짝짓는다');
  assert.equal(by['meeting-minutes-pro'].freqSuggest, '보통');
  assert.equal(by['meeting-minutes-pro'].owner.team, '보고서팀');
  assert.deepEqual(by['book-writer-two'].flags.map((x) => x.k), ['check', 'owner']);
  assert.deepEqual(by['old-skill'].flags.map((x) => x.k), ['inactive'], '보관인데 최근 씀');
  assert.deepEqual(m.missing.map((x) => x.key), ['docx']);
  assert.equal(m.counts.used, 2);

  const out = path.join(dir, 'out.xlsx');
  fs.writeFileSync(out, skillUsageXlsx(m, { rangeLabel: '최근 30일', usdToKrw: 1400 }));
  const back = readXlsx(out);
  assert.deepEqual(back.sheets.map((s) => s.name), ['스킬사용현황', 'DB에 없는 스킬']);
  assert.equal(back.sheets[0].rows[2][0], '스킬 ID');
  assert.equal(back.sheets[0].rows[3][7], 4, '이 기간 호출');
  assert.equal(back.sheets[0].rows[3][13], 2100, '원화 = $1.5 × 1400');
});

test('서버: 예산 저장·알림 읽음은 이 화면의 요청(X-AMC 머리글)만 받는다', async (t) => {
  const root = tmp();
  const cfg = path.join(root, 'config');
  fs.mkdirSync(cfg);
  fs.mkdirSync(path.join(root, 'claude', 'projects'), { recursive: true });
  fs.writeFileSync(path.join(cfg, 'pricing.json'), JSON.stringify(pricing));
  fs.writeFileSync(path.join(cfg, 'profiles.json'), '{}');
  const port = 47000 + Math.floor(Math.random() * 1000);
  const server = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'server.mjs');
  const child = spawn(process.execPath, [server], {
    env: { ...process.env, PORT: String(port), AMC_HOME: path.join(root, 'state'), AMC_CONFIG_DIR: cfg, CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CLAUDE_OFFICE_PORT: '1' },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try { if ((await (await fetch(base + '/api/health')).json()).ready) break; } catch { /* 아직 켜지는 중 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  const health = await (await fetch(base + '/api/health')).json();
  assert.match(health.version, /^\d+\.\d+\.\d+$/, '판 번호를 알려 줘서 ctl 이 예전 판 서버를 바꿀 수 있다');
  const body = JSON.stringify({ monthlyUsd: 50, warnAt: '50, 100' });
  const bad = await fetch(base + '/api/budget', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  assert.equal(bad.status, 403, '머리글 없는 요청은 막는다');
  const cross = await fetch(base + '/api/budget', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AMC': '1', Origin: 'http://evil.example' }, body });
  assert.equal(cross.status, 403, '다른 사이트에서 온 요청은 막는다');
  const ok = await fetch(base + '/api/budget', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AMC': '1', Origin: base }, body });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(fs.readFileSync(path.join(cfg, 'budget.json'), 'utf8')).monthlyUsd, 50);
  const wrong = await fetch(base + '/api/budget', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AMC': '1' }, body: JSON.stringify({ warnAt: '' }) });
  assert.equal(wrong.status, 400);
  const alerts = await (await fetch(base + '/api/alerts')).json();
  assert.equal(alerts.budget.monthlyUsd, 50);
  const summary = await (await fetch(base + '/api/summary?range=7d')).json();
  assert.equal(summary.month.budget, 50, '요약의 월 예산도 budget.json 을 따른다');
  const read = await fetch(base + '/api/alerts/read', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AMC': '1' }, body: '{"all":true}' });
  assert.equal(read.status, 200);

  // A4 리포트: 이번 달 기간, reports 폴더 밖 파일은 못 꺼낸다
  const rep = await fetch(base + '/report?range=month');
  assert.equal(rep.status, 200);
  assert.ok((rep.headers.get('content-type') || '').startsWith('text/html'));
  assert.ok((await rep.text()).includes('스킬팀 운영 현황 리포트'));
  assert.equal((await fetch(base + '/reports/..%2Fconfig%2Fpricing.json')).status, 404);
  const reveal = await fetch(base + '/api/report/reveal', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AMC': '1' }, body: '{"file":"../config/pricing.json"}' });
  assert.equal(reveal.status, 404);
  const pdfNoHeader = await fetch(base + '/api/report/pdf', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"range":"7d"}' });
  assert.equal(pdfNoHeader.status, 403, 'PDF 만들기도 이 화면에서만');
});
