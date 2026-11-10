---
inclusion: always
---

# Haunted Homelab: project steering

An AI sysadmin ghost for a homelab: a Fastify backend watches a data source, raises alerts, answers chat through OpenRouter, speaks through OpenRouter TTS, and runs restart or stop only after the user confirms. The spec in `.kiro/specs/haunted-homelab` is the source of truth; cite requirement numbers (for example `(Requirement 11.5)`) in doc comments when code implements one.

## Stack and code style

- TypeScript strict with `NodeNext` resolution: relative imports end in `.js` even for `.ts` files. `verbatimModuleSyntax` is on, so type-only imports use `import type`.
- Server: Fastify 4, `@fastify/websocket`, zod v4 (`import { z } from "zod"`), pino. Web: React 18, zustand v5, Vite.
- Shared types live in `src/shared/types.ts`. Browser-facing responses are built only from these DTOs, never from server objects.
- Format every displayed or spoken number with `src/shared/format.ts` (`formatPercent`, `formatBytes`, `usagePercent`) so the UI, the fact sheet, and the fact guard agree.
- Keep logic pure where the design says so (`evaluateRules`, simulator `state.ts`, `ProposalStore` transitions, `loadConfig`): no mutation of inputs, clock injected.

## Architecture rules that must not be broken

- `dockerode` and `systeminformation` may be imported only under `src/server/datasource/`. ESLint enforces this.
- `ActionExecutor` is reachable only through `ProposalStore.confirm`. No route, the Agent, or LLM output may call `DataSource.restart` or `stop` directly (Requirement 11.5).
- The speech route speaks only text stored in `MessageStore` by id. Never add an endpoint that sends client-supplied text to TTS (Requirement 13.2).
- LLM replies pass the fact guard; alert text passes `acceptAlertText`. On failure, fall back to the deterministic templates instead of showing unchecked numbers.
- Every LLM call goes through the budgeted provider in `app.ts`; chat and new speech clips also pass the per-visitor limits in `src/server/limits`.

## Secrets and security

- The OpenRouter key comes only from `HAUNTED_OPENROUTER_API_KEY` or the git-ignored `haunted.config.json`. Never hard-code a key, write one into tests (use obvious fakes such as `sk-or-v1-test-...`), or include it in errors, logs, or responses.
- Log through the scrubbing logger from `src/server/logging/logger.ts`, never `console`.
- The server binds to `127.0.0.1` by default (`0.0.0.0` on Render). Mutating routes and WebSocket upgrades pass the origin guard; new public origins go in `HAUNTED_ALLOWED_ORIGINS`, never a wildcard.

## Commands

- `npm run check` runs type-check, lint, and every test once. Run it before calling a task done.
- `npm test` runs Vitest once (`vitest --run`). Never start Vitest in watch mode.
- `npm run dev` and `npm start` are long-running. Ask the user to start them rather than running them in the foreground.
- Property tests use fast-check with `pbt()` from `test/pbt.ts` (at least 100 runs) and a comment tag such as `// Feature: haunted-homelab, Property 14: ...`.
