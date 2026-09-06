import express from 'express';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Inspector, InspectorError } from './cdp.js';
import { ExtensionBridge, attachExtensionBridge } from './extension-bridge.js';
import { requestHarness } from './ai-harness.js';

const directory = path.dirname(fileURLToPath(import.meta.url));
export function createApp(inspector) {
  const extensionBridge = new ExtensionBridge();
  inspector ||= new Inspector({ port: Number(process.env.CDP_PORT || 9222), extensionBridge });
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const requestId = randomUUID();
    req.requestId = requestId;
    res.set('X-Request-ID', requestId);
    const allowed = new Set(['localhost', '127.0.0.1', '[::1]']);
    let host;
    try { host = new URL(`http://${req.headers.host}`).hostname; } catch { /* rejected below */ }
    const isExtensionFrameNavigation = req.method === 'GET'
      && req.path === '/'
      && req.query.extension === '1'
      && req.headers['sec-fetch-mode'] === 'navigate'
      && ['iframe', 'frame'].includes(req.headers['sec-fetch-dest']);
    if (!allowed.has(host)) return res.status(403).json({ error: 'Only localhost access is allowed.' });
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return res.status(403).json({ error: 'Cross-origin access is not allowed.' });
    if (req.headers['sec-fetch-site'] === 'cross-site' && !isExtensionFrameNavigation) return res.status(403).json({ error: 'Cross-site access is not allowed.' });
    if (req.method !== 'GET' && req.headers['x-inspector-request'] !== '1') return res.status(403).json({ error: 'The inspector request header is required.' });
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'self' chrome-extension:" });
    next();
  });
  app.use(express.json({ limit: '2mb' }));
  app.get('/healthz', (req, res) => res.json({ ok: true, service: 'element-ide', version: '1.0.0', requestId: req.requestId, ...inspector.state() }));
  const route = (method, url, handler) => app[method](url, async (req, res, next) => {
    try { res.json(await inspector.run(() => handler(req))); } catch (error) { next(error); }
  });
  route('get', '/targets', () => inspector.targets());
  route('get', '/status', () => inspector.state());
  route('post', '/connect', req => inspector.connect(req.body.targetId));
  route('post', '/disconnect', async () => { await inspector.disconnect(); return inspector.state(); });
  route('get', '/dom', async () => ({ tree: await inspector.getDocument(), ...inspector.state() }));
  route('post', '/select/:nodeId', req => inspector.details({ ...req.body, nodeId: Number(req.params.nodeId) }));
  route('post', '/details/:pane', req => inspector.pane(req.params.pane, req.body));
  route('post', '/highlight', async req => { await inspector.highlight(req.body); return { ok: true }; });
  route('post', '/highlight/clear', async () => { await inspector.hideHighlight(); return { ok: true }; });
  route('post', '/inspect', async req => { await inspector.inspectMode(req.body.enabled === true, req.body.session); return { ok: true }; });
  for (const kind of ['html', 'attribute', 'style', 'text']) route('post', `/edit/${kind}`, req => inspector.edit(kind, req.body));
  route('post', '/preview/text', req => inspector.previewText(req.body));
  route('post', '/preview/text/commit', req => inspector.finishTextPreview('commit', req.body));
  route('post', '/preview/text/cancel', req => inspector.finishTextPreview('cancel', req.body));
  route('post', '/api/v1/ai/plan', req => requestHarness(req.body));
  route('post', '/edit/rule', req => inspector.editStyleSheet('rule', req.body));
  route('post', '/edit/selector', req => inspector.editStyleSheet('selector', req.body));
  route('post', '/pseudo', req => inspector.forcePseudoState(req.body));
  route('post', '/breakpoint', req => inspector.setBreakpoint(req.body));
  route('post', '/debugger/resume', async req => { await inspector.resume(req.body.session); return inspector.state(); });
  route('get', '/history', () => inspector.publicHistory());
  route('post', '/undo', req => inspector.undo(req.body.session));
  app.get('/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ type: 'status', ...inspector.state() })}\n\n`);
    const listener = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
    inspector.on('update', listener);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 20000);
    req.on('close', () => { clearInterval(heartbeat); inspector.off('update', listener); });
  });
  app.use('/vendor/monaco', express.static(path.join(directory, 'node_modules', 'monaco-editor', 'min')));
  app.use(express.static(path.join(directory, 'public')));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    let status = error.status || 502;
    let message = error.message || 'The inspected browser could not complete this request.';
    if (/Could not find node|No node with given|Could not find object|Cannot find context|Inspected target navigated/i.test(message)) {
      status = 409; message = 'The element changed or the tab navigated. Refresh the tree and select it again.';
    } else if (!(error instanceof InspectorError) && status === 502) {
      message = `The inspected browser could not complete the request: ${message}. Refresh the tree or reconnect.`;
    }
    res.status(status).json({ ok: false, error: message, requestId: req.requestId });
  });
  return { app, inspector, extensionBridge };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { app, inspector, extensionBridge } = createApp();
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  const server = app.listen(port, host, () => console.log(`Element IDE is running at http://${host}:${port}`));
  attachExtensionBridge(server, extensionBridge);
  server.on('error', error => { console.error(`Unable to start: ${error.message}`); process.exitCode = 1; });
  const shutdown = async () => { await inspector.disconnect(); server.closeAllConnections(); server.close(); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
