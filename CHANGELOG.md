# Changelog

All notable changes to the Parallax Engine will be documented in this file.

## [0.6.8] - 2026-06-05

### Fixed
- CI: added `@vitest/coverage-v8` to devDependencies (required by `vitest --coverage`)

## [0.6.7] - 2026-06-05

### Changed
- CI matrix: added Windows and macOS to test pipeline (3 OS x 2 Node versions = 6 jobs)
- `fail-fast: false` so platform failures don't cancel other jobs
- `package.json` `files`: excluded `scripts/publish.mjs` from npm package (release tool only)

### Added
- `.gitignore`: ignore `data/*.png`, `data/*.jpg`, `data/*.jpeg` (screenshot assets)

## [0.6.6] - 2026-05-30

### Changed
- Merged `skills/parallax/SKILL.md` into `agents/parallax.md` (one source of truth)
- Merged `skills/horizon/SKILL.md` into `agents/horizon.md` (one source of truth)
- Removed `skills/parallax/` and `skills/horizon/` directories (500+ lines of redundancy eliminated)
- Updated `MODE_META` to not inject base skills (horizon mode: skill null)
- Agent prompts now self-contained (no duplicate skill injection)

### Added
- Lazy loading pattern for session-scoped skills in Horizon (check before dispatch, create if needed)
- `parallax_health` diagnostic tool (state inspection, cross-context sync verification)

## [0.6.5] - 2026-05-30

### Changed
- Parallax agent prompt: 112 -> 92 lines (18% shorter)
- Horizon agent prompt: 306 -> 95 lines (69% shorter)

### Added
- Parallax: concrete BAD/GOOD examples for 4 Invariants (Step 2)
- Parallax: EVIDENCE requirement for Verification Gate (Step 3)
- Horizon: honest scoring guidance column in evaluation matrix
- Horizon: HONEST SCORING RULE ("give yourself the score you'd give a junior dev")
- Horizon: concrete examples in Protocol Level Decision Matrix

## [0.6.4] - 2026-05-30

### Fixed
- Cross-context state desynchronization (system prompt always showed PENDING)
- `flushState()` overwrote in-memory changes with stale disk data
- `writeState()` debounced re-read disk instead of using in-memory state
- `tool.execute.before` didn't sync in-memory store from disk
- `experimental.chat.system.transform` didn't read from disk (stale state)
- `experimental.session.compacting` didn't read from disk
- `shell.env` didn't read from disk
- `tool.execute.after` didn't read from disk
- Case-sensitive agent name check in Horizon write exemption
- Path separator mismatch in Horizon write exemption (cross-platform)

### Added
- `syncStateFromDisk()` helper: reads state.json, updates all 3 in-memory stores (protocol, mode, friction)
- `normalizeAgentName()` and `isAgent()` helpers for case-insensitive agent name handling
- `parallax_health` diagnostic tool
- `hook-enforcement.test.ts`: 11 integration tests for actual hook behavior
- Tests: 99 -> 110 (11 new integration tests)

### Changed
- Agent names normalized at assignment point (event hooks) and comparison point (isAgent)
- All hooks now call `syncStateFromDisk()` before reading state

## [0.6.0] - 2026-05-28

### Added
- `parallax_hyperplan` tool: multi-round adversarial plan hardening
- Hyperplan engine (`src/hyperplan.ts`): 3-round debate (analysis, cross-attack, defense) + insight bundle synthesis
- 5 adversarial angles: Pragmatist (major), Integration Tester (critical), Sentinel (critical), Architectural Strategist (major), Humanist (major)
- Complexity gating: auto-skips trivial plans (score < 3), moderate plans get 2 critical angles, complex plans get all 5
- Cross-attack round (Round 2): each critic attacks all other findings, resolves to DEFEND/REFINE/CONCEDE
- Defense round (Round 3): each critic defends/refines/concedes their own attacked findings
- Insight bundle synthesis: hard constraints, decisions, risks, open questions with adversarial provenance tracking
- Confidence scoring: -15 per critical, -8 per major, -3 per minor finding, R3 concede adjustments
- `horizon_evaluate_subagent` tool: score sub-agent output across 6 weighted dimensions
- `parallax_horizon` mode switch tool
- 43 hyperplan tests covering complexity, prompts, cross-attack, defense, synthesis, and edge cases

### Changed
- Plugin tools: 9 -> 11 (added parallax_hyperplan, parallax_horizon)
- Plugin tools: 27 -> 29 total (11 Parallax + 18 Horizon)
- Source layout: added src/hyperplan.ts (engine) + src/tests/hyperplan.test.ts (43 tests)
- Named export pattern: `export const plugin` matching opencode-wakatime (instead of PluginModule object)
- `package.json` exports: added `"./server"` entrypoint for OpenCode resolution
- Install script: removed `ensureNpmPackage()` -- OpenCode auto-installs npm plugins

### Fixed
- All relative imports now include `.js` extensions for ESM resolution
- Bun cache cleaned to resolve v0.6.0 (was fossilized v0.3.15)

## [0.5.0] - 2026-05-28

### Added
- Hyperplan engine (initial): complexity detection, 5 adversarial angles, Round 1 analysis prompt generation
- `parallax_hyperplan` tool (initial): generate mode with analysis, cross-attack, defense rounds
- Insight bundle synthesis: produces 4 categories (hard constraints, decisions, risks, open questions)
- Hyperplan sections in `agents/parallax.md`, `agents/horizon.md`, `skills/parallax/SKILL.md`, `skills/horizon/SKILL.md`

### Changed
- Published as v0.5.0 (first public hyperplan release)

### Fixed
- `package.json` exports field: added `"./server"` entrypoint -- OpenCode couldn't resolve without it
- Plugin export: switched from PluginModule object to named `plugin` function export

## [0.3.16] - 2026-05-27

### Changed
- Install script: removes old plugin file before copying, no more `file:///` duplicates in config
- Config migration: updates existing OpenCode config entries cleanly

## [0.3.15] - 2026-05-27

### Changed
- Install script: writes npm package name `parallax-opencode` instead of local file path
- Plugin shows clean name in OpenCode UI

## [0.3.14] - 2026-05-27

### Added
- Universal MCP research discovery: Horizon agent scans available tool list instead of hardcoding MCP names
- `horizon_evaluate_subagent` evaluation tool

## [0.3.13] - 2026-05-27

### Added
- Horizon agent: autonomous long-horizon supervisor
- 6-dimension evaluation with weighted scoring
- Retry cap enforcement (max 3 cycles per feature)
- Session restart recovery
- 18 Horizon tools (session management, plan management, feature/milestone tracking, decision audit, research cache, session-scoped skills, trace archiving, configuration)

## [0.3.12] - 2026-05-26

### Changed
- Updated CONTRIBUTING.md

## [0.3.11] - 2026-05-26

### Changed
- Cleanup: removed .parallax/, ROADMAP.md
- Rewrote README

## [0.3.10] - 2026-05-26

### Changed
- README refresh

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
