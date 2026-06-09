# 仓库指南

## 项目结构与模块组织

Tabminal 是一个 Node.js ESM 应用。后端入口是 `src/server.mjs`；终端生命周期代码位于
`src/terminal-session.mjs` 和 `src/terminal-manager.mjs`；ACP agent 监管逻辑位于
`src/acp-manager.mjs`。浏览器端 UI 主要在 `public/app.js`，样式在
`public/styles.css`，页面外壳标记在 `public/index.html`，共享前端辅助模块位于
`public/modules/`。测试位于 `test/`，浏览器冒烟脚本位于 `scripts/`，shell 集成文件位于
`shell/`，原生应用工作区位于 `apps/`。

## 构建、测试与开发命令

- `npm start -- --accept-terms`：运行本地服务。
- `npm run dev -- --accept-terms`：用 Node watch 模式监听 `src/` 和 `public/`。
- `npm run build`：运行 `build.mjs` 并生成可分发资源。
- `npm run lint`：对整个仓库运行 ESLint。
- `npm test`：运行完整 Node 测试套件。
- `node --test test/acp-manager.mjs`：运行指定测试文件。

验证 ACP UI 流程并使用内置测试 agent 时，使用
`TABMINAL_ENABLE_TEST_AGENT=1 npm start -- --accept-terms`。

用户测试服务脚本 `test.sh`，功能修改完成后，运行/重启此脚本供用户测试。若需要后台保活，使用
`setsid /bin/bash -lc 'cd /home/coder/git/Tabminal && exec /bin/bash test.sh' > /tmp/tabminal-test-7081.log 2>&1 < /dev/null &`；否则就在当前终端显式前台运行
`bash test.sh`。不要只用普通 `&` 或 `nohup` 启动后假设服务已保活，启动后必须确认 `7081` 可访问。

杀进程只能杀7081端口的进程，禁止杀其他进程

## 代码风格与命名约定

使用现代 ESM JavaScript，并遵循现有文件的两空格缩进。优先使用明确的辅助函数，避免临时的内联解析；新增抽象前先遵循附近代码模式。保持面向用户的标签一致：UI 术语是 `Host`，不是 `Server`。前端状态按 Host 隔离；不要跨 Host 合并会话、文件、agent 标签页或认证状态。

## 测试指南

测试使用 Node 内置测试运行器（`node --test`）和 `assert`。后端行为、持久化、ACP 状态变化和终端会话契约相关改动，应新增或更新聚焦测试。涉及重要 UI/ACP 改动时，运行相关单元测试和 `npm run lint`；交互行为变化需要浏览器覆盖时，使用 `scripts/acp-browser-smoke.mjs`。

## 提交与拉取请求指南

近期提交使用简洁的中文祈使句摘要，例如 `减少终端和 ACP 按需加载流量` 或 `修复文件树 Git 重置`。保持提交聚焦，并说明受影响的子系统。拉取请求应包含简短摘要、测试结果、相关 issue 链接（如适用），以及可见 UI 变化的截图或录屏。

## 安全与配置提示

此应用会控制终端，并可能启动外部 ACP 运行时。不要提交 token、私有配置或 `~/.tabminal` 中的文件。认证状态应保持由浏览器持有，保留主 Host 的全局认证行为；没有测量依据时，不要削弱 WebSocket 重连或 Host 隔离规则。
