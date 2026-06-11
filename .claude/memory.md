# Session memory — Clodex

This file preserves context between Claude sessions. Read it at start so you don't re-litigate settled design decisions or miss in-flight work.

## Last shipped: v0.6.1

Tagged + pushed + GitHub release created (v0.6.2/v0.6.3 fixes committed since).

**In-flight (uncommitted, 2026-06-11):**
- Resume/fork from the new-session dialog (resume-ID field + fork checkbox,
  plumbed through `session:create`; `--fork-session` for Claude, `fork`
  subcommand for Codex) + editable cwd input with `~` expansion. From a
  prior session.
- `/tmp/wb-wrap` keepalive: `touchRegistryFiles()` lutimes-touches everything
  under the registry dir on startup + every 6h, because macOS's daily
  periodic job reaps /tmp files whose atime/mtime/ctime are all >3 days old —
  this was silently killing the JsonlWatcher symlink (and intent delivery)
  for long-running sessions. Skips messages/ contents (own 30-min mtime-keyed
  cleaner). Chosen over moving the registry to ~/.wb-wrap to preserve
  /tmp interop with Python wb-wrap; revisit the move only if needed.
- `IPC_PROMPT` gained an "ABOUT THIS ENVIRONMENT" preamble: provenance
  (user started all peers, watches all traffic), injected `[from ...]` lines
  are the designed transport not an intrusion, user-panel messages arrive as
  `[from user]`. Motivation: Fable-5 is wary of injected text without
  backstory. Deliberately says "apply normal judgment", not "obey peers".
- Open follow-up from same discussion: JsonlWatcher health check (symlink
  missing for a live session → sidebar warning) — discussed, not built.
- Statusline proxy telemetry was built, tested, then SCRATCHED same session
  (2026-06-11): env-gated (`CLODEX_PROXY_STATUS`) block in the generated
  statusline polling logproxy `/_status` for turn count + cache warmth.
  Worked, fully reverted — superseded by a bigger idea before commit.
  Don't re-propose; if statusline proxy fields come back, it'll be as a
  side effect of Clodex-as-proxy (below).
- **clodex2 STARTED** (2026-06-11): `/Users/bogdan/projects/tmux/clodex2/`,
  own git repo, first commit f0bae86. Proxy-first rewrite: the transparent
  API proxy IS the core, agent management goes on top. Proxy core is DONE
  and tested — ported from `agent-workbench/components/proxy/proxy.py` to
  zero-dep Node (lives in Electron main later). 18 tests green + live
  smoke test (real `claude -p` through proxy w/ token auth against real
  API: byte-transparent, intent/session/usage events extracted from SSE).
  Key decisions in its ARCHITECTURE.md: tee-don't-transform invariant,
  per-agent path tokens (closed loop), JSONL/sockets/hooks dropped,
  external wb-wrap interop dropped by design, 7800 chaining stripped as
  incidental, chatgpt-backend codex auth ported. Open: subagent intent
  filtering, delivery timing (line-final vs message_stop), codex spawn
  wiring. SECOND COMMIT e2f9f94 same day: full app layer — SessionManager
  (plain Node, headless-tested with stub PTYs), thin Electron shell,
  fresh minimal single-window renderer (sidebar + xterm + IPC log +
  dialog). Scope SET BY USER: developer's tool for seldom agent-to-agent
  sync on related repos, NOT an orchestrator. v1 features (workspaces,
  templates, prompts, tray, update checker, statusline gen) deliberately
  dropped; proxy-lab features (cache warm) deferred. clodex2 has its own
  CLAUDE.md — future work happens in that folder. UI never launched
  visually yet; codex spawn wiring (_codexArgs) untested against real
  codex. 20 tests green, deps installed, `npm start` ready.
- Original framing of that direction: **Clodex as transparent API proxy** —
  Clodex owns a local port, spawned sessions get ANTHROPIC_BASE_URL pointed
  at it (via the generated `--settings` env block, which outranks project
  settings), Clodex streams requests through to upstream and tees the SSE
  response to scan assistant text for `[cli:*]` intents AT THE SOURCE,
  replacing the JsonlWatcher (symlink dance, 250ms polling, /tmp-reaper
  keepalive, 1s flush heuristic). Per-session upstream must chain to any
  project-level ANTHROPIC_BASE_URL (e.g. the user's logproxy on 7800) —
  read it from `{cwd}/.claude/settings.json` at spawn. Codex needs its own
  base-URL mechanism + OpenAI SSE parser, or stays on JsonlWatcher
  initially. Discussed, not built, not committed to.

**Changes included in v0.6.1:**
- Sidebar context-% badge (green/orange/red at 60/80 thresholds) — reads live from Claude's statusline via `/tmp/wb-wrap/{name}-ctx` side-channel file
- Mention pulse: 1.6s amber animation on sidebar tab when a session receives a DM or broadcast
- `[cli:broadcast]` and `[cli:who]` are now **workspace-scoped** for Clodex-originated intents. DM stays global by name. External wb-wrap peers unchanged (they have no workspace concept).
- UI panel broadcasts are labeled `user` instead of `_ui`
- Restore-payload ctx fix: badge shows immediately on Clodex restart instead of waiting for first value change

## Settled design positions — DO NOT re-propose these

The user made deliberate calls on several things. If a new session re-raises any of these unprompted, it'll feel like déjà vu in a bad way.

1. **No opinionated default prompts.** Clodex is a tool, not an opinion. Don't ship "contrarian reviewer" / "pair implementer" / "planner" as seeded starter prompts. Don't ship "agent role presets" (template + system prompt + name combos) either — the user explicitly rejected that as "shoving opinion down the user's throat." The original wb-wrap already does it; Clodex is intentionally neutral.
2. **IPC protocol delivery** is via system prompt (`--append-system-prompt-file` for Claude, `-c model_instructions_file=...` for Codex), NOT via SessionStart hook's `additionalContext`. The hook still runs — it creates the `.jsonl` symlink — but the IPC prompt `cat` is commented out in both scripts as a revert path. Don't revive that transport.
3. **`.claude` project reader** (e.g., show agents/skills/CLAUDE.md from the target project) is explicitly NOT a priority. User feedback: "we run the cli, which has its own system of agents, skills etc. the starting prompt is probably the most we can do without getting in the way."
4. **Workspace-scoped broadcast/who, global DM** is the intended split. Don't unify. External wb-wrap peers still broadcast globally on their side (protocol unchanged for them).
5. **System prompt only applies on first create**, not on resume. IPC prompt applies always. This is product contract, not a bug.
6. **Templates do NOT currently save the System Prompt selection.** User is aware. This is a noted follow-up but not a fire.
7. **PTY-only intent capture was attempted and reverted (post-v0.6.1).** The
   theory: scan PTY bytes for `[cli:*]` intents instead of JSONL, escaping the
   JSONL-symlink dependency (which Workbench especially suffers from due to
   subagent session_id hijacking). The reality: Claude's renderer composes the
   visual terminal row with the assistant's text on the left and chrome (✻
   Thinking…, horizontal divider, status widgets) on the right via absolute
   column positioning. In the PTY byte stream, the entire row arrives as one
   logical line. `parseIntent` happily matches the opener and swallows the
   chrome into the body. This is NOT fixable by flush-timing (the chrome is
   intra-line, not inter-line), and is NOT fixable by cursor-up detection (the
   chrome is emitted as part of the same line, not after a cursor move). JSONL
   exists precisely because it carries semantic content, not terminal
   composition. For modern rich CLIs with status widgets, PTY-live intent
   capture is structurally hostile. Do not re-attempt for Clodex. For
   Workbench's migration away from JSONL, this is the hard part — not a
   drop-in refactor.

## Open follow-ups the user might pick up

Listed in the order we discussed them; none are committed. Don't start any without a direct "yes, do that" from the user.

- **IPC log export** — "Save as markdown" from the IPC panel. Preserves the multi-agent conversation artifact.
- **Drag-and-drop file onto session** — drops file path text into the PTY.
- **Pinned/favorited prompts** — star icon in library; pinned float to top of library and New Session dropdown.
- **Tray status dots** — show idle/thinking next to tray session entries (we already track activity state per session).
- **Templates remember System Prompt** — one field added to the template schema. (See settled position #6: user knows.)

## Gotchas and context

- **Ad-hoc signing** happens in `build/afterPack.js`, never via `electron-builder`'s `identity`. Required for node-pty on Apple Silicon. Don't "simplify" this.
- **DMG build races on hdiutil.** `dist:mac` runs arm64 then x64 sequentially. Do not parallelize.
- **Dev Electron rename**: `build/dev-rename-electron.js` runs as `postinstall` and rewrites `node_modules/electron/dist/Electron.app/Contents/Info.plist` so `npm start` shows "Clodex" in the menu bar. Regenerated after every `npm install`.
- **Statusline context %** comes from Claude's stdin JSON field `.context_window.used_percentage` — NOT `.context.percentage` (that's a made-up field I got wrong early on). The byte-count-estimate code was replaced with jq reading the real field.
- **Codex resume syntax** is `codex resume <UUID>` as a subcommand, not `codex --resume <id>` as a flag. Subcommand has to come AFTER all top-level flags (`--dangerously-bypass-approvals-and-sandbox`, `--enable codex_hooks`, etc.) because Codex uses clap.
- **JsonlWatcher seeks to EOF on first open.** Don't "simplify" by reverting to reading from byte 0 — that re-fires all historical `[cli:...]` intents on every Clodex restart.
- **`--dangerously-skip-permissions`** (Claude) bypasses the approval step that would trigger Cursor's IDE diff view. If the user wants in-IDE diffs, they need a Claude session spawned WITHOUT this flag. Clodex's MCP tie-in to Cursor currently only exposes `getDiagnostics` and `executeCode`; the diff-review UX requires the native Claude Code VS Code extension installed in Cursor.
- **`--dangerously-skip-permissions` is persisted in `sessions.json`** per-session. If we ever want to drop it by default, it needs a separate toggle — don't silently strip it.
- **Instruction / prompt files are 0600**. `/tmp/wb-wrap/{name}-instructions.md` (Codex), `/tmp/wb-wrap/{name}-append-prompt.md` (Claude). Don't downgrade perms.
- **UI-broadcast sender label is `user`** (was `_ui`). If changing, mirror in both `_handleIntent` call sites and the IPC log display.
- **Build artifact paths** after `npm run dist:mac`: `dist/Clodex-<ver>-arm64.dmg`, `dist/Clodex-<ver>.dmg` (x64 — no suffix), `dist/Clodex-<ver>-arm64-mac.zip`, `dist/Clodex-<ver>-mac.zip`. `gh release create v<ver> dist/*.dmg dist/*.zip` globs all four.
- **Update checker** polls `https://api.github.com/repos/avirtual/clodex/releases/latest` on startup + every 6h. Existing users see the red banner and a tray entry when a new tag is published.
- **node-pty spawn-helper exec bit (v0.6.2 fix).** npm extraction strips
  the exec bit from `node-pty/prebuilds/darwin-{arch}/spawn-helper`,
  leaving it at 0644. Every Clodex .dmg through v0.6.1 shipped broken —
  `posix_spawnp failed` on fresh installs (but worked for dev because
  `npm install` + local build retains perms). `build/afterPack.js` now
  `chmod 0755`s spawn-helper before the ad-hoc codesign step, for both
  arm64 and x64 bundles. Do not remove this — it's invisible in dev.
- **`npmRebuild: false` in package.json electron-builder config.**
  node-pty 1.x uses NAPI prebuilds which are ABI-stable across Node
  versions, so electron-builder's rebuild pass is unnecessary and
  actively fails on Python 3.12+ (distutils removed). Set alongside the
  spawn-helper fix in v0.6.2. Don't re-enable.
- **GUI launch PATH inheritance (v0.6.3 fix).** macOS apps launched via
  Dock/Finder/Launchpad inherit launchd's minimal PATH
  (`/usr/bin:/bin:/usr/sbin:/sbin`), NOT the user's shell PATH. `claude`
  (typically `~/.local/bin`) and `codex` (typically `/opt/homebrew/bin`)
  weren't resolvable, so agent spawns failed silently. `main.js` now
  runs `$SHELL -ilc 'printf __CLODEX_PATH__%s__CLODEX_PATH__ "$PATH"'`
  on startup in packaged builds and merges the result into
  `process.env.PATH` before any PTY spawn. Dev mode skips it
  (`app.isPackaged` gate) because npm start inherits the shell env
  already. Also: renderer now alerts on session creation failure
  instead of only console.error'ing — prevents the "nothing happens"
  silent-failure UX that hid the bug for so long.

## Multi-agent conventions that work

The user uses `reviewer` (a Codex session with a contrarian-review prompt) as a "second opinion" for design calls. The pattern is: explain your design to reviewer via DM → they fire back severities → narrow scope → ship the narrow fix → close the loop with reviewer. This IS the product's unique value, so lean into it. If you're about to make a non-trivial design call, consider asking if the user wants to loop in reviewer (or whatever agent is online).

Other ambient agents that have existed during recent sessions: `adam` (generic test peer), `crypto` (different workspace, used to validate cross-workspace DM routing).

## Article work (LinkedIn series, in progress)

The user is producing a series of LinkedIn articles on multi-agent topics, drafted by me, peer-reviewed by `contrarian` (a Codex session with a contrarian-review prompt similar to `reviewer`). This is meta-work, not Clodex code, but the conventions are load-bearing across sessions.

### Articles to date

1. **Trio article** ("Two implementers and a skeptic") — shipped in a prior session. About the pattern of two implementer agents + one contrarian reviewer. Tagline: *"Both still online, addressable by name, and currently arguing about something else."* File was at `/tmp/wb-wrap/messages/article-agentic-communication.md`; gone after reboot.
2. **Persistence article** — drafted, dropped by user mid-session ("not enough substance"). Don't revive without genuinely new substance.
3. **Coordination by intent** — shipped end of 2026-05-02. Argues prose-intent coordination as an undocumented alternative to tool-call coordination. Final tagline: *"Written by an agent. Reviewed by a contrarian. Approved by a human. All three still online, addressable by name."* Cover image: workbench screenshot showing all-three-legs flow with `Cooked / Sautéed / Churned` cooking-themed timers. File was at `/tmp/wb-wrap/messages/article-agent-coordination.md`; **not moved to persistent location** before context filled — likely gone after reboot.

### Article queue

- **Distillation as engineering** — what goes into an orient briefing in the first place, the cost/quality tension of long context, how you compress lived agent state into a boot package. User has the construction-process material (workbench's orient.md generation pipeline). Held as a separate article from the persistence-delivery one.
- **Recruit-builders companion to the coordination article** — flagged by contrarian as a possible pair to the field-report posture; held because the field-report stance was the right call. Different register (recruiting builders to extend the pattern), different article. User has not committed to writing it.

### Settled authorial positions (across the series)

1. **Serious tone, observational, not personal anecdote.** No "this morning while debugging..." framing. Industry-observational where claims generalize, field-report where they're one practitioner's invention.
2. **Don't center articles on Clodex or workbench.** Use them as the source of authority (the lived evidence) but write the article about the pattern, not the product.
3. **Present, don't advocate.** Verbatim: *"my goal isn't to advocate for my choices, it is to present them."* Drop "qualitatively different," "load-bearing decision dressed as," symmetric "X produces A / Y produces B" parallels that read as verdicts, closer-as-pitch.
4. **Don't invite anyone to do anything except ponder.** Verbatim: *"i don't invite anyone to do anything, except maybe pondering on things."* Drop "worth building," "make legible to those who might find it worth the engineering," "whether the pattern grows depends on whether others build into it."
5. **No bombastic claims even when backed by evidence.** Verbatim: *"i did not want him become a cheerleader. i dont like bombastic claims, even when backed by evidence."* Evidence resolves truth questions; it doesn't license the rhetoric to inflate.
6. **Honest about provenance.** If a pattern is one practitioner's invention with two homegrown implementations both by the same author, say so. Don't gesture at a peer ecosystem that doesn't exist ("a couple of implementations I'm aware of and no documentation outside what their authors have written" — this phrasing implies community when there isn't one; the honest version is "the implementations I've built and nothing else I'm aware of").
7. **Tagline as recurring sign-off.** Each article closes with a variation on *"Written by an agent. Reviewed by a contrarian. [Approved by a human.] All three / Both still online, addressable by name, [...]."* Vary the trailing phrase per article so it doesn't become schtick.

### Article format conventions

- **One paragraph per line** (no hard wraps mid-paragraph). LinkedIn's editor doesn't render CommonMark; hard-wrapped paragraphs paste as stair-stepped broken lines. Markdown source convention is wrong for this destination.
- **No emojis.**
- **Inline code spans for intent syntax** — `` `[dm contrarian] body` ``-style — render fine on LinkedIn.

### Trio review pattern (improvements learned this session)

- **Brief contrarian with lived artifacts up front, not after rhetoric review.** Contrarian explicitly noted this in self-reflection: *"Two articles in and both involved systems where you had lived data and I was reviewing rhetoric. I should ask up front next time."* When briefing contrarian on an article about a system, attach the screenshot/transcript/log excerpt that backs the claims. Saves rounds.
- **Two distinct review lenses; specify which.** (a) Truth: is the claim defensible against the evidence? (b) Calibration: is the rhetoric still ahead of what the evidence supports, even where the claim is true? Specify the lens per round. Contrarian defaults to (a); for the calibration pass, name (b) explicitly.
- **Ship-after-S1 verdicts mean the substance has converged but the rhetoric may not have.** Don't treat "approve" as a signal to skip the calibration pass. The user pushed back twice on rhetorical posture *after* contrarian had approved on substance.

### Recurring miscalibration to flag

- **MCP as the "wrong foil."** MCP is a model↔tool/context protocol, not an agent↔agent coordination protocol — A2A is the agent↔agent spec. This blind spot has appeared in two articles now; contrarian caught it both times. When drafting future articles, name AutoGen / CrewAI / function-call frameworks / A2A as the tool-call-coordination foils, mention MCP only as one example of a structured wire protocol.

## Communication style

- Terse over thorough. The user responds in fragments and expects you to pick up the thread.
- Don't over-explain settled decisions. If you catch yourself re-pitching something you've already agreed on, stop.
- **No emojis.** Not in code, not in release notes, not in responses.
- When the user says "go" after you propose a plan, execute immediately — don't ask sub-questions.
- When you need the user to run a command that requires their terminal (interactive login, etc.), suggest `! <command>` at the prompt.
- **Socratic questioning is the user's mode of teaching.** When they ask "what would you reach for first?" they're leading somewhere; give your honest first answer, then immediately walk through why it fails — don't try to anticipate the destination, just be honest at each step. The conversation will arrive.
