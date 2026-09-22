# tabby-webviewer

A [Tabby](https://github.com/Eugeny/tabby) plugin that adds a **web browser connection type**:
open a pane (or a whole tab) that renders a real web page right next to your
terminals — for dashboards, admin panels, docs, anything your servers serve.

## Features

- **New connection type "Web viewer"** — appears in *Profiles & connections*
  and in the split-pane profile picker, so a browser pane can be opened
  directly beside any terminal.
- **Quick Connect** — type a URL (`https://git.example.com`,
  `localhost:3000`, `192.168.1.10:8443/dashboard`) into the Quick Connect box
  and it opens as a browser pane. `user@host` still goes to SSH.
- **One independent browser environment per pane** — every pane gets its own
  isolated, persistent cookie jar (`persist:` session partition): panes never
  share logins with each other, and each pane's login survives Tabby restarts.
  Optionally, a saved profile can be set to *share* browsing data between its
  panes.
- **Full HTTPS support** — with an optional per-profile *ignore certificate
  errors* switch for self-signed certificates (scoped to that profile's data).
- **Client certificates (mTLS)** — sites that require a client certificate
  automatically use matching certificates from the OS certificate store,
  exactly like a desktop browser: a single match is auto-selected (remembered
  per host), several matches open Tabby's selector to pick one.
- **Developer tools** — `F12` / `Ctrl+Shift+I` opens a detached Chromium
  DevTools window; the page context menu has *Inspect element*. This is the
  complete Chrome DevTools: network recording, JS breakpoints, element
  inspection, HAR export.
- **Compact toolbar** — stop/reload, back/forward, address bar, DevTools,
  clear-data and open-in-system-browser buttons.
- **Tab hotkeys keep working while the page has focus** — modifier combos and
  F-keys are forwarded to Tabby's hotkey engine (pane navigation, tab
  switching, rearrange-panes…), and browser keys do what you expect:
  `F5`/`Ctrl+R` reload, `Alt+←`/`Alt+→` history, `Ctrl+L` address bar.
- **Keyboard focus follows the focused pane** — splitting a pane
  (`Ctrl+Shift+D`/`Ctrl+Shift+S`) puts the keyboard straight onto the new
  pane's page, ready for the next action; pane navigation
  (`Ctrl+Alt+arrows`) moves the keyboard with it, and closing a Tabby
  modal (settings, command palette) hands focus back to the page.
- **Page zoom on Tabby's zoom hotkeys** — with a page focused,
  `Ctrl+=`/`Ctrl+-`/`Ctrl+0` zoom the page contents (×1.25 per step,
  persisted per site) instead of Tabby's UI, just like terminal font-size
  hotkeys behave for terminals. Ctrl+wheel works natively too.
- **Session recorder** — a toolbar button (⏺) opens a per-pane panel with
  Console / Network / Events tabs. It captures all console output plus
  uncaught exceptions, every request/response (headers, POST and — for
  textual responses ≤64KB — response bodies, with redirects split into
  chained entries), and core interactions: clicks (CSS selector + text +
  coordinates), input/change values (password fields are always masked),
  form submits and navigations. Network streams can be filtered with a
  DevTools-style expression (see below); the whole session exports to JSON.
  Recording and `F12` coordinate automatically: opening DevTools pauses the
  recorder, closing it resumes — data is preserved.
- **Recorder layouts** — Settings → Web Viewer → *Session recorder layout*:
  right drawer (default, drag its left edge), bottom drawer (page on top,
  drawer under it — drag its top edge), or a **detached tab**
  (`Recorder — <host>`) you can split beside its pane like DevTools' detach
  mode. Drawers keep a FIXED size you drag to (enforced three ways, so
  content can never grow them; remembered across opens) and always leave
  the page a minimum area. Hiding the panel never stops the recording —
  clicking the record button brings it back. Every list is a lazy
  collapsible tree: rows expand inline (Network into per-section groups —
  General / headers / bodies — that render only while open; clicks inside
  the open detail never collapse it). Rows support file-manager-style
  multi-selection — Ctrl+click, a held left-button sweep, or Shift+click —
  then right-click → 复制 or Ctrl+C: collapsed rows copy their one-line
  summary, expanded rows copy their full detail, joined by newlines.
- **Session recovery** — open viewer panes are restored on restart like
  terminals, each with its URL and its login state.
- `target="_blank"` / `window.open` links open as new viewer tabs.

## How it works

Tabby runs Electron with the `<webview>` tag disabled, so pages are rendered
by a `WebContentsView` obtained through `@electron/remote` and overlaid on
the pane. The view's bounds track a host `<div>` in a `requestAnimationFrame`
loop (zoom-factor aware), and the view is temporarily parked off-screen
whenever DOM must appear above it — Tabby modals (settings, command palette),
pane-resize / tab-drag gestures, or the pane's own error / empty pages.

The bounds-sync, docking and hotkey-forwarding techniques are borrowed from
[tabby-browser](https://github.com/karolnowacki/tabby-browser) v0.2.0 (MIT) —
many thanks for proving the overlay approach works in Tabby.

## Install

### Plugin Manager

Tabby → **Settings → Plugins** → search **`tabby-webviewer`** → Install →
restart Tabby.

### Manual / from source

```bash
cd WebViewer
npm install
npm run package:install   # builds + installs into Tabby's plugins directory
```

The install script resolves the plugins directory in this order:
`TABBY_PLUGINS_DIR` env override → portable install (`<exe>\data\plugins`,
e.g. `D:\App\Tabby\data\plugins`) → platform default
(`%APPDATA%\tabby\plugins` on Windows).

Then fully exit Tabby (including the tray icon) and start it again.

## Usage

- *Profiles & connections* → **Web viewer** template → edit URL / options →
  open as a tab or split pane.
- Quick Connect box → type a URL → Enter.
- In a pane: address bar navigates on Enter (bare localhost/IP hosts default
  to `http://`, other hosts to `https://` — configurable in Settings →
  Web Viewer).

### Session recorder

Click the ⏺ toolbar button — the drawer opens and recording starts; click
again to stop. The drawer (draggable top edge) has three tabs:

- **Console** — all levels + uncaught exceptions (marked `UNCAUGHT`).
- **Network** — click a row for headers / bodies / timing. The filter box
  accepts space-separated terms, ANDed together; a leading `-` negates one
  term:

  | Term | Meaning |
  |---|---|
  | `api` | URL contains "api" (case-insensitive) |
  | `/\.js$/i` | URL matches a regex (both slashes; only flag `i`) |
  | `method:POST` | exact HTTP method |
  | `status:4xx` / `status:404` / `status:>=400` / `status:<300` | status |
  | `type:xhr` | resource type (`doc css img js ws` are aliases) |
  | `domain:cdn` | hostname contains |
  | `mime:json` | MIME type contains |
  | `has:body` | response body was captured |

  The **静态资源** checkbox (on by default) hides image / font / stylesheet /
  script / media requests. A parse error shows a message and leaves the list
  unfiltered. Filtering is display-only — recording always captures
  everything.

- **Events** — recorded interactions; passwords never leave the page
  unmasked (`••`).

WebSocket traffic and cross-site out-of-process iframes are not captured
(v1).

## Browsing data & cleanup

Every pane's cookies/storage live under
`<Tabby userData>/Partitions/webviewer-*`. Closed panes leave their partition
on disk on purpose — reopening or restarting restores the login. To wipe:

- pane toolbar / context menu → **Clear browsing data** (that pane only),
- Settings → **Web Viewer** → *Clear all browsing data* (every partition,
  including orphaned ones).

## Known limitations

- The page is a native layer above Tabby's DOM: while a viewer pane is
  visible, Tabby's modals first park the page (it disappears for a moment),
  and the page lags one frame behind window resizes.
- Duplicating a tab duplicates its browsing identity too (the copy stays
  logged in — Chrome's "duplicate tab" semantics).
- Desktop Tabby only (Electron); does nothing in tabby-web.

## Development

```bash
npm run watch    # rebuild on change; reload the Tabby window (location.reload()) to pick up
npm run typecheck
npm test
```

## License

MIT. Bounds-sync / docking / hotkey-forwarding techniques originate from
[tabby-browser](https://github.com/karolnowacki/tabby-browser) (MIT) © Karol
Nowacki.
