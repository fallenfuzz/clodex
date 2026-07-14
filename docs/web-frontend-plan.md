# Web frontend — Clodex in Docker, GUI in a browser

Goal (Bogdan, 2026-07-14): the OPTION to run a Clodex docker image and access
the GUI through a published port in a browser. **The Electron desktop app
stays exactly as it is** — local engine, ipcMain transport, nodeIntegration
renderer, no thin-client mode, no behavior change. The browser is a NEW
frontend for the engine (engine.js, v2.22.0), not a replacement for any
existing one. Peering is NOT the mechanism here — peers are federation
between sovereign Clodexes; this is one Clodex's own GUI over a port.

Ground truth (verified 07-14):

- preload.js window.api = 165 invoke/send/on endpoints — THE contract a
  browser client must speak.
- ipc-handlers.js post-engine-extraction touches electron via: ipcMain
  (handle ×118, on ×5 — registration), and 17 direct GUI calls — dialog ×8
  (6 showMessageBox confirms, showOpenDialog, showSaveDialog),
  Menu.buildFromTemplate().popup() ×3, shell ×4 (openExternal ×2, openPath,
  showItemInFolder), app ×2 (getVersion, getPath('desktop')), with window
  anchoring via BrowserWindow.fromWebContents ×3 + getFocusedWindow ×7.
  (CORRECTED 07-14 from clodex-hand's line-by-line audit; the original
  "only ipcMain + 28 fromWebContents" claim was wrong — carried over
  unverified from a coarse inventory.) Workspace resolution is ALREADY
  fully seamed via injected workspaceOfSender(e) — the Phase 3 handshake
  replaces that seam's implementation, nothing in ipc-handlers.
- Renderer is bundlable: requires = xterm npm pkgs (browser-native),
  renderer/lib + islands + popovers, and 7 pure root leaves (proxy-util,
  peer-input-queue, peer-deploy, skills-util, scope-util, intent-catalog,
  os). No fs/electron anywhere under renderer/.
- Event push flows through session-manager's _sendToSession/_broadcast
  (workspaceId→window map) — the interception point already exists.

## Discipline (same as the engine arc)

- Electron path stays byte-identical in behavior; where code is shared,
  parameterization only. Suite green per phase via [agent:exec run-tests];
  clodex-hand implements + never commits; clodex reviews full diff,
  integrates, releases. New modules → leak-scanner lists. The
  electron-boundary ALLOWED set may only SHRINK.
- Genuine spec tensions: stop and get a ruling, don't guess (this worked
  twice in the engine arc — the leaf ruling and the data-dir catch).

## Phase 1 — transport seam in ipc-handlers

Make registration transport-agnostic without moving a single handler body:

- registerIpcHandlers gains injected `handle(channel, fn)` + `on(channel,
  fn)` and uses them everywhere it now calls ipcMain.handle/ipcMain.on.
  main.js passes wrappers over ipcMain. Drop the ipcMain require.
- Seam the 17 GUI calls as TEN capability fns (RULED 07-14): popupMenu
  (template, e), showMessageBox(opts), showSaveDialog(opts),
  showOpenDialog(opts), openExternal(url), openPath(p),
  showItemInFolder(p), getAppVersion(), getDesktopPath(). Window
  resolution FOLDS INTO the capability wrappers in main.js
  (fromWebContents/getFocusedWindow live inside them) — no
  window-object seam ever crosses into ipc-handlers, and the IPC event
  rides through as an opaque sender token so a Phase-3 WS connection can
  occupy the same slot. Names mirror electron deliberately (the wrappers'
  semantics ARE electron's; Phase 3 implementing them degraded is honest).
- End state: ipc-handlers.js has NO electron require → remove it from the
  boundary-test ALLOWED set (the test's "shrinking welcome" case).
- Electron behavior byte-identical; this phase is shippable alone.

## Phase 2 — event-push enumeration + emitter seam

Enumerate every channel the main process pushes to renderers (grep
webContents.send + _sendToSession/_broadcast callers; expect: pty-data,
session-exit, session-activity, session-ctx, ipc-message, update banners,
peer events, …). Ensure every one flows through a single injectable
emitter surface on the engine/host boundary (most already do via
_sendToSession/_broadcast). Document the channel list in the plan or a
doc — it is the other half of the browser contract. No behavior change.

## Phase 3 — web host: WS transport + bundled renderer (the big one)

Detailed spec (2026-07-14, post-P1/P2). Two milestones, EACH delivered,
reviewed, and committed separately: **P3a** (server side, headlessly
testable) then **P3b** (browser client + bundle). Companion contracts:
the 165-endpoint request half lives in preload.js; the 45-channel push
half in docs/renderer-events.md.

### P3a — web-host.js: WS server + engine wiring

**Module + entrypoint.** New `web-host.js` (plain Node, NOT in the
electron-boundary ALLOWED set): `createWebHost({ engine, log, port,
token })` → `{ close }`. Started ONLY by headless-main.js when
`CLODEX_WEB_PORT` is set — the Electron app never loads it. Dependency:
add `ws` (zero-dep) to production dependencies; plain `http` for the
rest (same stance as remote.js).

**Wire protocol** — JSON text frames (JSON.stringify round-trips any JS
string including lone surrogates, so pty-data rides as the already-
decoded string; NO base64 layer — this supersedes the earlier base64
note):
- client→server: `{t:'hello', workspaceId?, token?}` (first frame;
  workspaceId defaults to 'default'), `{t:'invoke', id, channel, args}`,
  `{t:'send', channel, args}` (the 5 ipcMain.on channels: pty-input,
  peer:input, session:context-menu, peer:context-menu,
  peer:header-menu), `{t:'menu-pick', menuId, itemId|null}`,
  `{t:'dialog-reply', dialogId, value}`.
- server→client: `{t:'welcome', workspaceId, appVersion}`, `{t:'reply',
  id, ok, value?|error?}`, `{t:'event', channel, args}` (the push half),
  `{t:'menu-show', menuId, items}`, `{t:'dialog-show', dialogId, kind,
  opts}`.
Frames before a valid hello (or with a bad token when `token` is set)
close the socket. Non-JSON-serializable handler return values: audit
during implementation; if any Buffer/Date surfaces, normalize at the
dispatcher (flag it in the handoff, don't silently coerce).

**Handler map.** The web host calls registerIpcHandlers ONCE at startup
with a deps object mirroring main.js:473's assembly: `{...engine,
...engine.stores}` + its own transport (`handle`/`on` populate a plain
Map<channel, fn>) + the degraded capabilities below + stubs for the
host-only tail — createWindow (no-op: browser tabs self-navigate; the
workspace record work already happens in the handlers),
openWirescopeWindow (log-only), setUiTheme / refreshAppMenu /
refreshTrayMenu (no-ops), checkForUpdate/UPDATE_REPO/getUpdateInfo/
getReleasesCache (inert: update-available is a designated desktop-only
channel), `workspaceOfSender(e)` reads the connection behind the sender
token. An invoke frame dispatches `map.get(channel)(e, ...args)` with
`e = {sender: {send: (ch, ...a) => conn.pushEvent(ch, a)}}` — the same
opaque-token shape Phase 1 established (§C channels flow free).

**Sender context for token-less capabilities.** showMessageBox /
showSaveDialog take only (opts) — under Electron the window resolution
is folded inside main.js's wrappers. The web host threads the requesting
connection via AsyncLocalStorage: the invoke dispatcher runs each
handler inside `als.run(conn, …)` and the capability impls read
`als.getStore()`. No Phase-1 signature changes.

**Degraded capabilities (v1, per the P1 handoff ruling: dialogs and
menus belong to the requesting connection):**
- `popupMenu(template, e)` — click closures STAY server-side: assign
  item ids, send `menu-show` (labels/enabled/separators; drop
  accelerators/submenus if none are actually used — audit), await
  `menu-pick`, invoke the matching `template[i].click()`. Dismiss →
  no-op.
- `showMessageBox(opts)` — `dialog-show(kind:'message')` to the ALS
  connection, await `dialog-reply`, resolve `{response}` (electron
  shape). Timeout/disconnect → resolve as cancel (the last button /
  cancelId).
- `showSaveDialog(opts)` — `dialog-show(kind:'save')` prompts for a
  filename; resolve `{canceled, filePath}` where filePath lands under
  `<userDataPath>/exports/` (sanitized basename). Serve `GET
  /exports/<file>` (token-gated) so the tab can offer a download.
- `showOpenDialog(opts)` — `dialog-show(kind:'open')` free-text path
  input; server validates fs.stat().isDirectory(); resolve `{canceled,
  filePaths}`.
- `openExternal(url)` → event to the ALS/sender connection; client
  window.open. `openPath(p)` → degrade to the in-browser file view
  where one exists, else log. `showItemInFolder(p)` → event; client
  shows the path (toast/copy). `getAppVersion()` → package.json.
  `getDesktopPath()` → the exports dir.

**Connection-backed window handles (the P2 contract).** Per workspace
with ≥1 tab, the host registers ONE multiplexing handle in
`manager.registerWindow(workspaceId, handle)` implementing exactly the
five methods: `webContents.send(ch, ...args)` fans an event frame to
every tab on that workspace; `isDestroyed()` = no tabs left;
`isFocused()` = any tab visible (client sends visibility hints;
default true); `show()`/`focus()` = a `focus-hint` event (serves
session-file-view). First tab registers, last disconnect unregisters —
so the engine's pendingOutput buffering (2MB) resumes exactly as for a
closed Electron window, and a reconnecting tab gets the replay through
the SAME path the desktop uses: the renderer's restore flow invoking
`app:restore-sessions` (session-restore.js returns `replay`).
Additionally the host keeps its OWN per-session scrollback ring (same
2MB cap) of pty-data it forwarded, replayed to a LATE-JOINING tab whose
workspace was already attached (the one case the engine buffer can't
cover — it only fills while detached). Zero engine change. Multi-tab
resize: last-writer-wins, accepted for v1.

**Auth v1 structure.** Optional `CLODEX_WEB_TOKEN`: bearer/`?token=`
check on every HTTP route + the WS upgrade + the hello frame. Absent →
localhost-trust stance (Phase 4 documents it). Structured so a real
auth layer replaces one predicate later.

**Tests (P3a is headlessly testable):** protocol framing + hello/token
gating; invoke→fake-handler round-trip incl. sender-token §C push; ALS
threading into a fake showMessageBox; the five-method handle contract
+ register/unregister timing; scrollback-ring replay; menu round-trip
(click closure fires on pick, not on show). electron-boundary: web-host
must NOT require electron (ALLOWED set unchanged). Leak-scanner lists:
not applicable (new module, not an extraction) — state so in the
handoff.

### P3b — browser client: api-contract table + shim + esbuild bundle

- **api-contract.js** (pure leaf): the single table `[{name, kind:
  'invoke'|'send'|'on', channel, argmap?}]` for all 165 window.api
  endpoints (argmap for the few non-passthrough wrappers, e.g.
  showSessionContextMenu's `{name, cwd}` object). **preload.js becomes
  a loop over the table** — window.api's surface and behavior byte-
  identical (this is the "where code is shared, parameterization only"
  clause; preload stays in the boundary ALLOWED set). Test: table
  well-formed, no dup names/channels, every `invoke` channel has a
  registered handler (capture-seam cross-check), and the generated
  window.api key set matches the pre-refactor 165.
- **renderer/web/api-shim.js**: builds window.api from the SAME table
  over the WS (invoke → id'd request/await-reply; send → send frame;
  on → event subscription). Connect + hello happen at boot; invoke
  callers transparently await socket-open. Also handles menu-show /
  dialog-show / focus-hint frames with minimal in-page UI (menu = the
  existing context-menu look if trivially reusable, else a plain
  positioned list; dialogs = simple modal). Reconnect on drop with a
  banner; after reconnect re-run the restore flow (that's what replays
  buffered output).
- **renderer/web/index.html + boot**: sets `window.api` via the shim
  (before renderer.js executes — preload-order equivalent), applies
  shims for the two node touches under renderer/ (`os.homedir()` —
  server passes home in `welcome`; `process` define for esbuild), then
  loads the renderer bundle. Workspace via `?workspace=` (default
  'default').
- **esbuild** as devDependency; `npm run build:web` → `web-dist/`
  (gitignored). Bundles renderer.js + lib + islands + popovers + xterm
  npm pkgs + the 7 pure root leaves; alias `os` to the shim. The
  Electron renderer keeps loading raw files via nodeIntegration — the
  bundle is for the browser only. web-host serves `web-dist/` +
  index.html.
- **v1 degradations surfaced honestly in the UI** (not silently
  broken): native-menu-driven `request-*` drawers → the in-page menu
  bar/buttons open them directly (channel-D designation); set-theme /
  zoom-nudge / update-available → absent; drag-drop of local files →
  absent; `[agent:file open]` → degrades to view.

Genuine spec tensions in either milestone: stop and get a ruling (the
standing rule). Expected friction worth pre-flagging: handlers whose
return values aren't JSON-cloneable, menu templates using more than
label/enabled/separator, renderer code paths assuming synchronous
window.api availability at parse time.

## Phase 4 — Docker image + auth v1 + docs

Detailed spec (2026-07-15, post-P3). One milestone; everything lives under
a new `docker/web/` directory except the two small code touches called out
below. (`docker/` itself is TAKEN — the peering arc's SSH/systemd peer
test-box, tracked files cross-referenced from the peering docs; the web
image nests beside it, RULED 07-15. References below to docker/X mean
docker/web/X; compose build context becomes `../..` with
`dockerfile: docker/web/Dockerfile`, and the repo-root .dockerignore
still applies.) The engine/web-host stack is DONE — headless-main.js already reads
CLODEX_DATA_DIR / CLODEX_WORKSPACES / CLODEX_WEB_PORT / CLODEX_WEB_TOKEN,
exits 0 on SIGTERM and 64 on restart-request — so this phase is packaging
+ docs + two follow-ups deferred out of P3.

### docker/Dockerfile (two-stage)

- **Stage 1 (builder)**: `node:20-slim` + git; `npm ci --ignore-scripts`
  (skips node-pty's gyp build, esbuild's platform binary arrives via
  optionalDependencies, and — critically — skips the electron devDep's
  binary download AND our postinstall, which is Electron-dev-only:
  dev-rename-electron.js / fix-pty-helper.js have no business in the
  image); `npm run build:web` → `web-dist/index.html`.
- **Stage 2 (runtime)**: `node:20-slim` + `git bash procps
  ca-certificates` + the build toolchain node-pty needs (`python3 make
  g++`) — kept in the final image deliberately: agents in the container
  will want to build things. Global CLIs: `npm i -g
  @anthropic-ai/claude-code @openai/codex` (pin nothing; agents
  self-update). App: copy the repo files electron-builder's `files` list
  names (or the whole tree minus .dockerignore), then `npm ci --omit=dev
  --ignore-scripts && npm rebuild node-pty` (Node-ABI native build, the
  headless smoke recipe), copy `web-dist/` from the builder.
- **Non-root user** `clodex` with a real `/home/clodex` and `HOME`/
  `SHELL=/bin/bash` set — agent-transport creates `~/.clodex` 0700 and
  fixPathFromLoginShell runs `$SHELL -ilc`. Set a container-local
  `git config --global` example in docs, not the image.
- `ENV CLODEX_DATA_DIR=/data CLODEX_WEB_PORT=8080`; `EXPOSE 8080`;
  `CMD ["node", "headless-main.js"]`. No ENTRYPOINT wrapper — compose
  `init: true` supplies PID-1 reaping (PTYs fork real process trees;
  without a reaper, zombies).
- **.dockerignore** (repo root): node_modules, dist, web-dist, deploy,
  .git, vendor/wirescope (unpublicized — MUST stay out), peering,
  docs, test, scratch artifacts.

### docker/compose.yaml

- One service `clodex`: build context `..` with
  `dockerfile: docker/Dockerfile`; `ports: "127.0.0.1:8080:8080"` —
  the localhost publish IS auth v1's boundary (same trust stance as
  remote.js v1); widening it means setting CLODEX_WEB_TOKEN, and the
  README says so in exactly those words.
- `environment`: pass-through `CLODEX_WEB_TOKEN` (optional, empty =
  localhost trust) and `CLODEX_WORKSPACES` (default 'default').
- `volumes`: named `clodex-data:/data` (sessions.json + stores + exports),
  named `clodex-dot:/home/clodex/.clodex` (registry/messages/log), named
  `claude-auth:/home/clodex/.claude`, plus a commented example bind mount
  for project checkouts (`- ./work:/home/clodex/work`).
- `restart: always` — this is the exit-64 contract's supervisor half
  (also restarts the clean exit-0, which is correct for a service);
  `init: true`.
- `healthcheck`: HTTP GET `/healthz` (see code touch below).

### Code touches (small, each with a test where testable)

1. **web-host.js `/healthz`**: unauthenticated `GET /healthz` → 200
   `ok`, exempt from the token predicate (leaks only liveness, and a
   compose healthcheck can't carry a secret cleanly). One test.
2. **fileOpen degradation (RE-RULED 07-15 after call-graph audit)**: the
   original "route open-path to the in-page view" ruling doesn't fit
   the actual call graph — window.api.fileOpen's sole caller is the
   file-peek modal's "Open in the default editor" button, fired while
   the peek is ALREADY showing that path (with a Diff tab the shim
   couldn't reconstruct: fileDiff needs the session name, which the
   transport layer doesn't have). Honest degradation instead: the shim
   sets `window.__CLODEX_WEB__ = true`, and files-popover hides the
   Open button when it's set (mirrors the existing `api.remote` hide
   at the same site) — there is no external editor to escape to and
   the file is already on screen. open-path keeps its toast as a net
   for any future source. The renderer touch is sanctioned despite the
   original shim-only scoping.

### Docs

- **docker/README.md**: quickstart (compose up, open
  `http://localhost:8080`), the paranoia rationale (the whole point:
  agents' blast radius = the container + explicit mounts; their world
  becomes Linux — mac-native workloads like this repo's DMG build stay
  host-side), auth stance v1 (localhost publish = boundary; token for
  anything wider; TLS/login is a later arc — front with a reverse proxy
  meanwhile), the volume map, and the **macOS credential gotcha**: a
  mac host keeps Claude OAuth in the Keychain, NOT in ~/.claude, so
  mounting the host's ~/.claude does NOT log the container in — first
  run is `docker compose exec clodex claude` (or `claude
  setup-token`) inside the container; the named volume persists it.
  Generic examples only (standing rule: no real domains/IPs).
- **docs/architecture.md**: third-host section — main.js (Electron),
  headless-main.js (plain Node), and the Docker image as the packaged
  form of the headless host + web frontend.

### Acceptance

- Suite green (the two code touches are the only suite-visible change).
- Live smoke (clodex runs it at review): `docker compose up` on the mac,
  browser to localhost:8080, hello→welcome, create a bash session, PTY
  round-trip, restart-request exits 64 and compose relaunches, SIGTERM
  clean. Token mode: 401 without, 200 with.

## Out of scope (explicit)

- ANY change to the Electron app's transport or workflow (it never speaks
  WS; it keeps ipcMain + nodeIntegration).
- Real multi-user auth/TLS (structured-for, not built).
- Peering changes; migrating existing spokes; k8s manifests (the image is
  the k8s enabler, manifests are operational).

## Phase 5 — UI parity (Electron ↔ browser)

New arc (Bogdan, 2026-07-15): close the UI gap between the Electron app and the
browser frontend, "as much as it can be done". The engine's whole A/B/C event
surface + all 165 `window.api` endpoints already flow to the browser over WS
(P3), and the renderer is *shared code*, so most UI already works — the gaps are
(i) things gated on Electron-native capabilities and (ii) accelerators/
affordances the browser sandbox changes. Everything browser-only is gated on
`window.__CLODEX_WEB__` so the Electron app is untouched.

### Gap classification

- **(a) verify-only** (shared renderer, should already match): all popovers +
  drawers (WS invokes onto the same handler map); theme switching (themes.js does
  localStorage + CSS `[data-theme]` + live xterm palette swap entirely
  renderer-side — the only desktop-only piece is cross-*window* `set-theme` sync,
  moot in one tab); `document.title`; in-page menus/dialogs (functional, cosmetic
  gap only).
- **(b) achievable in-browser**: the top menu bar (anchor, below); workspace
  switcher; Alt keyboard shortcuts; browser OS-notifications; favicon/title
  activity badge; dialog/menu theming.
- **(c) approximable**: zoom (native browser zoom, not persisted per-workspace,
  no `zoom-nudge` refit — leans on the resize-refit hook); native pickers
  (already degraded in P3b: open→typed path, save→/exports + download link);
  fileOpen "Open in editor" (hidden in browser, P4).
- **(d) impossible / browser supplies natively**: tray (partly absorbed by the
  bar's Window menu; no persistent OS tray); Edit/View **roles** (undo/redo/cut/
  copy/paste/select-all, reload/devtools/full-screen, about/hide/quit — the
  browser provides all natively, NOT gaps to build); dock bounce (approximated by
  the title badge); multi-OS-window (approximated by tabs + `?workspace=`).

### The top menu bar (anchor)

Bogdan ruled the floating "☰" corner button OUT, replaced by a real horizontal
menu bar resembling the Electron app's menus — NOT a macOS chrome simulation (no
traffic lights, no fake window frame), and skipping the Edit/View roles the
browser already supplies. It replaces `renderer/web/menubar.js`'s button.

- **Browser-only**, injected by the shim, gated on `window.__CLODEX_WEB__` — the
  Electron app's native menu bar must never get a second in-page bar.
- **Layout**: the current layout is NOT a flex column — `#main` is
  `position:fixed`, `#terminal-container` is `position:absolute` with a `bottom`
  offset (32px collapsed → 220px expanded IPC log) + a 0.2s transition, and
  `refitActiveTerminal()` reflows the fit addon against it. The menu bar is the
  exact mirror: a web-gated class reserves a `top` offset on `#terminal-container`
  (the bar renders in that strip) and mount calls `refitActiveTerminal()`. The
  terminal genuinely shrinks by the bar height — this is the proper fix for the
  xterm-fit concern that drove the corner button.
- **Structure** — mirror the REAL Electron menu tree (app-menus.js), NOT an
  invented grouping: File / Agents / Skills / View / Window. No "Session" menu
  (session switching is the sidebar's job on both platforms; desktop has none
  either). Edit omitted entirely (browser-native roles, (d)). Theme-styled with
  `var(--bg/--border/--accent/--text)` from birth, dropdowns reuse the
  context-menu look (pulls part of the dialog/menu theming forward).
  - **File** (desktop order + two web relocations): New Workspace,
    New Session… (Alt+T), Prompts…, Templates…, Exec Commands…, Inbox…,
    Rename Workspace…, **Preferences…** (relocated here — desktop keeps it in the
    macOS app menu the web bar deliberately lacks; File is its web home),
    **Restart Clodex** (confirm dialog like desktop, wired to the existing
    restartHost path = the container's exit-64 supervisor relaunch, which
    genuinely works). OMIT: Check for Updates / Update-to (ruled out), Quit
    (meaningless in a tab), Close (browser-native).
  - **Agents** (top-level, mirrors desktop): the library agent list +
    New Agent… + Manage Agent Types…, and Show IPC Traffic… (lives under Agents
    on desktop). All → `request-open-agents-drawer` / `request-open-ipc-log`.
  - **Skills** (top-level, mirrors desktop): the library skill list + New Skill… +
    Manage Skill Library… → `request-open-skills-drawer`.
  - **View**: Theme submenu with the same four entries + labels as desktop
    (Midnight / Claude / Paper (dim light) / Light → the existing renderer-side
    `applyTheme` — a menu home for what already works). OMIT Zoom (JS can't drive
    browser zoom — approximated natively). Open Log File: omit unless a
    token-gated GET of the log is added (implementer's call — flag if done).
  - **Window**: workspace switcher submenu (Focus/Open → `location.assign(
    '?workspace='+id)`, New/Rename/Delete where endpoints exist) + the Peers
    section mirroring desktop (Manage Peered Clodexes…, per-peer session attach).

### Rulings (2026-07-15)

1. **Shortcut chord family = Alt**: Alt+T (new), Alt+W (close), Alt+1-9 (switch),
   Alt+Shift+[ / ] (prev/next). Bound at document CAPTURE phase with
   `preventDefault`+`stopPropagation` so xterm never sees them, gated on
   `window.__CLODEX_WEB__`. Reserved Cmd+T/W/1-9 fail silently in a browser (chrome
   owns them), which is why the web frontend needs its own family. **Shadowed-Meta
   note**: Alt shortcuts shadow readline Meta bindings while the terminal is
   focused (Meta-T transpose-word, Meta-<digit> argument) — accepted cost, fine
   for agent CLIs. Shown as accelerator hints in the menu-bar labels, Electron-style.
2. **Notifications = S scope**: raise `new Notification()` off the existing
   broadcast `ipc-message` type:`attention`/`mention` events (already reach the
   browser), after a one-time permission prompt. Agent-finished notify (the
   `notifyOS` at the `_emitActivity` finished-turn site) has NO companion
   broadcast, so it stays deferred — leave a one-line comment at the shim site
   naming that missing broadcast as the trailhead for the M version.
3. **Update-available = OUT**: stays the Phase-4 non-goal. In-container "update" =
   rebuild the image, so the banner would have no action.
4. **Drag-drop file onto session = excluded**: net-new functionality (no desktop
   equivalent exists), parked in the backlog, not parity.

### Build order (one review per chunk; usual protocol — no commits, tests green
per chunk, stop for rulings on genuine tensions)

- **Chunk 1** (M): the menu bar replacing the ☰ button, with the tree above +
  the workspace switcher submenu, theme-styled, the web-gated layout `top`
  offset, AND the resize→refit hook (a debounced `window resize →
  refitActiveTerminal`, load-bearing for the bar row so it folds in here rather
  than standing alone).
- **Chunk 2** (S): Alt shortcuts (Alt+T/W/1-9, Alt+Shift+[ /]) + their
  accelerator hints in the bar labels.
- **Chunk 3** (S): notifications (S-scope) + title activity badge (favicon-canvas
  variant only if the title badge alone feels weak — flag at implementation).
- **Chunk 4** (M): remaining dialog / in-page-modal theming (the b6 residue not
  pulled forward by the bar).
- Fold the (a) verify passes into each chunk.

### Container reachability (interleaved chunk — one loopback-bind disease)

Three container issues Bogdan hit live, all the same shape (a service binds
loopback-only, so nothing outside the container's own network can reach it) —
fixed together, one review:

- **Wirescope full-dashboard links** point at the engine's loopback proxyBase
  (`127.0.0.1:7800`), unreachable from the browser. Fix: `CLODEX_WIRESCOPE_HOST`
  widens the uvicorn bind (0.0.0.0 in the image only; `_base()`/probes stay
  loopback — in-process); compose publishes `127.0.0.1:7811:7800`; the welcome
  frame carries `proxyBase` + `wirescopePublicBase` (from
  `CLODEX_WIRESCOPE_PUBLIC_URL`) and the shim rewrites any open-external url whose
  origin matches proxyBase to publicBase. `openWirescopeWindow` degrades to the
  open-external fan (the earlier dead log stub is gone).
- **Peering the container** was impossible: the peer wire (RemoteServer) binds
  loopback (`remote.js`) and the container never enabled it. Fix:
  `CLODEX_REMOTE_HOST` widens the bind (threaded through remote-wiring),
  `CLODEX_REMOTE_ENABLE=1` brings it up at first boot with no GUI toggle, compose
  publishes `127.0.0.1:7820:7900`. Desktop peers it as a direct-URL peer
  (`http://127.0.0.1:7820`), no SSH.
- **Deterministic-pid registry wedge**: in Docker the engine is the same pid every
  boot, so an `agent.json` surviving an unclean shutdown points at the new engine
  itself; `isAlive()` reads it as "running elsewhere" forever, wedging restore and
  fresh create under that name. Fix: a registration claiming our OWN pid for a
  session we don't run is treated as stale and force-cleaned, like a dead pid
  (`session-manager.js` `isStaleRegistration`). Desktop is unaffected — a
  genuinely-other Clodex sharing `~/.clodex` never has our pid.

All three bind overrides default to loopback and are set ONLY by the web image, so
the desktop app is byte-for-byte unchanged. **Caveat (README):** container
relaunch restores only `CLODEX_WORKSPACES`-listed workspaces, so a
browser-created workspace needs that env extended to survive a relaunch — surfaced
as a README caveat, not solved here.
