# Implementation Plan: Haunted Homelab

## Overview

The plan builds the system bottom-up in TypeScript (Node.js 20, strict mode). It starts with the project scaffold and shared types, then the pure, clock-injected modules (config, scrubber, Docker parsers, simulator state, rule engine, proposal store, prompt builder, fact guard, templates). Each pure module is followed by property tests for the design's correctness properties. Network and timer wrappers come next (LLM and TTS through OpenRouter with one API key, Agent, AlertService, Monitor), then the Fastify HTTP and WebSocket layer and `main.ts`. The React web app is built on the shared types and wired to the backend last. Tests use Vitest (`vitest --run`), fast-check with at least 100 runs per property, and @testing-library/react.

## Tasks

- [x] 1. Set up project scaffold and shared modules
  - [x] 1.1 Create project scaffold and tooling
    - Create `package.json` with dependencies (fastify 4, @fastify/websocket, @fastify/static, zod, dockerode, systeminformation, openai (used only with the OpenRouter `baseURL`), pino, react 18, react-dom, zustand) and dev dependencies (typescript 5, vite, @vitejs/plugin-react, vitest, fast-check, @testing-library/react, jsdom, eslint, tsx)
    - Add scripts: `dev`, `build` (tsc for server, vite build to `dist/web`), `start`, `test` (`vitest --run`), `lint`; no watch-mode test script
    - Create `tsconfig.json` (strict), `vite.config.ts` (React plugin, output `dist/web`, dev proxy for `/api` and `/ws` to the backend), `vitest.config.ts` (jsdom environment for `test/web/**`), and `index.html`
    - Create the ESLint config with a `no-restricted-imports` rule that allows `dockerode` and `systeminformation` only under `src/server/datasource/`
    - Create `test/pbt.ts` exporting shared fast-check parameters (`numRuns: 100` minimum)
    - Create `haunted.config.example.json` with every setting from the configuration table: `openrouter.apiKey` (placeholder), `openrouter.baseUrl`, `llm.model`, `tts.model`, `tts.voice`, `tts.instructions`, and the data source, Docker, monitor, threshold, server, and simulator settings
    - _Requirements: 1.4, 12.1_

  - [x] 1.2 Define shared types in `src/shared/types.ts`
    - Define `ContainerState`, `ContainerInfo`, `LogLine`, `FilesystemUsage`, `HostMetrics`, `Snapshot`, `Thresholds`, `ActionProposalDTO`, `Clock`
    - Define browser-facing types: `HauntingAlert`, `AlertEvent`, `AlertSubject`, `AlertRuleId`, `GhostReply` (including an optional non-spoken `list?: string[]` field), `LogEvent`, `ChatTurn`, `StagedIncident`, `IncidentType`, `PublicConfig`, `ServerEvent`, and HTTP request and response DTOs
    - _Requirements: 1.1, 10.1, 10.2_

  - [x] 1.3 Implement shared helpers
    - `src/shared/format.ts`: `formatPercent`, `formatBytes` (binary units, one decimal), `usagePercent`
    - `src/shared/words.ts`: `countWords`, `limitWords`
    - `src/shared/severity.ts`: `computeSeverityMarks` (highest severity among unresolved alerts per subject key)
    - _Requirements: 8.2, 8.3, 8.4, 10.4_

  - [ ]* 1.4 Write property test for word limit
    - File `test/shared/words.property.test.ts`
    - **Property 21: Word limit**
    - **Validates: Requirements 8.2, 8.3**

  - [ ]* 1.5 Write property test for status severity marks
    - File `test/shared/severity.property.test.ts`
    - **Property 25: Status severity marks**
    - **Validates: Requirements 10.4**

  - [ ]* 1.6 Write unit tests for format helpers
    - File `test/shared/format.test.ts`: unit boundaries for `formatBytes`, zero total in `usagePercent`, rounding in `formatPercent`
    - _Requirements: 8.4, 10.1_

- [x] 2. Implement configuration and secret-safe logging
  - [x] 2.1 Implement configuration loading
    - `src/server/config/schema.ts`: zod schema, `Config`, `DATA_SOURCE_NAMES`, `ConfigError` collecting all problems
    - `src/server/config/loadConfig.ts`: pure `loadConfig(env, file)` with env-over-file-over-default precedence, strict numeric parsing, range checks (thresholds 1–100, interval ≥ 1000 ms), platform-specific Docker endpoint default
    - Settings `HAUNTED_OPENROUTER_API_KEY` (required), `HAUNTED_OPENROUTER_BASE_URL` (default `https://openrouter.ai/api/v1`), `HAUNTED_LLM_MODEL` (default `openai/gpt-4o-mini`), `HAUNTED_TTS_MODEL` (default `openai/gpt-4o-mini-tts-2025-12-15`), `HAUNTED_TTS_VOICE` (default `onyx`), `HAUNTED_TTS_INSTRUCTIONS` (default spooky delivery text; empty string means none); no provider settings
    - Report a missing, empty, or whitespace-only `HAUNTED_OPENROUTER_API_KEY` by setting name; report unknown data source with `Unknown data source "<value>". Valid data sources: docker, simulator`
    - `src/server/config/publicConfig.ts`: `toPublicConfig` whitelist projection with `aiGateway: "openrouter"`, `llmModel`, `ttsModel`, and without the API key, the OpenRouter base URL, or the Docker endpoint
    - _Requirements: 1.2, 1.3, 12.1, 12.2, 12.3, 12.4_

  - [ ]* 2.2 Write property test for configuration precedence
    - File `test/server/config/precedence.property.test.ts`
    - **Property 1: Configuration precedence**
    - **Validates: Requirements 12.1, 12.2**

  - [ ]* 2.3 Write property test for invalid configuration
    - File `test/server/config/invalid.property.test.ts`
    - **Property 2: Invalid configuration is rejected with named problems**
    - **Validates: Requirements 1.3, 12.3**

  - [x] 2.4 Implement secret scrubbing and logger
    - `src/server/logging/scrub.ts`: `scrubDeep` replacing every non-empty secret with `[REDACTED]` in strings, nested objects, arrays, and Error messages
    - `src/server/logging/logger.ts`: `createLogger(secrets)` with a pino `hooks.logMethod` that scrubs every argument and a `redact` list for `*.apiKey`, `*.headers.authorization`, `*.headers.Authorization`
    - _Requirements: 12.4_

  - [ ]* 2.5 Write property test for secret exclusion
    - File `test/server/logging/secrets.property.test.ts`: covers `scrubDeep`, serialized pino lines, and `JSON.stringify(toPublicConfig(config))`
    - **Property 3: Secrets never leave the backend**
    - **Validates: Requirements 12.4**

- [x] 3. Implement the data source interface and Docker source
  - [x] 3.1 Define the data source interface and snapshot reader
    - `src/server/datasource/types.ts`: `DataSource` interface, `DataSourceUnavailableError`, `ContainerNotFoundError`, `DataSourceActionError`
    - `src/server/datasource/snapshot.ts`: `readSnapshot(ds, clock)` reading containers and host metrics in parallel and stamping `readAt`
    - _Requirements: 1.1, 1.4_

  - [ ]* 3.2 Implement pure Docker helpers
    - Deferred for MVP: build after the simulator demo works.
    - `src/server/datasource/docker/endpoint.ts`: map `unix://` and `npipe://` to `socketPath`, `tcp://` and `http://` to `host` and `port`
    - `src/server/datasource/docker/stats.ts`: `computeCpuPercent`, `computeMemoryBytes`
    - `src/server/datasource/docker/logs.ts`: `demuxDockerStream`, `parseTimestampedLines`, and a tail step keeping the last `maxLines` lines
    - _Requirements: 2.1, 2.2_

  - [ ]* 3.3 Write property test for Docker log stream round trip
    - File `test/server/datasource/docker/logs.property.test.ts`
    - **Property 4: Docker log stream round trip**
    - **Validates: Requirements 2.2**

  - [ ]* 3.4 Implement `DockerSource`
    - Deferred for MVP: build after the simulator demo works.
    - `src/server/datasource/docker/DockerSource.ts`: `listContainers` with `all: true`, name without leading `/`, stats for running containers with concurrency limit 8, zero CPU and memory for non-running containers
    - `readLogs` with `timestamps: true` and `tail`, demultiplexing when `Config.Tty === false`
    - `readHostMetrics` via systeminformation (`currentLoad`, `mem().active`, `fsSize`)
    - `restart` and `stop` via `getContainer(name)`
    - Error mapping: `ECONNREFUSED`, `ENOENT`, `EACCES`, `ETIMEDOUT`, `EPIPE` → `DataSourceUnavailableError(endpoint)`; HTTP 404 → `ContainerNotFoundError(name)`; other restart or stop failures → `DataSourceActionError` with Docker's message
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [ ]* 3.5 Write unit tests for `DockerSource` with mocked dockerode
    - File `test/server/datasource/docker/DockerSource.test.ts`: exited containers included and `/` stripped, host metrics mapping, restart and stop call the right methods and pass errors through, socket errors name the endpoint, 404 names the container, `computeCpuPercent` with zero deltas
    - _Requirements: 2.1, 2.3, 2.4, 2.5, 2.6_

- [x] 4. Implement the simulator data source
  - [x] 4.1 Implement simulator default model and log generation
    - `src/server/datasource/simulator/noise.ts`: `noise(seed, key, tick)` using FNV-1a hashing into mulberry32, `tick = floor(now / 5000)`
    - `src/server/datasource/simulator/logs.ts`: per-service log templates for `plex`, `pihole`, `homeassistant`, `nginx-proxy`, `uptime-kuma`
    - `src/server/datasource/simulator/state.ts`: `SimState`, `initialState(seed)`, and `observe(s, now)` producing the default host (8 cores, 32 GiB, `/` and `/mnt/media`) and containers within the design's ranges, plus lazy log generation of one or two lines per running container per tick into 1000-line ring buffers
    - _Requirements: 3.1, 3.2_

  - [x] 4.2 Implement incident staging and container operations in `state.ts`
    - `stageIncident` with target validation (`ContainerNotFoundError` for unknown targets, missing target for container incidents rejected), one container incident per container, idempotent host incidents
    - Incident effects in `observe`: `cpu_spike` (host CPU 96–99 %, `unknown-process-x13` container), `memory_leak` (grow `leakBytes` by 4 % of host memory per read until host memory ≥ 95 %, hold), `disk_full` (`/` at 97 %), `container_crash` (exited, three error lines on staging), `container_restart_loop` (restarting, repeated startup failure line per tick)
    - `restartContainer`, `stopContainer`, `clearIncidents` per the design's operation rules, including the ghost container cases
    - _Requirements: 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 3.11_

  - [x] 4.3 Implement `SimulatorSource` and the data source factory
    - `src/server/datasource/simulator/SimulatorSource.ts`: async `DataSource` wrapper around the pure state with an injected clock, plus `listIncidents`, `stage`, and `clearAll` methods for the incident endpoints
    - `src/server/datasource/factory.ts`: `createDataSource(config, clock, logger)` returning `SimulatorSource` when `dataSource === "simulator"`
    - MVP: the factory must not import `DockerSource`. When `dataSource === "docker"`, it throws a clear startup error: `Docker data source is not built yet. Set HAUNTED_DATA_SOURCE=simulator.`
    - Once 3.2 and 3.4 are done, switch the factory to construct `DockerSource` for `dataSource === "docker"`
    - _Requirements: 1.1, 1.2, 3.3_

  - [ ]* 4.4 Write property test for simulator defaults
    - File `test/server/datasource/simulator/defaults.property.test.ts`
    - **Property 5: Simulator defaults**
    - **Validates: Requirements 3.1**

  - [ ]* 4.5 Write property test for simulator log cadence
    - File `test/server/datasource/simulator/logCadence.property.test.ts`
    - **Property 6: Simulator log cadence**
    - **Validates: Requirements 3.2**

  - [ ]* 4.6 Write property test for staged incident effects
    - File `test/server/datasource/simulator/incidents.property.test.ts` (uses `classifyLine` from task 9.2)
    - **Property 7: Staged incidents produce their effects**
    - **Validates: Requirements 3.4, 3.6, 3.7, 3.8**

  - [ ]* 4.7 Write property test for memory leak growth
    - File `test/server/datasource/simulator/memoryLeak.property.test.ts`
    - **Property 8: Memory leak grows until host memory reaches 95 %**
    - **Validates: Requirements 3.5**

  - [ ]* 4.8 Write property test for restart and stop
    - File `test/server/datasource/simulator/restartStop.property.test.ts`
    - **Property 9: Restart heals and stop exits**
    - **Validates: Requirements 3.9, 3.11**

  - [ ]* 4.9 Write property test for clear all
    - File `test/server/datasource/simulator/clearAll.property.test.ts`
    - **Property 10: Clear all restores defaults**
    - **Validates: Requirements 3.10**

  - [ ]* 4.10 Write unit tests for factory, shared contract, and staging errors
    - File `test/server/datasource/contract.test.ts`: factory returns `SimulatorSource` for `simulator` and throws the docker-not-built error for `docker`, a shared contract suite runs against `SimulatorSource` (add a mocked `DockerSource` once it exists), staging a container incident without a target or with an unknown target fails
    - _Requirements: 1.1, 1.2_

- [x] 5. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement the rule engine and Monitor
  - [x] 6.1 Implement the pure rule engine
    - `src/server/monitor/rules.ts`: `RuleState`, `MonitorInput`, `subjectKey`, `initialRuleState`, and `evaluateRules(state, input, thresholds)`
    - Rules `host_cpu` (sustained via `cpuAboveSince`), `host_memory`, `disk` per mount, `container_exited` (latched), `container_restarting`, `new_container_cpu` (latched, none on first snapshot), `data_source_unavailable`
    - Error inputs change only `data_source_unavailable`; raised = true keys not active; resolved = active keys no longer true; measured values formatted with `formatPercent`
    - _Requirements: 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 4.10_

  - [ ]* 6.2 Write property test for memory and disk thresholds
    - File `test/server/monitor/thresholds.property.test.ts`
    - **Property 11: Host memory and disk thresholds**
    - **Validates: Requirements 4.3, 4.4**

  - [ ]* 6.3 Write property test for sustained CPU alert
    - File `test/server/monitor/cpu.property.test.ts`
    - **Property 12: Sustained CPU alert**
    - **Validates: Requirements 4.2**

  - [ ]* 6.4 Write property test for container state alerts
    - File `test/server/monitor/containers.property.test.ts` with an inline reference model recomputed from full history
    - **Property 13: Container state alerts match the reference model**
    - **Validates: Requirements 4.5, 4.6, 4.7**

  - [ ]* 6.5 Write property test for alert lifecycle
    - File `test/server/monitor/lifecycle.property.test.ts`
    - **Property 14: Alert lifecycle has no duplicates**
    - **Validates: Requirements 4.8, 4.9**

  - [ ]* 6.6 Write property test for data source outage
    - File `test/server/monitor/outage.property.test.ts`
    - **Property 15: Data source outage raises one alert**
    - **Validates: Requirements 4.10**

  - [x] 6.7 Implement the Monitor scheduler
    - `src/server/monitor/Monitor.ts`: `setTimeout` loop at `start + n·interval`, snapshot read timeout `min(interval, 10s)` treated as an error input, skip overlapped ticks, call `evaluateRules`, then injected callbacks `onSnapshot(snapshot)` and `onEvents(raised, resolved)`; expose `start()`, `stop()`, `latestSnapshot()`
    - _Requirements: 4.1, 4.10_

  - [ ]* 6.8 Write unit tests for the Monitor with fake timers
    - File `test/server/monitor/Monitor.test.ts`: polls at 0, 5 s, 10 s by default and at a configured interval, keeps polling after errors, skips overlapping reads
    - _Requirements: 4.1, 4.10_

- [x] 7. Implement proposals and the action executor
  - [x] 7.1 Implement `ActionExecutor`
    - `src/server/actions/ActionExecutor.ts`: `run(p)` calls `ds.restart` or `ds.stop` and maps errors to `{ ok: false, error: message }`
    - _Requirements: 11.4, 11.7_

  - [x] 7.2 Implement `ProposalStore`
    - `src/server/actions/ProposalStore.ts`: pure `createProposal`, `confirm` (marks confirmed before execution, expires when `now − createdAt > PROPOSAL_TTL_MS`, inclusive boundary), `cancel` (pending only), and DTO conversion with `expiresAt`
    - `ProposalStore` class wrapping the pure state, holding the only `ActionExecutor` reference, with `create`, `confirm(id)` (returns decision and action result), `cancel(id)`, `get(id)`, `list()`
    - _Requirements: 11.4, 11.5, 11.6, 11.8, 11.9_

  - [ ]* 7.3 Write property test for proposal lifecycle
    - File `test/server/actions/ProposalStore.property.test.ts` using fast-check `commands` with a spy executor and clock advances around 5 minutes
    - **Property 27: Proposal lifecycle runs each action at most once**
    - **Validates: Requirements 11.4, 11.5, 11.6, 11.8, 11.9**

  - [ ]* 7.4 Write unit tests for the expiry boundary and executor errors
    - File `test/server/actions/ProposalStore.test.ts`: confirm at exactly 5:00 executes, confirm at 5:00.001 expires, executor maps Docker errors to messages
    - _Requirements: 11.7, 11.8_

- [x] 8. Implement LLM, TTS, and message storage clients
  - [x] 8.1 Implement the LLM client and OpenRouter provider
    - `src/server/llm/LlmClient.ts`: `LlmRequest`, `LlmProvider` (test seam), `LlmClient.complete(req, timeoutMs)` with `AbortController` and `LlmTimeoutError`
    - `src/server/llm/openrouter.ts`: `OpenRouterLlm` using the `openai` SDK with `baseURL` from config, `maxRetries: 0`, and `X-Title: Haunted Homelab` header; `chat.completions.create` with the configured model and `response_format: { type: "json_object" }` when `json` is true; no automatic retries
    - _Requirements: 6.1, 6.7, 8.1_

  - [x] 8.2 Implement the TTS client and OpenRouter provider
    - `src/server/tts/TtsClient.ts`: `TtsRequest`, `TtsProvider` (test seam), `TtsClient.speak(text, timeoutMs = 15000)` building `{ model, input, voice, response_format: "mp3" }` from config and adding `instructions` only when non-empty
    - `src/server/tts/openrouterTts.ts`: `OpenRouterTts` sending `POST {baseUrl}/audio/speech` via `fetch` with `Authorization: Bearer <key>` and `X-Title: Haunted Homelab`; return raw bytes as `audio/mpeg` on 200; map non-200 JSON errors to `TtsProviderError`
    - _Requirements: 9.2, 9.5, 9.6, 9.7, 13.2_

  - [x] 8.3 Implement `MessageStore`
    - `src/server/messages/MessageStore.ts`: bounded map of the 500 most recent spoken texts by id, with an audio cache per id
    - _Requirements: 9.1, 13.2_

  - [ ]* 8.4 Write unit tests for LLM and TTS clients
    - File `test/server/clients.test.ts`: LLM timeout raises `LlmTimeoutError`, `OpenRouterLlm` sends the configured model and JSON response format, the Agent's raw-text fallback for non-JSON output, TTS sends the configured model, voice, and instructions and requests mp3, `OpenRouterTts` maps a non-200 JSON error, TTS timeout, MessageStore eviction at 500
    - _Requirements: 6.7, 9.2, 9.5, 9.6, 9.7_

- [x] 9. Implement Agent pure modules
  - [x] 9.1 Implement the fact sheet and fact guard
    - `src/server/agent/factSheet.ts`: `FactSheet`, `buildFactSheet(snapshot)` using shared formatters
    - `src/server/agent/factGuard.ts`: `extractQuantities`, `allowedQuantities(facts, extraTexts)`, `factGuard(reply, allowed)`
    - _Requirements: 6.4, 8.4_

  - [x] 9.2 Implement mention matching, intent detection, and log events
    - `src/server/agent/mentions.ts`: `resolveContainerMentions` (case-insensitive whole words, `-`, `_`, and space equivalent), `detectIntent` (`summarize`, `summarise`, `summary`, `logs`), container name matching used by the not-found check
    - `src/server/agent/logEvents.ts`: `classifyLine` (error wins over warning) and `extractLogEvents`
    - _Requirements: 6.2, 6.5, 7.1, 7.2_

  - [x] 9.3 Implement persona reply templates
    - `src/server/agent/replyTemplates.ts`: `unknownContainerReply` (moves names to a non-spoken `list` field past 120 words), `noLogsTemplate`, `chatFailureMessage`, `actionResultReply` (success or verbatim error), `factTemplateReply` (passes the fact guard); all limited to 120 words
    - _Requirements: 6.4, 6.5, 6.7, 7.3, 8.2, 11.7_

  - [x] 9.4 Implement the persona prompt and chat prompt builder
    - `src/server/agent/persona.ts`: `PERSONA_SYSTEM_PROMPT` (ghost voice, spooky metaphors, quote names and numbers exactly, ≤ 120 words, only restart or stop proposals, JSON `{reply, mentionedContainer, proposal}`)
    - `src/server/agent/prompt.ts`: `buildChatPrompt` with `FACTS`, `LOGS <name>` (last `limit` lines), `LOG EVENTS` for summaries, `QUESTION`; history limited to the last 10 turns truncated to 2000 chars; no config input
    - _Requirements: 6.1, 6.2, 7.1, 8.1, 13.1_

  - [x] 9.5 Implement proposal validation
    - `src/server/agent/validateProposal.ts`: zod schema for the LLM proposal; returns a proposal only for `restart` or `stop` on a container in the snapshot with a non-empty reason
    - _Requirements: 11.1, 11.3_

  - [ ]* 9.6 Write property test for the fact guard
    - File `test/server/agent/factGuard.property.test.ts`
    - **Property 18: Fact guard keeps quantities exact**
    - **Validates: Requirements 6.4, 8.4**

  - [ ]* 9.7 Write property test for the unknown container reply
    - File `test/server/agent/unknownContainer.property.test.ts`
    - **Property 19: Unknown container reply lists real containers**
    - **Validates: Requirements 6.5**

  - [ ]* 9.8 Write property test for log event extraction
    - File `test/server/agent/logEvents.property.test.ts` (noise words such as `terrorist` must not match)
    - **Property 20: Log event extraction**
    - **Validates: Requirements 7.2**

  - [ ]* 9.9 Write property test for chat prompt contents
    - File `test/server/agent/prompt.property.test.ts`
    - **Property 17: Chat prompt contents and data limits**
    - **Validates: Requirements 6.1, 6.2, 7.1, 8.1, 13.1**

  - [ ]* 9.10 Write property test for action result replies
    - File `test/server/agent/actionResult.property.test.ts`
    - **Property 28: Action result reply reports the outcome**
    - **Validates: Requirements 11.7**

- [x] 10. Implement alert templates and proposal policy
  - [x] 10.1 Implement alert templates
    - `src/server/alerts/templates.ts`: `subjectLabel`, `alertTemplate` (subject label and measured value verbatim, ≤ 40 words), `recoveryTemplate`, `acceptAlertText(candidate, event)`
    - _Requirements: 5.1, 5.5, 5.6, 8.3_

  - [x] 10.2 Implement the alert proposal policy
    - `src/server/alerts/proposalPolicy.ts`: `container_exited` and `container_restarting` → restart, `new_container_cpu` → stop, others → null, each with a non-empty reason
    - _Requirements: 11.1, 11.3_

  - [ ]* 10.3 Write property test for proposal limits
    - File `test/server/agent/proposals.property.test.ts`: covers `validateProposal` and `proposalPolicy`
    - **Property 26: Proposals are limited to restart and stop on real containers**
    - **Validates: Requirements 11.1, 11.3**

- [x] 11. Implement the Agent
  - [x] 11.1 Implement `Agent.answer`
    - `src/server/agent/Agent.ts`: steps 1–11 of the design (snapshot, mentions, intent, logs with 100 or 200 lines, ask-which-container and no-logs paths without an LLM call, JSON parsing with raw-text fallback, unknown container reply, one log re-request, fact guard with one corrective retry then `factTemplateReply`, `limitWords(120)`, `extractLogEvents`, `validateProposal` and registration in `ProposalStore`, store text in `MessageStore`)
    - Respect the deadline for every LLM call; throw typed errors that the route maps to 502 and 504
    - _Requirements: 6.1, 6.2, 6.4, 6.5, 6.7, 7.1, 7.2, 7.3, 8.2, 8.4, 11.1, 11.3_

  - [x] 11.2 Implement `Agent.writeAlertMessage` and `Agent.reportActionResult`
    - `writeAlertMessage`: one LLM call with a 10-second timeout asking for one sentence ≤ 40 words; accept via `acceptAlertText`, otherwise `alertTemplate`
    - `reportActionResult`: build a `GhostReply` from `actionResultReply` and store it in `MessageStore`
    - _Requirements: 5.1, 5.5, 8.1, 8.3, 11.7_

  - [ ]* 11.3 Write property test for alert and recovery messages
    - File `test/server/alerts/alertMessage.property.test.ts` with a mock LLM returning valid, long, or fact-missing text, rejecting, or hanging (fake timers)
    - **Property 16: Alert and recovery messages carry the facts**
    - **Validates: Requirements 5.1, 5.5, 5.6, 8.3**

  - [ ]* 11.4 Write unit tests for `Agent.answer`
    - File `test/server/agent/Agent.test.ts`: empty logs return `noLogsTemplate` with no LLM call, LLM rejection and a 30-second hang produce typed errors, non-JSON output used as plain text, invalid quantities trigger retry then template, unknown container path, invalid proposal dropped
    - _Requirements: 6.4, 6.5, 6.7, 7.3, 11.3_

- [x] 12. Implement the AlertService
  - [x] 12.1 Implement `AlertService` and the hub interface
    - `src/server/http/hub.ts`: `WsHub` interface with `broadcast(event: ServerEvent)`
    - `src/server/alerts/AlertService.ts`: per-key promise chains; on raised, write the message via the Agent, attach a proposal from `proposalPolicy` (source `alert`), store the text in `MessageStore`, broadcast `alert.raised`; on resolved, build `recoveryTemplate`, store it, mark the alert resolved, broadcast `alert.resolved`; `activeAlerts()`
    - _Requirements: 4.9, 5.1, 5.2, 5.6, 11.1, 11.2_

  - [ ]* 12.2 Write unit tests for `AlertService`
    - File `test/server/alerts/AlertService.test.ts`: resolved never overtakes raised for the same key, proposals attached for container alerts only, recovery messages stored for speech, active list updates
    - _Requirements: 4.9, 5.6, 11.1_

- [x] 13. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 14. Implement the HTTP and WebSocket layer and server entry point
  - [x] 14.1 Implement the origin guard and WebSocket hub
    - `src/server/http/originGuard.ts`: reject POST, DELETE, and WebSocket upgrades whose `Origin` is not the server origin or `http://localhost:5173` with 403, logged without body
    - `src/server/http/ws.ts`: `WsHub` implementation on `@fastify/websocket` at `/ws` with the origin check on upgrade
    - _Requirements: 10.3, 12.4_

  - [x] 14.2 Implement HTTP routes
    - `src/server/http/routes.ts`: `GET /api/config`, `GET /api/state`, `POST /api/chat` (zod body, 30-second deadline, 502 and 504 with `chatFailureMessage`), `POST /api/proposals/:id/confirm` (run via `ProposalStore`, then `Agent.reportActionResult`, broadcast `proposal.updated` and `chat.message`, 409 with reason on rejection), `POST /api/proposals/:id/cancel`, `GET /api/speech/:messageId` (MessageStore lookup, `TtsClient.speak`, audio cache, 404, 502, 504), simulator-only `GET`, `POST`, `DELETE /api/sim/incidents` (404 in Docker mode, 400 naming the bad target)
    - Generic persona error for unexpected exceptions, logged through the scrubbing logger; responses built only from DTO types
    - _Requirements: 3.3, 5.3, 6.3, 6.7, 9.1, 9.2, 9.5, 11.4, 11.5, 11.7, 11.8, 11.9, 12.4, 13.2_

  - [x] 14.3 Implement the server entry point
    - `src/server/main.ts`: read `process.env` and the optional JSON file at `HAUNTED_CONFIG`, call `loadConfig` (print `ConfigError` to stderr and exit 1), create the logger with the OpenRouter API key as the secret, construct `OpenRouterLlm` and `OpenRouterTts` from the OpenRouter settings, build the data source, clients, stores, Agent, AlertService, hub, and Monitor; wire `onSnapshot` to broadcast `snapshot` and `onEvents` to `AlertService.handle`; serve `dist/web` with `@fastify/static`; listen on the configured host and port
    - _Requirements: 1.2, 1.3, 4.1, 10.3, 12.1, 12.3_

  - [ ]* 14.4 Write property test for TTS request contents
    - File `test/server/http/speech.property.test.ts` with a mock `TtsProvider` and random texts, model slugs, voices, and instructions (including empty)
    - **Property 23: TTS request contains only the message text and configured settings**
    - **Validates: Requirements 9.2, 9.6, 9.7, 13.2**

  - [ ]* 14.5 Write unit tests for routes and origin guard
    - File `test/server/http/routes.test.ts` using Fastify `inject`: foreign origin rejected on POST and WebSocket upgrade, sim routes 404 in Docker mode, 400 for invalid incidents, 409 for repeated confirm and expired proposals, 502 and 504 chat errors, no API key in any response body
    - _Requirements: 3.3, 6.7, 11.8, 11.9, 12.4_

- [x] 15. Implement Web_App data layer
  - [x] 15.1 Implement REST and socket clients
    - `src/web/api/rest.ts`: typed calls for config, state, chat (35-second client abort), confirm, cancel, incidents, and speech fetch returning an object URL
    - `src/web/api/socket.ts`: reconnecting WebSocket with exponential backoff from 1 s to 10 s, `onEvent`, `onOpen`, `onClose` callbacks
    - _Requirements: 6.7, 10.3, 10.5_

  - [x] 15.2 Implement the client store and chat history
    - `src/web/state/store.ts` (zustand): `connection`, `lastSnapshotAt`, `snapshot`, `alerts`, `popups`, `chat` (turns, replies, proposals, voice status), `voiceEnabled` (default `true`), `publicConfig`, and reducers for each `ServerEvent`
    - `src/web/state/chatHistory.ts`: `saveHistory` and `loadHistory` on `sessionStorage` under `haunted.chat.v1`
    - _Requirements: 6.8, 9.3, 10.3, 10.5_

  - [x] 15.3 Implement the audio queue
    - `src/web/audio/AudioQueue.ts`: FIFO over an injected `Player`, one clip at a time, 15-second fetch abort, `onFailure(id)` and skip to the next clip on failure; plus an `HTMLAudioElement`-based `Player`
    - _Requirements: 5.3, 9.1, 9.4, 9.5_

  - [ ]* 15.4 Write property test for chat history round trip
    - File `test/web/chatHistory.property.test.ts` with an in-memory `Storage` stub
    - **Property 22: Chat history round trip**
    - **Validates: Requirements 6.8**

  - [ ]* 15.5 Write property test for the audio queue
    - File `test/web/AudioQueue.property.test.ts` with a fake `Player` and command sequences of enqueue, end, and fail
    - **Property 24: Audio queue order without overlap**
    - **Validates: Requirements 9.4**

- [x] 16. Implement Web_App components and wiring
  - [x] 16.1 Implement `StatusPanel`
    - `src/web/components/StatusPanel.tsx`: host CPU %, memory %, disk % per mount, container table (name, state, CPU %, memory), severity badges from `computeSeverityMarks`, disconnected banner with `lastSnapshotAt`
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5_

  - [x] 16.2 Implement `AlertPopupStack`
    - `src/web/components/AlertPopupStack.tsx`: popups with message, severity, detection time, dismiss button, recovery popups on resolve
    - _Requirements: 5.2, 5.4, 5.6_

  - [x] 16.3 Implement `ChatPage` and `ProposalCard`
    - `src/web/components/ChatPage.tsx`: input and send, question shown immediately, waiting indicator, ghost reply below the question, timestamped log event list, non-spoken name list, persona error with Retry and the question restored, muted-speaker indicator with "the voice was lost in the static"
    - `src/web/components/ProposalCard.tsx`: Confirm and Cancel buttons, both disabled when status is not `pending`, status label for `confirmed`, `cancelled`, `expired`
    - _Requirements: 6.3, 6.6, 6.7, 7.2, 9.5, 11.2, 11.6, 11.8_

  - [x] 16.4 Implement `IncidentControl`, `VoiceToggle`, and `PrivacyNotice`
    - `src/web/components/IncidentControl.tsx`: shown only when `publicConfig.dataSource === "simulator"`, incident type select, container select for container incidents, Stage and Clear all buttons
    - `src/web/components/VoiceToggle.tsx`: toggles `voiceEnabled` and shows the one-time "Wake the ghost" button that unlocks audio
    - `src/web/components/PrivacyNotice.tsx`: persistent footer stating that system data is sent to OpenRouter and the upstream providers of `publicConfig.llmModel` and `publicConfig.ttsModel`, naming both slugs
    - _Requirements: 3.3, 9.3, 13.3_

  - [x] 16.5 Wire the Web_App together
    - `src/web/App.tsx` and `src/web/main.tsx`: load `/api/config` and `/api/state`, connect the socket and dispatch events to the store, reload state on reconnect, enqueue audio for ghost replies, alert popups, and recovery popups only while voice is enabled, mark `voiceFailed` on queue failures, persist chat history
    - _Requirements: 5.2, 5.3, 6.8, 9.1, 9.5, 10.3, 10.5_

  - [ ]* 16.6 Write component tests for `StatusPanel` and `AlertPopupStack`
    - File `test/web/status-alerts.test.tsx`: host metrics and every container rendered, update on snapshot event, disconnected banner with time, popup content, dismiss, recovery popup, audio enqueued when voice is on
    - _Requirements: 5.2, 5.3, 5.4, 5.6, 10.1, 10.2, 10.3, 10.5_

  - [ ]* 16.7 Write component tests for `ChatPage` and `ProposalCard`
    - File `test/web/chat.test.tsx`: waiting indicator, reply below question, error with question restored, voice-failed indicator, audio enqueued for replies, Confirm and Cancel shown and disabled after cancel, confirm, or expiry
    - _Requirements: 6.3, 6.6, 6.7, 9.1, 9.5, 11.2, 11.6, 11.8_

  - [ ]* 16.8 Write component tests for `IncidentControl`, `VoiceToggle`, and `PrivacyNotice`
    - File `test/web/controls.test.tsx`: incident control only in simulator mode, voice on by default, privacy notice names OpenRouter and the configured LLM and TTS model slugs
    - _Requirements: 3.3, 9.3, 13.3_

- [ ] 17. Integration tests
  - [ ]* 17.1 Write end-to-end test with simulator and mock providers
    - File `test/integration/e2e.test.ts`: start the server, connect a WebSocket, stage `container_crash` on `plex`, expect `alert.raised` within one polling interval plus 2 seconds, confirm the restart proposal, expect a success reply and `alert.resolved`
    - _Requirements: 3.7, 3.9, 4.5, 5.2, 10.3, 11.4, 11.7_

  - [ ]* 17.2 Write optional Docker integration test
    - File `test/integration/docker.test.ts`, skipped unless `HAUNTED_IT_DOCKER=1`: alpine containers that echo and exit; checks listing, logs, restart, and stop against the real daemon
    - _Requirements: 2.1, 2.2, 2.4_

  - [ ]* 17.3 Write import restriction test
    - File `test/integration/imports.test.ts`: run ESLint programmatically and assert `dockerode` and `systeminformation` are imported only under `src/server/datasource/`
    - _Requirements: 1.4_

- [x] 18. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP.
- MVP mode: the Docker source (3.2, 3.4 and their tests) is deferred. 'Run all tasks' builds the simulator-only demo. Build 3.2 and 3.4, then update the factory in 4.3, to enable real Docker.
- Each task references specific requirement clauses for traceability.
- Property tests use fast-check with at least 100 runs and carry a comment tag such as `// Feature: haunted-homelab, Property 14: Alert lifecycle has no duplicates`.
- Run tests with `npm test` (`vitest --run`). Start the dev servers manually with `npm run dev`.
- Task 4.6 depends on `classifyLine` from task 9.2. The dependency graph schedules it after 9.2.
- The design's open questions (alert after a confirmed stop, CPU alert delay in the demo, no authentication) are not resolved by these tasks. The implementation follows the requirements as written.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["1.3", "2.1", "2.4", "3.1"] },
    { "id": 3, "tasks": ["1.4", "1.5", "1.6", "2.2", "2.3", "2.5", "3.2", "4.1", "6.1", "7.1", "8.1", "8.2", "8.3", "15.1", "15.2", "15.3"] },
    { "id": 4, "tasks": ["3.3", "3.4", "4.2", "6.2", "6.3", "6.4", "6.5", "6.6", "6.7", "7.2", "8.4", "9.1", "9.2", "15.4", "15.5", "16.1", "16.2", "16.3", "16.4"] },
    { "id": 5, "tasks": ["3.5", "4.3", "6.8", "7.3", "7.4", "9.3", "9.4", "9.5", "9.8", "10.1", "16.5"] },
    { "id": 6, "tasks": ["4.4", "4.5", "4.6", "4.7", "4.8", "4.9", "4.10", "9.6", "9.7", "9.9", "9.10", "10.2", "11.1", "16.6", "16.7", "16.8"] },
    { "id": 7, "tasks": ["10.3", "11.2"] },
    { "id": 8, "tasks": ["11.3", "11.4", "12.1"] },
    { "id": 9, "tasks": ["12.2", "14.1"] },
    { "id": 10, "tasks": ["14.2"] },
    { "id": 11, "tasks": ["14.3", "14.4", "14.5"] },
    { "id": 12, "tasks": ["17.1", "17.2", "17.3"] }
  ]
}
```
