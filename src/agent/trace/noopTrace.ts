/**
 * No-op AgentTrace. Used as the default for SDK consumers who don't
 * subscribe and as a baseline for the TeXRA-extended noop in
 * `@logger/noopTexraTrace`.
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

  usage: NOOP,
  contextState: NOOP,
  toolStart: NOOP,
  toolEnd: NOOP,
  domain: NOOP,

  openStage(_label, options) {
    return new NoopStageHandle(options?.id ?? randomUUID());
  },
  openStream(_kind, options) {
    return new NoopStreamHandle(options?.id ?? randomUUID());
  },
};
