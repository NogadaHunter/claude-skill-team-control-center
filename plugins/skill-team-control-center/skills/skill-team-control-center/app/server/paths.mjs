// 모든 경로를 한곳에서 정한다. 시험할 때는 환경 변수로 임시 폴더를 가리킨다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const appDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const webDir = path.join(appDir, 'web');
// 앱 판 번호. 플러그인을 새 판으로 바꾸면 ctl 이 예전 판 서버를 끄고 새로 켠다
export const appVersion = (() => { try { return JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')).version || ''; } catch { return ''; } })();

export const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
export const projectsDir = path.join(claudeDir, 'projects');
export const agentsDir = path.join(claudeDir, 'agents');
export const skillsDir = path.join(claudeDir, 'skills');
export const pluginsDir = path.join(claudeDir, 'plugins');

// 집계 캐시·알림 기록·(스킬로 설치했을 때의) 설정과 리포트는 홈 폴더에 둔다(OneDrive·스킬 폴더 밖).
export const stateDir = process.env.AMC_HOME || path.join(os.homedir(), '.agent-mission-control');
export const cacheFile = path.join(stateDir, 'cache.json');
export const alertsFile = path.join(stateDir, 'alerts.json'); // 알림을 처음 본 때·읽은 때
export const logFile = path.join(stateDir, 'server.log'); // ctl.mjs 로 띄운 서버의 출력

// 앱에 딸린 기본 설정(단가표 등). 앱 폴더에 profiles.json 이 있으면 그 폴더를 설정 폴더로 쓰고(직접 받아 쓰는 판),
// 없으면 스킬로 설치한 것으로 보고 홈 폴더의 config 를 쓴다 — 스킬을 새 판으로 바꿔도 설정이 남는다.
export const defaultConfigDir = path.join(appDir, 'config');
const local = fs.existsSync(path.join(defaultConfigDir, 'profiles.json'));
export const configDir = process.env.AMC_CONFIG_DIR || (local ? defaultConfigDir : path.join(stateDir, 'config'));

// 화면에서 고치는 설정(예산)과 스킬 DB 엑셀 위치
export const budgetFile = path.join(configDir, 'budget.json');
export const skilldbFile = path.join(configDir, 'skilldb.json');

// 화면에 보일 때는 홈 폴더를 ~ 로 줄인다(사용자 이름이 드러나지 않게)
export const homeShort = (p) => { const h = os.homedir(); return h && p.toLowerCase().startsWith(h.toLowerCase()) ? '~' + p.slice(h.length) : p; };

// 'PDF 바로 저장'한 리포트
export const reportsDir = process.env.AMC_REPORTS_DIR || (local ? path.join(appDir, 'reports') : path.join(stateDir, 'reports'));

// 3D 사무실(claude-3d-frog-office, 따로 설치하는 도구) 주소. 포트는 그쪽 설정을 따른다.
export const officeHome = process.env.CLAUDE_OFFICE_HOME || path.join(os.homedir(), '.claude-office');
function officePort() {
  if (process.env.CLAUDE_OFFICE_PORT) return Number(process.env.CLAUDE_OFFICE_PORT);
  try { return Number(JSON.parse(fs.readFileSync(path.join(officeHome, 'config.json'), 'utf8')).port) || 4777; } catch { return 4777; }
}
export const officeUrl = `http://127.0.0.1:${officePort()}`;
// 설치했는지(그쪽 setup 이 config.json 을 만든다) — 없으면 화면에서 '3D로 보기' 대신 설치 안내를 보인다
export const officeInstalled = () => fs.existsSync(path.join(officeHome, 'config.json'));
export const officeRepo = 'https://github.com/d-onworks/claude-3d-frog-office';
