# Code Reviewer Skill

Performs systematic code review with configurable rule sets.

## Usage

Triggered by `/code-reviewer` with args `[file-path]` or `[pr-url]`.

## Required Context

- `REVIEW_SCOPE`: changed files or full directory
- `RULES_DIR`: path to custom review rules

## Output

Review comments with severity, line references, and suggestions.
