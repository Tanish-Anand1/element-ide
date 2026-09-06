import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const windows = [
  ['Google Chrome', path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe')],
  ['Google Chrome', path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe')],
  ['Google Chrome', path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe')],
  ['Microsoft Edge', path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe')],
  ['Microsoft Edge', path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft/Edge/Application/msedge.exe')],
  ['Brave', path.join(process.env.LOCALAPPDATA || '', 'BraveSoftware/Brave-Browser/Application/brave.exe')],
  ['Vivaldi', path.join(process.env.LOCALAPPDATA || '', 'Vivaldi/Application/vivaldi.exe')],
];
const mac = [
  ['Google Chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  ['Microsoft Edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  ['Brave', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
  ['Vivaldi', '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi'],
  ['Chromium', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
];
const linux = [
  ['Google Chrome', '/usr/bin/google-chrome'],
  ['Google Chrome', '/usr/bin/google-chrome-stable'],
  ['Microsoft Edge', '/usr/bin/microsoft-edge'],
  ['Brave', '/usr/bin/brave-browser'],
  ['Vivaldi', '/usr/bin/vivaldi'],
  ['Chromium', '/usr/bin/chromium'],
  ['Chromium', '/usr/bin/chromium-browser'],
];
const configured = process.env.BROWSER_PATH || process.env.CHROME_PATH;
const candidates = process.platform === 'win32' ? windows : process.platform === 'darwin' ? mac : linux;
const detected = configured ? ['Configured browser', configured] : candidates.find(([, executable]) => existsSync(executable));

if (!detected || !existsSync(detected[1])) {
  console.error('No supported Chromium browser was found. Set BROWSER_PATH to a Chrome, Edge, Brave, Vivaldi or Chromium executable.');
  process.exit(1);
}

const [browserName, executable] = detected;
const port = Number(process.env.CDP_PORT || 9222);
const profile = path.join(tmpdir(), 'element-ide-browser');
const child = spawn(executable, [
  `--remote-debugging-port=${port}`,
  '--remote-debugging-address=127.0.0.1',
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  `http://localhost:${Number(process.env.PORT || 3000)}/playground.html`,
], { detached: true, stdio: 'ignore', windowsHide: true });

child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.unref();
console.log(`Launching ${browserName} with a separate profile on port ${port}. Open the IDE in your regular browser.`);
