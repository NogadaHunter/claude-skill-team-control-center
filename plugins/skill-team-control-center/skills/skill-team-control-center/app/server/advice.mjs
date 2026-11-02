// 운영 제언. 집계(summarize)·알림·스킬 DB 짝짓기·기록을 보고 "그래서 무엇을 하면 좋은가"를 규칙으로 뽑는다.
// 제언 하나 = 우선순위·영역·제목(할 일) + 근거(숫자) + 실행(구체적인 할 일) + 기대 효과 + 화면 바로 가기.
// 글은 리포트에도 그대로 들어가므로 개조식(명사형·짧은 지시)으로 쓴다.
import { EV } from './collect.mjs';
import { evCost, folderName, isProject, priceTable } from './aggregate.mjs';
import { dur, pct, prettyModel, shortSkill, usd } from './fmt.mjs';

const DAY = 86400000;
const LIGHT_MODEL = 'claude-sonnet-5-5'; // 가벼운 일을 옮길 모델
const HEAVY = /opus|fable/i;
const RANK = { high: 0, mid: 1, low: 2 };
const ROLE_WORDS = new Set(['manager', 'creator', 'editor', 'planner', 'author', 'analyst']);

// 일 설명에서 맞는 직원 찾기: 영문 이름 낱말(video, report…)이나 팀 이름 앞 두 글자(영상, 보고…)가 들어 있으면
function matchStaff(text, staff) {
  const t = String(text || '').toLowerCase();
  for (const s of staff) {
    const words = s.name.split('-').filter((w) => w.length >= 4 && !ROLE_WORDS.has(w));
    const stem = String(s.team || '').replace(/팀$/, '').slice(0, 2);
    if (words.some((w) => t.includes(w)) || (stem.length === 2 && t.includes(stem))) return s;
  }
  return null;
}

// 무거운 모델(Opus·Fable)로 쓴 응답을 가벼운 모델 단가로 다시 셈: { now, alt }
function reprice(cache, pricing, from, keep) {
  const target = pricing.models && pricing.models[LIGHT_MODEL];
  if (!target) return null;
  let now = 0;
  let alt = 0;
  for (const st of Object.values(cache.files)) {
    if (!keep(st)) continue;
    const prices = priceTable(pricing, st.models);
    for (const e of st.events) {
      if (e[EV.TS] < from) continue;
      const c = evCost(e, prices[e[EV.MODEL]].p);
      now += c;
      alt += HEAVY.test(st.models[e[EV.MODEL]] || '') ? evCost(e, target) : c;
    }
  }
  return { now, alt };
}

// 팀장 밖 세션 중 이 기간 비용이 큰 것: 제목(세션 이름·첫 요청)으로 무슨 일이었는지 보여 준다
function topSessions(cache, pricing, from, leadProject, n = 3) {
  const rows = [];
  for (const st of Object.values(cache.files)) {
    if (st.kind !== 'main' || isProject(st, leadProject)) continue;
    const prices = priceTable(pricing, st.models);
    let c = 0;
    for (const e of st.events) if (e[EV.TS] >= from) c += evCost(e, prices[e[EV.MODEL]].p);
    if (c > 0) rows.push({ title: st.title || (st.turns && st.turns[0] && st.turns[0][2]) || folderName(st), cost: c });
  }
  return rows.sort((a, b) => b.cost - a.cost).slice(0, n);
}

const list = (arr, n = 3) => arr.slice(0, n).join(', ') + (arr.length > n ? ` 외 ${arr.length - n}` : '');
const quote = (s, n = 34) => { const a = Array.from(String(s || '')); return '「' + (a.length > n ? a.slice(0, n - 1).join('') + '…' : a.join('')) + '」'; };

/**
 * d: summarize 결과(month.budget·budget 이 채워진 것), alerts: 알림, db: 스킬 DB 짝짓기 결과(없거나 error 일 수 있음)
 * → [{ id, level: high|mid|low, area, title, evidence, actions: [], effect, impact(달러), links: [{ label, k, … }] }]
 */
export function advise({ d, db, cache, pricing, staff, profiles = {}, now = Date.now() }) {
  const out = [];
  const add = (a) => out.push({ impact: 0, links: [], ...a });
  const g = Object.fromEntries(d.groups.map((x) => [x.key, x]));
  const total = d.kpi.cost;
  const team = (name) => { const s = staff.find((x) => x.name === name) || d.staff.find((x) => x.name === name); return s ? s.team || s.name : name; };
  const runs = d.runs.filter((r) => r.start >= d.from);
  const staffRuns = runs.filter((r) => r.group === 'staff');
  const days = d.unit === 'day' ? d.buckets.length : 1;

  // ── 예산 ──
  const m = d.month;
  const t0 = new Date(now);
  const monthFrom = new Date(t0.getFullYear(), t0.getMonth(), 1).getTime();
  const daysInMonth = new Date(t0.getFullYear(), t0.getMonth() + 1, 0).getDate();
  const elapsed = Math.max(0.5, (now - monthFrom) / DAY);
  const left = Math.max(0.5, daysInMonth - elapsed);
  if (m.budget && (m.cost > m.budget || (m.projected != null && m.projected > m.budget))) {
    const over = m.cost > m.budget;
    const allowed = Math.max(0, (m.budget - m.cost) / left);
    add({
      id: 'budget-forecast', level: 'high', area: '예산', impact: (m.projected || m.cost) - m.budget,
      title: over ? '이번 달 예산 이미 초과 — 남은 기간 사용 줄이기 또는 예산 다시 정하기' : `월말 예산 초과 막기 — 남은 ${Math.ceil(left)}일 하루 ${usd(allowed)} 이하로`,
      evidence: `이번 달 ${usd(m.cost)}(예산 ${usd(m.budget)}의 ${pct(m.cost, m.budget)}%) · 하루 평균 ${usd(m.cost / elapsed)}${m.projected != null ? ` → 이대로면 월말 ${usd(m.projected)}(예산의 ${pct(m.projected, m.budget)}%)` : ''}`,
      actions: [
        '비용이 큰 곳(그 밖의 세션·기본 에이전트)부터 줄이기 — 아래 비용·운영 제언 참고',
        '예산이 실제 쓰임과 너무 다르면 🔔 알림·예산에서 월 예산을 현실에 맞게 다시 정하기',
        '직원별 예산을 정해 두면 누가 얼마나 쓰는지 바로 알림',
      ],
      effect: over ? '남은 기간 추가 지출 억제' : `월말 예상보다 최대 ${usd((m.projected || 0) - m.budget)} 덜 쓰기`,
      links: [{ label: '알림·예산 열기', k: 'alerts' }],
    });
  } else if (!m.budget) {
    const perDay = m.cost / elapsed;
    add({
      id: 'budget-unset', level: 'mid', area: '예산', impact: 0,
      title: '월 예산 정하기 — 넘기 전에 알림 받기',
      evidence: `이번 달 ${usd(m.cost)} · 하루 평균 ${usd(perDay)}${m.projected != null ? ` · 월말 예상 ${usd(m.projected)}` : ''} · 지금은 예산 알림이 꺼져 있음`,
      actions: [`🔔 알림·예산에서 월 예산 입력(참고: 지금 속도면 한 달 약 ${usd(perDay * daysInMonth)})`, '비용이 큰 직원부터 직원별 예산 정하기'],
      effect: '예산의 50·80·100%와 월말 초과 예상을 미리 알림',
      links: [{ label: '알림·예산 열기', k: 'alerts' }],
    });
  }

  // ── 멈춘 직원 작업 ──
  const stopped = staffRuns.filter((r) => r.status === 'stopped');
  if (stopped.length) {
    add({
      id: 'stopped', level: 'high', area: '운영', impact: stopped.reduce((a, r) => a + r.cost, 0),
      title: `멈춘 직원 작업 ${stopped.length}건 마무리하기`,
      evidence: stopped.slice(0, 3).map((r) => `${team(r.agent)} ${quote(r.description)} ${dur(r.durationMs)} · ${usd(r.cost)}`).join(' / '),
      actions: ['단계 타임라인의 마지막 단계에서 멈춘 까닭 확인(승인 대기·오류·끊김)', '결과가 없으면 같은 지시로 다시 맡기거나 범위를 줄여 맡기기'],
      effect: '쓴 비용이 결과 없이 버려지는 일 줄이기',
      links: [{ label: '타임라인 보기', k: 'trace', id: stopped[0].id }],
    });
  }

  // ── 모델: 무거운 모델로 한 가벼운 일 ──
  // 직원 md 에 model 을 적어 두었으면 사용자가 정한 것으로 보고 다시 바꾸라고 하지 않는다(직접 여는 세션만 권한다)
  const staffNames = new Set(staff.map((s) => s.name));
  const explicit = staff.filter((s) => s.model && s.model !== 'inherit');
  const lightStaff = new Set(explicit.filter((s) => !HEAVY.test(s.model)).map((s) => s.name));
  const allRe = reprice(cache, pricing, d.from, () => true);
  const staffRe = reprice(cache, pricing, d.from, (st) => st.kind === 'sub' && st.meta && staffNames.has(st.meta.agentType) && !lightStaff.has(st.meta.agentType));
  const heavyCost = d.models.filter((x) => HEAVY.test(x.model)).reduce((a, x) => a + x.cost, 0);
  if (allRe && allRe.now - allRe.alt > Math.max(1, total * 0.05) && explicit.length) {
    const who = (x) => x.team || x.name;
    const light = explicit.filter((x) => lightStaff.has(x.name)).map(who);
    const pinned = explicit.filter((x) => !lightStaff.has(x.name));
    const kept = staff.filter((x) => !x.model || x.model === 'inherit').map(who);
    const pinnedText = pinned.length
      ? `${pinned.length === staff.length ? '직원 모두' : list(pinned.map(who))} ${[...new Set(pinned.map((x) => prettyModel(x.model)))].join('·')}로 정해 둠` : '';
    add({
      id: 'model-light', level: 'mid', area: '비용', impact: allRe.now - allRe.alt,
      title: `직접 여는 세션도 가벼운 일은 ${prettyModel(LIGHT_MODEL)}로`,
      evidence: [
        light.length ? `직원 ${light.length}명은 이미 가벼운 모델(${list(light, 5)})` : '',
        pinnedText,
        kept.length ? `${list(kept)}은 세션 모델 유지` : '',
        `그 밖의 세션까지 ${prettyModel(LIGHT_MODEL)}로 돌렸다면 이 기간 ${usd(allRe.now)} → ${usd(allRe.alt)}(추정)`,
      ].filter(Boolean).join(' · '),
      actions: [
        '직접 여는 세션도 정리·변환·확인처럼 간단한 일이면 /model sonnet 으로 바꿔 쓰기',
        ...(light.length ? ['바꾼 직원의 결과물을 1주일 비교 — 아쉬우면 그 직원 md 의 model 줄만 지우면 원래대로'] : []),
        ...(pinned.length ? ['직원 모델은 정해 둔 대로 유지 — 가벼운 일만 맡을 직원을 따로 만들면 그 직원만 Sonnet 으로'] : []),
        ...(kept.length ? [`${list(kept)}은 품질을 위해 지금 모델 유지`] : []),
      ],
      effect: `이 기간 기준 최대 ${usd(allRe.now - allRe.alt)} 절감(추정, 모든 응답을 옮겼을 때)`,
      links: [{ label: '직원 보기', k: 'view', v: 'board' }],
    });
  } else if (allRe && allRe.now - allRe.alt > Math.max(1, total * 0.05)) {
    const quick = d.staff.filter((s) => !lightStaff.has(s.name) && s.recentRuns.some((r) => r.start >= d.from))
      .map((s) => ({ s, avg: s.recentRuns.filter((r) => r.start >= d.from).reduce((a, r) => a + r.durationMs, 0) / Math.max(1, s.recentRuns.filter((r) => r.start >= d.from).length) }))
      .filter((x) => x.avg < 3 * 60000).map((x) => x.s.team || x.s.name);
    add({
      id: 'model-light', level: 'mid', area: '비용', impact: allRe.now - allRe.alt,
      title: `가벼운 일은 ${prettyModel(LIGHT_MODEL)}로 — 같은 일을 더 싸게`,
      evidence: `이 기간 비용의 ${pct(heavyCost, total)}%가 Opus·Fable 응답 · 직원 작업을 ${prettyModel(LIGHT_MODEL)}로 돌렸다면 ${usd(staffRe.now)} → ${usd(staffRe.alt)}, 전체는 ${usd(allRe.now)} → ${usd(allRe.alt)}(추정)`,
      actions: [
        quick.length ? `짧은 일이 많은 직원(${list(quick)})의 ~/.claude/agents/<이름>.md 머리에 model: sonnet 넣기` : '점검·정리·변환처럼 판단이 적은 일을 하는 직원의 md 머리에 model: sonnet 넣기',
        '직접 여는 세션도 간단한 일이면 /model sonnet 으로 바꿔 쓰기',
        '집필·기획처럼 품질이 중요한 일은 지금 모델 유지 — 바꾼 뒤 1주일 결과를 비교',
      ],
      effect: `이 기간 기준 최대 ${usd(allRe.now - allRe.alt)} 절감(추정, 모든 응답을 옮겼을 때)`,
      links: [{ label: '직원 보기', k: 'view', v: 'board' }],
    });
  }

  // ── 직접 작업이 대부분: 직원·팀장 활용 ──
  const otherShare = pct(g.other.cost, total);
  const staffShare = pct(g.staff.cost, total);
  if (total > 1 && otherShare >= 60 && staffShare < 20) {
    const top = topSessions(cache, pricing, d.from, (profiles.lead && profiles.lead.project) || 'skill-team');
    // 비용 큰 세션 제목에 맞는 직원이 있으면 그 직원을 콕 집어 말한다
    const fitAction = (rows) => {
      for (const o of rows) {
        const fit = matchStaff(o.title, staff);
        if (fit) return `${quote(o.title, 22)} 같은 일은 ${fit.team || fit.name}(${fit.name})에게 — 팀장 세션에서 '${fit.team || fit.name}에게 맡겨'로 요청`;
      }
      return rows.length ? `${quote(rows[0].title, 22)}처럼 되풀이되는 일은 맡을 직원을 정해 팀장 세션에서 'OO팀에게 맡겨'로 요청` : '되풀이되는 일은 맡을 직원을 정해 팀장 세션에서 요청';
    };
    const f = d.flow || { leadPrompts: 0, otherPrompts: 0 };
    add({
      id: 'delegate', level: 'mid', area: '운영', impact: g.other.cost * 0.1,
      title: '반복되는 직접 작업을 직원에게 넘기기',
      evidence: `비용의 ${otherShare}%(${usd(g.other.cost)})가 팀장·직원 밖 세션 · 직원 몫 ${staffShare}% · 팀장 요청 ${f.leadPrompts}회 / 직접 요청 ${f.otherPrompts.toLocaleString()}회${top.length ? ` · 비용 큰 세션: ${top.map((o) => `${quote(o.title, 22)} ${usd(o.cost)}`).join(', ')}` : ''}`,
      actions: [
        fitAction(top),
        '여러 단계가 필요한 일은 팀장에게 보내 직원 분배·결과 취합까지 맡기기',
        '맞는 직원이 없으면 그 일을 맡을 새 직원(~/.claude/agents)을 만들기',
      ],
      effect: '일과 비용이 직원 단위로 보이고, 같은 일을 스킬로 표준화',
      links: [{ label: '워크플로 보기', k: 'view', v: 'flow' }],
    });
  }

  // ── 기본 에이전트가 한 일을 직원에게 ──
  const builtin = runs.filter((r) => r.group === 'builtin');
  if (builtin.length >= 3 && builtin.reduce((a, r) => a + r.cost, 0) >= 5) {
    const byType = {};
    for (const r of builtin) (byType[r.agent] ||= []).push(r);
    const [type, rs] = Object.entries(byType).sort((a, b) => b[1].reduce((x, r) => x + r.cost, 0) - a[1].reduce((x, r) => x + r.cost, 0))[0];
    const cost = rs.reduce((a, r) => a + r.cost, 0);
    const top = [...rs].sort((a, b) => b.cost - a.cost);
    const fit = top.map((r) => matchStaff(r.description, staff)).find(Boolean);
    add({
      id: 'builtin-to-staff', level: 'mid', area: '운영', impact: cost * 0.2,
      title: `기본 에이전트(${type}) 일 ${rs.length}건을 직원에게 맡기기`,
      evidence: `${type} ${rs.length}건 · ${usd(cost)} · 예: ${top.slice(0, 2).map((r) => quote(r.description, 30) + ' ' + usd(r.cost)).join(', ')}`,
      actions: [
        fit ? `${quote(top.find((r) => matchStaff(r.description, staff) === fit).description, 30)} 같은 일은 ${fit.team || fit.name}(${fit.name})에게 — Agent 호출 때 subagent_type: ${fit.name}` : '이 일들을 맡을 새 직원을 만들어 목적·맡은 스킬을 정하기',
        '직원으로 맡기면 Control Center에서 작업·비용·작업 패턴이 직원 단위로 쌓임',
      ],
      effect: '같은 종류의 일을 같은 직원이 같은 방식으로 처리',
      links: [{ label: '가장 비싼 작업 타임라인', k: 'trace', id: top[0].id }],
    });
  }

  // ── 오래 걸리는 작업 쪼개기 ──
  const long = runs.filter((r) => r.durationMs > 60 * 60000).sort((a, b) => b.durationMs - a.durationMs);
  if (long.length) {
    add({
      id: 'long-runs', level: 'mid', area: '운영', impact: long.reduce((a, r) => a + r.cost, 0) * 0.15,
      title: `1시간 넘는 작업 ${long.length}건 — 단계로 쪼개 맡기기`,
      evidence: `합계 ${usd(long.reduce((a, r) => a + r.cost, 0))} · 가장 긴 것 ${quote(long[0].description)} ${dur(long[0].durationMs)} · ${usd(long[0].cost)}`,
      actions: [
        '큰 일은 기획 → 초안 → 검토처럼 단계로 나눠 따로 맡기고 단계마다 결과 확인',
        '지시에 \'완료 기준\'과 \'중간 보고 시점\'을 넣기',
        '단계 타임라인의 \'오래 걸린 순\'으로 시간을 잡아먹는 단계(명령·응답) 찾기',
      ],
      effect: '중간에 틀어져도 다시 하는 범위·비용이 줄어듦',
      links: [{ label: '가장 긴 작업 타임라인', k: 'trace', id: long[0].id }],
    });
  }

  // ── 직원에게 실제 업무를 ──
  const short = staffRuns.filter((r) => r.durationMs < 60000);
  const idle = d.staff.filter((s) => !s.runs);
  if (staffRuns.length >= 5 && short.length / staffRuns.length >= 0.6) {
    const sample = d.staff.filter((s) => s.purpose).slice(0, 3);
    add({
      id: 'real-work', level: 'low', area: '운영', impact: 0,
      title: '직원에게 실제 업무 맡기기',
      evidence: `직원 작업 ${staffRuns.length}건 중 ${short.length}건이 1분 안에 끝난 짧은 작업(예: ${quote(short[0].description, 16)})`,
      actions: [
        ...sample.map((s) => `${s.team || s.name}에 맡길 일 — ${s.purpose}`),
        '매주 고정 업무를 하나씩 정해 두기(예: 월요일 주간 실적 요약은 보고서팀)',
      ],
      effect: '직원별 작업 패턴·비용 데이터가 쌓여 다음 제언이 더 정확해짐',
      links: [{ label: '워크플로 보기', k: 'view', v: 'flow' }],
    });
  } else if (idle.length && days >= 7) {
    add({
      id: 'idle-staff', level: 'low', area: '운영', impact: 0,
      title: `쉬는 직원 ${idle.length}명 활용하기`,
      evidence: `이 기간 작업 없음: ${list(idle.map((s) => s.team || s.name), 4)}`,
      actions: [...idle.slice(0, 3).map((s) => `${s.team || s.name}에게 맡길 일: ${s.purpose || s.description}`), '한 달 넘게 일이 없으면 다른 직원과 합치기 검토'],
      effect: '만들어 둔 직원·스킬을 실제로 쓰기',
      links: idle[0] ? [{ label: '직원 상세', k: 'agent', name: idle[0].name }] : [],
    });
  }

  // ── 스킬: 등록본 정비 ──
  if (db && !db.error && db.rows) {
    const checks = db.rows.filter((r) => r.flags.some((x) => x.k === 'check'));
    if (checks.length) {
      const kinds = {};
      for (const r of checks) for (const x of r.flags.filter((y) => y.k === 'check')) (kinds[x.t] ||= []).push(r.id);
      add({
        id: 'skill-fix', level: 'mid', area: '스킬', impact: 0,
        title: `스킬 등록본 ${checks.length}개 정비하기`,
        evidence: Object.entries(kinds).map(([k, ids]) => `${k} ${ids.length}개`).join(' · ') + ` (스킬 DB ${db.counts.skills}개 중)`,
        actions: [
          ...Object.entries(kinds).slice(0, 3).map(([k, ids]) => `${k}: ${list(ids)}`),
          '고친 뒤 스킬 DB 엑셀의 \'등록본 점검\'을 \'정상\'으로 바꾸기',
        ],
        effect: '스킬이 빠진 파일 없이 끝까지 돌아가 결과물 품질이 고름',
        links: [{ label: '스킬 DB 보기', k: 'view', v: 'skills' }],
      });
    }
    const outside = (db.missing || []).filter((x) => x.callsAll >= 3);
    const ownedOutside = (db.missing || []).filter((x) => x.owner);
    if (outside.length || ownedOutside.length >= 3) {
      add({
        id: 'skill-db-add', level: 'low', area: '스킬', impact: 0,
        title: '자주 쓰거나 직원이 맡은 스킬을 스킬 DB에 올리기',
        evidence: [outside.length ? `DB 밖인데 자주 씀: ${list(outside.map((x) => `${shortSkill(x.skill)} ${x.callsAll}회`))}` : '',
          ownedOutside.length ? `직원이 맡았는데 DB에 없음 ${ownedOutside.length}개(${list(ownedOutside.map((x) => shortSkill(x.skill)))})` : ''].filter(Boolean).join(' · '),
        actions: ['스킬 DB 엑셀 스킬목록에 행 추가(담당 팀·주요 용도)', '기본 제공 스킬(docx·pdf 등)은 \'외부\' 카테고리로 따로 묶기'],
        effect: '스킬 현황을 한 곳에서 관리',
        links: [{ label: '스킬 DB 보기', k: 'view', v: 'skills' }],
      });
    }
  }

  // ── 스킬: 안 쓰는 직원 스킬 ──
  const assigned = d.staff.reduce((a, s) => a + s.skills.length, 0);
  if (d.unusedSkills.length >= 10) {
    const byOwner = {};
    for (const u of d.unusedSkills) byOwner[u.owner] = (byOwner[u.owner] || 0) + 1;
    const [worst, n] = Object.entries(byOwner).sort((a, b) => b[1] - a[1])[0];
    add({
      id: 'unused-skills', level: 'low', area: '스킬', impact: 0,
      title: `안 쓰는 직원 스킬 ${d.unusedSkills.length}개 살리거나 정리하기`,
      evidence: `직원이 맡은 스킬 ${assigned}개 중 ${d.unusedSkills.length}개는 이 PC에서 한 번도 안 불림 · 가장 많은 팀 ${worst}(${n}개)`,
      actions: [
        `지시에 스킬 이름을 넣어 직접 써 보기(예: ${list(d.unusedSkills.slice(0, 2).map((u) => shortSkill(u.skill)), 2)})`,
        '석 달 넘게 안 쓴 스킬은 직원 md 표에서 \'예비\'로 옮겨 자주 쓰는 스킬이 먼저 골라지게',
        'claude.ai 웹·앱에서만 쓰는 스킬이면 그대로 두기(이 PC 기록에는 안 잡힘)',
      ],
      effect: '직원이 고를 스킬이 분명해져 엉뚱한 스킬을 부르는 일이 줄어듦',
      links: [{ label: '스킬 DB 보기', k: 'view', v: 'skills' }],
    });
  }

  out.sort((a, b) => RANK[a.level] - RANK[b.level] || b.impact - a.impact);
  return out;
}
