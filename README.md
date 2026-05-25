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
npx parallax-opencode
```

After install, restart OpenCode and press **Tab** to cycle to the Parallax agent.

---

## What Makes Parallax Different

Every AI coding tool gives you code. None of them show you **how they got there**.

Parallax captures the complete reasoning trace of every session -- the ambiguity assessment, the invariants analysis, every verification result, every decision -- and makes it visible, exportable, and replayable.

> "Here is my complete reasoning trace. Review it. Score it. Compare it. See for yourself."

### The 4 Invariants

| Question | Why It Matters |
|---|---|
| Where does state live? | Ownership & truth, consistency, blast radius |
| Where does feedback live? | Observability, debugging, monitoring |
| What breaks if I delete this? | Coupling & fragility, safe refactoring |
| When does timing matter? | Async & ordering, race conditions, correctness |

Based on [@acidgreenservers AGENTS.md](https://gist.github.com/acidgreenservers/001185d63e5cd65f9fbe6f7a1c70a200)

### The Coherence Score

After every session, Parallax computes an evidence-based quality score (0-100):

- **Protocol Coverage (30%)** -- Were all 6 protocol phases completed?
- **Verification Integrity (35%)** -- Pass rate on first attempt?
- **Edge Case Coverage (20%)** -- How many edge categories were analyzed?
- **Timing Discipline (15%)** -- Were phases in correct order?

Track scores over time:

```bash
parallax trace trend
parallax trace report --week
```

### Trace in Your PR

The AI calls `parallax_trace_pr_comment` at session end and outputs a formatted markdown block directly in the chat. Copy it into your PR. No terminal needed.

### CI/CD Gate

```yaml
- name: Parallax Gate
  run: parallax gate --min-score 70
```

Pre-commit hook:
```bash
echo 'parallax pre-commit' >> .git/hooks/pre-commit
```

---

## Comparison

| Feature | Plain OpenCode | Cursor | Copilot | Parallax |
|---|---|---|---|---|
| Structured reasoning trace | No | No | No | **Yes** |
| Trace as PR comment (inline) | No | No | No | **Yes** |
| Evidence-based quality score | No | No | No | **Yes** |
| Protocol enforcement (6 steps) | No | No | No | **Yes** |
| Mode switching (plan/build/debug) | No | No | No | **Yes** |
| CI coherence gate | No | No | No | **Yes** |
| Session retrospective | No | No | No | **Yes** |
| Design doc enforcement | No | No | No | **Yes** |
| Multi-agent state sharing | No | No | No | **Yes** |
| Shell env injection | No | No | No | **Yes** |
| Trace analytics | No | No | No | **Yes** |

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
  |     parallax_verify             auto-verify after writes
  |     parallax_analyze            multi-perspective analysis
  |     parallax_checkin            protocol step checkin (6 steps incl. design)
  |     parallax_plan / _build / _debug   mode switching
  |     parallax_trace_export       export session trace to JSON file
  |     parallax_trace_pr_comment   generate trace as PR-ready markdown
  |     parallax_trace_view         show full reasoning trace inline in chat
  |
  +-- State files
  |     .parallax/state.json        written on every transition (debounced)
  |     .parallax/traces/           per-session JSON trace files
  |     .parallax/scores.jsonl      append-only score history
  |     .parallax/config.json       per-project config (optional)
  |
  +-- CLI (parallax) -- 11 commands
        init | trace list/show/score/export/trend/report/compare/compliance
        gate --min-score <n> | pre-commit
```

### Three Modes

| Mode | Tool | When |
|---|---|---|
| **PLAN** | `parallax_plan` | Vague requirements, before writing code |
| **BUILD** | `parallax_build` | Executing, writing code (default) |
| **DEBUG** | `parallax_debug` | Post-build quality and security audit |

### Six Protocol Steps

| Step | Checkin | Enforced |
|---|---|---|
| 1. Ambiguity Check | `parallax_checkin("ambiguity")` | Blocks all writes until done |
| 2. 4 Invariants | `parallax_checkin("invariants")` | Warns after 3 writes without checkin |
| 3. Verification Gate | `parallax_checkin("gate")` | Requires invariants first |
| 4. Design Doc *(opt-in)* | `parallax_checkin("design")` | Per project via config |
| 5. Commit Decision | `parallax_checkin("commit")` | Any time after gate |
| 6. Summary | `parallax_checkin("summary")` | Generates retrospective |

---

## Project Config (.parallax/config.json)

```json
{
  "strictness": "standard",
  "minScore": 70,
  "adaptiveProtocol": false,
  "designDocRequired": false,
  "trivialPatterns": ["*.md", "*.json"],
  "highRiskPatterns": ["**/auth/**", "**/*.env*"]
}
```

| Key | Default | Description |
|---|---|---|
| `strictness` | `"standard"` | `"strict"` / `"standard"` / `"relaxed"` |
| `minScore` | `70` | Gate threshold for CI |
| `adaptiveProtocol` | `false` | Auto-skip gate steps for trivial changes |
| `designDocRequired` | `false` | Block writes until design doc produced |
| `trivialPatterns` | `[]` | File patterns considered low-risk |
| `highRiskPatterns` | `[]` | Patterns always requiring full protocol |

---

## Manual Install

```bash
cp dist-standalone/parallax-engine.js ~/.config/opencode/plugins/
cp agents/parallax.md ~/.config/opencode/agents/
cp -r skills/parallax       ~/.config/opencode/skills/
cp -r skills/parallax-plan  ~/.config/opencode/skills/
cp -r skills/parallax-debug ~/.config/opencode/skills/
cd ~/.config/opencode && npm init -y && npm install @opencode-ai/plugin
```

---

## Project Status

**v0.3.0** -- Trace Protocol + Protocol Intelligence + Analytics

| Phase | Status | What |
|---|---|---|
| 1: Trace Artifact | Complete | PR comments, inline viewer, CI gate, pre-commit |
| 2: Protocol Intelligence | Complete | State persistence, retrospective, multi-agent sharing, shell env, design doc |
| 3: Developer Experience | Partial | Config system, design doc gate. Adaptive protocol deferred |
| 4: TUI Integration | Planned | Sidebar protocol status widget |
| 5: Analytics | Complete | Weekly reports, trace comparison, compliance reports |

See [ROADMAP.md](ROADMAP.md) for the full strategic plan.

---

## Commands

### Plugin Tools (AI calls in OpenCode chat)

```
parallax_verify                 Run project verification
parallax_analyze {topic}        Multi-perspective analysis
parallax_checkin {step}         Protocol step (ambiguity/invariants/gate/design/commit/summary)
parallax_plan / _build / _debug Mode switching
parallax_trace_export           Export session trace to JSON
parallax_trace_pr_comment       Generate trace as PR-ready markdown
parallax_trace_view             Show reasoning trace inline in chat
```

### CLI (for CI and analytics)

```
parallax init                    Create .parallax/ directory
parallax trace list              List all traces
parallax trace show <id>         Show trace details
parallax trace score <id>        Show coherence score breakdown
parallax trace export <id>       Export trace as pretty JSON
parallax trace trend             Show score trend over time
parallax trace report --week     Weekly analytics report
parallax trace compare <a> <b>   Side-by-side trace comparison
parallax trace compliance <id>   Protocol compliance report
parallax gate --min-score <n>    CI coherence gate
parallax pre-commit              Git pre-commit hook wrapper
```

---

## Files

```
parallax_plugin/
  agents/parallax.md            # Primary agent definition
  src/plugin.ts                 # Canonical plugin (TypeScript, 900+ lines)
  src/types.ts                  # Shared type definitions
  src/detect.ts                 # Project detection
  src/trace.ts                  # Trace recording and export
  src/score.ts                  # Coherence score + analytics
  src/cli.ts                    # CLI entry point (11 commands)
  src/tests/                    # 30 tests across 5 files
  dist/                         # Compiled output
  dist-standalone/              # Standalone bundled plugin (34KB)
  skills/                       # Protocol skills
  scripts/                      # Install and publish scripts
  .parallax/                    # Runtime state + traces + scores
  ROADMAP.md                    # Strategic roadmap
  CHANGELOG.md                  # Version history
```

---

## License

MIT (c) [@Master0fFate](https://github.com/Master0fFate)
