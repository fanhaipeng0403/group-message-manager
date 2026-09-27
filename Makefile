.PHONY: up infra-up db-migrate dev

# PostgreSQL, then migrations, then API / web / mock gateway / mock agent.
up:
	pnpm infra:up
	pnpm db:migrate
	pnpm dev

infra-up:
	pnpm infra:up

db-migrate:
	pnpm db:migrate

dev:
	pnpm dev
