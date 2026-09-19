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
npm run package:install   # builds + copies into %USERPROFILE%\.tabby\plugins
```

Then fully exit Tabby (including the tray icon) and start it again.

## Usage

- *Profiles & connections* → **Web viewer** template → edit URL / options →
  open as a tab or split pane.
- Quick Connect box → type a URL → Enter.
- In a pane: address bar navigates on Enter (bare localhost/IP hosts default
  to `http://`, other hosts to `https://` — configurable in Settings →
  Web Viewer).

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
