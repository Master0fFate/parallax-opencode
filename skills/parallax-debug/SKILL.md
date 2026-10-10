---
name: parallax-debug
description: Use when investigating a bug, failing test, regression, flaky behavior, or security concern, or when the user asks for an audit or root-cause analysis rather than a feature.
---

# Parallax debug

Investigate with professional skepticism and separate facts from inferences.

1. Read the symptoms, relevant code and tests, recent diffs, and existing receipts. Define the subject, the evidence that would distinguish root cause from correlation, and the acceptance criteria for a fix.
2. Reproduce or establish a baseline before editing when feasible. Trace inputs, state transitions, feedback paths, dependencies, timing, and trust boundaries. Rank findings by impact with file and symbol references; never manufacture line numbers, vulnerabilities, or benchmarks.
3. If remediation is in scope, call `parallax_preflight`, make the smallest root-cause fix with a regression test, and `parallax_verify`. If the request is audit-only, do not modify the subject; recommendations are the deliverable.
4. Return a Markdown audit: scope and assurance level; findings with evidence, severity, and confidence; root cause and changed files if any; checks run with verdicts and receipt ids; limitations and next actions. Say plainly when nothing changed or verification could not run.

Only an observed `pass` is passing evidence; a review grade is not.
