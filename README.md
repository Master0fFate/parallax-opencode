# PARALLAX ENGINE

**OpenCode plugin** -- protocol enforcement, mode switching (plan/build/debug/horizon), structured reasoning traces, friction-loop verification, and autonomous long-horizon supervision.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/parallax-opencode)](https://www.npmjs.com/package/parallax-opencode)
[![Tests](https://img.shields.io/badge/tests-56%20passing-brightgreen)]()

---

## Install

```bash
npx parallax-opencode
```

Restart OpenCode. The plugin hooks and tools are auto-loaded.

The plugin stores runtime state at `~/.parallax/` (plugin process runs from user home directory).

---

## What It Does

### Two Agent Modes

The plugin provides **two agent tabs**, switch between them with `[Tab]`:

| Agent | Mode | When to Use |
|---|---|---|
| **Parallax** | Plan / Build / Debug | Interactive reasoning with protocol enforcement |
| **Horizon** | Autonomous Supervisor | Multi-hour/multi-day unattended execution |

---

### PARALLAX AGENT -- Protocol Enforcement (6 steps)

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

### HORIZON AGENT -- Autonomous Long-Horizon Supervisor

The **Horizon** agent is a self-driving project supervisor for multi-hour/multi-day tasks. It plans, researches, executes, self-tests, and self-iterates until a goal is 100% complete without needing mid-execution user input.

#### Workflow

| Phase | What Happens |
|---|---|
| 1. RESEARCH | Parses goal, web searches best practices, analyzes codebase, synthesizes findings |
| 2. PLAN | Decomposes goal into milestones + features with acceptance criteria and complexity estimates |
| 3. EXECUTE LOOP | Dispatches sub-agents, runs tests, self-evaluates across 6 dimensions, retries up to 3x per feature |
| 4. FINAL AUDIT | Runs Universal Auditor, full test suite, exports traces, generates completion report |

#### Self-Check Evaluation (6 Dimensions)

After every sub-agent, Horizon scores output across 6 weighted dimensions:

| Dimension | Weight | Check |
|---|---|---|
| Protocol Integrity | 15% | All Parallax steps completed? |
| Verification | 25% | Tests pass? No lint errors? |
| Correctness | 25% | Matches acceptance criteria? |
| Design Quality | 15% | AI slop detected? |
| Edge Case Coverage | 10% | Error paths handled? |
| User Perspective | 10% | Intuitive for all skill levels? |

**Pass threshold:** >= 75% weighted score. Automatic retry on failure (up to 3 cycles).

#### Autonomous Decision Engine

When Horizon encounters ambiguity, it autonomously:
1. Identifies the ambiguity
2. Researches (web search, codebase, project conventions)
3. Decides using best-guess heuristics (preferring conservative defaults)
4. Documents the decision in `decisions.jsonl` for post-hoc review
5. Proceeds without blocking

#### Autonomy Levels

| Level | Behavior |
|---|---|
| `full` | No user interaction. All decisions auto-resolved. |
| `semi` | Milestone boundaries require user approval. |
| `supervised` | Every feature requires user approval before dispatch. |

---

## Plugin Tools

These are called by the AI in OpenCode chat:

### Parallax Tools (9)

| Tool | Purpose |
|---|---|
| `parallax_verify` | Run project verification |
| `parallax_analyze` | Multi-perspective analysis on a topic |
| `parallax_checkin` | Mark a protocol step complete |
| `parallax_plan` / `_build` / `_debug` | Switch modes |
| `parallax_trace_export` | Export session trace to JSON |
| `parallax_trace_pr_comment` | Generate trace as PR-ready markdown |
| `parallax_trace_view` | Show full reasoning trace inline |

### Horizon Tools (18)

#### Session Management
| Tool | Purpose |
|---|---|
| `horizon_init_session` | Initialize session directory + plan.json, state.json, decisions.jsonl, research/, skills/, traces/ |
| `horizon_list_sessions` | List all Horizon sessions from the index |
| `horizon_session_status` | Full status snapshot (plan, state, decisions, research, skills, traces) |

#### Plan Management
| Tool | Purpose |
|---|---|
| `horizon_write_plan` | Write/update plan.json (milestones + features) |
| `horizon_read_plan` | Read current plan with progress (% complete) |
| `horizon_write_state` | Write orchestration state (phase, active items) |
| `horizon_read_state` | Read current orchestration state |

#### Feature/Milestone Tracking
| Tool | Purpose |
|---|---|
| `horizon_update_feature` | Update feature status + auto-recalculate stats + retry cap enforcement |
| `horizon_update_milestone` | Update milestone status |

#### Decision Audit
| Tool | Purpose |
|---|---|
| `horizon_append_decision` | Log auto-decision to decisions.jsonl |
| `horizon_read_decisions` | Read the full decision audit log |

#### Research Cache
| Tool | Purpose |
|---|---|
| `horizon_write_research` | Write findings.md + sources.json |
| `horizon_read_research` | Read cached research |

#### Session-Scoped Skills
| Tool | Purpose |
|---|---|
| `horizon_create_skill` | Create a session-scoped skill (SKILL.md + plan.json registration) |
| `horizon_list_skills` | List session-scoped skills |

#### Trace Archiving
| Tool | Purpose |
|---|---|
| `horizon_save_trace` | Archive a sub-agent trace in traces/ |

#### Configuration
| Tool | Purpose |
|---|---|
| `horizon_config` | Read or write Horizon global configuration |

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
  +-- Parallax custom tools (9)
  |     parallax_verify, parallax_analyze, parallax_checkin,
  |     parallax_plan / _build / _debug,
  |     parallax_trace_export / _pr_comment / _view
  |
  +-- Horizon custom tools (18)
  |     horizon_init_session, horizon_list_sessions, horizon_session_status,
  |     horizon_write_plan, horizon_read_plan, horizon_write_state, horizon_read_state,
  |     horizon_update_feature, horizon_update_milestone,
  |     horizon_append_decision, horizon_read_decisions,
  |     horizon_write_research, horizon_read_research,
  |     horizon_create_skill, horizon_list_skills,
  |     horizon_save_trace,
  |     horizon_config,
  |     horizon_evaluate_subagent
  |
  +-- Parallax State (~/.parallax/)
  |     state.json                  protocol state (immediate on checkins)
  |     traces/                     per-session JSON traces
  |     scores.jsonl                append-only score history
  |     config.json                 per-project config (optional)
  |
  +-- Horizon State (~/.parallax/horizon/)
        config.json                global Horizon config
        index.json                 session UUID -> goal summaries
        sessions/<uuid>/
          plan.json                structured plan (milestones + features)
          state.json               orchestration state
          decisions.jsonl          auto-decision audit log
          research/
            findings.md            synthesized research summary
            sources.json           URL references with key excerpts
          skills/<name>/SKILL.md   session-scoped skills
          traces/                  sub-agent trace exports
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
  agents/
    parallax.md                   # Parallax agent definition
    horizon.md                    # Horizon agent definition
  src/
    plugin.ts                     # Plugin (~1900 lines, 27 tools)
    types.ts                      # Shared types (includes Horizon types)
    horizon.ts                    # Horizon persistence module (512 lines)
    detect.ts                     # Project detection
    trace.ts                      # Trace recording + export
    score.ts                      # Coherence score + analytics
    cli.ts                        # CLI (CI only)
    tests/
      trace.test.ts               # 6 tests
      protocol.test.ts            # 5 tests
      score.test.ts               # 5 tests
      detect.test.ts              # 7 tests
      friction.test.ts            # 7 tests
      horizon.test.ts             # 26 tests
  dist-standalone/                # Bundled plugin (~76KB)
  skills/
    parallax/                     # Parallax protocol skills
    parallax-plan/                # PLAN mode skill
    parallax-debug/               # DEBUG mode skill
    horizon/                      # Horizon autonomous supervisor skill
  scripts/
    install.mjs                   # Local install script
    publish.mjs                   # npm publish script
```

---

## License

MIT (c) [@Master0fFate](https://github.com/Master0fFate)
