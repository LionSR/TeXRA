import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '@agent/trace';
import { SessionEventHub } from '@agent/runtime/SessionEventHub';
import { attachWorkflowPlainProjection } from '@cli/runtime/workflowPlainProjection';
import {
  buildRunDescriptor,
  MESSAGE_TYPES,
  STREAM_PHASE,
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

function startWorkflow(
  events: SessionEventHub,
  target: StreamTabId = streamId,
): void {
  emit(
    events,
    {
      type: 'run.start',
      descriptor: buildRunDescriptor({
        streamId: target,
        executionId,
        agent: 'proof-workflow',
        category: 'workflow',
        kind: 'workflowScript',
      }),
    },
    target,
  );
}

function completeWorkflow(
  events: SessionEventHub,
  status:
    | typeof STREAM_PHASE.COMPLETED
    | typeof STREAM_PHASE.CANCELLED
    | typeof STREAM_PHASE.FAILED,
): void {
  events.emit({
    scope: 'session',
    event: {
      type: 'updateStreamStatus',
      payload: { streamId, status },
    },
  });
}

describe('attachWorkflowPlainProjection', () => {
  it('writes phase, call, log, and completion lines in stable order', () => {
    const events = new SessionEventHub();
    const lines: string[] = [];
    const beforeWrite = vi.fn();
    const detach = attachWorkflowPlainProjection(events, {
      writeLine: (line) => lines.push(line),
      beforeWrite,
    });
    startWorkflow(events);

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
    completeWorkflow(events, STREAM_PHASE.COMPLETED);

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

  it('ignores ordinary workflow-agent streams', () => {
    const events = new SessionEventHub();
    const lines: string[] = [];
    const detach = attachWorkflowPlainProjection(events, {
      writeLine: (line) => lines.push(line),
    });

    emit(events, {
      type: 'run.start',
      descriptor: buildRunDescriptor({
        streamId,
        executionId,
        agent: 'ordinary-workflow',
        category: 'workflow',
        kind: 'agent',
      }),
    });
    emit(events, {
      type: 'workflow.task',
      logId: 'ordinary-task',
      task: { id: 'ordinary', label: 'Ordinary task', status: 'running' },
    });
    completeWorkflow(events, STREAM_PHASE.FAILED);

    expect(lines).toEqual([]);
    detach();
  });

  it('prints phase-less calls immediately and flushes an unopened phase', () => {
    const events = new SessionEventHub();
    const lines: string[] = [];
    const detach = attachWorkflowPlainProjection(events, {
      writeLine: (line) => lines.push(line),
    });
    startWorkflow(events);

    emit(events, {
      type: 'workflow.task',
      stageId: 'run',
      logId: 'loose',
      task: { id: 'loose', label: 'Loose check', status: 'planned' },
    });
    emit(events, {
      type: 'log',
      stageId: 'run',
      level: 'info',
      message: 'Preparing the phase-less check.',
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
    completeWorkflow(events, STREAM_PHASE.CANCELLED);

    expect(lines).toEqual([
      'Planned: Loose check',
      'Preparing the phase-less check.',
      '◆ Write',
      'Planned: Draft proof',
      'Cancelled: proof-workflow',
    ]);
    detach();
  });
});
