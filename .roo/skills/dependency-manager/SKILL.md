# Dependency Manager Skill

Audits, updates, and manages project dependencies safely.

## Usage

Triggered by `/dependency-manager` with args `[action] [package-name]`.

## Required Context

- `PACKAGE_MANAGER`: npm / yarn / pnpm
- `PROJECT_DIR`: project root

## Output

Updated package.json, lockfile changes, or audit report.
