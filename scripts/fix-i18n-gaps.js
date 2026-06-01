/**
 * Comprehensive i18n gap fixer
 *
 * Fixes:
 * 1. Missing errors.invalid_structure in backend skills.json (17 locales)
 * 2. Missing settings.json keys in webview-ui (17 locales)
 * 3. Surplus keys in id/chat.json, zh-TW/chat.json, fr/*.json
 */

const fs = require("fs")
const path = require("path")

const ROOT = path.resolve(__dirname, "..")

// ========== UTILITY ==========

function readJSON(filePath) {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8"))
	} catch {
		return null
	}
}

function writeJSON(filePath, data) {
	fs.writeFileSync(filePath, JSON.stringify(data, null, "\t") + "\n", "utf-8")
}

/**
 * Recursively collect all leaf-key paths from a nested object.
 * Returns paths like "errors.invalid_structure", "a.b.c"
 */
function getLeafKeys(obj, prefix = "") {
	const keys = []
	for (const [key, value] of Object.entries(obj)) {
		const fullKey = prefix ? `${prefix}.${key}` : key
		if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			keys.push(...getLeafKeys(value, fullKey))
		} else {
			keys.push(fullKey)
		}
	}
	return keys
}

/**
 * Get a nested value by dot-separated path.
 */
function getByPath(obj, pathStr) {
	const parts = pathStr.split(".")
	let current = obj
	for (const part of parts) {
		if (current === undefined || current === null) return undefined
		current = current[part]
	}
	return current
}

/**
 * Deep-merge: add a leaf value at a dot-separated path.
 * Creates intermediate objects as needed.
 */
function setByPath(obj, pathStr, value) {
	const parts = pathStr.split(".")
	let current = obj
	for (let i = 0; i < parts.length - 1; i++) {
		if (!(parts[i] in current)) {
			current[parts[i]] = {}
		}
		current = current[parts[i]]
	}
	current[parts[parts.length - 1]] = value
}

/**
 * Deep delete a leaf key by dot-separated path.
 * Does not clean up empty parents (for safety).
 */
function deleteByPath(obj, pathStr) {
	const parts = pathStr.split(".")
	let current = obj
	for (let i = 0; i < parts.length - 1; i++) {
		if (current === undefined || current === null) return
		current = current[parts[i]]
	}
	if (current) {
		delete current[parts[parts.length - 1]]
	}
}

/**
 * Deep-clone a JSON-compatible value.
 */
function deepClone(obj) {
	return JSON.parse(JSON.stringify(obj))
}

// ========== ISSUE 1: Backend skills.json — errors.invalid_structure ==========

function fixBackendSkills() {
	console.log("\n=== ISSUE 1: Backend skills.json ===")

	const srcLocalesDir = path.join(ROOT, "src", "i18n", "locales")
	const enSkillsPath = path.join(srcLocalesDir, "en", "skills.json")
	const enSkills = readJSON(enSkillsPath)
	if (!enSkills) {
		console.error("  ERROR: Cannot read English skills.json")
		return
	}

	const englishValue = getByPath(enSkills, "errors.invalid_structure")
	console.log(`  English value: "${englishValue}"`)

	const locales = fs.readdirSync(srcLocalesDir).filter((l) => l !== "en")
	let addedCount = 0

	for (const locale of locales) {
		const filePath = path.join(srcLocalesDir, locale, "skills.json")
		if (!fs.existsSync(filePath)) {
			console.log(`  SKIP ${locale}: file not found`)
			continue
		}
		const data = readJSON(filePath)
		if (!data) {
			console.log(`  SKIP ${locale}: cannot parse`)
			continue
		}
		const existing = getByPath(data, "errors.invalid_structure")
		if (existing !== undefined) {
			continue // already present
		}
		// Add after description_length
		if (data.errors && data.errors.description_length !== undefined) {
			data.errors.invalid_structure = englishValue
		} else if (data.errors) {
			data.errors.invalid_structure = englishValue
		} else {
			data.errors = { invalid_structure: englishValue }
		}
		writeJSON(filePath, data)
		console.log(`  ADDED errors.invalid_structure → ${locale}`)
		addedCount++
	}
	console.log(`  Total: ${addedCount} locales updated`)
	return addedCount
}

// ========== ISSUE 2: Webview settings.json — add missing keys ==========

function fixWebviewSettings() {
	console.log("\n=== ISSUE 2: Webview settings.json ===")

	const webviewLocalesDir = path.join(ROOT, "webview-ui", "src", "i18n", "locales")
	const enSettingsPath = path.join(webviewLocalesDir, "en", "settings.json")
	const enSettings = readJSON(enSettingsPath)
	if (!enSettings) {
		console.error("  ERROR: Cannot read English settings.json")
		return
	}

	const enKeys = getLeafKeys(enSettings)
	console.log(`  English has ${enKeys.length} leaf keys`)

	const locales = fs.readdirSync(webviewLocalesDir).filter((l) => l !== "en" && l !== ".gitkeep")
	let totalAdded = 0
	const perLocale = {}

	for (const locale of locales) {
		const filePath = path.join(webviewLocalesDir, locale, "settings.json")
		if (!fs.existsSync(filePath)) {
			console.log(`  SKIP ${locale}: file not found`)
			continue
		}
		const data = readJSON(filePath)
		if (!data) {
			console.log(`  SKIP ${locale}: cannot parse`)
			continue
		}

		const added = []
		for (const key of enKeys) {
			if (getByPath(data, key) === undefined) {
				const value = getByPath(enSettings, key)
				setByPath(data, key, value)
				added.push({ key, value })
			}
		}

		if (added.length > 0) {
			writeJSON(filePath, data)
			console.log(`  ${locale}: added ${added.length} keys`)
			added.forEach((a) => console.log(`    + ${a.key}`))
			totalAdded += added.length
			perLocale[locale] = added.length
		} else {
			console.log(`  ${locale}: no missing keys`)
		}
	}
	console.log(`  Total: ${totalAdded} keys added across all locales`)
	return perLocale
}

// ========== ISSUE 3: Reconcile surplus keys ==========

function reconcileSurplusKeys() {
	console.log("\n=== ISSUE 3: Surplus key reconciliation ===")

	const webviewLocalesDir = path.join(ROOT, "webview-ui", "src", "i18n", "locales")

	// Read English files to get their keys
	const enFiles = {}
	for (const name of ["chat.json", "history.json", "marketplace.json", "prompts.json"]) {
		const path_ = path.join(webviewLocalesDir, "en", name)
		const data = readJSON(path_)
		if (data) {
			enFiles[name] = { data, keys: new Set(getLeafKeys(data)) }
			console.log(`  English ${name}: ${enFiles[name].keys.size} keys`)
		}
	}

	const removed = {}

	// --- id/chat.json ---
	const idChatPath = path.join(webviewLocalesDir, "id", "chat.json")
	const idChat = readJSON(idChatPath)
	if (idChat && enFiles["chat.json"]) {
		const idKeys = getLeafKeys(idChat)
		const enKeys = enFiles["chat.json"].keys
		const surplus = idKeys.filter((k) => !enKeys.has(k))
		if (surplus.length > 0) {
			console.log(`\n  id/chat.json: ${surplus.length} surplus keys found`)
			removed["id/chat.json"] = []
			for (const key of surplus) {
				deleteByPath(idChat, key)
				console.log(`    REMOVED: ${key}`)
				removed["id/chat.json"].push(key)
			}
			writeJSON(idChatPath, idChat)
		} else {
			console.log(`\n  id/chat.json: no surplus keys`)
		}
	}

	// --- zh-TW/chat.json ---
	const zhTWChatPath = path.join(webviewLocalesDir, "zh-TW", "chat.json")
	const zhTWChat = readJSON(zhTWChatPath)
	if (zhTWChat && enFiles["chat.json"]) {
		const zhTWKeys = getLeafKeys(zhTWChat)
		const enKeys = enFiles["chat.json"].keys
		const surplus = zhTWKeys.filter((k) => !enKeys.has(k))
		if (surplus.length > 0) {
			console.log(`\n  zh-TW/chat.json: ${surplus.length} surplus keys found`)
			removed["zh-TW/chat.json"] = []
			for (const key of surplus) {
				deleteByPath(zhTWChat, key)
				console.log(`    REMOVED: ${key}`)
				removed["zh-TW/chat.json"].push(key)
			}
			writeJSON(zhTWChatPath, zhTWChat)
		} else {
			console.log(`\n  zh-TW/chat.json: no surplus keys`)
		}
	}

	// --- fr/history.json ---
	const frHistoryPath = path.join(webviewLocalesDir, "fr", "history.json")
	const frHistory = readJSON(frHistoryPath)
	if (frHistory && enFiles["history.json"]) {
		const frKeys = getLeafKeys(frHistory)
		const enKeys = enFiles["history.json"].keys
		const surplus = frKeys.filter((k) => !enKeys.has(k))
		if (surplus.length > 0) {
			console.log(`\n  fr/history.json: ${surplus.length} surplus keys found`)
			removed["fr/history.json"] = []
			for (const key of surplus) {
				deleteByPath(frHistory, key)
				console.log(`    REMOVED: ${key}`)
				removed["fr/history.json"].push(key)
			}
			writeJSON(frHistoryPath, frHistory)
		} else {
			console.log(`\n  fr/history.json: no surplus keys`)
		}
	}

	// --- fr/marketplace.json ---
	const frMarketplacePath = path.join(webviewLocalesDir, "fr", "marketplace.json")
	const frMarketplace = readJSON(frMarketplacePath)
	if (frMarketplace && enFiles["marketplace.json"]) {
		const frKeys = getLeafKeys(frMarketplace)
		const enKeys = enFiles["marketplace.json"].keys
		const surplus = frKeys.filter((k) => !enKeys.has(k))
		if (surplus.length > 0) {
			console.log(`\n  fr/marketplace.json: ${surplus.length} surplus keys found`)
			removed["fr/marketplace.json"] = []
			for (const key of surplus) {
				deleteByPath(frMarketplace, key)
				console.log(`    REMOVED: ${key}`)
				removed["fr/marketplace.json"].push(key)
			}
			writeJSON(frMarketplacePath, frMarketplace)
		} else {
			console.log(`\n  fr/marketplace.json: no surplus keys`)
		}
	}

	// --- fr/prompts.json ---
	const frPromptsPath = path.join(webviewLocalesDir, "fr", "prompts.json")
	const frPrompts = readJSON(frPromptsPath)
	if (frPrompts && enFiles["prompts.json"]) {
		const frKeys = getLeafKeys(frPrompts)
		const enKeys = enFiles["prompts.json"].keys
		const surplus = frKeys.filter((k) => !enKeys.has(k))
		if (surplus.length > 0) {
			console.log(`\n  fr/prompts.json: ${surplus.length} surplus keys found`)
			removed["fr/prompts.json"] = []
			for (const key of surplus) {
				deleteByPath(frPrompts, key)
				console.log(`    REMOVED: ${key}`)
				removed["fr/prompts.json"].push(key)
			}
			writeJSON(frPromptsPath, frPrompts)
		} else {
			console.log(`\n  fr/prompts.json: no surplus keys`)
		}
	}

	return removed
}

// ========== RUN ==========

console.log("=".repeat(60))
console.log("i18n Translation Gap Fixer")
console.log("=".repeat(60))

const result1 = fixBackendSkills()
const result2 = fixWebviewSettings()
const result3 = reconcileSurplusKeys()

console.log("\n" + "=".repeat(60))
console.log("SUMMARY")
console.log("=".repeat(60))
console.log(`Issue 1 (skills.json): Added errors.invalid_structure to ${result1 || 0} locales`)
if (result2) {
	const total = Object.values(result2).reduce((a, b) => a + b, 0)
	console.log(`Issue 2 (settings.json): Added ${total} missing keys across ${Object.keys(result2).length} locales`)
	for (const [loc, count] of Object.entries(result2)) {
		console.log(`  ${loc}: ${count} keys added`)
	}
}
console.log(`Issue 3 (surplus keys):`)
for (const [file, keys] of Object.entries(result3 || {})) {
	console.log(`  ${file}: ${keys.length} keys removed`)
	keys.forEach((k) => console.log(`    - ${k}`))
}
console.log("\nDone!")
