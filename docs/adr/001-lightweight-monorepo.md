# ADR 001: Lightweight monorepo

## Decision

Use a pnpm workspace with runnable applications under `apps/` and communication schemas under `packages/contracts`. Do not add Nx or Turborepo at the current scale.

## Why

API, web console, gateway mock and Agent mock change together for this assignment. Atomic commits and one lockfile reduce integration drift, while independent package manifests preserve build and deployment boundaries.

## Trade-off

The repository shares a release history. If separate teams later require independent permissions and release lifecycles, applications can be extracted without changing their runtime interfaces.
