// A4 리포트 도구 줄: 인쇄 창 열기, PDF 바로 저장(서버가 reports 폴더에 만든다), 저장한 PDF 열기·폴더에서 보기.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const range = document.body.dataset.range || '7d';

async function post(url, body) {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AMC': '1' }, body: JSON.stringify(body) });
    return await res.json();
  } catch (err) {
    return { error: 'Control Center 서버에 닿지 못했어요 (' + (err.message || err) + ')' };
  }
}

function say(html, err = false) {
  const m = $('#tb-msg');
  m.innerHTML = html;
  m.classList.toggle('err', err);
}

$('#print').addEventListener('click', () => window.print());

$('#pdf').addEventListener('click', async () => {
  const btn = $('#pdf');
  btn.disabled = true;
  say('PDF를 만들고 있어요… (몇 초 걸려요)');
  const r = await post('/api/report/pdf', { range });
  btn.disabled = false;
  if (r.error) { say(esc(r.error) + ' · 대신 ‘인쇄 · PDF로 저장…’을 써 주세요.', true); return; }
  say(`저장했어요: <b>${esc(r.file)}</b> · <a href="/reports/${encodeURIComponent(r.file)}" target="_blank" rel="noopener">열기</a> · <button type="button" class="link" id="reveal">폴더에서 보기</button>`);
  $('#reveal').addEventListener('click', async () => {
    const x = await post('/api/report/reveal', { file: r.file });
    if (x.error) say(esc(x.error), true);
  });
});

// 대시보드에서 연 창이면 Ctrl+P 처럼 바로 인쇄할 수 있게 #print 로 열면 인쇄 창을 띄운다
if (location.hash === '#print') setTimeout(() => window.print(), 300);
