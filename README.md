# PARALLAX ENGINE

**OpenCode plugin** -- friction-loop verification, protocol enforcement, mode switching (plan/build/debug), and structured reasoning traces.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/parallax-opencode)](https://www.npmjs.com/package/parallax-opencode)
[![Tests](https://img.shields.io/badge/tests-30%20passing-brightgreen)]()

---

## Install

```bash
npx parallax-opencode
```

Restart OpenCode. The plugin hooks and tools are auto-loaded.

The plugin stores runtime state at `~/.parallax/state.json` (plugin process runs from user home directory).

---

## What It Does

### Protocol Enforcement (6 steps)

The Parallax agent follows a structured reasoning protocol before writing code. The plugin enforces this via the `tool.execute.before` hook:

| Step | Checkin | What it blocks |
|---|---|---|
| 1. Ambiguity Check | `parallax_checkin("ambiguity")` | All writes until done |
| 2. 4 Invariants | `parallax_checkin("invariants")` | Warns after 3 writes without checkin |
| 3. Verification Gate | `parallax_checkin("gate")` | Requires invariants first |
| 4. Design Doc (opt-in) | `parallax_checkin("design")` | Per project via config |
| 5. Commit Decision | `parallax_checkin("commit")` | Any time after gate |
| 6. Summary | `parallax_checkin("summary")` | Generates retrospective |

### Mode Switching

| Mode | Tool | When |
|---|---|---|
| PLAN | `parallax_plan` | Vague requirements, before writing code |
| BUILD | `parallax_build` | Executing, writing code (default) |
| DEBUG | `parallax_debug` | Post-build quality and security audit |

### Friction Loop

After every write, the plugin auto-runs project verification. On failure, it decrements a retry counter. After 3 consecutive failures, it blocks further writes until the issue is resolved.

### Trace Recording

Every session produces a structured reasoning trace -- phases, writes, verification results. The AI can export it to JSON or generate a PR-ready markdown summary.

### The 4 Invariants

| Question | Why It Matters |
|---|---|
| Where does state live? | Ownership & truth, consistency, blast radius |
| Where does feedback live? | Observability, debugging, monitoring |
| What breaks if I delete this? | Coupling & fragility, safe refactoring |
| When does timing matter? | Async & ordering, race conditions, correctness |

Based on [@acidgreenservers AGENTS.md](https://gist.github.com/acidgreenservers/001185d63e5cd65f9fbe6f7a1c70a200)

---

## Plugin Tools

These are called by the AI in OpenCode chat:

| Tool | Purpose |
|---|---|
| `parallax_verify` | Run project verification |
| `parallax_analyze` | Multi-perspective analysis on a topic |
| `parallax_checkin` | Mark a protocol step complete |
| `parallax_plan` / `_build` / `_debug` | Switch modes |
| `parallax_trace_export` | Export session trace to JSON |
| `parallax_trace_pr_comment` | Generate trace as PR-ready markdown |
| `parallax_trace_view` | Show full reasoning trace inline |

---

## CLI (CI Only)

The `parallax` CLI is for CI pipelines and automation, not for interactive use:

```bash
parallax gate --min-score 70       # CI coherence gate (exit code 0/1)
parallax pre-commit                # Git pre-commit hook wrapper
parallax init                      # Create .parallax/ config dir
npx parallax-opencode              # Install the plugin (alias for init)
```

---

## Architecture

```
Parallax Agent (system prompt)
  |
  +-- Plugin hooks (8)
  |     event                       --> session ID + agent switches
  |     tool.execute.before         --> protocol enforcement + friction + design doc gate
  |     tool.execute.after          --> auto-verify + trace recording + state persistence
  |     experimental.chat.system.transform --> protocol status + mode skill + agent context
  |     experimental.session.compacting     --> state preservation + trace export
  |     shell.env                   --> PARALLAX_MODE, PARALLAX_SESSION_ID in shell
  |
  +-- Custom tools (9)
  |     parallax_verify, parallax_analyze, parallax_checkin,
  |     parallax_plan / _build / _debug,
  |     parallax_trace_export / _pr_comment / _view
  |
  +-- State (at ~/.parallax/)
  |     state.json                  protocol state (immediate on checkins)
  |     traces/                     per-session JSON traces
  |     scores.jsonl                append-only score history
  |     config.json                 per-project config (optional)
```

---

## Project Config

Create `.parallax/config.json` in your project root:

```json
{
  "strictness": "standard",
  "minScore": 70,
  "designDocRequired": false,
  "trivialPatterns": ["*.md", "*.json"],
  "highRiskPatterns": ["**/auth/**", "**/*.env*"]
}
```

| Key | Default | Description |
|---|---|---|
| `strictness` | `"standard"` | `"strict"` / `"standard"` / `"relaxed"` |
| `minScore` | `70` | Gate threshold for CI |
| `designDocRequired` | `false` | Block writes until design doc produced |
| `trivialPatterns` | `[]` | File patterns considered low-risk |
| `highRiskPatterns` | `[]` | Patterns always requiring full protocol |

---

## Source Layout

```
parallax_plugin/
  agents/parallax.md            # Agent definition
  src/plugin.ts                 # Plugin (~1000 lines)
  src/types.ts                  # Shared types
  src/detect.ts                 # Project detection
  src/trace.ts                  # Trace recording + export
  src/score.ts                  # Coherence score + analytics
  src/cli.ts                    # CLI (CI only)
  src/tests/                    # 30 tests across 5 files
  dist-standalone/              # Bundled plugin (~37KB)
  skills/                       # Parallax protocol skills
```

---

## License

MIT (c) [@Master0fFate](https://github.com/Master0fFate)