// A4 비즈니스 리포트. 지금 현황을 서버에서 한 장의 HTML 로 다 그려 보낸다(불러오기를 기다릴 필요 없이 바로 인쇄·PDF 저장).
// 글은 보고서 개조식(명사형), 날짜는 '2026년 11월 2일(월)' 꼴로 쓴다.

import { dur, esc, krw as krwText, pct, prettyModel, shortSkill, tok, usd } from './fmt.mjs';

export const APP_NAME = 'Claude Skill Team Control Center';
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
const STATUS = { done: '완료', running: '진행 중', stopped: '중단' };
const LEVEL = { bad: '넘음', warn: '주의', info: '알림' };
// 제언 우선순위 → [표시, 색, 권장 기한]
const ADV = { high: ['우선', 'lv-bad', '이번 주'], mid: ['권장', 'lv-warn', '2주 안'], low: ['참고', '', '이번 달'] };

const pad2 = (n) => String(n).padStart(2, '0');
const dateKo = (ts) => { const d = new Date(ts); return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일(${WEEK[d.getDay()]})`; };
const dateTimeKo = (ts) => { const d = new Date(ts); return `${dateKo(ts)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const shortTime = (ts) => { if (!ts) return '—'; const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const yymmdd = (ts) => { const d = new Date(ts); return `${String(d.getFullYear()).slice(2)}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`; };

/** 인쇄 창의 기본 파일 이름이 되는 제목 */
export const reportTitle = (rangeLabel, now) => `ClaudeSkillTeam_현황리포트_${rangeLabel.replace(/\s/g, '')}_${yymmdd(now)}`;

// 기간을 날짜로: '2026년 10월 27일(월) ~ 2026년 11월 2일(일)'
function periodText(d, now) {
  if (d.range === 'all') return `기록 전체 ~ ${dateKo(now)}`;
  if (d.range === 'today') return dateKo(now);
  return `${dateKo(d.from)} ~ ${dateKo(now)}`;
}

// ── 핵심 요약(개조식) ──
function findings({ d, alerts, db, rangeLabel, krw }) {
  const out = [];
  const g = Object.fromEntries(d.groups.map((x) => [x.key, x]));
  const total = d.kpi.cost;
  out.push(`${rangeLabel} API 환산 비용 <b>${usd(total)}</b>${krw(total)} — 직원 ${usd(g.staff.cost)}(${pct(g.staff.cost, total)}%), 팀장 ${usd(g.lead.cost)}, 기본 에이전트 ${usd(g.builtin.cost)}, 그 밖의 세션 ${usd(g.other.cost)}`);
  const t = d.kpi.tokens;
  if (t.total) out.push(`토큰 ${tok(t.total)} 중 캐시 읽기 ${pct(t.cr, t.total)}% — 같은 문맥을 다시 읽어 입력 비용을 크게 줄이는 중`);
  const busy = d.staff.filter((s) => s.runs).sort((a, b) => b.cost - a.cost);
  if (busy.length) {
    out.push(`직원 ${d.staff.length}명 중 <b>${busy.length}명 가동</b>, 작업 ${d.kpi.staffRuns}건(완료 ${d.kpi.staffDone}, 진행 ${d.kpi.staffRunning}, 중단 ${d.kpi.staffStopped}) — 비용 1위 ${esc(busy[0].team || busy[0].name)} ${usd(busy[0].cost)}`);
    const idle = d.staff.filter((s) => !s.runs);
    if (idle.length) out.push(`이 기간 작업 없는 직원 ${idle.length}명: ${idle.map((s) => esc(s.team || s.name)).join(', ')}`);
  } else {
    out.push('이 기간 직원(서브에이전트) 작업 없음 — 일은 팀장·다른 세션이 직접 처리');
  }
  const f = d.flow;
  if (f) {
    const deleg = f.links.reduce((a, l) => a + l.runs, 0);
    out.push(`${d.owner || '사용자'} 요청 ${(f.leadPrompts + f.otherPrompts).toLocaleString()}회(팀장 ${f.leadPrompts}회) → 직원·기본 에이전트에게 맡긴 일 ${deleg}건`);
  }
  const m = d.month;
  if (m.budget) {
    out.push(`이번 달 누적 <b>${usd(m.cost)}</b> — 예산 ${usd(m.budget)}의 ${pct(m.cost, m.budget)}%${m.projected != null ? `, 월말 예상 ${usd(m.projected)}(예산의 ${pct(m.projected, m.budget)}%)` : ''}`);
  } else {
    out.push(`이번 달 누적 ${usd(m.cost)}${m.projected != null ? `, 월말 예상 ${usd(m.projected)}` : ''} — 월 예산 미설정`);
  }
  const unread = alerts ? alerts.alerts.filter((a) => !a.read) : [];
  if (unread.length) out.push(`읽지 않은 알림 ${unread.length}건: ${unread.slice(0, 2).map((a) => esc(a.title)).join(' / ')}${unread.length > 2 ? ' 외' : ''}`);
  const assigned = d.staff.reduce((a, s) => a + s.skills.length, 0);
  const usedSk = d.staff.reduce((a, s) => a + s.skills.filter((k) => k.calls > 0).length, 0);
  out.push(`직원이 맡은 스킬 ${assigned}개 중 직원이 이 기간 직접 쓴 스킬 ${usedSk}개${db && !db.error ? ` · 스킬 DB ${db.counts.skills}개 중 확인할 것 ${db.counts.flagged}개` : ''}`);
  return out;
}

// ── 날짜별 비용 막대(그룹별로 쌓기) ──
function costChart(d) {
  const series = d.series.group;
  const n = d.buckets.length;
  const totals = d.buckets.map((_, i) => series.reduce((a, s) => a + s.cost[i], 0));
  const peak = Math.max(...totals, 0);
  if (!peak) return '<p class="muted">이 기간에는 비용 기록이 없어요.</p>';
  const W = 680; const H = 190; const P = { l: 46, r: 6, t: 8, b: 22 };
  const raw = peak / 4;
  const p10 = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 5, 10].find((x) => raw / p10 <= x) || 10) * p10;
  const top = Math.ceil(peak / step) * step;
  const ih = H - P.t - P.b; const iw = W - P.l - P.r;
  const y = (v) => P.t + ih - (v / top) * ih;
  const slot = iw / n;
  const bw = Math.max(2, Math.min(26, slot * 0.64));
  const every = Math.max(1, Math.ceil(n / 14));
  let s = '';
  for (let v = 0; v <= top + step / 1000; v += step) s += `<line x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${P.l - 6}" y="${y(v) + 3.5}" text-anchor="end">${usd(v)}</text>`;
  for (let i = 0; i < n; i++) {
    const cx = P.l + slot * i + slot / 2;
    let acc = 0;
    for (const se of series) {
      const v = se.cost[i];
      if (!v) continue;
      const y0 = y(acc); const y1 = y(acc + v);
      acc += v;
      s += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${y1.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0.6, y0 - y1 - (y0 - y1 > 3 ? 1 : 0)).toFixed(1)}" rx="1.5" fill="${se.color}"/>`;
    }
    if (i % every === 0) {
      const t = new Date(d.buckets[i]);
      s += `<text x="${cx.toFixed(1)}" y="${H - 6}" text-anchor="middle">${d.unit === 'hour' ? t.getHours() + '시' : `${t.getMonth() + 1}/${t.getDate()}`}</text>`;
    }
  }
  const legend = series.map((se) => `<span><i style="background:${se.color}"></i>${esc(se.label)} ${usd(se.cost.reduce((a, b) => a + b, 0))}</span>`).join('');
  return `<figure class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="날짜별 API 환산 비용">${s}</svg><figcaption class="legend">${legend}</figcaption></figure>`;
}

const bar = (v, max, color) => `<span class="mbar"><i style="width:${max ? Math.max(1.5, (v / max) * 100) : 0}%;background:${color}"></i></span>`;
const table = (head, rows, cls = '') => `<table class="${cls}"><thead><tr>${head.map(([h, c]) => `<th${c ? ` class="${c}"` : ''}>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
const td = (v, c) => `<td${c ? ` class="${c}"` : ''}>${v}</td>`;

/** 리포트 HTML. 서버가 요약(summarize)·알림·스킬 DB 짝짓기·실시간 상태를 넣어 부른다 */
export function renderReport({ summary: d, alerts, db, live, rangeLabel, now = Date.now(), usdToKrw = 0, appName = APP_NAME, saveDir = '~/.agent-mission-control/reports' }) {
  const krw = (n) => (usdToKrw && n ? ` (${krwText(n, usdToKrw)})` : '');
  const g = Object.fromEntries(d.groups.map((x) => [x.key, x]));
  const staffName = (key) => { const s = d.staff.find((x) => x.name === key); return s ? s.team || s.name : key === 'unknown' ? '알 수 없음' : key; };
  const staffColor = (key) => (d.staff.find((x) => x.name === key) || {}).color || '#9a9893';
  const working = (name) => !!(live && live.staff && live.staff[name] && live.staff[name].state === 'working');
  const k = d.kpi;

  // 1. 요약 숫자
  const kpis = [
    ['API 환산 비용', usd(k.cost), krwText(k.cost, usdToKrw)],
    ['토큰', tok(k.tokens.total), `캐시 읽기 ${pct(k.tokens.cr, k.tokens.total)}%`],
    ['직원 작업', `${k.staffRuns}건`, `완료 ${k.staffDone} · 중단 ${k.staffStopped}`],
    ['보낸 요청', `${k.prompts.toLocaleString()}회`, `팀장에게 ${d.lead.prompts || 0}회`],
    ['직원 평균 작업', dur(k.avgRunMs), '완료한 작업 기준'],
    ['이번 달 누적', usd(d.month.cost), d.month.budget ? `예산의 ${pct(d.month.cost, d.month.budget)}%` : '월 예산 미설정'],
  ].map(([l, v, f]) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div><div class="f">${f}</div></div>`).join('');

  // 3. 직원 현황
  const maxCost = Math.max(...d.staff.map((s) => s.cost), 0);
  const budgetStaff = (d.budget && d.budget.staff) || {};
  const staffRows = d.staff.map((s) => {
    const done = s.recentRuns.filter((r) => r.status === 'done');
    const avg = done.length ? done.reduce((a, r) => a + r.durationMs, 0) / done.length : 0;
    const cap = budgetStaff[s.name];
    return `<tr>${td(`<i class="dot" style="background:${s.color}"></i><b>${esc(s.team || s.name)}</b><small>${esc(s.name)}</small>`)}
      ${td(s.runs ? `${s.runs}건` : '—', 'r')}${td(s.done ? `${s.done}` : '—', 'r')}${td(dur(avg), 'r')}${td(tok(s.tokens.total), 'r')}
      ${td(`${usd(s.cost)} ${bar(s.cost, maxCost, s.color)}`, 'r nowrap')}
      ${td(cap ? `${usd(s.month)} / ${usd(cap)} <small>${pct(s.month, cap)}%</small>` : usd(s.month), 'r')}
      ${td(working(s.name) ? '<b class="ok">일하는 중</b>' : s.lastActive ? shortTime(s.lastActive) : '기록 없음', 'r')}</tr>`;
  });

  // 4. 팀장 요청과 워크플로
  const f = d.flow || { links: [], skillLinks: [], leadPrompts: 0, otherPrompts: 0 };
  const byStaff = {};
  for (const l of f.links) {
    const key = l.to;
    byStaff[key] ||= { lead: 0, other: 0, cost: 0 };
    byStaff[key][l.from] += l.runs;
    byStaff[key].cost += l.cost;
  }
  const delegRows = Object.entries(byStaff).sort((a, b) => (b[1].lead + b[1].other) - (a[1].lead + a[1].other)).map(([key, v]) =>
    `<tr>${td(`<i class="dot" style="background:${key === 'builtin' ? '#7c8a9e' : staffColor(key)}"></i>${esc(key === 'builtin' ? '기본 에이전트' : staffName(key))}`)}${td(v.lead || '—', 'r')}${td(v.other || '—', 'r')}${td(usd(v.cost), 'r')}</tr>`);
  const turnRows = (d.leadTurns || []).slice(0, 10).map((u) =>
    `<tr>${td(shortTime(u.at), 'nowrap')}${td(esc(u.prompt || '(내용 없음)'))}${td(u.agents.length ? esc(u.agents.map(staffName).join(', ')) : '—')}${td(dur(u.durationMs), 'r')}${td(usd(u.cost), 'r')}</tr>`);

  // 5. 최근 직원 작업
  const runRows = d.runs.filter((r) => r.start >= d.from).slice(0, 12).map((r) =>
    `<tr>${td(shortTime(r.start), 'nowrap')}${td(`<i class="dot" style="background:${r.group === 'staff' ? staffColor(r.agent) : '#7c8a9e'}"></i>${esc(r.group === 'staff' ? staffName(r.agent) : '기본 · ' + r.agent)}`, 'nowrap')}${td(esc(r.description || '(설명 없음)'))}${td(dur(r.durationMs), 'r')}${td(tok(r.tokens), 'r')}${td(usd(r.cost), 'r')}${td(STATUS[r.status] || r.status, `r st-${r.status}`)}</tr>`);

  // 6. 스킬
  const kn = (s) => (d.skillNames && d.skillNames[shortSkill(s).toLowerCase()]) || '';
  const skillRows = d.skills.slice(0, 10).map((s) =>
    `<tr>${td(`<b>${esc(kn(s.skill) || shortSkill(s.skill))}</b>${kn(s.skill) ? `<small>${esc(shortSkill(s.skill))}</small>` : ''}`)}${td(esc(s.owner || '직원 밖'))}${td(s.calls, 'r')}${td(tok(s.tokens), 'r')}${td(usd(s.cost), 'r')}</tr>`);
  const flagged = db && !db.error ? db.rows.filter((r) => r.flags.length).slice(0, 12) : [];
  const flagRows = flagged.map((r) => `<tr>${td(`<b>${esc(r.name || r.id)}</b><small>${esc(r.id)}</small>`)}${td(esc(r.team || '—'))}${td(esc(r.flags.map((x) => x.t).join(' / ')))}</tr>`);

  // 7. 예산과 알림
  const meter = (label, color, used, cap, proj) => {
    const p = cap ? (used / cap) * 100 : 0;
    return `<tr>${td(`<i class="dot" style="background:${color}"></i>${esc(label)}`)}${td(usd(used), 'r')}${td(cap ? usd(cap) : '—', 'r')}
      ${td(cap ? `<span class="mbar wide${p > 100 ? ' over' : p >= 80 ? ' near' : ''}"><i style="width:${Math.min(100, p)}%"></i></span> ${Math.round(p)}%` : '—', 'nowrap')}${td(proj != null ? usd(proj) : '—', 'r')}</tr>`;
  };
  const budgetRows = [meter('전체', '#2a78d6', d.month.cost, d.month.budget, d.month.projected),
    ...d.staff.filter((s) => budgetStaff[s.name]).map((s) => meter(s.team || s.name, s.color, s.month, budgetStaff[s.name]))];
  // 새 알림은 다, 읽은 알림은 최근 5건만
  const alertList = alerts ? [...alerts.alerts.filter((a) => !a.read), ...alerts.alerts.filter((a) => a.read).slice(0, 5)] : [];
  const readCount = alerts ? alerts.alerts.filter((a) => a.read).length : 0;
  const alertRows = alertList.map((a) => `<tr class="${a.read ? 'read' : ''}">${td(`<span class="lv lv-${a.level}">${LEVEL[a.level] || a.level}</span>`)}${td(`<b>${esc(a.title)}</b><small>${esc(a.body)}</small>`)}${td(a.read ? '읽음' : '새 알림', 'r nowrap')}</tr>`);

  const groupRows = d.groups.map((x) => `<tr>${td(`<i class="dot" style="background:${x.color}"></i>${esc(x.label)}`)}${td(tok(x.tokens.total), 'r')}${td(usd(x.cost), 'r')}${td(pct(x.cost, k.cost) + '%', 'r')}</tr>`);
  const modelRows = d.models.slice(0, 6).map((x) => `<tr>${td(esc(prettyModel(x.model)))}${td(tok(x.tokens), 'r')}${td(usd(x.cost), 'r')}${td(pct(x.cost, k.cost) + '%', 'r')}</tr>`);

  // 8. 제언
  const advice = d.advice || [];
  const advBadge = (a) => { const [l, c] = ADV[a.level] || ADV.low; return `<span class="lv ${c}">${l}</span>`; };
  const prio = advice.slice(0, 3).map((a) => `<li>${advBadge(a)} ${esc(a.title)}</li>`).join('');
  const planRows = advice.map((a, i) => `<tr>${td(`${i + 1}`, 'r')}${td(advBadge(a))}${td(esc(a.area), 'nowrap')}${td(`<b>${esc(a.title)}</b>`)}${td((ADV[a.level] || ADV.low)[2], 'nowrap')}${td(esc(a.effect))}</tr>`);
  const advBlocks = advice.map((a, i) => `<article class="adv">
      <header>${advBadge(a)}<span class="area">${esc(a.area)}</span><b>${i + 1}. ${esc(a.title)}</b></header>
      <p class="ev"><span class="k">근거</span>${esc(a.evidence)}</p>
      <div class="acts"><span class="k">실행</span><ul>${a.actions.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
      <p class="eff"><span class="k">기대 효과</span>${esc(a.effect)}</p>
    </article>`).join('');

  const title = reportTitle(rangeLabel, now);
  const ranges = [['today', '오늘'], ['7d', '최근 7일'], ['30d', '최근 30일'], ['month', '이번 달'], ['all', '전체']];
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/report.css"></head>
<body data-range="${esc(d.range)}">
<div class="toolbar no-print" role="toolbar" aria-label="리포트 도구">
  <div class="tb-row">
    <b>A4 리포트</b>
    <nav class="seg" aria-label="기간">${ranges.map(([v, l]) => `<a href="/report?range=${v}"${v === d.range ? ' aria-current="page"' : ''}>${l}</a>`).join('')}</nav>
    <span class="grow"></span>
    <button type="button" class="btn" id="print">인쇄 · PDF로 저장…</button>
    <button type="button" class="btn primary" id="pdf">PDF 바로 저장</button>
  </div>
  <div class="tb-msg" id="tb-msg" role="status">‘인쇄’ 창에서 대상을 ‘PDF로 저장’으로 고르면 원하는 곳에 저장돼요. ‘PDF 바로 저장’은 <code>${esc(saveDir)}</code> 폴더에 바로 저장해요.</div>
</div>
<main class="sheet">
  <header class="rhead">
    <div class="brand"><svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="16" cy="16" r="12" opacity=".35"/><circle cx="16" cy="16" r="6.5" opacity=".65"/><path d="M16 16 L25.5 8"/></g><circle cx="22.5" cy="10.5" r="2.4" fill="currentColor"/></svg>${esc(appName)}</div>
    <h1>스킬팀 운영 현황 리포트</h1>
    <dl class="meta">
      <div><dt>기간</dt><dd>${esc(rangeLabel)} · ${esc(periodText(d, now))}</dd></div>
      <div><dt>작성</dt><dd>${esc(dateTimeKo(now))} 기준 자동 작성</dd></div>
      <div><dt>대상</dt><dd>직원(서브에이전트) ${d.staff.length}명 · 팀장 세션 · 이 PC의 Claude Code 기록</dd></div>
    </dl>
  </header>

  <section>
    <h2><span>1</span>한눈에 보기</h2>
    <div class="kpis">${kpis}</div>
    <ul class="findings">${findings({ d, alerts, db, rangeLabel, krw }).map((x) => `<li>${x}</li>`).join('')}</ul>
    ${prio ? `<div class="prio"><b>우선 제언</b><ol>${prio}</ol><small>근거와 실행 방법은 8. 더 잘 운영하기 위한 제언에 있어요.</small></div>` : ''}
  </section>

  <section class="keep">
    <h2><span>2</span>비용 흐름 <small>${d.unit === 'hour' ? '시간별' : '날짜별'} · API 환산</small></h2>
    ${costChart(d)}
    <div class="two">
      ${table([['누가 썼나'], ['토큰', 'r'], ['비용', 'r'], ['비율', 'r']], groupRows, 'compact')}
      ${table([['모델'], ['토큰', 'r'], ['비용', 'r'], ['비율', 'r']], modelRows.length ? modelRows : ['<tr><td colspan="4" class="muted">기록 없음</td></tr>'], 'compact')}
    </div>
  </section>

  <section>
    <h2><span>3</span>직원 현황</h2>
    ${table([['직원'], ['작업', 'r'], ['완료', 'r'], ['평균 작업', 'r'], ['토큰', 'r'], ['비용', 'r'], ['이번 달', 'r'], ['마지막 활동', 'r']], staffRows)}
  </section>

  <section>
    <h2><span>4</span>팀장 요청과 일 맡기기</h2>
    <p class="lead">${esc(d.owner || '사용자')} 요청 <b>${(f.leadPrompts + f.otherPrompts).toLocaleString()}회</b>(팀장 ${f.leadPrompts}회 · 다른 세션 ${f.otherPrompts.toLocaleString()}회) → 직원·기본 에이전트에게 맡긴 일 <b>${f.links.reduce((a, l) => a + l.runs, 0)}건</b> → 팀장·직원의 스킬 호출 <b>${f.skillLinks.reduce((a, l) => a + l.calls, 0)}회</b></p>
    ${delegRows.length ? table([['맡은 쪽'], ['팀장이 맡김', 'r'], ['다른 세션이 맡김', 'r'], ['비용', 'r']], delegRows, 'compact half') : '<p class="muted">이 기간에는 맡긴 일이 없어요.</p>'}
    ${turnRows.length ? `<h3>팀장에게 보낸 요청 (최근 ${turnRows.length}건)</h3>${table([['시각'], ['요청'], ['맡긴 직원'], ['걸린 시간', 'r'], ['비용', 'r']], turnRows)}` : ''}
  </section>

  <section>
    <h2><span>5</span>최근 직원 작업 <small>기본 에이전트 포함 · 최근 ${runRows.length}건</small></h2>
    ${runRows.length ? table([['시작'], ['누가'], ['무슨 일'], ['걸린 시간', 'r'], ['토큰', 'r'], ['비용', 'r'], ['상태', 'r']], runRows) : '<p class="muted">이 기간에는 직원 작업이 없어요.</p>'}
  </section>

  <section>
    <h2><span>6</span>스킬 사용 <small>스킬 토큰·비용은 추정</small></h2>
    ${skillRows.length ? table([['스킬'], ['담당'], ['호출', 'r'], ['추정 토큰', 'r'], ['추정 비용', 'r']], skillRows) : '<p class="muted">이 기간에는 스킬을 부른 기록이 없어요.</p>'}
    ${db && !db.error ? `<h3>스킬 DB 점검 <small>${esc(db.name)} · ${db.counts.skills}개 중 확인할 것 ${db.counts.flagged}개 · DB 밖 스킬 ${db.counts.missing}개</small></h3>
      ${flagRows.length ? table([['스킬'], ['담당 팀(엑셀)'], ['확인할 점']], flagRows, 'compact') : '<p class="muted">확인할 스킬이 없어요.</p>'}` : `<p class="muted">스킬 DB 엑셀을 읽지 못했어요${db && db.error ? ': ' + esc(db.error) : ''}.</p>`}
  </section>

  <section>
    <h2><span>7</span>예산과 알림</h2>
    ${table([['구분'], ['이번 달 사용', 'r'], ['월 예산', 'r'], ['사용률'], ['월말 예상', 'r']], budgetRows, 'compact')}
    ${alertRows.length ? `<h3>알림 <small>새 알림 ${alerts.unread}건 · 읽은 알림 ${readCount}건${readCount > 5 ? '(최근 5건만)' : ''}</small></h3>${table([['수준'], ['내용'], ['상태', 'r']], alertRows, 'compact')}` : '<p class="muted">켜진 알림이 없어요.</p>'}
  </section>

  <section>
    <h2><span>8</span>더 잘 운영하기 위한 제언 <small>기록에서 규칙으로 뽑은 제안 · 숫자는 이 기간 기준 · 절감액은 추정</small></h2>
    ${advice.length ? `<h3>실행 계획</h3>${table([['', 'r'], ['우선'], ['영역'], ['할 일'], ['권장 기한'], ['기대 효과']], planRows, 'compact plan')}
    <h3>제언별 근거와 실행 방법</h3><div class="advice">${advBlocks}</div>` : '<p class="muted">지금 기록으로는 따로 드릴 제언이 없어요. 운영이 고르게 잘되고 있어요.</p>'}
  </section>

  <footer class="notes">
    <b>참고</b>
    <ul>
      <li>비용은 Claude API 공식 단가로 계산한 환산값이에요. 구독 요금제의 실제 청구액이 아니에요.${usdToKrw ? ` 원화는 1달러 ${usdToKrw.toLocaleString('ko-KR')}원으로 계산했어요.` : ''}</li>
      <li>직원 토큰·비용은 직원(서브에이전트) 기록만 정확히 센 값이에요. 스킬 토큰·비용은 스킬을 부른 뒤 다음 요청까지를 그 스킬 몫으로 본 추정값이에요.</li>
      <li>claude.ai 웹·앱에서 쓴 것은 이 PC 기록에 없어서 빠져요.</li>
    </ul>
    <div class="sig">${esc(appName)} · ${esc(dateTimeKo(now))}</div>
  </footer>
</main>
<script src="/report.js" defer></script>
</body></html>`;
}
