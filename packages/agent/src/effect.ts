/**
 * `@texra-ai/agent/effect` — the SDK's surface.
 *
 * The services below are where every decision this package makes is
 * stated: which level is a run's first, when its transcript interest
 * changes, when its drain ends, which failure wins. The root entry
 * (`@texra-ai/agent`) is the Promise rendering of exactly these services
 * and holds no logic of its own; it is the boundary the Effect migration's
 * rule R1 names (`agents/docs/proposed/architecture/2026-08-26-effect-4-runtime-migration.md`,
 * §7 R1, boundary kind 3: the published SDK). Nothing below this barrel
 * calls `Effect.runPromise`, `runSync`, or `runFork`.
 *
 * Payloads are the runtime's own Zod-derived values (`RuntimeRequest`,
 * `Outcome`, the `RequestError` union), so an embedder that speaks Effect
 * reads and writes what every TeXRA host does. There is no store, no fold
 * internal, and no host widget here.
 */

// The services and their layer. `Runtime.layer(platform)` is the only way
// in: the composition root and the session factory under it stay internal,
// because a caller that reached them directly would hold a composed process
// and an open session with no scope to end either.
export { Runtime } from './effect/runtime.js';
export type { AgentPlatform, AgentRuntime } from './effect/runtime.js';
export { Sessions } from './effect/sessions.js';
export type {
  Run,
  Session,
  SessionView,
  StartInput,
  StreamView,
  TranscriptView,
} from './effect/sessions.js';

// The failures the surface names.
export {
  AgentNotFound,
  PlatformConflict,
  RunFailure,
  ToolsRefused,
} from './effect/errors.js';
export type { LaunchError } from './effect/errors.js';

// The payloads, as the runtime defines them.
export { aggregateId } from '@shared/schemas';
export type { AgentEvent } from '@agent/trace';
export type { AgentFlowResult } from '@agent/runtime/AgentFlowResult';
export type { ITool } from '@agent/core/tools/ToolTypes';
export type {
  AggregateId,
  ExecutionId,
  SessionCloseReport,
  StreamTabId,
  TranscriptSubscription,
} from '@shared/schemas';
export type { RequestError } from '@shared/session/requestErrors';
export type { Outcome, RuntimeRequest } from '@shared/session/runtimeRequest';
