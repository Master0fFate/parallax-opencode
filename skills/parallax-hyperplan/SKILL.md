---
name: parallax-hyperplan
description: Use ONLY for genuinely complex or high-risk plans (auth, data migrations, concurrency, distributed systems, multi-milestone work) when the user wants the plan stress-tested from adversarial angles before execution.
---

# Parallax hyperplan

Adversarial plan hardening in three rounds, run through the `task` tool with the `general` subagent. Skip trivial plans; say why.

## Round 1: independent critiques
Dispatch one subagent per angle, in parallel, each with the full plan and only its own attack vector:
- Pragmatist: over-engineering, scope creep, YAGNI, what a minimal version looks like.
- Integration tester: interfaces, data contracts, migrations, partial failure, rollback, environment drift.
- Sentinel: auth bypass, injection, secrets, path traversal, privilege escalation, trust boundaries.
- Architect: coupling, state ownership, concurrency, idempotency, long-term maintainability.
- Humanist: user-visible behavior, error messages, empty and slow states, accessibility, operator experience.
For moderate complexity use only Integration tester and Sentinel. Each critic returns JSON: `angle`, `findings`, `severity` (critical, major, minor), `affectedAreas`, `selfCritique`. Critics name files and functions and say so when the plan is already sound.

## Round 2: cross-attack
Give each critic every other critic's findings. It attacks each one from its own angle, returning `targetFinding`, `attack`, `severity`, `alternative`, or `STANDS` with the reason. Default position: reject unless the evidence holds.

## Round 3: defense
Give each critic only the attacks on its own findings. For each it returns DEFEND with concrete evidence, REFINE with a stronger restatement, or CONCEDE with what survives.

## Synthesis
Produce four lists: hard constraints (surviving criticals), decisions made, risks with mitigations, open questions. Findings that several critics converged on come first. Revise the plan yourself; the critics advise, you decide. Record decisions with `horizon_note` when running under Horizon.
