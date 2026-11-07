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
 * Model requests go through the harness's own HTTP transport. To answer them
 * yourself (a scripted model in a test), merge {@link ModelFetch} beneath
 * `Sessions.layer` with `Layer.provideMerge`.
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
 *   and what a tool or plugin is written with (`defineTool`, `definePlugin`,
 *   `ToolContext`, `Settings`, `WorkspaceFs`).
 * - [`@texra-ai/harness/node`](./node): `nodePlatform(options)` and Node.js
 *   filesystem, SQLite, and process building blocks.
 * - [`@texra-ai/harness/host`](./host): what a full application host (TeXRA's
 *   editor, desktop and terminal apps) composes beyond this entry:
 *   `processLayer`, the agent catalog, and the config and state stores.
 */

// Building the process and opening sessions.
export { Sessions } from './effect/processLayer.js';
export type { ProjectView } from './controllers/session/readSessionView.js';
export type { AgentPlatform } from '@platform/agentPlatform';
export type { Composition } from './effect/sessions.js';
export type { WorkspaceRoots } from '@platform/workspaceRoots';
// The fetch model requests go through, merged beneath `Sessions.layer`:
// a fake model for a test, or the harness's own transport when absent.
export { ModelFetch } from '@platform/defaults/longRunningModelTransport';
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
// What a session's methods take and hand out: a run's id
// (`session.resume`), a commit position and a display event (`view`), a
// stored conversation's nodes (`records(runId).readConversation()`), a
// request (`session.request`), and the request an `ApprovalHandler` is
// asked with and the decision it answers.

// What a run reports while it runs, and how it ended.
export type { AgentEvent, StreamChunkEvent } from '@shared/session/agentEvent';
export { responseText } from '@agent/trace/TraceEmitter';
export type { RunEnd, RunStopReason } from '@shared/schemas';

// A session's stored runs: their listing, records, and deletion.
export type {
  HeldRun,
  RunDeletion,
  RunRecords,
} from './effect/sessionReads.js';

// The tables `executions` `query` reads (a script's SQL over its session's
// runs and calls) and their columns.
export { HISTORY_TABLES } from '@agent/runtime/historyQuery/views';

// Why starting, resuming or opening fails.
export {
  PluginsRefused,
  ResumeRefused,
  RunFailure,
  ToolsRefused,
} from './effect/errors.js';
export type { LaunchError } from './effect/errors.js';
export { LaunchRefused } from '@common/errors/agentErrors';
export {
  DatabaseOpenFailed,
  DatabaseReadFailed,
  SessionOptionsConflict,
} from '@shared/session/database';
export type { SessionOpenError } from '@shared/session/database';

// What `session.request` answers, and why it refuses.
export {
  isOutcomeOf,
  type Outcome,
  type OutcomeOf,
} from '@shared/session/runtimeRequest';
