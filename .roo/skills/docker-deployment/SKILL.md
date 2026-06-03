# Docker Deployment Skill

Builds, analyzes, and optimises Docker configurations.

## Usage

Triggered by `/docker-deployment` with args `[action] [service-name]`.

## Required Context

- `DOCKER_DIR`: directory with Dockerfile(s)
- `COMPOSE_FILE`: docker-compose file path

## Output

Optimized Dockerfile, compose config, or deployment plan.
