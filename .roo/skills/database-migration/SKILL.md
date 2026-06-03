# Database Migration Skill

Plans, generates, and applies safe database schema migrations.

## Usage

Triggered by `/database-migration` with args `[action] [description]`.

## Required Context

- `DB_TYPE`: postgres / mysql / sqlite
- `MIGRATIONS_DIR`: migration files directory

## Output

Migration SQL file, rollback script, and status report.
