# PARALLAX ENGINE -- Strategic Roadmap

> The first AI coding assistant that shows its work.
>
> Last updated: 2026-05-25 | Status: [ ] Planned, [/] In Progress, [x] Shipped

---

## WHERE WE ARE (v0.2.0 -- shipped)

[x] Plugin hooks: `tool.execute.before` (write blocking), `tool.execute.after` (auto-verify),
    `experimental.chat.system.transform` (protocol status + skill injection),
    `experimental.session.compacting` (state preservation + trace export),
    `event` (session lifecycle tracking)

[x] 7 custom tools: verify, analyze, checkin, plan, build, debug, trace_export

[x] Protocol enforcement: ordered step checkins (ambiguity -> invariants -> gate -> commit -> summary)

[x] Friction loop: auto-verify after writes, 3 retries, blocks further writes on exhaustion

[x] Mode state machine: free / plan / build / debug

[x] Skill injection: parallax-plan, parallax-debug loaded on mode switch

[x] Trace recording: structured JSON traces in `.parallax/traces/` with phases, writes, metrics

[x] CLI: `parallax init`, `parallax trace list/show/score/export/trend`
    (debug/admin commands -- not the primary user interface)

[x] Coherence score: 0-100 across 4 dimensions (protocol coverage, verification integrity,
    edge case coverage, timing discipline)

[x] Score history: append-only `.parallax/scores.jsonl` with sparkline trend

[x] 30 tests across 5 test files (vitest)

---

## PHASE 1 -- Ship the Trace as an Artifact (In Progress)

The user lives inside OpenCode. They talk to the AI. The AI calls tools.
Phase 1 makes the trace visible in the chat (plugin tools) and enforceable
in CI (the one CLI command that needs a terminal).

### 1.1 -- Trace as PR comment (plugin tool)

The AI outputs the trace directly in the chat. The user copies it. Done.
No terminal. No session ID hunting. No `parallax trace link` nonsense.

- [ ] New tool: `parallax_trace_pr_comment` -- the AI calls this at session end
  (or when the user asks for it). Returns formatted markdown in the chat output:
  - Coherence score with dimensional breakdown (protocol, verification, edges, timing)
  - Protocol phase timeline: what step completed when
  - Write log: every file written with pass/fail/retries
  - Friction summary: successes, trials, retries consumed
  - Link to the trace JSON file on disk
- [ ] The AI pastes this output into the PR description as part of its normal
  workflow -- user doesn't leave OpenCode
- [ ] Edge case: no writes in session -> output a "planning session" variant
- [ ] Edge case: trace not found -> clear error message in chat

### 1.2 -- Inline trace viewer (plugin tool)

Opening an HTML file in a browser is the wrong medium. Show the trace in
OpenCode's chat where the developer already is.

- [ ] New tool: `parallax_trace_view` -- the AI calls this and returns a
  structured, readable trace summary directly in the chat output:
  - Ambiguity assessment (the HIGH/MEDIUM/LOW verdict + questions asked)
  - 4 Invariants analysis (state, feedback, blast radius, timing)
  - Verification gate checklist
  - Every write event with verification status
  - Commit decision and summary
- [ ] Coherence score with grade badge (S/A/B/C/D/F) shown inline
- [ ] The TUI trace browser (Phase 4.3) handles navigation/scrolling through
  large traces; this tool gives the quick at-a-glance version
- [ ] Edge case: trace not found -> error in chat
- [ ] Edge case: very long trace -> truncated with "full trace at .parallax/traces/<id>.json"

### 1.3 -- Coherence gate CLI (CI only)

The ONE CLI command that actually needs to be a CLI. CI pipelines need exit
codes. Humans should never type this -- the AI should tell them the score.

- [ ] `parallax gate --min-score <threshold>` -- reads traces from
  `.parallax/traces/` on disk, computes score, exits non-zero if below threshold
- [ ] `parallax gate --session <id>` -- gate a specific session
- [ ] `parallax gate --last` -- gate the most recent session (default)
- [ ] Document CI integration: GitHub Actions workflow example
- [ ] Edge case: no traces found -> exit code 2 (distinct from score-too-low exit 1)
- [ ] Edge case: trace has no writes -> score = 0, gate fails
- [ ] Note: this is the ONLY CLI command in Phase 1. Everything else is a plugin
  tool the AI calls. The CLI exists for machines, not humans.

### 1.4 -- Pre-commit hook (optional CI integration)

- [ ] Thin wrapper: `parallax pre-commit` = `parallax gate --last --min-score 70`
  with a friendly message
- [ ] Document: drop into `.git/hooks/pre-commit` for teams that want local gating
- [ ] Edge case: not in a git repo -> skip with warning
- [ ] Edge case: no traces exist (first commit in repo) -> skip, don't block

---

## PHASE 2 -- Plugin: Protocol Intelligence (Planned)

These are plugin features -- changes to the OpenCode plugin that make the protocol
smarter about when and how it enforces rules.

### 2.1 -- State persistence on every transition

- [ ] Write friction, mode, and protocol state to `.parallax/state.json` on every
  state transition (checkin, mode switch, write, verify). Currently state is
  in-memory only.
- [ ] Restore state from disk on plugin init if a trace is active
- [ ] Debounce writes (100ms) to avoid excessive disk I/O during rapid writes
- [ ] This makes `parallax gate` meaningful mid-session, not just post-hoc
- [ ] Edge case: disk full -> log warning, continue with in-memory state

### 2.2 -- Adaptive protocol

- [ ] Detect trivial changes (single-line fix, typo, comment tweak, config value)
  and auto-skip non-critical verification gate steps
- [ ] Detect high-risk changes (auth, DB schema, payment, security paths, env files)
  and insist on full protocol regardless of mode
- [ ] Implementation: inspect `input.args` in `tool.execute.before` -- check
  file extension, path patterns, diff size. Use a configurable allowlist/blocklist.
- [ ] Start simple: path pattern blocklist (`**/auth/**`, `**/*.env*`, `**/schema/**`)
  combined with file extension allowlist (`.md`, `.json`, `.yml` are "trivial").
- [ ] Edge case: file not found in args -> treat as high-risk (conservative default)

### 2.3 -- Post-session retrospective

- [ ] On `parallax_checkin("summary")`, auto-generate a retrospective markdown block:
  - What was built / changed (summary of phases + files touched)
  - Verification results summary (pass/fail/retry counts)
  - Coherence score with dimensional breakdown
  - Recommended review focus areas for the human
- [ ] Return the markdown in the checkin response so the AI can paste it
- [ ] Edge case: no writes in session -> generate a "planning session" variant

### 2.4 -- Permission hook integration (permission.ask)

- [ ] Use the `permission.ask` hook (stable, documented in plugin API) to add
  protocol-awareness to OpenCode's permission system
- [ ] When AI attempts write/edit without completing invariants, set
  `output.status = "ask"` (force user confirmation) instead of throwing errors
- [ ] When invariants complete and score is high, set to `"allow"`
- [ ] When friction exhausted, set to `"deny"`
- [ ] This replaces the current `tool.execute.before` error-throwing with a
  more graceful user-facing permission flow
- [ ] Note: this hook exists in the API but no known community plugin uses it yet.
  If the hook doesn't fire as expected, fall back to the current error-throwing
  approach in `tool.execute.before`

### 2.5 -- Multi-agent protocol sharing

- [ ] When user switches agents in the TUI (TAB key), carry protocol state to the
  new agent. Currently the plugin tracks `session.next.agent.switched` events
  but does nothing with protocol state on switch.
- [ ] Inject protocol status into the system prompt of the new agent via
  `experimental.chat.system.transform` so it knows where the session left off
- [ ] Reset friction counter on agent switch (new agent = fresh verification state)

### 2.6 -- Shell environment injection (shell.env)

- [ ] Use the `shell.env` hook (currently unused) to inject Parallax context
  into every shell command the AI runs:
  - `PARALLAX_MODE` = current mode (plan/build/debug)
  - `PARALLAX_SESSION_ID` = current session ID
  - `PARALLAX_FRICTION_RETRIES` = remaining retries
- [ ] This makes shell-based verification scripts aware of the protocol state
- [ ] Edge case: no active session -> skip injection

---

## PHASE 3 -- Plugin: Developer Experience (Planned)

Features that make the protocol feel integrated rather than bolted-on.

### 3.1 -- Configurable strictness

- [ ] Create `.parallax/config.json` (schema-versioned) with per-project settings:
  - `strictness`: `"strict"` | `"standard"` | `"relaxed"`
  - `minScore`: gate threshold (default 70)
  - `adaptiveProtocol`: enable/disable Phase 2.2 heuristics
  - `designDocRequired`: enable/disable Phase 3.2 design doc enforcement
  - `trivialPatterns`: custom allowlist of file patterns for adaptive protocol
  - `highRiskPatterns`: custom blocklist of patterns that always require full protocol
- [ ] Plugin reads config on init. Missing config = defaults (standard strictness).
- [ ] `parallax init` generates a template config with comments

### 3.2 -- Design doc enforcement

- [ ] For non-trivial changes (configurable via Phase 3.1 config), block code
  writes until `parallax_checkin("design")` is completed
- [ ] `parallax_checkin("design")` records a design phase in the trace
- [ ] Override: set `PARALLAX_FORCE=1` environment variable to bypass.
  Override events are logged in the trace with timestamp and reason.
- [ ] This is opt-in per project via `.parallax/config.json` (disabled by default)

### 3.3 -- Protocol extension via skills

- [ ] Allow skills to declare custom protocol steps in their YAML frontmatter:
  ```yaml
  protocolSteps:
    - name: security_review
      label: "Security Review"
      after: invariants
      before: gate
  ```
- [ ] Plugin parses skill frontmatter on load and integrates declared steps
  into the protocol state machine (step slotting between existing phases)
- [ ] Custom steps appear in the protocol status block injected into system prompt
- [ ] `parallax_checkin("security_review")` works like any other step checkin
- [ ] Skills without `protocolSteps` declaration are unaffected (backward compatible)

### 3.4 -- Message transform injection

- [ ] Use `experimental.chat.messages.transform` (documented in plugin API,
  experimental) to inject protocol reminders into the message stream:
  - After 3 writes without invariants checkin: "You have written 3 files. Consider
    checking invariants now."
  - After friction exhaustion: "Verification is failing. Review the error before
    writing more code."
- [ ] These are soft nudges, not blocking errors. Blocking stays in
  `tool.execute.before`.
- [ ] Note: experimental hook, behavior may change across OpenCode versions.
  Wrap in a try/catch so a broken hook doesn't crash the plugin.

### 3.5 -- Tool definition modification

- [ ] Use `tool.definition` (currently unused) to modify how write tools appear
  to the AI based on protocol phase:
  - Before ambiguity check: append "[PROTOCOL: complete ambiguity check first]"
    to write tool descriptions
  - After friction exhaustion: append "[BLOCKED: verification failing]"
- [ ] This makes the protocol state visible to the AI at tool selection time,
  not just in the system prompt

---

## PHASE 4 -- TUI Integration (Planned)

OpenCode supports TUI plugins as a separate module type (`@opencode-ai/plugin/tui`).
The oh-my-opencode-slim plugin (4.7k stars) proves this works in production:
it renders agent status in the `sidebar_content` slot with `setInterval` polling.

Server plugins and TUI plugins are separate processes with no shared memory.
Communication mechanism: the server plugin writes state to `.parallax/state.json`
(Phase 2.1), the TUI plugin reads it via polling.

### 4.1 -- Protocol status sidebar widget

- [ ] Create a separate TUI plugin module (`parallax-tui`) that renders
  protocol status in the OpenCode terminal UI
- [ ] Uses `api.slots.register({ slots: { sidebar_content } })` -- same pattern
  as oh-my-opencode-slim's agent status display
- [ ] Polls `.parallax/state.json` every 500ms, triggers `api.renderer.requestRender()`
  on change
- [ ] Renders with `@opentui/solid` primitives (`createElement`, `insert`, `setProp`)
  matching the proven oh-my-opencode-slim rendering pattern
- [ ] Displays:
  - Current mode (PLAN/BUILD/DEBUG) with color from `api.theme.current`
  - Protocol step checklist: [x] Ambiguity [x] Invariants [ ] Gate [ ] Commit [ ] Summary
  - Friction: "3 retries" or "BLOCKED" with warning color
  - Session coherence score (from trace data in the state file)
- [ ] Uses `api.lifecycle.onDispose()` to clear the polling interval
- [ ] Edge case: state.json doesn't exist yet -> show "No active session"
- [ ] Edge case: file parse error -> show "State unavailable" with last known good state

### 4.2 -- TUI trace quick-view (stretch goal)

- [ ] If Phase 4.1 is stable, add a read-only trace summary accessible from the
  sidebar: select a trace file from `.parallax/traces/`, show score + phase timeline
- [ ] Uses `api.slots` for rendering, same polling pattern as 4.1
- [ ] This is a stretch goal -- the primary trace interface is the chat tool
  (`parallax_trace_view` from Phase 1.2). The TUI view is for quick at-a-glance
  reference, not deep inspection

---

## PHASE 5 -- Analytics & Insights (Planned)

The plugin records data. Phase 5 turns that data into actionable signal.

### 5.1 -- Enhanced score analytics

- [ ] Per-project score breakdowns: `parallax trace trend --project <name>`
- [ ] Weekly/monthly reports: `parallax trace report --week` generates a markdown
  summary of all sessions in the past week
- [ ] Verification failure pattern detection: which files/operations cause the
  most friction retries
- [ ] All analytics are local-only, offline, no telemetry

### 5.2 -- Trace comparison

- [ ] `parallax trace diff <session-a> <session-b>` -- compare two traces
  side by side: which had higher coherence, more friction, different approaches
- [ ] Useful for A/B testing protocol changes: "did adaptive protocol improve
  first-pass verification rate?"
- [ ] Output as a diff-style markdown table

### 5.3 -- Protocol compliance report

- [ ] `parallax trace compliance <session-id>` -- generate a checklist report
  of which protocol steps were completed, which were skipped, and why
- [ ] Flag protocol violations (e.g., 5 writes without invariants checkin)
  with file references and timestamps
- [ ] Useful for code review: reviewer sees at a glance whether the AI
  followed the methodology

---

## HOUSEKEEPING -- Credibility-Critical

These are not strategic features. They are correctness and trust issues that
must be resolved because they undermine everything else.

### H1 -- Remove broken Discord RPC

The Discord RPC module (`src/discord-rpc.ts`, 352 lines) is documented as broken.
It connects via IPC but presence never appears. It adds dead weight to every
plugin initialization, 5 hook handlers, and the npm dependency tree.

- [ ] Delete `src/discord-rpc.ts` entirely
- [ ] Strip from `src/plugin.ts`: remove import (line 34), `DISCORD_RPC_ENABLED`
  constant (line 42), init block in `server()` (lines 158-160), presence updates
  in `tool.execute.before` (lines 376-385), `tool.execute.after` (lines 433-442),
  `event` handler (lines 534-589), `chat.message` (lines 596-621),
  `chat.params` (lines 623-648)
- [ ] Remove `@xhayper/discord-rpc` from `package.json` dependencies
- [ ] Update `build:standalone` script (esbuild no longer needs to externalize it)
- [ ] Verify: `npm run build:all` and `npm run test` pass

### H2 -- Dead dependency audit

Beyond Discord RPC, audit all dependencies for actual usage:

- [ ] `bun-types` in devDependencies -- the project uses `tsc` and `vitest`, not
  Bun's runtime. Is this still needed?
- [ ] `@types/node` -- verify version is compatible with the Node target
- [ ] Any unused imports across all source files

### H3 -- Documentation reconciliation

- [ ] README.md "Project Status" phase numbering (Phase 0-4) must match
  ROADMAP.md phase numbering (Phase 1-5) or be removed in favor of a single
  reference to ROADMAP.md
- [ ] CHANGELOG.md must list all completed Phase 1 sub-items when shipped
- [ ] Agent definition (`agents/parallax.md`) must reference `parallax gate`
  and trace CLI once Phase 1 ships
- [ ] Skill docs must be updated if protocol steps change (Phase 3.3)

### H4 -- Release process

- [ ] `npm run release:dry` works end-to-end
- [ ] Version bump convention documented and followed:
  - Breaking protocol changes = major
  - New tools/commands = minor
  - Fixes = patch
- [ ] GitHub release notes auto-generated from CHANGELOG.md

### H5 -- Hook coverage audit

The plugin uses 7 of OpenCode's 17 available hooks. The unused 10 hooks
(`permission.ask`, `shell.env`, `tool.definition`, `chat.headers`,
 `command.execute.before`, `config`, `experimental.chat.messages.transform`,
 `experimental.compaction.autocontinue`, `experimental.text.complete`,
 `tool.definition`) should be audited for applicability. Several are already
  roadmapped (Phase 2.4, 2.6, 3.4, 3.5).

- [ ] For each unused hook, document: "used in Phase X" or "not applicable because Y"
- [ ] This prevents future contributors from wondering "why doesn't Parallax use hook Z?"

---

## CROSS-HARNESS VISION (Separate Projects)

The Parallax protocol is harness-agnostic. The trace CLI can already read traces
from any source. The following are separate implementation projects, NOT work
items for this OpenCode plugin codebase.

### Claude Code
- Port the core protocol enforcement (write blocking, step ordering) to Claude Code's
  hook model (`pre_tool` hooks)
- If write-blocking isn't possible in Claude Code's hook architecture, fall back to
  advisory enforcement + trace recording
- The trace CLI and coherence scoring carry over unchanged

### Cursor
- Investigate Cursor's rule system for protocol enforcement
- If full enforcement isn't possible, ship as agent instructions via `.cursorrules`
  + trace CLI
- The CLI is always portable even when enforcement isn't

### Team trace aggregation (research item)
- This requires a trace sharing mechanism that doesn't exist yet. Current traces
  are git-ignored local files. Options to research:
  - Opt-in git tracking of `.parallax/traces/` (remove from `.gitignore` per project)
  - A `parallax trace share` command that uploads to a team-accessible location
  - CI artifact aggregation (collect traces as CI artifacts, aggregate post-hoc)
- This is a research item, not a planned feature. The "no backend" claim in the
  original roadmap was incorrect -- aggregation requires a sharing mechanism.

---

## WHAT NOT TO DO

| Trap | Why |
|---|---|
| Adding 50+ skills | Parallax is a process engine, not a content library. Skills extend the protocol -- they don't replace it. |
| Supporting 7 harnesses immediately | One solid OpenCode integration beats 7 half-working ports. Cross-harness is a vision, not a sprint. |
| Web dashboard / Electron app | Wrong medium. The developer is in the terminal. TUI plugin covers this without leaving the context. |
| Monetizing too early | Build the thing people depend on first. Business model comes after adoption. |
| Over-engineering the protocol | 6 steps is good. Make them smarter (Phase 2), not more numerous. Skill extensions (Phase 3.3) are opt-in. |
| Building features the plugin API can't support | Every item in this roadmap was verified against the actual OpenCode plugin API (17 hooks, SDK client, TUI slots) and cross-referenced with real community plugins (oh-my-opencode-slim, opencode-notify, opencode-wakatime). No CLI commands for humans. No TUI keybindings that trigger server tools (unproven pattern). No cross-harness features in the main roadmap (those are in the appendix). |

---

## SUCCESS CRITERIA

How we know this roadmap is working:

- [ ] A developer finishes a session and the AI pastes a Parallax trace into the PR
      description without the developer asking for it -- it just appears in the chat
- [ ] A CI pipeline blocks a PR because `parallax gate --min-score 70` returned exit 1
- [ ] A developer asks the AI "show me the trace" and `parallax_trace_view` returns
      a readable summary in the chat immediately
- [ ] Someone installs Parallax specifically for the trace-in-PR feature
- [ ] A developer TAB-switches agents and sees the protocol status carry over
- [ ] Someone creates a `.parallax/config.json` with project-specific strictness
- [ ] A Parallax protocol status widget appears in someone's OpenCode sidebar
      (via the TUI plugin's `sidebar_content` slot)

These are signals that Parallax is becoming quality infrastructure
rather than just another agent configuration file.
