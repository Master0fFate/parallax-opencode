# Contributing to Parallax Engine

Thanks for your interest in contributing! Parallax is an OpenCode plugin that makes AI reasoning visible, measurable, and replayable.

## Quick Start

```bash
git clone https://github.com/Master0fFate/parallax-opencode.git
cd parallax-opencode
npm install --ignore-scripts
npm test
```

## Development Workflow

1. **Write tests first** -- We use vitest. Tests go in `src/tests/`.
2. **TypeScript only** -- All source is in `src/`. No raw JS files.
3. **Typecheck before commit** -- `npm run typecheck` must pass.
4. **All tests pass** -- `npm test` must pass (30+ tests).
5. **Build works** -- `npm run build` produces clean dist output.

### Running Checks

```bash
npm run typecheck     # TypeScript validation
npm test              # Run all tests
npm run build         # Compile to dist/
npm run build:all     # Build + standalone copy
```

## Code Structure

```
src/
  plugin.ts     -- Main plugin entry (all 7 tools + hooks)
  types.ts      -- Shared type definitions
  detect.ts     -- Project type detection
  trace.ts      -- Trace recording & file I/O
  score.ts      -- Coherence score computation
  cli.ts        -- CLI entry point
  tests/        -- Vitest test files
```

## Pull Request Guidelines

- One feature/fix per PR
- Include tests for new functionality
- Update CHANGELOG.md with your change
- Keep the coherence score logic consistent
- No regressions in existing tests

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
