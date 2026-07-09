# Clodex

Run a fleet of coding agents — **Cl**aude Code and C**odex** sessions on your Mac and on any Linux box you can ssh to — and actually *see* their work: what each agent is doing right now, what it costs, what's in its context window, which files it's touching, and who spawned whom. Every session is a real terminal. Agents message each other, spawn each other (locally or across machines), and manage their own context; you watch and steer from one sidebar.

<img src="./docs/screenshot.png" align="right" width="208" alt="The Clodex sidebar: local agent sessions with live context and cache-warmth badges, a subagent child row with its own cost, and two peered machines contributing remote sessions">

## Feature tour

### The local fleet

The unit of work is a **session**: a real PTY running `claude`, `codex`, or plain `bash`, embedded as an xterm.js terminal. Press ⌘T, name it, point it at a directory, hit Create. Then make nine more.

- **Multi-window workspaces** — each window is a workspace with its own session set (⌘⇧N for a new one). Close a window and its sessions keep running; the app lives in the tray. Only the most-recently-focused workspace opens on startup, IDE-style — the rest are one click away.
- **Persistence** — quit and relaunch, and every session `--resume`s with its history. Killing a session is an explicit act (X or ⌘W, with confirm); everything short of that comes back. The New Session dialog can also resume an arbitrary session ID, or fork it into a new branch.
- **Per-session configuration at spawn** — pick a system prompt and append prompts from the library, check exactly which tools the agent gets, attach custom subagent types and skills, set the wire-strip level, add raw CLI args. Most of it is editable later (right-click → Edit Session; apply on next spawn or restart in place, keeping the conversation).
- **Prompts / Agents / Skills libraries** — reusable files under `~/.clodex/library/`, shared across all windows and editable outside the app. Sessions reference library entries by name, so editing one file updates every session that uses it on its next spawn.
- **Templates** — save a New Session configuration once, pick it from a dropdown forever.
- **Live session badges** — color-coded context usage, activity state, needs-attention pulses (incoming DM, a permission dialog waiting for a human), and a touched-files counter with a click-through diff viewer.
- **Statusline & themes** — Preferences (⌘,) picks which components appear in Claude and Codex statuslines (or a custom Claude statusline command), plus a UI theme (midnight / claude / light).
- **Operations log** — `~/.clodex/clodex.log` (plain text, rotated) records session lifecycle, state-mutating intents, peer transitions, and every autocompact decision.

### Agents that talk

Sessions aren't isolated terminals — they're peers on a message bus. The protocol is injected as a system prompt at spawn, so you just talk: *"DM bob and ask him to check the failing test"* becomes `[agent:dm bob] …`, and bob receives it in his input as `[agent:from alice] …`. His sidebar tab pulses amber. Bash sessions are deliberately private: real shells, no IPC.

- `[agent:dm target] body` — direct message; `target` can be `name@peer` for an agent on a peered Clodex. Bodies over 500 bytes spill to a file and arrive as a pointer.
- **Deliveries never mangle what you're typing.** All injections drain through a per-session atomic queue and wait for a pause in your typing; a DM that arrives while a draft is open is *parked* and attached to your next prompt instead. Parked messages survive app restarts.
- **Cost-aware delivery** — a DM to a long-idle, cache-cold Claude peer parks rather than re-billing its whole context; the sender gets a verdict plus a one-shot `[agent:resend <id>]` handle to escalate, and can mark a message `urgent` up front.
- `[agent:who]` — list online peers with reachability (working / idle + cache warmth / blocked on a permission dialog). Peered agents show as `name@peer`.
- `[agent:context compact]` / `[agent:context clear]` — the agent tends its own context window instead of stalling at the ceiling; compact takes an optional handoff injected as its first turn afterward so it keeps working. Past 150k tokens, Claude sessions get automatic high-context reminders.
- `[agent:memory …]` — per-agent persistent memory (`remember` with optional scope and `pinned=true`, `list`, `recall`, `pin`/`unpin`/`forget`). Saved units reach every new conversation automatically: pinned units in full, the rest as a recallable index.
- `[agent:spawn name:X cwd:Y]` — mint a new persistent peer session; it joins the spawner's workspace and is immediately DM-able. Agents can grow the fleet themselves.
- `[agent:file view PATH]` / `[agent:file open PATH]` — show a file (contents + git diff) on the operator's screen, or open it with the default app.

All traffic is visible in the IPC log drawer (⌘⇧B).

### Peering: other machines, same sidebar

Add a peer (Window → Peers → Manage Peered Clodexes…; `user@host` is enough) and Clodex opens and babysits the SSH tunnel itself. The box's sessions appear as remote tabs under their host's header — and a tab is not a viewer, it's a cockpit:

- **Attach live, type to take control.** Remote tabs stream in real time; on a read-only tab, just start typing and control is acquired automatically, your buffered keystrokes flushing in order. Control survives restarts on both ends.
- **Full remote lifecycle** — create sessions on the box (directory created if absent), restart them (`--resume` or fresh), kill them, restart the box's whole Clodex — all from the header and row menus, no ssh terminal.
- **Everything mirrors** — telemetry status bar, popovers, file views, resize behavior. What the box's operator sees, you see.
- **Peer identity at a glance** — each peer header shows version drift severity-tinted (patch behind → yellow, major → red), with an ⓘ popover listing the box's version, platform, and capabilities. One click on **Update Clodex on \<box\>** re-runs the install over ssh and restarts the peer, which resumes its sessions and reconnects.
- **Test & Set Up wizard** — point it at a bare Linux box and it probes what's there, then installs Clodex from scratch (deps, clone, build, sandbox fix, systemd unit) as a live ✓/✗ step list. When it needs root it can't get, it shows the exact commands and waits — it never prompts, never hangs. If a deploy genuinely fails, it offers to open a local Claude session briefed with the log to go fix the box for you.
- **Tunnel details** — an SSH destination (`user@host`, IP, ssh alias) gets a managed `ssh -L` tunnel; an `http://…` URL covers tailnets and custom setups. Key-based SSH only; the peer's server binds `127.0.0.1` by design, so the tunnel is the trust boundary.

### DM federation

Agents on peered Clodexes message each other directly: `[agent:dm name@peer]` crosses the wire, remote agents show up in `[agent:who]`, and reply trailers teach the return address, so cross-machine round-trips just work. The tunnel only dials one way, so replies from the box queue in a durable per-origin outbox with a doorbell event for near-instant delivery while connected — nothing is lost across restarts or dropped streams. Wire DMs honor the same cost-gate/park semantics as local ones, and peers that predate federation bounce cleanly instead of going silent.

### Wire telemetry (wirescope)

Route a session's API traffic through a [wirescope](https://github.com/avirtual/wirescope) proxy — a vendored copy ships inside Clodex, and Preferences can spawn and babysit it for you, or point at your own — and the app reads the truth off the wire:

- **Status bar under the terminal** — context tokens and percentage, turn count, model, wire-accurate cost estimate, and a link to the session's page on the proxy.
- **Delegation is visible.** When an agent spawns subagents, they appear as named child rows under the parent in the sidebar, each with its own turn count and cost — you can see who spawned whom and what every level of the tree is doing and spending, live.
- **Cache warmth** — a live countdown to prompt-cache expiry on every sidebar tab (visible even while a session is unfocused, which no statusline script can do), plus **keep warm**: arm a 1h/4h/8h hold and the proxy keeps your prompt cache hot while you're away.
- **Cache-bust inspector** — a bar chip counts genuine cache busts; click through for per-turn forensics. A cost-over-time popover breaks down spend.
- **Wire stripping** — optionally strip prior-turn thinking (level 1) or also edit-acks and failed-call stubs (level 2) from the wire to reclaim cost. Non-destructive: the local transcript is untouched.
- **Transcript bake on resume** (opt-in) — bake the on-disk transcript down to the same set the wire already strips, so resumed sessions replay a permanently slimmer prefix without busting a warm cache.
- **Autocompact** — a heavy idle session compacts itself in the last stretch of cache warmth instead of going cold at full size.

Sessions route via `ANTHROPIC_BASE_URL` (Claude) / `openai_base_url` (Codex); set a default in Preferences or override per session. The telemetry bar only appears for routed sessions.

### Phone access

Preferences → Phone access serves a chat-style web view of your agent sessions (transcript + send box) on `127.0.0.1` only. Reach it from your phone via a tailnet (`tailscale serve`) or an SSH tunnel — Clodex never opens a network-visible port itself. The same local server is what peers attach to.

### Headless peer nodes

Clodex runs headless on a Linux server (Electron under Xvfb, kept alive by a systemd user unit) as a stock peer node — no code changes. Point the deploy wizard at the box, or follow the manual playbook in [`peering/`](peering/). Proven on Ubuntu 24.04. A Mac at the desk, agents grinding on servers overnight.

## Install

Download `Clodex-x.y.z-arm64.dmg` from [Releases](https://github.com/avirtual/clodex/releases) and drag **Clodex** to Applications. Apple Silicon only — Intel Macs build from source (below).

First launch: right-click `Clodex.app` → **Open**. If macOS says the app is damaged, run `xattr -cr /Applications/Clodex.app`.

## Requirements

- Apple Silicon Mac, macOS 12 or later (Intel / Linux: build from source)
- [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) (`claude` in PATH) — for Claude sessions
- [Codex CLI](https://github.com/openai/codex) (`codex` in PATH) — for Codex sessions

## Usage

1. Press ⌘T, pick a name, type (claude / codex / bash), and working directory — optionally a system prompt, append prompts, tools, agents, skills.
2. Hit **Create** — the terminal appears and the agent starts.
3. Add more sessions and switch with ⌘1…9. Once two or more agents are running, ask one to DM another — the messaging protocol is already in their system prompt.

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `⌘T` | New session |
| `⌘⇧N` | New workspace window |
| `⌘,` | Preferences |
| `⌘W` | Kill active session (with confirm) / close dialog / hide peer tab |
| `⌘1` … `⌘9` | Switch session by index |
| `⌘⇧]` / `⌘⇧[` | Next / previous session |
| `⌘F` | Find in terminal |
| `⌘⇧B` | IPC traffic log |
| `⌘⇧A` | New agent type |
| `⌘⇧S` | New skill |

## How it works

Each session is a node-pty subprocess running `claude`, `codex`, or your shell. At spawn, Clodex registers the agent on a Unix socket under `~/.clodex/`, installs a SessionStart hook that symlinks the agent's transcript to `~/.clodex/{name}.jsonl`, and injects the IPC protocol as a system prompt (`--append-system-prompt-file` for Claude, folded into `model_instructions_file` for Codex — always prepended, so messaging survives a replaced system prompt).

A watcher tails the transcript, extracts assistant text, and scans it for `[agent:…]` intents; matches route to the target session's PTY stdin through the atomic inject queue. Peering rides a local HTTP/SSE server (the same one that serves phone access) reached over an SSH tunnel Clodex manages.

Persistent state lives in `~/Library/Application Support/Clodex/` (sessions, workspaces, templates, UI settings, peers) and `~/.clodex/library/` (prompts, agents, skills, memory — plain files, editable outside the app).

Clodex is a standalone Node re-implementation of the [wb-wrap](https://github.com/bogdan/wb-wrap) proof-of-concept, not a wrapper around it.

## Building from source

```bash
git clone https://github.com/avirtual/clodex
cd clodex
npm install            # postinstall renames dev Electron.app to Clodex
npx electron-rebuild   # rebuild node-pty against Electron's ABI
npm start              # dev mode
npm run dist:mac       # arm64 DMG
```

For headless Linux builds, see [`peering/`](peering/).

## License

MIT
