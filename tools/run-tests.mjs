// 저장소에서 시험 돌리기: 플러그인 안의 앱을 임시 폴더에 복사하고 test/ 를 옆에 붙여 node --test 로 돌린다.
// (플러그인 폴더에는 시험 파일을 넣지 않아 설치 크기를 줄인다. 진짜 ~/.claude 는 건드리지 않는다)
//   node tools/run-tests.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = path.join(root, 'plugins', 'skill-team-control-center', 'skills', 'skill-team-control-center', 'app');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'amc-test-'));
try {
  fs.cpSync(app, tmp, { recursive: true });
  fs.cpSync(path.join(root, 'test'), path.join(tmp, 'test'), { recursive: true });
  const files = fs.readdirSync(path.join(tmp, 'test')).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => path.join('test', f));
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: tmp, stdio: 'inherit' });
  process.exitCode = r.status ?? 1;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
