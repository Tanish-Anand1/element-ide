let socket = null;
let targetTab = null;
let attachedTabId = null;
let serverPort = 3000;

setInterval(() => send({ type: 'ping' }), 20000);

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function announceTarget() {
  if (!targetTab) return;
  send({ type: 'hello', tab: { tabId: targetTab.id, title: targetTab.title || 'Untitled', url: targetTab.url || '' } });
}

async function detachCurrent() {
  if (!Number.isInteger(attachedTabId)) return;
  const tabId = attachedTabId;
  attachedTabId = null;
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

function connectSocket(port) {
  if (socket?.readyState === WebSocket.OPEN && serverPort === port) return Promise.resolve();
  socket?.close();
  serverPort = port;
  return new Promise((resolve, reject) => {
    const connection = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    const timeout = setTimeout(() => {
      connection.close();
      reject(new Error(`Element IDE did not answer on port ${port}. Run npm start first.`));
    }, 4000);
    connection.onopen = () => {
      clearTimeout(timeout);
      socket = connection;
      announceTarget();
      resolve();
    };
    connection.onerror = () => {
      clearTimeout(timeout);
      reject(new Error(`Element IDE is not reachable on port ${port}.`));
    };
    connection.onclose = () => {
      if (socket === connection) socket = null;
      void detachCurrent();
    };
    connection.onmessage = event => void handleBridgeRequest(JSON.parse(event.data));
  });
}

async function handleBridgeRequest(message) {
  if (message.type !== 'request') return;
  try {
    let result = {};
    if (message.method === 'Browser.attach') {
      if (!targetTab || message.params.tabId !== targetTab.id) throw new Error('The selected tab changed. Click the extension on it again.');
      if (attachedTabId !== targetTab.id) {
        await detachCurrent();
        await chrome.debugger.attach({ tabId: targetTab.id }, '1.3');
        attachedTabId = targetTab.id;
      }
    } else if (message.method === 'Browser.detach') {
      await detachCurrent();
    } else {
      if (!Number.isInteger(attachedTabId)) throw new Error('Connect to the signed-in tab first.');
      result = await chrome.debugger.sendCommand({ tabId: attachedTabId }, message.method, message.params || {}) || {};
    }
    send({ type: 'response', id: message.id, result });
  } catch (error) {
    send({ type: 'response', id: message.id, error: error.message || String(error) });
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId === attachedTabId) send({ type: 'event', method, params });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId !== attachedTabId) return;
  attachedTabId = null;
  send({ type: 'event', method: 'Browser.detached', params: { reason } });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (targetTab?.id !== tabId || (!changeInfo.title && !changeInfo.url)) return;
  targetTab = tab;
  announceTarget();
});

chrome.tabs.onRemoved.addListener(tabId => {
  if (targetTab?.id !== tabId) return;
  targetTab = null;
  if (attachedTabId === tabId) attachedTabId = null;
  send({ type: 'event', method: 'Browser.detached', params: { reason: 'target_closed' } });
});

async function inspectTab(tabId, port = serverPort) {
  if (!Number.isInteger(tabId)) throw new Error('No inspectable browser tab is active.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Enter a valid local IDE port from 1 to 65535.');
  const tab = await chrome.tabs.get(tabId);
  if (/^(chrome|edge|brave|vivaldi|about|chrome-extension):/.test(tab.url || '')) throw new Error('Browser settings and extension pages cannot be inspected.');
  if (attachedTabId && attachedTabId !== tabId) await detachCurrent();
  targetTab = tab;
  await chrome.storage.local.set({ serverPort: port });
  await connectSocket(port);
  announceTarget();
  return { ok: true, port, tab: { id: tab.id, title: tab.title || 'Untitled', url: tab.url || '' } };
}

chrome.action.onClicked.addListener(tab => {
  const opening = chrome.sidePanel.open({ tabId: tab.id });
  void (async () => {
    const saved = await chrome.storage.local.get('serverPort');
    const port = Number(saved.serverPort) || 3000;
    await opening;
    await inspectTab(tab.id, port);
  })().catch(error => {
    void chrome.runtime.sendMessage({ type: 'bridge-status', ok: false, error: error.message || String(error) }).catch(() => {});
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'bridge-status') {
    sendResponse({ ok: !!socket && socket.readyState === WebSocket.OPEN, port: serverPort, tab: targetTab && { id: targetTab.id, title: targetTab.title || 'Untitled', url: targetTab.url || '' } });
    return undefined;
  }
  if (message.type !== 'inspect-tab') return undefined;
  void (async () => {
    try {
      sendResponse(await inspectTab(message.tabId, message.port));
    } catch (error) {
      sendResponse({ ok: false, error: error.message || String(error) });
    }
  })();
  return true;
});
