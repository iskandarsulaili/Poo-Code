# Git Workflow Skill

Manages branching strategies, commit conventions, and automated changelog generation.

## Usage

Triggered by `/git-workflow` with args `[action] [branch]`.

## Required Context

- `GIT_BRANCH`: current branch name
- `GIT_REPO`: repository path

## Output

Branch name, commit message template, or changelog diff.
