import { HTMLAttributes } from "react"

import type { Experiments, ImageGenerationProvider } from "@roo-code/types"

import { EXPERIMENT_IDS, experimentConfigsMap } from "@roo/experiments"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui"
import { cn } from "@src/lib/utils"

import { SetExperimentEnabled } from "./types"
import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"
import { SearchableSetting } from "./SearchableSetting"
import { ExperimentalFeature } from "./ExperimentalFeature"
import { ImageGenerationSettings } from "./ImageGenerationSettings"
import { CustomToolsSettings } from "./CustomToolsSettings"

type ExperimentalSettingsProps = HTMLAttributes<HTMLDivElement> & {
	experiments: Experiments
	setExperimentEnabled: SetExperimentEnabled
	apiConfiguration?: any
	setApiConfigurationField?: any
	imageGenerationProvider?: ImageGenerationProvider
	openRouterImageApiKey?: string
	openRouterImageGenerationSelectedModel?: string
	memoryBackend?: "builtin" | "agentmemory"
	agentMemoryUrl?: string
	setImageGenerationProvider?: (provider: ImageGenerationProvider) => void
	setOpenRouterImageApiKey?: (apiKey: string) => void
	setImageGenerationSelectedModel?: (model: string) => void
	setMemoryBackend?: (backend: "builtin" | "agentmemory") => void
	setAgentMemoryUrl?: (url: string) => void
}

export const ExperimentalSettings = ({
	experiments,
	setExperimentEnabled,
	apiConfiguration,
	setApiConfigurationField,
	imageGenerationProvider,
	openRouterImageApiKey,
	openRouterImageGenerationSelectedModel,
	memoryBackend,
	agentMemoryUrl,
	setImageGenerationProvider,
	setOpenRouterImageApiKey,
	setImageGenerationSelectedModel,
	setMemoryBackend,
	setAgentMemoryUrl,
	className,
	...props
}: ExperimentalSettingsProps) => {
	const { t } = useAppTranslation()
	const autoSkillsVisible = experiments[EXPERIMENT_IDS.SELF_IMPROVING] ?? false
	const currentMemoryBackend = memoryBackend ?? "builtin"

	return (
		<div className={cn("flex flex-col gap-2", className)} {...props}>
			<SectionHeader>{t("settings:sections.experimental")}</SectionHeader>

			<Section>
				{Object.entries(experimentConfigsMap)
					.filter(([key]) => key in EXPERIMENT_IDS && key !== "SELF_IMPROVING_AUTO_SKILLS")
					.map((config) => {
						const experimentKey = config[0]
						const label = t(`settings:experimental.${experimentKey}.name`)

						if (
							config[0] === "IMAGE_GENERATION" &&
							setImageGenerationProvider &&
							setOpenRouterImageApiKey &&
							setImageGenerationSelectedModel
						) {
							return (
								<SearchableSetting
									key={config[0]}
									settingId={`experimental-${config[0].toLowerCase()}`}
									section="experimental"
									label={label}>
									<ImageGenerationSettings
										enabled={experiments[EXPERIMENT_IDS.IMAGE_GENERATION] ?? false}
										onChange={(enabled) =>
											setExperimentEnabled(EXPERIMENT_IDS.IMAGE_GENERATION, enabled)
										}
										imageGenerationProvider={imageGenerationProvider}
										openRouterImageApiKey={openRouterImageApiKey}
										openRouterImageGenerationSelectedModel={openRouterImageGenerationSelectedModel}
										setImageGenerationProvider={setImageGenerationProvider}
										setOpenRouterImageApiKey={setOpenRouterImageApiKey}
										setImageGenerationSelectedModel={setImageGenerationSelectedModel}
									/>
								</SearchableSetting>
							)
						}
						if (config[0] === "CUSTOM_TOOLS") {
							return (
								<SearchableSetting
									key={config[0]}
									settingId={`experimental-${config[0].toLowerCase()}`}
									section="experimental"
									label={label}>
									<CustomToolsSettings
										enabled={experiments[EXPERIMENT_IDS.CUSTOM_TOOLS] ?? false}
										onChange={(enabled) =>
											setExperimentEnabled(EXPERIMENT_IDS.CUSTOM_TOOLS, enabled)
										}
									/>
								</SearchableSetting>
							)
						}
						if (config[0] === "SELF_IMPROVING") {
							return (
								<SearchableSetting
									key={config[0]}
									settingId={`experimental-${config[0].toLowerCase()}`}
									section="experimental"
									label={label}>
									<div className="space-y-3">
										<ExperimentalFeature
											experimentKey={config[0]}
											enabled={experiments[EXPERIMENT_IDS.SELF_IMPROVING] ?? false}
											onChange={(enabled) =>
												setExperimentEnabled(EXPERIMENT_IDS.SELF_IMPROVING, enabled)
											}
											checkboxTestId="experimental-self-improving-checkbox"
										/>
										{autoSkillsVisible && (
											<div className="ml-6 space-y-3 border-l border-vscode-panel-border pl-4">
												<ExperimentalFeature
													experimentKey="SELF_IMPROVING_AUTO_SKILLS"
													enabled={
														experiments[EXPERIMENT_IDS.SELF_IMPROVING_AUTO_SKILLS] ?? false
													}
													onChange={(enabled) =>
														setExperimentEnabled(
															EXPERIMENT_IDS.SELF_IMPROVING_AUTO_SKILLS,
															enabled,
														)
													}
													checkboxTestId="experimental-self-improving-auto-skills-checkbox"
												/>
												{setMemoryBackend && (
													<div className="space-y-2">
														<label className="block font-medium">
															{t(
																"settings:experimental.SELF_IMPROVING.memoryBackendLabel",
																{
																	defaultValue: "Memory backend",
																},
															)}
														</label>
														<Select
															value={currentMemoryBackend}
															onValueChange={(value) =>
																setMemoryBackend(value as "builtin" | "agentmemory")
															}
															data-testid="self-improving-memory-backend-select">
															<SelectTrigger className="w-full">
																<SelectValue
																	placeholder={t("settings:common.select")}
																/>
															</SelectTrigger>
															<SelectContent>
																<SelectItem value="builtin">Built-in</SelectItem>
																<SelectItem value="agentmemory">agentmemory</SelectItem>
															</SelectContent>
														</Select>
													</div>
												)}
												{currentMemoryBackend === "agentmemory" && setAgentMemoryUrl && (
													<div className="space-y-2">
														<label className="block font-medium">
															{t(
																"settings:experimental.SELF_IMPROVING.agentMemoryUrlLabel",
																{
																	defaultValue: "agentmemory URL",
																},
															)}
														</label>
														<Input
															value={agentMemoryUrl ?? "http://localhost:3111"}
															onChange={(event) => setAgentMemoryUrl(event.target.value)}
															placeholder="http://localhost:3111"
															data-testid="self-improving-agent-memory-url-input"
														/>
													</div>
												)}
											</div>
										)}
									</div>
								</SearchableSetting>
							)
						}
						return (
							<SearchableSetting
								key={config[0]}
								settingId={`experimental-${config[0].toLowerCase()}`}
								section="experimental"
								label={label}>
								<ExperimentalFeature
									experimentKey={config[0]}
									enabled={
										experiments[EXPERIMENT_IDS[config[0] as keyof typeof EXPERIMENT_IDS]] ?? false
									}
									onChange={(enabled) =>
										setExperimentEnabled(
											EXPERIMENT_IDS[config[0] as keyof typeof EXPERIMENT_IDS],
											enabled,
										)
									}
								/>
							</SearchableSetting>
						)
					})}
			</Section>
		</div>
	)
}
