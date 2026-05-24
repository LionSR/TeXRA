import { describe, expect, it } from 'vitest';

import { emitToolUseCard, TraceEmitter, type AgentEvent } from '@agent/trace';

function captureEvents(trace: TraceEmitter): AgentEvent[] {
  const events: AgentEvent[] = [];
  trace.subscribe((event) => {
    events.push(event);
  });
  return events;
}

describe('emitToolUseCard', () => {
  it('emits only tool.start when no status is passed (slow-tool path)', () => {
    const trace = new TraceEmitter();
    const events = captureEvents(trace);

    emitToolUseCard(trace, { toolName: 'bash', input: { command: 'ls' } });

    const toolEvents = events.filter(
      (e) => e.type === 'tool.start' || e.type === 'tool.end',
    );
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0]?.type).toBe('tool.start');
  });

  it('emits tool.start + tool.end when status is completed (fast-tool path)', () => {
    const trace = new TraceEmitter();
    const events = captureEvents(trace);

    emitToolUseCard(trace, {
      toolName: 'todo_write',
      input: { items: [] },
      output: 'ok',
      isError: false,
      status: 'completed',
    });

    const toolEvents = events.filter(
      (e) => e.type === 'tool.start' || e.type === 'tool.end',
    );
    expect(toolEvents).toHaveLength(2);
    expect(toolEvents[0]?.type).toBe('tool.start');
    expect(toolEvents[1]?.type).toBe('tool.end');
    if (toolEvents[1]?.type === 'tool.end') {
      expect(toolEvents[1].status).toBe('completed');
      // start and end share the same logId so the transcript can match them
      const startLogId =
        toolEvents[0]?.type === 'tool.start' ? toolEvents[0].logId : null;
      expect(toolEvents[1].logId).toBe(startLogId);
    }
  });

  it('emits tool.start + tool.end when status is failed', () => {
    const trace = new TraceEmitter();
    const events = captureEvents(trace);

    emitToolUseCard(trace, {
      toolName: 'bash',
      input: { command: 'false' },
      isError: true,
      status: 'failed',
    });

    const toolEvents = events.filter(
      (e) => e.type === 'tool.start' || e.type === 'tool.end',
    );
    expect(toolEvents).toHaveLength(2);
    if (toolEvents[1]?.type === 'tool.end') {
      expect(toolEvents[1].status).toBe('failed');
    }
  });

  it('does not emit tool.end when status is explicitly in_progress', () => {
    const trace = new TraceEmitter();
    const events = captureEvents(trace);

    emitToolUseCard(trace, {
      toolName: 'bash',
      input: { command: 'sleep' },
      status: 'in_progress',
    });

    const toolEvents = events.filter(
      (e) => e.type === 'tool.start' || e.type === 'tool.end',
    );
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0]?.type).toBe('tool.start');
  });
});
