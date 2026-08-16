# Chrome Agent Bridge

浏览器插件形式的 Agent 桥:让外部 Agent(pi 等)通过本地 WebSocket 操作**你日常使用的 Chrome**(带完整登录态),作为 chrome-cdp(独立配置目录、无登录态)的 **B 方案**。

```
┌────────────┐  WS 127.0.0.1:9333  ┌────────────────────┐  Chrome API  ┌──────────────┐
│  Agent/CLI │ ──────────────────▶ │  bridge-server.mjs │ ───────────▶ │ Chrome 扩展  │
│ bridge.mjs │ ◀────────────────── │  (本地服务端)       │ ◀─────────── │ Agent Bridge │
└────────────┘                     └────────────────────┘              └──────┬───────┘
                                                                              │ scripting / tabs / cookies
                                                                         ┌────▼──────┐
                                                                         │ 真实页面   │
                                                                         └───────────┘
```

## 特性

- ✅ **登录态完整复用**——运行在用户日常 Chrome profile 中
- ✅ 操作 tab:新建/切换/导航/刷新/关闭
- ✅ 页面执行 JS:基于 `chrome.debugger`(等价 CDP `Runtime.evaluate`),**不受页面 CSP 限制**,支持 async/await、可访问页面内变量与 fetch 网络请求
- ✅ 抓取:正文文本 / 完整 HTML / 标题
- ✅ 等待元素出现(`waitFor`,前端测试断言)
- ✅ 截图(自动激活 tab 后截取)
- ✅ Cookie 读取/写入(复用登录态的核心能力)
- 🔒 仅监听 127.0.0.1,不暴露公网

## 安装

### 1. 启动服务端(一次)

```bash
./scripts/start-server.sh        # 幂等,依赖自动安装
```

### 2. 安装扩展

1. 打开 `chrome://extensions`
2. 右上角开启「开发者模式」
3. 点「加载已解压的扩展程序」→ 选择本目录的 `extension/` 文件夹
4. 扩展图标出现后,应显示 **ON** 徽标(连接成功)

> 命令行方式(CDP 测试实例):`Google Chrome --load-extension=<绝对路径>/extension ...`

### 3. 使用 CLI

```bash
node scripts/bridge.mjs status                      # 服务端+扩展连接状态
node scripts/bridge.mjs list                        # 列出所有 tab
node scripts/bridge.mjs open "https://example.com"  # 新开 tab(记住 tabId)
node scripts/bridge.mjs text                        # 抓当前 tab 正文(省略 tabId 用最近一个)
node scripts/bridge.mjs text 123                    # 指定 tabId
node scripts/bridge.mjs eval 123 'document.title'
node scripts/bridge.mjs eval 123 'fetch("/api/x").then(r=>r.json())' --async
node scripts/bridge.mjs wait 123 '#app' 15000       # 等元素出现
node scripts/bridge.mjs screenshot 123 /tmp/s.png   # 截图(自动激活 tab)
node scripts/bridge.mjs cookies "https://example.com"
node scripts/bridge.mjs close 123
```

## 安全说明

- 服务端只监听 `127.0.0.1`;扩展只连接本机地址(可在 popup 中修改,默认 `ws://127.0.0.1:9333`)
- 该桥能读取 cookie、在任意页面执行 JS,能力等同 DevTools —— **不要**把端口暴露到公网,也不要安装来路不明的扩展修改版
- 页面执行通过 `chrome.debugger` API,被调试的 tab 顶部会出现「正在调试」提示条,属正常现象;关闭该 tab 后自动解除
- 表达式在页面主世界执行,可直接访问页面变量(如 `window.__INITIAL_STATE__`)、发起 fetch

## 与 chrome-cdp skill 的分工

| | chrome-cdp | Agent Bridge(本方案) |
|---|---|---|
| 优先级 | 回退 / 独立环境 | **默认首选** |
| 登录态 | ❌ 独立配置目录 | ✅ 用户日常浏览器 |
| 页面执行 | CDP `Runtime.evaluate` | debugger API(等价 CDP) |
| 依赖 | Node 内置,零依赖 | 需 `ws` 包 + 手动装扩展 |
| 适用 | 无头/CI/快速抓公开页 | 需登录态、用户可见会话 |

**决策**:浏览器控制任务默认先 `bridge.sh status` 检查扩展连接 —— 可用则用本方案(登录态价值高);不可用或需要独立/无头环境时回退 chrome-cdp。

## 目录

```
extension/            Chrome 扩展(MV3)
  manifest.json
  background.js       service worker:WS 客户端 + 命令分发
  popup.html/js       连接状态/服务端地址
server/
  bridge-server.mjs   本地 WS 服务端(127.0.0.1:9333)
scripts/
  start-server.sh     服务端启动(幂等)
  bridge.mjs          CLI 客户端
```
