const frame = document.querySelector('#ide');
const form = document.querySelector('#connection-panel');
const portInput = document.querySelector('#server-port');
const portLabel = document.querySelector('#port-label');
const connectionButton = document.querySelector('#connection-button');
const status = document.querySelector('#status');

const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
const saved = await chrome.storage.local.get('serverPort');
portInput.value = String(Number(saved.serverPort) || 3000);

function load(port) {
  portLabel.textContent = String(port);
  frame.src = `http://127.0.0.1:${port}/?extension=1`;
}

function setConnected(connected) {
  document.body.classList.toggle('connected', connected);
  document.body.classList.toggle('disconnected', !connected);
  if (connected) form.hidden = true;
  connectionButton.setAttribute('aria-expanded', String(!form.hidden));
}

async function connect() {
  const port = Number(portInput.value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    status.textContent = 'Enter a port from 1 to 65535.';
    portInput.focus();
    return;
  }
  status.textContent = 'Connecting to the local IDE…';
  const response = await chrome.runtime.sendMessage({ type: 'inspect-tab', tabId: activeTab?.id, port });
  if (!response?.ok) {
    status.textContent = response?.error || 'The local IDE could not connect.';
    form.hidden = false;
    connectionButton.setAttribute('aria-expanded', 'true');
    setConnected(false);
    return;
  }
  status.textContent = `Inspecting ${response.tab.title}.`;
  load(port);
  form.hidden = true;
  setConnected(true);
}

connectionButton.addEventListener('click', () => {
  if (document.body.classList.contains('connected') && !form.hidden) {
    form.hidden = true; setConnected(true); return;
  }
  document.body.classList.remove('connected');
  form.hidden = !form.hidden;
  connectionButton.setAttribute('aria-expanded', String(!form.hidden));
  if (!form.hidden) portInput.focus();
});
form.addEventListener('submit', event => { event.preventDefault(); void connect(); });
window.addEventListener('message', event => {
  const expectedOrigin = `http://127.0.0.1:${Number(portInput.value) || 3000}`;
  if (event.source !== frame.contentWindow || event.origin !== expectedOrigin || event.data?.type !== 'element-settings') return;
  document.body.classList.remove('connected'); form.hidden = false; connectionButton.setAttribute('aria-expanded', 'true'); portInput.focus();
});
void connect();
