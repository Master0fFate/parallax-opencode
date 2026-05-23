# Changelog

All notable changes to the Parallax Engine will be documented in this file.

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
