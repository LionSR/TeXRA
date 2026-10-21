/**
 * AgentTrace — agent-general SDK surface for agent runs.
 *
 * One discriminated-event channel per run, fanned out to the sinks it was
 * built with. Plain `debug/info/warn/error`, stages, runs, and the domain
 * helpers are sugar over `emit()`.
 *
 * App-specific helpers (`logSdkError`/`logUserMessage`/etc.) are plain
 * functions over this interface in `helpers.ts`.
 */
export type {
  AgentEvent,
  ResultEvent,
  StreamChunkEvent,
  TraceArm,
} from './events';

export type { AgentTrace, StageHandle, StreamHandle } from './AgentTrace';

export { TraceEmitter } from './TraceEmitter';
export {
  logSdkError,
  logProviderError,
  startCompactionActivity,
  logProgressStatus,
  logUserMessage,
  logContextManagementEvent,
} from './helpers';
