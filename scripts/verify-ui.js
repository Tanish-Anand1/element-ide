import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import CDP from 'chrome-remote-interface';
import { createApp } from '../server.js';
import { Inspector } from '../cdp.js';

const executable = process.env.BROWSER_PATH || process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(existsSync);
assert.ok(executable, 'Chromium browser not found.');
const profile = await mkdtemp(path.join(tmpdir(), 'element-ide-ui-'));
const screenshotPath = process.env.UI_SCREENSHOT || path.join(tmpdir(), 'element-ide-sidepanel.png');
const chrome = spawn(executable, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore', windowsHide: true });
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const waitFor = async task => { for (let attempt = 0; attempt < 80; attempt++) { try { const result = await task(); if (result) return result; } catch { /* startup */ } await pause(100); } throw Error('Timed out waiting for the UI.'); };
let port, server, inspector, pageClient, ideClient, ideTarget, failure;
try {
  port = Number((await waitFor(() => readFile(path.join(profile, 'DevToolsActivePort'), 'utf8'))).split('\n')[0]);
  inspector = new Inspector({ port }); const { app } = createApp(inspector); server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const targets = await inspector.targets(); const pageTarget = targets.find(target => target.url === 'about:blank') || targets[0];
  pageClient = await CDP({ host: '127.0.0.1', port, target: pageTarget.id, local: true }); await pageClient.Page.enable();
  await pageClient.Page.navigate({ url: `${base}/playground.html` }); await waitFor(async () => (await pageClient.Runtime.evaluate({ expression: 'document.readyState', returnByValue: true })).result.value === 'complete');
  await pageClient.Runtime.evaluate({ expression: `(() => { const root = document.createElement('section'); root.id = 'deep-tree-test'; let cursor = root; for (let index = 0; index < 32; index++) { const child = document.createElement('div'); child.dataset.depth = index; cursor.append(child); cursor = child; } cursor.append('Deep nested text remains visible'); document.body.append(root); })()` });
  await inspector.connect(pageTarget.id);
  ideTarget = await CDP.New({ host: '127.0.0.1', port, url: 'about:blank' }); ideClient = await CDP({ host: '127.0.0.1', port, target: ideTarget.id, local: true });
  await ideClient.Page.enable(); await ideClient.Runtime.enable(); await ideClient.Emulation.setDeviceMetricsOverride({ width: 430, height: 900, deviceScaleFactor: 1, mobile: false });
  const consoleErrors = []; ideClient.Runtime.exceptionThrown(event => consoleErrors.push(event.exceptionDetails.exception?.description || `${event.exceptionDetails.text} at ${event.exceptionDetails.url}:${event.exceptionDetails.lineNumber + 1}`)); ideClient.Runtime.consoleAPICalled(event => { if (event.type === 'error') consoleErrors.push(event.args.map(argument => argument.value || argument.description || '').join(' ')); });
  await ideClient.Page.navigate({ url: `${base}/?extension=1` });
  const evaluate = async expression => (await ideClient.Runtime.evaluate({ expression, returnByValue: true })).result.value;
  await waitFor(() => evaluate('!document.querySelector("#selected-content").hidden && document.querySelector("#selected-label").textContent === "body" && Boolean(document.querySelector("#html-editor .monaco-editor"))'));
  const layout = await evaluate(`(() => { const tree = document.querySelector('.tree-pane').getBoundingClientRect(); const splitter = document.querySelector('#splitter').getBoundingClientRect(); const inspector = document.querySelector('#inspector').getBoundingClientRect(); return {extension:document.documentElement.classList.contains('extension-mode'), width:innerWidth, scrollWidth:document.documentElement.scrollWidth, tabs:document.querySelectorAll('[role=tab]').length, selected:document.querySelector('#selected-label').textContent, treeRows:document.querySelectorAll('.tree-row').length, detailScroll:document.querySelector('#selected-content').scrollTop, summaryHeight:document.querySelector('.selection-summary').getBoundingClientRect().height, pseudoHeight:document.querySelector('#pseudo-toolbar').getBoundingClientRect().height, treeBottom:tree.bottom, splitterTop:splitter.top, inspectorTop:inspector.top, splitterBottom:splitter.bottom, inspectorHeight:inspector.height, activeTab:document.querySelector('[role=tab][aria-selected=true]').dataset.tab}; })()`);
  assert.equal(layout.extension, true); assert.equal(layout.width, 430); assert.ok(layout.scrollWidth <= 430); assert.equal(layout.tabs, 8); assert.equal(layout.selected, 'body'); assert.ok(layout.treeRows >= 6); assert.equal(layout.detailScroll, 0); assert.ok(layout.summaryHeight > 50); assert.ok(layout.pseudoHeight > 20); assert.ok(Math.abs(layout.treeBottom - layout.splitterTop) < 2); assert.ok(layout.inspectorTop >= layout.splitterBottom - 1); assert.ok(layout.inspectorHeight > 260); assert.equal(layout.activeTab, 'html');
  const overview = await evaluate(`(() => { const ai = document.querySelector('.ai-harness').getBoundingClientRect(); return { documentHeight: document.documentElement.scrollHeight, viewportHeight: innerHeight, aiTop: ai.top, aiBottom: ai.bottom }; })()`); assert.equal(overview.documentHeight, overview.viewportHeight); assert.ok(overview.aiTop >= layout.inspectorTop); assert.ok(overview.aiBottom <= overview.viewportHeight);
  const resized = await evaluate(`(() => { const splitter = document.querySelector('#splitter'); splitter.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); return splitter.getAttribute('aria-valuenow'); })()`); assert.equal(resized, '39');
  await evaluate(`(() => { const search = document.querySelector('#tree-search'); search.value = 'Deep nested text remains visible'; search.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const deepVisibility = await evaluate(`(() => { const row = [...document.querySelectorAll('.tree-row')].find(candidate => candidate.textContent.includes('Deep nested text remains visible')); const tree = document.querySelector('#tree').getBoundingClientRect(); const code = row?.querySelector('.tree-code').getBoundingClientRect(); return row && code ? { depth:Number(row.dataset.depth), left:code.left, right:code.right, treeLeft:tree.left, treeRight:tree.right, horizontalScroll:document.querySelector('#tree').scrollWidth - document.querySelector('#tree').clientWidth } : null; })()`);
  assert.ok(deepVisibility); assert.ok(deepVisibility.depth > 30); assert.ok(deepVisibility.left >= deepVisibility.treeLeft); assert.ok(deepVisibility.right <= deepVisibility.treeRight); assert.equal(deepVisibility.horizontalScroll, 0);
  await evaluate(`(() => { const search = document.querySelector('#tree-search'); search.value = 'Good things take'; search.dispatchEvent(new Event('input', { bubbles: true })); const row = [...document.querySelectorAll('.tree-row')].find(candidate => candidate.querySelector('.node-text')?.textContent.includes('Good things take')); row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); })()`);
  await waitFor(() => evaluate('Boolean(document.querySelector(".tree-text-editor"))'));
  await evaluate(`(() => { const input = document.querySelector('.tree-text-editor'); input.value = 'Changed live from Element IDE'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const pageEvaluate = async expression => (await pageClient.Runtime.evaluate({ expression, returnByValue: true })).result.value;
  await waitFor(() => pageEvaluate('document.querySelector("#sample-title").textContent.startsWith("Changed live from Element IDE")'));
  await evaluate(`document.querySelector('.tree-text-editor').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await waitFor(() => pageEvaluate('document.querySelector("#sample-title").textContent.startsWith("Good things take")'));
  await waitFor(() => evaluate('!document.querySelector(".tree-text-editor") && document.querySelector("#history-count").textContent === "0"'));
  await evaluate(`(() => { const row = [...document.querySelectorAll('.tree-row')].find(candidate => candidate.querySelector('.node-text')?.textContent.includes('Good things take')); row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); })()`);
  await waitFor(() => evaluate('Boolean(document.querySelector(".tree-text-editor"))'));
  await evaluate(`(() => { const input = document.querySelector('.tree-text-editor'); input.value = 'Changed live from Element IDE'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await waitFor(() => pageEvaluate('document.querySelector("#sample-title").textContent.startsWith("Changed live from Element IDE")'));
  await evaluate(`document.querySelector('.tree-text-editor').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await waitFor(() => evaluate('!document.querySelector(".tree-text-editor") && document.querySelector("#history-count").textContent === "1"'));
  await evaluate(`(() => { const model = window.monaco.editor.getEditors()[0].getModel(); model.pushEditOperations([], [{ range: model.getFullModelRange(), text: 'Changed from Monaco live preview' }], () => null); })()`);
  await waitFor(() => pageEvaluate('document.querySelector("#sample-title").textContent.startsWith("Changed from Monaco live preview")'));
  assert.equal(await evaluate('document.querySelector("#html-dirty").textContent'), 'Preview live');
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await waitFor(() => pageEvaluate('document.querySelector("#sample-title").textContent.startsWith("Changed live from Element IDE")'));
  assert.deepEqual(consoleErrors, []);
  const screenshot = await ideClient.Page.captureScreenshot({ format: 'png', captureBeyondViewport: false }); await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  await pageClient.Page.reload(); await waitFor(() => pageEvaluate('document.readyState === "complete" && document.querySelector("#sample-title").textContent.startsWith("Good things take")'));
  console.log(`PASS: 430x900 split panel, deep-node visibility, keyboard resize, live typing, Escape cancel, commit, reload reset and no console errors`);
  console.log(`SCREENSHOT: ${screenshotPath}`);
} catch (error) { failure = error; }
finally {
  await ideClient?.close().catch(() => {}); if (ideTarget) await CDP.Close({ host: '127.0.0.1', port, id: ideTarget.id }).catch(() => {}); await pageClient?.close().catch(() => {}); await inspector?.disconnect();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (port) { try { const browser = await CDP({ host: '127.0.0.1', port, target: (await CDP.Version({ host: '127.0.0.1', port })).webSocketDebuggerUrl, local: true }); await browser.Browser.close(); } catch { chrome.kill(); } } else chrome.kill();
  if (path.dirname(profile) === path.resolve(tmpdir()) && path.basename(profile).startsWith('element-ide-ui-')) await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
}
if (failure) { console.error(failure); process.exitCode = 1; }
