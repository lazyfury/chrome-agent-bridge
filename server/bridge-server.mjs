#!/usr/bin/env node
// Agent Bridge 本地服务端
// - 监听 127.0.0.1:9333
// - 扩展(Agent Bridge extension)作为"执行端"连接
// - CLI/Agent 作为"控制端"连接,命令转发给扩展执行并回传结果
//
// 消息协议(JSON):
//   控制端 -> 服务端 : { id, cmd, params, target? }
//   扩展   -> 服务端 : { type:'hello', ... } | { id, ok, data|error } | { type:'ping' }
//   服务端 -> 控制端 : { id, ok, data|error } | { type:'event', ... }
import { WebSocketServer } from 'ws';

const PORT = parseInt(process.env.BRIDGE_PORT || '9333', 10);
const HOST = '127.0.0.1';

const wss = new WebSocketServer({ host: HOST, port: PORT });
const extensions = new Set(); // 扩展连接
const controllers = new Set(); // 控制端连接
const pending = new Map(); // id -> controller ws
let extSeq = 0;

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'hello') {
      // 扩展连接
      extensions.add(ws);
      ws.isExtension = true;
      ws.extId = 'ext-' + (++extSeq);
      console.log(`[server] extension connected: ${ws.extId} v${msg.version || '?'}`);
      broadcastControllers({ type: 'event', event: 'extension-connected', extId: ws.extId });
      return;
    }

    if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }

    if (ws.isExtension) {
      // 扩展回包
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { controller, extId } = pending.get(msg.id);
        pending.delete(msg.id);
        if (controller.readyState === controller.OPEN) {
          controller.send(JSON.stringify(msg));
        }
      }
      return;
    }

    // 控制端命令
    if (msg.id !== undefined && (msg.cmd || msg.type === 'getState')) {
      controllers.add(ws);
      ws.isController = true;
      const ext = pickExtension(msg.target);
      if (!ext) {
        ws.send(JSON.stringify({ id: msg.id, ok: false, error: 'no extension connected (请先安装并在浏览器中启用 Agent Bridge 扩展)' }));
        return;
      }
      if (msg.cmd === 'getState' || msg.cmd === 'ping') {
        // server-local commands
        ws.send(JSON.stringify({ id: msg.id, ok: true, data: { server: true, extensions: [...extensions].map(e => e.extId), port: PORT } }));
        return;
      }
      pending.set(msg.id, { controller: ws, extId: ext.extId });
      ext.send(JSON.stringify({ id: msg.id, cmd: msg.cmd, params: msg.params || {} }));
    }
  });

  ws.on('close', () => {
    if (ws.isExtension) {
      extensions.delete(ws);
      console.log(`[server] extension disconnected: ${ws.extId || '?'}`);
      broadcastControllers({ type: 'event', event: 'extension-disconnected' });
      // 该扩展的 pending 全部失败
      for (const [id, p] of pending) {
        if (p.extId === ws.extId) { pending.delete(id); p.controller.send(JSON.stringify({ id, ok: false, error: 'extension disconnected' })); }
      }
    }
    if (ws.isController) controllers.delete(ws);
  });
});

function pickExtension(target) {
  if (extensions.size === 0) return null;
  if (target) return [...extensions].find(e => e.extId === target) || null;
  return [...extensions][extensions.size - 1]; // 最近连接的扩展
}

function broadcastControllers(msg) {
  for (const c of controllers) if (c.readyState === c.OPEN) c.send(JSON.stringify(msg));
}

console.log(`[server] Agent Bridge server listening on ws://${HOST}:${PORT}`);
