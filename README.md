[![Parallax Banner](https://capsule-render.vercel.app/api?type=waving&height=200&color=6c63ff&desc=PARALLAX%20ENGINE&descAlignY=65&fontColor=ffffff&section=header&reversal=true&textBg=false&animation=fadeIn)](https://github.com/Master0fFate/parallax-opencode)

# PARALLAX ENGINE

**The first AI coding assistant that shows its work.**

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![OpenCode](https://img.shields.io/badge/OpenCode-plugin-6c63ff)](https://opencode.ai)
[![npm](https://img.shields.io/npm/v/parallax-opencode)](https://www.npmjs.com/package/parallax-opencode)
[![Tests](https://img.shields.io/badge/tests-30%20passing-brightgreen)]()
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)]()

---

## Quick Install

```bash
# One command -- installs agent, plugin, skills, and dependencies
npx parallax-opencode
```

After install, restart OpenCode and press **Tab** in the TUI to cycle to the Parallax agent.

---

## What Makes Parallax Different

Every AI coding tool (Cursor, Copilot, Windsurf) gives you code. None of them show you **how they got there**.

Parallax captures the complete reasoning trace of every session -- the ambiguity assessment, the invariants analysis, every verification result, every decision -- and makes it visible, exportable, and replayable.

Instead of "trust me, I wrote good code," Parallax says:

> "Here is my complete reasoning trace. Review it. Score it. Compare it with another approach. See for yourself."

### The 4 Invariants

Every action is checked against four questions:

| Question | Why It Matters |
|---|---|
| Where does state live? | Ownership & truth, consistency, blast radius |
| Where does feedback live? | Observability, debugging, monitoring |
| What breaks if I delete this? | Coupling & fragility, safe refactoring |
| When does timing matter? | Async & ordering, race conditions, correctness |

### The Coherence Score

After every session, Parallax computes an evidence-based quality score (0-100):

- **Protocol Coverage (30%)** -- Were all 5 protocol phases completed?
- **Verification Integrity (35%)** -- Pass rate on first attempt?
- **Edge Case Coverage (20%)** -- How many edge categories were analyzed?
- **Timing Discipline (15%)** -- Were phases in correct order?

Track your scores over time and see improvement:

```bash
parallax trace trend
```

### The Trace Protocol

Every session produces a structured JSON trace file:

```bash
parallax trace list
parallax trace show <session-id>
parallax trace score <session-id>
```

Traces are stored in `.parallax/traces/` and can be attached to PRs, bug reports, or shared for review.

### The Friction Loop

1. After every write, Parallax auto-verifies (debounced)
2. 3 retries before blocking further writes
3. Parses verification output and reports specific failures
4. Only the friction loop enforces quality -- the rest is instrumentation

---

## Comparison

| Feature | Plain OpenCode | Cursor | Copilot | Parallax |
|---|---|---|---|---|
| Structured reasoning trace | No | No | No | **Yes** |
| Exportable session history | No | No | No | **Yes** |
| Evidence-based quality score | No | No | No | **Yes** |
| Protocol enforcement | No | No | No | **Yes** |
| Mode switching (plan/build/debug) | No | No | No | **Yes** |
| CLI for trace analysis | No | No | No | **Yes** |

---

## Architecture

```
Parallax Agent (system prompt)
  |
  +-- Plugin hooks
  |     event              --> track session ID
  |     tool.execute.before --> block writes if friction exhausted
  |     tool.execute.after --> debounced auto-verify + trace recording
  |     system.transform   --> inject protocol status + mode skill
  |     session.compacting --> preserve state + export trace
  |
  +-- Custom tools (7)
  |     parallax_verify          auto-verify after writes
  |     parallax_analyze         multi-perspective analysis
  |     parallax_checkin         mark protocol step complete
  |     parallax_plan            switch to PLAN mode
  |     parallax_build           switch to BUILD mode
  |     parallax_debug           switch to DEBUG mode
  |     parallax_trace_export    export session trace to file
  |
  +-- CLI (parallax)
        init                    create .parallax/ directory
        trace list              list all session traces
        trace show <id>         show trace details
        trace score <id>        show coherence score
        trace export <id>       export trace to JSON
        trace trend             show score trend
```

### Three Modes

| Mode | Tool | When |
|---|---|---|
| **PLAN** | `parallax_plan` | Vague requirements, before writing code |
| **BUILD** | `parallax_build` | Executing, writing code (default) |
| **DEBUG** | `parallax_debug` | Post-build quality and security audit |

---

## Manual Install (no npm)

```bash
# Copy files directly
cp dist-standalone/parallax-engine.js ~/.config/opencode/plugins/
cp agents/parallax.md ~/.config/opencode/agents/
cp -r skills/parallax       ~/.config/opencode/skills/
cp -r skills/parallax-plan  ~/.config/opencode/skills/
cp -r skills/parallax-debug ~/.config/opencode/skills/

# Install runtime dependency
cd ~/.config/opencode && npm init -y && npm install @opencode-ai/plugin
```

---

## Project Status

**Current phase: v0.2.0** -- Foundation + Trace Protocol

| Phase | Status | What |
|---|---|---|
| 0: Honest Foundation | Complete | MIT license, TS consolidation, 30 tests |
| 1: Trace Protocol | Complete | Trace recording, export, CLI, coherence score |
| 2: Quality Scoring | Complete | Score formula, trend tracking |
| 3: Git Integration | Planned | Commit trace links, PR-ready reports |
| 4: GitHub Excellence | In progress | README, CI/CD, docs |

---

## Commands

### Plugin Tools (in OpenCode)

```
parallax_verify              Run project verification
parallax_analyze {topic}     Structured multi-perspective analysis
parallax_checkin {step}      Mark protocol step complete
parallax_plan                Switch to PLAN mode
parallax_build               Switch to BUILD mode
parallax_debug               Switch to DEBUG mode
parallax_trace_export        Export session trace to JSON
```

### CLI (terminal)

```
parallax init                    Create .parallax/ directory
parallax trace list              List all traces
parallax trace show <id>         Show trace details
parallax trace score <id>        Show coherence score breakdown
parallax trace export <id>       Export trace as pretty JSON
parallax trace trend             Show score trend over time
```

---

## Files

```
parallax_plugin/
  agents/parallax.md            # Primary agent definition
  src/plugin.ts                 # Canonical plugin (TypeScript)
  src/types.ts                  # Shared type definitions
  src/detect.ts                 # Project detection
  src/trace.ts                  # Trace recording and export
  src/score.ts                  # Coherence score computation
  src/cli.ts                    # CLI entry point
  src/tests/                    # 30 tests across 5 files
  dist/                         # Compiled output
  dist-standalone/              # Standalone plugin file
  skills/                       # Protocol skills
  scripts/                      # Install and publish scripts
  package.json                  # npm package metadata
  LICENSE                       # MIT
```

---

## License

MIT &copy; [@Master0fFate](https://github.com/Master0fFate)
