/**
 * AgentTrace — agent-general SDK surface for agent runs.
 *
 * One discriminated-event channel per run, fanned out to the sinks it was
 * built with. Plain `debug/info/warn/error`, stages, runs, and the domain
 * helpers are sugar over `emit()`.
 *
 * App-specific helpers (`logSdkError`/`logUserMessage`/etc.) are plain
 * functions over this interface in `helpers.ts` / `toolUseHelpers.ts`.
 */
export type { AgentEvent, ResultEvent } from './events';

export type { AgentTrace, StageHandle, StreamHandle } from './AgentTrace';

export { TraceEmitter } from './TraceEmitter';
export {
  startToolUseCard,
  endToolUseCard,
  emitToolUseCard,
  endOpenToolUseCards,
  type OpenToolUseCard,
  type ToolUseCardRef,
} from './toolUseHelpers';
export {
  logSdkError,
  logProviderError,
  startCompactionActivity,
  logProgressStatus,
  logUserMessage,
  logContextManagementEvent,
  logWebSearch,
  logFilesLoaded,
  logFileCategory,
} from './helpers';
