# HORIZON AGENT -- System Specification

**Version:** 1.0  
**Status:** Design Phase  
**Plugin:** parallax-engine (OpenCode plugin)  
**Copyright:** 2026 Master0fFate  

---

## 1. IDENTITY

| Property | Value |
|---|---|
| **Name** | Horizon |
| **Tab** | Separate agent tab alongside Plan/Build and Parallax |
| **Color** | `#00bcd4` (cyan/teal -- distinct from Parallax `#6c63ff`) |
| **Mode** | `primary` |
| **Persona** | Long-horizon autonomous supervisor. Self-iterates, self-tests, self-completes. |
| **Surface** | OpenCode plugin only. No CLI. No standalone. |

### Agent Definition (agents/horizon.md frontmatter)

```yaml
name: Horizon
description: "HORIZON: Long-horizon autonomous supervisor. Plans, researches, executes, self-tests, and self-iterates complex multi-day tasks until 100% complete. Orchestrates sub-agents with Parallax reasoning for deep work."
mode: primary
color: "#00bcd4"
permission:
  edit: allow
  bash: ask
  read: allow
  grep: allow
  glob: allow
  list: allow
  webfetch: allow
  browser: ask
  todowrite: allow
  task: allow
```

---

## 2. ARCHITECTURE

Horizon is a supervisor/orchestrator that wraps Parallax as a reasoning module and dispatches sub-agents via OpenCode's native `task` infrastructure.

```
┌──────────────────────────────────────────────────────────────┐
│                     HORIZON AGENT (Tab)                       │
│                                                               │
│  PHASE 1: RESEARCH                  PHASE 2: PLAN             │
│  ┌─────────────────────┐           ┌─────────────────────┐   │
│  │ Web search + fetch   │           │ Decompose goal into  │   │
│  │ Codebase analysis    │──────────▶│ milestones+features │   │
│  │ Cache to research/   │           │ Determine protocol   │   │
│  │ Skill discovery      │           │ level per feature   │   │
│  └─────────────────────┘           │ Create session skills│   │
│                                     │ Output plan.json     │   │
│                                     └──────────┬──────────┘   │
│                                                │               │
│  PHASE 3: EXECUTE LOOP (autonomous)             │               │
│  ┌──────────────────────────────────────────────▼──────────┐  │
│  │  FOR each feature in plan:                              │  │
│  │    │                                                    │  │
│  │    ├─(a) Determine protocol: none vs full Parallax      │  │
│  │    ├─(b) Dispatch sub-agent via task() tool             │  │
│  │    ├─(c) Wait for sub-agent completion                  │  │
│  │    ├─(d) AUTO-TEST: run project test suite              │  │
│  │    ├─(e) SELF-CHECK: evaluate result across 6 dims      │  │
│  │    │                                                    │  │
│  │    ├─ PASS ──▶ mark feature complete, next feature      │  │
│  │    │                                                    │  │
│  │    └─ FAIL ──▶ create corrective sub-plan               │  │
│  │               ──▶ dispatch fix agent (max 3 cycles)     │  │
│  │               ──▶ if 3 cycles fail → flag for user      │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
│  PHASE 4: FINAL AUDIT                                         │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │  - Run parallax_debug (Universal Auditor) on all work    │  │
│  │  - Run full test suite one final time                    │  │
│  │  - Export traces for all sub-agents                      │  │
│  │  - Generate completion report with decision log          │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
│  PERSISTENCE LAYER                                            │
│  ~/.parallax/horizon/sessions/<id>/                           │
│  ├── plan.json                (structured todo)               │
│  ├── state.json               (orchestration state)           │
│  ├── decisions.jsonl          (auto-decision audit log)       │
│  ├── research/                (cached findings)               │
│  ├── skills/                  (session-scoped skills)         │
│  └── traces/                  (sub-agent trace exports)       │
└──────────────────────────────────────────────────────────────┘
```

---

## 3. INTERACTION POLICY AND PARALLAX GATE

Horizon interacts with the user at exactly TWO windows:

| Window | Allowed? | Purpose |
|---|---|---|
| Pre-execution (Parallax Gate) | YES | Resolve ambiguity ONCE before any work begins |
| Mid-execution | NO | Hard ban. Decide, log, proceed. |
| Post-execution (Final Report) | YES | Deliver results, decisions log, residual questions |

**Mid-execution ban is absolute.** The only legal mid-execution pause is a HARD BLOCKER — missing API credentials, private repo access, hardware, or paid-tier account access the user alone possesses. Design choices, library selection, naming, scope, edge cases, tests, retries, and refactors are NEVER blockers.

### 3.1 Parallax Gate (Pre-Execution, Phase 0)

The Gate is the first action of every task, before any tool call, before any research.

**Ambiguity Levels:**

| Level | Signal | Action |
|---|---|---|
| LOW | Specific, scoped, single-domain, clear acceptance criteria | Proceed immediately. No questions. |
| MEDIUM | 1–2 gaps; reasonable defaults exist but require user preference | Ask 1–3 targeted questions, then proceed. |
| HIGH | Vague, conceptual, multi-domain, contradictory, or has hidden requirements | Ask 3+ questions covering goal, scope, constraints, success criteria. |

**Question Protocol:**
- Multiple choice for enumerable options; open-ended only when unbounded.
- Bundle ALL questions in a single batch — never drip-feed.
- Each question must tie to a specific decision it unblocks.
- Stop tool calls the moment the batch is delivered; resume only after the user answers.

**Gate Resolution:**
- LOW → proceed to Phase 1.
- MEDIUM/HIGH → user answers → re-run Gate to confirm LOW → proceed.
- User declines / time-sensitive / non-interactive → fall back to autonomous defaults via Decision Engine, log in `decisions.jsonl`, proceed. The Gate is never a blocker itself.

**Re-Gate Triggers:** Re-run mid-execution ONLY on a new hard blocker. Do not re-Gate for ordinary design or scope decisions.

### 3.2 Autonomous Decision Engine (Post-Gate, Mid-Execution)

Once the Gate has resolved and execution is underway, the user is NOT consulted. New ambiguity is resolved here.

1. **IDENTIFY** the ambiguity explicitly
2. **RESEARCH** if possible (web search, codebase context, project conventions)
3. **DECIDE** using a best-guess heuristic based on:
   - Project conventions (AGENTS.md, existing patterns)
   - Industry best practices (from research phase)
   - Conservative defaults (prefer safety over cleverness)
4. **DOCUMENT** the decision in `decisions.jsonl` for post-hoc review
5. **PROCEED** — do not block

Scope: design choices, library selection, naming, edge cases, error paths, scope expansion, refactor boundaries, test coverage, retry strategy, configuration values, internal architecture. None of these are user-facing.

### Decision Audit Log Format (decisions.jsonl)

```jsonl
{"timestamp":"ISO","feature":"f1","ambiguity":"Which auth library to use?","researchResult":"NextAuth.js is standard for Next.js","decision":"Use NextAuth.js","rationale":"Industry standard, best research match, aligns with project conventions","confidence":"high"}
```

### Configuration: Autonomy Level

```json
// ~/.parallax/horizon/config.json
{
  "autonomyLevel": "full | semi | supervised",
  "autoApproveMilestones": true,
  "maxRetryCycles": 3,
  "decisionConfidenceThreshold": 0.7,
  "pauseOnCriticalFailure": true,
  "testCommand": "npm test",
  "lintCommand": "npm run lint"
}
```

| Level | Behavior |
|---|---|
| `full` | No user interaction. All decisions auto-resolved. Milestones auto-approved. |
| `semi` | Milestone boundaries require user approval. Feature-level decisions auto-resolved. |
| `supervised` | Every feature requires user approval before dispatch. |

---

## 4. WORKFLOW PHASES (Detailed)

### 4.0 PARALLAX GATE PHASE (Phase 0, mandatory first action)

See [Section 3.1](#31-parallax-gate-pre-execution-phase-0). The Gate runs before any other phase. If the Gate is skipped, every downstream decision is invalid.

**Exit conditions:** ambiguity rated LOW (with or without user input) before Phase 1 begins.

### 4.1 RESEARCH PHASE

**Goal:** Gather all context before any editing begins.

**Inputs:**
- User's goal description
- Current codebase (glob, grep, read)
- Internet (webfetch, browser_navigate)

**Process:**
1. Parse user goal into search queries
2. Web search for best practices, libraries, patterns, documentation
3. Analyze codebase: project type, existing patterns, dependencies, conventions
4. Check for AGENTS.md, project README, existing config files
5. Synthesize findings into `research/findings.md`
6. Cache sources in `research/sources.json`
7. Discover globally available skills that apply to the task

**Outputs:**
- `research/findings.md` -- structured research summary
- `research/sources.json` -- URL references with key excerpts

**Fallbacks:**
- If webfetch fails → proceed with codebase-only context, flag limited research
- If codebase is empty → treat as greenfield project, research becomes primary context

### 4.2 PLAN PHASE

**Goal:** Decompose the goal into an executable, verifiable plan.

**Process:**
1. Based on research, decompose goal into **milestones** (high-level checkpoints)
2. Within each milestone, define **features** (concrete, verifiable units of work)
3. For each feature:
   - Write acceptance criteria (what does "done" mean?)
   - Determine protocol level: `none` (simple) or `full` (complex, uses Parallax)
   - Identify skills needed (global + session-scoped)
   - Estimate complexity (trivial / moderate / complex)
4. Create any session-scoped skills needed for the work
5. Output `plan.json`

**Protocol Level Decision Matrix:**

| Task Type | Protocol | Parallax Tools Used |
|---|---|---|
| Read-only, research, analysis | `none` | None |
| Simple write (config, typo, one-liner) | `none` | None |
| New feature, component, module | `full` | parallax_plan, parallax_build, parallax_verify, parallax_checkin |
| Refactor, architecture change | `full` | parallax_analyze + parallax_plan + parallax_build + parallax_debug |
| Bug fix (targeted) | `none` | parallax_verify only |
| Bug fix (complex, multi-file) | `full` | Full protocol |

**Outputs:**
- `plan.json` -- structured plan with milestones and features
- Session-scoped skills (if any)

### 4.3 EXECUTE LOOP

**Goal:** Execute every feature in the plan, verify each one, iterate until all pass.

**Loop:**
```
FOR each milestone in plan (ordered):
  IF autonomyLevel requires approval:
    Present milestone to user, WAIT for approval
  
  FOR each feature in milestone:
    attempts = 0
    
    WHILE attempts < maxRetryCycles:
      attempts++
      
      # 1. Dispatch sub-agent
      IF feature.protocolLevel == "full":
        dispatch with Parallax protocol prompt
      ELSE:
        dispatch with simple task prompt
      
      WAIT for sub-agent completion
      
      # 2. Auto-test
      RUN project test suite (parallax_verify + custom test command)
      IF tests fail:
        record failure reason
        CREATE corrective sub-plan
        CONTINUE loop (dispatch fix agent)
      
      # 3. Self-check evaluation
      EVALUATE sub-agent output across 6 dimensions:
        a. Protocol integrity (if full Parallax)
        b. Verification (tests pass?)
        c. Correctness (matches acceptance criteria?)
        d. Design quality (AI slop check)
        e. Edge case coverage
        f. User perspective (novice + pro mental simulation)
      
      IF all dimensions pass:
        mark feature complete
        BREAK loop (next feature)
      
      IF some dimensions fail:
        record specific failures
        CREATE corrective sub-plan targeting failures
        IF attempts < maxRetryCycles:
          CONTINUE loop (dispatch fix agent)
        ELSE:
          mark feature as FAILED
          log decision: "Max retries exceeded for feature X"
          BREAK loop (move to next feature)
    
  # After all features in milestone complete:
  mark milestone complete in plan.json
  
# After all milestones:
proceed to Final Audit
```

### 4.4 SELF-CHECK EVALUATION MATRIX

For each completed sub-agent, Horizon evaluates:

| Dimension | Weight | Check | Data Source |
|---|---|---|---|
| **Protocol Integrity** | 15% | All Parallax steps completed? Coherence score >= 60? | Sub-agent trace (parallax_trace_export) |
| **Verification** | 25% | parallax_verify pass? Test suite pass? No lint errors? | Friction state, test output |
| **Correctness** | 25% | Output matches acceptance criteria? No logical errors? | Code review of sub-agent output |
| **Design Quality** | 15% | AI slop detected? (generic patterns, boilerplate, poor naming) Follows project conventions? | Visual and structural audit |
| **Edge Case Coverage** | 10% | Null/empty states handled? Error paths covered? Boundary conditions? | Static analysis |
| **User Perspective** | 10% | Works for novice user? Works for pro user? Intuitive? Accessible? | Mental simulation |

**Pass threshold:** >= 75% weighted score

### 4.5 AUTOMATED TESTING

After each sub-agent completes (and before self-check evaluation):

1. Run `parallax_verify` (typecheck/lint/compile depending on project type)
2. Run project test suite using configured `testCommand`
3. Run project lint using configured `lintCommand`
4. If any fail → auto-capture failure output → feed into corrective sub-plan
5. Test results are recorded in feature verification state

---

## 5. PERSISTENCE MODEL

### Directory Structure

```
~/.parallax/horizon/
├── config.json                   # Horizon global config (autonomy level, test commands)
├── index.json                    # Maps session UUIDs → goal summaries
└── sessions/
    └── <session-uuid>/
        ├── plan.json             # The structured plan
        ├── state.json            # Orchestration state
        ├── decisions.jsonl       # Auto-decision audit log
        ├── research/
        │   ├── findings.md       # Synthesized research summary
        │   └── sources.json      # URLs and key excerpts
        ├── skills/
        │   └── <skill-name>/
        │       └── SKILL.md      # Session-scoped auto-generated skill
        └── traces/
            └── <sub-agent-session-id>.json
```

### plan.json Schema

```json
{
  "schemaVersion": "1.0",
  "sessionId": "uuid",
  "goal": "User's original goal statement",
  "autonomyLevel": "full",
  "status": "planning | executing | completed | failed",
  "createdAt": "2026-05-27T12:00:00Z",
  "completedAt": null,
  "milestones": [
    {
      "id": "milestone-001",
      "name": "Foundation & Research",
      "description": "Research existing solutions and set up project foundation",
      "status": "pending | in_progress | completed | failed",
      "order": 1,
      "requiresApproval": false,
      "features": [
        {
          "id": "feat-001",
          "name": "Research authentication libraries",
          "description": "Find best auth library for Next.js project",
          "acceptanceCriteria": "Document recommending a library with rationale",
          "protocolLevel": "none",
          "status": "pending | in_progress | completed | failed",
          "order": 1,
          "subAgentSessionId": null,
          "attempts": 0,
          "maxAttempts": 3,
          "verification": {
            "passed": false,
            "testResults": null,
            "issues": [],
            "score": null
          },
          "skillsRequired": [],
          "skillsGenerated": []
        }
      ]
    }
  ],
  "skills": {
    "global": ["parallax-plan", "parallax-debug"],
    "sessionScoped": []
  },
  "stats": {
    "totalFeatures": 0,
    "completedFeatures": 0,
    "failedFeatures": 0,
    "totalRetries": 0,
    "estimatedCost": null
  }
}
```

### state.json Schema

```json
{
  "sessionId": "uuid",
  "currentPhase": "research | plan | execute | audit | complete",
  "activeSubAgents": ["sub-agent-session-id-1"],
  "currentMilestoneId": "milestone-001",
  "currentFeatureId": "feat-003",
  "lastCheckpoint": "2026-05-27T14:30:00Z",
  "pausedAt": null,
  "pauseReason": null
}
```

### Session Isolation Guarantees

- Each session gets a unique UUID-scoped directory
- Skills in one session are invisible to other sessions
- Traces are scoped per session
- Decisions are scoped per session
- `index.json` maps UUIDs to goal summaries for discovery without cross-contamination
- On session completion, the session directory is archived (not deleted) for audit

---

## 6. PLUGIN INTEGRATION

### 6.1 New Files

| File | Purpose |
|---|---|
| `agents/horizon.md` | Agent tab definition (YAML frontmatter + markdown prompt) |
| `skills/horizon/SKILL.md` | Horizon operational instructions (loaded on mode switch) |

### 6.2 Modified Files

| File | Change |
|---|---|
| `src/types.ts` | Add `"horizon"` to `AgentMode` union |
| `src/plugin.ts` | Add `MODE_META["horizon"]`, add `parallax_horizon` tool, modify `tool.execute.before` hook |
| `scripts/install.mjs` | Add `horizon.md` agent and `horizon` skill to copy list |

### 6.3 New Mode Switch Tool

```typescript
parallax_horizon: tool({
  description:
    "Switch to HORIZON mode. Activates the long-horizon autonomous supervisor " +
    "agent that plans, researches, executes, self-tests, and self-iterates " +
    "until the task is 100% complete. Use for multi-hour to multi-day tasks.",
  args: {},
  async execute() {
    getMode().mode = "horizon"
    addPhase(sessionId(), "mode_switch", { mode: "horizon" })
    writeState()
    return (
      "[parallax] HORIZON mode activated. " +
      "Long-horizon autonomous supervisor loaded. " +
      "I will plan, research, execute, self-test, and self-iterate " +
      "until the task is 100% complete."
    )
  },
}),
```

### 6.4 Hook Modification: Write Enforcement

The `tool.execute.before` hook currently blocks all writes without protocol checkin. For Horizon, this hook must distinguish between:

- **Horizon orchestration writes** (writing plan.json, state.json, skills, research) -- ALLOWED without Parallax protocol
- **Sub-agent implementation writes** (writing application code) -- ENFORCED with Parallax protocol when protocolLevel is `full`

**Implementation:** Check the current agent name or session metadata. If Horizon is the active agent, allow orchestration writes. Sub-agents dispatched by Horizon run in their own context where protocol enforcement applies normally.

```typescript
// In tool.execute.before:
// If current agent is "horizon" and writing to ~/.parallax/horizon/*, skip enforcement
if (currentAgentName === "horizon" && filePath.startsWith(homedir())) {
  return // Allow orchestration writes
}
// Otherwise, enforce protocol as before
```

### 6.5 System Prompt Injection

When Horizon mode is active, the `experimental.chat.system.transform` hook injects:

```
=== HORIZON MODE ===

You are HORIZON -- a long-horizon autonomous supervisor agent.

[CORE BEHAVIOR]
- You plan, research, execute, self-test, and self-iterate until done
- You NEVER ask the user mid-execution questions. You research and decide.
- You document all auto-decisions in decisions.jsonl
- You dispatch sub-agents for implementation work
- You self-evaluate every sub-agent output across 6 dimensions
- You run automated tests after every sub-agent
- You re-plan and retry when verification fails (max 3 cycles)
- You report progress through client.app.log()

[WORKFLOW]
1. RESEARCH -- web search + codebase analysis before any editing
2. PLAN -- decompose into milestones + features in plan.json
3. EXECUTE -- dispatch sub-agents, test, evaluate, iterate
4. AUDIT -- final parallax_debug pass on all work

[TOOLS]
- task() to dispatch sub-agents
- webfetch/browser for research
- parallax_plan/build/debug for complex sub-agent configuration
- parallax_verify for automated verification
- todowrite for plan tracking

[PERSISTENCE]
All state at ~/.parallax/horizon/sessions/<id>/
```

---

## 7. SESSION-SCOPED SKILLS

### Creation Process

1. During PLAN phase, Horizon identifies gaps where a custom skill would improve sub-agent quality
2. Horizon generates the skill content (a markdown file with YAML frontmatter)
3. Skill is written to `~/.parallax/horizon/sessions/<session-id>/skills/<name>/SKILL.md`
4. Skill is registered in `plan.json` under `skills.sessionScoped`
5. Sub-agents reference the skill in their task context

### Skill Template

```markdown
---
name: <skill-name>
description: <what this skill does>
scope: session
sessionId: <uuid>
---

# <Skill Title>

[Specialized instructions for sub-agents working on this session's tasks]

## Context
[What the sub-agent needs to know about this specific task]

## Patterns
[Code patterns, conventions, or approaches to use]

## Constraints
[Rules specific to this session's work]
```

### Lifecycle

- Created during PLAN phase
- Loaded by sub-agents during EXECUTE phase
- Archived with session on completion (not deleted)
- Invisible to other sessions or global skill registry

---

## 8. GUARDRAILS & SAFETY

| Guardrail | Mechanism |
|---|---|
| **Max retries** | 3 corrective cycles per feature. After 3 failures, feature is flagged as FAILED and Horizon moves on. |
| **Milestone checkpoints** | Optional user approval gates between milestones (configurable via autonomyLevel). |
| **Sub-agent timeout** | Each sub-agent has a maximum execution budget. Horizon kills and retries if exceeded. |
| **Infinite loop prevention** | Feature-level retry cap + milestone-level feature count cap + session-level wall-clock timeout. |
| **Cost awareness** | Horizon estimates token cost per milestone before execution and reports cumulative cost. |
| **Decision audit** | Every auto-decision is logged to `decisions.jsonl` for post-hoc review. |
| **Resource limits** | Configurable max concurrent sub-agents (default: 1, sequential execution). |
| **Critical failure pause** | If autonomyLevel is `semi` or `supervised`, Horizon pauses on critical failures and waits for user. |
| **Write isolation** | Horizon's orchestration writes are scoped to `~/.parallax/horizon/`. Sub-agent writes go to project directories and are subject to Parallax protocol enforcement. |

---

## 9. ERROR & RECOVERY SCENARIOS

| Scenario | Recovery |
|---|---|
| **Session restart during execution** | On startup, Horizon reads `state.json` and `plan.json`, identifies current phase and active item, resumes from last checkpoint. |
| **Sub-agent crashes/times out** | Horizon detects failed sub-agent, increments attempt counter, creates corrective sub-plan, dispatches new sub-agent. |
| **Test suite breaks** | Horizon captures test failure output, analyzes root cause, dispatches fix sub-agent. If tests were already broken before Horizon started, flags as pre-existing issue. |
| **Research phase fails** | Falls back to codebase-only context. If codebase also empty, proceeds with conservative defaults, flags limited context. |
| **Skill generation fails** | Horizon falls back to inline instructions in sub-agent prompt instead of session-scoped skill. |
| **Disk full during persistence** | Horizon logs error via `client.app.log()`, continues in-memory, retries persistence on next checkpoint. |
| **Infinite self-check loop** | Feature retry cap (3) breaks the loop. Feature is marked FAILED with audit log entry. |

---

## 10. IMPLEMENTATION PHASES

### Phase A: Core Infrastructure
- [ ] Add `"horizon"` to `AgentMode` type
- [ ] Add `MODE_META["horizon"]` entry
- [ ] Create `parallax_horizon` mode switch tool
- [ ] Create `agents/horizon.md` agent definition
- [ ] Create `skills/horizon/SKILL.md` skill file
- [ ] Update `scripts/install.mjs` to copy new files
- [ ] Modify `tool.execute.before` to handle Horizon orchestration writes

### Phase B: Persistence Layer
- [ ] Implement `plan.json` read/write with schema validation
- [ ] Implement `state.json` for orchestration state
- [ ] Implement `decisions.jsonl` for audit logging
- [ ] Implement session directory creation and isolation
- [ ] Implement `index.json` for session discovery
- [ ] Wire into `experimental.session.compacting` for state preservation

### Phase C: Plan Engine
- [ ] Implement goal decomposition (milestones + features)
- [ ] Implement protocol level decision matrix
- [ ] Implement skill gap analysis and generation
- [ ] Implement plan.json output

### Phase D: Execution Engine
- [ ] Implement sub-agent dispatch with protocol configuration
- [ ] Implement automated test execution after sub-agent completion
- [ ] Implement self-check evaluation across 6 dimensions
- [ ] Implement corrective sub-plan generation
- [ ] Implement retry loop with max cycle guard

### Phase E: Autonomous Decision Engine
- [ ] Implement ambiguity detection in execution context
- [ ] Implement research-based auto-resolution
- [ ] Implement decision logging to decisions.jsonl
- [ ] Implement autonomy level configuration (full/semi/supervised)

### Phase F: Polish & Testing
- [ ] Session restart recovery
- [ ] Cost estimation
- [ ] Progress reporting via client.app.log()
- [ ] Trace export for all sub-agents
- [ ] Completion report generation
- [ ] Unit tests for all phases

---

## 11. OPEN QUESTIONS & TRADE-OFFS

| Question | Current Position | Risk |
|---|---|---|
| Parallel sub-agents? | Start with sequential (1 at a time). Factory's research says parallel may not improve quality. Can add later. | Low -- sequential is simpler and safer. |
| How to detect "AI slop"? | Heuristic-based: check for generic variable names, excessive comments, boilerplate patterns, lack of project-specific conventions. Compare against project codebase patterns. | Medium -- heuristic may false-positive. Needs tuning. |
| Cost estimation accuracy? | Rough estimate based on planned sub-agent count + average token usage. Not a billing guarantee. | Low -- informational only. |
| Should Horizon be able to install packages? | No. Package installation requires user approval. Horizon can recommend but not execute. | Low -- safety-first. |
| What if the user's goal is impossible? | Horizon should detect this in PLAN phase: if acceptance criteria cannot be met with available tools, report impossibility early. | Medium -- requires good judgment from the LLM. |

---

*End of specification. Ready for validation and implementation.*
