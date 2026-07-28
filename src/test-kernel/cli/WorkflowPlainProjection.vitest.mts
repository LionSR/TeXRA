import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '@agent/trace';
import { SessionEventHub } from '@agent/runtime/SessionEventHub';
import { attachWorkflowPlainProjection } from '@cli/runtime/workflowPlainProjection';
import {
  MESSAGE_TYPES,
  RUN_OUTCOME,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';

const streamId = 'workflow@model#abcdef' as StreamTabId;
const otherStreamId = 'child@model#123456' as StreamTabId;
const executionId = 'abcdef' as ExecutionId;

function emit(
  events: SessionEventHub,
  event: AgentEvent,
  target: StreamTabId = streamId,
): void {
  events.emit({ scope: 'run', streamId: target, event });
}

describe('attachWorkflowPlainProjection', () => {
  it('writes phase, call, log, and completion lines in stable order', () => {
    const events = new SessionEventHub();
    const lines: string[] = [];
    const beforeWrite = vi.fn();
    const detach = attachWorkflowPlainProjection(events, {
      streamId,
      writeLine: (line) => lines.push(line),
      beforeWrite,
    });

    emit(events, {
      type: 'workflow.task',
      stageId: 'phase-map',
      logId: 'task-read',
      task: {
        id: 'read',
        label: 'Read the argument',
        phase: 'Map',
        status: 'planned',
      },
    });
    emit(events, {
      type: 'stage.start',
      id: 'phase-map',
      label: 'Map',
      kind: 'phase',
      index: 0,
      total: 2,
    });
    emit(events, {
      type: 'workflow.task',
      stageId: 'phase-map',
      logId: 'task-read',
      task: {
        id: 'read',
        label: 'Read the argument',
        phase: 'Map',
        status: 'running',
      },
    });
    // Resolving the navigation target updates the structured card but does not
    // change its human-readable line.
    emit(events, {
      type: 'workflow.task',
      stageId: 'phase-map',
      logId: 'task-read',
      task: {
        id: 'read',
        label: 'Read the argument',
        phase: 'Map',
        status: 'running',
        childStreamId: otherStreamId,
      },
    });
    emit(events, {
      type: 'log',
      stageId: 'phase-map',
      level: 'info',
      message: 'Found two boundary cases.',
    });
    emit(events, {
      type: 'log',
      stageId: 'phase-map',
      level: 'debug',
      message: 'hidden debug detail',
    });
    emit(events, {
      type: 'log',
      stageId: 'phase-map',
      level: 'info',
      messageType: MESSAGE_TYPES.INTERNAL,
      message: 'hidden internal detail',
    });
    emit(events, {
      type: 'workflow.task',
      stageId: 'phase-map',
      logId: 'task-read',
      task: {
        id: 'read',
        label: 'Read the argument',
        phase: 'Map',
        status: 'completed',
        childStreamId: otherStreamId,
      },
    });
    emit(
      events,
      {
        type: 'stage.start',
        id: 'child-phase',
        label: 'Child phase',
        kind: 'phase',
      },
      otherStreamId,
    );
    emit(events, {
      type: 'result',
      outcome: RUN_OUTCOME.COMPLETED,
      executionId,
      streamId,
      agentName: 'proof-workflow',
      category: 'workflow',
      isSubagent: false,
    });

    expect(lines).toEqual([
      '◆ Map (1/2)',
      'Planned: Read the argument',
      'Running: Read the argument',
      'Found two boundary cases.',
      'Finished: Read the argument',
      'Finished: proof-workflow',
    ]);
    expect(beforeWrite).toHaveBeenCalledTimes(lines.length);

    detach();
    emit(events, {
      type: 'log',
      stageId: 'phase-map',
      level: 'info',
      message: 'after detach',
    });
    expect(lines.at(-1)).toBe('Finished: proof-workflow');
  });

  it('ignores root result events from other categories and child runs', () => {
    const events = new SessionEventHub();
    const lines: string[] = [];
    const detach = attachWorkflowPlainProjection(events, {
      streamId,
      writeLine: (line) => lines.push(line),
    });

    emit(events, {
      type: 'result',
      outcome: RUN_OUTCOME.FAILED,
      executionId,
      streamId,
      agentName: 'tool',
      category: 'toolUse',
      isSubagent: false,
    });
    emit(events, {
      type: 'result',
      outcome: RUN_OUTCOME.CANCELLED,
      executionId,
      streamId,
      agentName: 'child',
      category: 'workflow',
      isSubagent: true,
    });

    expect(lines).toEqual([]);
    detach();
  });

  it('prints phase-less calls immediately and flushes an unopened phase', () => {
    const events = new SessionEventHub();
    const lines: string[] = [];
    const detach = attachWorkflowPlainProjection(events, {
      streamId,
      writeLine: (line) => lines.push(line),
    });

    emit(events, {
      type: 'workflow.task',
      stageId: 'run',
      logId: 'loose',
      task: { id: 'loose', label: 'Loose check', status: 'planned' },
    });
    emit(events, {
      type: 'workflow.task',
      stageId: 'phase-write',
      logId: 'draft',
      task: {
        id: 'draft',
        label: 'Draft proof',
        phase: 'Write',
        status: 'planned',
      },
    });
    emit(events, {
      type: 'result',
      outcome: RUN_OUTCOME.CANCELLED,
      executionId,
      streamId,
      agentName: 'proof-workflow',
      category: 'workflow',
      isSubagent: false,
    });

    expect(lines).toEqual([
      'Planned: Loose check',
      '◆ Write',
      'Planned: Draft proof',
      'Cancelled: proof-workflow',
    ]);
    detach();
  });
});
