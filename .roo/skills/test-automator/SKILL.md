# Test Automator Skill

Runs, generates, and maintains test suites with coverage reporting.

## Usage

Triggered by `/test-automator` with args `[test-path] [--watch] [--coverage]`.

## Required Context

- `TEST_FRAMEWORK`: vitest / jest / mocha
- `TEST_DIR`: default test directory

## Output

Test results, coverage report, or generated test files.
