/**
 * Barrel export for language-specific output parsers.
 *
 * Re-exports all parser plugins and provides a convenience function
 * to register all built-in parsers with an OutputParser instance.
 *
 * @module
 */

import type { ParserPlugin } from "@roo-code/types"
import type { OutputParser } from "../OutputParser"

import { TypeScriptParser } from "./TypeScriptParser"
import { PythonParser } from "./PythonParser"
import { KotlinParser } from "./KotlinParser"
import { GoParser } from "./GoParser"
import { RustParser } from "./RustParser"

export { TypeScriptParser } from "./TypeScriptParser"
export { PythonParser } from "./PythonParser"
export { KotlinParser } from "./KotlinParser"
export { GoParser } from "./GoParser"
export { RustParser } from "./RustParser"

/**
 * Array of all built-in parser plugins.
 * Useful for iterating, testing, or selective registration.
 */
export const BUILT_IN_PARSERS: ParserPlugin[] = [TypeScriptParser, PythonParser, KotlinParser, GoParser, RustParser]

/**
 * Register all built-in language parsers with an OutputParser instance.
 *
 * Each parser is registered with its corresponding language key,
 * enabling automatic parser selection when the language is known.
 *
 * @param parser - The OutputParser instance to register parsers with
 *
 * @example
 * ```ts
 * import { OutputParser } from "../OutputParser"
 * import { registerAllParsers } from "./index"
 *
 * const parser = new OutputParser()
 * registerAllParsers(parser)
 * ```
 */
export function registerAllParsers(parser: OutputParser): void {
	parser.registerParser("typescript", TypeScriptParser)
	parser.registerParser("python", PythonParser)
	parser.registerParser("kotlin", KotlinParser)
	parser.registerParser("go", GoParser)
	parser.registerParser("rust", RustParser)
}
