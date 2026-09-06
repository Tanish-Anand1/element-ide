// Real Chrome/CDP boundary test. Uses its own browser, tab, profile and server.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
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
assert.ok(executable, 'Chromium browser not found. Set BROWSER_PATH to a Chrome, Edge, Brave, Vivaldi or Chromium executable.');
const profile = await mkdtemp(path.join(tmpdir(), 'element-ide-test-'));
const chrome = spawn(executable, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore', windowsHide: true });
let client, ideClient, ideTarget, inspector, server, port, failure;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async task => { for (let i = 0; i < 60; i++) { try { const result = await task(); if (result) return result; } catch { /* startup / navigation */ } await pause(100); } throw Error('Timed out waiting for Chrome'); };
try {
  port = Number((await waitFor(() => readFile(path.join(profile, 'DevToolsActivePort'), 'utf8'))).split('\n')[0]);
  inspector = new Inspector({ port });
  const { app } = createApp(inspector);
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (url, body, expected = 200) => {
    const response = await fetch(base + url, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Inspector-Request': '1' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json(); assert.equal(response.status, expected, `${url}: ${JSON.stringify(data).slice(0, 250)}`); return data;
  };
  const targets = await request('/targets'); assert.ok(targets.length);
  const workTarget = targets.find(target => target.url === 'about:blank') || targets[0];
  client = await CDP({ host: '127.0.0.1', port, target: workTarget.id, local: true });
  await client.Page.enable();
  await client.Page.navigate({ url: base + '/playground.html' });
  await waitFor(async () => (await client.Runtime.evaluate({ expression: 'document.readyState', returnByValue: true })).result.value === 'complete');
  let current = await request('/connect', { targetId: workTarget.id });
  const evaluate = async expression => { const result = await client.Runtime.evaluate({ expression, returnByValue: true }); assert.ok(!result.exceptionDetails, 'Page evaluation failed'); return result.result.value; };
  const flatten = root => [root, ...(root.children || []).flatMap(flatten)];
  const node = id => { const found = flatten(current.tree).find(n => { const a = n.attributes || []; return a.some((v, i) => i % 2 === 0 && v === 'id' && a[i + 1] === id); }); assert.ok(found, `Node ${id} exists`); return { nodeId: found.nodeId, backendNodeId: found.backendNodeId, session: current.session }; };
  const edit = async (kind, id, values) => { current = await request(`/edit/${kind}`, { ...node(id), ...values }); };
  const undo = async () => { current = await request('/undo', { session: current.session }); };
  const detail = await request(`/select/${node('sample-title').nodeId}`, node('sample-title'));
  assert.ok(detail.computedStyle.length > 100); assert.ok(detail.matched.matchedCSSRules.length); assert.ok(detail.metrics.width > 0);
  const layout = await request('/details/layout', node('sample-title')); assert.equal(layout.data.display, 'block'); assert.ok(layout.data.rect.width > 0);
  const accessibility = await request('/details/accessibility', node('sample-title')); assert.equal(accessibility.data.role, 'heading'); assert.match(accessibility.data.name, /Good things take/);
  await evaluate('document.querySelector("#sample-title").addEventListener("click", window.__elementTestListener = () => {})');
  const events = await request('/details/events', node('sample-title')); assert.ok(events.data.some(listener => listener.type === 'click'));
  await request('/pseudo', { ...node('sample-title'), classes: ['hover', 'focus'] });
  await request('/pseudo', { ...node('sample-title'), classes: [] });
  await request('/breakpoint', { ...node('sample-title'), type: 'attribute-modified', enabled: true });
  assert.equal((await request('/details/breakpoints', node('sample-title'))).data.find(item => item.type === 'attribute-modified').enabled, true);
  await request('/breakpoint', { ...node('sample-title'), type: 'attribute-modified', enabled: false });
  await request('/highlight', node('sample-title')); await request('/highlight/clear', {});
  let picked;
  const onPick = event => { if (event.type === 'picked') picked = event; };
  inspector.on('update', onPick);
  await client.Page.bringToFront();
  await request('/inspect', { enabled: true, session: current.session });
  const point = await evaluate('(() => { const r = document.querySelector("#sample-title").getBoundingClientRect(); return { x: r.x + 20, y: r.y + 20 }; })()');
  await client.Input.dispatchMouseEvent({ type: 'mouseMoved', ...point });
  await pause(200); // Let Chrome paint and hit-test the inspect overlay before clicking.
  await client.Input.dispatchMouseEvent({ type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await client.Input.dispatchMouseEvent({ type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  await waitFor(() => picked);
  assert.equal(picked.backendNodeId, node('sample-title').backendNodeId);
  assert.ok(picked.nodeId && picked.tree);
  current.tree = picked.tree;
  inspector.off('update', onPick);
  await request('/inspect', { enabled: false, session: current.session });
  console.log('PASS: full DOM, computed/layout/accessibility/listener panes, pseudo states, breakpoints, highlight and reverse picking');

  ideTarget = await CDP.New({ host: '127.0.0.1', port, url: 'about:blank' });
  ideClient = await CDP({ host: '127.0.0.1', port, target: ideTarget.id, local: true });
  await ideClient.Page.enable();
  await ideClient.Runtime.enable();
  const uiErrors = [];
  ideClient.Runtime.exceptionThrown(({ exceptionDetails }) => uiErrors.push(exceptionDetails.text));
  ideClient.Runtime.consoleAPICalled(({ type, args }) => {
    if (type === 'error') uiErrors.push(args.map(argument => argument.value || argument.description || '').join(' '));
  });
  await ideClient.Page.navigate({ url: base });
  await waitFor(async () => (await ideClient.Runtime.evaluate({ expression: 'document.readyState', returnByValue: true })).result.value === 'complete');
  await waitFor(async () => (await ideClient.Runtime.evaluate({ expression: 'Boolean(document.querySelector("#html-editor .monaco-editor")) && document.querySelector("#html-editor-fallback").hidden', returnByValue: true })).result.value);
  assert.deepEqual(uiErrors, []);
  current = await request('/dom');
  console.log('PASS: workbench route loads Monaco under CSP with no browser console errors');

  await edit('attribute', 'sample-title', { name: 'data-test', value: 'quoted "value" <safe>' });
  assert.equal(await evaluate('document.querySelector("#sample-title").getAttribute("data-test")'), 'quoted "value" <safe>');
  await undo(); assert.equal(await evaluate('document.querySelector("#sample-title").hasAttribute("data-test")'), false);
  await edit('attribute', 'sample-card', { name: 'class', value: null }); await undo();
  assert.equal(await evaluate('document.querySelector("#sample-card").className'), 'note-card');
  await edit('attribute', 'sample-title', { name: 'id', value: 'renamed-title' }); await undo(); assert.ok(node('sample-title'));
  await edit('attribute', 'sample-card', { oldName: 'data-category', name: 'data-renamed', value: 'practice' });
  assert.equal(await evaluate('document.querySelector("#sample-card").getAttribute("data-renamed")'), 'practice');
  assert.equal(await evaluate('document.querySelector("#sample-card").hasAttribute("data-category")'), false);
  await undo(); assert.equal(await evaluate('document.querySelector("#sample-card").getAttribute("data-category")'), 'practice');
  console.log('PASS: add, remove and rename attributes; undo restores absent vs empty values');

  await edit('style', 'sample-title', { property: 'color', value: 'rgb(200, 30, 40)', priority: 'important' });
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#sample-title")).color'), 'rgb(200, 30, 40)');
  assert.equal(await evaluate('document.querySelector("#sample-title").style.getPropertyPriority("color")'), 'important');
  await request('/edit/style', { ...node('sample-title'), property: 'color', value: 'not-a-color' }, 409);
  await edit('style', 'sample-title', { property: '--test', value: 'quote " ; text' }); await undo(); await undo();
  assert.equal(await evaluate('document.querySelector("#sample-title").hasAttribute("style")'), false);
  console.log('PASS: inline style, !important, custom properties, invalid CSS rejection and exact style undo');

  const ruleDetail = await request(`/select/${node('sample-title').nodeId}`, node('sample-title'));
  const editableRule = ruleDetail.matched.matchedCSSRules.map(item => item.rule).find(rule => rule.styleSheetId && rule.style?.range && rule.selectorList?.text === 'h1');
  assert.ok(editableRule, 'An editable h1 rule exists');
  const ruleText = editableRule.style.cssText;
  current = await request('/edit/rule', { ...node('sample-title'), styleSheetId: editableRule.styleSheetId, range: editableRule.style.range, before: ruleText, text: `${ruleText}\ncolor: rgb(12, 34, 56);`, selector: 'h1' });
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#sample-title")).color'), 'rgb(12, 34, 56)');
  await undo(); assert.notEqual(await evaluate('getComputedStyle(document.querySelector("#sample-title")).color'), 'rgb(12, 34, 56)');
  console.log('PASS: matched stylesheet declarations edit live and undo exactly');

  const heading = flatten(current.tree).find(candidate => candidate.localName === 'h1' && (candidate.attributes || []).includes('sample-title'));
  const textNode = heading.children.find(candidate => candidate.nodeType === 3);
  const textDetail = await request(`/select/${textNode.nodeId}`, { nodeId: textNode.nodeId, backendNodeId: textNode.backendNodeId, session: current.session });
  assert.equal(textDetail.outerHTML, textNode.nodeValue);
  let preview = await request('/preview/text', { nodeId: textNode.nodeId, backendNodeId: textNode.backendNodeId, session: current.session, value: 'Live while typing' });
  assert.match(await evaluate('document.querySelector("#sample-title").textContent'), /^Live while typing/);
  current = await request('/preview/text/cancel', { draftId: preview.draftId, session: current.session });
  assert.match(await evaluate('document.querySelector("#sample-title").textContent'), /^Good things take/); assert.equal(current.history.length, 0);
  const refreshedHeading = flatten(current.tree).find(candidate => candidate.localName === 'h1' && (candidate.attributes || []).includes('sample-title'));
  const refreshedText = refreshedHeading.children.find(candidate => candidate.nodeType === 3);
  preview = await request('/preview/text', { nodeId: refreshedText.nodeId, backendNodeId: refreshedText.backendNodeId, session: current.session, value: 'Committed live text' });
  preview = await request('/preview/text', { nodeId: refreshedText.nodeId, backendNodeId: refreshedText.backendNodeId, session: current.session, draftId: preview.draftId, value: 'Committed live text final' });
  current = await request('/preview/text/commit', { draftId: preview.draftId, session: current.session });
  assert.equal(current.history.length, 1); assert.match(await evaluate('document.querySelector("#sample-title").textContent'), /^Committed live text final/);
  await undo(); assert.match(await evaluate('document.querySelector("#sample-title").textContent'), /^Good things take/);
  const currentHeading = flatten(current.tree).find(candidate => candidate.localName === 'h1' && (candidate.attributes || []).includes('sample-title'));
  const currentText = currentHeading.children.find(candidate => candidate.nodeType === 3);
  current = await request('/edit/text', { nodeId: currentText.nodeId, backendNodeId: currentText.backendNodeId, session: current.session, value: 'Edited directly' });
  assert.match(await evaluate('document.querySelector("#sample-title").textContent'), /^Edited directly/);
  await undo(); assert.match(await evaluate('document.querySelector("#sample-title").textContent'), /^Good things take/);
  console.log('PASS: live text preview, cancel, single-entry commit, direct text editing and undo');

  await evaluate(`(() => { window.addEventListener('resize', () => { const title = document.querySelector('#sample-title'); if (!title || title.dataset.resizeRebuilt) return; const replacement = title.cloneNode(true); replacement.dataset.resizeRebuilt = 'true'; title.replaceWith(replacement); }, { once: true }); })()`);
  await edit('attribute', 'sample-title', { name: 'data-survives-resize', value: 'yes' });
  await client.Emulation.setDeviceMetricsOverride({ width: 960, height: 720, deviceScaleFactor: 1, mobile: false });
  await waitFor(() => evaluate('document.querySelector("#sample-title").dataset.survivesResize === "yes"'));
  await undo(); assert.equal(await evaluate('document.querySelector("#sample-title").hasAttribute("data-survives-resize")'), false);
  console.log('PASS: session edits survive responsive node replacement and undo after re-render');

  // The earlier attribute edit must remain undoable after replacing and restoring its ancestor.
  const original = await evaluate('document.querySelector("#sample-card").outerHTML');
  await edit('attribute', 'sample-title', { name: 'data-retained', value: 'yes' });
  const stale = node('sample-card');
  await evaluate('window.originalSibling = document.querySelector("#details"); window.originalHeading = document.querySelector("#sample-title")');
  await edit('html', 'sample-card', { outerHTML: '<article id="replacement">Live replacement</article><aside id="inserted-sibling">Second node</aside>' });
  assert.equal(await evaluate('document.querySelector("#replacement").textContent'), 'Live replacement');
  await request('/edit/attribute', { ...stale, name: 'data-stale', value: 'no' }, 409);
  await undo();
  assert.equal(await evaluate('document.querySelector("#details") === window.originalSibling'), true);
  assert.equal(await evaluate('document.querySelector("#sample-title") === window.originalHeading'), true);
  assert.equal(await evaluate('document.querySelector("#inserted-sibling")'), null);
  await undo(); assert.equal(await evaluate('document.querySelector("#sample-card").outerHTML'), original);
  await edit('html', 'sample-card', { outerHTML: '' }); assert.equal(await evaluate('document.querySelector("#sample-card")'), null); await undo();
  assert.equal(await evaluate('document.querySelector("#sample-card").outerHTML'), original);
  await edit('html', 'sample-card', { outerHTML: original }); assert.equal(current.changed, false); assert.equal(current.history.length, 0);
  console.log('PASS: multi-node HTML replacement, deletion, unchanged HTML, stale-node rejection, sibling identity and chained undo');

  await edit('attribute', 'sample-title', { name: 'data-conflict', value: 'ours' });
  await evaluate('document.querySelector("#sample-title").setAttribute("data-conflict", "page-changed")');
  await request('/undo', { session: current.session }, 409); assert.equal(await evaluate('document.querySelector("#sample-title").getAttribute("data-conflict")'), 'page-changed');
  await evaluate('document.querySelector("#sample-title").setAttribute("data-conflict", "ours")'); await undo();
  const previous = node('sample-title');
  await client.Page.reload();
  await waitFor(async () => (await request('/status')).session !== previous.session);
  await request('/edit/attribute', { ...previous, name: 'data-stale', value: 'no' }, 409); assert.deepEqual(await request('/history'), []);
  current = await request('/dom'); assert.ok(node('sample-title'));
  console.log('PASS: conflict-safe undo, navigation invalidation, history clearing and document recovery');

  const second = await CDP.New({ host: '127.0.0.1', port, url: 'about:blank' });
  await request('/connect', { targetId: second.id });
  await request('/edit/attribute', { ...node('sample-title'), name: 'data-wrong-target', value: 'no' }, 409);
  await CDP.Close({ host: '127.0.0.1', port, id: second.id });
  await waitFor(async () => !(await request('/status')).connected);
  await request('/dom', undefined, 409);
  console.log('PASS: explicit target switching, old-session rejection and closed-tab recovery');
  console.log('All live CDP checks passed.');
} catch (error) { failure = error; }
finally {
  await ideClient?.close().catch(() => {});
  if (ideTarget) await CDP.Close({ host: '127.0.0.1', port, id: ideTarget.id }).catch(() => {});
  await client?.close().catch(() => {});
  await inspector?.disconnect();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (port) {
    try { const browser = await CDP({ host: '127.0.0.1', port, target: (await CDP.Version({ host: '127.0.0.1', port })).webSocketDebuggerUrl, local: true }); await browser.Browser.close(); } catch { chrome.kill(); }
  } else chrome.kill();
  // Delete only the exact temporary directory created by this test, after Chrome exits.
  if (path.dirname(profile) === path.resolve(tmpdir()) && path.basename(profile).startsWith('element-ide-test-')) {
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(error => console.warn(`Temporary Chrome profile retained: ${error.code}`));
  }
}
if (failure) { console.error(failure); process.exitCode = 1; }
