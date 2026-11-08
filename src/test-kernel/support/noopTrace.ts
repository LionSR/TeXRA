/**
 * No-op AgentTrace for suites whose code under test takes a trace they do
 * not assert on.
 */
import type { AgentTrace, StreamHandle } from '@agent/trace/AgentTrace';
import { TraceEmitter } from '@agent/trace/TraceEmitter';

const NOOP: () => void = () => undefined;

class NoopStreamHandle implements StreamHandle {
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
  append(_text: string): void {}
  finalize(_finalText?: string): string {
    return '';
  }
}

export const noopTrace: AgentTrace = {
  emit: NOOP,

  debug: NOOP,
  info: NOOP,
  warn: NOOP,
  error: NOOP,
  output: NOOP,

  stage(_label, use) {
    return use(this);
  },
  openRun() {
    return new NoopStreamHandle(crypto.randomUUID());
  },
  // Through `emit`, so a suite that spreads this trace and replaces `emit`
  // sees the card's events.
  openToolCard(log) {
    return new TraceEmitter((event) => this.emit(event)).openToolCard(log);
  },
};
