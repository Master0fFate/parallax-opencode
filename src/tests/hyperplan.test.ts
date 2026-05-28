/**
 * Tests for Hyperplan adversarial plan hardening engine.
 *
 * Tests complexity detection, angle selection by complexity level,
 * prompt generation structure, critique synthesis, and edge cases
 * (trivial plans, empty plans, custom angles, force flag).
 */
import { describe, it, expect } from "vitest"

import {
  assessComplexity,
  generateHyperplan,
  generateCrossAttackPrompt,
  generateAllCrossAttacks,
  generateDefensePrompt,
  synthesizeCritiques,
  synthesizeInsightBundle,
  buildInsightBundle,
  DEFAULT_ANGLES,
} from "../hyperplan"

import type { HyperplanCritique } from "../types"

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TRIVIAL_PLAN = [
  "Fix typo in README: change 'teh' to 'the'.",
  "",
  "Single file change. No tests needed. No dependencies.",
].join("\n")

const MODERATE_PLAN = [
  "# Add User Profile Page",
  "",
  "## Components",
  "- Create UserProfile component with edit form",
  "- Add avatar upload with preview",
  "- Implement form validation for name, email, bio",
  "",
  "## API",
  "- GET /api/users/:id - fetch profile data",
  "- PUT /api/users/:id - update profile",
  "- POST /api/users/:id/avatar - upload avatar",
  "",
  "## Data Layer",
  "- Update user schema with bio field",
  "- Add avatar storage (local filesystem)",
  "- Cache profile responses for 60 seconds",
  "",
  "## States",
  "- Loading skeleton while data fetches",
  "- Empty state for new users (no bio yet)",
  "- Error state with retry button",
  "- Offline detection with cached display",
].join("\n")

const COMPLEX_PLAN = [
  "# Microservice Authentication Gateway",
  "",
  "## Architecture",
  "- Edge auth service handling OAuth2/OIDC flows",
  "- Token service for JWT generation and rotation",
  "- Session store with Redis cluster (replication + failover)",
  "- Rate limiter with sliding window (per-user, per-endpoint)",
  "",
  "## API Gateway",
  "- Route requests to backend services",
  "- Enforce rate limits and CORS policies",
  "- Circuit breaker per upstream service",
  "- Request/response transformation pipeline",
  "",
  "## Database",
  "- User table with role-based permissions",
  "- Refresh token table with automatic cleanup",
  "- Migration system with rollback support",
  "- Read replicas for token validation queries",
  "",
  "## Security",
  - "TLS termination at gateway",
  - "CSRF token validation on mutating endpoints",
  - "SQL injection prevention via parameterized queries",
  - "Audit logging for all auth events",
  "",
  "## Deployment",
  "- Docker containers orchestrated via Kubernetes",
  "- Horizontal pod autoscaling based on CPU/memory",
  "- Blue-green deployment with health checks",
  "- Secrets management via Vault",
  "",
  "## Observability",
  "- Structured logging (JSON format)",
  "- Prometheus metrics for request latency, error rate",
  "- Distributed tracing via OpenTelemetry",
  "- Alerting on P99 latency > 500ms or error rate > 1%",
].join("\n")

// ---------------------------------------------------------------------------
// Complexity Detection
// ---------------------------------------------------------------------------

describe("Complexity Detection", () => {
  it("classifies trivial plan correctly", () => {
    const result = assessComplexity(TRIVIAL_PLAN)
    expect(result.level).toBe("trivial")
    expect(result.score).toBeLessThan(3)
  })

  it("classifies moderate plan correctly", () => {
    const result = assessComplexity(MODERATE_PLAN)
    expect(result.level).toBe("moderate")
    // Score should be >= 3 but not huge -- moderate plan has API, DB, schema, cache, component keywords
    expect(result.score).toBeGreaterThanOrEqual(3)
  })

  it("classifies complex plan correctly", () => {
    const result = assessComplexity(COMPLEX_PLAN)
    expect(result.level).toBe("complex")
    expect(result.score).toBeGreaterThan(8)
  })

  it("returns empty signals for plan with zero complexity keywords", () => {
    const result = assessComplexity("Fix a typo. Change 'colour' to 'color'.")
    expect(result.level).toBe("trivial")
    expect(result.signals).toEqual([])
  })

  it("detects structure (milestones, task lists) as complexity boost", () => {
    const structuredPlan = [
      "- [ ] Task one: set up the build pipeline",
      "- [ ] Task two: configure the deployment orchestrator",
    ].join("\n")
    const result = assessComplexity(structuredPlan)
    // "pipeline" and "orchestrat" both score -- should be moderate+
    expect(result.level).toBe("moderate")
  })

  it("handles empty plan gracefully", () => {
    const result = assessComplexity("")
    expect(result.level).toBe("trivial")
    expect(result.signals).toEqual([])
    expect(result.score).toBe(0)
  })

  it("handles plan with only newlines", () => {
    const result = assessComplexity("\n\n\n")
    expect(result.level).toBe("trivial")
  })
})

// ---------------------------------------------------------------------------
// Angle Selection via generateHyperplan
// ---------------------------------------------------------------------------

describe("Angle Selection", () => {
  it("skips trivial plans by default", () => {
    const result = generateHyperplan(TRIVIAL_PLAN)
    expect(result.skipped).toBe(true)
    expect(result.complexity).toBe("trivial")
    expect(result.prompts).toHaveLength(0)
  })

  it("forces execution on trivial plans with force=true", () => {
    const result = generateHyperplan(TRIVIAL_PLAN, { force: true })
    expect(result.skipped).toBe(false)
    // Should return critical-severity angles only for trivial+force
    expect(result.angles.length).toBeGreaterThan(0)
    expect(result.prompts.length).toBe(result.angles.length)
  })

  it("selects critical-only angles for moderate plans", () => {
    const result = generateHyperplan(MODERATE_PLAN)
    expect(result.skipped).toBe(false)
    expect(result.complexity).toBe("moderate")
    // Moderate plans should only get critical-severity angles
    for (const angle of result.angles) {
      expect(angle.severity).toBe("critical")
    }
    expect(result.angles.length).toBe(2) // integration + sentinel
  })

  it("selects all 5 angles for complex plans", () => {
    const result = generateHyperplan(COMPLEX_PLAN)
    expect(result.skipped).toBe(false)
    expect(result.complexity).toBe("complex")
    expect(result.angles).toHaveLength(5)
  })

  it("respects custom angle IDs", () => {
    const result = generateHyperplan(COMPLEX_PLAN, {
      customAngles: ["pragmatist", "humanist"],
    })
    expect(result.skipped).toBe(false)
    expect(result.angles).toHaveLength(2)
    expect(result.angles[0].id).toBe("pragmatist")
    expect(result.angles[1].id).toBe("humanist")
  })

  it("falls through to defaults when no custom IDs match", () => {
    const result = generateHyperplan(COMPLEX_PLAN, {
      customAngles: ["nonexistent"],
    })
    expect(result.skipped).toBe(false)
    // Should fall through to default complex selection (all 5)
    expect(result.angles).toHaveLength(5)
  })

  it("returns all 5 default angles when requested explicitly for moderate plan", () => {
    const result = generateHyperplan(MODERATE_PLAN, {
      customAngles: ["pragmatist", "integration", "sentinel", "architect", "humanist"],
    })
    expect(result.skipped).toBe(false)
    expect(result.angles).toHaveLength(5)
  })
})

// ---------------------------------------------------------------------------
// Prompt Generation
// ---------------------------------------------------------------------------

describe("Prompt Generation", () => {
  it("includes the plan in every prompt", () => {
    const result = generateHyperplan(COMPLEX_PLAN)
    for (const p of result.prompts) {
      expect(p.prompt).toContain(COMPLEX_PLAN)
    }
  })

  it("includes the angle's instruction in each prompt", () => {
    const result = generateHyperplan(COMPLEX_PLAN)
    for (const angle of result.angles) {
      const prompt = result.prompts.find((p) => p.angleId === angle.id)
      expect(prompt).not.toBeUndefined()
      expect(prompt!.prompt).toContain(angle.instruction)
    }
  })

  it("includes output format instructions", () => {
    const result = generateHyperplan(COMPLEX_PLAN)
    for (const p of result.prompts) {
      expect(p.prompt).toContain("Output Format")
      expect(p.prompt).toContain("angleId")
      expect(p.prompt).toContain("findings")
      expect(p.prompt).toContain("severity")
      expect(p.prompt).toContain("selfCritique")
    }
  })

  it("includes self-critique requirement", () => {
    const result = generateHyperplan(COMPLEX_PLAN)
    for (const p of result.prompts) {
      expect(p.prompt).toContain("selfCritique")
      expect(p.prompt).toContain("blind spots")
    }
  })

  it("includes context enrichment for API plans", () => {
    const apiPlan = [
      "Design a REST API with endpoints, authentication, and rate limiting.",
    ].join("\n")
    const result = generateHyperplan(apiPlan, { force: true })
    // Should include API-specific context
    const firstPrompt = result.prompts[0].prompt
    expect(firstPrompt).toContain("API design")
  })

  it("generates unique prompts per angle", () => {
    const result = generateHyperplan(COMPLEX_PLAN)
    const promptTexts = result.prompts.map((p) => p.prompt)
    // All prompts should be different (each has unique angle name and instruction)
    const unique = new Set(promptTexts)
    expect(unique.size).toBe(promptTexts.length)
  })
})

// ---------------------------------------------------------------------------
// Critique Synthesis
// ---------------------------------------------------------------------------

describe("Critique Synthesis", () => {
  it("handles empty critiques array", () => {
    const result = synthesizeCritiques(COMPLEX_PLAN, [])
    expect(result.confidence).toBe(100)
    expect(result.survivingInsights).toHaveLength(0)
    expect(result.summary).toContain("No critiques received")
  })

  it("produces lower confidence with critical findings", () => {
    const critiques: HyperplanCritique[] = [
      {
        angleId: "sentinel",
        angleName: "Sentinel",
        findings: "No input validation on any endpoint. SQL injection vector in user query.",
        severity: "critical",
        affectedAreas: ["API endpoints", "Database queries"],
      },
    ]
    const result = synthesizeCritiques(COMPLEX_PLAN, critiques)
    expect(result.confidence).toBeLessThan(100)
    expect(result.confidence).toBe(85) // 100 - 15 (one critical)
    expect(result.survivingInsights.length).toBeGreaterThan(0)
  })

  it("produces lower confidence with many major findings", () => {
    const critiques: HyperplanCritique[] = [
      {
        angleId: "architect",
        angleName: "Architectural Strategist",
        findings: "Wrong abstraction for auth service.",
        severity: "major",
        affectedAreas: ["Auth service"],
      },
      {
        angleId: "humanist",
        angleName: "Humanist",
        findings: "Too much cognitive load for new devs.",
        severity: "major",
        affectedAreas: ["Developer onboarding"],
      },
    ]
    const result = synthesizeCritiques(COMPLEX_PLAN, critiques)
    // 100 - 2*8 = 84
    expect(result.confidence).toBe(84)
  })

  it("identifies overlapping concern areas", () => {
    const critiques: HyperplanCritique[] = [
      {
        angleId: "sentinel",
        angleName: "Sentinel",
        findings: "No rate limiting on auth endpoints.",
        severity: "critical",
        affectedAreas: ["Auth endpoints"],
      },
      {
        angleId: "integration",
        angleName: "Integration Tester",
        findings: "Auth service has no timeout handling.",
        severity: "major",
        affectedAreas: ["Auth endpoints"],
      },
    ]
    const result = synthesizeCritiques(COMPLEX_PLAN, critiques)
    // Both critiques hit "Auth endpoints" -- overlapping concern
    expect(result.summary).toContain("Auth endpoints")
    // Should mention that multiple critics hit the same area
    expect(result.summary).toContain("perspectives")
  })

  it("separates critical, major, minor findings correctly", () => {
    const critiques: HyperplanCritique[] = [
      {
        angleId: "sentinel",
        angleName: "Sentinel",
        findings: "Critical security issue.",
        severity: "critical",
        affectedAreas: ["Security"],
      },
      {
        angleId: "architect",
        angleName: "Architect",
        findings: "Major design issue.",
        severity: "major",
        affectedAreas: ["Architecture"],
      },
      {
        angleId: "humanist",
        angleName: "Humanist",
        findings: "Minor UX concern.",
        severity: "minor",
        affectedAreas: ["UX"],
      },
    ]
    const result = synthesizeCritiques(COMPLEX_PLAN, critiques)
    expect(result.summary).toContain("1 critical")
    expect(result.summary).toContain("1 major")
    expect(result.summary).toContain("1 minor")
  })

  it("includes recommended actions in summary", () => {
    const critiques: HyperplanCritique[] = [
      {
        angleId: "sentinel",
        angleName: "Sentinel",
        findings: "No error handling.",
        severity: "critical",
        affectedAreas: ["Error handling"],
      },
    ]
    const result = synthesizeCritiques(COMPLEX_PLAN, critiques)
    expect(result.summary).toContain("Recommended Actions")
    expect(result.summary).toContain("Address ALL")
  })

  it("outputs appropriate action for minor-only critiques", () => {
    const critiques: HyperplanCritique[] = [
      {
        angleId: "humanist",
        angleName: "Humanist",
        findings: "Slight naming confusion.",
        severity: "minor",
        affectedAreas: ["Naming"],
      },
    ]
    const result = synthesizeCritiques(COMPLEX_PLAN, critiques)
    expect(result.summary).toContain("Minor findings only")
    expect(result.summary).not.toContain("Address ALL")
  })
})

// ---------------------------------------------------------------------------
// Edge Cases
// ---------------------------------------------------------------------------

describe("Edge Cases", () => {
  it("falls through to defaults when customAngles is empty array", () => {
    // Empty array means "no custom filter" -> falls through to defaults
    // which for moderate plans means critical-only angles
    const result = generateHyperplan(MODERATE_PLAN, {
      customAngles: [],
    })
    expect(result.skipped).toBe(false)
    expect(result.complexity).toBe("moderate")
    // Should get default moderate behavior: 2 critical angles
    expect(result.angles.length).toBe(2)
    expect(result.angles.every((a) => a.severity === "critical")).toBe(true)
  })

  it("default angles array is non-empty and has correct structure", () => {
    expect(DEFAULT_ANGLES.length).toBe(5)
    for (const angle of DEFAULT_ANGLES) {
      expect(angle.id).toBeTruthy()
      expect(angle.name).toBeTruthy()
      expect(angle.attackVector).toBeTruthy()
      expect(angle.instruction).toBeTruthy()
      expect(angle.focusAreas.length).toBeGreaterThan(0)
      expect(["critical", "major", "minor"]).toContain(angle.severity)
    }
  })

  it("includes context in prompts when extraContext provided", () => {
    const result = generateHyperplan(COMPLEX_PLAN, {
      extraContext: "- This is a legacy migration project",
    })
    const firstPrompt = result.prompts[0].prompt
    expect(firstPrompt).toContain("legacy migration")
  })
})

// ---------------------------------------------------------------------------
// Cross-Attack (Round 2)
// ---------------------------------------------------------------------------

describe("Cross-Attack (Round 2)", () => {
  const sampleFindings = [
    { angleId: "pragmatist", angleName: "Pragmatist", findings: "Finding 1: Too many modules." },
    { angleId: "sentinel", angleName: "Sentinel", findings: "Finding 2: No error handling." },
  ]

  it("generates cross-attack prompt for a single angle", () => {
    const angle = DEFAULT_ANGLES[0] // Pragmatist
    const prompt = generateCrossAttackPrompt(angle, sampleFindings)

    expect(prompt).toContain(angle.name)
    expect(prompt).toContain("CROSS-ATTACK")
    expect(prompt).toContain("Sentinel") // Other critic's findings
    expect(prompt).toContain("Attack EVERY finding")
    expect(prompt).toContain("STANDS")
  })

  it("does not include own findings in cross-attack prompt", () => {
    const angle = DEFAULT_ANGLES[0] // Pragmatist
    const allFindings = [
      ...sampleFindings,
      { angleId: "pragmatist", angleName: "Pragmatist", findings: "My own finding." },
    ]
    const prompt = generateCrossAttackPrompt(angle, allFindings)
    // Should NOT tell the Pragmatist to attack their own findings
    expect(prompt).not.toContain("My own finding")
  })

  it("generates cross-attack prompts for all angles", () => {
    const result = generateHyperplan(COMPLEX_PLAN)
    const allFindings = result.angles.map((a) => ({
      angleId: a.id,
      angleName: a.name,
      findings: `${a.name} finding here.`,
    }))

    const prompts = generateAllCrossAttacks(result.angles, allFindings)
    expect(prompts.length).toBe(result.angles.length)

    for (const p of prompts) {
      expect(p.angleId).toBeTruthy()
      expect(p.prompt).toContain("CROSS-ATTACK")
    }
  })

  it("generates unique cross-attack prompts per angle", () => {
    const result = generateHyperplan(COMPLEX_PLAN)
    const allFindings = result.angles.map((a) => ({
      angleId: a.id,
      angleName: a.name,
      findings: `Finding from ${a.name}.`,
    }))

    const prompts = generateAllCrossAttacks(result.angles, allFindings)
    const promptTexts = prompts.map((p) => p.prompt)
    const unique = new Set(promptTexts)
    expect(unique.size).toBe(promptTexts.length)
  })

  it("handles single angle gracefully", () => {
    const result = generateHyperplan(MODERATE_PLAN)
    // Moderate plan with full custom angles
    const moderateWithAll = generateHyperplan(MODERATE_PLAN, {
      customAngles: ["pragmatist", "integration", "sentinel", "architect", "humanist"],
    })
    const allFindings = moderateWithAll.angles.map((a) => ({
      angleId: a.id,
      angleName: a.name,
      findings: `${a.name} finding.`,
    }))

    const prompts = generateAllCrossAttacks(moderateWithAll.angles, allFindings)
    expect(prompts.length).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// Defense & Refinement (Round 3)
// ---------------------------------------------------------------------------

describe("Defense & Refinement (Round 3)", () => {
  it("generates defense prompt with attacks", () => {
    const angle = DEFAULT_ANGLES[0] // Pragmatist
    const attacks = [
      {
        targetFinding: "Too many modules proposed.",
        attackerName: "Integration Tester",
        attack: "This ignores the actual modularity requirements.",
        severity: "critical",
      },
    ]

    const prompt = generateDefensePrompt(angle, attacks)
    expect(prompt).toContain(angle.name)
    expect(prompt).toContain("DEFENSE & REFINEMENT")
    expect(prompt).toContain("Too many modules proposed")
    expect(prompt).toContain("Integration Tester")
    expect(prompt).toContain("DEFEND")
    expect(prompt).toContain("REFINE")
    expect(prompt).toContain("CONCEDE")
  })

  it("handles multiple attacks", () => {
    const angle = DEFAULT_ANGLES[1] // Integration Tester (formerly integration)
    const attacks = [
      {
        targetFinding: "Missing test cases.",
        attackerName: "Pragmatist",
        attack: "Too many test cases.",
        severity: "major",
      },
      {
        targetFinding: "No error path tests.",
        attackerName: "Sentinel",
        attack: "Error paths completely untested.",
        severity: "critical",
      },
      {
        targetFinding: "Test structure is wrong.",
        attackerName: "Architectural Strategist",
        attack: "Leaky test abstractions.",
        severity: "minor",
      },
    ]

    const prompt = generateDefensePrompt(angle, attacks)
    expect(prompt).toContain("Missing test cases")
    expect(prompt).toContain("No error path tests")
    expect(prompt).toContain("Test structure is wrong")
    expect(prompt).toContain("DEFEND")
    expect(prompt).toContain("REFINE")
    expect(prompt).toContain("CONCEDE")
  })

  it("output format mentions JSON array response", () => {
    const angle = DEFAULT_ANGLES[2] // Sentinel
    const attacks = [
      {
        targetFinding: "No security review.",
        attackerName: "Architectural Strategist",
        attack: "Security is everyone's job.",
        severity: "major",
      },
    ]

    const prompt = generateDefensePrompt(angle, attacks)
    expect(prompt).toContain("JSON array")
    expect(prompt).toContain('"DEFEND"')
    expect(prompt).toContain('"REFINE"')
    expect(prompt).toContain('"CONCEDE"')
  })
})

// ---------------------------------------------------------------------------
// Insight Bundle Synthesis
// ---------------------------------------------------------------------------

describe("Insight Bundle Synthesis", () => {
  const sampleCritiques: HyperplanCritique[] = [
    {
      angleId: "sentinel",
      angleName: "Sentinel",
      findings: "No rate limiting on auth endpoints. Potential for brute force attacks.",
      severity: "critical",
      affectedAreas: ["Auth endpoints", "Rate limiting"],
    },
    {
      angleId: "architect",
      angleName: "Architectural Strategist",
      findings: "Auth service has hidden coupling with user service via shared DB access.",
      severity: "major",
      affectedAreas: ["Auth service", "Database access"],
    },
    {
      angleId: "humanist",
      angleName: "Humanist",
      findings: "Error messages are too technical for end users.",
      severity: "minor",
      affectedAreas: ["Error messages"],
    },
  ]

  it("produces insight bundle with all 4 categories", () => {
    const bundle = buildInsightBundle(COMPLEX_PLAN, sampleCritiques)

    expect(bundle.hardConstraints.length).toBe(1) // critical -> hard constraint
    expect(bundle.decisionsMade.length).toBe(1) // major -> decision
    expect(bundle.openQuestions.length).toBe(1) // minor -> open question
    expect(bundle.risksAndMitigations.length).toBe(1) // critical also creates risk
    expect(bundle.confidenceScore).toBeLessThan(100)
  })

  it("generates readable insight bundle text", () => {
    const text = synthesizeInsightBundle(COMPLEX_PLAN, sampleCritiques)

    expect(text).toContain("Insight Bundle")
    expect(text).toContain("Hard Constraints")
    expect(text).toContain("Decisions Made")
    expect(text).toContain("Risks & Mitigations")
    expect(text).toContain("Open Questions")
    expect(text).toContain("Adversarial Provenance")
    expect(text).toContain("Confidence Score")
  })

  it("tracks adversarial provenance per angle", () => {
    const bundle = buildInsightBundle(COMPLEX_PLAN, sampleCritiques)

    expect(bundle.adversarialProvenance["Sentinel"]).toBe(1)
    expect(bundle.adversarialProvenance["Architectural Strategist"]).toBe(1)
    expect(bundle.adversarialProvenance["Humanist"]).toBe(1)
  })

  it("handles empty critiques gracefully", () => {
    const bundle = buildInsightBundle(COMPLEX_PLAN, [])
    expect(bundle.hardConstraints).toEqual([])
    expect(bundle.decisionsMade).toEqual([])
    expect(bundle.risksAndMitigations).toEqual([])
    expect(bundle.openQuestions).toEqual([])
    expect(bundle.confidenceScore).toBe(100)
    expect(Object.keys(bundle.adversarialProvenance)).toHaveLength(0)
  })

  it("handles round 3 defenses reducing effective critical count", () => {
    const bundle = buildInsightBundle(COMPLEX_PLAN, sampleCritiques, [
      {
        angleId: "sentinel",
        responses: [
          { response: "CONCEDE", reasoning: "The plan already has rate limiting." },
        ],
      },
    ])
    // One critical conceded -> higher confidence
    expect(bundle.confidenceScore).toBeGreaterThan(85) // 100 - (0*15 + 1*8) = 92
  })
})
