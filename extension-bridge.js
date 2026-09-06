import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';

class ExtensionProtocolClient extends EventEmitter {
  constructor(bridge, target) {
    super();
    this.bridge = bridge;
    this.target = target;
    this.closed = false;
    for (const domain of ['DOM', 'CSS', 'Runtime', 'Overlay', 'Page', 'DOMDebugger', 'Accessibility', 'Debugger']) {
      this[domain] = new Proxy({}, {
        get: (_, command) => (...args) => {
          if (args.length === 1 && typeof args[0] === 'function') {
            this.on(`${domain}.${String(command)}`, args[0]);
            return undefined;
          }
          return this.bridge.request(`${domain}.${String(command)}`, args[0] || {});
        },
      });
    }
  }

  dispatch(method, params) { this.emit(method, params); }

  disconnect() {
    if (this.closed) return;
    this.closed = true;
    this.emit('disconnect');
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.bridge.client = null;
    await this.bridge.request('Browser.detach', { tabId: this.target.tabId }).catch(() => {});
  }
}

export class ExtensionBridge extends EventEmitter {
  constructor() {
    super();
    this.socket = null;
    this.target = null;
    this.client = null;
    this.pending = new Map();
  }

  targets() {
    return this.socket?.readyState === WebSocket.OPEN && this.target
      ? [{ id: `extension:${this.target.tabId}`, title: `${this.target.title || 'Untitled'} [signed-in]`, url: this.target.url, transport: 'extension' }]
      : [];
  }

  accept(socket) {
    this.socket?.close(1000, 'Replaced by a newer extension connection.');
    this.socket = socket;
    this.target = null;
    socket.on('message', data => this.receive(data));
    socket.on('close', () => this.drop(socket, 'The browser extension disconnected.'));
    socket.on('error', () => this.drop(socket, 'The browser extension connection failed.'));
  }

  receive(data) {
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
    if (message.type === 'hello' && Number.isInteger(message.tab?.tabId)) {
      this.target = message.tab;
      this.emit('update', this.targets());
    } else if (message.type === 'response' && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      message.error ? reject(new Error(message.error)) : resolve(message.result || {});
    } else if (message.type === 'event') {
      if (message.method === 'Browser.detached') this.client?.disconnect();
      else this.client?.dispatch(message.method, message.params || {});
    }
  }

  drop(socket, reason) {
    if (this.socket !== socket) return;
    this.socket = null;
    this.target = null;
    this.client?.disconnect();
    this.client = null;
    for (const { reject } of this.pending.values()) reject(new Error(reason));
    this.pending.clear();
    this.emit('update', []);
  }

  request(method, params = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('The browser extension is not connected. Click its toolbar button on the tab again.'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The browser extension did not answer ${method}.`));
      }, 12000);
      this.pending.set(id, {
        resolve: result => { clearTimeout(timer); resolve(result); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      this.socket.send(JSON.stringify({ type: 'request', id, method, params }));
    });
  }

  async connect(targetId) {
    const target = this.targets().find(candidate => candidate.id === targetId);
    if (!target) throw new Error('That signed-in tab is no longer shared. Click the Element extension on it again.');
    await this.request('Browser.attach', { tabId: this.target.tabId });
    this.client = new ExtensionProtocolClient(this, this.target);
    return this.client;
  }
}

export function attachExtensionBridge(server, bridge) {
  const webSockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    let url;
    try { url = new URL(request.url, 'http://127.0.0.1'); } catch { socket.destroy(); return; }
    const origin = request.headers.origin || '';
    if (url.pathname !== '/extension' || !origin.startsWith('chrome-extension://')) { socket.destroy(); return; }
    webSockets.handleUpgrade(request, socket, head, connection => bridge.accept(connection));
  });
  return webSockets;
}
