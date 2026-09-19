# v0.2.0

新增客户端证书（mTLS）支持与便携版安装适配。

## 新功能

- **客户端证书 (mTLS)** — 需要客户端证书的站点现在自动使用本机证书库中的匹配证书，行为对齐桌面浏览器：
  - 恰好一个匹配证书 → 自动选用并按主机记忆
  - 多个匹配证书 → 弹出 Tabby 原生选择器（证书主题 + 颁发者），选择后按主机记忆
  - 仅作用于 webviewer 窗格的请求，不影响 Tabby 其他内容

## 改进

- **便携版 (portable) 安装支持** — `npm run package:install` 现在按 `TABBY_PLUGINS_DIR` 环境变量 → 便携目录（`<exe>\data\plugins`，自动检测）→ 平台默认目录 的优先级解析安装位置

## 升级说明

从 v0.1.0 手动升级：下载下方 zip，替换插件目录中的 `tabby-webviewer` 文件夹后完全重启 Tabby。若你的 Tabby 是便携版（exe 旁有 `data\` 目录），插件目录为 `data\plugins\node_modules\`。
