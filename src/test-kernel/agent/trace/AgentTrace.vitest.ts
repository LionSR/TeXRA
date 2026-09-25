import { describe, expect, it } from 'vitest';
import { type AgentEvent, emitToolUseCard, TraceEmitter } from '@agent/trace';

/** Collect every event a fresh trace emits while `act` runs. */
function collectEvents(act: (trace: TraceEmitter) => void): AgentEvent[] {
  const trace = new TraceEmitter();
  const events: AgentEvent[] = [];
  trace.subscribe((event) => events.push(event));
  act(trace);
  return events;
}

type ToolUseCard = Parameters<typeof emitToolUseCard>[1];

/** Emit a card on a fresh trace and return only its tool.start/tool.end events. */
function collectToolEvents(card: ToolUseCard): AgentEvent[] {
  return collectEvents((trace) => emitToolUseCard(trace, card)).filter(
    (e) => e.type === 'tool.start' || e.type === 'tool.end',
  );
}

describe('emitToolUseCard', () => {
  it.each<{ name: string; card: ToolUseCard }>([
    {
      name: 'no status is passed (slow-tool path)',
      card: { toolName: 'bash', input: { command: 'ls' } },
    },
    {
      name: 'status is explicitly in_progress',
      card: {
        toolName: 'bash',
        input: { command: 'sleep' },
        status: 'in_progress',
      },
    },
  ])('emits only tool.start when $name', ({ card }) => {
    const toolEvents = collectToolEvents(card);

    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0]?.type).toBe('tool.start');
  });

  it.each<{ status: 'completed' | 'failed'; card: ToolUseCard }>([
    {
      status: 'completed',
      card: {
        toolName: 'todo_write',
        input: { items: [] },
        output: 'ok',
        status: 'completed',
      },
    },
    {
      status: 'failed',
      card: {
        toolName: 'bash',
        input: { command: 'false' },
        status: 'failed',
      },
    },
  ])(
    'emits tool.start + tool.end when status is $status (fast-tool path)',
    ({ status, card }) => {
      const toolEvents = collectToolEvents(card);

      expect(toolEvents).toHaveLength(2);
      const [start, end] = toolEvents;
      expect(start?.type).toBe('tool.start');
      expect(end?.type).toBe('tool.end');
      if (start?.type === 'tool.start' && end?.type === 'tool.end') {
        expect(end.status).toBe(status);
        // start and end share the same logId so the transcript can match them
        expect(end.logId).toBe(start.logId);
      }
    },
  );
});
