# v0.1.0

首个公开版本：为 Tabby 终端提供内嵌真实浏览器的"连接类型"，网页窗格与终端窗格并存。

## 功能

- **新连接类型 Web viewer** — 出现在 Profiles & connections，可直接打开或分屏；Quick Connect 输入 URL（`https://…`、`localhost:3000`、`192.168.1.10:8443`）直接开窗格
- **每窗格独立浏览器环境** — 独立持久化 Cookie/存储（session partition），窗格间互不共享登录态，重启后保留
- **完整 HTTPS** — profile 级"忽略证书错误"开关（自签名证书，仅作用于该身份的数据）
- **DevTools** — F12 / Ctrl+Shift+I 呼出独立窗口；右键菜单"检查元素"
- **紧凑工具栏** — 刷新/停止、后退/前进、地址栏（裸 localhost/IP 自动补 http://）、清数据、系统浏览器打开
- **会话恢复** — 窗格随 Tabby 重启恢复（URL + 浏览览身份）
- **快捷键集成** — 页面聚焦时 Tabby 组合键（分裂、窗格导航、切标签等）照常工作：F5/Ctrl+R 刷新、Alt+←/→ 历史、Ctrl+L 地址栏
- `target="_blank"` 链接在新标签页打开

## 技术说明

Tabby 未启用 `<webview>`，本插件通过 `@electron/remote` 创建 `WebContentsView` 覆盖层渲染网页：rAF 边界同步、遮挡/拖拽停靠、`before-input-event` 热键转发。部分技术方案参考了 [tabby-browser](https://github.com/kolnowacki/tabby-browser)（MIT）。

## 已知限制

- 网页为原生浮层：Tabby 模态框（设置、命令面板）出现时网页会短暂让位；窗口缩放时网页有一帧延迟
- 分裂出的新窗格不自动接管键盘，需点击一次网页
- 仅桌面版 Tabby（Electron）

## 安装

```bash
# 下载下方 zip，解压到 %APPDATA%\tabby\plugins\node_modules\tabby-webviewer 后完全重启 Tabby
```

要求 Tabby ≥ 1.0.231。
