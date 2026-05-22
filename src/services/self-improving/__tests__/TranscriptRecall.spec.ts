import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { TranscriptRecall } from "../TranscriptRecall"

describe("TranscriptRecall", () => {
	let tempDir: string
	let logger: { appendLine: ReturnType<typeof vi.fn> }

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-transcript-"))
		logger = { appendLine: vi.fn() }
	})

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	it("records, persists, and searches transcript evidence", async () => {
		const recall = new TranscriptRecall(tempDir, logger)
		await recall.initialize()

		await recall.record({
			id: "entry-1",
			timestamp: 1,
			taskId: "task-1",
			mode: "code",
			summary: "Task failed while writing file",
			signal: "TASK_FAILURE",
			toolNames: ["write_to_file"],
			errorKey: "EACCES",
			success: false,
		})
		await recall.record({
			id: "entry-2",
			timestamp: 2,
			taskId: "task-2",
			mode: "code",
			summary: "Task completed after search",
			signal: "TASK_SUCCESS",
			toolNames: ["search_files"],
			success: true,
		})

		expect(recall.size).toBe(2)
		expect(recall.search("search_files")).toHaveLength(1)
		expect(recall.searchBySignal("TASK_FAILURE")).toHaveLength(1)
		expect(recall.searchByErrorKey("EACCES")).toHaveLength(1)

		const reloaded = new TranscriptRecall(tempDir, logger)
		await reloaded.initialize()
		expect(reloaded.getRecent(1)[0].id).toBe("entry-2")
	})

	it("clears persisted entries", async () => {
		const recall = new TranscriptRecall(tempDir, logger)
		await recall.initialize()
		await recall.record({
			id: "entry-1",
			timestamp: 1,
			summary: "Task completed",
			signal: "TASK_SUCCESS",
		})

		await recall.clear()
		expect(recall.size).toBe(0)

		const reloaded = new TranscriptRecall(tempDir, logger)
		await reloaded.initialize()
		expect(reloaded.size).toBe(0)
	})
})
