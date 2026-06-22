import { DEFAULT_CONFIG, createLogger } from "./models.js"
import type { CodebaseMappingConfig, ComplianceBoundary, MaskedSecret, PIIDetection } from "./types.js"

export class SecurityLayer {
	private config: CodebaseMappingConfig
	private logger: ReturnType<typeof createLogger>
	private secretPatterns: RegExp[]
	private piiPatterns: Map<PIIDetection["type"], RegExp>

	constructor(config: Partial<CodebaseMappingConfig> = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config }
		this.logger = createLogger(this.config.logLevel)
		this.secretPatterns = this.initializeSecretPatterns()
		this.piiPatterns = this.initializePIIPatterns()
	}

	maskSecrets(content: string, filePath: string): { masked: string; secrets: MaskedSecret[] } {
		if (!this.config.enableSecretMasking) {
			return { masked: content, secrets: [] }
		}

		const secrets: MaskedSecret[] = []
		let masked = content
		const lines = content.split("\n")

		for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
			const line = lines[lineIdx]
			if (line === undefined) continue
			for (const pattern of this.secretPatterns) {
				const matches = line.matchAll(pattern)
				for (const match of matches) {
					if (match[0]) {
						const maskedValue = "***MASKED***"
						masked = masked.replace(match[0], maskedValue)
						secrets.push({
							pattern: pattern.source,
							originalValue: match[0],
							maskedValue,
							filePath,
							line: lineIdx + 1,
							column: match.index ?? 0,
						})
					}
				}
			}
		}

		return { masked, secrets }
	}

	detectPII(content: string, filePath: string): PIIDetection[] {
		if (!this.config.enablePIIDetection) return []

		const detections: PIIDetection[] = []
		const lines = content.split("\n")

		for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
			const line = lines[lineIdx]
			if (line === undefined) continue
			for (const [type, pattern] of this.piiPatterns) {
				const matches = line.matchAll(pattern)
				for (const match of matches) {
					if (match[0]) {
						detections.push({
							type,
							value: match[0],
							filePath,
							line: lineIdx + 1,
							column: match.index ?? 0,
						})
					}
				}
			}
		}

		return detections
	}

	checkComplianceBoundaries(_filePath: string): ComplianceBoundary[] {
		// Compliance boundary checking will be implemented here
		return []
	}

	private initializeSecretPatterns(): RegExp[] {
		return [
			/(?:api[_-]?key|apikey|secret[_-]?key|secretkey)\s*[:=]\s*['"][^'"]+['"]/gi,
			/(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]+['"]/gi,
			/(?:token|access[_-]?token)\s*[:=]\s*['"][^'"]+['"]/gi,
			/(?:ssh-rsa|ssh-ed25519)\s+A[A-Za-z0-9+/=]+/g,
			/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g,
		]
	}

	private initializePIIPatterns(): Map<PIIDetection["type"], RegExp> {
		return new Map([
			["email", /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g],
			["phone", /\+?1?\d{10,15}/g],
			["ip_address", /\b(?:\d{1,3}\.){3}\d{1,3}\b/g],
		])
	}
}
