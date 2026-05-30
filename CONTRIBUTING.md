# Contributing to Parallax Engine

OpenCode plugin -- friction-loop verification, protocol enforcement, mode switching (plan/build/debug), and structured reasoning traces.

## Quick Start

```bash
git clone https://github.com/Master0fFate/parallax-opencode.git
cd parallax-opencode
npm install --ignore-scripts
npm test
```

## Development Workflow

1. **TypeScript only** -- All source in `src/`. No raw JS files.
2. **Typecheck before commit** -- `npm run typecheck` must pass.
3. **All tests pass** -- `npm test` must pass (110+ tests across 8 files).
4. **Build works** -- `npm run build:all` produces both `dist/` and `dist-standalone/`.
5. **Install locally** -- Run `node scripts/install.mjs` or copy `dist-standalone/parallax-engine.js` to `~/.config/opencode/plugins/` then reload OpenCode.

### Running Checks

```bash
npm run typecheck           # TypeScript validation (tsc --noEmit)
npm test                    # Run all vitest tests (110+)
npm run build               # Compile to dist/
npm run build:standalone    # Bundle plugin via esbuild
npm run build:all           # Build + standalone (run before publish)
```

## Code Structure

```
src/
  plugin.ts     -- Main plugin (29 tools + 8 hooks + state management, ~2300 lines)
  types.ts      -- Shared type definitions
  detect.ts     -- Project type detection
  trace.ts      -- Trace recording, session management
  score.ts      -- Coherence score computation
  horizon.ts    -- Horizon persistence layer (517 lines)
  hyperplan.ts  -- Hyperplan adversarial debate engine
  cli.ts        -- CLI entry point (CI-only)
  tests/        -- Vitest test files (8 files, 110+ tests)
agents/
  parallax.md   -- Parallax agent definition (self-contained)
  horizon.md    -- Horizon agent definition (self-contained)
skills/
  parallax-plan/   -- PLAN mode skill (Precision Architect)
  parallax-debug/  -- DEBUG mode skill (Universal Auditor)
```

## Plugin Architecture Notes

### Cross-Context Execution

OpenCode loads plugin modules in separate execution contexts for custom tools vs hooks. In-memory Maps (`Map<string, T>`) are NOT shared across contexts.

**The fix:** `syncStateFromDisk()` reads `~/.parallax/state.json` and updates ALL in-memory stores (protocol, mode, friction). Called in every hook before reading state.

### Agent Definitions vs Skills

- `agents/*.md` -- Self-contained agent definitions. Always loaded when agent tab is active.
- `skills/parallax-*.md` -- Mode-specific skills. Injected only when mode is activated via `parallax_plan` or `parallax_debug`.
- Base skills (parallax, horizon) are merged into agent definitions. Only mode-specific skills remain as separate files.

### State File Location

Plugin process cwd is the user home directory (`~`), not the project root. All runtime state lives at `~/.parallax/`. The project `.parallax/` is CLI-only and gitignored.

## Pull Request Guidelines

- One feature/fix per PR
- Include tests for new functionality
- Update README.md if user-facing behavior changes
- No regressions in existing tests (110+ must pass)
- Keep the coherence score logic consistent

## Publishing

```bash
npm version patch
npm run build:all
npm test
git push && git push --tags
npm publish
```

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
