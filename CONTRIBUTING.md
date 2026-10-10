# Contributing

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run check   # adds build, packed-artifact smoke, and the real OpenCode E2E
```

Node 20+ is required. The E2E uses the locked `opencode-ai` dev dependency and never reads your OpenCode config or credentials.

## Layout

```text
agents/            prompts for parallax, horizon, horizon-worker, horizon-auditor
skills/            on-demand skills discovered through config.skills.paths
src/plugin.ts      hooks and the seven tools
src/verify.ts      check discovery, bounded execution, receipt ledger
src/horizon.ts     plan persistence and the worker → receipt → audit state machine
src/config.ts      project config and the edit gate
src/session.ts     per-session state under .parallax/sessions
src/agents.ts      agent definitions injected through the plugin config hook
src/tests/         node:test suites, compiled by tsc
scripts/           installer, pack smoke, OpenCode E2E, publisher
```

## Rules

- No comments in code. Names and tests carry the meaning.
- Disk is the source of truth for session and plan state; hooks and tools never share in-memory state across sessions.
- Only a `pass` receipt is passing evidence. Never let a score, a summary, or a retry stand in for one.
- OpenCode permissions are authoritative. Agent prompts and plugin logic must not route around `ask` or `deny`.
- Every behavior change comes with a test. Prompt changes keep the agent contract tests green.
- Keep the tool surface at seven unless a new tool removes more than it adds.

## Releases

```bash
npm run release:dry
node scripts/publish.mjs --patch
```

Tagged pushes run the same gate in `.github/workflows/publish.yml` and publish with provenance.
