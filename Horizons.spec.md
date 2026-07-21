# HORIZON AGENT — Current Product Specification

**Status:** Implemented and covered by the next release verification gate
**Surface:** OpenCode primary agent plus plugin-provided persistence and orchestration tools
**Proof:** Prompt-contract tests, packed npm import/install smoke, and isolated real OpenCode 1.18.x tool discovery

## 1. Positioning

Horizon is durable, self-iterative supervision for long-running engineering work. It persists plans, state, research, decisions, session skills, evaluations, recovery directives, blockers, and archived traces so later OpenCode processes can inspect and resume work.

Horizon is not a background daemon or scheduler. While OpenCode is running, full autonomy is liveness-driven: the plugin listens for `session.idle` and queues a synthetic continuation whenever runnable work remains. Platform availability, explicit user cancellation, and OpenCode permissions remain authoritative.

## 2. Unified Verified Change Loop

Horizon and Parallax share one contract for every implementation feature and final integration.

### PREFLIGHT

- Read repository instructions, relevant implementation/tests, current workspace state, and resumable Horizon state.
- Turn the goal into measurable acceptance criteria and classify ambiguity LOW, MEDIUM, or HIGH.
- Ask only when an essential decision cannot be derived safely from repository evidence or a missing credential, access grant, or consequential user choice blocks the work. Bundle related questions once. Otherwise log the assumption and proceed; do not ask merely to continue.
- Before project writes, complete `parallax_checkin` for `ambiguity`, `invariants`, and `gate` in order. The gate records readiness, not post-change success.
- Record baseline checks so pre-existing failures are distinguishable from regressions.

OpenCode permission prompts are authoritative. Agent autonomy settings never bypass a permission configured as `ask` or `deny`. Configured `semi` or `supervised` checkpoints may request user approval; `full` removes those product checkpoints, not OpenCode permission checks.

### CHANGE

- Decompose work into milestones and atomic features with acceptance criteria.
- For every implementation feature, dispatch exactly one packaged `horizon-worker` with one atomic brief and wait for completion.
- Observe and persist the worker's schema-v2 receipt ID and exact verdict, then dispatch exactly one packaged read-only `horizon-auditor` and wait for completion.
- Accept only when the observed verdict is `pass` and the auditor accepts; otherwise immediately dispatch a fresh corrective worker without an attempt cap.
- At most one delegated task is active. Overlap, parallel dispatch, generic roles, and worker self-audit are forbidden.
- Keep changes scoped and preserve unrelated behavior.
- Keep implementation and audit detail in child sessions and durable traces; return only structured supervisor summaries bounded to 2,000 characters.
- Persist material decisions and feature status through `horizon_*` tools.
- Use optional session skills and `parallax_hyperplan` only when complexity warrants them.
- Persist every attempt and rotate recovery by `recoveryEscalationInterval`: focused correction, replan from current evidence, framework/source research, then decomposition. The interval changes strategy; it never stops execution.
- In full autonomy, failed checks, timeouts, low scores, missing receipts, and exhausted schema-1.0 budgets remain runnable. They cannot terminally fail a feature.
- Pause only when a trusted OpenCode event records explicit cancellation/denied permission, or through a typed `blocked` feature with concrete evidence of missing credentials, an unavailable external service, or a platform/framework/structural limit.

### VERIFY

- Call `parallax_verify` after each changed-file batch. It runs one detected bounded project check and appends a schema-v2 verification receipt to the workspace ledger.
- Run targeted acceptance tests and configured broader test/lint commands when available and permitted.
- Evaluate delegated work against the actual diff, acceptance criteria, and observed command evidence.
- Persist the receipt ID and `pass`, `fail`, `skipped`, or `unknown` verdict before auditor dispatch.
- Only `pass` is passing evidence. `fail`, `skipped`, and `unknown` remain explicit limitations. Self-reported evaluation scores cannot set verification passed or readiness and do not replace receipts.

### RECEIPT

Each feature and final integration reports or persists:
- changed files and acceptance-criteria status;
- exact commands/checks and observed verdicts;
- verification receipt IDs;
- material decisions and assumptions;
- residual risks, skipped checks, failures, and blockers.

The final Markdown handoff aggregates completed, skipped, and blocked work and identifies resumable session state. Full autonomy does not emit that handoff while ordinary runnable work remains. It does not claim certainty beyond the receipts.

## 3. Agent Definitions and Dispatch Allowlist

The installer packages `agents/horizon.md` (`mode: primary`), `agents/horizon-worker.md` (`mode: subagent`), and `agents/horizon-auditor.md` (`mode: subagent`). The worker can edit one atomic brief and uses `bash: ask`. The auditor has `edit: deny`, `bash: deny`, `todowrite: deny`, and `task: deny`, making its workspace review read-only.

Horizon's `permission.task` is a last-match allowlist in this exact order: `"*": deny`, `"horizon-worker": allow`, `"horizon-auditor": allow`. It cannot dispatch generic or unbundled roles. Both child roles also deny `task`, so they cannot recursively delegate. `bash: ask` means OpenCode can pause for command approval; Horizon must not describe that platform pause as an autonomy failure.

The plugin mode switch is `parallax_horizon`. It changes prompt mode; selecting the Horizon agent tab and using Horizon persistence tools remain explicit agent actions. Once a full-autonomy plan is active, the idle-session hook continues that OpenCode session automatically until the plan completes or records a valid blocker.

## 4. Durable State

```text
~/.parallax/horizon/
├── config.json
├── index.json
└── sessions/<session-id>/
    ├── plan.json
    ├── state.json
    ├── decisions.jsonl
    ├── research/
    ├── skills/
    └── traces/
```

Project protocol state, traces, and verification receipts remain workspace-local under `.parallax/`. Horizon orchestration writes under its persistence root are exempt from project-write protocol enforcement; source-code edits are not.

On resume, Horizon reads durable plan/state and then re-reads current repository state. Persisted intent may be stale and never overrides the current workspace. Schema-1.0 `failed` features and pauses without typed blocker evidence are treated as resumable work.

## 5. Runtime Tools

### Parallax contract tools

- `parallax_checkin` — records protocol readiness and closing steps.
- `parallax_verify` — detected bounded verification plus durable receipt.
- `parallax_plan`, `parallax_build`, `parallax_debug`, `parallax_horizon` — prompt modes.
- `parallax_analyze`, `parallax_hyperplan` — optional analysis depth.
- trace and health tools — inspect evidence and runtime state.

### Horizon persistence and supervision tools

The plugin exposes session initialization/list/status, plan/state read-write and feature/milestone update, decision read-append, research read-write, session-skill create/list, trace archive, observed receipt and audit persistence, advisory sub-agent evaluation, and configuration tools under the `horizon_*` prefix. `horizon_record_verification` resolves a receipt ID from the workspace ledger rather than accepting a caller-supplied verdict; `horizon_record_audit` requires that receipt evidence first. State writes reject more than one active subagent, and completion requires observed `pass` plus an independent `accept` audit.

These tools persist and score supplied information. They do not dispatch sub-agents or prove correctness. Automatic continuation belongs to the plugin event hook; sub-agent dispatch still uses OpenCode's available `task` tool. Research uses whichever code, documentation, or web tools are actually present; no specific MCP or browser is assumed.

## 6. Configuration Semantics

No shipped agent hardcodes a model. Primary and child roles inherit an available user-configured model by default; this avoids assuming that any cheaper model identifier or tool capability is portable across providers. A user who knows a compatible weaker/cheaper model exists may optionally set `agent.horizon-worker.model` and/or `agent.horizon-auditor.model` in OpenCode configuration. Compatibility, tool support, context limits, and provider access are the user's prerequisite; no override is recommended by default.

- `autonomyLevel`: `full`, `semi`, or `supervised` product checkpoint behavior.
- `autoApproveMilestones`: whether milestone checkpoints are automatic.
- `recoveryEscalationInterval`: number of attempts before switching recovery strategy; it is not an attempt cap.
- Legacy `maxRetryCycles`: accepted on read/write and migrated to `recoveryEscalationInterval` for schema-1.0 compatibility.
- `decisionConfidenceThreshold`: threshold used in decision handling.
- `testCommand`, `lintCommand`: requested broader checks, subject to availability and OpenCode permissions.

Configuration guides agent behavior. The OpenCode event hook provides in-process continuation; it is not an external daemon, command runner, timeout killer, or permission bypass.

## 7. Evaluation

`horizon_evaluate_subagent` records a weighted advisory evaluation across protocol integrity, verification, correctness, design quality, edge-case coverage, and user perspective. The 75% threshold is an advisory rating only. The tool preserves receipt ID, receipt verdict, `passed`, and readiness state; scores are supervision signals, never verification verdicts.

## 8. Safety and Failure Semantics

- Trusted OpenCode events create permission/cancellation blockers; Horizon tools may create only evidence-backed credential, external-service, platform, framework, or structural blockers.
- OpenCode permission requests are always honored.
- Failed checks, unavailable verification, timeout, or interruption are persisted and feed the next adaptive recovery attempt; they do not exhaust execution.
- Repeated unchanged attempts are forbidden; every escalation window changes the recovery strategy.
- Package installation, GitHub push, and npm publication occur only through available tools under their configured permissions and only after release gates pass.
- Durable state and the idle hook support autonomous progress while OpenCode runs; after the process stops, the next invocation resumes from persisted state.
