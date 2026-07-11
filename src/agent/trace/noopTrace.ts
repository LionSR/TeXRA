/**
 * No-op AgentTrace. Used as the default for SDK consumers who don't
 * subscribe to the run's event stream.
 */
import { nanoid } from 'nanoid';

import type { RunOutcome } from '@shared/schemas';

import type {
  AgentTrace,
  StageHandle,
  StageOptions,
  StreamHandle,
} from './AgentTrace';

const NOOP: () => void = () => undefined;

class NoopStageHandle implements StageHandle {
  constructor(readonly id: string | undefined) {}
  end(_status?: RunOutcome): void {}
  async within<T>(fn: () => Promise<T> | T): Promise<T> {
    return Promise.resolve(fn());
  }
  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    return Promise.resolve(fn());
  }
  child(_label: string, _options?: StageOptions): StageHandle {
    return new NoopStageHandle(nanoid());
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

  usage: NOOP,
  contextState: NOOP,
  toolStart: NOOP,
  toolEnd: NOOP,
  domain: NOOP,
  responseFinalized: NOOP,

  openStage(_label, options) {
    return new NoopStageHandle(options?.id ?? nanoid());
  },
  openStream(_kind, options) {
    return new NoopStreamHandle(options?.id ?? nanoid());
  },
};
