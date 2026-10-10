<p align="center">
  <img src="./data/parallaxtui.png" alt="Parallax" width="220" />
</p>

<h1 align="center">Parallax</h1>

<p align="center"><strong>OpenCode changes you can prove.</strong></p>

[![CI](https://github.com/Master0fFate/parallax-opencode/actions/workflows/ci.yml/badge.svg)](https://github.com/Master0fFate/parallax-opencode/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/parallax-opencode)](https://www.npmjs.com/package/parallax-opencode)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

Parallax is an OpenCode plugin that turns every change into a verified loop: **preflight → change → verify → receipt**. Edits are gated until the agent states what it is doing and how it will know it worked. The project's own check runs on the edited files and leaves a durable receipt. Horizon extends the loop to long-running goals with a persisted plan, one delegated brief at a time, independent audits, and automatic continuation.

Requires Node 20+ and OpenCode 1.18.35+.

```bash
npx parallax-opencode@latest install
opencode
```

Restart OpenCode after the first install, then pick the **parallax** or **horizon** agent. Nothing is copied into your config directory: the installer adds one entry to `opencode.json`, and the agents and skills ship inside the package.

## How it works

| Step | What happens | Enforced by |
|---|---|---|
| Preflight | `parallax_preflight` records ambiguity, acceptance criteria, and invariants | file edits are rejected until it runs |
| Change | the agent edits; every touched file is tracked | `tool.execute.after` hook |
| Verify | `parallax_verify` runs the project check on the pending files and appends a receipt | a receipt is `pass`, `fail`, `skipped`, or `unknown`; only `pass` is evidence |
| Receipt | `parallax_receipt` closes with `full`, `partial`, `hold`, or `override` | refused while edits are unverified; `full` needs a passing receipt |

The check is discovered, never configured: the first declared `verify`, `test`, `typecheck`, `check`, `lint`, or `build` script with the project's package manager; `cargo check`; `go vet ./...`; or `python -m compileall`. It runs without a shell, with a timeout, and with bounded output. The last failing output is injected into the system prompt until a later check passes.

State lives in `.parallax/` (self-ignored by git):

```text
.parallax/
├── config.json        optional
├── receipts.jsonl     every check, append-only
└── sessions/<id>.json preflight, pending files, decision
```

## Configuration

Create `.parallax/config.json` only to change defaults. Unknown fields fail loudly.

```json
{
  "strictness": "strict",
  "trivialPatterns": ["*.md"],
  "highRiskPatterns": ["src/auth/**"],
  "timeoutMs": 120000
}
```

| Key | Default | Meaning |
|---|---|---|
| `strictness` | `strict` | `strict`: every non-trivial edit needs a preflight. `standard`: only files matching `highRiskPatterns`. `relaxed`: track only, never block |
| `trivialPatterns` | `[]` | globs that skip the gate (matched against the relative path or basename) |
| `highRiskPatterns` | `[]` | globs that always need a preflight |
| `timeoutMs` | `120000` | check timeout |

Override agent models or permissions in `opencode.json` as with any agent; your values win:

```json
{ "agent": { "horizon-worker": { "model": "provider/model" } } }
```

## Skills

Loaded on demand with OpenCode's `skill` tool, so they cost nothing until needed: `parallax-plan` (scoped, verifiable plans), `parallax-debug` (evidence-led investigation), `parallax-hyperplan` (adversarial plan critique through parallel subagents).

## Horizon

Horizon is a supervisor for goals that outlive one turn. It never edits code itself.

1. `horizon_plan init` and `horizon_plan write` persist a plan of milestones and atomic features under `~/.parallax/horizon/<plan>/`.
2. For each feature Horizon dispatches one `horizon-worker` with `task`. The worker runs the Parallax loop and reports its receipt id.
3. `horizon_feature receipt` binds that receipt. The verdict is read from the ledger; the receipt must come from a `horizon-worker` session and from a fresh one per attempt.
4. Horizon dispatches one read-only `horizon-auditor`, which records its own verdict with `horizon_feature audit`. A `pass` receipt plus `accept` completes the feature; `corrective` reopens it with a rotating recovery directive (correct, replan, research, decompose).
5. With `full` autonomy the plugin re-prompts the Horizon session on `session.idle` while runnable work remains. User cancellation or a rejected permission pauses the plan, and so do six continuations without feature progress; the next real message or granted permission resumes it. `horizon_feature block` records typed blockers (credentials, external service, platform, framework, structural) with evidence.

The plugin enforces the shape: Horizon cannot edit, can only delegate to the two packaged roles, and runs one delegated task at a time; the worker cannot delegate or touch plans; the auditor cannot edit, run commands, or delegate. OpenCode permission prompts stay authoritative throughout.

## Tools

`parallax_preflight`, `parallax_verify`, `parallax_receipt`, `parallax_trace`, `horizon_plan`, `horizon_feature`, `horizon_note`.

## CLI

```bash
npx parallax-opencode install | uninstall | status | doctor | receipts [--json] [--config-dir <path>]
```

`receipts` summarizes `.parallax/receipts.jsonl` for the current project, useful in CI. `install` also removes files copied by versions before 1.0.

## Development

```bash
npm ci --ignore-scripts
npm run check   # typecheck, tests, build, packed-artifact smoke, real OpenCode E2E
```

The E2E packs the module, installs it into a temporary prefix, launches the locked OpenCode binary with an isolated home and no credentials, and asserts the agents, permissions, tools, and skills it discovers.

MIT © [Master0fFate](https://github.com/Master0fFate)
