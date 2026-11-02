// 서버에서 글로 쓰는 숫자·시간 표기(리포트·제언이 함께 쓴다). 화면(web/app.js)의 표기와 같은 규칙이다.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const usd = (n) => {
  n = n || 0;
  if (n >= 1000) return '$' + Math.round(n).toLocaleString('en-US');
  if (n >= 100) return '$' + n.toFixed(0);
  if (n >= 0.01) return '$' + n.toFixed(2);
  return n > 0 ? '<$0.01' : '$0';
};

export const tok = (n) => {
  n = n || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 1 : 2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K';
  return String(Math.round(n));
};

export const dur = (ms) => {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + '초';
  const m = Math.floor(s / 60);
  if (m < 60) return m + '분' + (s % 60 ? ' ' + (s % 60) + '초' : '');
  return Math.floor(m / 60) + '시간' + (m % 60 ? ' ' + (m % 60) + '분' : '');
};

export const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

/** 달러 → '약 171만 원'(1만 원 아래는 '약 1,050원', 1억 넘으면 '약 1.2억 원'). 환율이 없으면 '' */
export const krw = (usdValue, rate) => {
  if (!rate || !usdValue) return '';
  const w = usdValue * rate;
  if (w >= 1e8) return `약 ${(w / 1e8).toFixed(1)}억 원`;
  if (w >= 1e4) return `약 ${Math.round(w / 1e4).toLocaleString('ko-KR')}만 원`;
  return `약 ${Math.round(w).toLocaleString('ko-KR')}원`;
};
export const shortSkill = (s) => String(s || '').split(':').pop();
export const prettyModel = (m) => {
  const r = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(m || '');
  if (!r) return m;
  return r[1][0].toUpperCase() + r[1].slice(1) + ' ' + r[2] + (r[3] && r[3].length < 3 ? '.' + r[3] : '');
};
