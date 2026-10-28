/**
 * `@texra-ai/harness`: run an agent from a Node program, stated in Effect.
 *
 * > **Guide:** Read [Philosophy & Architecture](/api/) and
 * > [Durable Protocol & Recovery](/api/durable-protocol) for how the runtime
 * > works and how to embed it.
 *
 * What an embedder needs to know, in order:
 *
 * 1. `Sessions.layer({ platform, plugins })` builds the process. `platform`
 *    comes from `nodePlatform()` in `./node`; `plugins` is `harnessBuiltins`
 *    from `./plugins`, plus any plugin of your own.
 * 2. `sessions.open(roots)` gives the {@link Session} of one workspace.
 * 3. `session.start({ agent, instruction })` gives a {@link Run}: read
 *    `run.events` for its progress (`run.events.pipe(responseText)` for
 *    just the answer's text) and `run.result` for how it ended.
 * 4. `session.resume(runId)` continues a run a persistent session stored.
 * 5. `session.attach({ approve })` answers the approvals a run asks for.
 *
 * The surface is Effect: nothing here calls `Effect.runPromise`; your
 * program runs it at its own entry point. Every failure is a tagged error
 * listed below.
 *
 * ### Companion subpaths
 *
 * - [`@texra-ai/harness/schemas`](./schemas): browser-safe Effect Schemas, view
 *   types (`SessionView`, `RunView`, `TranscriptView`), and pure view queries.
 * - [`@texra-ai/harness/transcript`](./transcript): browser-safe transcript row
 *   projections and `RemoteSessionView` for UI renderers.
 * - [`@texra-ai/harness/plugins`](./plugins): built-in plugins (`harnessBuiltins`)
 *   and what a tool or plugin is written with (`definePlugin`, `ToolContext`).
 * - [`@texra-ai/harness/node`](./node): `nodePlatform(options)` and Node.js
 *   filesystem, SQLite, and process building blocks.
 * - [`@texra-ai/harness/host`](./host): what a full application host (TeXRA's
 *   editor, desktop and terminal apps) composes beyond this entry:
 *   `processLayer`, the agent catalog, settings, stores and secrets.
 */

// Building the process and opening sessions.
export { Sessions } from './effect/processLayer.js';
export type { AgentPlatform, Composition } from './effect/sessions.js';
export type { Plugin } from '@tools/plugins';
export type { WorkspaceRoots } from '@platform/workspaceRoots';
export type {
  ApprovalHandler,
  LocalSession,
  OpenOptions,
  ResumeInput,
  Run,
  Session,
  SessionHost,
  StartInput,
} from './effect/sessions.js';

// What a run reports while it runs, and how it ended.
export type { AgentEvent, StreamChunkEvent } from '@agent/trace';
export { responseText } from '@agent/trace/TraceEmitter';
export type { RunEnd } from '@shared/schemas';

// A session's stored runs: their listing, records, and deletion.
export type {
  HeldRun,
  RunDeletion,
  RunRecords,
} from './effect/sessionReads.js';
export type { RunResult } from '@agent/storage/runRecords';
export type { AgentRunListingEntry } from '@agent/storage/runListing';

// A custom tool, passed to a run as `start({ tools })`.
export { defineTool, type DefinedTool } from '@tools/core/definition';
export type { ITool } from '@agent/core/tools/ToolTypes';
export type { ToolResult } from '@shared/schemas';

// Why starting, resuming or opening fails.
export {
  PluginsRefused,
  ResumeRefused,
  RunFailure,
  ToolsRefused,
} from './effect/errors.js';
export type { LaunchError } from './effect/errors.js';
export { AgentNotFound } from '@agent/index/agentCatalog';
export {
  DatabaseOpenFailed,
  DatabaseReadFailed,
  SessionOptionsConflict,
} from '@shared/session/database';
export type { SessionOpenError } from '@shared/session/database';

// What `session.request` answers, and why it refuses.
export {
  Cancelled,
  HostRequestFailure,
  Internal,
  isRequestRefusal,
  NotOwner,
  Rejected,
  Unavailable,
  type RequestError,
  type RequestRefusal,
} from '@shared/session/runtimeRequest';
export type { Outcome, RunStopReason } from '@shared/session/runtimeRequest';
