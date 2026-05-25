// src/plugin.ts
import { tool } from "@opencode-ai/plugin";
import { readFileSync as readFileSync2, writeFileSync as writeFileSync2, existsSync as existsSync3 } from "fs";
import { homedir } from "os";
import { join as join3 } from "path";

// src/detect.ts
import { existsSync, statSync } from "fs";
function detectProject() {
  try {
    if (existsSync("Cargo.toml")) return "cargo";
    if (existsSync("package.json")) {
      if (existsSync("node_modules") && statSync("node_modules").isDirectory()) {
        if (existsSync("tsconfig.json")) return "tsc";
        return "lint";
      }
    }
    if (existsSync("pyproject.toml") || existsSync("requirements.txt")) return "python";
    return null;
  } catch {
    return null;
  }
}
function getVerifyCommand() {
  switch (detectProject()) {
    case "cargo":
      return "cargo check --color=never --all-targets --all-features 2>&1";
    case "tsc":
      return "npx tsc --noEmit 2>&1";
    case "lint":
      return "npm run lint 2>&1";
    case "python":
      return "python -m compileall -q . 2>&1";
    default:
      return null;
  }
}
function runVerify() {
  try {
    const cmd = getVerifyCommand();
    if (!cmd) return null;
    const shell = process.platform === "win32" ? "cmd" : "sh";
    const flag = process.platform === "win32" ? "/C" : "-c";
    const proc = Bun.spawnSync([shell, flag, cmd], { cwd: process.cwd() });
    const stdout = proc.stdout.toString();
    const stderr = proc.stderr.toString();
    const combined = stderr ? `${stdout}
${stderr}` : stdout;
    return { exitCode: proc.exitCode, stdout, stderr, combined };
  } catch (e) {
    return { exitCode: -1, stdout: "", stderr: String(e), combined: String(e) };
  }
}

// src/trace.ts
import { existsSync as existsSync2, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync as statSync2 } from "fs";
import { join } from "path";
var TRACE_DIR_RELATIVE = join(".parallax", "traces");
var TRACE_SCHEMA_VERSION = "1.0";
var traceStore = /* @__PURE__ */ new Map();
function getTrace(sessionId2) {
  if (!traceStore.has(sessionId2)) {
    traceStore.set(sessionId2, createEmptyTrace(sessionId2));
  }
  return traceStore.get(sessionId2);
}
function createEmptyTrace(sessionId2) {
  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    session: {
      id: sessionId2,
      agent: "parallax",
      agentVersion: "0.2.0",
      startedAt: (/* @__PURE__ */ new Date()).toISOString(),
      endedAt: null,
      project: null,
      projectType: null
    },
    phases: [],
    writes: [],
    metrics: null,
    coherenceScore: null
  };
}
function initTrace(sessionId2, project, projectType) {
  const trace = getTrace(sessionId2);
  trace.session.project = project;
  trace.session.projectType = projectType;
}
function addPhase(sessionId2, phase, data = {}) {
  const trace = getTrace(sessionId2);
  const record = {
    phase,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    data
  };
  trace.phases.push(record);
}
function addWrite(sessionId2, file, verification, frictionRetriesLeft) {
  const trace = getTrace(sessionId2);
  const record = {
    file,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    verification,
    frictionRetriesLeft
  };
  trace.writes.push(record);
}
function computeMetrics(trace) {
  const started = new Date(trace.session.startedAt).getTime();
  const now = Date.now();
  const durationSeconds = Math.round((now - started) / 1e3);
  const totalWrites = trace.writes.length;
  const totalWritesWithData = trace.writes.filter((w) => w.verification !== "unknown").length;
  const passes = trace.writes.filter((w) => w.verification === "pass").length;
  const firstPass = trace.writes.filter(
    (w) => w.verification === "pass" && w.frictionRetriesLeft >= 3
  ).length;
  const totalFrictionRetries = trace.writes.reduce(
    (sum, w) => sum + (3 - w.frictionRetriesLeft),
    0
  );
  const requiredPhases = [
    "ambiguity_check",
    "four_invariants",
    "verification_gate",
    "commit_decision",
    "summary"
  ];
  const uniqueRequiredPhases = new Set(
    trace.phases.filter((p) => requiredPhases.includes(p.phase)).map((p) => p.phase)
  );
  return {
    durationSeconds,
    totalPhases: trace.phases.length,
    totalWrites,
    verificationPassRate: totalWritesWithData > 0 ? passes / totalWritesWithData : 0,
    firstAttemptPassRate: totalWrites > 0 ? firstPass / totalWrites : 0,
    totalFrictionRetries,
    protocolStepsCompleted: uniqueRequiredPhases.size
  };
}
function finalizeTrace(sessionId2) {
  const trace = getTrace(sessionId2);
  trace.session.endedAt = (/* @__PURE__ */ new Date()).toISOString();
  trace.metrics = computeMetrics(trace);
  return trace;
}
function getTraceDir() {
  const dir = join(process.cwd(), TRACE_DIR_RELATIVE);
  if (!existsSync2(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}
function exportTrace(sessionId2, pretty = false) {
  const trace = finalizeTrace(sessionId2);
  const dir = getTraceDir();
  const filePath = join(dir, `${sessionId2}.json`);
  const json = pretty ? JSON.stringify(trace, null, 2) : JSON.stringify(trace);
  writeFileSync(filePath, json, "utf8");
  return filePath;
}

// src/score.ts
import { join as join2 } from "path";
var REQUIRED_PHASES = [
  "ambiguity_check",
  "four_invariants",
  "verification_gate",
  "commit_decision",
  "summary"
];
var PHASE_ORDER = [
  "ambiguity_check",
  "four_invariants",
  "verification_gate",
  "mode_switch",
  "execution",
  "commit_decision",
  "summary"
];
function computeCoherenceScore(trace) {
  const phaseNames = new Set(trace.phases.map((p) => p.phase));
  const completed = REQUIRED_PHASES.filter((r) => phaseNames.has(r)).length;
  const protocolCoverage = Math.round(completed / REQUIRED_PHASES.length * 30);
  let verificationIntegrity = 0;
  const writesWithData = trace.writes.filter((w) => w.verification !== "unknown");
  if (writesWithData.length > 0) {
    const firstPass = writesWithData.filter(
      (w) => w.verification === "pass" && w.frictionRetriesLeft >= 3
    ).length;
    verificationIntegrity = Math.round(firstPass / writesWithData.length * 35);
  }
  const analyzePhases = trace.phases.filter(
    (p) => p.phase === "mode_switch" && p.data && typeof p.data.analysisTopic === "string"
  );
  const edgeCategories = new Set(
    analyzePhases.map((p) => p.data.analysisTopic)
  );
  const edgeCaseCoverage = Math.min(Math.round(edgeCategories.size / 7 * 20), 20);
  let inOrder = 0;
  let lastIdx = -1;
  for (const phase of trace.phases) {
    const idx = PHASE_ORDER.indexOf(phase.phase);
    if (idx > lastIdx) {
      inOrder++;
      lastIdx = idx;
    }
  }
  const timingDiscipline = Math.min(
    Math.round(inOrder / REQUIRED_PHASES.length * 15),
    15
  );
  const total = Math.min(protocolCoverage + verificationIntegrity + edgeCaseCoverage + timingDiscipline, 100);
  return {
    total,
    protocolCoverage,
    verificationIntegrity,
    edgeCaseCoverage,
    timingDiscipline
  };
}
var SCORES_DIR = ".parallax";
var SCORES_FILE = join2(SCORES_DIR, "scores.jsonl");

// src/plugin.ts
var MAX_FRICTION_RETRIES = 3;
var CHECK_DEBOUNCE_MS = 1e3;
var STATE_DEBOUNCE_MS = 100;
var CONFIG_DIR = join3(homedir(), ".config", "opencode");
var STATE_FILE = join3(".parallax", "state.json");
var CONFIG_FILE = join3(".parallax", "config.json");
var frictionStore = /* @__PURE__ */ new Map();
var modeStore = /* @__PURE__ */ new Map();
var protocolStore = /* @__PURE__ */ new Map();
var currentSessionId = null;
var currentAgentName = null;
var PROTOCOL_KEY = "current";
function sessionId() {
  return PROTOCOL_KEY;
}
function getFriction(s = sessionId()) {
  if (!frictionStore.has(s)) {
    frictionStore.set(s, {
      successes: 0,
      trials: 0,
      retriesLeft: MAX_FRICTION_RETRIES,
      lastObservation: null
    });
  }
  return frictionStore.get(s);
}
function getMode(s = sessionId()) {
  if (!modeStore.has(s)) {
    modeStore.set(s, { mode: "free" });
  }
  return modeStore.get(s);
}
function getProtocol(s = sessionId()) {
  if (!protocolStore.has(s)) {
    protocolStore.set(s, {
      ambiguityDone: false,
      invariantsDone: false,
      gateDone: false,
      designDone: false,
      commitDone: false,
      summaryDone: false,
      writesBeforeGate: 0,
      gateBlocked: false
    });
  }
  return protocolStore.get(s);
}
var configCache = null;
var configCacheLoaded = false;
function loadConfig() {
  if (configCacheLoaded) return configCache || {};
  configCacheLoaded = true;
  try {
    if (existsSync3(CONFIG_FILE)) {
      const raw = readFileSync2(CONFIG_FILE, "utf8");
      configCache = JSON.parse(raw);
    }
  } catch {
  }
  return configCache || {};
}
var stateDebounceTimer = null;
function flushState() {
  try {
    const s = getFriction();
    const m = getMode();
    const p = getProtocol();
    const trace = getTrace(sessionId());
    const state = {
      sessionId: "current",
      sessionStart: trace.session.startedAt,
      mode: m.mode,
      friction: {
        successes: s.successes,
        trials: s.trials,
        retriesLeft: s.retriesLeft,
        lastObservation: s.lastObservation
      },
      protocol: {
        ambiguityDone: p.ambiguityDone,
        invariantsDone: p.invariantsDone,
        gateDone: p.gateDone,
        designDone: p.designDone,
        commitDone: p.commitDone,
        summaryDone: p.summaryDone,
        writesBeforeGate: p.writesBeforeGate,
        gateBlocked: p.gateBlocked
      }
    };
    const json = JSON.stringify(state, null, 2);
    writeFileSync2(STATE_FILE, json, "utf8");
  } catch {
  }
}
function writeState(immediate = false) {
  if (immediate) {
    flushState();
    return;
  }
  if (stateDebounceTimer) clearTimeout(stateDebounceTimer);
  stateDebounceTimer = setTimeout(() => {
    stateDebounceTimer = null;
    try {
      const s = getFriction();
      const m = getMode();
      const diskState = readProtocolFromDisk();
      const p = diskState || getProtocol();
      const state = {
        sessionId: "current",
        sessionStart: getTrace(sessionId()).session.startedAt,
        mode: m.mode,
        friction: {
          successes: s.successes,
          trials: s.trials,
          retriesLeft: s.retriesLeft,
          lastObservation: s.lastObservation
        },
        protocol: {
          ambiguityDone: p.ambiguityDone,
          invariantsDone: p.invariantsDone,
          gateDone: p.gateDone,
          designDone: p.designDone,
          commitDone: p.commitDone,
          summaryDone: p.summaryDone,
          writesBeforeGate: p.writesBeforeGate,
          gateBlocked: p.gateBlocked
        }
      };
      writeFileSync2(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
    } catch {
    }
  }, STATE_DEBOUNCE_MS);
}
function readProtocolFromDisk() {
  try {
    if (existsSync3(STATE_FILE)) {
      const raw = readFileSync2(STATE_FILE, "utf8");
      const s = JSON.parse(raw);
      if (s && s.protocol) {
        return {
          ambiguityDone: s.protocol.ambiguityDone === true,
          invariantsDone: s.protocol.invariantsDone === true,
          gateDone: s.protocol.gateDone === true,
          designDone: s.protocol.designDone === true,
          commitDone: s.protocol.commitDone === true,
          summaryDone: s.protocol.summaryDone === true,
          writesBeforeGate: typeof s.protocol.writesBeforeGate === "number" ? s.protocol.writesBeforeGate : 0,
          gateBlocked: s.protocol.gateBlocked === true
        };
      }
    }
  } catch {
  }
  return null;
}
var skillCache = {};
function loadSkill(name) {
  if (name in skillCache) return skillCache[name];
  const path = join3(CONFIG_DIR, "skills", name, "SKILL.md");
  try {
    const raw = readFileSync2(path, "utf8");
    skillCache[name] = raw.replace(/^---[\s\S]*?---\n*/, "");
  } catch {
    skillCache[name] = null;
  }
  return skillCache[name];
}
function truncate(s, maxLen) {
  if (!s || s.length <= maxLen) return s || "";
  return s.slice(0, maxLen) + `
[Truncated at ${maxLen} chars]`;
}
var STEP_LABELS = {
  ambiguity: "Ambiguity Check",
  invariants: "4 Invariants",
  gate: "Verification Gate",
  design: "Design Doc",
  commit: "Commit Decision",
  summary: "Summarize"
};
var MODE_META = {
  free: { skill: null, label: null },
  build: { skill: null, label: "PARALLAX BUILD MODE" },
  plan: { skill: "parallax-plan", label: "PARALLAX PLAN MODE" },
  debug: { skill: "parallax-debug", label: "PARALLAX DEBUG MODE" }
};
var debounceTimer = null;
var plugin_default = {
  id: "parallax-engine",
  server: async ({ client }) => {
    return {
      // -----------------------------------------------------------------------
      // Custom tools
      // -----------------------------------------------------------------------
      tool: {
        // VERIFY
        parallax_verify: tool({
          description: "Run the project's verification command (cargo check, tsc, npm run lint, python compileall) and return the result. Use this instead of running checks manually via bash.",
          args: {},
          async execute() {
            const result = runVerify();
            if (!result) {
              return "[parallax] No known project type -- skipping verification.";
            }
            if (result.exitCode === 0) {
              return `[parallax] VERIFICATION PASSED (exit 0)
${truncate(result.stdout, 500)}`;
            }
            return `[parallax] VERIFICATION FAILED (exit ${result.exitCode})
${truncate(result.combined, 2e3)}`;
          }
        }),
        // ANALYZE
        parallax_analyze: tool({
          description: "Run structured Parallax multi-perspective analysis on a specific component or change. Surfaces edge cases, cross-cutting concerns, and verification criteria before you write code.",
          args: {
            topic: tool.schema.string().describe(
              "The component, module, function, or change to analyze"
            )
          },
          async execute(args) {
            addPhase(sessionId(), "mode_switch", { analysisTopic: args.topic });
            return `[parallax] ANALYSIS FRAMEWORK: ${args.topic}

Apply these questions to "${args.topic}":

NOMINAL CASE -- What does success look like for ${args.topic}?

EDGE CASES:
- Empty states / null / missing inputs
- Boundary conditions / overflow
- Error states / failure paths
- Concurrency / race conditions
- State transitions / interruption safety
- Security (injection, credential exposure, path traversal)
- Backward compatibility (migrations, deprecation)

CROSS-CUTTING:
- Error handling: does every failure path produce a clear message?
- Observability: can we trace what happened?
- Performance: hot paths, O(n^2), memory leaks
- Testability: how would each component be tested?
- Rollback: if this fails, how do we undo it?

Use grep and read to investigate ${args.topic} in the codebase, then proceed with the Parallax protocol.`;
          }
        }),
        // CHECKIN -- protocol step tracking with ordering enforcement
        parallax_checkin: tool({
          description: "Mark a protocol step as complete. The plugin tracks this to enforce the protocol order. Call this after completing each step.",
          args: {
            step: tool.schema.string().describe(
              "The protocol step to mark complete: ambiguity, invariants, gate, design, commit, summary"
            )
          },
          async execute(args) {
            const p = getProtocol();
            const step = args.step;
            if (!STEP_LABELS[step]) {
              return `[parallax] Unknown step "${step}". Valid: ${Object.keys(STEP_LABELS).join(", ")}`;
            }
            const sid = sessionId();
            const cfg = loadConfig();
            if (step === "ambiguity" && !p.ambiguityDone) {
              p.ambiguityDone = true;
              addPhase(sid, "ambiguity_check");
              writeState(true);
              return "[parallax] Step 1/6: Ambiguity Check marked complete.";
            }
            if (step === "invariants") {
              if (!p.ambiguityDone) {
                return "[parallax] ERROR: Complete Ambiguity Check first (Step 1).";
              }
              p.invariantsDone = true;
              addPhase(sid, "four_invariants");
              writeState(true);
              return "[parallax] Step 2/6: 4 Invariants marked complete.";
            }
            if (step === "gate") {
              if (!p.invariantsDone) {
                return "[parallax] ERROR: Complete 4 Invariants first (Step 2).";
              }
              p.gateDone = true;
              addPhase(sid, "verification_gate");
              writeState(true);
              return "[parallax] Step 3/6: Verification Gate marked complete.";
            }
            if (step === "design") {
              if (!p.gateDone && cfg.designDocRequired) {
                return "[parallax] ERROR: Complete Verification Gate first (Step 3).";
              }
              p.designDone = true;
              addPhase(sid, "design_check");
              writeState(true);
              return "[parallax] Step 4/6: Design Doc marked complete.";
            }
            if (step === "commit") {
              p.commitDone = true;
              addPhase(sid, "commit_decision");
              writeState(true);
              return "[parallax] Step 5/6: Commit Decision marked complete.";
            }
            if (step === "summary") {
              p.summaryDone = true;
              addPhase(sid, "summary");
              writeState(true);
              const trace = getTrace(sid);
              const breakdown = computeCoherenceScore(trace);
              const s = getFriction();
              const passCount = trace.writes.filter((w) => w.verification === "pass").length;
              const failCount = trace.writes.filter((w) => w.verification === "fail").length;
              const retrospective = [
                `[parallax] Step 6/6: Summary marked complete. Protocol finished.`,
                ``,
                `## Session Retrospective`,
                ``,
                `**What was built:** ${trace.writes.length} writes across ${trace.phases.length} phases`,
                `**Verification:** ${passCount} passed, ${failCount} failed`,
                `**Coherence Score:** ${breakdown.total}/100`,
                `**Friction:** ${s.successes} ok / ${s.trials} trials, ${s.retriesLeft} retries remaining`,
                ``,
                `**Review Focus:**`,
                failCount > 0 ? `- ${failCount} verification failures -- review the failed files` : `- No verification failures`,
                breakdown.total < 60 ? `- Low coherence score (${breakdown.total}/100) -- protocol steps may have been skipped` : ``,
                breakdown.edgeCaseCoverage < 10 ? `- Low edge case coverage (${breakdown.edgeCaseCoverage}/20) -- consider running parallax_analyze on critical paths` : ``
              ].filter(Boolean).join("\n");
              return retrospective;
            }
            if (p[`${step}Done`]) {
              return `[parallax] Step "${step}" was already completed.`;
            }
            return `[parallax] Unknown step state for "${step}".`;
          }
        }),
        // MODE: PLAN
        parallax_plan: tool({
          description: "Switch to PLAN mode. Injects the Precision Architect skill for deep requirements elicitation and structured planning. Best for Phase 1-3 of the protocol. Use this when you need to fully spec out a feature before building.",
          args: {},
          async execute() {
            getMode().mode = "plan";
            addPhase(sessionId(), "mode_switch", { mode: "plan" });
            writeState();
            return "[parallax] PLAN mode activated. Precision Architect skill loaded. Elicit requirements fully before building.";
          }
        }),
        // MODE: BUILD
        parallax_build: tool({
          description: "Switch to BUILD mode (default). Standard Parallax execution protocol. Best for Phase 4-5 execution work. Use this when you have a clear plan and need to write code.",
          args: {},
          async execute() {
            getMode().mode = "build";
            addPhase(sessionId(), "mode_switch", { mode: "build" });
            writeState();
            return "[parallax] BUILD mode activated. Standard Parallax execution protocol. Write clean code, verify with parallax_verify.";
          }
        }),
        // MODE: DEBUG
        parallax_debug: tool({
          description: "Switch to DEBUG mode. Injects the Universal Auditor skill for comprehensive post-build audit. Best for Phase 6 review. Use this after building to audit quality, security, and correctness.",
          args: {},
          async execute() {
            getMode().mode = "debug";
            addPhase(sessionId(), "mode_switch", { mode: "debug" });
            writeState();
            return "[parallax] DEBUG mode activated. Universal Auditor skill loaded. Run a full audit pass.";
          }
        }),
        // TRACE EXPORT -- export current session trace to file
        parallax_trace_export: tool({
          description: "Export the current session's structured reasoning trace to a JSON file. Traces capture protocol phases, writes, verifications, and coherence score. Use --pretty for human-readable formatting.",
          args: {
            pretty: tool.schema.boolean().optional().describe(
              "Format output with indentation for human readability"
            )
          },
          async execute(args) {
            const sid = sessionId();
            const pretty = args.pretty === true;
            const filePath = exportTrace(sid, pretty);
            const trace = getTrace(sid);
            const breakdown = computeCoherenceScore(trace);
            trace.coherenceScore = breakdown.total;
            return `[parallax] Trace exported: ${filePath}
Session: ${sid}
Phases: ${trace.phases.length}, Writes: ${trace.writes.length}
Coherence Score: ${breakdown.total}/100`;
          }
        }),
        // TRACE PR COMMENT -- generates markdown for PR description (Phase 1.1)
        parallax_trace_pr_comment: tool({
          description: "Generate a formatted markdown summary of the current session trace suitable for pasting into a GitHub PR comment. Shows coherence score, protocol phases completed, write verification summary, and friction stats. The AI should call this at session end and paste the output into the PR.",
          args: {},
          async execute() {
            const sid = sessionId();
            const trace = getTrace(sid);
            const breakdown = computeCoherenceScore(trace);
            const s = getFriction();
            if (trace.writes.length === 0) {
              return `## Parallax Trace -- Planning Session

**Session:** ${sid}
**Protocol Steps:** ${trace.phases.length} phases recorded
**Coherence Score:** ${breakdown.total}/100

*No code was written in this session.*`;
            }
            const passCount = trace.writes.filter((w) => w.verification === "pass").length;
            const failCount = trace.writes.filter((w) => w.verification === "fail").length;
            const passRate = trace.writes.length > 0 ? Math.round(passCount / trace.writes.length * 100) : 0;
            const phaseTimeline = trace.phases.filter((p) => p.phase !== "execution" && p.phase !== "mode_switch").map((p) => {
              const label = p.phase.replace(/_/g, " ");
              return `- [x] ${label} (${p.timestamp.slice(11, 19)})`;
            }).join("\n");
            const writeSummary = trace.writes.slice(0, 20).map((w) => {
              const icon = w.verification === "pass" ? "[OK]" : w.verification === "fail" ? "[FAIL]" : "[SKIP]";
              const file = w.file.length > 60 ? "..." + w.file.slice(-57) : w.file;
              return `- ${icon} \`${file}\``;
            }).join("\n");
            const more = trace.writes.length > 20 ? `
*...and ${trace.writes.length - 20} more writes*
` : "";
            return [
              `## Parallax Trace`,
              ``,
              `| Metric | Value |`,
              `|---|---|`,
              `| **Coherence Score** | **${breakdown.total}/100** |`,
              `| Protocol Coverage | ${breakdown.protocolCoverage}/30 |`,
              `| Verification Integrity | ${breakdown.verificationIntegrity}/35 |`,
              `| Edge Case Coverage | ${breakdown.edgeCaseCoverage}/20 |`,
              `| Timing Discipline | ${breakdown.timingDiscipline}/15 |`,
              ``,
              `**Session:** \`${sid}\``,
              ``,
              `### Protocol Phases`,
              phaseTimeline,
              ``,
              `### Verification Summary`,
              `- ${passCount} passed, ${failCount} failed (${passRate}% pass rate)`,
              `- ${s.trials} trials, ${s.successes} successes`,
              `- Friction retries consumed: ${3 - s.retriesLeft}`,
              ``,
              `### Files Changed`,
              writeSummary,
              more,
              ``,
              `> Full trace: \`.parallax/traces/${sid}.json\``
            ].join("\n");
          }
        }),
        // TRACE VIEW -- inline trace viewer (Phase 1.2)
        parallax_trace_view: tool({
          description: "Show the current session's complete reasoning trace in the chat. Displays ambiguity assessment, 4 invariants analysis, verification gate results, every write with pass/fail status, commit decision, and summary. Use this when the user asks to see the trace.",
          args: {},
          async execute() {
            const sid = sessionId();
            const trace = getTrace(sid);
            const breakdown = computeCoherenceScore(trace);
            const s = getFriction();
            const p = getProtocol();
            const stepStatus = (done, label) => done ? `[DONE] ${label}` : `[PENDING] ${label}`;
            const writesList = trace.writes.length === 0 ? "*No writes recorded yet.*" : trace.writes.slice(-30).map((w) => {
              const icon = w.verification === "pass" ? "OK" : w.verification === "fail" ? "FAIL" : "SKIP";
              const file = w.file.length > 80 ? "..." + w.file.slice(-77) : w.file;
              return `  ${icon} | ${file} | retries left: ${w.frictionRetriesLeft}`;
            }).join("\n");
            const more = trace.writes.length > 30 ? `
  ... and ${trace.writes.length - 30} more writes (see full trace at .parallax/traces/${sid}.json)` : "";
            return [
              `## Parallax Session Trace`,
              `**Session:** \`${sid}\``,
              `**Mode:** ${getMode().mode.toUpperCase()}`,
              ``,
              `### Coherence Score: ${breakdown.total}/100`,
              `  Protocol Coverage:     ${breakdown.protocolCoverage}/30`,
              `  Verification Integrity: ${breakdown.verificationIntegrity}/35`,
              `  Edge Case Coverage:    ${breakdown.edgeCaseCoverage}/20`,
              `  Timing Discipline:     ${breakdown.timingDiscipline}/15`,
              ``,
              `### Protocol Progress`,
              `  ${stepStatus(p.ambiguityDone, "1. Ambiguity Check")}`,
              `  ${stepStatus(p.invariantsDone, "2. 4 Invariants")}`,
              `  ${stepStatus(p.gateDone, "3. Verification Gate")}`,
              `  ${stepStatus(p.designDone, "4. Design Doc (optional)")}`,
              `  ${stepStatus(p.commitDone, "5. Commit Decision")}`,
              `  ${stepStatus(p.summaryDone, "6. Summary")}`,
              ``,
              `### Friction`,
              `  Successes: ${s.successes} / Trials: ${s.trials}`,
              `  Retries remaining: ${s.retriesLeft}`,
              s.lastObservation ? `  Last error: ${s.lastObservation.slice(0, 200)}` : "",
              ``,
              `### Writes (last 30)`,
              writesList,
              more,
              ``,
              `> Full trace JSON: \`.parallax/traces/${sid}.json\``
            ].filter(Boolean).join("\n");
          }
        })
      },
      // -----------------------------------------------------------------------
      // Pre-write enforcement: protocol ordering + friction block
      // -----------------------------------------------------------------------
      "tool.execute.before": async (input) => {
        if (!["write", "edit", "apply_patch"].includes(input.tool)) return;
        const p = readProtocolFromDisk() || getProtocol();
        const cfg = loadConfig();
        if (!p.ambiguityDone) {
          throw new Error(
            `[parallax] PROTOCOL VIOLATION: Ambiguity Check (Step 1) not completed.
You MUST state HIGH/MEDIUM/LOW and ask clarifying questions before writing code.
Use parallax_checkin({ step: "ambiguity" }) after completing it.`
          );
        }
        if (cfg.designDocRequired && !p.designDone && p.invariantsDone && !process.env.PARALLAX_FORCE) {
          throw new Error(
            `[parallax] PROTOCOL VIOLATION: Design Doc (Step 4) required by project config.
Complete a design document before writing code for non-trivial changes.
Use parallax_checkin({ step: "design" }) after completing it.
Override: set PARALLAX_FORCE=1 to bypass.`
          );
        }
        if (!p.invariantsDone) {
          p.writesBeforeGate++;
          writeState();
          if (p.writesBeforeGate > 3) {
            throw new Error(
              `[parallax] PROTOCOL VIOLATION: 4 Invariants (Step 2) not completed after ${p.writesBeforeGate} writes.
State: state ownership, feedback location, deletion blast radius, timing concerns.
Use parallax_checkin({ step: "invariants" }) after completing it.`
            );
          }
        }
        const s = getFriction();
        if (s.retriesLeft === 0 && s.lastObservation) {
          throw new Error(
            `[parallax] Friction blocked: fix the outstanding issue first.
${s.lastObservation}`
          );
        }
      },
      // -----------------------------------------------------------------------
      // Post-write debounced auto-verify (friction loop)
      // -----------------------------------------------------------------------
      "tool.execute.after": async (input) => {
        if (!["write", "edit", "apply_patch"].includes(input.tool)) return;
        const s = getFriction();
        if (s.retriesLeft === 0) return;
        const sid = sessionId();
        const fileName = input.args && typeof input.args.filePath === "string" ? input.args.filePath : input.args && typeof input.args.path === "string" ? input.args.path : `(${input.tool})`;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          const result = runVerify();
          if (!result) {
            addWrite(sid, fileName, "skipped", s.retriesLeft);
            return;
          }
          s.trials++;
          if (result.exitCode === 0) {
            s.successes++;
            s.retriesLeft = MAX_FRICTION_RETRIES;
            s.lastObservation = null;
            addWrite(sid, fileName, "pass", s.retriesLeft);
            writeState();
            client.app.log({
              body: {
                service: "parallax",
                level: "info",
                message: `[parallax] Check passed (${s.successes} ok / ${s.trials} trials)`
              }
            }).catch(() => {
            });
          } else {
            s.retriesLeft--;
            s.lastObservation = truncate(result.combined, 2e3);
            addWrite(sid, fileName, "fail", s.retriesLeft);
            writeState();
            const lvl = s.retriesLeft === 0 ? "error" : "warn";
            client.app.log({
              body: {
                service: "parallax",
                level: lvl,
                message: `[parallax] Check FAILED. ${s.retriesLeft} retries left.`,
                extra: { output: s.lastObservation }
              }
            }).catch(() => {
            });
          }
        }, CHECK_DEBOUNCE_MS);
      },
      // -----------------------------------------------------------------------
      // Event hook: track session ID
      // -----------------------------------------------------------------------
      event: async (input) => {
        if (input.event.type === "session.created") {
          const props = input.event.properties || {};
          const info = props.info || {};
          if (info.parentID) return;
          currentSessionId = info.id || props.sessionID || info.sessionID || null;
          currentAgentName = info.agent || props.agent || null;
          if (currentSessionId) {
            initTrace(currentSessionId, process.cwd(), detectProject());
            if (protocolStore.has("default")) {
              protocolStore.set(currentSessionId, protocolStore.get("default"));
              protocolStore.delete("default");
            }
            if (frictionStore.has("default")) {
              frictionStore.set(currentSessionId, frictionStore.get("default"));
              frictionStore.delete("default");
            }
            if (modeStore.has("default")) {
              modeStore.set(currentSessionId, modeStore.get("default"));
              modeStore.delete("default");
            }
            writeState();
          }
        }
        if (input.event.type === "session.next.agent.switched") {
          const props = input.event.properties;
          currentAgentName = props?.agent || null;
        }
      },
      // -----------------------------------------------------------------------
      // Shell environment injection (Phase 2.6)
      // -----------------------------------------------------------------------
      "shell.env": async (input, output) => {
        const m = getMode();
        const s = getFriction();
        output.env.PARALLAX_MODE = m.mode;
        output.env.PARALLAX_SESSION_ID = currentSessionId || "";
        output.env.PARALLAX_FRICTION_RETRIES = String(s.retriesLeft);
      },
      // -----------------------------------------------------------------------
      // System prompt transformation: inject protocol status + mode skill
      // -----------------------------------------------------------------------
      "experimental.chat.system.transform": async (_input, output) => {
        const m = getMode();
        const s = getFriction();
        const p = getProtocol();
        if (currentAgentName) {
          const sys2 = output.system || (output.system = []);
          sys2.push(
            `
## PARALLAX AGENT CONTEXT
You are now operating as agent "${currentAgentName}". Parallax protocol state carries over:
- Mode: ${m.mode.toUpperCase()}
- Ambiguity: ${p.ambiguityDone ? "DONE" : "PENDING"}
- Invariants: ${p.invariantsDone ? "DONE" : "PENDING"}
- Gate: ${p.gateDone ? "DONE" : "PENDING"}
- Friction: ${s.retriesLeft} retries remaining`
          );
        }
        const statusLines = [];
        const steps = [
          "ambiguity",
          "invariants",
          "gate",
          "design",
          "commit",
          "summary"
        ];
        let currentStep = null;
        for (const step of steps) {
          const done = p[`${step}Done`];
          const label = STEP_LABELS[step];
          statusLines.push(`  ${done ? "[DONE]" : "[PENDING]"} Step: ${label}`);
          if (!done && !currentStep) currentStep = label;
        }
        const activeStep = currentStep || "Complete";
        const sys = output.system || (output.system = []);
        sys.push(
          `
## PARALLAX PROTOCOL STATUS

Active Step: ${activeStep}
${statusLines.join("\n")}`
        );
        if (m.mode !== "free") {
          const meta = MODE_META[m.mode];
          if (meta && meta.label) sys.push(`
=== ${meta.label} ===`);
          if (meta && meta.skill) {
            const content = loadSkill(meta.skill);
            if (content) sys.push(content);
          }
          if (m.mode === "build") {
            sys.push(
              "\nExecute the plan. Write clean code. Verify with parallax_verify after writes. Flag deferred items."
            );
          }
        }
        if (s.lastObservation) {
          sys.push(
            `
## PARALLAX FRICTION STATE

A previous check failed. Fix this before writing more code:

${s.lastObservation}

Retries remaining: ${s.retriesLeft}`
          );
        }
      },
      // -----------------------------------------------------------------------
      // Session compaction: preserve state across context window resets
      // -----------------------------------------------------------------------
      "experimental.session.compacting": async (_input, output) => {
        const s = getFriction();
        const m = getMode();
        const p = getProtocol();
        const sid = sessionId();
        try {
          exportTrace(sid);
        } catch {
        }
        const ctx = output.context || (output.context = []);
        ctx.push(
          `## PARALLAX SESSION STATE
- Mode: ${m.mode}
- Ambiguity: ${p.ambiguityDone}, Invariants: ${p.invariantsDone}, Gate: ${p.gateDone}
- Friction: ${s.successes} ok / ${s.trials} trials, Retries: ${s.retriesLeft}`
        );
      }
    };
  }
};
export {
  plugin_default as default
};
