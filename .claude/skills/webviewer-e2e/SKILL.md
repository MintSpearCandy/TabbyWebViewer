---
name: webviewer-e2e
description: WebViewer 插件的 E2E 测试套使用手册：构建/部署插件到测试 Tabby、启动与安全关闭隔离实例、运行回归脚本、编写新的 CDP 测试脚本、以及全部已知陷阱。凡是要跑 E2E/test/回归/冒烟测试、驱动 9231 测试 Tabby、写 CDP 探测脚本、截图验证 UI、或排查"测试不通过/找不到 target/clipboard 失效"之类的问题时，务必先读本 skill，不要凭记忆猜命令和端口。
---

# WebViewer E2E 测试套速查

> 通用 Tabby 调试方法论（源码地图、CDP 取证、输入注入分级、排查心法）在用户级 skill **`tabby-debug`**——跨插件通用；本 skill 只管本仓库的测试套操作。

所有 CDP 脚本零依赖（仅用 Node 全局 `fetch` + `WebSocket`，需 **Node ≥ 22**，本机 v24 ✓）。

## 0. 安全红线（先读这个）

- **用户的真实 Tabby 在 `D:\App\Tabby\Tabby.exe`**（便携版，插件在 `D:\App\Tabby\data\plugins\node_modules`）——**绝对不能碰**。
- 杀测试实例**只允许按路径过滤**，禁止按进程名杀：
  ```powershell
  Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '*tabby-port*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  ```
- 测试实例是便携版（`test-env\tabby-port\Tabby.exe`），有独立 userData，与真实 Tabby 互不干扰，可以随便折腾。

## 1. 标准流程（每次测试都从这开始）

```bash
# ① 构建（改了 src/ 之后必须）
npm run build

# ② 部署到测试实例的插件目录（两个候选位都拷，portable 位生效）
node scripts/updateDebugCfg.js
#    追加 `--app` 同时部署到用户的真实 Tabby（D:\App\Tabby）——仅用户明确要求时用

# ③ 启动测试 Tabby（专用实例，CDP 端口 9232——tabby-port 已被 GlassTheme 工作流共享）
powershell -ExecutionPolicy Bypass -Command "Start-Process 'test-env\tabby-wv\Tabby.exe' -ArgumentList '--remote-debugging-port=9232'"
sleep 8   # 等 CDP 就绪

# ④ 验证 CDP 在线（应返回 JSON）
curl -s http://127.0.0.1:9232/json/version

# ⑤ 跑离线冒烟（不需要 Tabby，可单独当 CI 用）
node scripts/smokeLoad.js

# ⑥ 跑 E2E
node scripts/recorderTest.js
```

改了 `config.yaml`（如 `webviewer.recorderLayout`）**必须重启测试实例**才生效——配置只在启动时读取。

## 2. 端口与实例对照

| 端口 | 用途 |
|---|---|
| **9232** | **WebViewer 专用实例**（`test-env/tabby-wv`）——跑测试一律用它：`CDP_PORT=9232 node scripts/...` |
| 9231 | `test-env/tabby-port`——**已被 GlassTheme 工作流共享**（其测试会随意杀/重启它，端口也变 9225/9226），勿再用于测试 |
| 9233 / 9223 / 9251 | 历史隔离实例（cdpProbe/seedLayout/e2eDebug/splitDoubleTest 等 relics 用） |
| **9311** | 脚本自建的本地测试站点（recorderTest/recorderShot 内部 `http.createServer`，脚本退出自动关） |

## 3. 稳定回归套件（有断言、有 exit code，可放心跑）

| 脚本 | 验证内容 | 前置 |
|---|---|---|
| `smokeLoad.js` | dist 模块能否像 Tabby 渲染进程那样加载（stub 全部宿主依赖，漏 stub 即崩） | 仅需 `npm run build`，无需 Tabby |
| `recorderTest.js` | **旗舰**：录制器全功能 ~56 项断言（5 级 console、异常捕获、行展开、ctrl+点选/框选、剪贴板、右键菜单定位、网络捕获 404/302/静态开关、过滤器表达式、密码打码、F12 暂停、stop/start、隐藏再召回、洪水下抽屉定高、**多选取消**：plain click / click-away / 页面内 click / 真实 sweep 后首击不被吞） | 9231 实例 + 新部署的 build；自建站点自导航自复位；**连跑前先干净重启**（见陷阱 14） |
| `recorderDragTest.js` | 抽屉拖拽改高、页面区随之缩小、隐藏重开后高度保持 | 9231 + 可见 webviewer pane（脚本自己开抽屉） |
| `rightDragTest.js` | right 布局抽屉向左拖宽（手势跨越原生 view） | **先跑 `recorderShot.js`**；config 需 `recorderLayout: right` + 已重启 |
| `recorderTabTest.js` | 分离式 recorder tab 生命周期（录制中关 tab 会话不丢、按钮再召回、二击停止） | **先跑 `recorderShot.js`**（要留一个在录的分离 tab） |
| `debugKitVerify.js` | **调试工具链自检**（11 项：CDP attach、console/异常捕获、焦点取证、ngModel 导航+唯一 URL 选 target、CDP 按键驱动热键引擎、引擎日志实时捕获、截图、log.txt） | 9231 实例在线；改完调试手法后跑一遍防退化 |
| `dismissRealClick.js` | 多选取消的焦点路径独立复检（ctrl+点选 2 行 → `view.webContents.focus()` 真实焦点转移 → 断言清除） | 先跑 `recorderShot.js`；改 focus 插线后跑 |

**工具类**（生产率脚本，非测试）：`recorderShot.js [out.png]` 复位+导航+开录+驱动活动+全窗截图（也是上面两个测试的铺垫器）；`closeExtraWindows.js` 关掉恢复会话带出的无 pane 多余窗口（多 index target 时 `url.includes('index')` 会连错窗口——先跑它）；`panelClip.js [out.png] [scale]` 只截 recorder 面板区域；`cdpEval.js "expr"` 主窗口一次性求值；`asarScan.js` 查 asar 内容；`package.js`/`release.js` 打包发布。

**其余脚本（e2eDebug/seedLayout/navExperiment/chordTest/sendInputChord/chordFollowTest/engineResidueTest/multiSplitTest/splitDoubleTest/focusTrace/fullVerify/timelineProbe/tabHeaderProbe*）是历史调试 relic**：无断言或硬编码旧端口（9233/9223/9251），仅供考古，不要当回归用。

## 4. 写新测试脚本：CDP 配方

每个脚本各自内联一份样板（无共享模块）。新建脚本直接抄这段（出自 `scripts/cdpEval.js`）：

```js
const targets = await (await fetch('http://127.0.0.1:9231/json/list')).json()
const main = targets.filter(t => t.type === 'page').find(t => t.url.includes('index'))
const ws = new WebSocket(main.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
let id = 0
const pend = new Map()
ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data)
    if (m.id !== undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
})
const evaluate = ex => new Promise(r => {
    const i = ++id
    pend.set(i, r)
    ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: ex, returnByValue: true } }))
})
```

要收 console 日志则需扩展版（带事件监听，参考 `e2eDebug.js` 的 `CdpSession`）：`await send('Runtime.enable')` 后挂 `Runtime.consoleAPICalled` / `Runtime.exceptionThrown` 监听，用 `/webviewer-debug|Matched hotkey|hotkey-guard/` 过滤。

**四类高频配方：**

导航 webviewer pane（ngModel 安全，主窗口会话内执行）：
```js
const el = document.querySelector('webviewer-tab .webviewer-address')
el.value = '127.0.0.1:9311/?run' + Date.now()      // 唯一 run 标记，见陷阱①
el.dispatchEvent(new Event('input', { bubbles: true }))
el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
```

复位遗留 recorder 状态（收敛循环，最多 6 轮；隐性在录的抽屉会让"开始"按钮变成"召回"）：轮询 `{panel: !!querySelector('webviewer-recorder-panel'), rec: !!querySelector('.recording-active')}`；`rec` → 点 `.fa-circle-dot` 最近 button；`panel` → 点 `.fa-chevron-down` 最近 button；每轮 `sleep(400)`，两者皆无才算干净。

选对 webContents target（三级）：
1. 主窗口：`type==='page' && url.includes('index')`
2. pane 页面：**按本次 run 的完整唯一 URL 匹配** `t.url.startsWith(PAGE_URL)`——禁止只用 `https` 前缀
3. 进程内：`@electron/remote` → `getCurrentWindow().contentView.children.filter(v => v.webContents.getURL().startsWith(PAGE_URL))`，键盘归属用 `getBuiltin('webContents').getFocusedWebContents()`

按键注入三级（按需选层）：CDP `Input.dispatchKeyEvent`（modifiers 掩码 ctrl=2/shift=8/alt=1，发到指定 target）；Electron `webContents.sendInputEvent`（走插件转发路径，可在主窗口上下文按 pane 发）；原生 DOM `KeyboardEvent`（直达热键引擎，可设 `repeat:true`）。

**注意：本机 Git Bash 里 `node -e "带模板字符串的代码"` 会炸——新脚本一律写成 `scripts/xxx.js` 文件再跑。**

## 5. 陷阱清单（每条都是真金白银换来的）

1. **实例会恢复上次的 tab**。启动后遗留 pane 可能停在和本次相同的 URL 上——按 URL 前缀选 target 会选错 webContents（症状：recorder 显示在录但零捕获）。每次 run 用 `?run<timestamp>` 唯一标记并精确匹配。
2. **关 tab 绑定是 Ctrl-Shift-W（不是 Ctrl+W）**，且对 tab 头部的关闭按钮 `.click()` 无效——激活该 tab 后用 CDP 发 Ctrl-Shift-W。
3. **非可见 pane 停在屏幕外**（`getBoundingClientRect().x ≈ -8000`）：`element.click()` 照样有效，但 CDP Input 鼠标坐标无意义——坐标驱动的测试先找 `x > -100` 的 pane。
4. **视口外坐标的 CDP 输入会被静默丢弃**（如 y<0 的拖拽收尾 pointerup 丢失——这就是 recorderPanel 拖拽要 `buttons===0` 自愈的原因）。绑定测试用合成事件发到 document/window；拖拽轨迹用 `Input.dispatchMouseEvent`。
5. **系统剪贴板可能被其它进程锁死**（PowerShell `Set-Clipboard` 抛 0x800401D0，Electron `clipboard.writeText` 全应用**静默失败**）。剪贴板断言前先做一次 write/read 探活，锁了就只走通路不断内容（见 recorderTest 的 `clipOk` 守卫）。用户报"复制不管用"先查这个。
6. **CDP 窗口里 `navigator.clipboard` 报 "Document is not focused"**（窗口无 OS 焦点）——用 `require('@electron/remote').getBuiltin('clipboard')`。
7. **CDP Input 不移动真实 OS 光标**（`screen.getCursorScreenPoint()` 不变）：CDP 注入坐标的测量不代表真实用户；原生弹窗出现在真实光标处而非注入处。
8. **Electron `Menu.popup` 的 x/y 是窗口相对 DIP**，150% 缩放下 = 窗口原点(物理) + 参数×1.5；主 DOM 菜单公式 `client × windowZoomFactor`，页面菜单 `viewBounds + params × pageZoom`。菜单窗口类名是 `Chrome_WidgetWin_1`（非 #32768），关闭后被停到 (-32000,-32000)——枚举要过滤。**主窗口 DOM 上的自定义菜单一律用 DOM 菜单**（recorderPanel 的 `.wv-ctx-menu` 模式：`position:fixed` + clientX/Y），只有必须浮在原生页面 view 之上时才用原生 Menu（pageContextMenu）。
9. **真鼠标测试**：osprobe.ps1 必须 `SetProcessDPIAware` 才拿到物理坐标；后台进程 `SetForegroundWindow` 要先按 ALT；**测完把光标挪开**——停驻光标会让 Chromium 在列表重渲染时合成 mouseenter 污染选择类测试（需重启+移开才能恢复）。菜单可见性用截图（`rclick-shot`）验证，别信窗口枚举（停泊残影会误报）。
10. **配置启动时读取**：改 `webviewer.recorderLayout` 等必须重启测试实例，否则布局断言全错。
11. **CDP 按键注入的两个静默坑**（详见用户级 tabby-debug skill §4）：pane 导航后第一发和弦被热键引擎 timeStamp 去重吞掉（先发 F13 牺牲键或重试）；xterm textarea 持焦时吞 Ctrl-Tab 类和弦（注入前 blur）。注入后必查捕获日志里有无 `Matched hotkey`。
12. **"第一个 http view" 会选错 pane**：恢复会话带多个 view 时 `find(w => url.startsWith('http'))` 常命中最旧的那个。焦点/清除类测试要按**本 run 唯一 URL** 匹配；没有唯一 URL 时按**几何匹配**（drawer 所在 pane 的 `.webviewer-content` rect × 窗口 zoomFactor vs `view.getBounds()`，容差 x/y 12px、width 30px）。实测症状：焦点转移成功但目标 panel 不清——清了别的 pane 的空 panel。
13. **主窗口 DOM 的 window 永远不持有 webContents 焦点**（焦点常驻各 view webContents，`getFocusedWebContents()` 恒指向某个 view）→ **`window:blur` 不会因点击 view 而触发**（实测证伪并弃用过该方案）。且 **view 已聚焦时 `view.focus()` 是 no-op（无 focus 事件）**——真实用户流里焦点本来就在 view 上（点击面板行不改变 webContents 焦点），点击页面时**没有任何焦点事件**。页面交互的唯一可靠信号是注入脚本的 click 上报（recorder `onPageInteract` 回调）。测 focus 转移路径时必须先把焦点 park 到别的 view 再 focus 回来制造真实转移。
16. **真实浏览器的 sweep 收尾 click 落在公共祖先上**：mousedown 行 A → 拖到行 B → mouseup，浏览器把 click 派发到两者的**最近公共祖先**（列表容器），永远不经过行——行内的事件消费逻辑（如 `suppressNextClick`）收不到它，标记残留并吞掉用户**下一次**单击。合成测试不会自动产生这个 click，必须显式模拟（`document.querySelector('.recorder-scroll').dispatchEvent(click)`）；修复模式：每次新 mousedown 重置残留标记。
14. **tabby-port 实例被其它项目共享**（已分家解决）：GlassTheme 的测试流程会随意杀/重启 `test-env\tabby-port`（端口漂移 9225/9226）——症状：CDP 无响应或实例凭空消失，而进程还在（log.txt 的 `cwd` 字段可分辨谁起的）。**2026-09 起已复制独立实例 `test-env\tabby-wv`（端口 9232）专供本仓库**，杀实例按路径过滤 `*tabby-wv*`；与 GlassTheme 的杀法（`*tabby-port*`）互不误伤。
17. **`onFocusGained` 里做副作用会自摆乌龙**（实测定位，2026-09）：pane 的 `claimKeyboardFocus()` 会在用户**点击 drawer（主 DOM）**时被 split 的 focus 重发触发，并程序化调用 `view.focus()`——`onFocusGained` 随即触发。曾在此挂"清除多选"，结果用户每次在 drawer 里按下/松开（划选手势全程）选择都被自己人清掉（合成 DOM 事件测不出——它们不产生真实焦点变化；用 **CDP `Input.dispatchMouseEvent`**（走 Chromium 真实输入管线）+ clearSelection 调用栈日志即可复现定位）。**程序性焦点路径不可挂用户语义副作用**；页面点击信号用注入脚本的 click 上报（`onPageInteract`）。
15. **连跑 recorderTest 前先干净重启实例**：状态残留（stopped 录制、上轮 flood 数据、被转移走的焦点）会造成**每次不一样的随机失败**——失败项漂移时先重启再下结论，别急着改代码。

## 6. 环境结构（重建时照此办）

```
test-env/
  tabby-wv/              ← WebViewer 专用实例（端口 9232；从 tabby-port 复制分家）
    data/config.yaml     ← 测试配置（close-tab=Ctrl-Shift-W, recorderLayout, enableWelcomeTab=false）
    data/plugins/node_modules/tabby-webviewer/   ← 部署目标①（生效位）
  tabby-port/            ← 便携版 Tabby（被 GlassTheme 工作流共享，勿用于测试；部署目标②）
  tabby-debug-cfg/       ← 老配置位，部署目标③（兜底）
  *.png / *.log          ← 历次测试的截图与日志（可清理）
```

从零重建：官网下 Tabby 便携 zip 解压到 `test-env/tabby-port/`，首启生成 `data/config.yaml` 后把 `close-tab` 改成 `Ctrl-Shift-W`、设 `webviewer.recorderLayout`、`enableWelcomeTab: false`，再 `npm run build && node scripts/updateDebugCfg.js`。`updateDebugCfg.js` 只拷 `dist/` + `package.json` 到两个候选位（目录不存在则跳过）。

## 7. osprobe.ps1 真输入探针（Windows）

```powershell
powershell -ExecutionPolicy Bypass -File scripts/osprobe.ps1 <mode> [args]
```

模式：`move x y` / `rclick` / `lclick` / `esc` / `key <vk-hex> down|up`（按住修饰键，配合 lclick 做真 ctrl+click）/ `focus-hwnd <hwnd>`（ALT 技巧）/ `windows` / `menu-wait [s]` / `rclick-probe`（右键+毫秒级菜单矩形时间线）/ `rclick-shot <png> <ms>` / `cursor` / `foreground`。`shot` 模式半残勿用。全部坐标为物理像素。Node 侧驱动示例见 `timelineProbe.js`（注意其 DPI 系数 1.5 是本机硬编码）。**注意：后台进程的 focus-hwnd(ALT)+真点击组合曾两次把主进程卡死（CDP 陪葬）**——真鼠标驱动 Tabby 主窗口是高危路径，能用 CDP/Electron 层替代就替代。
