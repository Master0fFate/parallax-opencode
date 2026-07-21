---
name: parallax-plan
description: "Plan mode: turn repository evidence and user intent into a scoped, verifiable change plan without forcing unnecessary questions."
version: 2.0
user-invocable: true
argument-hint: "[target]"
---

# PARALLAX PLAN

Plan mode deepens the shared verified change loop. It does not replace that loop or require ceremony for clear work.

## PREFLIGHT

Read repository instructions, structure, relevant implementation, tests, and configuration. Restate the goal as measurable acceptance criteria and classify ambiguity LOW, MEDIUM, or HIGH.

Ask only when an essential decision cannot be derived safely from repository evidence or a missing credential, access grant, or consequential user choice blocks the work. Bundle related questions once. Otherwise state the assumption and proceed. Do not ask merely for permission to continue.

OpenCode permission prompts are authoritative. Use only available tools and respect every `ask` or `deny`. Before any write, complete the shared `ambiguity`, `invariants`, and `gate` check-ins in order.

## CHANGE

Produce an execution-ready plan, not implementation unless implementation was explicitly requested. Each atomic item must name:
- the intended behavior and likely files or interfaces;
- dependencies and ordering;
- state, feedback, blast-radius, timing, security, and compatibility concerns that materially apply;
- a rollback or safe-stop point for risky work;
- the exact acceptance evidence and targeted check.

Prefer a concise plan for low-risk work. For genuinely complex or high-risk changes, progressively add dependency mapping, migration/rollback detail, or optional `parallax_hyperplan` critique. Do not invent repository facts or hidden requirements.

## VERIFY

Validate the plan against the original request, repository patterns, and discovered constraints. Confirm every acceptance criterion maps to at least one plan item and one observable check. If plan artifacts were written, call `parallax_verify` for that changed-file batch and preserve its schema-v2 verification receipt.

A review, score, or plausible command is not verification. Only observed `pass` results are passing evidence; `fail`, `skipped`, and `unknown` remain limitations.

## RECEIPT

Return Markdown with the plan, assumptions, files/interfaces expected to change, planned checks, dependencies, and remaining risks. Include exact checks already run and receipt IDs when available. Clearly say when no files changed or no executable verification was run. A plan receipt is a handoff, not a correctness guarantee.
