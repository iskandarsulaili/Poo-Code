/**
 * Comprehensive i18n gap fixer - v2
 *
 * Fixes:
 * 1. Missing errors.invalid_structure in backend skills.json (17 locales)
 * 2. Missing settings.json keys in webview-ui (17 locales)
 *    Handles dotted key names (e.g. "enableVerification.description")
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
 * Recursively collect all leaf entries (key + value) from a nested object.
 * Returns array of {key, value} where key is dot-separated path.
 * Handles dotted key names correctly by treating the raw JSON key as-is.
 */
function getLeafEntries(obj, prefix = "") {
	const entries = []
	for (const [rawKey, value] of Object.entries(obj)) {
		// Use the original path: prefix + rawKey (don't split on dots)
		const fullKey = prefix ? `${prefix}.${rawKey}` : rawKey
		if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			entries.push(...getLeafEntries(value, fullKey))
		} else {
			entries.push({ key: fullKey, value })
		}
	}
	return entries
}

/**
 * Get a value from a nested object using a dot-separated path.
 * BUT: this function may fail for keys with literal dots in the name.
 * Use safeGetByKey as fallback.
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
 * Deep-set a value in a nested object.
 * Handles dotted key names by detecting when traversal hits a non-object value.
 */
function deepSet(obj, pathStr, value) {
	const parts = pathStr.split(".")
	let current = obj

	for (let i = 0; i < parts.length - 1; i++) {
		const part = parts[i]

		// If we hit a non-object (e.g. string), we need to handle dotted key names
		if (current[part] !== undefined && (typeof current[part] !== "object" || current[part] === null)) {
			// This means "part" exists but is a value, not an object.
			// The remaining path (parts[i..]) should be treated as a single flat key.
			const flatKey = parts.slice(i).join(".")
			current[flatKey] = value
			return
		}

		if (!(part in current) || current[part] === null) {
			current[part] = {}
		}
		current = current[part]
	}

	// Set the final part
	current[parts[parts.length - 1]] = value
}

/**
 * Deep delete by dot-separated path.
 * Same dotted key handling as deepSet.
 */
function deepDelete(obj, pathStr) {
	const parts = pathStr.split(".")
	let current = obj

	for (let i = 0; i < parts.length - 1; i++) {
		const part = parts[i]
		if (current[part] === undefined || current[part] === null) return

		if (typeof current[part] !== "object") {
			// Dotted key name - delete the flat key
			const flatKey = parts.slice(i).join(".")
			delete current[flatKey]
			return
		}
		current = current[part]
	}

	delete current[parts[parts.length - 1]]
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

	// Get the English value using getByPath (works for normal keys)
	const enEntries = getLeafEntries(enSkills)
	const invalidStructEntry = enEntries.find((e) => e.key === "errors.invalid_structure")
	if (!invalidStructEntry) {
		console.error("  ERROR: errors.invalid_structure not found in English source!")
		return
	}

	const englishValue = invalidStructEntry.value
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

		// Check if errors.invalid_structure already exists - use entries to handle traversal issues
		const localeEntries = getLeafEntries(data)
		const exists = localeEntries.some((e) => e.key === "errors.invalid_structure")
		if (exists) {
			continue
		}

		// Add it. Since "errors" is an object and "invalid_structure" is a normal key, deepSet works fine.
		if (!data.errors) {
			data.errors = {}
		}
		data.errors.invalid_structure = englishValue

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

	const enEntries = getLeafEntries(enSettings)
	console.log(`  English has ${enEntries.length} leaf keys`)

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

		// Get all leaf entries from locale for comparison
		const localeEntries = getLeafEntries(data)
		const localeKeySet = new Set(localeEntries.map((e) => e.key))

		const added = []
		for (const { key, value } of enEntries) {
			if (!localeKeySet.has(key)) {
				deepSet(data, key, value)
				added.push({ key, value: typeof value === "string" ? value : JSON.stringify(value) })
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

// ========== ISSUE 3: Surplus key reconciliation ==========

function reconcileSurplusKeys() {
	console.log("\n=== ISSUE 3: Surplus key reconciliation ===")

	const webviewLocalesDir = path.join(ROOT, "webview-ui", "src", "i18n", "locales")

	// Read English files and get their key sets
	const enFiles = {}
	for (const name of ["chat.json", "history.json", "marketplace.json", "prompts.json"]) {
		const path_ = path.join(webviewLocalesDir, "en", name)
		const data = readJSON(path_)
		if (data) {
			const entries = getLeafEntries(data)
			enFiles[name] = { data, keys: new Set(entries.map((e) => e.key)) }
			console.log(`  English ${name}: ${enFiles[name].keys.size} keys`)
		}
	}

	const removed = {}

	// Helper to check and remove surplus keys from a file
	const checkFile = (locale, name) => {
		const filePath = path.join(webviewLocalesDir, locale, name)
		const data = readJSON(filePath)
		if (!data || !enFiles[name]) return

		const entries = getLeafEntries(data)
		const enKeys = enFiles[name].keys
		const surplus = entries.filter((e) => !enKeys.has(e.key))

		if (surplus.length > 0) {
			const key = `${locale}/${name}`
			console.log(`\n  ${key}: ${surplus.length} surplus keys found`)
			removed[key] = []
			for (const { key: k } of surplus) {
				deepDelete(data, k)
				console.log(`    REMOVED: ${k}`)
				removed[key].push(k)
			}
			writeJSON(filePath, data)
		} else {
			console.log(`\n  ${locale}/${name}: no surplus keys`)
		}
	}

	checkFile("id", "chat.json")
	checkFile("zh-TW", "chat.json")
	checkFile("fr", "history.json")
	checkFile("fr", "marketplace.json")
	checkFile("fr", "prompts.json")

	return removed
}

// ========== RUN ==========

console.log("=".repeat(60))
console.log("i18n Translation Gap Fixer v2")
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
if (result3 && Object.keys(result3).length > 0) {
	console.log(`Issue 3 (surplus keys):`)
	for (const [file, keys] of Object.entries(result3)) {
		console.log(`  ${file}: ${keys.length} keys removed`)
	}
} else {
	console.log(`Issue 3 (surplus keys): none found`)
}
console.log("\nDone!")
