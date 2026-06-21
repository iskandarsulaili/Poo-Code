import type OpenAI from "openai"

const UPDATE_MEMORY_BANK_DESCRIPTION = `Update the project's memory bank — a set of 5 markdown files that preserve context across sessions.

The memory bank files store structured knowledge in human-readable markdown:
  productContext.md  — Project goal, high-level architecture, key features
  activeContext.md   — Current focus, recent changes, open questions
  decisionLog.md     — Architectural decisions with rationale (append-only)
  systemPatterns.md  — Coding patterns, conventions, architecture decisions
  progress.md        — Task tracking: completed, current, next steps (append-only)

Use this tool when:
- You make an architectural decision → write to decisionLog.md (append)
- You discover a pattern or convention → write to systemPatterns.md
- You complete a task or start a new one → update progress.md (append for new entries)
- The project's focus or direction changes → update activeContext.md
- Core product understanding changes → update productContext.md

Parameters:
- file: (required) Which memory bank file to update. One of: "productContext.md", "activeContext.md", "decisionLog.md", "systemPatterns.md", "progress.md"
- content: (required) The content to write. Starts with "## Section Name" for new sections. New content prepended with timestamp for append-only files (decisionLog, progress).
- mode: (optional, default: "append") How to update: "append" adds new content with timestamp, "replace" overwrites the entire file.

Examples:
{ "file": "decisionLog.md", "content": "## Decision: Use PostgreSQL over MongoDB\nDate: 2026-06-21\nRationale: Stronger relational integrity, better JSON support, team expertise\nImplementation: Added postgres dependency, created schema in migrations/", "mode": "append" }
{ "file": "activeContext.md", "content": "## Current Focus\nRefactoring the auth module to use JWT instead of session cookies.\n\n## Recent Changes\n- Added JWT utility library\n- Replaced session middleware with token verification\n\n## Open Questions\n- Token refresh strategy? Implicit refresh or explicit endpoint?", "mode": "replace" }
{ "file": "progress.md", "content": "## Current Tasks\n- [ ] Implement JWT token refresh endpoint\n- [ ] Update frontend to handle token expiry", "mode": "append" }`

export default {
  type: "function",
  function: {
    name: "update_memory_bank",
    description: UPDATE_MEMORY_BANK_DESCRIPTION,
    strict: true,
    parameters: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description: "Which memory bank file to update",
          enum: ["productContext.md", "activeContext.md", "decisionLog.md", "systemPatterns.md", "progress.md"],
        },
        content: {
          type: "string",
          description: "The content to write to the memory bank file",
        },
        mode: {
          type: "string",
          description: '"append" adds content with timestamp, "replace" overwrites the file',
          enum: ["append", "replace"],
        },
      },
      required: ["file", "content"],
    },
  },
} satisfies OpenAI.Chat.ChatCompletionTool
