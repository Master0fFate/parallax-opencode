# Contributing to Parallax Engine

Parallax is an OpenCode plugin for verified, evidence-bearing changes. Keep contributions scoped, test observable behavior, and leave the repository release-ready.

## Start here

```bash
git clone https://github.com/Master0fFate/parallax-opencode.git
cd parallax-opencode
npm ci --ignore-scripts
npm run typecheck
npm test
```

Node.js 20+ is required. The real integration test uses the repository's locked OpenCode 1.18.x development dependency and does not use your OpenCode config or credentials.

## Change loop

1. Read the relevant source, nearby tests, and current workspace diff.
2. Define measurable acceptance criteria and preserve unrelated behavior.
3. Make the smallest coherent change; avoid churn-only moves.
4. Add or update targeted tests.
5. Run the narrow check first, then the complete release gate before a release-ready handoff.
6. Report changed files, exact commands and verdicts, and remaining risk.

TypeScript implementation lives in `src/`; release/lifecycle automation lives in `scripts/`; installed prompts live in `agents/` and `skills/`. Update user documentation when behavior or defaults change.

## Checks

```bash
npm run typecheck             # TypeScript validation
npm test                      # Vitest suite
npm test -- --coverage        # Full suite with coverage
npm run build:all             # ESM declarations + standalone bundle
npm run test:pack             # Pack, install, and import the npm artifact
npm run test:opencode         # Discover tools in isolated real OpenCode
npm run audit:release         # High-severity production dependency audit
npm run release:check         # Complete fail-closed release gate
```

The packed-artifact and OpenCode checks use temporary directories and clean them up. They must not depend on global package links, user configuration, user credentials, generated files left in the repository, or network model access.

## Repository boundaries

```text
agents/                  installed OpenCode agent definitions
skills/                  installed mode guidance
src/plugin.ts            hooks and plugin tool surface
src/verification.ts      verification receipts and changed-file batching
src/config.ts            project configuration validation/defaults
src/detect.ts            deterministic bounded check discovery
src/horizon.ts           Horizon persistence
src/hyperplan.ts         optional adversarial planning engine
src/trace.ts             trace recording/export
src/score.ts             coherence score calculation
src/cli.ts               automation and trace CLI
src/tests/               behavioral and contract tests
scripts/install.mjs      explicit managed installer lifecycle
scripts/pack-smoke.mjs   package-content/public-import proof
scripts/opencode-e2e.mjs real OpenCode integration proof
scripts/publish.mjs      local release workflow
```

OpenCode can load custom tools and hooks in separate execution contexts. Do not assume module-level maps are shared. Session identity and workspace-local state under `.parallax/sessions/<session-id>/` are the cross-context source of truth. Horizon orchestration state is separate under `~/.parallax/horizon/`.

Do not commit or stage `.parallax/`, dependencies, build output, coverage, caches, logs, credentials, or package tarballs. Before handoff, inspect both `git status --short` and the staged file list.

## Pull requests

- Keep one coherent feature or fix per pull request.
- Include regression coverage for behavior changes.
- Preserve explicit failure semantics: only a `pass` verification receipt is passing evidence.
- Keep OpenCode permissions authoritative; agent autonomy must not bypass `ask` or `deny`.
- Avoid exact tool/test/line counts in docs because they become stale; document contracts and commands instead.
- Update `README.md`, `CHANGELOG.md`, package metadata, workflow gates, or `Horizons.spec.md` when their story changes.

## Releases

Do not publish from an unverified tree or bypass lifecycle scripts without first running the same release gate in that environment.

```bash
npm run release:dry           # Full gate plus npm publish --dry-run
npm run release:patch         # Bump package/lock, verify, authorize, publish
```

A release requires synchronized package and lockfile versions, passing typecheck and coverage, both builds, packed import/install proof, real OpenCode integration, and audit. The local publisher checks npm identity and package ownership before publication and verifies registry metadata afterward. Tagged releases run the same gate through [`.github/workflows/publish.yml`](.github/workflows/publish.yml).

If authentication, ownership, two-factor authentication, provenance, or registry access blocks publishing, report the exact npm error and do not claim publication.

## License

By contributing, you agree that your contributions are licensed under the MIT License.
