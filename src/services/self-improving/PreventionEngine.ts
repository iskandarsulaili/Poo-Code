import { ErrorClassifier, ClassifiedError, ErrorCategory } from "./ErrorClassifier"
import { ToolCallValidator, ValidationResult } from "./ToolCallValidator"
import { CascadeTracker } from "./CascadeTracker"

export interface PreventionContext {
	preValidation: ValidationResult
	cascadeWarning: string | null
	preventionHints: string[]
	recentErrors: Array<{ toolName: string; category: string }>
}

export class PreventionEngine {
	private errorClassifier: ErrorClassifier
	private toolCallValidator: ToolCallValidator
	private cascadeTracker: CascadeTracker

	constructor() {
		this.errorClassifier = new ErrorClassifier()
		this.toolCallValidator = new ToolCallValidator()
		this.cascadeTracker = new CascadeTracker()
	}

	/**
	 * Called BEFORE every tool call to get prevention context.
	 * Returns validation warnings, cascade warnings, and hints
	 * that can be injected into the model's context.
	 */
	getPreventionContext(
		toolName: string,
		params: Record<string, unknown>,
	): PreventionContext {
		const preValidation = this.toolCallValidator.validate(toolName, params)
		const cascadeWarning = this.cascadeTracker.getCascadeSuggestion()
		const recentErrors = this.cascadeTracker.getRecentErrors(toolName, 3)
		const preventionHints = this.toolCallValidator.getPreventionHints(
			toolName,
			recentErrors.map((e) => ({ toolName: e.toolName, category: e.category })),
		)

		return {
			preValidation,
			cascadeWarning,
			preventionHints,
			recentErrors: recentErrors.map((e) => ({
				toolName: e.toolName,
				category: e.category,
			})),
		}
	}

	/**
	 * Called AFTER every tool call to record the result.
	 * Returns a ClassifiedError if there was an error, or null on success.
	 */
	recordToolResult(
		toolName: string,
		error: string | null,
		_params: Record<string, unknown>,
	): ClassifiedError | null {
		if (!error) {
			// Success — check if we were in a cascade and can clear it
			this.cascadeTracker.reset()
			return null
		}

		const classified = this.errorClassifier.classify(error, toolName)
		this.cascadeTracker.recordError(toolName, classified.category, error)
		return classified
	}

	/**
	 * Generate a prevention message to inject into the model's context.
	 * Returns a formatted string or null if nothing to report.
	 */
	generatePreventionMessage(context: PreventionContext): string | null {
		const parts: string[] = []

		if (context.cascadeWarning) {
			parts.push(context.cascadeWarning)
		}

		if (context.preValidation.warnings.length > 0) {
			parts.push(
				`⚠️ Pre-validation warnings: ${context.preValidation.warnings.join("; ")}`,
			)
		}

		if (context.preValidation.suggestions.length > 0) {
			parts.push(
				`💡 Suggestions: ${context.preValidation.suggestions.join("; ")}`,
			)
		}

		if (context.preventionHints.length > 0) {
			parts.push(...context.preventionHints)
		}

		return parts.length > 0 ? parts.join("\n") : null
	}

	getCascadeTracker(): CascadeTracker {
		return this.cascadeTracker
	}

	getErrorClassifier(): ErrorClassifier {
		return this.errorClassifier
	}

	getToolCallValidator(): ToolCallValidator {
		return this.toolCallValidator
	}
}
