/**
 * No-op AgentTrace for suites whose code under test takes a trace they do
 * not assert on.
 */
import type {
  AgentTrace,
  StageHandle,
  StageOptions,
  StreamHandle,
} from '@agent/trace/AgentTrace';
import type { RunOutcome } from '@shared/schemas';
import { generateShortId } from '@utils/core';

const NOOP: () => void = () => undefined;

class NoopStageHandle implements StageHandle {
  constructor(readonly id: string | undefined) {}
  end(_status?: RunOutcome): void {}
  child(_label: string, _options?: StageOptions): StageHandle {
    return new NoopStageHandle(generateShortId());
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

  debug: NOOP,
  info: NOOP,
  warn: NOOP,
  error: NOOP,

  usage: NOOP,
  contextState: NOOP,
  toolStart: NOOP,
  toolEnd: NOOP,
  domain: NOOP,
  responseFinalized: NOOP,

  openStage(_label, options) {
    return new NoopStageHandle(options?.id ?? generateShortId());
  },
  openRun(_kind, options) {
    return new NoopStreamHandle(options?.id ?? generateShortId());
  },
};
