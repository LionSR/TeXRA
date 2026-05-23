/**
 * No-op trace used as the default for RunContexts created without an
 * explicit trace (tests, embedded callers that don't care about events).
 */
import { randomUUID } from 'node:crypto';

import type { EndGroupStatus } from '@shared/schemas';

import type {
  AgentTrace,
  StageHandle,
  StageOptions,
  StreamHandle,
} from './AgentTrace';

const NOOP: () => void = () => undefined;

class NoopStageHandle implements StageHandle {
  constructor(readonly id: string | undefined) {}
  end(_status?: EndGroupStatus): void {}
  async within<T>(fn: () => Promise<T> | T): Promise<T> {
    return Promise.resolve(fn());
  }
  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    return Promise.resolve(fn());
  }
  child(_label: string, _options?: StageOptions): StageHandle {
    return new NoopStageHandle(randomUUID());
  }
}

class NoopStreamHandle implements StreamHandle {
  constructor(readonly id: string) {}
  append(_text: string): void {}
  finalize(_finalText?: string): string {
    return '';
  }
}

export const noopTrace: AgentTrace = {
  emit: NOOP,
  subscribe: () => NOOP,
  activeStageId: () => undefined,
  withStage: <T>(_id: string | undefined, fn: () => Promise<T> | T) =>
    Promise.resolve(fn()),

  debug: NOOP,
  info: NOOP,
  warn: NOOP,
  error: NOOP,
  logError: NOOP,
  logProgress: NOOP,
  logErrorData: NOOP,
  logInternal: NOOP,
  debugInternal: NOOP,
  logScratchpad: NOOP,
  logContextManagement: NOOP,
  logContextState: NOOP,
  missingOutputs: NOOP,
  latexDiff: NOOP,
  userMessage: NOOP,

  usage: NOOP,
  contextState: NOOP,
  filesLoaded: NOOP,
  logFileCategory: NOOP,
  toolStart: NOOP,
  toolEnd: NOOP,
  emitToolUse: () => ({ logId: randomUUID(), groupId: undefined }),
  logToolUseStart: () => ({ logId: randomUUID(), groupId: undefined }),
  updateToolUse: NOOP,
  logWebSearch: NOOP,
  logWebFetch: NOOP,
  domain: NOOP,

  openStage(_label, options) {
    return new NoopStageHandle(options?.id ?? randomUUID());
  },
  openStream(_kind, options) {
    return new NoopStreamHandle(options?.id ?? randomUUID());
  },
  startGroup: (_name, id) => id ?? randomUUID(),
  endGroup: NOOP,
};
