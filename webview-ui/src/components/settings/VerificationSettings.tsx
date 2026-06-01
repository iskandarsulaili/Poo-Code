import { useMemo, useCallback } from "react"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { Input } from "@/components/ui"
import { X } from "lucide-react"

import type { AutoDetectedProfile, Experiments, ModeConfig, VerificationLevel } from "@roo-code/types"

import { EXPERIMENT_IDS } from "@roo/experiments"
import { getAllModes } from "@roo/modes"

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui"
import { SearchableSetting } from "./SearchableSetting"
import { Section } from "./Section"
import { SetExperimentEnabled } from "./types"

type VerificationSettingsProps = {
	customModes: ModeConfig[]
	lenientModes: string[]
	verificationLevel: VerificationLevel | undefined
	verificationLevels: Record<string, VerificationLevel> | undefined
	setLenientModes: (modes: string[]) => void
	setVerificationLevel: (level: VerificationLevel) => void
	setVerificationLevels: (levels: Record<string, VerificationLevel>) => void
	experiments: Experiments
	setExperimentEnabled: SetExperimentEnabled

	// Gate config
	verificationCheckBuild?: boolean
	verificationCheckLint?: boolean
	verificationCheckTypes?: boolean
	verificationCheckTests?: boolean
	verificationBuildCommand?: string
	verificationLintCommand?: string
	verificationTypeCheckCommand?: string
	verificationTestCommand?: string
	verificationTimeoutMs?: number
	onVerificationGateChange?: (key: string, value: boolean | string | number) => void

	// Auto-detected profile from the engine
	autoDetectedProfile?: AutoDetectedProfile
	autoDetectingVerification?: boolean
}

const VERIFICATION_LEVEL_OPTIONS: { value: VerificationLevel; label: string }[] = [
	{ value: "strict", label: "Strict — All requirements must be verified" },
	{ value: "lenient", label: "Lenient — Log warnings, don't block" },
	{ value: "bypass", label: "Bypass — Skip requirements verification" },
]

type GateDef = {
	key: string
	label: string
	checkKey: string
	cmdKey: string
}

const GATES: GateDef[] = [
	{ key: "build", label: "Build", checkKey: "verificationCheckBuild", cmdKey: "verificationBuildCommand" },
	{ key: "lint", label: "Lint", checkKey: "verificationCheckLint", cmdKey: "verificationLintCommand" },
	{
		key: "type-check",
		label: "Type Check",
		checkKey: "verificationCheckTypes",
		cmdKey: "verificationTypeCheckCommand",
	},
	{ key: "tests", label: "Tests", checkKey: "verificationCheckTests", cmdKey: "verificationTestCommand" },
]

export const VerificationSettings = ({
	customModes,
	lenientModes,
	verificationLevel,
	verificationLevels,
	setLenientModes,
	setVerificationLevel,
	setVerificationLevels,
	experiments,
	setExperimentEnabled,
	verificationCheckBuild,
	verificationCheckLint,
	verificationCheckTypes,
	verificationCheckTests,
	verificationBuildCommand,
	verificationLintCommand,
	verificationTypeCheckCommand,
	verificationTestCommand,
	verificationTimeoutMs,
	onVerificationGateChange,
	autoDetectedProfile,
	autoDetectingVerification,
}: VerificationSettingsProps) => {
	const allModes = useMemo(() => getAllModes(customModes), [customModes])

	const lenientSet = useMemo(() => new Set(lenientModes ?? []), [lenientModes])
	const levels = useMemo(() => verificationLevels ?? {}, [verificationLevels])

	// Master toggle: enabled when either verification engine or requirements verification is on
	const verificationEngineEnabled = experiments[EXPERIMENT_IDS.VERIFICATION_ENGINE] ?? false
	const requirementsVerificationEnabled = experiments[EXPERIMENT_IDS.REQUIREMENTS_VERIFICATION] ?? false
	const masterEnabled = verificationEngineEnabled || requirementsVerificationEnabled

	const handleMasterToggle = useCallback(
		(enabled: boolean) => {
			setExperimentEnabled(EXPERIMENT_IDS.VERIFICATION_ENGINE, enabled)
			setExperimentEnabled(EXPERIMENT_IDS.REQUIREMENTS_VERIFICATION, enabled)
		},
		[setExperimentEnabled],
	)

	const handleModeToggle = useCallback(
		(slug: string, checked: boolean) => {
			const updated = checked ? [...(lenientModes ?? []), slug] : (lenientModes ?? []).filter((m) => m !== slug)
			setLenientModes(updated)
		},
		[lenientModes, setLenientModes],
	)

	const handleLevelChange = useCallback(
		(slug: string, level: VerificationLevel) => {
			setVerificationLevels({ ...levels, [slug]: level })
		},
		[levels, setVerificationLevels],
	)

	/**
	 * Resolve the effective command for a gate using tiered priority:
	 *  Tier 1: User override (experiments value) — highest priority
	 *  Tier 2: Auto-detected from project files
	 *  Tier 3: Hardcoded fallback
	 */
	const resolveCommand = useCallback(
		(
			gateKey: string,
			_checkKey: string,
			cmdKey: string,
		): { command: string; sourceLabel: string | null; isOverride: boolean } => {
			// Get the user override value from experiment props
			const getOverrideCommand = (key: string): string | undefined => {
				switch (key) {
					case "verificationBuildCommand":
						return verificationBuildCommand
					case "verificationLintCommand":
						return verificationLintCommand
					case "verificationTypeCheckCommand":
						return verificationTypeCheckCommand
					case "verificationTestCommand":
						return verificationTestCommand
					default:
						return undefined
				}
			}

			const userOverride = getOverrideCommand(cmdKey)

			// Tier 1: User has explicitly set a command override
			if (userOverride) {
				return { command: userOverride, sourceLabel: null, isOverride: true }
			}

			// Tier 2: Auto-detected from project
			if (autoDetectedProfile) {
				const detected = autoDetectedProfile[gateKey as keyof AutoDetectedProfile] as
					| { command?: string | null; source?: string | null }
					| undefined
				if (detected?.command) {
					const sourceLabel = detected.source
						? ({
								"package.json": "package.json",
								cargo: "Cargo.toml",
								"go-mod": "go.mod",
								gradle: "build.gradle",
								maven: "pom.xml",
								dotnet: "*.csproj",
								zig: "build.zig",
								deno: "deno.json",
								mix: "mix.exs",
								gemfile: "Gemfile",
								pyproject: "pyproject.toml",
								detected: "detected",
								fallback: "default",
							}[detected.source] ?? detected.source)
						: null
					return {
						command: detected.command,
						sourceLabel: sourceLabel ? `from ${sourceLabel}` : null,
						isOverride: false,
					}
				}
			}

			// Tier 3: Hardcoded fallback
			const hardcoded = getHardcodedDefault(gateKey)
			return { command: "", sourceLabel: hardcoded ? "default" : null, isOverride: false }
		},
		[
			autoDetectedProfile,
			verificationBuildCommand,
			verificationLintCommand,
			verificationTypeCheckCommand,
			verificationTestCommand,
		],
	)

	const handleResetCommand = useCallback(
		(cmdKey: string) => {
			onVerificationGateChange?.(cmdKey, "")
		},
		[onVerificationGateChange],
	)

	return (
		<Section>
			{/* Master Enable/Disable Toggle */}
			<SearchableSetting
				settingId="experimental-verification-master-toggle"
				section="experimental"
				label="Enable Verification"
				description="Master toggle for all verification features. When disabled, both code quality verification and requirements verification are skipped.">
				<VSCodeCheckbox checked={masterEnabled} onChange={(e: any) => handleMasterToggle(e.target.checked)} />
			</SearchableSetting>

			{/* Default Verification Level */}
			<SearchableSetting
				settingId="experimental-verification-level"
				section="experimental"
				label="Default Verification Level"
				description="Controls how requirements verification behaves on attempt_completion by default">
				<Select
					value={verificationLevel ?? "strict"}
					onValueChange={(value: VerificationLevel) => setVerificationLevel(value)}
					disabled={!masterEnabled}>
					<SelectTrigger data-testid="experimental-verification-level-select">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{VERIFICATION_LEVEL_OPTIONS.map((opt) => (
							<SelectItem key={opt.value} value={opt.value}>
								{opt.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</SearchableSetting>

			{/* Per-Mode Verification Settings */}
			<div className={`flex flex-col gap-1 ${!masterEnabled ? "opacity-50 pointer-events-none" : ""}`}>
				<span className="text-vscode-foreground text-sm font-medium">Per-Mode Verification</span>
				<span className="text-vscode-descriptionForeground text-xs mb-2">
					Override verification behavior for specific modes. Checked modes use lenient/bypass instead of the
					default level.
				</span>
				{allModes.map((m) => {
					const slug = m.slug
					const isLenient = lenientSet.has(slug)
					const level = levels[slug] ?? verificationLevel ?? "strict"
					return (
						<div key={slug} className="flex items-center gap-2">
							<VSCodeCheckbox
								checked={isLenient}
								onChange={(e: any) => handleModeToggle(slug, e.target.checked)}>
								{slug}
							</VSCodeCheckbox>
							<Select value={level} onValueChange={(v: VerificationLevel) => handleLevelChange(slug, v)}>
								<SelectTrigger
									className="w-[160px]"
									data-testid={`experimental-verification-level-${slug}`}>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{VERIFICATION_LEVEL_OPTIONS.map((opt) => (
										<SelectItem key={opt.value} value={opt.value}>
											{opt.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					)
				})}
			</div>

			{/* --- Code Quality Gates --- */}
			<div className={`flex flex-col gap-3 mt-4 ${!masterEnabled ? "opacity-50 pointer-events-none" : ""}`}>
				<span className="text-vscode-foreground text-sm font-medium">Code Quality Gates</span>
				<span className="text-vscode-descriptionForeground text-xs mb-1">
					Configure which checks run on attempt_completion. The engine auto-detects your project language and
					fills default commands — override them here.
				</span>

				{/* Auto-detection status */}
				{autoDetectingVerification && (
					<div className="text-xs text-vscode-descriptionForeground italic">
						Auto-detecting project profile...
					</div>
				)}
				{!autoDetectingVerification && autoDetectedProfile && !autoDetectedProfile.language && (
					<div className="text-xs text-vscode-descriptionForeground">
						No recognized project files detected. Falling back to generic defaults.
					</div>
				)}
				{!autoDetectingVerification && autoDetectedProfile?.language && (
					<div className="text-xs text-vscode-descriptionForeground">
						Detected project: <span className="font-medium">{autoDetectedProfile.language}</span>
					</div>
				)}

				{/* Timeout */}
				<SearchableSetting
					settingId="experimental-verification-timeout"
					section="experimental"
					label="Gate Timeout (ms)"
					description="Max time per gate in milliseconds (default: 60000)">
					<Input
						value={String(verificationTimeoutMs ?? 60000)}
						onChange={(e: any) =>
							onVerificationGateChange?.("verificationTimeoutMs", parseInt(e.target.value) || 60000)
						}
						disabled={!masterEnabled}
						type="number"
						style={{ width: "120px" }}
					/>
				</SearchableSetting>

				{GATES.map((gate) => {
					const checked =
						gate.checkKey === "verificationCheckBuild"
							? (verificationCheckBuild ?? false)
							: gate.checkKey === "verificationCheckLint"
								? (verificationCheckLint ?? false)
								: gate.checkKey === "verificationCheckTypes"
									? (verificationCheckTypes ?? false)
									: (verificationCheckTests ?? false)

					const { command, sourceLabel, isOverride } = resolveCommand(gate.key, gate.checkKey, gate.cmdKey)
					const hardcodedDefault = getHardcodedDefault(gate.key)

					return (
						<div key={gate.key} className="flex flex-col gap-1 mb-2">
							<div className="flex items-center gap-2">
								<VSCodeCheckbox
									checked={checked}
									onChange={(e: any) => onVerificationGateChange?.(gate.checkKey, e.target.checked)}
									disabled={!masterEnabled}>
									{gate.label}
								</VSCodeCheckbox>
							</div>
							{checked && (
								<div className="flex items-center gap-2">
									<div className="flex-1 relative">
										<Input
											value={command}
											placeholder={hardcodedDefault}
											onChange={(e: any) =>
												onVerificationGateChange?.(gate.cmdKey, e.target.value)
											}
											disabled={!masterEnabled}
											style={{ width: "100%" }}
										/>
									</div>
									{/* Source badge */}
									{sourceLabel && !isOverride && (
										<span className="text-xs text-vscode-descriptionForeground whitespace-nowrap">
											{sourceLabel}
										</span>
									)}
									{/* Reset button — only show when there's a user override */}
									{isOverride && (
										<button
											type="button"
											onClick={() => handleResetCommand(gate.cmdKey)}
											disabled={!masterEnabled}
											className="p-1 text-vscode-descriptionForeground hover:text-vscode-foreground transition-colors disabled:opacity-50"
											title="Reset to auto-detected or default">
											<X size={14} />
										</button>
									)}
								</div>
							)}
						</div>
					)
				})}
			</div>
		</Section>
	)
}

function getHardcodedDefault(gate: string): string {
	switch (gate) {
		case "build":
			return "npm run build"
		case "lint":
			return "npm run lint"
		case "type-check":
			return "npm run typecheck"
		case "tests":
			return "npm test"
		default:
			return ""
	}
}
