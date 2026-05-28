/**
 * HYPERPLAN -- Adversarial Plan Hardening Engine
 *
 * Multi-perspective adversarial critique system that analyzes plans from
 * orthogonal angles before execution begins. Detects plan complexity,
 * generates structured adversarial prompts, and synthesizes critiques
 * into hardened plans that survive real-world scrutiny.
 *
 * Architecture:
 *   1. Complexity Detection -- gate that skips trivial plans
 *   2. Angle Generation -- spawn N adversarial perspectives
 *   3. Prompt Construction -- build structured sub-agent prompts
 *   4. Critique Synthesis -- merge survivor insights into hardened plan
 *
 * License: MIT
 * Copyright (c) 2026 Master0fFate
 */

import type {
  HyperplanAngle,
  HyperplanCritique,
  HyperplanResult,
  HyperplanSynthesis,
} from "./types.js"

// ---------------------------------------------------------------------------
// Constants -- the 5 adversarial angles
// ---------------------------------------------------------------------------

const DEFAULT_ANGLES: HyperplanAngle[] = [
  {
    id: "pragmatist",
    name: "Pragmatist",
    attackVector: "Over-engineering, scope creep, unnecessary complexity, YAGNI violations",
    instruction:
      "Attack this plan for being too complex. What can be deleted without losing value? " +
      "What is gold-plating or premature optimization? Where does the plan violate YAGNI? " +
      "Which features are 'nice to have' vs 'must have'? What would a minimal viable version " +
      "of this plan look like? Be ruthless -- this plan WILL grow during implementation, " +
      "so every piece of fat needs to be identified now.",
    focusAreas: [
      "Scope creep",
      "Gold plating",
      "YAGNI violations",
      "Over-abstraction",
      "Premature optimization",
      "Unnecessary dependencies",
    ],
    severity: "major",
  },
  {
    id: "integration",
    name: "Integration Tester",
    attackVector:
      "Cross-module fragility, missing interfaces, data flow gaps, contract mismatches",
    instruction:
      "Attack this plan for missing connections between components. Trace every data flow: " +
      "where does data enter, transform, and exit? What interfaces are implied but not specified? " +
      "What happens at module boundaries when data shapes change? What contracts are missing? " +
      "If you assembled all components described in this plan, where would they fail to connect? " +
      "Don't assume things 'just work' -- demand explicit contracts.",
    focusAreas: [
      "Interface gaps",
      "Data flow tracing",
      "API contracts",
      "State sharing",
      "Error propagation",
      "Module coupling",
    ],
    severity: "critical",
  },
  {
    id: "sentinel",
    name: "Sentinel",
    attackVector:
      "Security vulnerabilities, error states, boundary conditions, operational fragility",
    instruction:
      "Attack this plan for what it FORGOT. Systematically enumerate: What null/empty/missing " +
      "states are unhandled? What happens on every failure path -- does it crash silently, " +
      "corrupt data, or give a clear error? What boundary conditions exist (max inputs, timeouts, " +
      "concurrent access)? What security surfaces are exposed? What operational concerns are " +
      "missing (logging, monitoring, rollback, backup)? Attack every unstated assumption.",
    focusAreas: [
      "Error states",
      "Null/empty/missing",
      "Boundary conditions",
      "Security surfaces",
      "Race conditions",
      "Operational readiness",
      "Rollback strategy",
    ],
    severity: "critical",
  },
  {
    id: "architect",
    name: "Architectural Strategist",
    attackVector:
      "Wrong abstractions, pattern mismatches, tech debt accumulation, scalability ceilings",
    instruction:
      "Attack this plan's architectural decisions. Are the chosen abstractions right for this " +
      "problem? What patterns are being used and do they actually fit? What tech debt is being " +
      "deliberately (or accidentally) created? What will need to be rewritten in 6 months? " +
      "Where are the scalability ceilings? Is the architecture flexible enough for likely " +
      "future requirements, or too flexible (over-engineered)? Name the specific design " +
      "decisions that will cause pain.",
    focusAreas: [
      "Design pattern fit",
      "Abstraction boundaries",
      "Tech debt identification",
      "Extensibility",
      "Scalability",
      "Architectural consistency",
    ],
    severity: "major",
  },
  {
    id: "humanist",
    name: "Humanist",
    attackVector:
      "Developer experience, user experience, cognitive load, accessibility, onboarding friction",
    instruction:
      "Attack this plan from the human perspective -- both the developers who will build it and " +
      "the users who will interact with it. What parts of this plan create cognitive friction? " +
      "What would confuse a new team member? What would frustrate an end user on their first " +
      "attempt? Where are accessibility gaps? What error messages will users see and will they " +
      "understand them? How much context does someone need to hold in their head at once? " +
      "Good design feels invisible -- where does this plan force people to think too hard?",
    focusAreas: [
      "Developer onboarding",
      "User workflow friction",
      "Cognitive load",
      "Accessibility",
      "Error message quality",
      "Documentation gaps",
      "Progressive disclosure",
    ],
    severity: "major",
  },
]

// ---------------------------------------------------------------------------
// Complexity keywords -- signals that a plan is non-trivial
// ---------------------------------------------------------------------------

const COMPLEXITY_SIGNALS: Array<{ word: string; weight: number }> = [
  // Architecture and structure
  { word: "API", weight: 2 },
  { word: "database", weight: 2 },
  { word: "migration", weight: 2 },
  { word: "service", weight: 1 },
  { word: "component", weight: 1 },
  { word: "module", weight: 1 },
  { word: "integration", weight: 2 },
  { word: "interface", weight: 1 },
  { word: "protocol", weight: 1 },
  { word: "middleware", weight: 2 },
  { word: "pipeline", weight: 1 },
  { word: "plugin", weight: 1 },
  { word: "architecture", weight: 2 },
  { word: "data flow", weight: 2 },
  { word: "state", weight: 1 },
  { word: "store", weight: 1 },
  { word: "event", weight: 1 },

  // Concurrency and async
  { word: "async", weight: 2 },
  { word: "concurrent", weight: 2 },
  { word: "parallel", weight: 2 },
  { word: "race", weight: 3 },
  { word: "lock", weight: 2 },
  { word: "queue", weight: 1 },
  { word: "worker", weight: 1 },
  { word: "stream", weight: 1 },
  { word: "callback", weight: 1 },
  { word: "promise", weight: 1 },
  { word: "thread", weight: 2 },

  // Security
  { word: "auth", weight: 2 },
  { word: "oauth", weight: 3 },
  { word: "encrypt", weight: 2 },
  { word: "token", weight: 1 },
  { word: "session", weight: 1 },
  { word: "permission", weight: 2 },
  { word: "role", weight: 1 },
  { word: "audit", weight: 1 },
  { word: "ssrf", weight: 3 },
  { word: "xss", weight: 3 },
  { word: "sqli", weight: 3 },
  { word: "csp", weight: 2 },
  { word: "cors", weight: 1 },

  // Data
  { word: "transaction", weight: 2 },
  { word: "replication", weight: 3 },
  { word: "shard", weight: 3 },
  { word: "cache", weight: 1 },
  { word: "query", weight: 1 },
  { word: "index", weight: 1 },
  { word: "schema", weight: 1 },
  { word: "normalize", weight: 1 },
  { word: "denormalize", weight: 2 },

  // Networking
  { word: "network", weight: 1 },
  { word: "websocket", weight: 2 },
  { word: "http", weight: 1 },
  { word: "grpc", weight: 2 },
  { word: "rest", weight: 1 },
  { word: "rpc", weight: 1 },

  // Infrastructure
  { word: "deploy", weight: 1 },
  { word: "container", weight: 1 },
  { word: "kubernetes", weight: 2 },
  { word: "docker", weight: 1 },
  { word: "orchestrat", weight: 2 },
  { word: "config", weight: 1 },
  { word: "env", weight: 1 },

  // Complexity descriptors
  { word: "milestone", weight: 1 },
  { word: "phase", weight: 1 },
  { word: "cross-cut", weight: 2 },
  { word: "dependency", weight: 1 },
  { word: "complex", weight: 2 },
  { word: "multiple", weight: 1 },
  { word: "distributed", weight: 2 },
  { word: "microservice", weight: 3 },
  { word: "monolith", weight: 1 },
  { word: "legacy", weight: 1 },
  { word: "refactor", weight: 1 },
  { word: "handling", weight: 1 },
  { word: "edge case", weight: 1 },
  { word: "fallback", weight: 1 },
  { word: "retry", weight: 1 },
  { word: "timeout", weight: 1 },
  { word: "circuit break", weight: 2 },
  { word: "rate limit", weight: 2 },
  { word: "backpressure", weight: 3 },
]

// ---------------------------------------------------------------------------
// Complexity detection
// ---------------------------------------------------------------------------

export interface ComplexityAssessment {
  level: "trivial" | "moderate" | "complex"
  score: number
  reason: string
  signals: string[]
}

/**
 * Analyze a plan string for complexity signals.
 *
 * Heuristic:
 *   - Score < 3  -> trivial (single concern, low risk)
 *   - Score 3-8  -> moderate (may benefit from 2-3 angles)
 *   - Score > 8  -> complex (full 5-angle hyperplan recommended)
 */
export function assessComplexity(plan: string): ComplexityAssessment {
  const lower = plan.toLowerCase()
  const found: Array<{ word: string; weight: number }> = []

  for (const signal of COMPLEXITY_SIGNALS) {
    // Use word boundary matching -- the signal word, not a substring
    const escaped = signal.word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const regex = new RegExp(`\\b${escaped}\\b`, "i")
    if (regex.test(lower)) {
      found.push(signal)
    }
  }

  const totalScore = found.reduce((sum, s) => sum + s.weight, 0)
  const signals = [...new Set(found.map((s) => s.word))]

  // Also check for structural complexity (JSON milestones, numbered steps, etc.)
  const hasStructure =
    (plan.match(/\bmilestone\b/gi) || []).length > 0 ||
    (plan.match(/^#+\s+\d\./gm) || []).length > 0 ||
    (plan.match(/^[-\*]\s+\[/gm) || []).length > 0

  const structuralBoost = hasStructure ? 2 : 0
  const adjustedScore = totalScore + structuralBoost

  // Line count heuristic
  const lineCount = plan.split("\n").filter((l) => l.trim().length > 0).length
  const lengthBoost = lineCount > 30 ? 2 : lineCount > 15 ? 1 : 0
  const finalScore = adjustedScore + lengthBoost

  if (finalScore < 3) {
    return {
      level: "trivial",
      score: finalScore,
      reason:
        `Plan complexity score: ${finalScore}. ` +
        `Low signal density (${signals.length} complexity signals found). ` +
        `${lineCount} lines. This plan appears straightforward -- hyperplan is not needed.`,
      signals,
    }
  }

  if (finalScore <= 8) {
    return {
      level: "moderate",
      score: finalScore,
      reason:
        `Plan complexity score: ${finalScore}. ` +
        `Moderate signal density (${signals.length} complexity signals found). ` +
        `${lineCount} lines. This plan could benefit from 2-3 targeted adversarial perspectives.`,
      signals,
    }
  }

  return {
    level: "complex",
    score: finalScore,
    reason:
      `Plan complexity score: ${finalScore}. ` +
      `High signal density (${signals.length} complexity signals found). ` +
      `${lineCount} lines. Full 5-angle hyperplan recommended to surface hidden risks.`,
    signals,
  }
}

// ---------------------------------------------------------------------------
// Angle selection based on complexity
// ---------------------------------------------------------------------------

function selectAngles(
  level: ComplexityAssessment["level"],
  customIds?: string[],
): HyperplanAngle[] {
  // If custom angles specified, filter by ID
  if (customIds && customIds.length > 0) {
    const selected = DEFAULT_ANGLES.filter((a) => customIds.includes(a.id))
    if (selected.length > 0) return selected
    // Fall through to defaults if no custom IDs match
  }

  switch (level) {
    case "trivial":
      return [] // No angles -- skip hyperplan entirely
    case "moderate":
      // Return the 2 highest-severity angles: Integration + Sentinel (both "critical")
      return DEFAULT_ANGLES.filter((a) => a.severity === "critical")
    case "complex":
      return DEFAULT_ANGLES // All 5
    default:
      return DEFAULT_ANGLES
  }
}

// ---------------------------------------------------------------------------
// Subject matter enrichment
// ---------------------------------------------------------------------------

/**
 * Build the "context" section of a sub-agent prompt from the plan type.
 * Adds targeted questions based on what the plan appears to be about.
 */
function enrichContext(plan: string): string {
  const lower = plan.toLowerCase()
  const parts: string[] = []

  const hasAPI = /\bapi\b|\bendpoint\b|\broute\b|\bgraphql\b|\bgrpc\b/i.test(lower)
  const hasDB = /\bdatabase\b|\bsql\b|\bquery\b|\bschema\b|\btable\b|\bcache\b/i.test(lower)
  const hasUI = /\bui\b|\bcomponent\b|\brender\b|\bpage\b|\bview\b|\bwidget\b/i.test(lower)
  const hasAuth = /\bauth\b|\blogin\b|\bpermission\b|\brole\b|\buser\b/i.test(lower)
  const hasAsync = /\basync\b|\bconcurrent\b|\bparallel\b|\bevent\b|\bqueue\b|\bworker\b/i.test(lower)
  const hasNetwork = /\bnetwork\b|\bhttp\b|\bwebsocket\b|\brequest\b|\bfetch\b|\bstream\b/i.test(lower)

  if (hasAPI) {
    parts.push(
      "- API design: are endpoints RESTful, consistent, and versioned? Are error responses " +
        "structured? What happens on 429 (rate limit), 503 (unavailable), 504 (timeout)?",
    )
  }
  if (hasDB) {
    parts.push(
      "- Data layer: are migrations reversible? What happens to existing data on schema changes? " +
        "Are queries indexed? Connection pool sizing? Transaction isolation levels correct?",
    )
  }
  if (hasUI) {
    parts.push(
      "- UI: loading states, empty states, error states, edge case rendering " +
        "(overflow, missing data, slow network). Is the UX accessible? Keyboard navigable?",
    )
  }
  if (hasAuth) {
    parts.push(
      "- Security: authentication bypass vectors, session management, token rotation, " +
        "privilege escalation paths. Are permissions checked at every layer (not just UI)?",
    )
  }
  if (hasAsync) {
    parts.push(
      "- Concurrency: what happens under concurrent access? Race conditions, deadlocks, " +
        "stale reads. Are operations idempotent? Is ordering guaranteed?",
    )
  }
  if (hasNetwork) {
    parts.push(
      "- Network: what happens on transient failures? Retry with backoff? Circuit breaker? " +
        "Request timeout handling? Data integrity over unreliable connections?",
    )
  }

  if (parts.length === 0) {
    parts.push(
      "- General: what assumptions does this plan make that could be wrong? " +
        "What is NOT being said? What would surprise someone reading this plan?",
    )
  }

  return parts.join("\n")
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/**
 * Build a structured sub-agent prompt for one adversarial angle.
 */
function buildPrompt(
  plan: string,
  angle: HyperplanAngle,
  context: string,
): string {
  return [
    `# HYPERPLAN CRITIQUE -- ${angle.name}`,
    ``,
    `## Your Role`,
    `You are the ${angle.name}. Your sole purpose is to attack the plan below from `,
    `${angle.attackVector}. Be specific, be ruthless, be constructive.`,
    ``,
    `## Plan to Critique`,
    plan,
    ``,
    `## Your Attack Vector`,
    angle.instruction,
    ``,
    `## Focus Areas`,
    angle.focusAreas.map((a) => `- ${a}`).join("\n"),
    ``,
    `## Context`,
    context,
    ``,
    `## Output Format`,
    `Return your critique as a JSON object with these fields:`,
    `  {`,
    `    "angleId": "${angle.id}",`,
    `    "angleName": "${angle.name}",`,
    `    "findings": "Your detailed critique text...",`,
    `    "severity": "critical" | "major" | "minor",`,
    `    "affectedAreas": ["area1", "area2", ...],`,
    `    "selfCritique": "What is the WEAKNESS in your own critique? What did you miss?"`,
    `  }`,
    ``,
    `## Quality Rules`,
    `- Be SPECIFIC. Name files, functions, data structures. "This will break" is not enough.`,
    `- Be HONEST. If the plan handles something well, say so. Credibility matters.`,
    `- Be CONSTRUCTIVE. Every attack should include what to do instead.`,
    `- Include a "selfCritique" field -- acknowledge what your own blind spots might be.`,
    `- Keep findings focused on YOUR angle. Other angles will cover their own territory.`,
    ``,
    `## Red Line`,
    `If the plan is genuinely excellent in your domain, say so.`,
    `Hyperplan is about hardening, not performative criticism.`,
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Hyperplan Round Types -- multi-phase adversarial debate
// ---------------------------------------------------------------------------

export type HyperplanRound = "analysis" | "cross-attack" | "defense"

// ---------------------------------------------------------------------------
// Generate mode
// ---------------------------------------------------------------------------

/**
 * Generate adversarial critique prompts for a plan.
 *
 * Returns a HyperplanResult with:
 *   - complexity assessment
 *   - selected angles
 *   - structured prompts for each angle
 *
 * If complexity is "trivial" and force is false, returns skipped=true with
 * an explanation.
 */
export function generateHyperplan(
  plan: string,
  options?: {
    customAngles?: string[]
    force?: boolean
    extraContext?: string
  },
): HyperplanResult {
  const assessment = assessComplexity(plan)
  const context = enrichContext(plan)
  const extraCtx = options?.extraContext || ""
  const fullContext = [context, extraCtx].filter(Boolean).join("\n")

  // Skip trivial plans unless forced
  if (assessment.level === "trivial" && !options?.force) {
    return {
      complexity: "trivial",
      reason: assessment.reason,
      skipped: true,
      angles: [],
      prompts: [],
    }
  }

  // For moderate plans with custom angles specified, respect them
  const angles = selectAngles(assessment.level, options?.customAngles)

  if (angles.length === 0 && !options?.force) {
    return {
      complexity: assessment.level,
      reason:
        assessment.level === "moderate"
          ? "Moderate complexity but no angles selected."
          : assessment.reason,
      skipped: true,
      angles: [],
      prompts: [],
    }
  }

  // If force is true for trivial, use the minimum set
  const finalAngles =
    angles.length === 0 && options?.force
      ? DEFAULT_ANGLES.filter((a) => a.severity === "critical")
      : angles

  const prompts = finalAngles.map((angle) => ({
    angleId: angle.id,
    prompt: buildPrompt(plan, angle, fullContext),
  }))

  return {
    complexity: assessment.level,
    reason: assessment.reason,
    skipped: false,
    angles: finalAngles,
    prompts,
  }
}

// ---------------------------------------------------------------------------
// Synthesis mode
// ---------------------------------------------------------------------------

/**
 * Synthesize multiple critiques into a hardened plan.
 *
 * Analyzes all critiques, identifies surviving insights vs rejected critiques,
 * and produces an actionable synthesis. This function guides the agent toward
 * defensive plan revisions rather than doing the revision itself (since the
 * agent has context the tool doesn't).
 */
export function synthesizeCritiques(
  originalPlan: string,
  critiques: HyperplanCritique[],
): HyperplanSynthesis {
  if (critiques.length === 0) {
    return {
      confidence: 100,
      survivingInsights: [],
      rejectedCritiques: [],
      hardenedPlan: originalPlan,
      summary: "No critiques received. Plan unchanged.",
    }
  }

  // Group critiques by severity
  const critical = critiques.filter((c) => c.severity === "critical")
  const major = critiques.filter((c) => c.severity === "major")
  const minor = critiques.filter((c) => c.severity === "minor")

  // Calculate confidence score based on critique severity distribution
  // More critical findings = lower confidence in the plan
  const criticalPenalty = critical.length * 15
  const majorPenalty = major.length * 8
  const minorPenalty = minor.length * 3
  const confidence = Math.max(0, Math.min(100, 100 - criticalPenalty - majorPenalty - minorPenalty))

  // Build structured synthesis text for the agent to use
  const criticalLines = critical.map(
    (c) =>
      `[CRITICAL][${c.angleName}] ${c.findings}` +
      (c.affectedAreas.length > 0
        ? ` (Affects: ${c.affectedAreas.join(", ")})`
        : ""),
  )

  const majorLines = major.map(
    (c) =>
      `[MAJOR][${c.angleName}] ${c.findings}` +
      (c.affectedAreas.length > 0
        ? ` (Affects: ${c.affectedAreas.join(", ")})`
        : ""),
  )

  const minorLines = minor.map(
    (c) =>
      `[MINOR][${c.angleName}] ${c.findings}` +
      (c.affectedAreas.length > 0
        ? ` (Affects: ${c.affectedAreas.join(", ")})`
        : ""),
  )

  // Identify critique conflicts (same affected area, different or contradictory findings)
  const areaMap = new Map<string, string[]>()
  for (const c of critiques) {
    for (const area of c.affectedAreas) {
      if (!areaMap.has(area)) areaMap.set(area, [])
      areaMap.get(area)!.push(`${c.angleName}: ${c.findings.slice(0, 100)}`)
    }
  }
  const overlappingAreas: string[] = []
  for (const [area, findings] of areaMap) {
    if (findings.length > 1) {
      overlappingAreas.push(
        `Area "${area}" critiqued by ${findings.length} perspectives:\n` +
          findings.map((f) => `  - ${f}`).join("\n"),
      )
    }
  }

  const summary = [
    `## Hyperplan Synthesis`,
    ``,
    `**Confidence:** ${confidence}/100`,
    `**Critiques analyzed:** ${critiques.length} (${critical.length} critical, ${major.length} major, ${minor.length} minor)`,
    ``,
    critical.length > 0
      ? `**Must address (${critical.length} critical):**\n${criticalLines.map((l) => `- ${l}`).join("\n")}`
      : "**No critical findings.**",
    ``,
    major.length > 0
      ? `**Should address (${major.length} major):**\n${majorLines.map((l) => `- ${l}`).join("\n")}`
      : "**No major findings.**",
    ``,
    minor.length > 0
      ? `**Consider addressing (${minor.length} minor):**\n${minorLines.map((l) => `- ${l}`).join("\n")}`
      : "**No minor findings.**",
    ``,
    overlappingAreas.length > 0
      ? `**Overlapping concerns (multiple critics hit same area):**\n${overlappingAreas.join("\n\n")}`
      : "**No overlapping concerns.**",
    ``,
    `## Recommended Actions`,
    critical.length > 0
      ? `1. Address ALL ${critical.length} critical findings before execution.\n` +
        `2. Address at least the most impactful major findings.\n` +
        `3. Document any deferred items in decisions.jsonl.`
      : major.length > 0
        ? `1. Address the most impactful major findings.\n` +
          `2. Review minor findings for quick wins.\n` +
          `3. Proceed with heightened awareness of identified risks.`
        : `1. Minor findings only -- proceed with normal caution.\n` +
          `2. Flag any findings that resonate as design notes.`,
    ``,
    `## Cross-Critique Integrity Note`,
    `Each critic was instructed to include a "selfCritique" field acknowledging their own ` +
      `blind spots. When synthesizing, weigh critiques against each other: if one critic ` +
      `attacks from the left and another from the right, the truth is often somewhere in ` +
      `the middle. The overlapping concerns section above identifies areas where multiple ` +
      `critics independently converged -- these deserve highest priority.`,
  ].join("\n")

  return {
    confidence,
    survivingInsights: [...criticalLines, ...majorLines],
    rejectedCritiques: [],
    hardenedPlan: originalPlan, // Agent revises the actual plan; tool provides guidance
    summary,
  }
}

// ---------------------------------------------------------------------------
// Exported utilities
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Cross-Attack prompt generation (Round 2)
// ---------------------------------------------------------------------------

/**
 * Generate a cross-attack prompt for a single critic.
 *
 * In Round 2, each critic receives ALL findings from ALL other critics and
 * must attack every finding from their own adversarial perspective.
 * This surface disagreements, blind spots, and convergence/divergence points.
 */
export function generateCrossAttackPrompt(
  angle: HyperplanAngle,
  allFindings: Array<{ angleId: string; angleName: string; findings: string }>,
): string {
  // Filter out this critic's own findings -- they attack others
  const othersFindings = allFindings.filter((f) => f.angleId !== angle.id)

  const findingsBlock = othersFindings
    .map(
      (f) =>
        `### ${f.angleName}'s Findings:\n${f.findings
          .split("\n")
          .map((l) => `  ${l}`)
          .join("\n")}`,
    )
    .join("\n\n")

  return [
    `# HYPERPLAN ROUND 2 -- CROSS-ATTACK (${angle.name})`,
    ``,
    `## Your Role`,
    `You are the ${angle.name}. Your sole purpose is to ATTACK the findings below `,
    `from your adversarial perspective: ${angle.attackVector}`,
    ``,
    `## The Findings to Attack`,
    `Below are the Round 1 findings from the OTHER critics. Your job: `,
    `attack EVERY finding from your perspective. Be hostile. Be specific.`,
    ``,
    findingsBlock,
    ``,
    `## Your Weapons`,
    angle.focusAreas.map((a) => `- Attack findings related to: ${a}`).join("\n"),
    ``,
    `## Output Format`,
    `For EACH other critic's finding, produce:`,
    `  {`,
    `    "targetAngleId": "${othersFindings.map((f) => f.angleId).join('" or "')}",`,
    `    "targetFinding": "The specific claim you are attacking",`,
    `    "attack": "Your specific attack -- what is wrong, missing, or over-engineered",`,
    `    "severity": "critical" | "major" | "minor",`,
    `    "alternative": "What should be done instead (if applicable)"`,
    `  }`,
    ``,
    `## Rules`,
    `- Attack EVERY finding. Do not skip any.`,
    `- Be SPECIFIC. Name exact files, functions, data, or logic.`,
    `- If a finding is genuinely correct from your perspective, say "STANDS" and explain why.`,
    `- Default position: REJECT. Only concede when evidence forces you to.`,
    `- No collegial hedging. No "I see your point but". Direct attack only.`,
  ].join("\n")
}

/**
 * Generate cross-attack prompts for ALL critics given a bundle of findings.
 * Returns one prompt per critic for parallel dispatch.
 */
export function generateAllCrossAttacks(
  angles: HyperplanAngle[],
  allFindings: Array<{ angleId: string; angleName: string; findings: string }>,
): Array<{ angleId: string; prompt: string }> {
  return angles.map((angle) => ({
    angleId: angle.id,
    prompt: generateCrossAttackPrompt(angle, allFindings),
  }))
}

// ---------------------------------------------------------------------------
// Defense/Refinement prompt generation (Round 3)
// ---------------------------------------------------------------------------

/**
 * Generate a defense/refinement prompt for a single critic.
 *
 * In Round 3, each critic receives ONLY the attacks against THEIR OWN findings
 * and must DEFEND (rebut with evidence), REFINE (acknowledge and strengthen),
 * or CONCEDE (admit the finding is invalid) each point.
 */
export function generateDefensePrompt(
  angle: HyperplanAngle,
  attacksAgainst: Array<{
    targetFinding: string
    attackerName: string
    attack: string
    severity: string
  }>,
): string {
  const attacksBlock = attacksAgainst
    .map(
      (a, i) =>
        `Attack ${i + 1} from ${a.attackerName} [${a.severity.toUpperCase()}]:\n` +
        `  On: "${a.targetFinding}"\n` +
        `  Attack: "${a.attack}"`,
    )
    .join("\n\n")

  return [
    `# HYPERPLAN ROUND 3 -- DEFENSE & REFINEMENT (${angle.name})`,
    ``,
    `## Your Role`,
    `You are the ${angle.name}. Your Round 1 findings have been attacked by `,
    `the other critics. You must now DEFEND, REFINE, or CONCEDE each point.`,
    ``,
    `## Attacks Against Your Findings`,
    attacksBlock,
    ``,
    `## Your Response Format`,
    `For EACH attack against your findings, choose one response:`,
    ``,
    `  DEFEND: "This attack is wrong because [concrete evidence/reasoning]."`,
    `    Use when the attack missed the point or your finding is correct.`,
    ``,
    `  REFINE: "The attack landed. I restate my finding as [stronger version]."`,
    `    Use when the attack exposed a weakness but the core concern is valid.`,
    ``,
    `  CONCEDE: "I was wrong. [What survives, if anything?]"`,
    `    Use when the attack fully defeats your finding. Pride is the enemy.`,
    ``,
    `Output as JSON array:`,
    `  [{`,
    `    "response": "DEFEND" | "REFINE" | "CONCEDE",`,
    `    "targetAttack": "The attack you are responding to",`,
    `    "reasoning": "Your justification -- be specific",`,
    `    "revisedFinding": "If REFINE or CONCEDE, what survives. If DEFEND, null"`,
    `  }]`,
    ``,
    `## Rules`,
    `- Be HONEST. Wrong is wrong. Concede when defeated.`,
    `- Be PRECISE. "This is wrong" is not enough. "This is wrong because line 47 of X.ts "`,
    `  shows the opposite behavior" is.`,
    `- Pride is the enemy of good planning. Only defensible positions survive.`,
    `- If you DEFEND, your evidence must be concrete -- no "I believe" or "I think".`,
    `- If you REFINE, the revised version must be stronger than the original.`,
    `- If you CONCEDE, state what (if anything) survives from the original finding.`,
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Enhanced insight bundle synthesis
// ---------------------------------------------------------------------------

export interface InsightBundle {
  hardConstraints: string[]
  decisionsMade: string[]
  risksAndMitigations: Array<{ risk: string; mitigation: string }>
  openQuestions: string[]
  adversarialProvenance: Record<string, number>
  confidenceScore: number
}

/**
 * Produce an insight bundle from a full multi-round hyperplan.
 * Uses the 4-category structure from the hyperplan protocol:
 * Hard Constraints, Decisions Made, Risks & Mitigations, Open Questions.
 */
export function buildInsightBundle(
  originalPlan: string,
  round1Critiques: HyperplanCritique[],
  round3Defenses?: Array<{
    angleId: string
    responses: Array<{
      response: "DEFEND" | "REFINE" | "CONCEDE"
      reasoning: string
      revisedFinding?: string
    }>
  }>,
): InsightBundle {
  // Calculate confidence based on survived critiques
  const criticalCount = round1Critiques.filter((c) => c.severity === "critical").length
  const majorCount = round1Critiques.filter((c) => c.severity === "major").length

  // If defenses exist, only conceded findings reduce count
  let effectiveCritical = criticalCount
  let effectiveMajor = majorCount
  if (round3Defenses) {
    for (const defense of round3Defenses) {
      for (const r of defense.responses) {
        if (r.response === "CONCEDE") {
          effectiveCritical = Math.max(0, effectiveCritical - 1)
        }
      }
    }
  }

  const confidenceScore = Math.max(
    0,
    Math.min(100, 100 - effectiveCritical * 15 - effectiveMajor * 8),
  )

  // Extract findings into the 4 categories
  const hardConstraints: string[] = []
  const decisionsMade: string[] = []
  const risksAndMitigations: Array<{ risk: string; mitigation: string }> = []
  const openQuestions: string[] = []

  for (const c of round1Critiques) {
    if (c.severity === "critical") {
      hardConstraints.push(
        `[${c.angleName}] ${c.findings}` +
          (c.affectedAreas.length > 0 ? ` (Affects: ${c.affectedAreas.join(", ")})` : ""),
      )
      risksAndMitigations.push({
        risk: `[${c.angleName}] ${c.findings.slice(0, 200)}`,
        mitigation: "Must be addressed before execution -- see synthesis for details.",
      })
    } else if (c.severity === "major") {
      decisionsMade.push(
        `[${c.angleName}] ${c.findings}` +
          (c.affectedAreas.length > 0 ? ` (Affects: ${c.affectedAreas.join(", ")})` : ""),
      )
    } else {
      openQuestions.push(
        `[${c.angleName}] ${c.findings}`,
      )
    }
  }

  // Track how many findings survived from each angle
  const provenance: Record<string, number> = {}
  for (const c of round1Critiques) {
    provenance[c.angleName] = (provenance[c.angleName] || 0) + 1
  }

  return {
    hardConstraints,
    decisionsMade,
    risksAndMitigations,
    openQuestions,
    adversarialProvenance: provenance,
    confidenceScore,
  }
}

// ---------------------------------------------------------------------------
// Enhanced synthesis using insight bundle
// ---------------------------------------------------------------------------

/**
 * Enhanced version of synthesizeCritiques that produces the 4-category
 * insight bundle format. Replaces the original synthesizeCritiques for
 * multi-round hyperplan workflows.
 */
export function synthesizeInsightBundle(
  originalPlan: string,
  round1Critiques: HyperplanCritique[],
): string {
  const bundle = buildInsightBundle(originalPlan, round1Critiques)

  const criticalCount = round1Critiques.filter((c) => c.severity === "critical").length
  const majorCount = round1Critiques.filter((c) => c.severity === "major").length
  const minorCount = round1Critiques.filter((c) => c.severity === "minor").length

  const provenanceLines = Object.entries(bundle.adversarialProvenance)
    .map(([name, count]) => `- ${name}: ${count} finding(s) that survived`)
    .join("\n")

  const riskLines = bundle.risksAndMitigations
    .map((r) => `- RISK: ${r.risk}\n  MITIGATION: ${r.mitigation}`)
    .join("\n\n")

  return [
    `## Hyperplan Insight Bundle`,
    ``,
    `**Confidence Score:** ${bundle.confidenceScore}/100`,
    `**Critiques analyzed:** ${round1Critiques.length} (${criticalCount} critical, ${majorCount} major, ${minorCount} minor)`,
    ``,
    `### Hard Constraints (Must Respect)`,
    bundle.hardConstraints.length > 0
      ? bundle.hardConstraints.map((c) => `- ${c}`).join("\n")
      : "No hard constraints identified.",
    ``,
    `### Decisions Made (Converged Through Analysis)`,
    bundle.decisionsMade.length > 0
      ? bundle.decisionsMade.map((d) => `- ${d}`).join("\n")
      : "No decisions explicitly converged during analysis.",
    ``,
    `### Risks & Mitigations`,
    bundle.risksAndMitigations.length > 0
      ? riskLines
      : "No significant risks identified.",
    ``,
    `### Open Questions (Unresolved)`,
    bundle.openQuestions.length > 0
      ? bundle.openQuestions.map((q) => `- ${q}`).join("\n")
      : "No open questions remaining.",
    ``,
    `### Adversarial Provenance`,
    provenanceLines || "No findings survived from any critic.",
    ``,
    `## Synthesis Summary`,
    `Confidence ${bundle.confidenceScore}/100. ` +
      (criticalCount > 0
        ? `${criticalCount} critical constraints identified that must be resolved before execution.`
        : "No critical blockers.") +
      ` ${majorCount} major considerations documented.` +
      (minorCount > 0 ? ` ${minorCount} minor points noted.` : ""),
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Exported utilities
// ---------------------------------------------------------------------------

export { DEFAULT_ANGLES, COMPLEXITY_SIGNALS }
