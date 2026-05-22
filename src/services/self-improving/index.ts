/**
 * Self-Improving Module
 *
 * A standalone, experiment-gated subsystem that learns from task outcomes
 * to improve prompt guidance, tool preferences, and error avoidance over time.
 *
 * Architecture: Hermes-agent symbolic learning loop adapted to Zoo-Code patterns.
 * See ARCHITECTURE.md for full design documentation.
 */

export { SelfImprovingManager } from "./SelfImprovingManager"
export { LearningStore } from "./LearningStore"
export { FeedbackCollector } from "./FeedbackCollector"
export { PatternAnalyzer } from "./PatternAnalyzer"
export { ImprovementApplier } from "./ImprovementApplier"
export { CodeIndexAdapter } from "./CodeIndexAdapter"
export { MemoryBackendFactory } from "./MemoryBackendFactory"
export { AgentMemoryAdapter } from "./AgentMemoryAdapter"
export { MemoryStore } from "./MemoryStore"
export { SkillUsageStore } from "./SkillUsageStore"
export { ActionExecutor } from "./ActionExecutor"
export { CuratorService } from "./CuratorService"
export { ReviewPromptFactory } from "./ReviewPromptFactory"
export { TranscriptRecall } from "./TranscriptRecall"

export type { CodeIndexInfo, Logger, PromptContext, SelfImprovingManagerOptions, TaskEventInfo } from "./types"
export type { MemoryBackend, MemoryBackendType } from "./MemoryBackend"
export type { MemoryStoreType } from "./MemoryStore"
export type { SkillTelemetryRecord, SkillProvenance, SkillLifecycleState } from "./SkillUsageStore"
export type { CuratorConfig, CuratorReport } from "./CuratorService"
export type { ReviewType, ReviewPrompt } from "./ReviewPromptFactory"
export type { TranscriptEntry } from "./TranscriptRecall"

export { DEFAULT_CONFIG, EMPTY_STATE } from "./types"
