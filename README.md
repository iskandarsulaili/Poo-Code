## Poo Code (v3.57.0)

Poo-Code is a fork of [Zoo-Code](https://github.com/Zoo-Code-Org/Zoo-Code) which is a fork of Roo-Code which is a fork of Cline. I named it "Poo" because I don't know if it will work or not. In other words, it can either be total sh\*t or become organic fertilizer that will take legacy "spaghetti code" and "crap architectures," breaks them down, and uses full AI automation to fertilize it into beautifully optimized, blooming software to flush out bad code so your codebase can grow.
(The truth is I am too lazy to chunk it into smaller commits — the full pile lives in the [selfimproving](https://github.com/iskandarsulaili/Poo-Code/tree/selfimproving) branch)

> **⚠ EXPERIMENTAL** — This fork adds a full self-improving AI layer + parallel execution engine + codebase intelligence + verification system on top of Zoo-Code. All new features are gated behind experiment toggles. Enable at your own risk. Source: [selfimproving](https://github.com/iskandarsulaili/Poo-Code/tree/selfimproving) branch.

---

## The Problem

1. I can't sleep well because of anxiety due to the wrong decisions it made by always selecting the first choice as the answer.
2. It ruined my morning because when I woke up I found it having an unauthorized day off during a busy day (silently stuck because of an error).

The ultimate goal is to totally replace you, so you can be permanently "Ooo" (Out of Office) and jobless like I am.

## What's different from Zoo-Code

This fork adds **~31,000 lines** of new infrastructure across **230+ files**, all behind experiment toggles. Every new feature is gated — Zoo-Code main's behaviour is preserved with everything off.

### Core Features

| Feature | Poo-Code (this branch) | Zoo-Code main |
|---------|--------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------|
| **Self-improving loop** | `SelfImprovingManager` — background review pass every N turns/tool calls. Learns from mistakes, curates skills, suggests optimizations. | ❌ No automated self-review |
| **Pattern analysis** | `PatternAnalyzer` — detects recurring tool-use patterns, error signatures, and skill gaps from execution history. | ❌ No pattern detection |
| **Curator service** | `CuratorService` — tar.gz-backed skill store (backup/rollback). Decides when to create/update/merge skills from learned patterns. | ❌ Manual skill authoring only |
| **Skill automation** | `ActionExecutor` + `ImprovementApplier` — auto-creates and updates skills from reviewed patterns. | ❌ No auto skill creation |
| **Insights engine** | `InsightsEngine` — generates project-level insights (dead code, stale configs, architecture notes). | ❌ No project insights |
| **Resilience** | `ResilienceService` — streaming backoff, tool error healer, auto-retry with learned recovery strategies. Separate streaming failure counter prevents cross-contamination. | ❌ Basic retry only |
| **Question evaluation** | `QuestionEvaluatorService` — evaluates user questions for clarity/completeness; auto-selects best answer when choices are offered. | ❌ Always picks first choice |
| **Trust service** | `TrustService` — learns tool-approval patterns over time. Full-trust mode auto-approves known-safe tools. | ❌ Static auto-approval rules |
| **Review team** | `ReviewTeamService` — multi-agent review (innovator + critic + decider) scores every learned pattern before applying it. | ❌ No pre-apply validation |
| **Agent memory** | `AgentMemoryAdapter` + `MemoryStore` + `MemoryBackendFactory` — pluggable memory backend (SQLite default, configurable). Bounded context injection via `memory.ts` types. | ❌ No persistent agent memory |
| **Learning store** | `LearningStore` — stores/retrieves learned patterns with confidence scoring. Schema-versioned for forward compat. | ❌ No learning storage |
| **Transcript recall** | `TranscriptRecall` — retrieves past conversation context for pattern learning. | ❌ No historical context |
| **Skill usage tracking** | `SkillUsageStore` — tracks which skills fire, success rate, frequency. Feeds curator decisions. | ❌ No usage metrics |
| **Auto-mode orchestrator** | `AutoModeOrchestrator` — automatically switches between VS Code modes based on task type. | ❌ Manual mode switching |
| **Mode factory** | `ModeFactoryService` — generates custom modes from learned workflows. | ❌ Fixed mode set |

### Parallel Execution Engine

| Feature | Poo-Code | Zoo-Code |
|---------|----------|----------|
| **Parallel execution** | `ExecuteParallelSubtaskTool` + `ExecuteParallelChildTaskTool` — DAG-based parallel task execution with dependency resolution, lock-aware scheduling, and blackboard communication between subtasks. Real child agent spawning via SubtaskExecutor callback. | ❌ No parallel execution |
| **Parallel orchestrator** | `ParallelSubtaskOrchestrator` — topological DAG wave scheduling, cycle detection, subtask heartbeat monitoring, automatic retry/failure handling, resume/skip/cancel controls. | ❌ No orchestrator |
| **Parallel dashboard UI** | Slide-in overlay panel with tabbed views (Subtasks, Child Tasks, DAG, Logs). Live DAG visualization, subtask cards with status/duration/deps, intervention controls (pause/resume/cancel/retry/skip), agent thought stream, system log stream. Auto-opens on parallel task start; closeable via Escape/backdrop/X. | ❌ No UI |
| **Log forwarding** | Live log streaming from orchestrator to webview via onLog callback. Every subtask lifecycle event (start, complete, fail) pushed to dashboard in real-time. | ❌ No equivalent |

### Verification System

| Feature | Poo-Code | Zoo-Code |
|---------|----------|----------|
| **Requirements extraction** | `RequirementsVerifier` — parses user prompts for bullet points, numbered lists, and narrative action verbs. Splits "Create a login page with auth and session management" into 3+ granular requirements. | ❌ No requirement tracking |
| **Auto-verification** | Cross-references requirements against actual tool_use blocks in API conversation history. Marks requirements as verified when matching file paths found, failed when no corresponding file changes. | ❌ No equivalent |
| **File-changes gate** | `VerificationEngine` runs `git diff --diff-filter=ACMRTD` at completion time to verify files were actually modified (not just claimed). | ❌ No file-change validation |
| **Content volume check** | Parses `git diff --stat` to count lines inserted+deleted. Warns when <5 lines changed across all files (suggests stubs/placeholders). | ❌ No equivalent |
| **Stub detection** | Scans modified files for TODO, FIXME, HACK, `throw new Error('not implemented')`, `@ts-ignore`, `@ts-nocheck`. Flags files where >5% of lines match. | ❌ No stub scanning |
| **Build config integrity** | SHA256-hashes 15 build config files (package.json, Cargo.toml, pyproject.toml, etc.) at task start. Re-checks at completion — fails if agent tampered with build scripts. | ❌ No integrity check |
| **Claim cross-reference** | Extracts file names from the agent's `attempt_completion` result text. Blocks completion when >50% of claimed files were not actually modified by tool calls. | ❌ No claim validation |
| **Result substance check** | Rejects empty or evasion-language result text. Minimum 20 meaningful characters, blocks "nothing/failed/unable to" patterns under 80 chars. | ❌ No validation |
| **Test coverage gate** | Supports `coverageCommand` + `minCoverage` config. Parses `XX%` from coverage tool output (matches last occurrence for total). Auto-detects coverage command per language. | ❌ No coverage check |
| **Escalation** | After 5 consecutive verification failures across any gate, prompts user to bypass, retry, or cancel. Cross-call tracking persists across `attempt_completion` retries. | ❌ No escalation |
| **Bypass mode** | Single `verificationLevel: "bypass"` skips ALL 5 gate sections (requirements, auto-verify, claim check, substance check, code quality). Opt-out from verification. | ❌ No equivalent |
| **Child task scoping** | Aggregates tool call files from delegated children into parent's verification. Children store files under direct parent taskId; no sibling pollution. Cleaned up on delegation completion/denied/error. | ❌ No equivalent |
| **Gate consistency** | `vLevel` resolved once, enforced uniformly across all 5 checks. No gate runs when bypassed. | ❌ No equivalent |

### Codebase Intelligence & Developer Experience

| Feature | Poo-Code | Zoo-Code |
|---------|----------|----------|
| **Codebase mapping** | `@zoo-code/codebase-mapping` package — AST parsing via web-tree-sitter, dependency graph with circular detection, symbol extraction, token compression for LLM context, multi-format serialization (JSON/Mermaid/Markdown/DOT), security layer (PII/secret scanning), AST cache with TTL. 3 VS Code commands: refresh/show/export map. | ❌ No equivalent |
| **Prompt compression** | `compressPrompt()` — lossless compression for child agent prompts (verbose phrase shortening, whitespace optimization, markdown stripping, JSON compaction, file path shortening). Prevents child agent context overload. | ❌ No compression |
| **i18n translation** | All 18 locales fully translated for parallel UI (dashboard, subtask cards, intervention controls, resume panel, detail panel, DAG labels). Languages: ca, de, en, es, fr, hi, id, it, ja, ko, nl, pl, pt-BR, ru, tr, vi, zh-CN, zh-TW. Fixed `defaultNS: "common"` so dashboard renders labels instead of raw keys. | ❌ Partial EN-only |

### Orchestrator Modes

| Feature | Poo-Code | Zoo-Code |
|---------|----------|----------|
| **ONE-SHOT Orchestrator** | Autonomous 8-phase sequential build agent — handles entire projects from requirements to verification in a single pass | ❌ No equivalent |
| **KAIZEN Orchestrator** | Continuous improvement agent with 7-step iteration loop (Analyze → Identify → Fix → Verify → Enhance → Git Push → Re-evaluate) and self-evolving mini-goals | ❌ No equivalent |
| **Proactive Error Prevention** | Pre-execution tool call validation, structured error classification (12 categories), cascading failure detection, and prevention hint injection — catches errors BEFORE they happen | ❌ No equivalent |
| **Git Auto-Push** | KAIZEN mode auto-commits and pushes every cycle, enabling CI/CD pipelines to apply changes to staging/production automatically | ❌ No equivalent |
| **Self-Evolving Mini-Goals** | Mini-goals automatically evolve upward as each is achieved, with healing that reverts to fixing regressions first | ❌ No equivalent |

### Infrastructure

| Feature | Poo-Code | Zoo-Code |
|---------|----------|----------|
| **Skill name validation** | Validates skill name format (1-64 chars, lowercase alphanumeric/hyphens) in `SkillManageTool` (create/update/delete/merge) and `ActionExecutor`. Hash-truncated names pass validation with safe fallback. | ❌ No validation |
| **MemoryManager init** | Calls `initialize()` before `consolidate()` in F3 cycle — prevents silent init failures on cold start. | ❌ No equivalent |
| **ConfidenceScorer wiring** | Fixed: only scores when patterns exist; passes proper typed args to `calculateScore()`. | ❌ No equivalent |
| **Always-available tools** | `list_files` + `read_file` promoted to always-available tools (available in any mode). | ❌ Gated per mode |
| **Streaming failure resilience** | Separate `streamingFailureCount` counter so consecutive tool mistakes don't exhaust streaming retry budget. | ❌ Single counter |
| **Verification ON by default** | Verification engines created on extension activation. Opt-out with `experiments.disableVerification: true`. Previously required opt-in. | ❌ No default |

### Experiment gate reference

| Toggle | Enables |
| ------ | ------- |
| `selfImproving` | Master switch — enables the entire learning loop |
| `selfImprovingAutoSkills` | Auto-create/update/merge skills from learned patterns |
| `selfImprovingAutoMode` | Auto-switch VS Code modes based on task |
| `selfImprovingReviewTeam` | Multi-agent review before applying learned patterns |
| `selfImprovingFullTrust` | Auto-approve tools that TrustService considers safe |
| `selfImprovingQuestionEvaluation` | Evaluate user questions for clarity; auto-select best answer |
| `oneShotOrchestrator` | Enable ONE-SHOT Orchestrator mode for autonomous project builds |
| `kaizenOrchestrator` | Enable KAIZEN Orchestrator mode for continuous improvement |
| `proactiveErrorPrevention` | Enable pre-execution tool call validation and cascade detection |
| `gitAutoPush` | Enable auto-commit and push in KAIZEN mode |
| `selfEvolvingMiniGoals` | Enable self-evolving mini-goals with regression healing |
| `fullUICoverage` | Enable full UI coverage for all self-improving services |
| `parallelExecution` | Enable DAG-based parallel task execution |
| `structuredOutputParsing` | Enable structured output parsing for model responses |
| `dependencyGraph` | Enable dependency graph analysis for task ordering |
| `multiRootWorkspace` | Enable multi-root workspace support |
| `parallelSubtask` | Enable parallel subtask execution with blackboard communication |
| `disableVerification` | Disable ALL verification gates (verification ON by default) |

## Use Case Examples

### Example 1: One-Shot Project Build

**Scenario:** You need to build a complete REST API server from scratch.

1. Switch to **ONE-SHOT Orchestrator** mode
2. Describe your requirements: "Build a FastAPI REST API with PostgreSQL backend, JWT auth, and CRUD endpoints for users and products"
3. The agent autonomously executes 8 phases:
    - Requirements analysis → Architecture design → Project scaffolding → Core implementation → Integration → Testing → Bug fixing → Verification
4. Result: A fully tested, production-ready API server with zero manual intervention

### Example 2: Parallel Task Execution

**Scenario:** You need to update multiple independent files simultaneously.

1. Enable **Parallel Execution** in Experimental Settings
2. The agent splits your request into DAG-ordered subtasks:
    - Subtask A: Update API schema (no deps) ✓
    - Subtask B: Update backend logic (depends on A) ⟳
    - Subtask C: Update frontend types (depends on A) ⟳
    - Subtask D: Update tests (depends on B, C) ○
3. The Parallel Dashboard shows live progress, DAG visualization, logs, and agent thoughts
4. Each subtask spawns a real child agent via `waitForCompletion()` — parent awaits real completion
5. Result: Structurally parallel execution with dependency-safe ordering

### Example 3: Continuous Codebase Improvement

**Scenario:** You have an existing codebase with technical debt and want continuous improvement.

1. Switch to **KAIZEN Orchestrator** mode
2. Set your initial mini-goal: "Fix all TypeScript strict mode errors"
3. The agent enters the Kaizen loop:
    - **Cycle 1**: Analyzes errors → Fixes 3 type errors → Runs tests → Git push → Re-evaluates
    - **Cycle 2**: Fixes 5 more errors → Runs tests → Git push → Evolves mini-goal
    - **Cycle N**: Continues until mini-goal achieved, then evolves upward
4. Each cycle is one atomic change, verified, and pushed to CI/CD
5. Result: Continuous, safe improvement without regressions

### Example 4: Proactive Error Prevention

**Scenario:** You're working on a large codebase and the model keeps hitting tool errors.

1. Enable **Prevention Engine** and **Cascade Tracker** in Experimental Settings
2. Before each tool call, the system validates parameters:
    - `read_file` with directory path → warns to use `list_files` instead
    - `list_files recursive=true` without ripgrep → suggests `find`/`ls` fallback
    - Long `execute_command` → warns about shell limits
3. After errors, the system classifies them and tracks cascading failures
4. If 2+ errors occur within 30 seconds, a cascade warning is injected suggesting an approach change
5. Result: Fewer wasted tool calls, faster task completion, lower API costs

### Example 5: Self-Healing Production Deployment

**Scenario:** A production deployment has regressions and needs immediate attention.

1. Switch to **KAIZEN Orchestrator** mode
2. The agent analyzes logs and test results
3. Detects regressions → mini-goal auto-reverts to fixing those first
4. Each fix is verified, committed with `kaizen: fix regression in X`, and pushed
5. CI/CD pipeline auto-deploys each fix to staging/production
6. Once regressions are resolved, mini-goal evolves upward to the next improvement
7. Result: Self-healing deployment with zero manual intervention

### Example 6: Codebase Understanding

**Scenario:** You inherit a large unfamiliar codebase and need to understand its structure.

1. Enable **Codebase Mapping** (via `zoo-code.refreshCodebaseMap` command)
2. The system scans all files, parses ASTs, builds a dependency graph
3. Use `zoo-code.showCodebaseMap` to see file count, edges, dead symbols, cache hit rate
4. Use `zoo-code.exportCodebaseMap` to export Mermaid diagram for documentation
5. Result: Instant codebase understanding without manual tracing

### Example 7: Verification-Gated Completion

**Scenario:** You want to ensure the agent actually implements what it claims before marking work as done.

1. Verification runs automatically at `attempt_completion` (no manual toggle needed)
2. The system checks:
    - **File-changes**: Were files actually modified? (`git diff --diff-filter=ACMRTD`)
    - **Build config**: Was `package.json` tampered with? (SHA256 snapshot comparison)
    - **Claims**: Do the files mentioned in the result text match actual tool calls?
    - **Stubs**: Are there TODO/FIXME patterns in the modified files?
    - **Content volume**: Were at least ~5 lines changed? (anti-stub)
    - **Build/Lint/Types**: Do auto-detected project commands pass?
    - **Requirements**: Was each extracted requirement addressed by a file change?
    - **Substance**: Is the completion result non-empty and non-evasive?
3. Failures block `attempt_completion` with detailed error messages
4. After 5 consecutive failures, user is prompted to bypass or retry
5. Result: Honest completion results with verifiable evidence

## Statistic

Projects generated: Countless

Monthly cost: LLM & electric bills

Non-refundable cost: My soul

Revenue generated so far: 0 and still counting zero

## Special Messages

Don't star this repo. It will just get me excited to drag you into the jobless community

Any issue not related to self-learning, submit at https://github.com/Zoo-Code-Org/Zoo-Code/issues as they know more than me (no cap)

## FAQ

**Q:** What is your day job?

**A:** Jobless

**Q:** What is your night job?

**A:** Sleep

**Q:** Ooo... Can I buy you coffee?

**A:** No. I have insomnia.

**Q:** Can I...?

**A:** This is end of conversation.
