// Agent Bridge - MV3 service worker
// 连接本地 WS 服务端并执行浏览器命令。
// 保活:Chrome 116+ 活跃 WebSocket 连接可保持 service worker 存活,外加心跳 + alarms 兜底。

const DEFAULT_SERVER = 'ws://127.0.0.1:9333';
let ws = null;
let connected = false;
let seq = 0;
const pending = new Map(); // id -> {resolve, reject}

const log = (...a) => console.log('[agent-bridge]', ...a);

// ---------- server connection ----------
function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  chrome.storage.local.get('serverUrl').then(({ serverUrl }) => {
    const url = serverUrl || DEFAULT_SERVER;
    log('connecting to', url);
    const sock = new WebSocket(url);
    ws = sock;
    sock.onopen = () => {
      connected = true;
      log('connected');
      setBadge(true);
      send({ type: 'hello', extension: 'chrome-agent-bridge', version: chrome.runtime.getManifest().version });
      // 心跳:保持 WS 活跃(防止 service worker 空闲挂起)
      if (!sock._hb) sock._hb = setInterval(() => {
        if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: 'ping' }));
      }, 15000);
    };
    sock.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'ping') { sock.send(JSON.stringify({ type: 'pong' })); return; }
      handle(msg).then(
        (data) => send({ id: msg.id, ok: true, data }),
        (err) => send({ id: msg.id, ok: false, error: String(err && err.message || err) })
      );
    };
    sock.onclose = () => {
      connected = false;
      setBadge(false);
      log('disconnected');
      if (sock._hb) { clearInterval(sock._hb); sock._hb = null; }
      rejectAll(new Error('server connection closed'));
      ws = null;
    };
    sock.onerror = () => { /* onclose follows */ };
  });
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
    return true;
  }
  // 未连接:直接失败(防止 pending 悬挂)
  const err = new Error('not connected to server');
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id).reject(err); pending.delete(msg.id); }
  return false;
}

function rejectAll(err) {
  for (const [id, p] of pending) { p.reject(err); pending.delete(id); }
}

function setBadge(ok) {
  try {
    chrome.action.setBadgeText({ text: ok ? 'ON' : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#2e7d32' });
  } catch {}
}

// ---------- command dispatch ----------
async function handle(msg) {
  if (typeof msg.id !== 'number' && typeof msg.id !== 'string') return { type: 'event' };
  const { cmd, params = {} } = msg;
  switch (cmd) {
    case 'ping': return 'pong';
    case 'getState': return { connected: true, version: chrome.runtime.getManifest().version, server: await getServerUrl() };
    case 'listTabs': return listTabs();
    case 'newTab': return newTab(params.url);
    case 'closeTab': return closeTab(params.tabId);
    case 'activateTab': return activateTab(params.tabId);
    case 'navigate': return navigate(params.tabId, params.url);
    case 'refresh': return refresh(params.tabId);
    case 'eval': return evalInTab(params.tabId, params.expression, params);
    case 'getText': return evalInTab(params.tabId, TEXT_EXPR, {});
    case 'getHTML': return evalInTab(params.tabId, 'document.documentElement.outerHTML', {});
    case 'getTitle': return evalInTab(params.tabId, 'document.title', {});
    case 'waitFor': return waitFor(params.tabId, params.selector, params.timeout || 30000);
    case 'screenshot': return screenshot(params.tabId);
    case 'getCookies': return getCookies(params.url);
    case 'setCookie': return setCookie(params);
    default: throw new Error('unknown command: ' + cmd);
  }
}

// ---------- tab ops ----------
async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map(t => ({ id: t.id, windowId: t.windowId, active: t.active, url: t.url, title: t.title }));
}
async function newTab(url) {
  const t = await chrome.tabs.create({ url: url || 'chrome://newtab/' });
  // create 返回时导航可能未完成,url 为空;等待首个导航完成
  const full = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(t), 8000);
    const listener = (tabId, info) => {
      if (tabId === t.id && info.url) { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); resolve({ ...t, url: info.url }); }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
  return { id: full.id, windowId: full.windowId, url: full.url, title: full.title };
}
async function closeTab(tabId) { await chrome.tabs.remove(tabId); return true; }
async function activateTab(tabId) {
  const t = await chrome.tabs.get(tabId);
  await chrome.windows.update(t.windowId, { focused: true });
  await chrome.tabs.update(tabId, { active: true });
  return true;
}
async function navigate(tabId, url) { const t = await chrome.tabs.update(tabId, { url }); return { id: t.id, url: t.url }; }
async function refresh(tabId) { await chrome.tabs.reload(tabId); return true; }

// ---------- page eval (chrome.debugger = CDP Runtime.evaluate, 不受页面 CSP 限制) ----------
const TEXT_EXPR = `(() => {
  const main = document.querySelector('main, article, #content, .document, [role="main"]');
  return (main || document.body).innerText;
})()`;

const attachedTabs = new Set(); // 已附加 debugger 的 tab,保持附加直到 tab 关闭

async function attachDebug(tabId) {
  if (attachedTabs.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, '1.3');
  attachedTabs.add(tabId);
}

async function evalInTab(tabId, expression, { awaitPromise = false, world = 'ISOLATED' } = {}) {
  if (!tabId) throw new Error('tabId required');
  await attachDebug(tabId);
  const res = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: !!awaitPromise,
  });
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error('JS error: ' + (d.exception && d.exception.description || d.text));
  }
  return res.result && res.result.value;
}

async function waitFor(tabId, selector, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const found = await evalInTab(tabId, `!!document.querySelector(${JSON.stringify(selector)})`);
      if (found) return true;
    } catch {}
    await sleep(300);
  }
  throw new Error('timeout waiting for selector: ' + selector);
}

// ---------- screenshot / cookies ----------
async function screenshot(tabId) {
  const t = await chrome.tabs.get(tabId);
  await chrome.windows.update(t.windowId, { focused: true });
  await chrome.tabs.update(tabId, { active: true });
  await sleep(400); // wait for tab to be visible
  const dataUrl = await chrome.tabs.captureVisibleTab(t.windowId, { format: 'png' });
  return dataUrl; // base64 data URL, server side converts to file
}

async function getCookies(url) {
  const cookies = await chrome.cookies.getAll({ url });
  return cookies.map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, session: c.session, expirationDate: c.expirationDate }));
}
async function setCookie({ url, name, value, domain, path, secure, httpOnly, expirationDate }) {
  const c = { url, name, value };
  if (domain) c.domain = domain;
  if (path) c.path = path;
  if (secure) c.secure = true;
  if (httpOnly) c.httpOnly = true;
  if (expirationDate) c.expirationDate = expirationDate;
  await chrome.cookies.set(c);
  return true;
}

// ---------- helpers ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function getServerUrl() {
  const { serverUrl } = await chrome.storage.local.get('serverUrl');
  return serverUrl || DEFAULT_SERVER;
}
function setServerUrl(url) { return chrome.storage.local.set({ serverUrl: url }); }

// ---------- lifecycle ----------
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.alarms.create('bridge-reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'bridge-reconnect') connect(); });

// popup 通信
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'getState') {
    getServerUrl().then(server => sendResponse({ connected, server }));
    return true;
  }
  if (msg.type === 'reconnect') {
    if (ws) ws.close();
    connect();
    sendResponse({ ok: true });
  }
});

connect();
