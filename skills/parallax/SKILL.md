---
name: parallax
description: "PARALLAX ENGINE REASONING PROTOCOL: Multi-perspective analysis framework for AI agents. Use when you need rigorous edge case analysis, the 4 invariants framework, friction-loop verification, or structured multi-angle planning. Triggers: 'parallax', 'friction loop', '4 invariants', 'multi-perspective', 'edge case analysis', 'parallax engine', 'view from every angle', 'parallax protocol'."
license: MIT
compatibility: opencode
---

# PARALLAX ENGINE REASONING PROTOCOL

View every problem from every angle before acting.

## THE 4 INVARIANTS

Apply these four questions to EVERY change:

| Question | Maps To | Why It Matters |
|----------|---------|---------------|
| Where does state live? | Ownership & truth | Consistency, blast radius |
| Where does feedback live? | Observability | Debugging, monitoring |
| What breaks if I delete this? | Coupling & fragility | Safe refactoring |
| When does timing work? | Async & ordering | Race conditions, correctness |

## FRICTION LOOP PROTOCOL

After every write/edit operation, auto-verify:

1. Detect project type (Cargo.toml, package.json, pyproject.toml)
2. Run appropriate check (cargo check, tsc, lint, compileall)
3. On FAILURE: fix and retry (3 retries max, reset on success)
4. On EXHAUSTION: stop and report -- do not continue

## PARALLAX PLANNING PROTOCOL

PHASE 1 -- RECONNAISSANCE: Explore before planning. Read structure, configs, existing patterns.

PHASE 2 -- PARALLAX ANALYSIS per component:
- Nominal case (happy path)
- Edge cases: empty, boundary, error, concurrency, state transitions, security, backward compat
- Cross-cutting: error handling, observability, performance, testability, rollback

PHASE 3 -- PLAN SYNTHESIS: Atomic items with verification steps, in execution order.

PHASE 4 -- EXECUTE: Implement item by item, verify each change.

PHASE 5 -- ADAPT: Add/reorder as requirements change.

PHASE 6 -- SUMMARIZE: What was built, edge cases handled, verification passed, remaining concerns.

## AMBIGUITY DETECTION

Classify every request:
- HIGH ambiguity (vague): Full question sequence. Ask calibrated questions before proceeding.
- MEDIUM ambiguity: Ask targeted questions on gaps. If you assume structure not stated, it is MEDIUM.
- LOW ambiguity (clear): Verify quickly and proceed. For trivial changes, trust user intent.

Always confirm ambiguities before executing. Propose a concrete baseline -- never hand back a blank questionnaire.

## VERIFICATION GATE (Before Ship)

Before committing any change, verify:
- [ ] State ownership and consistency clear?
- [ ] Feedback / observability in place?
- [ ] Blast radius understood?
- [ ] Timing & ordering safe?
- [ ] Follows existing patterns (or intentionally breaks them)?
- [ ] Security / obvious risks addressed?
- [ ] Friction loop passed (if applicable)?

## RED LINES (Stop and Flag)

- Unclear state ownership
- Unknown blast radius
- Timing / race condition hazards
- Security issues
- Creating significant complexity debt
- Unknown unknowns on non-trivial changes
