// README 화면 사진: 켜 둔 관제판(보통 tools/demo.mjs 의 가상 데이터)을 Chrome·Edge 헤드리스로 찍는다.
// 진짜 기록이 찍히지 않게 기본 주소는 데모 포트(4795)다.
//   node tools/screenshots.mjs [--base http://127.0.0.1:4795] [--out docs/screenshots]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = [path.join(here, '..'), path.join(here, '..', 'plugins', 'skill-team-control-center', 'skills', 'skill-team-control-center', 'app')]
  .find((d) => fs.existsSync(path.join(d, 'server', 'browser.mjs')));
const { findBrowser } = await import(pathToFileURL(path.join(appDir, 'server', 'browser.mjs')));

const base = opt('base', 'http://127.0.0.1:4795');
const out = path.resolve(opt('out', path.join(here, '..', 'docs', 'screenshots')));
const browser = findBrowser({ edge: true });
if (!browser) throw new Error('Chrome·Edge 를 찾지 못했어요');
fs.mkdirSync(out, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'amc-shot-'));

const SHOTS = [
  ['dashboard.png', '/', 1440, 1000, 'light'],
  ['dashboard-dark.png', '/', 1440, 1000, 'dark'],
  ['workflow.png', '/#flow', 1440, 1000, 'light'],
  ['skills.png', '/#skills', 1440, 900, 'light'],
  ['office.png', '/#office', 1440, 520, 'light'],
  ['report.png', '/report?range=30d', 1000, 1400, 'light'],
];

for (const [name, p, w, h, scheme] of SHOTS) {
  const file = path.join(out, name);
  await promisify(execFile)(browser, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', `--user-data-dir=${profile}`,
    `--window-size=${w},${h}`, '--timeout=7000', `--blink-settings=preferredColorScheme=${scheme === 'dark' ? 0 : 1}`,
    ...(scheme === 'dark' ? ['--force-dark-mode'] : []), `--screenshot=${file}`, base + p,
  ], { timeout: 60000 });
  console.log(`${name} (${Math.round(fs.statSync(file).size / 1024)}KB)`);
}
fs.rmSync(profile, { recursive: true, force: true });
console.log(`저장: ${out}`);
