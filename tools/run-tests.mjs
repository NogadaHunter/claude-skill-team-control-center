// 저장소에서 시험 돌리기: 플러그인 안의 앱을 임시 폴더에 복사하고 test/ 를 옆에 붙여 node --test 로 돌린다.
// (플러그인 폴더에는 시험 파일을 넣지 않아 설치 크기를 줄인다. 진짜 ~/.claude 는 건드리지 않는다)
// GitHub Actions 에서는 실패한 시험을 주석(::error)으로도 남긴다. 로그는 로그인해야 보이지만 주석은 누구나 본다.
//   node tools/run-tests.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = path.join(root, 'plugins', 'skill-team-control-center', 'skills', 'skill-team-control-center', 'app');
const ci = !!process.env.GITHUB_ACTIONS;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'amc-test-'));
try {
  fs.cpSync(app, tmp, { recursive: true });
  fs.cpSync(path.join(root, 'test'), path.join(tmp, 'test'), { recursive: true });
  const files = fs.readdirSync(path.join(tmp, 'test')).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => path.join('test', f));
  const r = spawnSync(process.execPath, ['--test', ...(ci ? ['--test-reporter=tap'] : []), ...files],
    { cwd: tmp, stdio: ci ? ['inherit', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (ci) {
    process.stdout.write(r.stdout || '');
    if (r.status !== 0) annotate(r.stdout || '');
  }
  process.exitCode = r.status ?? 1;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// TAP 의 'not ok' 가운데 하위 시험 실패를 묶기만 한 줄(subtestsFailed)은 빼고, 오류 내용 앞부분을 주석으로 낸다
function annotate(tap) {
  const lines = tap.split(/\r?\n/);
  let n = 0;
  for (let i = 0; i < lines.length && n < 10; i++) {
    const m = lines[i].match(/^\s*not ok \d+ - (.+)$/);
    if (!m) continue;
    const block = [];
    for (let j = i + 1; j < lines.length && lines[j].trim() !== '...'; j++) block.push(lines[j].trim());
    if (block.some((l) => l.includes('subtestsFailed'))) continue;
    const from = Math.max(0, block.findIndex((l) => l.startsWith('error:')));
    const msg = block.slice(from, from + 14).join('\n');
    const enc = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    console.log(`::error title=${enc('시험 실패 - ' + m[1]).replace(/[:,]/g, ' ')}::${enc(msg)}`);
    n++;
  }
}
