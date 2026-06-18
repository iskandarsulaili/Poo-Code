import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"
import App from "./App"
import "../node_modules/@vscode/codicons/dist/codicon.css"

import { getHighlighter } from "./utils/highlighter"

/*
 * Service Worker Safety Guard for VS Code Webview
 *
 * VS Code webviews use a vscode-webview:// URI scheme, which is NOT a secure
 * context (only https:// and localhost qualify). Service workers require a
 * secure context to register. Any code (first-party or third-party) that
 * attempts to register a service worker will fail with:
 *   "InvalidStateError: Failed to register a ServiceWorker: The document is
 *    in an invalid state."
 *
 * This guard wraps navigator.serviceWorker.register in a safe no-op that:
 * 1. Checks window.isSecureContext before attempting registration
 * 2. Wraps the registration call in try/catch for graceful degradation
 * 3. Logs failures as warnings instead of crashing the webview
 */
function applyServiceWorkerSafety() {
	if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
		return
	}

	const originalRegister = navigator.serviceWorker.register.bind(navigator.serviceWorker)

	navigator.serviceWorker.register = async (scriptURL, options) => {
		if (!window.isSecureContext) {
			console.warn("[SW-Guard] Service worker registration skipped: document is not a secure context")
			// Return a dummy registration that satisfies the API contract
			// without requiring an actual service worker.
			return {} as ServiceWorkerRegistration
		}

		try {
			return await originalRegister(scriptURL, options)
		} catch (error) {
			console.warn(
				"[SW-Guard] Service worker registration failed (non-fatal):",
				error instanceof Error ? error.message : String(error),
			)
			return {} as ServiceWorkerRegistration
		}
	}
}

// Apply the service worker safety guard before any other code runs.
// This must execute before libraries or VS Code runtime attempt to register
// a service worker under the unsupported vscode-webview:// scheme.
applyServiceWorkerSafety()

// Initialize Shiki early to hide initialization latency (async)
getHighlighter().catch((error: Error) => console.error("Failed to initialize Shiki highlighter:", error))

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
)
