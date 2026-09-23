/**
 * `@texra-ai/agent` — the SDK's surface, stated in Effect.
 *
 * The services below are where every decision this package makes is
 * stated: which level is a run's first, when its transcript interest
 * changes, when its drain ends, which failure wins. Nothing in the package
 * calls `Effect.runPromise`, `runSync`, or `runFork`: a Promise-land
 * embedder runs `Effect.runPromise(program)` at its own entry point.
 *
 * This module is the package's public surface and is documented as one
 * (packages/agent/README.md); it is the one barrel the "no convenience
 * barrels" rule does not apply to.
 *
 * The root entry used to render these services as Promises and
 * AsyncIterables, the boundary the Effect migration's rule R1 names
 * (`.agents/docs/archived/architecture/2026-08-26-effect-4-runtime-migration.md`,
 * §7 R1, boundary kind 3: the published SDK speaks Promises). That ruling is
 * superseded (2026-09-21): `effect` is a mandatory exact-pin peer dependency
 * of the whole package, the package has no external consumers, and TeXRA 1.0
 * keeps no parallel surfaces.
 */

// The services and their layer. `Sessions.layer(platform)` is the only way
// in: the composition root and the session factory under it stay internal,
// because a caller that reached them directly would hold a composed process
// and an open session with no scope to end either.
export type { AgentPlatform } from './effect/runtime.js';
export { Sessions } from './effect/sessions.js';
export type {
  Run,
  Session,
  SessionView,
  StartInput,
  RunView,
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
export {
  DatabaseOpenFailed,
  DatabaseReadFailed,
} from '@shared/session/database';
export type { SessionOpenError } from '@shared/session/database';

// The payloads, as the runtime defines them.
export { aggregateId } from '@shared/schemas';
export type { AgentEvent } from '@agent/trace';

// `AgentFlowResult` is deliberately sourced from its own module rather than
// from the `@agent/runtime` barrel. It appears in this package's PUBLIC
// declarations, and declaration emit follows whichever module a public type
// comes from: taking it from the barrel pulls the barrel's whole `.d.ts`
// graph — model handlers included — into the published type surface, which
// trips the provider-type leak check in `scripts/validate-artifacts.mjs`
// (`@anthropic-ai/sdk`).
export type {
  AgentFlowResult,
  ToolUseFlowResult,
  WorkflowFlowResult,
} from '@agent/runtime/AgentFlowResult';
export type {
  ITool,
  IToolRegistry,
  ToolHost,
} from '@agent/core/tools/ToolTypes';
export { MapToolRegistry } from '@agent/core/tools/ToolTypes';
export { defineTool } from '@tools/core/definition';
export type { DefinedTool } from '@tools/core/definition';
export type {
  AggregateId,
  RunId,
  SessionCloseReport,
  TranscriptSubscription,
} from '@shared/schemas';
export type { RequestError } from '@shared/session/requestErrors';
export type { Outcome, RuntimeRequest } from '@shared/session/runtimeRequest';
