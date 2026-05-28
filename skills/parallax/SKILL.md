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

## HYPERPLAN: ADVERSARIAL PLAN HARDENING (Optional)

Before executing a complex plan, you may harden it using the Hyperplan adversarial debate system.

### When to Use

- **Complex plans** (multi-file, cross-module, high-risk) -- ALWAYS hyperplan
- **Moderate plans** (new feature with known patterns) -- RECOMMENDED
- **Trivial plans** (typo fix, single-file config change) -- SKIP (auto-detected)

### The 3-Round Debate

**Round 1 -- Independent Analysis (parallel)**
Dispatch 5 adversarial critics simultaneously via task():
- Pragmatist (major): Is this practical? Does it ship? Scope vs value?
- Integration Tester (critical): Does this integrate cleanly? What breaks?
- Sentinel (critical): What is the worst case? Security, failure, edge cases?
- Architectural Strategist (major): Does this fit the architecture? Coupling?
- Humanist (major): Can a human understand and maintain this?

Each critic outputs JSON with findings, severity (critical/major/minor), affected areas, and selfCritique acknowledging their own blind spots.

**Round 2 -- Cross-Attack**
Each critic receives ALL other critics' findings and attacks every point:
- Must output DEFEND (stands), REFINE (revise), or CONCEDE (admit wrong) per point
- Default position: REJECT -- only concede when evidence forces it
- Each attack includes an alternative suggestion

**Round 3 -- Defense & Refinement**
Each critic receives ONLY attacks against their own findings:
- DEFEND: Concrete evidence required (no "I believe")
- REFINE: Produce a stronger version incorporating valid criticism
- CONCEDE: State what (if anything) survives

### Insight Bundle Synthesis

After all 3 rounds, synthesize an insight bundle with 4 categories:

1. **Hard Constraints** -- Non-negotiable findings (must-fix)
2. **Decisions Made** -- Trade-offs explicitly accepted
3. **Risks & Mitigations** -- Identified risks with mitigation strategies
4. **Open Questions** -- Items needing more information

Also tracks:
- **Adversarial Provenance**: How many findings survived from each angle
- **Confidence Score**: Derived from unresolved critical/major/minor findings, adjusted for conceded items in Round 3

### Usage via Plugin

Call `parallax_hyperplan` tool with the plugin:
- `mode: "generate"` with `round: "analysis"` -- Independent analysis prompts
- `mode: "generate"` with `round: "cross-attack"` -- Cross-attack prompts
- `mode: "generate"` with `round: "defense"` -- Defense prompts
- `mode: "synthesize"` -- Produce insight bundle

The tool generates structured prompts. You dispatch sub-agents in parallel via task() using those prompts.

## RED LINES (Stop and Flag)

- Unclear state ownership
- Unknown blast radius
- Timing / race condition hazards
- Security issues
- Creating significant complexity debt
- Unknown unknowns on non-trivial changes
