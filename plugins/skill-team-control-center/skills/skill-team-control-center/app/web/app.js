// Claude Skill Team Control Center 화면. /api/summary 를 받아 그린다. 외부 라이브러리 없이 SVG로 차트를 그린다.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const store = {
  get(k, d) { try { return localStorage.getItem('amc.' + k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('amc.' + k, v); } catch { /* 저장 못 해도 화면은 돈다 */ } },
};
const state = {
  range: store.get('range', '7d'),
  metric: store.get('metric', 'cost'),
  split: store.get('split', 'group'),
  feedscope: store.get('feedscope', 'team'),
  runfilter: store.get('runfilter', 'all'),
  view: viewOfHash(),
  data: null, // 기간 요약(/api/summary)
  live: null, // 실시간 상태(/api/stream)
  streamOk: false,
  seenFeed: new Set(),
  stack: [], // 서랍에 쌓인 화면: {type:'agent', name} | {type:'trace', id, at, hl}
  trace: null, // 서랍에 열린 트레이스(/api/trace)
  traceSort: 'time',
  patterns: new Map(), // 직원 이름 → { at, data } (/api/pattern)
  alerts: null, // 예산·이상 알림(/api/stream 'alerts')
  skilldb: null, // 스킬 DB 엑셀 × 사용 기록(/api/skilldb)
  skilldbAt: 0,
  skillfilter: store.get('skillfilter', 'all'),
  skillq: '',
  skillOpen: new Set(),
  adviceAll: false, // 운영 제언을 다 펼쳐 볼지
  lastFocus: null,
};
function viewOfHash() {
  return { '#office': 'office', '#flow': 'flow', '#skills': 'skills' }[location.hash] || 'board';
}
const topOf = () => state.stack[state.stack.length - 1] || null;
const ownerName = () => (state.data && state.data.owner) || '사용자'; // 사용자를 부르는 이름(profiles.json 의 owner)
const topAgent = () => { const t = topOf(); return t && t.type === 'agent' ? t.name : null; };

const RANGE_LABEL = { today: '오늘', '7d': '최근 7일', '30d': '최근 30일', all: '전체 기간' };
const STATUS = { done: ['완료', 'ok'], running: ['진행 중', 'warn live'], stopped: ['중단', 'bad'] };
const TOKEN_PARTS = [
  ['in', '입력', '#2a78d6'], ['out', '출력', '#eb6834'], ['cw', '캐시 쓰기', '#eda100'], ['cr', '캐시 읽기', '#1baf7a'],
];
const NEUTRAL = '#9a9893';
const LEAD_COLOR = '#1baf7a';
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
// 활동 낱말(3D 사무실과 같은 k). NOW = 지금 하는 일, KIND = 활동 기록의 꼬리표
const ACT_NOW = {
  read: '{a} 읽는 중', edit: '{a} 고치는 중', write: '{a} 쓰는 중', bash: '{a}', grep: "'{a}' 찾는 중",
  glob: '{a} 파일 찾는 중', fetch: '{a} 읽는 중', search: "'{a}' 검색 중", agent: '맡기는 중: {a}', todo: '할 일 정리 중',
  skill: '{a} 스킬 펼치는 중', mcp: '{a} 쓰는 중', tool: '{a} 쓰는 중', text: '{a}',
};
const ACT_KIND = {
  read: '읽기', edit: '고치기', write: '쓰기', bash: '명령', grep: '찾기', glob: '파일 찾기', fetch: '웹 읽기',
  search: '검색', agent: '맡김', todo: '할 일', skill: '스킬', mcp: '도구', tool: '도구', text: '말',
  prompt: '요청', start: '작업 시작', done: '작업 끝', wait: '승인 대기',
};
const actNow = (act) => (act ? (ACT_NOW[act.k] || '{a}').replace('{a}', act.a || '') : '');
// 트레이스의 단계 묶음(서버 trace.mjs 의 catOf 와 같은 이름)
const CATS = {
  think: ['응답 만들기', '#6250d6'], look: ['살펴보기', '#2a78d6'], write: ['쓰기·고치기', '#eb6834'],
  bash: ['명령', '#1baf7a'], skill: ['스킬', '#eda100'], web: ['웹', '#e87ba4'], agent: ['맡기기', '#008300'],
  other: ['기타 도구', '#9a9893'], idle: ['기다림', 'var(--idle)'],
};
const catColor = (c) => (CATS[c] || CATS.other)[1];
const catLabel = (c) => (CATS[c] || CATS.other)[0];
const TOOL_LABEL = {
  SubagentHandback: '결과 넘기고 마침', TodoWrite: '할 일 정리', ToolSearch: '도구 불러오기',
  AskUserQuestion: '사용자에게 질문', ExitPlanMode: '계획 승인 요청', update_plan: '진행 목록 갱신', wrap_up: '마무리 정리',
};

// ── 숫자·시간 표기 ──
const fmtTok = (n) => {
  n = n || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 1 : 2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K';
  return String(Math.round(n));
};
const fmtUsd = (n) => {
  n = n || 0;
  if (n >= 1000) return '$' + Math.round(n).toLocaleString('en-US');
  if (n >= 100) return '$' + n.toFixed(0);
  if (n >= 0.01) return '$' + n.toFixed(2);
  return n > 0 ? '<$0.01' : '$0';
};
const fmtKrw = (usd) => {
  const rate = state.data?.currency?.usdToKrw;
  if (!rate) return '';
  const w = (usd || 0) * rate;
  if (w >= 1e8) return '약 ' + (w / 1e8).toFixed(1) + '억 원';
  if (w >= 1e4) return '약 ' + Math.round(w / 1e4).toLocaleString('ko-KR') + '만 원';
  return '약 ' + Math.round(w).toLocaleString('ko-KR') + '원';
};
const fmtDur = (ms) => {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + '초';
  const m = Math.floor(s / 60);
  if (m < 60) return m + '분' + (s % 60 ? ' ' + (s % 60) + '초' : '');
  return Math.floor(m / 60) + '시간' + (m % 60 ? ' ' + (m % 60) + '분' : '');
};
const pad2 = (n) => String(n).padStart(2, '0');
const fmtDay = (ts) => { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()}`; };
const fmtTime = (ts) => { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const fmtClock = (ts) => { const d = new Date(ts); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const fmtClockS = (ts) => { const d = new Date(ts); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };
const fmtAgo = (ts) => {
  if (!ts) return '기록 없음';
  const d = Date.now() - ts;
  if (d < 60000) return '방금';
  if (d < 3600000) return Math.floor(d / 60000) + '분 전';
  if (d < 86400000) return Math.floor(d / 3600000) + '시간 전';
  if (d < 7 * 86400000) return Math.floor(d / 86400000) + '일 전';
  return fmtDay(ts);
};
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const pctText = (a, b) => { const p = pct(a, b); return p === 0 && a > 0 ? "<1%" : p + "%"; };
const prettyModel = (m) => {
  const r = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(m || '');
  if (!r) return m;
  return r[1][0].toUpperCase() + r[1].slice(1) + ' ' + r[2] + (r[3] && r[3].length < 3 ? '.' + r[3] : '');
};
const skillShort = (s) => String(s).split(':').pop();

// ── 불러오기 ──
let loadSeq = 0;
let lastLoadAt = 0;
async function load({ silent = false } = {}) {
  const seq = ++loadSeq;
  lastLoadAt = Date.now();
  const btn = $('#refresh');
  btn.classList.add('spin');
  try {
    const res = await fetch('/api/summary?range=' + encodeURIComponent(state.range), { cache: 'no-store' });
    const data = await res.json();
    if (seq !== loadSeq) return; // 그사이 기간을 바꿨으면 버린다
    if (data.loading) {
      showLoading(data.progress, data.error);
      setTimeout(() => load(), 800);
      return;
    }
    if (data.error) throw new Error(data.error);
    state.data = data;
    render();
  } catch (err) {
    if (!silent) showError(err);
  } finally {
    if (seq === loadSeq) btn.classList.remove('spin');
  }
}

function showLoading(p, error) {
  $('#loading').hidden = false;
  $('#content').hidden = true;
  const ratio = p && p.total ? p.done / p.total : 0;
  $('#loadbar').style.width = Math.round(ratio * 100) + '%';
  $('#loadtext').textContent = error ? '읽기 오류: ' + error
    : p && p.total ? `${Math.round(p.done / 1e6).toLocaleString()}MB / ${Math.round(p.total / 1e6).toLocaleString()}MB` : '';
}

function showError(err) {
  $('#loading').hidden = false;
  $('#loading').innerHTML = `<div class="error">Control Center 서버에 닿지 못했어요. 서버가 켜져 있는지 확인하세요. (${esc(err.message || err)})</div>`;
}

// ── 그리기 ──
function render() {
  const d = state.data;
  $('#loading').hidden = true;
  $('#content').hidden = false;
  $('#updated').textContent = fmtClock(d.generatedAt) + ' 집계';
  $('#refresh').title = `새로 고침 · ${fmtClock(d.generatedAt)} 집계`;
  renderKpis(d);
  renderChart(d);
  renderGroups(d);
  renderAdvice(d);
  renderRoster(d);
  renderRuns(d);
  renderSkills(d);
  renderOthers(d);
  if (state.view === 'flow') renderFlowView(d);
  if (state.view === 'skills') loadSkillDb();
  if (state.live) { renderFeed({ quiet: true }); if (state.view === 'office') renderOffice(); }
  if (topAgent()) showAgent(topAgent(), { focus: false });
}

function kpi(label, value, foot, extra = '') {
  return `<div class="kpi"><div class="label">${label}</div><div class="value">${value}</div><div class="foot">${foot}</div>${extra}</div>`;
}

function renderKpis(d) {
  const k = d.kpi;
  const rl = RANGE_LABEL[d.range];
  const staffCost = d.groups.find((g) => g.key === 'staff')?.cost || 0;
  const lead = d.lead || {};
  let month = `월말 예상 ${d.month.projected != null ? fmtUsd(d.month.projected) : '—'}`;
  let meter = '';
  if (d.month.budget) {
    const p = pct(d.month.cost, d.month.budget);
    month = `예산 ${fmtUsd(d.month.budget)}의 ${p}% · ` + month;
    meter = `<div class="meter${p > 100 ? ' over' : ''}"><i style="width:${Math.min(100, p)}%"></i></div>`;
  } else {
    meter = '<button type="button" class="linkbtn kpi-link" data-open-alerts>예산 정하기 →</button>';
  }
  $('#kpis').innerHTML = [
    kpi(`직원 작업 · ${rl}`, `${k.staffRuns}<small>건</small>`,
      `완료 ${k.staffDone} · 진행 ${k.staffRunning} · 중단 ${k.staffStopped}`),
    kpi(`보낸 요청 · ${rl}`, `${k.prompts.toLocaleString()}<small>회</small>`,
      `팀장에게 ${lead.prompts || 0}회 · 그 밖의 세션 ${k.prompts - (lead.prompts || 0)}회`),
    kpi(`토큰 · ${rl}`, `<span title="${k.tokens.total.toLocaleString()}">${fmtTok(k.tokens.total)}</span>`,
      `캐시 읽기 ${pct(k.tokens.cr, k.tokens.total)}% · 출력 ${fmtTok(k.tokens.out)}`),
    kpi(`API 환산 비용 · ${rl}`, `${fmtUsd(k.cost)}<small>${fmtKrw(k.cost)}</small>`,
      `직원 몫 ${fmtUsd(staffCost)} (${pct(staffCost, k.cost)}%)`),
    kpi('직원 평균 작업 시간', fmtDur(k.avgRunMs), `${rl} 완료한 작업 기준`),
    kpi('이번 달 누적', `${fmtUsd(d.month.cost)}<small>${fmtKrw(d.month.cost)}</small>`, month, meter),
  ].join('');
}

function niceStep(max) {
  if (max <= 0) return 1;
  const raw = max / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

function bucketLabel(d, i, long = false) {
  const ts = d.buckets[i];
  const t = new Date(ts);
  if (d.unit === 'hour') return long ? `${fmtDay(ts)} ${t.getHours()}시` : `${t.getHours()}시`;
  return long ? `${fmtDay(ts)} (${WEEK[t.getDay()]})` : fmtDay(ts);
}

function chartSeries(d) {
  const list = state.split === 'staff' ? d.series.staff : d.series.group;
  return { list, m: state.metric === 'tokens' ? 'tokens' : 'cost' };
}

function renderChart(d) {
  const el = $('#chart');
  const { list, m } = chartSeries(d);
  const fmt = m === 'cost' ? fmtUsd : fmtTok;
  const n = d.buckets.length;
  const totals = d.buckets.map((_, i) => list.reduce((s, x) => s + x[m][i], 0));
  const sum = totals.reduce((a, b) => a + b, 0);
  $('#chart-title').textContent = `${m === 'cost' ? '비용' : '토큰'} 흐름 · ${RANGE_LABEL[d.range]}${d.unit === 'hour' ? ' 시간별' : ' 날짜별'}`;
  $('#legend').innerHTML = list.map((x) => {
    const t = x[m].reduce((a, b) => a + b, 0);
    return `<span><i class="sw" style="background:${x.color}"></i>${esc(x.label)} <b class="num">${fmt(t)}</b></span>`;
  }).join('');
  if (!sum) {
    el.innerHTML = `<div class="empty">${state.split === 'staff' ? '이 기간에는 직원이 일한 기록이 없어요' : '이 기간에는 기록이 없어요'}</div>`;
    return;
  }

  const W = Math.max(el.clientWidth, 280);
  const H = el.clientHeight || 250;
  const P = { l: 52, r: 4, t: 8, b: 24 };
  const peak = Math.max(...totals);
  const step = niceStep(peak);
  const top = Math.ceil(peak / step) * step || step;
  const ih = H - P.t - P.b;
  const iw = W - P.l - P.r;
  const y = (v) => P.t + ih - (v / top) * ih;
  const slot = iw / n;
  const bw = Math.max(2, Math.min(30, slot * 0.66));
  const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(iw / 52))));

  let svg = '';
  for (let v = 0; v <= top + step / 1000; v += step) {
    svg += `<line class="gridline" x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}"/>`
      + `<text x="${P.l - 8}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`;
  }
  for (let i = 0; i < n; i++) {
    svg += `<rect class="hit" data-i="${i}" x="${P.l + slot * i}" y="${P.t}" width="${slot}" height="${ih}"/>`;
  }
  for (let i = 0; i < n; i++) {
    const cx = P.l + slot * i + slot / 2;
    let acc = 0;
    for (const s of list) {
      const v = s[m][i];
      if (!v) continue;
      const y0 = y(acc);
      const y1 = y(acc + v);
      acc += v;
      const h = y0 - y1;
      svg += `<rect pointer-events="none" x="${cx - bw / 2}" y="${y1}" width="${bw}" height="${Math.max(h > 3 ? h - 1.5 : h, 0.8)}" rx="2.5" fill="${s.color}"/>`;
    }
    if (i % every === 0) svg += `<text x="${cx}" y="${H - 6}" text-anchor="middle">${bucketLabel(d, i)}</text>`;
  }
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc($('#chart-title').textContent)}">${svg}</svg>`;
}

function showTip(ev, i) {
  const d = state.data;
  const { list, m } = chartSeries(d);
  const fmt = m === 'cost' ? fmtUsd : fmtTok;
  const rows = list.map((s) => [s, s[m][i]]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((a, [, v]) => a + v, 0);
  const tip = $('#tip');
  tip.innerHTML = `<b>${bucketLabel(d, i, true)}</b>`
    + (rows.length ? rows.map(([s, v]) => `<div class="row"><span><i class="sw" style="background:${s.color}"></i>${esc(s.label)}</span><span class="num">${fmt(v)}</span></div>`).join('')
      + `<div class="row total"><span>합계</span><span class="num">${fmt(total)}</span></div>`
      : '<div class="faint">기록 없음</div>');
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let x = ev.clientX + 14;
  let yy = ev.clientY + 14;
  if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - 14;
  if (yy + r.height > innerHeight - 8) yy = ev.clientY - r.height - 14;
  tip.style.left = x + 'px';
  tip.style.top = yy + 'px';
}

function barRows(items, valueOf, labelOf, colorOf, footOf) {
  const max = Math.max(...items.map(valueOf), 0);
  return items.map((it) => `<div class="barrow">
      <span class="name" title="${esc(labelOf(it))}"><i class="sw" style="background:${colorOf(it)}"></i>${esc(labelOf(it))}</span>
      <span class="track"><i style="width:${max ? Math.max(1.5, (valueOf(it) / max) * 100) : 0}%;background:${colorOf(it)}"></i></span>
      <span class="val">${footOf(it)}</span></div>`).join('');
}

function renderGroups(d) {
  $('#who-sub').textContent = RANGE_LABEL[d.range] + ' 비용';
  const total = d.kpi.cost;
  $('#groups').innerHTML = barRows(d.groups, (g) => g.cost, (g) => g.label, (g) => g.color,
    (g) => `${fmtUsd(g.cost)}<small>${pct(g.cost, total)}%</small>`);
  $('#models').innerHTML = d.models.length
    ? barRows(d.models.slice(0, 5), (x) => x.cost, (x) => prettyModel(x.model), () => 'var(--accent)',
      (x) => `${fmtUsd(x.cost)}<small>${fmtTok(x.tokens)}</small>`)
    : '<div class="empty">기록 없음</div>';
}

function spark(arr) {
  const max = Math.max(...arr, 0);
  const bars = arr.map((v, i) => {
    const h = max ? Math.max(v > 0 ? 2 : 0, (v / max) * 24) : 0;
    return h
      ? `<rect x="${i * 10 + 1.5}" y="${26 - h}" width="7" height="${h}" rx="1.5" fill="currentColor"/>`
      : `<rect x="${i * 10 + 1.5}" y="25" width="7" height="1" fill="currentColor" opacity=".25"/>`;
  }).join('');
  return `<svg viewBox="0 0 140 26" preserveAspectRatio="none" aria-hidden="true">${bars}</svg>`;
}

const liveOf = (name) => (state.live && state.live.staff && state.live.staff[name]) || null;

function statusChip(s, d) {
  const l = liveOf(s.name);
  if ((l && l.state === 'working') || (!state.live && d.runs.some((r) => r.agent === s.name && r.status === 'running'))) {
    return `<span class="chip ok live">일하는 중${l && l.running > 1 ? ' ' + l.running : ''}</span>`;
  }
  return `<span class="chip" title="${s.lastActive ? esc(fmtTime(s.lastActive)) : ''}">${s.lastActive ? fmtAgo(s.lastActive) : '기록 없음'}</span>`;
}

function doingLine(l) {
  if (!l || l.state !== 'working') return '';
  const what = actNow(l.doing) || l.desc || '일하는 중';
  return `<div class="doing" title="${esc(l.desc)}"><span>${esc(what)}</span></div>`;
}

// ── 운영 제언(서버 advice.mjs 가 기록으로 뽑은 다음 할 일) ──
const ADV = { high: ['우선', 'bad'], mid: ['권장', 'warn'], low: ['참고', ''] };
const ADV_SHOW = 3; // 리포트의 '우선 제언'과 같은 3개를 먼저
function adviceLink(l) {
  if (l.k === 'alerts') return `<button type="button" class="linkbtn" data-open-alerts>${esc(l.label)} →</button>`;
  if (l.k === 'trace') return `<button type="button" class="linkbtn" ${traceAttrs(l.id, l.at || 0, 0, l.label)}>${esc(l.label)} →</button>`;
  if (l.k === 'agent') return `<button type="button" class="linkbtn" data-agent="${esc(l.name)}">${esc(l.label)} →</button>`;
  if (l.k === 'view') return `<button type="button" class="linkbtn" data-goview="${esc(l.v)}">${esc(l.label)} →</button>`;
  return '';
}
function renderAdvice(d) {
  const list = d.advice || [];
  $('#advice-sub').textContent = `${RANGE_LABEL[d.range]} 기록으로 본 다음 할 일 ${list.length}가지 · 리포트 8장에도 들어가요`;
  if (!list.length) { $('#advice').innerHTML = '<div class="empty">지금 기록으로는 따로 드릴 제언이 없어요</div>'; return; }
  const show = state.adviceAll ? list : list.slice(0, ADV_SHOW);
  $('#advice').innerHTML = show.map((a) => {
    const [lab, cls] = ADV[a.level] || ADV.low;
    return `<article class="adv lv-${esc(a.level)}">
        <div class="adv-head"><span class="chip ${cls}">${lab}</span><span class="area">${esc(a.area)}</span></div>
        <h3>${esc(a.title)}</h3>
        <p class="ev">${esc(a.evidence)}</p>
        <details><summary>실행 ${a.actions.length}가지 · 기대 효과</summary>
          <ul>${a.actions.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
          <p class="eff">기대 효과 — ${esc(a.effect)}</p></details>
        ${a.links.length ? `<div class="a-acts">${a.links.map(adviceLink).join('')}</div>` : ''}
      </article>`;
  }).join('') + (list.length > ADV_SHOW ? `<button type="button" class="btn adv-more" id="advice-more">${state.adviceAll ? '접기' : `제언 ${list.length}가지 모두 보기`}</button>` : '');
}

// 직원 md 머리의 model(없으면 그 직원을 부른 세션의 모델을 그대로 쓴다)
const modelNote = (s) => (s.model && s.model !== 'inherit' ? `model: ${s.model}` : '세션 모델 따름');

// 직원별 월 예산이 있으면 카드에 이번 달 막대
function staffMeter(s, d) {
  const cap = d.budget && d.budget.staff && d.budget.staff[s.name];
  if (!cap) return '';
  const p = ((s.month || 0) / cap) * 100;
  return `<div class="smeter${p > 100 ? ' over' : p >= 80 ? ' near' : ''}" title="이번 달 ${fmtUsd(s.month)} / 예산 ${fmtUsd(cap)} (${Math.round(p)}%)"><span class="meter"><i style="width:${Math.min(100, p)}%"></i></span><span>이번 달 ${fmtUsd(s.month)} / ${fmtUsd(cap)}</span></div>`;
}

function renderRoster(d) {
  $('#roster-title').textContent = `직원 ${d.staff.length}명 · ${RANGE_LABEL[d.range]}`;
  $('#roster').innerHTML = d.staff.map((s) => {
    const used = s.skills.filter((k) => k.callsAll > 0).length;
    return `<div class="agent" role="button" tabindex="0" data-agent="${esc(s.name)}" style="--c:${s.color}" aria-label="${esc(s.team || s.name)} 자세히 보기">
      <div class="who"><span class="avatar">${esc((s.team || s.name).slice(0, 1))}</span>
        <div class="names"><div class="team">${esc(s.team || s.name)}</div><div class="id" title="${esc(modelNote(s))}">${esc(s.name)}${s.model && s.model !== 'inherit' ? ` · ${esc(prettyModel(s.model))}` : ''}</div></div>${statusChip(s, d)}</div>
      ${doingLine(liveOf(s.name))}
      <div class="purpose">${esc(s.purpose)}</div>
      <dl class="stats">
        <div><dt>작업</dt><dd>${s.runs}건</dd></div>
        <div><dt>토큰</dt><dd title="${s.tokens.total.toLocaleString()}">${fmtTok(s.tokens.total)}</dd></div>
        <div><dt>비용</dt><dd>${fmtUsd(s.cost)}</dd></div>
      </dl>
      ${staffMeter(s, d)}
      <div class="spark" title="최근 14일 날짜별 비용">${spark(s.spark)}</div>
      <div class="foot"><span>맡은 스킬 ${s.skills.length}개 · 써 본 스킬 ${used}개</span><span>14일 비용</span></div>
    </div>`;
  }).join('') || '<div class="empty">~/.claude/agents 에 직원이 없어요</div>';
}

function agentMeta(d, key) {
  const s = d.staff.find((x) => x.name === key);
  return s ? { label: s.team || s.name, color: s.color } : { label: key === 'unknown' ? '알 수 없음' : key, color: NEUTRAL };
}

function statusHtml(st) {
  const [t, c] = STATUS[st] || [st, ''];
  return `<span class="chip ${c}">${t}</span>`;
}

// 누르면 트레이스를 여는 줄의 속성
const traceAttrs = (id, at = 0, hl = 0, label = '단계 타임라인 보기') =>
  `role="button" tabindex="0" data-tid="${esc(id)}" data-tat="${at || 0}"${hl ? ` data-thl="${hl}"` : ''} aria-label="${esc(label)}"`;

function renderRuns(d) {
  if (!d.runs.length) { $('#runs').innerHTML = '<div class="empty">아직 직원 작업 기록이 없어요</div>'; return; }
  $('#runs').innerHTML = `<div class="rowx head"><span>시작</span><span>누가</span><span>무슨 일</span><span class="r">걸린 시간</span><span class="r">토큰</span><span class="r">비용</span><span class="r">상태</span></div>`
    + d.runs.slice(0, 30).map((r) => {
      const a = agentMeta(d, r.agent);
      return `<div class="rowx click" ${traceAttrs(r.id, 0, 0, (r.description || a.label) + ' 단계 타임라인')}>
        <span class="cell num faint">${fmtTime(r.start)}</span>
        <span class="cell" title="${esc(r.agent)}"><i class="dot" style="background:${a.color}"></i>${esc(a.label)}</span>
        <span class="cell" title="${esc(r.description)}${r.folder ? ' · ' + esc(r.folder) : ''}">${esc(r.description || '(설명 없음)')}</span>
        <span class="cell r">${fmtDur(r.durationMs)}</span>
        <span class="cell r">${fmtTok(r.tokens)}</span>
        <span class="cell r">${fmtUsd(r.cost)}</span>
        <span class="cell r">${statusHtml(r.status)}</span></div>`;
    }).join('');
}

function renderSkills(d) {
  $('#skills-sub').textContent = RANGE_LABEL[d.range] + ' · 스킬 토큰은 추정';
  $('#skills').innerHTML = d.skills.length
    ? `<div class="rowx head"><span>스킬</span><span>담당 팀</span><span class="r">호출</span><span class="r">토큰</span><span class="r">비용</span></div>`
      + d.skills.slice(0, 12).map((s) => `<div class="rowx">
        <span class="cell mono" title="${esc(s.skill)}">${esc(skillShort(s.skill))}</span>
        <span class="cell">${s.owner ? `<span class="chip">${esc(s.owner)}</span>` : '<span class="faint">직원 밖</span>'}</span>
        <span class="cell r">${s.calls}</span>
        <span class="cell r">${fmtTok(s.tokens)}</span>
        <span class="cell r">${fmtUsd(s.cost)}</span></div>`).join('')
    : '<div class="empty">이 기간에는 스킬을 부른 기록이 없어요</div>';

  const byOwner = {};
  for (const u of d.unusedSkills) (byOwner[u.owner] ||= []).push(u.skill);
  $('#unused').innerHTML = d.unusedSkills.length
    ? `<details class="unused"><summary>아직 한 번도 안 쓴 직원 스킬 ${d.unusedSkills.length}개</summary>
        ${Object.entries(byOwner).map(([o, list]) => `<h3>${esc(o)} (${list.length})</h3><div class="chips">${list.map((k) => `<span class="chip mono" title="${esc(k)}">${esc(skillShort(k))}</span>`).join('')}</div>`).join('')}
      </details>`
    : '';
}

const OFFICE_STATUS = { working: ['일하는 중', 'ok live'], decision: ['승인 대기', 'warn'], rest: ['쉬는 중', ''] };
function leadChip(lastActive) {
  const ll = state.live && state.live.lead;
  if (ll && (ll.state === 'working' || ll.state === 'decision')) {
    const [t, c] = OFFICE_STATUS[ll.state];
    return `<span class="chip ${c}">${t}</span>`;
  }
  return `<span class="chip" title="${lastActive ? esc(fmtTime(lastActive)) : ''}">${fmtAgo(lastActive)}</span>`;
}
function leadDoing() {
  const ll = state.live && state.live.lead;
  if (!ll || ll.state === 'rest') return '';
  if (ll.state === 'decision') return `<div class="doing" style="background:var(--warn-bg)"><span>승인 기다림${ll.ask ? ': ' + esc(ll.ask) : ''}</span></div>`;
  return ll.doing ? `<div class="doing"><span>${esc(actNow(ll.doing))}</span></div>` : '';
}

function renderOthers(d) {
  const l = d.lead || {};
  const builtin = d.builtin.length
    ? d.builtin.map((b) => `<div class="rowx" style="grid-template-columns:minmax(0,1fr) 54px 70px"><span class="cell mono">${esc(b.key === 'unknown' ? '알 수 없음' : b.key)}</span><span class="cell r">${b.runs}건</span><span class="cell r">${fmtUsd(b.cost)}</span></div>`).join('')
    : '<div class="faint">이 기간 기록 없음</div>';
  const others = d.others.filter((o) => o.cost > 0 || o.prompts > 0);
  $('#others').innerHTML = `<div class="subgrid">
      <div class="mini agent" role="button" tabindex="0" data-agent="__lead" style="--c:#1baf7a;box-shadow:none" aria-label="팀장 자세히 보기">
        <div class="who"><span class="avatar">팀</span><div class="names"><div class="team">${esc(l.name || '팀장')}</div><div class="id">${esc(l.project || 'skill-team')} 세션</div></div>
        ${leadChip(l.lastActive)}</div>
        ${leadDoing()}
        <div class="purpose">${esc(l.purpose || '')}</div>
        <dl class="stats"><div><dt>요청</dt><dd>${l.prompts || 0}회</dd></div><div><dt>토큰</dt><dd>${fmtTok(l.tokens?.total)}</dd></div><div><dt>비용</dt><dd>${fmtUsd(l.cost)}</dd></div></dl>
      </div>
      <div class="mini"><h3>기본 에이전트 <span class="faint">(직원 명부에 없는 서브에이전트)</span></h3><div class="rows">${builtin}</div></div>
    </div>
    <h3>그 밖의 세션 (프로젝트 폴더별)</h3>
    ${others.length ? `<div class="rows others"><div class="rowx head"><span>폴더</span><span class="r">세션</span><span class="r">요청</span><span class="r">토큰</span><span class="r">비용</span><span class="r">마지막</span></div>
      ${others.map((o) => `<div class="rowx"><span class="cell" title="${esc(o.key)}">${esc(o.key)}</span><span class="cell r">${o.sessions}</span><span class="cell r">${o.prompts}</span><span class="cell r">${fmtTok(o.tokens.total)}</span><span class="cell r">${fmtUsd(o.cost)}</span><span class="cell r faint">${fmtAgo(o.lastActive)}</span></div>`).join('')}</div>`
      : '<div class="faint">이 기간 기록 없음</div>'}`;
}

// ── 직원 상세 서랍 ──
function drawerLive(s) {
  if (s.isLead) {
    const ll = state.live && state.live.lead;
    if (!ll || ll.state === 'rest') return '';
    return `<section><h3>지금</h3>${leadDoing() || '<div class="doing"><span>일하는 중</span></div>'}</section>`;
  }
  const l = liveOf(s.name);
  if (!l || l.state !== 'working') return '';
  const mins = l.since ? Math.max(0, Math.floor((Date.now() - l.since) / 60000)) : 0;
  return `<section><h3>지금 하는 일 <span class="faint">· ${mins ? mins + '분째' : '방금 시작'}${l.running > 1 ? ` · 동시에 ${l.running}건` : ''}</span></h3>
    ${l.desc ? `<div style="margin-bottom:6px">${esc(l.desc)}</div>` : ''}${doingLine(l)}</section>`;
}

function leadAsAgent(d) {
  const l = d.lead || {};
  return {
    name: '__lead', team: l.name || '팀장', color: '#1baf7a', purpose: l.purpose || '', goals: l.goals || [],
    workflow: l.workflow || [], tokens: l.tokens, cost: l.cost, runs: l.prompts || 0, lastActive: l.lastActive,
    skills: null, recentRuns: d.runs.filter((r) => r.lead).slice(0, 12), isLead: true,
  };
}

function backButton() {
  if (state.stack.length < 2) return '';
  const prev = state.stack[state.stack.length - 2];
  const label = prev.type === 'alerts' ? '알림·예산'
    : prev.type === 'agent' ? (prev.name === '__lead' ? '팀장' : agentMeta(state.data, prev.name).label) : (prev.title || '이전 실행');
  return `<button type="button" class="btn back" title="뒤로"><span aria-hidden="true">←</span> ${esc(label)}</button>`;
}
const closeBtn = '<button type="button" class="icon-btn close" aria-label="닫기" title="닫기 (Esc)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>';

function openPanel(focus, keepTop) {
  $('#scrim').hidden = false;
  $('#drawer').hidden = false;
  if (focus) { $('#drawer').scrollTop = 0; ($('#drawer .back') || $('#drawer .close')).focus(); } else $('#drawer').scrollTop = keepTop;
}

const kname = (skill) => (state.data && state.data.skillNames && state.data.skillNames[skillShort(skill).toLowerCase()]) || '';

function showAgent(name, { focus = true } = {}) {
  const d = state.data;
  const s = name === '__lead' ? leadAsAgent(d) : d.staff.find((x) => x.name === name);
  if (!s) { closeDrawer(); return; }
  const dr = $('#drawer');
  const keepTop = dr.scrollTop; // 요약이 새로 와서 다시 그릴 때 읽던 자리를 지킨다
  dr.classList.remove('wide');
  const t = s.tokens || { total: 0 };
  const done = (s.recentRuns || []).filter((r) => r.status === 'done');
  const avg = done.length ? done.reduce((a, r) => a + r.durationMs, 0) / done.length : 0;
  const stack = TOKEN_PARTS.map(([k, , c]) => (t[k] ? `<i style="width:${(t[k] / t.total) * 100}%;background:${c}" title="${k}"></i>` : '')).join('');
  const skills = s.skills ? [...s.skills].sort((a, b) => b.callsAll - a.callsAll || a.name.localeCompare(b.name)) : null;
  const turns = s.isLead ? d.leadTurns || [] : [];

  dr.innerHTML = `
    ${backButton()}
    <div class="dhead" style="--c:${s.color}">
      <span class="avatar">${esc((s.team || s.name).slice(0, 1))}</span>
      <div><h2 id="drawer-title">${esc(s.team || s.name)}</h2><div class="mono faint">${esc(s.isLead ? (d.lead?.project || 'skill-team') + ' 세션' : `${s.name} · ${modelNote(s)}`)}</div></div>
      ${closeBtn}
    </div>
    <div id="drawer-live">${drawerLive(s)}</div>
    <section>
      <h3>목적</h3><div>${esc(s.purpose) || '<span class="faint">config/profiles.json 에 적어 주세요</span>'}</div>
      ${s.goals && s.goals.length ? `<h3>목표</h3><ul class="goals">${s.goals.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>` : ''}
    </section>
    <section style="--c:${s.color}">
      ${s.workflow && s.workflow.length ? `<h3>정해 둔 워크플로 <span class="faint">· config/profiles.json</span></h3><div class="flow">${s.workflow.map((w, i) => `${i ? '<span class="arrow" aria-hidden="true">→</span>' : ''}<span class="step"><b>${i + 1}</b>${esc(w)}</span>`).join('')}</div>` : ''}
      <div id="drawer-pattern">${patternHtml(name)}</div>
    </section>
    <section>
      <h3>${RANGE_LABEL[d.range]} 숫자</h3>
      <dl class="stats" style="grid-template-columns:repeat(4,1fr)">
        <div><dt>${s.isLead ? '요청' : '작업'}</dt><dd>${s.runs}${s.isLead ? '회' : '건'}</dd></div>
        <div><dt>토큰</dt><dd title="${(t.total || 0).toLocaleString()}">${fmtTok(t.total)}</dd></div>
        <div><dt>비용</dt><dd>${fmtUsd(s.cost)}</dd></div>
        <div><dt>평균 작업</dt><dd>${fmtDur(avg)}</dd></div>
      </dl>
      <h3>토큰 구성</h3>
      ${t.total ? `<div class="stack">${stack}</div><div class="legend" style="margin-top:8px">${TOKEN_PARTS.map(([k, l, c]) => `<span><i class="sw" style="background:${c}"></i>${l} <b class="num">${fmtTok(t[k])}</b></span>`).join('')}</div>` : '<div class="faint">이 기간 기록 없음</div>'}
    </section>
    ${skills ? `<section class="skilltable"><h3>맡은 스킬 ${skills.length}개 <span class="faint">· 이 직원이 직접 부른 횟수</span></h3><div class="rows">
      <div class="rowx head"><span>스킬</span><span class="r">이 기간</span><span class="r">전체</span><span class="r">마지막</span></div>
      ${skills.map((k) => `<div class="rowx"><span class="cell" title="${esc(k.name)}"><span class="mono">${esc(skillShort(k.name))}</span>${kname(k.name) ? ` <small class="faint">${esc(kname(k.name))}</small>` : ''}</span><span class="cell r">${k.calls}</span><span class="cell r">${k.callsAll}</span><span class="cell r faint">${k.lastUsed ? fmtAgo(k.lastUsed) : '안 씀'}</span></div>`).join('')}
    </div></section>` : ''}
    ${s.isLead ? `<section class="runlist"><h3>${esc(ownerName())} 요청 <span class="faint">· ${RANGE_LABEL[d.range]} · 누르면 단계 타임라인</span></h3>
      ${turns.length ? `<div class="rows"><div class="rowx head"><span>시작</span><span>요청</span><span class="r">걸린 시간</span><span class="r">비용</span><span class="r">맡김</span></div>
        ${turns.map((u) => `<div class="rowx click" ${traceAttrs(u.id, u.at, 0, u.prompt + ' 단계 타임라인')}><span class="cell num faint">${fmtTime(u.at)}</span><span class="cell" title="${esc(u.prompt)}">${esc(u.prompt || '(내용 없음)')}</span><span class="cell r">${fmtDur(u.durationMs)}</span><span class="cell r">${fmtUsd(u.cost)}</span><span class="cell r">${u.agents.length ? u.agents.length + '명' : '—'}</span></div>`).join('')}</div>`
        : '<div class="faint">이 기간에는 팀장에게 보낸 요청이 없어요</div>'}
    </section>` : ''}
    <section class="runlist"><h3>${s.isLead ? '팀장이 맡긴 최근 작업' : '최근 작업'} <span class="faint">· 누르면 단계 타임라인</span></h3>
      ${s.recentRuns && s.recentRuns.length ? `<div class="rows"><div class="rowx head"><span>시작</span><span>무슨 일</span><span class="r">걸린 시간</span><span class="r">비용</span><span class="r">상태</span></div>
        ${s.recentRuns.map((r) => `<div class="rowx click" ${traceAttrs(r.id, 0, 0, (r.description || r.agent) + ' 단계 타임라인')}><span class="cell num faint">${fmtTime(r.start)}</span><span class="cell" title="${esc(r.description)}${r.skills.length ? ' · 스킬: ' + esc(r.skills.join(', ')) : ''}">${s.isLead ? `<i class="dot" style="background:${agentMeta(d, r.agent).color}"></i>` : ''}${esc(r.description || '(설명 없음)')}</span><span class="cell r">${fmtDur(r.durationMs)}</span><span class="cell r">${fmtUsd(r.cost)}</span><span class="cell r">${statusHtml(r.status)}</span></div>`).join('')}</div>`
        : '<div class="faint">아직 작업 기록이 없어요</div>'}
    </section>`;
  openPanel(focus, keepTop);
  loadPattern(name);
}

// ── 실제 작업 패턴(최근 실행 n건) ──
function patternHtml(name) {
  const p = state.patterns.get(name);
  if (!p || !p.data) return '<h3>실제 작업 패턴</h3><div class="faint">최근 실행 기록을 읽고 있어요…</div>';
  const P = p.data;
  if (P.error) return `<h3>실제 작업 패턴</h3><div class="faint">${esc(P.error)}</div>`;
  if (!P.n) return '<h3>실제 작업 패턴</h3><div class="faint">아직 실행 기록이 없어요</div>';
  const tot = Object.values(P.share).reduce((a, b) => a + b, 0) || 1;
  const order = P.order;
  const chips = order.length
    ? `<div class="flow actual">${order.map((o, i) => `${i ? '<span class="arrow" aria-hidden="true">→</span>' : ''}<span class="step" title="${esc(catLabel(o.cat))}: ${P.n}건 중 ${o.runs}건에 나옴 · 걸린 시간의 ${pctText(o.ms, tot)}"><i class="sw" style="background:${catColor(o.cat)}"></i>${esc(catLabel(o.cat))}<small>${o.runs}/${P.n}건</small></span>`).join('')}</div>`
    : '<div class="faint">도구를 거의 쓰지 않았어요</div>';
  const cats = Object.entries(P.share).filter(([, ms]) => ms > 0).sort((a, b) => b[1] - a[1]);
  return `<h3>실제 작업 패턴 <span class="faint">· 최근 ${P.n}건${P.total > P.n ? ` (전체 ${P.total}건)` : ''} · 하는 일이 평균적으로 나오는 순서</span></h3>
    ${chips}
    <div class="strips" aria-label="실행마다 시간을 어디에 썼나">${P.runs.map((r) => `<div class="striprow click" ${traceAttrs(r.id, r.at, 0, (r.title || '') + ' 단계 타임라인')}>
        <span class="num faint">${fmtTime(r.at)}</span>
        <span class="strip" title="${esc(r.title)}">${r.strip.map((x) => `<i style="flex:${x.w};background:${catColor(x.c)}"></i>`).join('')}</span>
        <span class="r num">${fmtDur(r.durationMs)}</span></div>`).join('')}</div>
    <div class="legend" style="margin-top:8px">${cats.map(([c, ms]) => `<span><i class="sw" style="background:${catColor(c)}"></i>${esc(catLabel(c))} <b class="num">${pctText(ms, tot)}</b></span>`).join('')}</div>`;
}

const PATTERN_TTL = 30000; // 같은 직원 패턴은 30초 안에 다시 받지 않는다
async function loadPattern(name) {
  const p = state.patterns.get(name);
  if (p && (p.loading || Date.now() - p.at < PATTERN_TTL)) return;
  state.patterns.set(name, { at: p ? p.at : 0, data: p ? p.data : null, loading: true });
  let data;
  try {
    const res = await fetch('/api/pattern?agent=' + encodeURIComponent(name), { cache: 'no-store' });
    data = await res.json();
  } catch (err) {
    data = { error: '패턴을 불러오지 못했어요 (' + (err.message || err) + ')' };
  }
  state.patterns.set(name, { at: Date.now(), data, loading: false });
  if (topAgent() === name && $('#drawer-pattern')) $('#drawer-pattern').innerHTML = patternHtml(name);
}

function openDrawer(name) {
  const e = { type: 'agent', name };
  if ($('#drawer').hidden) state.stack = [e]; else state.stack.push(e);
  showAgent(name);
}

function openTrace(ref) {
  const e = { type: 'trace', id: ref.id, at: ref.at || 0, hl: ref.hl || 0 };
  if ($('#drawer').hidden) state.stack = [e]; else state.stack.push(e);
  showTrace(e);
}

function showTop({ focus = true } = {}) {
  const t = topOf();
  if (!t) { closeDrawer(); return; }
  if (t.type === 'agent') showAgent(t.name, { focus });
  else if (t.type === 'alerts') showAlerts({ focus });
  else showTrace(t, { focus });
}

function goBack() {
  if (state.stack.length < 2) { closeDrawer(); return; }
  state.stack.pop();
  showTop();
}

function closeDrawer() {
  state.stack = [];
  state.trace = null;
  $('#drawer').hidden = true;
  $('#drawer').classList.remove('wide');
  $('#scrim').hidden = true;
  if (state.lastFocus && document.contains(state.lastFocus)) state.lastFocus.focus();
}

// ── 트레이스(실행 한 건의 단계 타임라인) ──
const fmtStep = (ms) => {
  if (!ms || ms < 0) return '0초';
  if (ms < 10000) return (ms / 1000).toFixed(1) + '초';
  if (ms < 60000) return Math.round(ms / 1000) + '초';
  return fmtDur(ms);
};
const fmtStamp = (ts) => (ts >= new Date().setHours(0, 0, 0, 0) ? '' : fmtDay(ts) + ' ') + fmtClockS(ts);
const fmtSpan = (ms) => (ms < 60000 ? Math.round(ms / 1000) + '초' : ms < 3600000 ? +(ms / 60000).toFixed(1) + '분' : +(ms / 3600000).toFixed(1) + '시간');
function niceTick(ms, most = 6) {
  const c = [1e3, 2e3, 5e3, 1e4, 15e3, 3e4, 6e4, 12e4, 3e5, 6e5, 9e5, 18e5, 36e5, 72e5, 144e5, 288e5];
  return c.find((x) => ms / x <= most) || c[c.length - 1];
}
// 막대 칸의 대략 너비(px). 폰에서는 막대가 한 줄을 다 쓴다(style.css 720px 아래)
function trackWidth() {
  const w = Math.min(innerWidth, 1040);
  return innerWidth <= 720 ? w - 72 : w - 44 - 36 - (320 + 58 + 54);
}

function stepLabel(s) {
  if (s.type === 'mark') {
    if (s.k === 'notify') return `${s.child ? whoInfo(s.child.who).label + ' ' : ''}작업 끝 알림 · ${s.a || ''}`;
    return `${ownerName()} 추가 요청 · ` + (s.a || '');
  }
  if (s.type === 'llm') return s.say ? s.say : s.tools ? `도구 ${s.tools}개 부르기로 함` : '응답';
  if (TOOL_LABEL[s.name] || TOOL_LABEL[s.a]) return TOOL_LABEL[s.name] || TOOL_LABEL[s.a];
  if (s.k === 'agent') return `${s.to ? whoOfType(s.to).label + '에게 ' : ''}맡김 · ${s.a || ''}`;
  return `${ACT_KIND[s.k] || '도구'} · ${s.a || s.name}`;
}

let traceSeq = 0;
async function showTrace(e, { focus = true, quiet = false } = {}) {
  const dr = $('#drawer');
  const keepTop = dr.scrollTop;
  dr.classList.add('wide');
  if (!quiet) {
    dr.innerHTML = `${backButton()}<div class="dhead"><div class="grow"><h2 id="drawer-title">단계 타임라인</h2><div class="faint">기록을 읽고 있어요…</div></div>${closeBtn}</div><div class="empty" id="trace-wait">잠시만요</div>`;
    openPanel(focus, 0);
  }
  const seq = ++traceSeq;
  let t;
  try {
    const res = await fetch(`/api/trace?id=${encodeURIComponent(e.id)}&at=${e.at || 0}`, { cache: 'no-store' });
    t = await res.json();
  } catch (err) {
    t = { error: 'Control Center 서버에 닿지 못했어요 (' + (err.message || err) + ')' };
  }
  if (seq !== traceSeq || topOf() !== e) return; // 그사이 다른 화면으로 갔다
  if (t.error || t.loading) {
    if (!quiet && $('#trace-wait')) $('#trace-wait').textContent = t.error || '기록을 아직 읽는 중이에요. 잠시 뒤 다시 눌러 주세요.';
    return;
  }
  state.trace = t;
  e.title = t.title || t.prompt || '실행';
  e.lastLoad = Date.now();
  e.expanded ||= new Set();
  dr.innerHTML = traceHtml(t, e);
  if (quiet) { dr.scrollTop = keepTop; return; }
  openPanel(focus, 0);
  const hl = dr.querySelector('.wf-row.hl');
  if (hl) hl.scrollIntoView({ block: 'center' });
}

function refreshTrace() {
  const e = topOf();
  if (!e || e.type !== 'trace' || !state.trace || state.trace.status !== 'running') return;
  if (Date.now() - (e.lastLoad || 0) < 3000) return;
  showTrace(e, { focus: false, quiet: true });
}

function traceHtml(t, e) {
  const w = whoInfo(t.who);
  const T0 = t.t0;
  const span = Math.max(1000, t.view1 - T0);
  const pos = (ts) => Math.max(0, Math.min(100, ((ts - T0) / span) * 100));
  const tot = t.totals;
  const steps = t.steps;
  const shareTot = Object.values(tot.share).reduce((a, b) => a + b, 0) || 1;
  const cats = Object.entries(tot.share).filter(([, ms]) => ms > 0).sort((a, b) => b[1] - a[1]);
  const dur = (s) => Math.max(0, (s.t1 || s.t0) - s.t0);
  const tools = steps.filter((s) => s.type === 'tool');
  const llms = steps.filter((s) => s.type === 'llm');
  const slowTool = [...tools].sort((a, b) => dur(b) - dur(a))[0];
  const slowLlm = [...llms].sort((a, b) => dur(b) - dur(a))[0];
  const priciest = [...llms].sort((a, b) => b.cost - a.cost)[0];

  // 피드에서 누른 그 순간의 단계를 표시한다
  let hlIdx = -1;
  if (e.hl) {
    let best = 3000;
    for (const s of steps) {
      const dd = Math.abs(s.t0 - e.hl) - (s.type === 'tool' ? 1 : 0);
      if (dd < best) { best = dd; hlIdx = s.i; }
    }
  }

  // 응답 아래에 그 응답이 부른 도구를 들여 쓴다. 알림·추가 요청은 시간 순서로 끼운다.
  let rows;
  if (state.traceSort === 'slow') {
    rows = [...steps].sort((a, b) => dur(b) - dur(a)).slice(0, 40).map((s) => ({ s, depth: 0 }));
  } else {
    const kids = new Map();
    for (const s of tools) { if (!kids.has(s.parent)) kids.set(s.parent, []); kids.get(s.parent).push(s); }
    const tops = llms.map((s) => ({ t: s.t0, items: [{ s, depth: 0 }, ...(kids.get(s.i) || []).map((c) => ({ s: c, depth: 1 }))] }));
    t.marks.forEach((m, mi) => tops.push({ t: m.t0, items: [{ s: { ...m, mi }, depth: 0 }] }));
    tops.sort((a, b) => a.t - b.t);
    rows = tops.flatMap((g) => g.items);
  }

  const tick = niceTick(span, Math.max(2, Math.floor(trackWidth() / 60)));
  const ticks = [];
  for (let x = 0; x <= span; x += tick) ticks.push(`<i style="left:${(x / span) * 100}%">${x ? fmtSpan(x) : '0'}</i>`);

  const row = ({ s, depth }) => {
    const mark = s.type === 'mark';
    const id = mark ? 'm' + s.mi : String(s.i);
    const d = mark ? 0 : dur(s);
    const color = mark ? (s.child ? whoInfo(s.child.who).color : 'var(--accent)') : catColor(s.cat);
    let bars = mark
      ? `<i class="pin" style="left:${pos(s.t0)}%;--pc:${color}"></i>`
      : `<i class="bar${s.err ? ' err' : ''}${s.running ? ' run' : ''}" style="left:${pos(s.t0)}%;width:${Math.max(0.3, (d / span) * 100)}%;background:${color}"></i>`;
    if (s.child && s.child.t0) {
      const cw = whoInfo(s.child.who);
      bars += `<i class="bar kid" style="left:${pos(s.child.t0)}%;width:${Math.max(0.3, ((s.child.t1 - s.child.t0) / span) * 100)}%;--kc:${cw.color}" title="${esc(cw.label)} 작업 ${esc(fmtDur(s.child.t1 - s.child.t0))}"></i>`;
    }
    const label = stepLabel(s);
    const chips = (s.err ? '<span class="chip bad">오류</span>' : '') + (s.running ? '<span class="chip ok live">진행 중</span>' : '')
      + (s.open ? '<span class="chip">결과 없음</span>' : '') + (!mark && s.child ? `<span class="chip kidst" style="color:${whoInfo(s.child.who).color}">${statusLabel(s.child.status)}</span>` : '');
    const open = e.expanded.has(id);
    return `<div class="wf-row${depth ? ' kid' : ''}${s.type === 'llm' ? ' llm' : ''}${mark ? ' mark' : ''}${s.i === hlIdx && !mark ? ' hl' : ''}" role="button" tabindex="0" data-step="${id}" aria-expanded="${open}">
        <span class="wf-label" title="${esc(label)}"><i class="sw" style="background:${color}"></i><span class="t">${esc(label)}</span>${chips}</span>
        <span class="wf-track">${bars}</span>
        <span class="wf-dur num">${mark ? fmtClock(s.t0) : fmtStep(d)}</span>
        <span class="wf-cost num">${s.type === 'llm' ? fmtUsd(s.cost) : ''}</span>
      </div>${open ? stepDetail(s) : ''}`;
  };

  const jump = (s, text) => (s ? `<button type="button" class="chip jump" data-jump="${s.i}">${text}</button>` : '');
  const insights = [
    jump(slowTool, `가장 오래 걸린 도구 · ${esc(stepLabel(slowTool || {}))} ${slowTool ? fmtStep(dur(slowTool)) : ''}`),
    jump(slowLlm, `가장 오래 걸린 응답 · ${slowLlm ? fmtStep(dur(slowLlm)) : ''}`),
    jump(priciest, `가장 비싼 응답 · ${priciest ? fmtUsd(priciest.cost) : ''}`),
    tot.errors ? jump(steps.find((s) => s.err), `오류 ${tot.errors}건`).replace('class="chip jump"', 'class="chip bad jump"') : '',
    tot.skills.length ? `<span class="chip">스킬 · ${esc(tot.skills.join(', '))}</span>` : '',
    tot.thinkMs ? `<span class="chip">생각 시간 합계 ${fmtStep(tot.thinkMs)}</span>` : '',
    t.models.length ? `<span class="chip">${esc(t.models.map(prettyModel).join(', '))}</span>` : '',
  ].filter(Boolean).join('');

  const nav = [];
  if (t.parent) {
    const pw = whoInfo(t.parent.who);
    nav.push(`<span class="faint">맡긴 곳</span> <button type="button" class="linkbtn" ${traceAttrs(t.parent.id, t.parent.at, 0, '맡긴 요청 열기')}><i class="dot" style="background:${pw.color}"></i>${esc(pw.label)} · ${esc(t.parent.prompt || '요청')}</button>`);
  }
  if (t.turn) {
    nav.push(`<span class="faint">이 세션의 요청 ${t.turn.index + 1}/${t.turn.count}</span>`);
    if (t.turn.prev) nav.push(`<button type="button" class="linkbtn" data-treplace="1" ${traceAttrs(t.id, t.turn.prev, 0, '이전 요청')}>← 이전 요청</button>`);
    if (t.turn.next) nav.push(`<button type="button" class="linkbtn" data-treplace="1" ${traceAttrs(t.id, t.turn.next, 0, '다음 요청')}>다음 요청 →</button>`);
  }

  return `${backButton()}
    <div class="dhead" style="--c:${w.color}">
      <span class="avatar">${esc((w.label || '?').slice(0, 1))}</span>
      <div class="grow"><h2 id="drawer-title" title="${esc(e.title)}">${esc(e.title)}</h2>
        <div class="faint">${esc(w.label)}${t.kind === 'main' ? ' 세션' : ''} · ${fmtStamp(t.t0)} 시작 · ${statusHtml(t.status)}</div></div>
      ${closeBtn}
    </div>
    <section>
      <dl class="stats" style="grid-template-columns:repeat(4,1fr)">
        <div><dt>걸린 시간</dt><dd>${fmtDur(t.durationMs)}</dd></div>
        <div><dt>단계</dt><dd>응답 ${tot.llm} · 도구 ${tot.tools}</dd></div>
        <div><dt>토큰</dt><dd title="${tot.tokens.total.toLocaleString()}">${fmtTok(tot.tokens.total)}</dd></div>
        <div><dt>API 환산 비용</dt><dd>${fmtUsd(tot.cost)}</dd></div>
      </dl>
      <h3>시간을 어디에 썼나</h3>
      <div class="share">${cats.map(([c, ms]) => `<i style="flex:${ms};background:${catColor(c)}" title="${esc(catLabel(c))} ${esc(fmtStep(ms))} (${pctText(ms, shareTot)})"></i>`).join('')}</div>
      <div class="legend" style="margin-top:8px">${cats.map(([c, ms]) => `<span><i class="sw" style="background:${catColor(c)}"></i>${esc(catLabel(c))} <b class="num">${pctText(ms, shareTot)}</b> <span class="faint">${fmtStep(ms)}</span></span>`).join('')}</div>
      ${insights ? `<div class="insights">${insights}</div>` : ''}
      ${nav.length ? `<div class="crumbs">${nav.join('')}</div>` : ''}
      ${t.prompt ? `<details class="prompt"><summary>${t.kind === 'sub' ? '받은 지시' : '요청 내용'}</summary><p>${esc(t.prompt)}</p></details>` : ''}
    </section>
    <section class="wfsec">
      <header class="wfhead"><h3>단계 타임라인 <span class="faint">· ${rows.length}줄 · 누르면 자세히</span></h3>
        <div class="seg small" id="tsort" role="group" aria-label="정렬">
          <button type="button" data-v="time" aria-pressed="${state.traceSort === 'time'}">순서대로</button>
          <button type="button" data-v="slow" aria-pressed="${state.traceSort === 'slow'}">오래 걸린 순</button>
        </div></header>
      <div class="wf" style="--tick:${(tick / span) * 100}%">
        <div class="wf-axis" aria-hidden="true"><span></span><span class="wf-track">${ticks.join('')}</span><span></span><span></span></div>
        ${rows.length ? rows.map(row).join('') : '<div class="empty">남은 단계 기록이 없어요</div>'}
      </div>
      ${t.truncated ? '<div class="notice" style="margin-top:10px">이 요청은 기록이 너무 길어서 앞부분(48MB)만 보여 줘요.</div>' : ''}
      <p class="faint wf-note">막대 하나가 단계 하나예요. 도구 시간에는 승인을 기다린 시간도 들어가요. 도구가 돌려준 결과는 다음 응답의 입력 토큰으로 들어가서, 비용은 응답 줄에만 붙어요.${steps.some((s) => s.child) ? ' 빗금 막대는 맡긴 직원이 실제로 일한 시간이에요.' : ''}</p>
    </section>`;
}

const statusLabel = (st) => (STATUS[st] || [st])[0];

function stepDetail(s) {
  const kv = (k, v) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;
  const items = [];
  let extra = '';
  if (s.type === 'mark') {
    items.push(kv('시각', fmtStamp(s.t0)), kv('내용', esc(s.a || '—')));
    if (s.status) items.push(kv('상태', esc(s.status === 'completed' ? '끝남' : s.status)));
    if (s.child) extra = `<button type="button" class="btn" ${traceAttrs(s.child.id, 0, 0, '그 작업 타임라인 열기')}>${esc(whoInfo(s.child.who).label)} 작업 타임라인 열기 →</button>`;
  } else {
    items.push(kv('시작', fmtStamp(s.t0)), kv('끝', fmtStamp(s.t1)), kv('걸린 시간', fmtStep(s.t1 - s.t0)));
    if (s.type === 'llm') {
      items.push(kv('모델', esc(prettyModel(s.model))), kv('생각', s.think ? fmtStep(s.think) : '—'),
        kv('입력', fmtTok(s.tok.in)), kv('출력', fmtTok(s.tok.out)), kv('캐시 쓰기', fmtTok(s.tok.cw)), kv('캐시 읽기', fmtTok(s.tok.cr)),
        kv('비용', fmtUsd(s.cost)), kv('부른 도구', s.tools + '개'));
      if (s.say) extra = `<p class="say">${esc(s.say)}</p>`;
    } else {
      items.push(kv('도구', `<span class="mono">${esc(s.name)}</span>`), kv('대상', esc(s.a || '—')),
        kv('결과', s.err ? '<span class="chip bad">오류</span>' : s.running ? '진행 중' : s.open ? '결과 기록 없음' : '정상'));
      if (s.k === 'bash') extra = '<p class="faint">명령 원문에는 비밀값이 섞일 수 있어서 사람이 적은 설명만 보여 줘요.</p>';
      if (s.child) extra += `<button type="button" class="btn" ${traceAttrs(s.child.id, 0, 0, '맡긴 작업 타임라인 열기')}>${esc(whoInfo(s.child.who).label)} 작업 타임라인 열기 → <span class="faint">${fmtDur(s.child.t1 - s.child.t0)} · ${fmtUsd(s.child.cost)}</span></button>`;
    }
  }
  return `<div class="wf-detail"><dl class="kv">${items.join('')}</dl>${extra}</div>`;
}

function toggleStep(rowEl) {
  const e = topOf();
  if (!e || e.type !== 'trace' || !state.trace) return;
  const id = rowEl.dataset.step;
  if (e.expanded.has(id)) e.expanded.delete(id); else e.expanded.add(id);
  const keep = $('#drawer').scrollTop;
  $('#drawer').innerHTML = traceHtml(state.trace, e);
  $('#drawer').scrollTop = keep;
  const again = $(`#drawer .wf-row[data-step="${id}"]`);
  if (again) again.focus({ preventScroll: true });
}

function jumpToStep(i) {
  const e = topOf();
  if (!e || !state.trace) return;
  if (state.traceSort !== 'time') { state.traceSort = 'time'; $('#drawer').innerHTML = traceHtml(state.trace, e); }
  const el = $(`#drawer .wf-row[data-step="${i}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('flash');
  void el.offsetWidth; // 애니메이션을 다시 돌린다
  el.classList.add('flash');
  el.focus({ preventScroll: true });
}

// ── 워크플로 탭: 팀 워크플로 지도 + 실행 기록 ──
function renderFlowView(d) {
  $('#flow-title').textContent = `팀 워크플로 지도 · ${RANGE_LABEL[d.range]}`;
  renderFlowMap(d);
  renderTraceList(d);
}

let measureCtx = null;
function fitText(text, px, font) {
  measureCtx ||= document.createElement('canvas').getContext('2d');
  measureCtx.font = font;
  if (measureCtx.measureText(text).width <= px) return text;
  const cps = Array.from(text);
  let lo = 0; let hi = cps.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measureCtx.measureText(cps.slice(0, mid).join('') + '…').width <= px) lo = mid; else hi = mid - 1;
  }
  return cps.slice(0, lo).join('') + '…';
}

function renderFlowMap(d) {
  const el = $('#flowmap');
  const f = d.flow;
  if (!f) { el.innerHTML = '<div class="empty">요약을 다시 받아 주세요</div>'; return; }
  const L = state.live;
  const working = (name) => !!(L && L.staff && L.staff[name] && L.staff[name].state === 'working');
  const leadState = L && L.lead ? L.lead.state : 'rest';
  const lastSource = (name) => { const r = d.runs.find((x) => x.agent === name); return r ? (r.lead ? 'lead' : 'other') : 'lead'; };

  const nodes = new Map();
  const cols = [[], [], [], []];
  const add = (c, n) => { n.col = c; cols[c].push(n); nodes.set(n.id, n); };
  const allPrompts = f.leadPrompts + f.otherPrompts;
  add(0, { id: 'you', label: ownerName(), sub: `요청 ${allPrompts.toLocaleString()}회`, color: 'var(--accent)' });
  add(1, { id: 'lead', label: d.lead.name || '팀장', sub: `요청 ${f.leadPrompts}회 · ${fmtUsd(d.lead.cost)}`, color: LEAD_COLOR, agent: '__lead', live: leadState === 'working', warn: leadState === 'decision' });
  if (f.otherPrompts || f.links.some((l) => l.from === 'other')) {
    const oc = d.others.reduce((a, o) => a + o.cost, 0);
    add(1, { id: 'other', label: '다른 세션', sub: `직접 작업 · ${fmtUsd(oc)}`, color: NEUTRAL, title: '팀장 말고 직접 연 Claude Code 세션' });
  }
  for (const s of d.staff) {
    add(2, { id: 's:' + s.name, label: s.team || s.name, sub: s.runs ? `${s.runs}건 · ${fmtUsd(s.cost)}` : '이 기간 쉼', color: s.color, agent: s.name, dim: !s.runs && !working(s.name), live: working(s.name) });
  }
  const bl = f.links.filter((l) => l.to === 'builtin');
  if (bl.length) {
    const kinds = {};
    for (const l of bl) for (const [k, v] of Object.entries(l.kinds)) kinds[k] = (kinds[k] || 0) + v;
    add(2, {
      id: 'builtin', label: '기본 에이전트', sub: `${bl.reduce((a, l) => a + l.runs, 0)}건 · ${fmtUsd(bl.reduce((a, l) => a + l.cost, 0))}`,
      color: '#7c8a9e', title: '직원 명부에 없는 서브에이전트: ' + Object.entries(kinds).map(([k, v]) => `${k} ${v}건`).join(', '),
    });
  }
  const skillCalls = {};
  for (const l of f.skillLinks) skillCalls[l.skill] = (skillCalls[l.skill] || 0) + l.calls;
  const ranked = Object.entries(skillCalls).sort((a, b) => b[1] - a[1]);
  const MAXSK = 8;
  const ownerOf = (sk) => d.staff.find((s) => s.skills.some((k) => skillShort(k.name).toLowerCase() === skillShort(sk).toLowerCase()));
  for (const [sk, n] of ranked.slice(0, MAXSK)) {
    const o = ownerOf(sk);
    add(3, { id: 'k:' + sk, label: skillShort(sk), sub: `${n}회${o ? ' · ' + (o.team || o.name) : ''}`, color: o ? o.color : NEUTRAL, mono: true, title: sk });
  }
  if (ranked.length > MAXSK) {
    add(3, { id: 'k:+', label: `그 밖의 스킬 ${ranked.length - MAXSK}개`, sub: `${ranked.slice(MAXSK).reduce((a, [, n]) => a + n, 0)}회`, color: NEUTRAL });
  }
  if (!ranked.length) add(3, { id: 'k:none', label: '스킬 호출 없음', sub: '이 기간', color: NEUTRAL, dim: true });

  const emap = new Map();
  const link = (a, b, v, layer, extra = {}) => {
    if (!(v > 0) || !nodes.has(a) || !nodes.has(b)) return;
    const k = a + '>' + b;
    const e = emap.get(k);
    if (e) e.v += v; else emap.set(k, { a, b, v, layer, ...extra });
  };
  link('you', 'lead', f.leadPrompts, 0, { unit: '회' });
  link('you', 'other', f.otherPrompts, 0, { unit: '회' });
  for (const l of f.links) {
    const to = l.to === 'builtin' ? 'builtin' : 's:' + l.to;
    link(l.from, to, l.runs, 1, { unit: '건', live: l.to !== 'builtin' && working(l.to) && lastSource(l.to) === l.from });
  }
  for (const l of f.skillLinks) {
    const to = nodes.has('k:' + l.skill) ? 'k:' + l.skill : 'k:+';
    link(l.from === 'lead' ? 'lead' : 's:' + l.from, to, l.calls, 2, { unit: '회' });
  }
  const edges = [...emap.values()];

  const W = Math.max(el.clientWidth || 0, 760);
  const NW = [118, 156, 176, 184];
  const NH = 46;
  const GAP = 10;
  const maxN = Math.max(...cols.map((c) => c.length));
  const H = maxN * NH + (maxN - 1) * GAP + 8;
  const gap = (W - NW.reduce((a, b) => a + b, 0) - 2) / 3;
  const X = [];
  let x = 1;
  for (const w of NW) { X.push(x); x += w + gap; }
  cols.forEach((list, c) => {
    const h = list.length * NH + (list.length - 1) * GAP;
    let y = (H - h) / 2;
    for (const n of list) { n.x = X[c]; n.y = y; n.w = NW[c]; y += NH + GAP; n.out = []; n.in = []; }
  });
  for (const e of edges) { nodes.get(e.a).out.push(e); nodes.get(e.b).in.push(e); }
  // 선이 한 점에 몰리지 않게, 노드 높이 안에서 상대 노드 높이 순으로 나눠 붙인다
  for (const n of nodes.values()) {
    n.out.sort((p, q) => nodes.get(p.b).y - nodes.get(q.b).y).forEach((e, i, arr) => { e.y1 = n.y + (NH * (i + 1)) / (arr.length + 1); });
    n.in.sort((p, q) => nodes.get(p.a).y - nodes.get(q.a).y).forEach((e, i, arr) => { e.y2 = n.y + (NH * (i + 1)) / (arr.length + 1); });
  }
  const layerMax = [0, 0, 0];
  for (const e of edges) layerMax[e.layer] = Math.max(layerMax[e.layer], e.v);

  const font = getComputedStyle(document.body).fontFamily;
  let svg = '';
  for (const e of edges) {
    const a = nodes.get(e.a);
    const b = nodes.get(e.b);
    const x1 = a.x + a.w;
    const x2 = b.x;
    const dx = Math.max(30, (x2 - x1) / 2);
    const sw = 1.4 + 6.5 * Math.sqrt(e.v / (layerMax[e.layer] || 1));
    const color = e.layer === 2 ? a.color : b.color;
    svg += `<path class="fedge${e.live ? ' live' : ''}" d="M${x1} ${e.y1} C${x1 + dx} ${e.y1}, ${x2 - dx} ${e.y2}, ${x2} ${e.y2}" stroke="${e.live ? 'var(--ok)' : color}" stroke-width="${sw.toFixed(1)}"><title>${esc(a.label)} → ${esc(b.label)}: ${e.v.toLocaleString()}${e.unit}</title></path>`;
  }
  // 숫자는 받는 노드 바로 앞, 그 선이 닿는 높이에 붙인다(가운데에 두면 선이 몰리는 곳에서 겹친다)
  for (const e of edges) {
    if (e.layer === 2) continue; // 스킬 선은 많아서 숫자를 생략(마우스를 올리면 보임)
    const b = nodes.get(e.b);
    svg += `<text class="flabel" x="${b.x - 6}" y="${e.y2 + 3.5}" text-anchor="end">${e.v.toLocaleString()}${e.unit}</text>`;
  }
  for (const n of nodes.values()) {
    const lf = `600 12.5px ${n.mono ? 'var(--mono)' : font}`;
    const label = fitText(n.label, n.w - 34, n.mono ? `600 12px Consolas, monospace` : lf);
    const sub = fitText(n.sub, n.w - 34, `400 11px ${font}`);
    const cls = ['fnode', n.dim ? 'dim' : '', n.live ? 'live' : '', n.warn ? 'warn' : '', n.agent ? 'click' : ''].filter(Boolean).join(' ');
    const attrs = n.agent ? ` data-agent="${esc(n.agent)}" role="button" tabindex="0" aria-label="${esc(n.label)} 자세히 보기"` : '';
    svg += `<g class="${cls}" transform="translate(${n.x.toFixed(1)} ${n.y.toFixed(1)})"${attrs}>
      <title>${esc(n.title || n.label)} · ${esc(n.sub)}</title>
      <rect class="fbox" width="${n.w}" height="${NH}" rx="11"/>
      <circle cx="15" cy="${NH / 2}" r="5" fill="${n.color}"/>
      <text class="fl${n.mono ? ' mono' : ''}" x="27" y="20">${esc(label)}</text>
      <text class="fs" x="27" y="36">${esc(sub)}</text>
      ${n.live ? `<circle class="fpulse" cx="${n.w - 12}" cy="12" r="4"/>` : ''}${n.warn ? `<circle class="fwarn" cx="${n.w - 12}" cy="12" r="4"/>` : ''}
    </g>`;
  }
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(ownerName())}에서 팀장·직원·스킬로 이어지는 일의 흐름">${svg}</svg>`;

  const delegated = f.links.reduce((a, l) => a + l.runs, 0);
  const calls = ranked.reduce((a, [, n]) => a + n, 0);
  const nowWorking = d.staff.filter((s) => working(s.name)).length;
  $('#flow-line').innerHTML = `<span>${esc(ownerName())} 요청 <b class="num">${allPrompts.toLocaleString()}</b>회</span><span class="arrow">→</span>
    <span>직원에게 맡긴 일 <b class="num">${delegated}</b>건 <span class="faint">(팀장 ${f.links.filter((l) => l.from === 'lead').reduce((a, l) => a + l.runs, 0)} · 다른 세션 ${f.links.filter((l) => l.from === 'other').reduce((a, l) => a + l.runs, 0)})</span></span><span class="arrow">→</span>
    <span>팀장·직원의 스킬 호출 <b class="num">${calls}</b>회</span>
    ${nowWorking ? `<span class="chip ok live">지금 일하는 직원 ${nowWorking}</span>` : ''}`;
  $('#flow-sub').textContent = '';
}

function renderTraceList(d) {
  const f = state.runfilter;
  const runs = f === 'lead' ? [] : d.runs.filter((r) => r.start >= d.from).map((r) => ({
    id: r.id, at: 0, t: r.start, who: agentMeta(d, r.agent), what: r.description || '(설명 없음)', tip: r.skills.length ? '스킬: ' + r.skills.join(', ') : '',
    dur: r.durationMs, tok: r.tokens, cost: r.cost, status: r.status,
  }));
  const turns = f === 'staff' ? [] : (d.leadTurns || []).map((u) => ({
    id: u.id, at: u.at, t: u.at, who: { label: '팀장', color: LEAD_COLOR }, what: u.prompt || '(내용 없음)',
    tip: u.agents.length ? '맡김: ' + u.agents.map((a) => agentMeta(d, a).label).join(', ') : '', extra: u.agents.length ? `직원 ${u.agents.length}명에게 맡김` : '',
    dur: u.durationMs, tok: u.tokens, cost: u.cost, status: u.status,
  }));
  const items = [...runs, ...turns].sort((a, b) => b.t - a.t).slice(0, 60);
  $('#tracelist-sub').textContent = `${RANGE_LABEL[d.range]} ${items.length}건 · 누르면 단계 타임라인(트레이스)`;
  $('#tracelist').innerHTML = items.length
    ? `<div class="rowx head"><span>시작</span><span>누가</span><span>무슨 일</span><span class="r">걸린 시간</span><span class="r">토큰</span><span class="r">비용</span><span class="r">상태</span></div>`
      + items.map((it) => `<div class="rowx click" ${traceAttrs(it.id, it.at, 0, it.what + ' 단계 타임라인')}>
        <span class="cell num faint">${fmtTime(it.t)}</span>
        <span class="cell"><i class="dot" style="background:${it.who.color}"></i>${esc(it.who.label)}</span>
        <span class="cell" title="${esc(it.what)}${it.tip ? ' · ' + esc(it.tip) : ''}">${esc(it.what)}${it.extra ? ` <span class="chip">${esc(it.extra)}</span>` : ''}</span>
        <span class="cell r">${fmtDur(it.dur)}</span>
        <span class="cell r">${fmtTok(it.tok)}</span>
        <span class="cell r">${fmtUsd(it.cost)}</span>
        <span class="cell r">${statusHtml(it.status)}</span></div>`).join('')
    : `<div class="empty">${f === 'lead' ? '이 기간에는 팀장에게 보낸 요청이 없어요' : '이 기간에는 실행 기록이 없어요'}</div>`;
}

// ── 알림·예산 ──
const LEVEL = { bad: ['넘음', 'bad'], warn: ['주의', 'warn'], info: ['알림', ''] };
const bellSvg = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';

async function post(url, body) {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AMC': '1' }, body: JSON.stringify(body) });
    return await res.json();
  } catch (err) {
    return { error: 'Control Center 서버에 닿지 못했어요 (' + (err.message || err) + ')' };
  }
}

function renderBell() {
  const A = state.alerts;
  const n = A ? A.unread : 0;
  $('#bell-n').hidden = !n;
  $('#bell-n').textContent = n > 99 ? '99+' : String(n);
  $('#bell').classList.toggle('has', !!n);
  $('#bell').title = n ? `읽지 않은 알림 ${n}개 · 예산 설정` : '알림·예산';
  const bad = A && A.alerts.find((a) => a.level === 'bad' && !a.read);
  $('#banner').hidden = !bad;
  if (bad) $('#banner').innerHTML = `<b>${esc(bad.title)}</b><span>${esc(bad.body)}</span><button type="button" class="btn" data-open-alerts>알림 보기</button>`;
}

function toast(title, body = '', level = 'info', open = true) {
  const el = document.createElement('div');
  el.className = 'toast ' + ((LEVEL[level] || LEVEL.info)[1] || 'info');
  if (open) { el.setAttribute('role', 'button'); el.tabIndex = 0; el.dataset.openAlerts = ''; }
  el.innerHTML = `<b>${esc(title)}</b>${body ? `<span>${esc(body)}</span>` : ''}`;
  $('#toasts').append(el);
  setTimeout(() => el.classList.add('out'), 7000);
  setTimeout(() => el.remove(), 7600);
}

const notifyOn = () => store.get('notify', 'off') === 'on' && 'Notification' in window && Notification.permission === 'granted';
function desktopNotify(list) {
  if (!notifyOn()) return;
  for (const a of list.slice(0, 3)) {
    try {
      const n = new Notification(a.title, { body: a.body, tag: a.id, icon: 'favicon.svg' });
      n.onclick = () => { window.focus(); openAlerts(); n.close(); };
    } catch { /* 이 창에서는 못 띄운다 */ }
  }
}

async function toggleNotify() {
  if (!('Notification' in window)) { toast('이 브라우저는 바탕화면 알림을 띄우지 못해요', '', 'warn', false); return; }
  if (store.get('notify', 'off') === 'on') {
    store.set('notify', 'off');
  } else {
    const p = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    if (p !== 'granted') {
      toast('브라우저가 알림을 막아 두었어요', '주소창 왼쪽의 사이트 정보에서 알림을 허용해 주세요.', 'warn', false);
    } else {
      store.set('notify', 'on');
      try { new Notification('Claude Skill Team Control Center', { body: '이제 새 알림을 바탕화면에도 띄워요.', icon: 'favicon.svg' }); } catch { /* 무시 */ }
    }
  }
  if (topOf() && topOf().type === 'alerts') refreshAlertsDrawer();
}

function onAlerts(data) {
  state.alerts = data;
  renderBell();
  const fresh = (data.fresh || []).map((id) => data.alerts.find((a) => a.id === id)).filter(Boolean);
  for (const a of fresh.slice(0, 3)) toast(a.title, a.body, a.level);
  if (fresh.length) desktopNotify(fresh);
  if (topOf() && topOf().type === 'alerts' && !$('#drawer').hidden) refreshAlertsDrawer();
}

async function markAlertsRead(ids) {
  const r = await post('/api/alerts/read', ids === 'all' ? { all: true } : { ids });
  if (r.error) toast('읽음 표시를 못 했어요', r.error, 'warn', false);
}

function openAlerts() {
  if ($('#drawer').hidden) state.lastFocus = document.activeElement;
  state.stack = [{ type: 'alerts' }];
  showAlerts();
}

function alertItem(a) {
  const [lab, cls] = LEVEL[a.level] || LEVEL.info;
  const acts = [
    a.ref ? `<button type="button" class="linkbtn" ${traceAttrs(a.ref.id, a.ref.at, 0, '그 작업 단계 타임라인')}>단계 타임라인 →</button>` : '',
    a.agent && isStaff(a.agent) ? `<button type="button" class="linkbtn" data-agent="${esc(a.agent)}">직원 상세</button>` : '',
    a.read ? '' : `<button type="button" class="linkbtn" data-read="${esc(a.id)}">읽음</button>`,
  ].join('');
  return `<article class="alert lv-${esc(a.level)}${a.read ? '' : ' unread'}" data-alert="${esc(a.id)}">
      <div class="a-head"><span class="chip ${cls}">${lab}</span><b>${esc(a.title)}</b><time title="${esc(fmtTime(a.first))}">${fmtAgo(a.first)}</time></div>
      <div class="a-body">${esc(a.body)}</div>${acts ? `<div class="a-acts">${acts}</div>` : ''}</article>`;
}

function meterRow(label, color, used, cap, projected) {
  const p = cap ? (used / cap) * 100 : 0;
  const tick = cap && projected ? `<b class="tick" style="left:${Math.min(100, (projected / cap) * 100)}%" title="월말 예상 ${esc(fmtUsd(projected))}"></b>` : '';
  return `<div class="mrow"><span class="name"><i class="dot" style="background:${color}"></i>${esc(label)}</span>
    <span class="meter${p > 100 ? ' over' : p >= 80 ? ' near' : ''}">${cap ? `<i style="width:${Math.min(100, p)}%"></i>` : ''}${tick}</span>
    <span class="num">${fmtUsd(used)}${cap ? ` / ${fmtUsd(cap)} <small>${Math.round(p)}%</small>` : ' <small>예산 없음</small>'}</span></div>`;
}

function alertsBoxHtml() {
  const A = state.alerts || { alerts: [], unread: 0 };
  const d = state.data;
  const b = A.budget || (d && d.budget) || {};
  const sm = A.staffMonth || {};
  const on = store.get('notify', 'off') === 'on';
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  return `<section>
      <header class="wfhead"><h3>알림 <span class="faint">· 읽지 않음 ${A.unread}개</span></h3>${A.unread ? '<button type="button" class="btn" id="alerts-readall">모두 읽음</button>' : ''}</header>
      <div class="alerts">${A.unread ? A.alerts.filter((a) => !a.read).map(alertItem).join('') : '<div class="faint">새 알림이 없어요</div>'}</div>
      ${A.alerts.length > A.unread ? `<details class="unused read-alerts"><summary>읽은 알림 ${A.alerts.length - A.unread}개</summary><div class="alerts">${A.alerts.filter((a) => a.read).map(alertItem).join('')}</div></details>` : ''}
      <div class="notify-row">
        <div><b>바탕화면 알림</b><div class="faint">Control Center 창이 열려 있으면 새 알림을 Windows 알림으로도 띄워요${perm === 'denied' ? ' · 지금은 브라우저가 막아 두었어요' : ''}.</div></div>
        <button type="button" class="switch" id="notify-toggle" role="switch" aria-checked="${on && perm === 'granted'}"><i></i><span class="sr">바탕화면 알림</span></button>
      </div>
    </section>
    <section>
      <h3>이번 달 <span class="faint">· API 환산 · 막대 위 세로선은 월말 예상</span></h3>
      <div class="mrows">${meterRow('전체', 'var(--accent)', A.month ?? (d ? d.month.cost : 0), b.monthlyUsd, A.projected)}
      ${d ? d.staff.map((s) => meterRow(s.team || s.name, s.color, sm[s.name] || 0, b.staff && b.staff[s.name])).join('') : ''}</div>
    </section>`;
}

function budgetFormHtml() {
  const d = state.data;
  const b = (state.alerts && state.alerts.budget) || (d && d.budget) || {};
  const v = (x) => (x === null || x === undefined ? '' : esc(x));
  const sm = (state.alerts && state.alerts.staffMonth) || {};
  return `<section>
      <h3>예산·알림 기준 <span class="faint">· config/budget.json 에 저장 · 비우면 그 알림을 꺼요</span></h3>
      <form id="budget-form" class="bform" autocomplete="off">
        <label><span class="lab">이번 달 전체 예산</span>
          <span class="in"><span class="unit">$</span><input name="monthlyUsd" type="number" min="0" step="1" inputmode="decimal" value="${v(b.monthlyUsd)}" placeholder="예: 1000"></span>
          <small class="faint" data-krw>${b.monthlyUsd ? esc(fmtKrw(b.monthlyUsd)) : 'API로 썼다면 낼 금액 기준'}</small></label>
        <label><span class="lab">알림 단계(%)</span>
          <span class="in"><input name="warnAt" type="text" value="${v((b.warnAt || [50, 80, 100]).join(', '))}" placeholder="50, 80, 100"></span>
          <small class="faint">이 비율을 넘을 때마다 한 번씩 알려요</small></label>
        <label><span class="lab">비싼 작업 기준(한 건)</span>
          <span class="in"><span class="unit">$</span><input name="runUsd" type="number" min="0" step="0.5" inputmode="decimal" value="${v(b.runUsd)}" placeholder="예: 5"></span>
          <small class="faint">직원·기본 에이전트 작업 한 건이 넘으면</small></label>
        <label><span class="lab">갑자기 많이 쓴 날</span>
          <span class="in"><span class="unit">평소의</span><input name="dailySpike" type="number" min="1.2" step="0.1" inputmode="decimal" value="${v(b.dailySpike)}" placeholder="3"><span class="unit">배</span></span>
          <span class="in"><span class="unit">그리고 $</span><input name="dailyMinUsd" type="number" min="0" step="1" inputmode="decimal" value="${v(b.dailyMinUsd)}" placeholder="20"><span class="unit">이상</span></span></label>
        <fieldset><legend>직원별 월 예산</legend>
          ${d ? d.staff.map((s) => `<label class="srow"><span class="lab"><i class="dot" style="background:${s.color}"></i>${esc(s.team || s.name)}</span>
            <span class="in"><span class="unit">$</span><input name="staff:${esc(s.name)}" type="number" min="0" step="0.5" inputmode="decimal" value="${v(b.staff && b.staff[s.name])}" placeholder="없음"></span>
            <small class="faint">이번 달 ${fmtUsd(sm[s.name] || 0)}</small></label>`).join('') : ''}
        </fieldset>
        <div class="actions"><button type="submit" class="btn primary">저장</button><span class="faint" id="budget-msg" role="status"></span></div>
      </form>
    </section>`;
}

function showAlerts({ focus = true } = {}) {
  const dr = $('#drawer');
  dr.classList.remove('wide');
  dr.innerHTML = `${backButton()}
    <div class="dhead" style="--c:var(--accent)">
      <span class="avatar">${bellSvg}</span>
      <div class="grow"><h2 id="drawer-title">알림·예산</h2><div class="faint">예산을 넘거나, 비싼 작업·멈춘 작업·평소보다 많이 쓴 날이 생기면 알려요</div></div>
      ${closeBtn}
    </div>
    <div id="alerts-box">${alertsBoxHtml()}</div>
    ${budgetFormHtml()}`;
  openPanel(focus, 0);
}

// 알림만 바뀌면 목록·막대만 다시 그린다(쓰던 예산 칸은 그대로)
function refreshAlertsDrawer() {
  if ($('#alerts-box')) $('#alerts-box').innerHTML = alertsBoxHtml();
}

async function submitBudget(form) {
  const fd = new FormData(form);
  const body = { staff: {} };
  for (const [k, val] of fd) {
    if (k.startsWith('staff:')) { if (val !== '') body.staff[k.slice(6)] = val; } else body[k] = val;
  }
  const msg = $('#budget-msg');
  msg.textContent = '저장하는 중…';
  const r = await post('/api/budget', body);
  if (r.error) { msg.textContent = r.error; msg.classList.add('err'); return; }
  msg.classList.remove('err');
  msg.textContent = '저장했어요';
  toast('예산을 저장했어요', r.budget.monthlyUsd ? `이번 달 전체 ${fmtUsd(r.budget.monthlyUsd)}` : '전체 예산 없음', 'info', false);
  load({ silent: true });
}

// ── 스킬 DB 탭 ──
let skillSeq = 0;
async function loadSkillDb({ force = false } = {}) {
  const S = state.skilldb;
  if (!force && S && S.range === state.range && Date.now() - state.skilldbAt < 30000) { renderSkillDb(); return; }
  const seq = ++skillSeq;
  let j;
  try {
    const res = await fetch('/api/skilldb?range=' + encodeURIComponent(state.range), { cache: 'no-store' });
    j = await res.json();
  } catch (err) {
    j = { error: 'Control Center 서버에 닿지 못했어요 (' + (err.message || err) + ')', rows: [], missing: [], categories: [], counts: {} };
  }
  if (seq !== skillSeq) return;
  if (j.loading) { setTimeout(() => loadSkillDb({ force: true }), 1500); return; }
  state.skilldb = j;
  state.skilldbAt = Date.now();
  renderSkillDb();
}

const FLAG_CLS = { check: 'bad', team: 'warn', owner: '', inactive: 'warn' };
function renderSkillDb() {
  const S = state.skilldb;
  if (!S || state.view !== 'skills') return;
  const rl = RANGE_LABEL[S.range] || '';
  $('#skilldb-export').href = '/api/export/skills.xlsx?range=' + encodeURIComponent(state.range);
  $('#skilldb-export').classList.toggle('disabled', !S.rows || !S.rows.length);
  $('#skilldb-sub').innerHTML = S.error && !S.rows.length
    ? `<span class="err">${esc(S.error)}</span> · <code>config/skilldb.json</code>에서 위치를 고쳐 주세요.`
    : S.source === 'local'
    ? `<b>${esc(S.name)}</b> <span class="faint">· ${S.rows.length}개</span>${S.notice ? `<br><span class="err">${esc(S.notice)}</span>` : ''}<br>
       스킬 DB 엑셀(SkillDB 표)이 있으면 <code>config/skilldb.json</code>에 위치를 적어 주세요. 그러면 한글명·카테고리·담당 팀·점검 결과까지 함께 보여 줘요.`
    : `<b>${esc(S.name)}</b> <span class="faint">· 표 ${esc(S.table || '')} · ${S.mtime ? esc(fmtTime(S.mtime)) + ' 저장본' : ''}</span><br>
       엑셀은 읽기만 해요. 사용 기록은 이 PC의 Claude Code 기록이라 claude.ai 웹·앱에서 쓴 것은 빠져요.`;
  const c = S.counts || {};
  const calls = (S.rows || []).reduce((a, r) => a + r.calls, 0);
  $('#skilldb-kpis').innerHTML = [
    kpi('스킬 DB', `${c.skills || 0}<small>개</small>`, `운영 중 ${c.live || 0}개`),
    kpi(`쓴 스킬 · ${rl}`, `${c.used || 0}<small>개</small>`, `${c.skills ? pct(c.used, c.skills) : 0}% · 이 PC에서 한 번이라도 쓴 스킬 ${c.usedAll || 0}개`),
    kpi(`스킬 호출 · ${rl}`, `${calls.toLocaleString()}<small>회</small>`, 'DB에 있는 스킬만'),
    kpi('확인할 것', `${c.flagged || 0}<small>개</small>`, '등록본 점검·담당 팀 불일치·명부 누락'),
    kpi('DB 밖 스킬', `${c.missing || 0}<small>개</small>`, '썼거나 직원이 맡았는데 엑셀에 없음'),
  ].join('');

  const q = state.skillq.trim().toLowerCase();
  const f = state.skillfilter;
  const rows = (S.rows || []).map((r, i) => ({ ...r, i }))
    .filter((r) => (f === 'used' ? r.calls > 0 : f === 'unused' ? !r.calls : f === 'flag' ? r.flags.length : true))
    .filter((r) => !q || [r.id, r.name, r.category, r.team, r.purpose].some((x) => String(x || '').toLowerCase().includes(q)))
    .sort((a, b) => b.calls - a.calls || b.callsAll - a.callsAll || a.i - b.i);
  $('#skilldb-table').innerHTML = rows.length
    ? `<div class="rowx head"><span>스킬</span><span>카테고리</span><span>담당 팀</span><span>상태</span><span class="r">호출</span><span class="r">마지막</span><span>확인할 점</span></div>`
      + rows.map((r) => {
        const open = state.skillOpen.has(r.id);
        return `<div class="rowx click${r.live ? '' : ' off'}" role="button" tabindex="0" data-skill="${esc(r.id)}" aria-expanded="${open}">
          <span class="cell"><b>${esc(r.name || r.id)}</b><small class="mono faint">${esc(r.id)}</small></span>
          <span class="cell" title="${esc(r.category)}">${esc(r.category)}</span>
          <span class="cell">${r.owner ? `<i class="dot" style="background:${r.owner.color}"></i>` : ''}${esc(r.team || (r.owner && r.owner.team) || '—')}</span>
          <span class="cell"><span class="chip${r.live ? ' ok' : ''}">${esc(r.status || '—')}</span></span>
          <span class="cell r">${r.calls || '<span class="faint">0</span>'}${r.callsAll > r.calls ? `<small class="faint"> / ${r.callsAll}</small>` : ''}</span>
          <span class="cell r faint">${r.lastUsed ? fmtAgo(r.lastUsed) : '—'}</span>
          <span class="cell flags">${r.flags.map((x) => `<span class="chip ${FLAG_CLS[x.k] ?? ''}" title="${esc(x.t)}">${esc(x.t)}</span>`).join('')}</span>
        </div>${open ? skillDetail(r) : ''}`;
      }).join('')
    : `<div class="empty">${S.rows && S.rows.length ? '조건에 맞는 스킬이 없어요' : '스킬 DB를 읽지 못했어요'}</div>`;

  $('#skilldb-cat-sub').textContent = `쓴 스킬 / 전체 · ${rl}`;
  // 막대 길이 = 그 카테고리의 스킬 수(회색), 안의 파랑 = 그중 쓴 스킬
  const maxSk = Math.max(...(S.categories || []).map((x) => x.skills), 1);
  $('#skilldb-cats').innerHTML = (S.categories || []).length
    ? S.categories.map((x) => `<div class="barrow" title="${esc(x.category)}: 스킬 ${x.skills}개 중 ${x.used}개를 썼어요 · ${x.calls}회">
        <span class="name">${esc(x.category)}</span>
        <span class="track"><i style="width:${(x.skills / maxSk) * 100}%"><b style="width:${x.skills ? (x.used / x.skills) * 100 : 0}%"></b></i></span>
        <span class="val">${x.used}/${x.skills}<small>${x.calls}회</small></span></div>`).join('')
    : '<div class="empty">없음</div>';

  const owned = (S.missing || []).filter((m) => m.owner);
  const other = (S.missing || []).filter((m) => !m.owner);
  const mrow = (m) => `<div class="rowx"><span class="cell mono" title="${esc(m.skill)}">${esc(skillShort(m.skill))}</span><span class="cell">${esc(m.owner || '')}</span><span class="cell r">${m.calls}${m.callsAll > m.calls ? `<small class="faint"> / ${m.callsAll}</small>` : ''}</span></div>`;
  $('#skilldb-missing').innerHTML = (owned.length || other.length)
    ? `${owned.length ? `<h3 style="margin-top:0">직원이 맡았는데 DB에 없음 (${owned.length})</h3><div class="rows missing">${owned.map(mrow).join('')}</div>` : ''}
       ${other.length ? `<details class="unused"${owned.length ? '' : ' open'}><summary>이 PC에서 썼지만 DB에 없음 ${other.length}개 <span class="faint">(기본 제공 스킬 포함)</span></summary><div class="rows missing">${other.map(mrow).join('')}</div></details>` : ''}`
    : '<div class="faint">엑셀에 없는 스킬이 없어요</div>';
}

function skillDetail(r) {
  const kv = (k, val) => (val ? `<div><dt>${k}</dt><dd>${esc(val)}</dd></div>` : '');
  const callers = Object.entries(r.callers || {}).map(([k, n]) => `${k} ${n}회`).join(', ');
  return `<div class="wf-detail skill-detail">
      ${r.purpose ? `<p class="say" style="margin-top:0">${esc(r.purpose)}</p>` : ''}
      <dl class="kv">
        ${kv('버전', r.version)}${kv('최종 업데이트', r.updated)}${kv('등록 형태', r.type)}${kv('활성화', r.active)}
        ${kv('등록본 점검', r.check)}${kv('중요도', r.importance)}
        <div><dt>사용 빈도</dt><dd>${esc(r.freq || '—')} <span class="faint">(기록상 ${esc(r.freqSuggest)} · 최근 30일 ${r.calls30}회)</span></dd></div>
        ${r.owner ? `<div><dt>맡은 직원(명부)</dt><dd>${esc(r.owner.team || r.owner.name)}</dd></div>` : ''}
        ${callers ? `<div><dt>누가 불렀나</dt><dd>${esc(callers)}</dd></div>` : ''}
        ${r.tokens ? `<div><dt>추정 토큰·비용</dt><dd>${fmtTok(r.tokens)} · ${fmtUsd(r.cost)}</dd></div>` : ''}
      </dl>
      ${r.triggers ? `<p class="faint"><b>대표 트리거</b> ${esc(r.triggers)}</p>` : ''}
      ${r.links ? `<p class="faint"><b>연계 스킬</b> ${esc(r.links)}</p>` : ''}
      ${r.memo ? `<p class="faint"><b>관리 메모</b> ${esc(r.memo)}</p>` : ''}
      ${r.ideas ? `<p class="faint"><b>개선 아이디어</b> ${esc(r.ideas)}</p>` : ''}
    </div>`;
}

// ── 실시간 ──
function whoInfo(who) {
  if (!who) return { label: '', color: NEUTRAL };
  if (who.group === 'staff') {
    const s = state.data && state.data.staff.find((x) => x.name === who.key);
    return { label: s ? s.team || s.name : who.key, color: s ? s.color : NEUTRAL };
  }
  if (who.group === 'lead') return { label: '팀장', color: LEAD_COLOR };
  return { label: who.key === 'unknown' ? '알 수 없음' : who.key, color: NEUTRAL };
}
const isStaff = (type) => !!((state.live && state.live.staff && state.live.staff[type]) || (state.data && state.data.staff.some((x) => x.name === type)));
const whoOfType = (type) => whoInfo({ group: isStaff(type) ? 'staff' : 'builtin', key: type });

function feedBody(it) {
  if (it.k === 'agent') return (it.to ? whoOfType(it.to).label + ' · ' : '') + (it.a || '');
  if (it.k === 'done') return [it.a || '(설명 없음)', it.dur ? fmtDur(it.dur) : '', it.cost != null ? fmtUsd(it.cost) : ''].filter(Boolean).join(' · ');
  if (it.k === 'wait') return it.a || '승인 창이 떠 있어요';
  return it.a || '';
}

function renderFeed({ quiet = false } = {}) {
  const L = state.live;
  if (!L) return;
  const team = state.feedscope === 'team';
  const items = (team ? L.feedTeam || [] : L.feed).slice(0, 50);
  const first = quiet || state.seenFeed.size === 0;
  const today = new Date().setHours(0, 0, 0, 0);
  $('#feed').innerHTML = items.length ? items.map((it) => {
    const key = `${it.t}|${it.k}|${it.who.key}|${it.a}`;
    const fresh = !first && !state.seenFeed.has(key);
    state.seenFeed.add(key);
    const w = whoInfo(it.who);
    const body = feedBody(it);
    const cls = ['prompt', 'start', 'done', 'wait'].includes(it.k) ? it.k : '';
    // 기록 파일에서 온 활동은 누르면 그 실행의 타임라인을 연다(도구 활동이면 그 단계를 표시)
    const attrs = it.ref ? ' ' + traceAttrs(it.ref.id, it.ref.at, cls ? 0 : it.t, `${w.label} ${ACT_KIND[it.k] || ''} 단계 타임라인`) : '';
    return `<div class="item${fresh ? ' new' : ''}${it.ref ? ' click' : ''}"${attrs}>
      <span class="time" title="${esc(fmtTime(it.t))}">${it.t >= today ? fmtClockS(it.t) : fmtDay(it.t)}</span>
      <span class="who" title="${esc(w.label)}"><i class="dot" style="background:${w.color}"></i>${esc(w.label)}</span>
      <span class="what" title="${esc(body)}"><span class="kind ${cls}">${ACT_KIND[it.k] || esc(it.k)}</span><span class="${it.k === 'text' ? 'say' : ''}">${esc(body)}</span></span></div>`;
  }).join('') : `<div class="empty">${team ? '직원·팀장 활동이 아직 없어요. ‘전체’를 눌러 보세요.' : '활동 기록이 없어요'}</div>`;
}

function renderCounts() {
  const L = state.live;
  const c = L.counts;
  $('#cnt-working').textContent = `일하는 중 ${c.working}`;
  $('#cnt-working').title = `세션 ${c.sessions ?? 0} · 직원·서브에이전트 ${c.subs ?? 0}`;
  if (L.office.up) {
    $('#cnt-decision').textContent = `승인 대기 ${c.decision}`;
    $('#cnt-decision').title = '승인 대기';
    $('#cnt-rest').textContent = `쉬는 중 ${c.rest}`;
    $('#cnt-rest').hidden = false;
  } else {
    $('#cnt-decision').textContent = '승인 대기 —';
    $('#cnt-decision').title = L.office.installed ? '3D 사무실이 꺼져 있어 승인 대기는 알 수 없어요' : '승인 대기는 3D 사무실(따로 설치)이 있어야 알 수 있어요';
    $('#cnt-rest').hidden = true;
  }
  $('#cnt-decision').classList.toggle('warn', !L.office.up || c.decision > 0);
}

function personCard(p) {
  const [t, c] = OFFICE_STATUS[p.status] || [p.status, ''];
  const subs = p.subs.length ? `<div><h4>서브에이전트 ${p.subCount}</h4><div class="subs">${p.subs.map((s) => {
    const w = whoOfType(s.type);
    return `<div class="sub"><div class="line"><i class="dot" style="background:${w.color}"></i><b>${esc(w.label)}</b><span>${esc(s.desc || '')}</span></div>${s.doing ? `<div class="act">${esc(actNow(s.doing))}</div>` : ''}</div>`;
  }).join('')}</div></div>` : '';
  const log = p.log.length ? `<div><h4>최근 활동</h4><ol class="log">${[...p.log].reverse().map((x) => `<li><time>${fmtClockS(Date.parse(x.at))}</time><span>${esc(actNow(x))}</span></li>`).join('')}</ol></div>` : '';
  const doing = p.doing ? (p.status === 'rest' ? `<div class="quiet">마지막: ${esc(actNow(p.doing))}</div>` : `<div class="doing"><span>${esc(actNow(p.doing))}</span></div>`) : '';
  return `<article class="person s-${esc(p.status)}">
    <header><i class="dot" style="background:${p.lead ? LEAD_COLOR : NEUTRAL}"></i><h3 title="${esc(p.path)}">${esc(p.name)}</h3>${p.lead ? '<span class="chip">팀장</span>' : ''}<span class="chip ${c}">${t}${p.pending > 1 ? ' ' + p.pending : ''}</span></header>
    ${p.status === 'decision' && p.ask ? `<div class="ask">${esc(p.ask)}</div>` : ''}
    ${doing}${subs}${log}
    <footer>세션 ${p.sessions}개 · ${p.source === 'hook' ? '훅으로 감지' : '대화 기록으로 감지'}</footer></article>`;
}

function fallbackBoard(L) {
  const rows = [
    ...Object.entries(L.staff).filter(([, s]) => s.state === 'working').map(([k, s]) => ({ w: whoInfo({ group: 'staff', key: k }), s })),
    ...L.builtin.map((b) => ({ w: whoInfo({ group: 'builtin', key: b.key }), s: b })),
  ];
  if (L.lead.state === 'working') rows.unshift({ w: whoInfo({ group: 'lead' }), s: { desc: '팀장 세션이 방금 움직였어요' } });
  return rows.length ? `<div class="people">${rows.map((r) => `<article class="person s-working">
      <header><i class="dot" style="background:${r.w.color}"></i><h3>${esc(r.w.label)}</h3><span class="chip ok live">일하는 중</span></header>
      ${r.s.desc ? `<div class="muted">${esc(r.s.desc)}</div>` : ''}${r.s.doing ? `<div class="doing"><span>${esc(actNow(r.s.doing))}</span></div>` : ''}</article>`).join('')}</div>`
    : '<div class="notice">지금 일하는 직원이 없어요.</div>';
}

// 「3D로 보기」 단추: 켜져 있으면 3D 화면, 설치만 했으면 숨김, 설치 안 했으면 설치 안내(원 저장소)로
function officeButton(o) {
  const a = $('#office-open');
  const install = !o.up && !o.installed && !!o.repo;
  a.hidden = !o.up && !install;
  a.href = install ? o.repo : o.url;
  a.classList.toggle('primary', o.up);
  a.firstChild.textContent = install ? '3D 사무실 설치 안내 ' : '3D로 보기 ';
  a.title = install ? '다른 개발자가 만든 무료 오픈소스(MIT) 저장소로 가요' : '3D 사무실을 새 창으로 열어요';
}

function renderOffice() {
  const L = state.live;
  if (!L) return;
  officeButton(L.office);
  if (!L.office.up && L.office.installed) {
    $('#office-sub').textContent = '3D 사무실 서버가 꺼져 있어요. 아래는 대화 기록만으로 본 상태예요.';
    $('#office-body').innerHTML = `<div class="notice"><b>3D 사무실</b> — 설치되어 있지만 꺼져 있어요. Claude Code 세션을 새로 시작하면 저절로 켜지고,
      직접 켜려면 그 폴더에서 <code>node scripts/start.mjs</code>를 실행하세요. 없어도 관제판은 대화 기록만으로 돌아가요.</div>${fallbackBoard(L)}`;
    return;
  }
  if (!L.office.up) {
    $('#office-sub').textContent = '대화 기록만으로 본 상태예요. 3D 사무실을 따로 설치하면 세션별 3D 화면과 승인 대기도 보여요.';
    $('#office-body').innerHTML = `<div class="notice"><b>3D 사무실(선택)</b> — 다른 개발자가 만든 무료 오픈소스 도구(<code>claude-3d-frog-office</code>, MIT)예요. 이 관제판에 들어 있지 않아 따로 설치해요.
      설치하면 프로젝트(세션)마다 3D 사무실 화면과 <b>승인 대기</b> 감지가 더해져요. 설치할 때 Claude Code 설정(<code>settings.json</code>)에 훅을 넣으니, 위 「3D 사무실 설치 안내」에서 그 저장소의 설명을 읽고 정하세요.
      설치하지 않아도 관제판의 다른 기능은 모두 그대로 돌아가요.</div>${fallbackBoard(L)}`;
    return;
  }
  $('#office-sub').textContent = `열린 프로젝트 ${L.people.length}개 · ${L.office.hooks ? '훅 연결됨' : '훅 없음(승인 대기는 감지 안 됨)'} · 3D 화면은 사무실 서버가 다른 페이지 안에 넣는 것을 막아 두어 새 창으로 열어요.`;
  const rank = { decision: 0, working: 1, rest: 2 };
  const people = [...L.people].sort((a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3) || Number(b.lead) - Number(a.lead));
  $('#office-body').innerHTML = people.length ? `<div class="people">${people.map(personCard).join('')}</div>`
    : '<div class="notice">지금 열린 Claude 세션이 없어요.</div>';
}

let liveSig = '';
function renderLive() {
  const L = state.live;
  renderCounts();
  renderFeed();
  if (state.view === 'office') renderOffice();
  // 상태가 바뀐 때만 카드를 다시 그린다(마우스 올림·포커스가 튀지 않게)
  const sig = JSON.stringify([L.staff, L.lead.state, L.lead.doing, L.lead.ask]);
  if (sig !== liveSig && state.data) {
    liveSig = sig;
    renderRoster(state.data);
    renderOthers(state.data);
    if (state.view === 'flow') renderFlowMap(state.data);
  }
  const ta = topAgent();
  if (ta && state.data && $('#drawer-live')) {
    const s = ta === '__lead' ? leadAsAgent(state.data) : state.data.staff.find((x) => x.name === ta);
    if (s) $('#drawer-live').innerHTML = drawerLive(s);
  }
}

let reloadTimer = null;
function scheduleReload() {
  if (reloadTimer || !state.data) return;
  const wait = Math.max(0, 10000 - (Date.now() - lastLoadAt)); // 요약은 10초에 한 번까지만
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    if (!document.hidden) load({ silent: true });
  }, wait);
}

function connect() {
  const es = new EventSource('/api/stream');
  const badge = $('#live-badge');
  es.addEventListener('open', () => {
    state.streamOk = true;
    badge.classList.remove('off');
    badge.innerHTML = '<i></i>LIVE';
  });
  es.addEventListener('error', () => {
    state.streamOk = false;
    badge.classList.add('off');
    badge.innerHTML = '<i></i>다시 연결 중';
  });
  es.addEventListener('live', (e) => {
    try { state.live = JSON.parse(e.data); } catch { return; }
    renderLive();
  });
  es.addEventListener('changed', () => { scheduleReload(); refreshTrace(); });
  es.addEventListener('alerts', (e) => { try { onAlerts(JSON.parse(e.data)); } catch { /* 깨진 메시지는 버린다 */ } });
}

function setView(v) {
  state.view = v;
  setPressed('#view', v);
  $('#view-board').hidden = v !== 'board';
  $('#view-flow').hidden = v !== 'flow';
  $('#view-skills').hidden = v !== 'skills';
  $('#view-office').hidden = v !== 'office';
  $('#range').hidden = v === 'office';
  $('#updated').hidden = v === 'office';
  history.replaceState(null, '', v === 'board' ? location.pathname + location.search : '#' + v);
  if (v === 'board' && state.data) renderChart(state.data);
  if (v === 'flow' && state.data) renderFlowView(state.data);
  if (v === 'office') renderOffice();
  if (v === 'skills') loadSkillDb();
}

// ── 조작 ──
function setPressed(groupSel, value) {
  for (const b of document.querySelectorAll(groupSel + ' button')) b.setAttribute('aria-pressed', String(b.dataset.v === value));
}

function bindSeg(sel, key, after) {
  setPressed(sel, state[key]);
  $(sel).addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b || state[key] === b.dataset.v) return;
    state[key] = b.dataset.v;
    store.set(key, state[key]);
    setPressed(sel, state[key]);
    after();
  });
}

function effectiveTheme() {
  return document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}
function paintThemeButton() {
  const dark = effectiveTheme() === 'dark';
  $('#theme').innerHTML = dark
    ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
    : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/></svg>';
}

bindSeg('#range', 'range', () => load());
bindSeg('#metric', 'metric', () => state.data && renderChart(state.data));
bindSeg('#split', 'split', () => state.data && renderChart(state.data));
bindSeg('#feedscope', 'feedscope', () => renderFeed({ quiet: true }));
bindSeg('#runfilter', 'runfilter', () => state.data && renderTraceList(state.data));
bindSeg('#skillfilter', 'skillfilter', () => renderSkillDb());
document.addEventListener('input', (e) => {
  if (e.target.id === 'skillq') { state.skillq = e.target.value; renderSkillDb(); return; }
  if (e.target.name === 'monthlyUsd' && e.target.form && e.target.form.id === 'budget-form') {
    const v = Number(e.target.value);
    e.target.form.querySelector('[data-krw]').textContent = v > 0 ? fmtKrw(v) : 'API로 썼다면 낼 금액 기준';
  }
});
document.addEventListener('submit', (e) => {
  if (e.target.id !== 'budget-form') return;
  e.preventDefault();
  submitBudget(e.target);
});
$('#view').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-v]');
  if (b && b.dataset.v !== state.view) setView(b.dataset.v);
});
addEventListener('hashchange', () => setView(viewOfHash()));
setView(state.view);
$('#refresh').addEventListener('click', () => load());
$('#theme').addEventListener('click', () => {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  store.set('theme', next);
  paintThemeButton();
});
paintThemeButton();

$('#chart').addEventListener('mousemove', (e) => {
  const hit = e.target.closest('.hit');
  if (hit) showTip(e, Number(hit.dataset.i)); else $('#tip').hidden = true;
});
$('#chart').addEventListener('mouseleave', () => { $('#tip').hidden = true; });

// 누를 수 있는 것: 트레이스 줄([data-tid]) · 직원 카드([data-agent]) · 트레이스 단계(.wf-row) · 서랍 단추
function activate(el) {
  if (el.matches('[data-tid]')) {
    if ($('#drawer').hidden) state.lastFocus = el;
    if (el.dataset.treplace && topOf() && topOf().type === 'trace') state.stack.pop();
    openTrace({ id: el.dataset.tid, at: Number(el.dataset.tat) || 0, hl: Number(el.dataset.thl) || 0 });
    return;
  }
  if (el.matches('[data-agent]')) { if ($('#drawer').hidden) state.lastFocus = el; openDrawer(el.dataset.agent); return; }
  if (el.matches('.wf-row')) { toggleStep(el); return; }
  if (el.matches('[data-open-alerts]')) { if (el.classList.contains('toast')) el.remove(); openAlerts(); return; }
  if (el.matches('[data-skill]')) {
    const id = el.dataset.skill;
    if (state.skillOpen.has(id)) state.skillOpen.delete(id); else state.skillOpen.add(id);
    renderSkillDb();
    const again = $(`#skilldb-table [data-skill="${CSS.escape(id)}"]`);
    if (again) again.focus({ preventScroll: true });
  }
}
const ACTIVE = '[data-tid], [data-agent], .wf-row, [data-open-alerts], [data-skill]';
document.addEventListener('click', (e) => {
  if (e.target.closest('#drawer .close') || e.target === $('#scrim')) { closeDrawer(); return; }
  if (e.target.closest('#drawer .back')) { goBack(); return; }
  if (e.target.closest('#bell')) { openAlerts(); return; }
  if (e.target.closest('#advice-more')) { state.adviceAll = !state.adviceAll; renderAdvice(state.data); return; }
  const gv = e.target.closest('[data-goview]');
  if (gv) {
    // 제언의 바로 가기: 그 탭으로(관제판이면 직원 카드로) 옮긴다
    setView(gv.dataset.goview);
    if (gv.dataset.goview === 'board') $('#roster').scrollIntoView({ behavior: 'smooth', block: 'start' });
    else scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  if (e.target.closest('#report-btn')) {
    // 지금 보고 있는 기간으로 A4 리포트를 새 창에 연다(그 창에서 인쇄·PDF 저장)
    window.open('/report?range=' + encodeURIComponent(state.range), 'amc-report', 'width=980,height=1100');
    return;
  }
  const rd = e.target.closest('[data-read]');
  if (rd) { markAlertsRead([rd.dataset.read]); return; }
  if (e.target.closest('#alerts-readall')) { markAlertsRead('all'); return; }
  if (e.target.closest('#notify-toggle')) { toggleNotify(); return; }
  const al = e.target.closest('[data-alert]'); // 알림 안의 단추를 누르면 그 알림은 읽은 것으로
  if (al && al.classList.contains('unread') && e.target.closest('button')) markAlertsRead([al.dataset.alert]);
  const sort = e.target.closest('#tsort button[data-v]');
  if (sort) { state.traceSort = sort.dataset.v; const t = topOf(); if (t && state.trace) $('#drawer').innerHTML = traceHtml(state.trace, t); return; }
  const j = e.target.closest('[data-jump]');
  if (j) { jumpToStep(j.dataset.jump); return; }
  if (e.target.closest('.wf-detail')) { const b = e.target.closest('[data-tid]'); if (b) activate(b); return; }
  const el = e.target.closest(ACTIVE);
  if (el) activate(el);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#drawer').hidden) { closeDrawer(); return; }
  const el = e.target.closest && e.target.closest(ACTIVE);
  if (el && el === e.target && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    activate(el);
  }
});

let resizeTimer;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!state.data) return;
    renderChart(state.data);
    if (state.view === 'flow') renderFlowMap(state.data);
    const t = topOf();
    if (t && t.type === 'trace' && state.trace && !$('#drawer').hidden) {
      const keep = $('#drawer').scrollTop;
      $('#drawer').innerHTML = traceHtml(state.trace, t);
      $('#drawer').scrollTop = keep;
    }
  }, 120);
});
// 실시간 연결이 끊겼을 때만 1분마다 요약을 다시 받는다
setInterval(() => { if (!document.hidden && state.data && !state.streamOk) load({ silent: true }); }, 60000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.data && Date.now() - lastLoadAt > 10000) load({ silent: true });
});

load();
connect();
