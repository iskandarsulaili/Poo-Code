import { ErrorCategory } from "./ErrorClassifier"

// Hermes F3: SemanticMemory integration for pattern learning from cascade events
import { SemanticMemory } from "../memory/SemanticMemory"
import { MemoryTier } from "../memory/types"

interface ErrorEvent {
	timestamp: number
	toolName: string
	category: ErrorCategory
	message: string
}

interface CascadeChain {
	rootError: ErrorEvent
	chain: ErrorEvent[]
	isActive: boolean
}

export class CascadeTracker {
	private recentErrors: ErrorEvent[] = []
	private activeCascade: CascadeChain | null = null
	private readonly CASCADE_WINDOW_MS = 30_000 // 30 seconds
	private readonly MAX_CHAIN_LENGTH = 10

	recordError(toolName: string, category: ErrorCategory, message: string): void {
		const event: ErrorEvent = {
			timestamp: Date.now(),
			toolName,
			category,
			message,
		}

		this.recentErrors.push(event)
		this.pruneOldErrors()
		this.detectCascade(event)
	}

	private detectCascade(event: ErrorEvent): void {
		if (!this.activeCascade) {
			// Start a new cascade
			this.activeCascade = {
				rootError: event,
				chain: [event],
				isActive: true,
			}
			return
		}

		const timeSinceRoot = event.timestamp - this.activeCascade.rootError.timestamp

		if (timeSinceRoot < this.CASCADE_WINDOW_MS && this.activeCascade.chain.length < this.MAX_CHAIN_LENGTH) {
			this.activeCascade.chain.push(event)
		} else {
			// Cascade expired or too long — archive and start new
			this.archiveCascadeToMemory()
			this.activeCascade = {
				rootError: event,
				chain: [event],
				isActive: true,
			}
		}
	}

	getActiveCascade(): CascadeChain | null {
		if (this.activeCascade && this.activeCascade.isActive) {
			const age = Date.now() - this.activeCascade.rootError.timestamp
			if (age < this.CASCADE_WINDOW_MS) {
				return this.activeCascade
			}
			this.activeCascade.isActive = false
		}
		return null
	}

	getRecentErrors(toolName?: string, count: number = 5): ErrorEvent[] {
		const filtered = toolName ? this.recentErrors.filter((e) => e.toolName === toolName) : this.recentErrors
		return filtered.slice(-count)
	}

	getCascadeSuggestion(): string | null {
		const cascade = this.getActiveCascade()
		if (!cascade || cascade.chain.length < 2) {
			return null
		}
		const tools = [...new Set(cascade.chain.map((e) => e.toolName))]
		return `Possible cascade detected across [${tools.join(", ")}]. Suggest pausing to evaluate.`
	}

	// Hermes F3: Forward completed cascades to SemanticMemory for pattern learning
	private async archiveCascadeToMemory(): Promise<void> {
		if (!this.activeCascade || this.activeCascade.chain.length < 2) {
			return
		}

		try {
			const semanticMemory = new SemanticMemory()
			await semanticMemory.initialize()
			const cascade = this.activeCascade
			const rootCategory = cascade.rootError.category
			const tools = [...new Set(cascade.chain.map((e) => e.toolName))]
			const summary = cascade.chain
				.map((e) => `${e.toolName}:${e.category}:${e.message.slice(0, 100)}`)
				.join(" → ")

			const now = Date.now()
			await semanticMemory.store({
				id: crypto.randomUUID(),
				tier: MemoryTier.SEMANTIC,
				type: "learned_pattern",
				content: `Cascade detected: ${summary}`,
				metadata: {
					rootCategory,
					tools,
					chainLength: cascade.chain.length,
					source: "CascadeTracker" as const,
				},
				confidence: cascade.chain.length / 10,
				sourceAuthority: "execution" as const,
				tags: ["error_cascade", rootCategory, ...tools],
				createdAt: now,
				lastAccessed: now,
				accessCount: 1,
				baseScore: 0.5,
				tierDecayRate: 0.01,
				contradictoryObservations: 0,
				totalObservations: cascade.chain.length,
				expiresAt: now + 7 * 24 * 60 * 60 * 1000, // 7 days
			})
		} catch (memoryError) {
			console.warn("[Hermes F3] archiveCascadeToMemory failed:", memoryError)
		}
	}

	private pruneOldErrors(): void {
		const cutoff = Date.now() - 300_000 // 5 minutes
		this.recentErrors = this.recentErrors.filter((e) => e.timestamp > cutoff)
	}

	reset(): void {
		this.recentErrors = []
		this.activeCascade = null
	}
}
