// 외부 라이브러리 없이 .xlsx(엑셀) 를 읽는다. xlsx 는 XML 파일 여러 개를 묶은 zip 이다.
// 읽기만 한다: 시트의 칸 값(공유 문자열·숫자·수식의 마지막 계산값)과 표(Table) 정의.
import fs from 'node:fs';
import zlib from 'node:zlib';

// ── zip ──
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('엑셀(zip) 파일이 아니에요');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 목차가 깨졌어요');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    files.set(name, { method, csize, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return (name) => {
    const f = files.get(name);
    if (!f) return null;
    const start = f.local + 30 + buf.readUInt16LE(f.local + 26) + buf.readUInt16LE(f.local + 28);
    const raw = buf.subarray(start, start + f.csize);
    if (f.method === 0) return raw.toString('utf8');
    if (f.method === 8) return zlib.inflateRawSync(raw).toString('utf8');
    throw new Error('지원하지 않는 압축 방식: ' + f.method);
  };
}

// ── XML 조각 ──
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function unescapeXml(s) {
  return String(s)
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#'
      ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
      : ENT[e] ?? m))
    .replace(/_x([0-9A-F]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16))); // 엑셀이 줄바꿈 등을 _x000D_ 로 적는다
}
const attr = (tag, name) => { const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag); return m ? unescapeXml(m[1]) : null; };
// <t> 들을 이어 붙인 글자(서식 있는 글자 <r><t> 포함, 읽는 법 <rPh> 는 뺀다)
const textOf = (xml) => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1])).join('');

/** 'AB12' → [행 번호(0부터), 열 번호(0부터)] */
export function cellRef(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return [Number(m[2]) - 1, col - 1];
}

function parseSheet(xml, shared) {
  const rows = [];
  for (const cm of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const head = cm[1];
    const body = cm[2] || '';
    const pos = cellRef(attr(head, 'r') || '');
    if (!pos) continue;
    const type = attr(head, 't');
    const v = /<v>([\s\S]*?)<\/v>/.exec(body);
    let val = null;
    if (type === 's') val = v ? shared[Number(v[1])] ?? '' : '';
    else if (type === 'inlineStr') val = textOf(body);
    else if (type === 'b') val = v ? v[1] === '1' : null;
    else if (type === 'str' || type === 'e') val = v ? unescapeXml(v[1]) : '';
    else if (v) { const num = Number(v[1]); val = Number.isFinite(num) ? num : unescapeXml(v[1]); }
    if (val === null || val === '') continue;
    (rows[pos[0]] ||= [])[pos[1]] = val;
  }
  return rows;
}

const relsOf = (xml) => Object.fromEntries([...(xml || '').matchAll(/<Relationship\b[^>]*>/g)].map((m) => [attr(m[0], 'Id'), attr(m[0], 'Target')]));
const resolve = (base, target) => {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const seg of target.split('/')) { if (seg === '..') parts.pop(); else if (seg !== '.') parts.push(seg); }
  return parts.join('/');
};

/** 엑셀 파일 → { sheets: [{ name, rows }], tables: [{ name, sheet, columns, rows: [{열이름: 값}] }] } */
export function readXlsx(file) {
  const get = unzip(fs.readFileSync(file));
  const shared = [...(get('xl/sharedStrings.xml') || '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
  const wb = get('xl/workbook.xml') || '';
  const wbRels = relsOf(get('xl/_rels/workbook.xml.rels'));
  const sheets = [];
  const tables = [];
  for (const sm of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(sm[0], 'name');
    const path = resolve('xl/workbook.xml', wbRels[attr(sm[0], 'r:id')] || '');
    const xml = get(path);
    if (!xml) continue;
    const rows = parseSheet(xml, shared);
    sheets.push({ name, rows });
    const rels = relsOf(get(path.replace(/([^/]+)$/, '_rels/$1.rels')));
    for (const tp of xml.matchAll(/<tablePart\b[^>]*>/g)) {
      const tpath = resolve(path, rels[attr(tp[0], 'r:id')] || '');
      const txml = get(tpath);
      if (!txml) continue;
      const head = /<table\b[^>]*>/.exec(txml)[0];
      const [a, b] = (attr(head, 'ref') || '').split(':').map(cellRef);
      if (!a || !b) continue;
      const columns = [...txml.matchAll(/<tableColumn\b[^>]*>/g)].map((m) => attr(m[0], 'name'));
      const headerRows = Number(attr(head, 'headerRowCount') ?? 1);
      const totals = Number(attr(head, 'totalsRowCount') ?? 0);
      const out = [];
      for (let r = a[0] + headerRows; r <= b[0] - totals; r++) {
        const row = rows[r] || [];
        const o = {};
        let any = false;
        columns.forEach((c, i) => { const v = row[a[1] + i]; if (v != null) { o[c] = v; any = true; } });
        if (any) out.push(o);
      }
      tables.push({ name: attr(head, 'displayName') || attr(head, 'name'), sheet: name, columns, rows: out });
    }
  }
  return { sheets, tables };
}
