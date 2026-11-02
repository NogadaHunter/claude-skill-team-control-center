// 브라우저 찾기·창 열기. 서버(PDF 만들기·창 열기)와 ctl.mjs(창 열기)가 함께 쓴다.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** Chrome 실행 파일(edge=true 면 Chrome 이 없을 때 Edge 도). 못 찾으면 null */
export function findBrowser({ edge = false } = {}) {
  const pf = process.env.ProgramFiles || 'C:/Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)';
  const chrome = {
    win32: [path.join(pf, 'Google/Chrome/Application/chrome.exe'), path.join(pf86, 'Google/Chrome/Application/chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe')],
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
  };
  const msedge = {
    win32: [path.join(pf86, 'Microsoft/Edge/Application/msedge.exe'), path.join(pf, 'Microsoft/Edge/Application/msedge.exe')],
    darwin: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    linux: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'],
  };
  const list = [...(chrome[process.platform] || []), ...(edge ? msedge[process.platform] || [] : [])];
  return list.find((p) => fs.existsSync(p)) || null;
}

/** 독립 창(Chrome 앱 모드)으로 연다. Chrome 이 없으면 기본 브라우저로 연다 */
export function openWindow(url) {
  const chrome = findBrowser();
  if (chrome) return spawn(chrome, [`--app=${url}`, '--window-size=1440,960'], { detached: true, stdio: 'ignore' }).unref();
  if (process.platform === 'win32') return spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}
