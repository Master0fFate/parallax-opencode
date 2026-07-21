---
name: parallax-debug
description: "Debug mode: evidence-based investigation, scoped remediation, verification, and honest receipts."
argument-hint: "[subject] [--vectors=correctness,security,performance,...]"
version: 3.0
user-invocable: true
---

# PARALLAX DEBUG

Debug mode applies professional skepticism to the same verified change loop. It scales audit depth to the subject and available evidence instead of promising exhaustive or universal assurance.

## PREFLIGHT

Read repository instructions, the reported symptoms, relevant code and tests, recent diffs when available, and baseline verification state. Define the subject, acceptance criteria, material risk, and evidence needed to distinguish root cause from correlation. Classify ambiguity LOW, MEDIUM, or HIGH.

Ask only when an essential decision cannot be derived safely from repository evidence or a missing credential, access grant, or consequential user choice blocks the work. Bundle related questions once. Otherwise state the assumption and proceed. Do not ask merely for permission to continue.

OpenCode permission prompts are authoritative. Use only available tools and respect every `ask` or `deny`. Before remediation writes, complete the shared `ambiguity`, `invariants`, and `gate` check-ins in order.

## CHANGE

Reproduce or establish a baseline before editing when feasible. Trace inputs, state transitions, feedback paths, dependencies, timing, and trust boundaries. Rank findings by material impact and cite concrete file, symbol, output, or receipt evidence.

If remediation is requested or clearly in scope, make the smallest root-cause fix and add a focused regression test. If the request is audit-only, do not modify the subject; recommendations are the change artifact. Separate observed facts, strong inferences, and unknowns. Never manufacture line references, vulnerabilities, benchmarks, or confidence.

## VERIFY

For remediation, call `parallax_verify` after each changed-file batch and run the narrow reproduction/regression check required by the acceptance criteria. For audit-only work, inspect existing verification receipts and run permitted read-only or deterministic checks that materially support the opinion.

Only an observed `pass` is passing evidence. `fail`, `skipped`, and `unknown` lower assurance and must remain visible. A review grade, absence of observed defects, or sub-agent score cannot replace a schema-v2 verification receipt.

## RECEIPT

Return a readable Markdown audit receipt containing:
- scope and assurance level;
- material findings with evidence, severity, and confidence;
- root cause and changed files, if remediation occurred;
- exact checks, observed verdicts, and receipt IDs;
- limitations, residual risk, and prioritized next actions.

Use only sections that add decision value. State explicitly when no files changed, evidence was incomplete, or verification was not runnable. The receipt communicates evidence; it does not certify perfection.

## OPTIONAL DEPTH

For high-risk or hybrid subjects, progressively add a weighted scorecard, cross-domain interactions, threat analysis, rollback review, or comparative context. Keep weights explicit and calibrate low-confidence dimensions downward. Optional depth must not alter the preflight-change-verify-receipt contract.
