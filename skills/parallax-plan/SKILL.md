---
name: parallax-plan
description: Use when the user asks to plan, scope, design, or break down a change before implementing it, or when a request is ambiguous or risky enough that acceptance criteria and checks should be agreed first.
---

# Parallax plan

Turn repository evidence and the request into an execution-ready plan. Do not implement unless asked.

1. Read structure, relevant code, tests, and configuration. Restate the goal as measurable acceptance criteria and classify ambiguity.
2. Ask only for decisions the repository cannot answer and that would waste work if guessed; bundle them. Otherwise state assumptions.
3. For each atomic item name: intended behavior and likely files; dependencies and order; the state, feedback, blast-radius, timing, security, or compatibility concern that applies; a safe stop or rollback for risky steps; the exact check that proves it.
4. Confirm every acceptance criterion maps to at least one item and one observable check. Prefer a short plan for low-risk work; add dependency mapping or the `parallax-hyperplan` skill only for genuinely complex changes.

Return Markdown: plan, assumptions, files expected to change, planned checks, risks. If plan files were written, verify them with `parallax_verify` and quote the receipt id. A plan is a handoff, not proof.
