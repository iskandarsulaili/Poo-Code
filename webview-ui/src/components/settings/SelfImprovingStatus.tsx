import { useAppTranslation } from "@src/i18n/TranslationContext"
import { useExtensionState } from "@src/context/ExtensionStateContext"

export const SelfImprovingStatus = () => {
	const { t } = useAppTranslation()
	const { selfImprovingStatus, experiments } = useExtensionState()

	const isExperimentEnabled = experiments?.selfImproving ?? false
	const status = selfImprovingStatus

	if (!isExperimentEnabled) {
		return null
	}

	if (!status) {
		return (
			<div className="mt-3 rounded border border-vscode-panel-border bg-vscode-editor-background p-3 text-sm">
				<p className="text-vscode-descriptionForeground">
					{t("settings:experimental.SELF_IMPROVING.statusLoading", { defaultValue: "Loading status..." })}
				</p>
			</div>
		)
	}

	return (
		<div className="mt-3 rounded border border-vscode-panel-border bg-vscode-editor-background p-3 text-sm">
			<h4 className="mb-2 font-medium">
				{t("settings:experimental.SELF_IMPROVING.statusTitle", { defaultValue: "Self-Improving Status" })}
			</h4>
			<table className="w-full text-xs">
				<tbody>
					<tr className="border-b border-vscode-panel-border">
						<td className="py-1 pr-3 text-vscode-descriptionForeground">
							{t("settings:experimental.SELF_IMPROVING.statusEnabled", { defaultValue: "Enabled" })}
						</td>
						<td className="py-1 text-right font-medium">{status.enabled ? "Yes" : "No"}</td>
					</tr>
					<tr className="border-b border-vscode-panel-border">
						<td className="py-1 pr-3 text-vscode-descriptionForeground">
							{t("settings:experimental.SELF_IMPROVING.statusStarted", { defaultValue: "Started" })}
						</td>
						<td className="py-1 text-right font-medium">{status.started ? "Yes" : "No"}</td>
					</tr>
					<tr className="border-b border-vscode-panel-border">
						<td className="py-1 pr-3 text-vscode-descriptionForeground">
							{t("settings:experimental.SELF_IMPROVING.statusPatterns", { defaultValue: "Patterns" })}
						</td>
						<td className="py-1 text-right font-medium">{status.patternCount}</td>
					</tr>
					<tr className="border-b border-vscode-panel-border">
						<td className="py-1 pr-3 text-vscode-descriptionForeground">
							{t("settings:experimental.SELF_IMPROVING.statusEvents", { defaultValue: "Events" })}
						</td>
						<td className="py-1 text-right font-medium">{status.eventCount}</td>
					</tr>
					<tr className="border-b border-vscode-panel-border">
						<td className="py-1 pr-3 text-vscode-descriptionForeground">
							{t("settings:experimental.SELF_IMPROVING.statusActions", { defaultValue: "Pending Actions" })}
						</td>
						<td className="py-1 text-right font-medium">{status.actionCount}</td>
					</tr>
					<tr className="border-b border-vscode-panel-border">
						<td className="py-1 pr-3 text-vscode-descriptionForeground">
							{t("settings:experimental.SELF_IMPROVING.statusMemory", { defaultValue: "Memory Entries" })}
						</td>
						<td className="py-1 text-right font-medium">{status.memoryEntries}</td>
					</tr>
					<tr className="border-b border-vscode-panel-border">
						<td className="py-1 pr-3 text-vscode-descriptionForeground">
							{t("settings:experimental.SELF_IMPROVING.statusSkills", { defaultValue: "Skill Records" })}
						</td>
						<td className="py-1 text-right font-medium">{status.skillRecords}</td>
					</tr>
					<tr className="border-b border-vscode-panel-border">
						<td className="py-1 pr-3 text-vscode-descriptionForeground">
							{t("settings:experimental.SELF_IMPROVING.statusBackend", { defaultValue: "Memory Backend" })}
						</td>
						<td className="py-1 text-right font-medium">{status.memoryBackend ?? "builtin"}</td>
					</tr>
					{status.lastReviewAt && (
						<tr className="border-b border-vscode-panel-border">
							<td className="py-1 pr-3 text-vscode-descriptionForeground">
								{t("settings:experimental.SELF_IMPROVING.statusLastReview", {
									defaultValue: "Last Review",
								})}
							</td>
							<td className="py-1 text-right font-medium">
								{new Date(status.lastReviewAt).toLocaleTimeString()}
							</td>
						</tr>
					)}
					{status.lastCuratorRunAt && (
						<tr>
							<td className="py-1 pr-3 text-vscode-descriptionForeground">
								{t("settings:experimental.SELF_IMPROVING.statusLastCurator", {
									defaultValue: "Last Curator Run",
								})}
							</td>
							<td className="py-1 text-right font-medium">
								{new Date(status.lastCuratorRunAt).toLocaleTimeString()}
							</td>
						</tr>
					)}
				</tbody>
			</table>
		</div>
	)
}
