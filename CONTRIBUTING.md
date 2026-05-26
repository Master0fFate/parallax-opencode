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
3. **All tests pass** -- `npm test` must pass (30+ tests across 5 files).
4. **Build works** -- `npm run build:all` produces both `dist/` and `dist-standalone/`.
5. **Install locally** -- Copy `dist-standalone/parallax-engine.js` to `~/.config/opencode/plugins/` then reload OpenCode.

### Running Checks

```bash
npm run typecheck           # TypeScript validation (tsc --noEmit)
npm test                    # Run all vitest tests
npm run build               # Compile to dist/
npm run build:standalone    # Bundle plugin via esbuild
npm run build:all           # Build + standalone (run before publish)
```

## Code Structure

```
src/
  plugin.ts     -- Main plugin entry (9 custom tools + 8 hooks, ~1000 lines)
  types.ts      -- Shared type definitions (ProtocolState, ParallaxConfig, etc.)
  detect.ts     -- Project type detection (Node, Python, Go, etc.)
  trace.ts      -- Trace recording, session management, file I/O
  score.ts      -- Coherence score computation + analytics
  cli.ts        -- CLI entry point (CI-only: gate, pre-commit, trace commands)
  tests/        -- Vitest test files (5 files, 30+ tests)
```

## Plugin Architecture Notes

### Cross-Context Execution

OpenCode loads plugin modules in separate execution contexts for custom tools vs hooks. In-memory Maps (`Map<string, T>`) are NOT shared across these contexts.

**The fix:** Protocol state is persisted to `~/.parallax/state.json` on every checkin. Hooks read from disk, not memory. See `readProtocolFromDisk()` in `plugin.ts`.

### State File Location

Plugin process cwd is the user home directory (`~`), not the project root. All runtime state lives at `~/.parallax/`. The project `.parallax/` is CLI-only and gitignored.

## Pull Request Guidelines

- One feature/fix per PR
- Include tests for new functionality
- Update README.md if user-facing behavior changes
- No regressions in existing tests (30 must pass)
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
