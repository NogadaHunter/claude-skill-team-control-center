// 올리기 전에 저장소 구조를 점검한다(claude CLI 가 있으면 `claude plugin validate .` 도 함께 돌려 보세요).
//   node tools/check-repo.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'skill-team-control-center';
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const RESERVED = /^(claude|anthropic|anthropics|cc-plugin)(-|$)|claude-code|official/;
const errors = [];
const warns = [];
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const load = (p) => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8')); } catch (e) { errors.push(`${p}: ${e.code === 'ENOENT' ? '파일이 없어요' : 'JSON 문법 오류 (' + e.message + ')'}`); return null; }
};
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (e.name === '.git' || e.name === 'node_modules' ? [] : walk(path.join(dir, e.name))) : [path.join(dir, e.name)]);

const pkg = load('package.json');
const mk = load('.claude-plugin/marketplace.json');
if (mk) {
  for (const k of ['name', 'owner', 'plugins']) if (!(k in mk)) errors.push(`marketplace.json: '${k}' 필드가 없어요`);
  if (mk.name && (!KEBAB.test(mk.name) || RESERVED.test(mk.name))) errors.push(`marketplace.json: 이름 '${mk.name}' 이 규칙에 맞지 않아요(kebab-case, claude·anthropic 으로 시작 금지)`);
  if (!(mk.owner && mk.owner.name)) errors.push('marketplace.json: owner.name 이 없어요');
  for (const [i, p] of (mk.plugins || []).entries()) {
    if (String(p.source).includes('..')) { errors.push(`plugins[${i}]: source 에 '..' 를 쓸 수 없어요`); continue; }
    const pdir = path.join(ROOT, p.source);
    if (!fs.existsSync(pdir)) { errors.push(`plugins[${i}]: source 폴더가 없어요 (${p.source})`); continue; }
    const man = load(path.join(p.source, '.claude-plugin', 'plugin.json'));
    if (!man) continue;
    if (man.name !== p.name) errors.push(`plugins[${i}]: marketplace 이름 '${p.name}' 과 plugin.json 이름 '${man.name}' 이 달라요`);
    if (!KEBAB.test(man.name || '')) errors.push(`plugin.json: 이름 '${man.name}' 은 kebab-case 여야 해요`);
    for (const k of ['version', 'description', 'author']) if (!(k in man)) warns.push(`plugin.json: '${k}' 가 없어요`);
    const sdir = path.join(pdir, 'skills');
    for (const s of fs.existsSync(sdir) ? fs.readdirSync(sdir) : []) {
      const sk = path.join(sdir, s, 'SKILL.md');
      if (!fs.existsSync(sk)) { errors.push(`skills/${s}: SKILL.md 가 없어요`); continue; }
      const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(fs.readFileSync(sk, 'utf8'));
      if (!fm) { errors.push(`skills/${s}/SKILL.md: 맨 위 --- 머리말이 없어요`); continue; }
      const nm = /^name:\s*(.+)$/m.exec(fm[1]);
      const ds = /^description:\s*(.+)$/m.exec(fm[1]);
      if (!nm || nm[1].trim() !== s) errors.push(`skills/${s}/SKILL.md: name 이 폴더 이름과 같아야 해요`);
      if (!ds) errors.push(`skills/${s}/SKILL.md: description 이 없어요`);
      else if ([...ds[1].trim()].length > 1024) warns.push(`skills/${s}/SKILL.md: description 이 1,024자를 넘어요`);
      const app = path.join(sdir, s, 'app');
      if (s === NAME) {
        const ver = fs.readFileSync(path.join(sdir, s, 'VERSION'), 'utf8').trim();
        const appPkg = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
        if (man.version !== ver || appPkg.version !== ver || (pkg && pkg.version !== ver)) errors.push(`판 번호가 서로 달라요: plugin.json ${man.version} · VERSION ${ver} · app ${appPkg.version} · package.json ${pkg && pkg.version}`);
        for (const need of ['server/server.mjs', 'scripts/ctl.mjs', 'scripts/setup.mjs', 'web/index.html', 'config/pricing.json']) {
          if (!fs.existsSync(path.join(app, need))) errors.push(`app/${need} 가 없어요`);
        }
        if (fs.existsSync(path.join(app, 'config', 'profiles.json'))) errors.push('app/config/profiles.json 이 들어 있어요(개인 설정은 넣지 않아요)');
        for (const f of walk(path.join(sdir, s))) if (/\.test\.mjs$|\.log$/.test(f)) warns.push(`${rel(f)}: 플러그인 안에 시험·로그 파일이 있어요`);
      }
    }
  }
}

// 직접 설치용 zip 이 플러그인 스킬 폴더와 같은지(파일 수)
const skillZip = path.join(ROOT, 'dist', `${NAME}.skill`);
if (fs.existsSync(skillZip)) {
  const buf = fs.readFileSync(skillZip);
  let count = 0;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { count = buf.readUInt16LE(i + 10); break; }
  const src = walk(path.join(ROOT, 'plugins', NAME, 'skills', NAME)).length;
  if (count !== src) warns.push(`dist/${NAME}.skill 파일 수(${count})가 스킬 폴더(${src})와 달라요 → 개발 폴더에서 다시 빌드하세요`);
} else errors.push(`dist/${NAME}.skill 이 없어요`);

for (const need of ['README.md', 'README.en.md', 'LICENSE', 'CHANGELOG.md', 'test', '.github/workflows/test.yml']) {
  if (!fs.existsSync(path.join(ROOT, need))) errors.push(`${need} 가 없어요`);
}
// 개인 폴더 경로가 섞였는지(사용자 이름이 드러나는 경로)
for (const f of walk(ROOT)) {
  if (!/\.(mjs|js|json|md|html|css|cmd|command|yml)$/.test(f)) continue;
  if (/[A-Z]:[\\/]+Users[\\/]+(?![<]|demo\b)[^\\/\s'"`]+[\\/]|\/Users\/(?![<]|demo\b)[^/\s'"`]+\/|\/home\/(?![<]|demo\b)[^/\s'"`]+\//.test(fs.readFileSync(f, 'utf8'))) {
    errors.push(`${rel(f)}: 개인 폴더 경로가 들어 있어요`);
  }
}

console.log('■ 저장소 점검');
for (const e of errors) console.log('  ✖', e);
for (const w of warns) console.log('  ⚠', w);
console.log(errors.length ? `  실패 ${errors.length}건` : '  ✔ 통과');
process.exitCode = errors.length ? 1 : 0;
