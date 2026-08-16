#!/usr/bin/env node
// Agent Bridge CLI - 向本地服务端发命令并输出结果
//
// 用法:
//   node bridge.mjs status
//   node bridge.mjs list
//   node bridge.mjs open <url>
//   node bridge.mjs navigate <tabId> <url>
//   node bridge.mjs refresh <tabId>
//   node bridge.mjs activate <tabId>
//   node bridge.mjs close <tabId>
//   node bridge.mjs title [tabId]
//   node bridge.mjs text [tabId]
//   node bridge.mjs html [tabId]
//   node bridge.mjs eval <tabId> '<js>' [--async] [--world MAIN]
//   node bridge.mjs wait <tabId> <selector> [timeoutMs]
//   node bridge.mjs screenshot [tabId] <out.png>
//   node bridge.mjs cookies <url>
//
// tabId 可省略时使用最近操作过的 tab(state 文件 ~/.chrome-bridge.json)。
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PORT = process.env.BRIDGE_PORT || 9333;
const URL = `ws://127.0.0.1:${PORT}`;
const STATE_FILE = join(homedir(), '.chrome-bridge.json');

function loadState() { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function saveState(s) { try { writeFileSync(STATE_FILE, JSON.stringify(s)); } catch {} }

function parseArgs() {
  const a = process.argv.slice(2);
  const opts = { async: false, world: 'ISOLATED' };
  const positional = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--async') opts.async = true;
    else if (a[i] === '--world') opts.world = a[++i];
    else positional.push(a[i]);
  }
  return { cmd: positional[0], args: positional.slice(1), opts };
}

async function request(cmd, params, timeoutMs = 60000) {
  const ws = new WebSocket(URL);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error(`无法连接服务端 ${URL}(先运行 scripts/start-server.sh)`)); });
  const id = Date.now() + Math.random();
  const result = new Promise((resolve) => {
    const timer = setTimeout(() => { ws.close(); resolve({ ok: false, error: `timeout (${timeoutMs}ms)` }); }, timeoutMs);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === id) { clearTimeout(timer); ws.close(); resolve(msg); }
    };
  });
  ws.send(JSON.stringify({ id, cmd, params }));
  return result;
}

async function main() {
  const { cmd, args, opts } = parseArgs();
  const state = loadState();

  if (cmd === 'status') {
    const r = await request('getState', {});
    console.log(JSON.stringify(r.data || r, null, 2));
    return;
  }

  const lastTab = state.lastTabId;
  const explicitTab = !!(args[0] && /^\d+$/.test(args[0]));
  const tabId = explicitTab ? parseInt(args[0], 10) : (lastTab ?? null);

  switch (cmd) {
    case 'list': {
      const r = await request('listTabs', {});
      if (!r.ok) { console.error(r.error); process.exit(1); }
      for (const t of r.data) console.log(`${t.id}\t${t.active ? '*' : ' '}\t${t.title || '(no title)'}\n    ${t.url}`);
      return;
    }
    case 'open': {
      const url = args[0];
      if (!url) { console.error('usage: bridge.mjs open <url>'); process.exit(1); }
      const r = await request('newTab', { url });
      if (!r.ok) { console.error(r.error); process.exit(1); }
      state.lastTabId = r.data.id;
      saveState(state);
      console.log(`opened tab ${r.data.id}: ${r.data.url}`);
      return;
    }
    case 'navigate': {
      const url = args[explicitTab ? 1 : 0];
      if (!url) { console.error('usage: bridge.mjs navigate [tabId] <url>'); process.exit(1); }
      const r = await request('navigate', { tabId, url });
      if (!r.ok) { console.error(r.error); process.exit(1); }
      console.log(`navigated tab ${r.data.id} -> ${r.data.url}`);
      return;
    }
    case 'refresh': {
      const r = await request('refresh', { tabId });
      if (!r.ok) { console.error(r.error); process.exit(1); }
      console.log('refreshed');
      return;
    }
    case 'activate': {
      const r = await request('activateTab', { tabId });
      if (!r.ok) { console.error(r.error); process.exit(1); }
      console.log(`activated tab ${tabId}`);
      return;
    }
    case 'close': {
      const r = await request('closeTab', { tabId });
      if (!r.ok) { console.error(r.error); process.exit(1); }
      console.log(`closed tab ${tabId}`);
      return;
    }
    case 'title':
    case 'text':
    case 'html': {
      if (tabId === null) { console.error('no tabId (先 open,或用 list 查看)'); process.exit(1); }
      const r = await request(cmd === 'title' ? 'getTitle' : cmd === 'text' ? 'getText' : 'getHTML', { tabId });
      if (!r.ok) { console.error(r.error); process.exit(1); }
      console.log(r.data);
      return;
    }
    case 'eval': {
      const expr = args.slice(explicitTab ? 1 : 0).join(' ').trim();
      if (!expr) { console.error('usage: bridge.mjs eval [tabId] <js> [--async] [--world MAIN]'); process.exit(1); }
      const r = await request('eval', { tabId, expression: expr, awaitPromise: opts.async, world: opts.world });
      if (!r.ok) { console.error(r.error); process.exit(1); }
      console.log(JSON.stringify(r.data, null, 2));
      return;
    }
    case 'wait': {
      const selector = args[explicitTab ? 1 : 0];
      const timeout = parseInt(args[explicitTab ? 2 : 1], 10) || 30000;
      const r = await request('waitFor', { tabId, selector, timeout });
      if (!r.ok) { console.error(r.error); process.exit(1); }
      console.log(`found: ${selector}`);
      return;
    }
    case 'screenshot': {
      const out = args[args.length - 1];
      if (!out) { console.error('usage: bridge.mjs screenshot [tabId] <out.png>'); process.exit(1); }
      const r = await request('screenshot', { tabId });
      if (!r.ok) { console.error(r.error); process.exit(1); }
      const b64 = String(r.data).replace(/^data:image\/png;base64,/, '');
      writeFileSync(out, Buffer.from(b64, 'base64'));
      console.log(`saved ${out}`);
      return;
    }
    case 'cookies': {
      const url = args[0];
      if (!url) { console.error('usage: bridge.mjs cookies <url>'); process.exit(1); }
      const r = await request('getCookies', { url });
      if (!r.ok) { console.error(r.error); process.exit(1); }
      console.log(JSON.stringify(r.data, null, 2));
      return;
    }
    default:
      console.error(`unknown command: ${cmd}`);
      process.exit(1);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
