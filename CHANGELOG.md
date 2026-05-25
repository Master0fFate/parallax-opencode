# Changelog

All notable changes to the Parallax Engine will be documented in this file.

## [0.3.0] - 2026-05-25

### Added
- `parallax_trace_pr_comment` tool: AI outputs formatted trace markdown directly in chat
- `parallax_trace_view` tool: inline reasoning trace viewer in chat
- `parallax gate` CLI: CI coherence gate with exit codes (--min-score, --session, --last)
- `parallax pre-commit` CLI: git pre-commit hook wrapper
- `parallax trace report --week` CLI: weekly score analytics
- `parallax trace compare <a> <b>` CLI: side-by-side trace comparison
- `parallax trace compliance <id>` CLI: protocol compliance report
- State persistence: `.parallax/state.json` written on every transition (debounced)
- Post-session retrospective: auto-generated on summary checkin
- Multi-agent protocol sharing: state carries over on agent switch (TAB)
- Shell environment injection: `PARALLAX_MODE`, `PARALLAX_SESSION_ID`, `PARALLAX_FRICTION_RETRIES` in shell
- Config system: `.parallax/config.json` with strictness, minScore, designDocRequired, pattern allowlists
- Design doc enforcement: opt-in via config, `PARALLAX_FORCE=1` override
- 3 new score analytics functions: computeWeeklyReport, detectFailurePatterns, computePerProjectStats
- Protocol extended to 6 steps: ambiguity, invariants, gate, design (optional), commit, summary

### Changed
- Plugin tools: 7 -> 9 (added trace_pr_comment, trace_view)
- CLI commands: 6 -> 11 (added gate, pre-commit, report, compare, compliance)
- Protocol steps: 5 -> 6 (added design doc step)
- ProtocolState: added designDone field
- PhaseName: added design_check
- STEP_LABELS: added design entry

### Removed
- Discord RPC module (`src/discord-rpc.ts`, 352 lines) -- broken, dead code
- `@xhayper/discord-rpc` npm dependency
- `chat.message` and `chat.params` hooks (only served Discord RPC)
- Discord RPC presence update blocks from tool.execute.before, tool.execute.after, and event handlers

### Fixed
- Pre-existing CLI ESM resolution issue (imports need .js extensions for Node.js ESM)

## [0.2.0] - 2026-05-21

### Added
- MIT license (replaced AGPL-3.0)
- Complete TypeScript consolidation with extracted modules:
  - `src/types.ts` -- shared type definitions
  - `src/detect.ts` -- project detection
  - `src/trace.ts` -- trace recording and export
  - `src/score.ts` -- coherence score computation
  - `src/cli.ts` -- CLI entry point
- Trace Protocol: structured JSON trace files in `.parallax/traces/`
- New tool: `parallax_trace_export` (export session trace to file)
- CLI: `parallax init`, `parallax trace list/show/score/export/trend`
- Coherence Score: evidence-based quality metric (0-100)
- Trend tracking: `.parallax/scores.jsonl` with sparkline display
- 30 unit tests across 5 test files (vitest)
- Test infrastructure: vitest config, test scripts
- CI/CD: GitHub Actions workflow

### Changed
- License: AGPL-3.0 -> MIT
- Plugin source: JavaScript -> TypeScript (single source of truth)
- Package entry: `./dist/index.js` -> `./dist/plugin.js`
- Install script: resolves plugin from dist-standalone, dist, or src
- Build system: `tsc` (no longer requires Bun CLI)

### Fixed
- Publish script inverted validation bug (line 31)
- Missing `main-exists` validation in publish checks
- License validation updated to MIT

### Removed
- `src/index.ts` (replaced by `src/plugin.ts`)
- `src/parallax-engine.plugin.js` (replaced by TypeScript source)
- `prompts/parallax-system.txt` (historical reference, redundant with agent)

### Security
- AGPL-3.0 removed -- MIT enables enterprise adoption

## [0.1.0] - 2026-05-01

### Added
- Initial release
- Parallax agent for OpenCode
- 6 custom tools: verify, analyze, checkin, plan, build, debug
- Friction-loop auto-verification
- Mode state machine (free/plan/build/debug)
- Protocol enforcement (step ordering)
- Skill injection system
- Install and publish scripts
