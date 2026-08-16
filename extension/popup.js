const dot = document.getElementById('dot');
const statusEl = document.getElementById('status');
const urlInput = document.getElementById('url');
const saveBtn = document.getElementById('save');

async function refresh() {
  const { serverUrl } = await chrome.storage.local.get('serverUrl');
  urlInput.value = serverUrl || 'ws://127.0.0.1:9333';
  // 通过 background 查询状态
  chrome.runtime.sendMessage({ type: 'getState' }).then((s) => {
    dot.classList.toggle('on', !!s && s.connected);
    statusEl.textContent = s && s.connected ? '已连接' : '未连接';
  }).catch(() => {
    dot.classList.remove('on');
    statusEl.textContent = '未连接';
  });
}

saveBtn.addEventListener('click', async () => {
  await chrome.storage.local.set({ serverUrl: urlInput.value.trim() });
  statusEl.textContent = '已保存,请重启扩展生效';
  chrome.runtime.sendMessage({ type: 'reconnect' });
});

refresh();
