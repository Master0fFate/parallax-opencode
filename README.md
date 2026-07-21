<p align="center">
  <img src="./data/parallaxtui.png" alt="Parallax Engine" width="220" />
</p>

<h1 align="center">Parallax Engine</h1>

<p align="center"><strong>OpenCode changes you can prove.</strong></p>

**A verified change loop for OpenCode:** preflight the task, make the change, run a bounded project check, and leave a durable receipt.

[![CI](https://github.com/Master0fFate/parallax-opencode/actions/workflows/ci.yml/badge.svg)](https://github.com/Master0fFate/parallax-opencode/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/parallax-opencode)](https://www.npmjs.com/package/parallax-opencode)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

Release proof is fail-closed: the packed npm artifact is installed and imported, then loaded by a credential-free **real OpenCode 1.18.x process** that must discover Parallax tools.

## 30-second demo

Requires Node.js 20+ and OpenCode 1.18.x.

```bash
npx parallax-opencode@latest install
npx parallax-opencode@latest doctor
opencode .
```

Give OpenCode its first task:

> Use Parallax to add one focused test for the smallest uncovered edge case in this repository. Verify it and report the receipt ID.

Parallax guides OpenCode through **PREFLIGHT → CHANGE → VERIFY → RECEIPT**. Restart OpenCode after a first install so copied agents and skills are loaded.

---

## Why Parallax

AI-generated changes are easy to produce and hard to trust. Parallax makes the evidence part of the workflow:

1. **PREFLIGHT** — inspect repository evidence, state acceptance criteria, classify ambiguity, and complete readiness check-ins.
2. **CHANGE** — make the smallest coherent change under OpenCode's configured permissions.
3. **VERIFY** — detect and run one bounded project check for the changed-file batch.
4. **RECEIPT** — persist the command, arguments, duration, exit code, verdict, changed files, and bounded output.

Only `pass` is passing evidence. `fail`, `skipped`, and `unknown` remain visible. OpenCode `ask` and `deny` permissions are always authoritative.

### Choose a working mode

| Mode | Use it for |
|---|---|
| **Parallax / PLAN** | Scoping acceptance criteria and checks |
| **Parallax / BUILD** | Focused implementation (default build mode) |
| **Parallax / DEBUG** | Evidence-led investigation and remediation |
| **Horizon** | Milestone-based work that must persist and resume across invocations |

Horizon is durable, prompt-driven supervision—not a background daemon or a guarantee of unattended completion. It advances only while OpenCode is running, the agent is active, tools are available, and permissions are granted.

## Install and lifecycle

The package has no install-time configuration side effects. The explicit installer validates JSON/JSONC before mutation, writes atomically, backs up customized files, records managed ownership, and is safe to repeat.

```bash
npx parallax-opencode@latest install
npx parallax-opencode@latest status --json
npx parallax-opencode@latest doctor --json
npx parallax-opencode@latest uninstall --dry-run
npx parallax-opencode@latest uninstall
```

Use `--config-dir <path>` or `OPENCODE_CONFIG_DIR` for a non-default OpenCode config root. Run `npx parallax-opencode@latest help` for the complete lifecycle interface.

The installer registers `"parallax-opencode"` and copies these packaged assets into the selected OpenCode config root:

```text
agents/parallax.md
agents/horizon.md
agents/horizon-worker.md
agents/horizon-auditor.md
skills/parallax-plan/SKILL.md
skills/parallax-debug/SKILL.md
```

Uninstall removes only registration and assets proven to be installer-managed. Customized assets, unrelated settings, and backups are preserved.

## Verification evidence and state

Project-local runtime evidence is written under the active workspace:

```text
.parallax/
├── config.json                         optional project config
├── verification-ledger.jsonl           schema-v2 verification receipts
├── sessions/<open-code-session>/       protocol state and pending verification batches
├── traces/                             exported session traces
└── scores.jsonl                        optional CLI score history
```

Horizon orchestration state is separate and durable:

```text
~/.parallax/horizon/
├── config.json
├── index.json
└── sessions/<horizon-session>/
    ├── plan.json
    ├── state.json
    ├── decisions.jsonl
    ├── research/
    ├── skills/
    └── traces/
```

Both locations are runtime state. `.parallax/` is gitignored by this repository and should not be committed in consumer projects.

## Configuration

Create `.parallax/config.json` in the project root only when overriding defaults:

```json
{
  "strictness": "strict",
  "minScore": 70,
  "adaptiveProtocol": false,
  "designDocRequired": false,
  "trivialPatterns": [],
  "highRiskPatterns": []
}
```

| Key | Default | Meaning |
|---|---:|---|
| `strictness` | `"strict"` | Runtime write gate: `strict`, `standard`, or `relaxed` |
| `minScore` | `70` | Minimum score used by the CLI gate |
| `adaptiveProtocol` | `false` | Reserved compatibility flag; the default keeps the fixed workflow |
| `designDocRequired` | `false` | Requires the design readiness check before writes |
| `trivialPatterns` | `[]` | Project-defined low-risk file patterns |
| `highRiskPatterns` | `[]` | Project-defined patterns that require full protocol |

Unknown fields and malformed values fail explicitly rather than silently weakening enforcement.

## How it fits together

```text
OpenCode
  ├── Parallax and Horizon agent prompts
  ├── mode skills (plan and debug)
  └── parallax-opencode plugin
       ├── session-aware protocol write gate
       ├── changed-file batching
       ├── bounded project-check detection
       ├── schema-v2 receipt ledger and traces
       ├── Parallax mode, analysis, health, and trace tools
       └── Horizon plan/state/research/decision/skill/evaluation tools
```

`parallax_checkin` records readiness steps in order: `ambiguity`, `invariants`, `gate`, optional `design`, `commit`, and `summary`. The pre-change gate records that the work is understood; it is not post-change proof. The `strictness` setting changes how early the runtime blocks a non-compliant write; it does not define a different agent workflow. `parallax_verify` claims the pending changed-file batch and appends the observed verification receipt.

Project checks are selected without evaluating package metadata or interpolating user input into a shell. For Node projects, Parallax chooses the first declared script in this order: `verify`, `test`, `typecheck`, `check`, `lint`, `build`, and uses the declared or lockfile-selected package manager. Cargo and Python use fixed argument-separated checks. The default timeout is 120 seconds and output is bounded.

## Tool reference

### Parallax

- `parallax_checkin`, `parallax_verify`, `parallax_health`
- `parallax_plan`, `parallax_build`, `parallax_debug`, `parallax_horizon`
- `parallax_analyze`, `parallax_hyperplan`
- `parallax_trace_export`, `parallax_trace_view`, `parallax_trace_pr_comment`

Hyperplan generates an optional three-round adversarial review (analysis, cross-attack, defense) and synthesizes supplied findings. OpenCode's available `task` tool performs any sub-agent dispatch; Hyperplan itself does not run agents.

### Horizon

Horizon is a context-efficient sequential supervisor. For each atomic feature it dispatches only packaged `horizon-worker`, waits for completion and an observed schema-v2 receipt, dispatches only packaged read-only `horizon-auditor`, waits again, then accepts or sends one corrective worker. At most one delegated task is active; overlap and parallel dispatch are forbidden. Full implementation/audit detail remains in child sessions and archived traces while each child returns a structured summary of at most 2,000 characters. A feature is ready only with persisted receipt ID + `pass` verdict evidence and an independent auditor acceptance; evaluator scores cannot set verification or readiness.

Horizon tools initialize/list/status sessions; read and write plans and state; update features and milestones; append/read decisions; write/read research; create/list session skills; archive traces; persist observed verification/audit evidence; evaluate supplied sub-agent evidence; and read/write Horizon configuration. They persist and score supplied information but do not run continuously or prove correctness.

- Session: `horizon_init_session`, `horizon_list_sessions`, `horizon_session_status`
- Plan/state: `horizon_write_plan`, `horizon_read_plan`, `horizon_write_state`, `horizon_read_state`
- Progress: `horizon_update_feature`, `horizon_update_milestone`, `horizon_record_verification`, `horizon_record_audit`
- Decisions: `horizon_append_decision`, `horizon_read_decisions`
- Research: `horizon_write_research`, `horizon_read_research`
- Skills/traces: `horizon_create_skill`, `horizon_list_skills`, `horizon_save_trace`
- Supervision/config: `horizon_evaluate_subagent`, `horizon_config`

No agent file hardcodes a model, so Horizon and both subagents inherit a model that the user's OpenCode installation can actually run. Users who know that a compatible weaker or cheaper model exists may optionally override either child in `opencode.json`; this is never a portable default:

```json
{
  "agent": {
    "horizon-worker": { "model": "your-provider/compatible-model" },
    "horizon-auditor": { "model": "your-provider/compatible-model" }
  }
}
```

Do not copy an example model identifier blindly: tool support, permissions, context limits, and provider availability must be compatible with the child role.

## CLI and ESM API

The `parallax` binary provides CI and trace automation:

```bash
parallax gate --min-score 70
parallax pre-commit
parallax trace list
parallax trace report --week
parallax doctor --json
```

Documented ESM entrypoints:

```js
import plugin, { plugin as namedPlugin } from "parallax-opencode"
import { runVerification, verifyAndRecord } from "parallax-opencode/verification"
```

The default and named plugin exports are the same function. These imports are tested from an installed npm tarball, not from the source tree.

## Reproduce the release proof

From a clean checkout:

```bash
npm ci --ignore-scripts
npm run typecheck
npm test -- --coverage
npm run build:all
npm run test:pack
npm run test:opencode
npm run audit:release
```

`test:pack` creates the tarball in a temporary directory, rejects development/runtime files, installs it into a temporary prefix, imports the public ESM API, runs the installed CLI, and exercises the installed lifecycle receipt. `test:opencode` packs and installs the same release surface into an isolated config/home, launches the locked OpenCode 1.18.x binary without credentials or user plugins, and verifies tool discovery. Temporary tarballs and test homes are deleted on completion.

`npm run release:check` runs this fail-closed release gate. Tag publication uses the same gate in [`.github/workflows/publish.yml`](.github/workflows/publish.yml).

## Repository map

```text
agents/                  installed OpenCode agent definitions
skills/                  installed progressive mode guidance
src/plugin.ts            OpenCode hooks and tool surface
src/verification.ts      changed-file queue and durable receipt ledger
src/config.ts            validated project configuration
src/detect.ts            deterministic project-check discovery/execution
src/horizon.ts           durable Horizon persistence
src/hyperplan.ts         optional adversarial plan hardening
src/trace.ts             session trace recording/export
src/score.ts             evidence-calibrated coherence scoring
src/cli.ts               CI, lifecycle, and trace CLI
src/tests/               product, runtime, lifecycle, and regression tests
scripts/install.mjs      side-effect-free explicit installer lifecycle
scripts/pack-smoke.mjs   packed artifact contract
scripts/opencode-e2e.mjs real OpenCode packed-plugin integration
scripts/publish.mjs      local release preflight and publication
```

Generated `dist/`, `dist-standalone/`, `coverage/`, package tarballs, dependencies, caches, and runtime state stay out of version control.

## Troubleshooting

**Plugin or tools do not appear**

1. Run `npx parallax-opencode@latest doctor --json`.
2. Confirm `opencode --version` is in the supported 1.18.x line.
3. Restart OpenCode after install/update.
4. If OpenCode retained an old package cache, remove only its cached `parallax-opencode` package and restart.

**A project check is skipped**

Declare one supported package script (`verify`, `test`, `typecheck`, `check`, `lint`, or `build`) or run the appropriate targeted check yourself. A skipped receipt intentionally remains non-passing evidence.

**State appears stale after resuming**

Inspect `parallax_health` and `parallax_trace_view`. Horizon resumes by reading durable intent and then re-reading the current workspace; persisted intent never overrides current repository evidence.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) for the verified development loop. MIT © [Master0fFate](https://github.com/Master0fFate).
