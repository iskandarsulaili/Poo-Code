# Security Engineer Skill

Scans code for vulnerabilities, secrets, and compliance issues.

## Usage

Triggered by `/security-engineer` with args `[scan-type] [target-path]`.

## Required Context

- `SCAN_SCOPE`: path or dependency list
- `SEVERITY_THRESHOLD`: minimum severity to report

## Output

Vulnerability report with CVE references and fix suggestions.
