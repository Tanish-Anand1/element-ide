import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { WebSocket } from 'ws';
import { createApp } from '../server.js';
import { Inspector } from '../cdp.js';
import { attachExtensionBridge } from '../extension-bridge.js';

test('extension opens a tab-scoped side panel without a popup', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.minimum_chrome_version, '116');
  assert.ok(manifest.permissions.includes('sidePanel'));
  assert.equal(manifest.side_panel.default_path, 'sidepanel.html');
  assert.equal(manifest.action.default_popup, undefined);
  await Promise.all(['sidepanel.html', 'sidepanel.css', 'sidepanel.js'].map(file => readFile(new URL(`../extension/${file}`, import.meta.url), 'utf8')));
});

test('local API enforces its trust boundary and handles disconnected requests', async t => {
  const { app, inspector } = createApp(new Inspector({ port: 1 }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (url, body, headers = {}) => fetch(base + url, { method: body ? 'POST' : 'GET', headers: { ...(body ? { 'Content-Type': 'application/json', 'X-Inspector-Request': '1' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  await t.test('serves the real interface and restrictive headers', async () => {
    const response = await request('/'); assert.equal(response.status, 200); assert.match(await response.text(), /DOM workbench/);
    const health = await request('/healthz'); assert.equal(health.status, 200); assert.equal((await health.json()).ok, true); assert.ok(health.headers.get('x-request-id'));
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'self' chrome-extension:/);
    assert.match(response.headers.get('content-security-policy'), /worker-src 'self' blob:/);
    const editor = await request('/vendor/monaco/vs/loader.js'); assert.equal(editor.status, 200); assert.match(editor.headers.get('content-type'), /javascript/);
  });
  await t.test('blocks external hosts, origins and cross-site requests', async () => {
    const hostStatus = await new Promise((resolve, reject) => { const req = http.get(base + '/status', { headers: { Host: 'malicious.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); });
    assert.equal(hostStatus, 403);
    assert.equal((await request('/connect', {}, { Origin: 'https://malicious.example' })).status, 403);
    assert.equal((await request('/status', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await fetch(base + '/disconnect', { method: 'POST' })).status, 403);
  });
  await t.test('allows only the side-panel document to navigate in an extension frame', async () => {
    const navigate = pathname => new Promise((resolve, reject) => {
      const req = http.get(base + pathname, { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
    });
    assert.equal(await navigate('/?extension=1'), 200);
    assert.equal(await navigate('/status?extension=1'), 403);
    assert.equal(await navigate('/'), 403);
  });
  await t.test('reports an absent browser and no connection clearly', async () => {
    assert.equal((await request('/targets')).status, 503);
    const response = await request('/dom'); assert.equal(response.status, 409); assert.match((await response.json()).error, /Connect/);
    assert.equal((await request('/undo', { session: inspector.session })).status, 409);
  });
  await t.test('rejects malformed JSON without crashing', async () => {
    const response = await fetch(base + '/connect', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Inspector-Request': '1' }, body: '{broken' });
    assert.equal(response.status, 400); assert.ok((await response.json()).error);
    assert.equal((await request('/status')).status, 200);
  });
});

test('a failed queued operation does not block the next one', async () => {
  const inspector = new Inspector();
  const order = [];
  const first = inspector.run(async () => { order.push(1); throw Error('expected'); });
  const second = inspector.run(async () => { order.push(2); return 42; });
  await assert.rejects(first, /expected/); assert.equal(await second, 42); assert.deepEqual(order, [1, 2]);
});

test('a signed-in extension tab can attach through the local bridge', async t => {
  const { app, inspector, extensionBridge } = createApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  attachExtensionBridge(server, extensionBridge);
  const base = `http://127.0.0.1:${server.address().port}`;
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/extension`, { headers: { Origin: 'chrome-extension://element-test' } });
  const methods = [];
  socket.on('message', data => {
    const message = JSON.parse(data.toString());
    if (message.type !== 'request') return;
    methods.push(message.method);
    const result = message.method === 'DOM.getDocument'
      ? { root: { nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '', nodeValue: '', children: [] } }
      : {};
    socket.send(JSON.stringify({ type: 'response', id: message.id, result }));
  });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.send(JSON.stringify({ type: 'hello', tab: { tabId: 41, title: 'Signed-in account', url: 'https://example.test/account' } }));
  await new Promise(resolve => extensionBridge.once('update', resolve));
  t.after(async () => {
    await inspector.disconnect();
    socket.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });

  const targets = await (await fetch(`${base}/targets`)).json();
  const target = targets.find(candidate => candidate.id === 'extension:41');
  assert.ok(target); assert.match(target.title, /signed-in/);
  const response = await fetch(`${base}/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Inspector-Request': '1' },
    body: JSON.stringify({ targetId: target.id }),
  });
  const connected = await response.json();
  assert.equal(response.status, 200); assert.equal(connected.connected, true); assert.equal(connected.tree.nodeName, '#document');
  assert.deepEqual(methods.slice(0, 9), ['Browser.attach', 'DOM.enable', 'CSS.enable', 'Runtime.enable', 'Overlay.enable', 'Page.enable', 'Accessibility.enable', 'Debugger.enable', 'DOM.getDocument']);
});
