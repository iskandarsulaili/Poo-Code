# Docs Writer Skill

Generates and maintains project documentation files.

## Usage

Triggered by `/docs-writer` with args `[doc-type] [topic]`.

## Required Context

- `DOCS_DIR`: documentation output directory
- `FILE_PATTERNS`: source files to document

## Output

Markdown documentation file(s) with TOC, examples, and API references.
