import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '@agent/trace';
import { SessionEventHub } from '@agent/runtime/SessionEventHub';
import { attachWorkflowPlainOutput } from '@cli/runtime/workflowPlainOutput';
import {
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
      streamId: target,
      executionId,
      identity: { kind: 'multiAgentWorkflow', workflowName: 'proof-workflow' },
    },
    target,
  );
}

function readTask(
  status: 'planned' | 'running' | 'completed',
  childStreamId?: StreamTabId,
): AgentEvent {
  return {
    type: 'workflow.call',
    stageId: 'phase-map',
    logId: 'task-read',
    call: {
      id: 'read',
      label: 'Read the argument',
      phase: 'Map',
      status,
      ...(childStreamId ? { childStreamId } : {}),
      ...(status === 'completed' ? { model: 'gpt56-' } : {}),
    },
  };
}

function logMessage(
  events: SessionEventHub,
  message: string,
  extras: Partial<{
    stageId: string;
    level: 'info' | 'debug';
    messageType: string;
  }> = {},
): void {
  emit(events, {
    type: 'log',
    stageId: 'phase-map',
    level: 'info',
    ...extras,
    message,
  });
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
      type: 'status',
      streamId,
      phase: status,
      cause: 'lifecycle',
    },
  });
}

function startProjection(beforeWrite?: () => void): {
  readonly events: SessionEventHub;
  readonly lines: readonly string[];
  readonly detach: () => void;
} {
  const events = new SessionEventHub();
  const lines: string[] = [];
  const detach = attachWorkflowPlainOutput(events, {
    writeLine: (line) => lines.push(line),
    beforeWrite,
  });
  return { events, lines, detach };
}

describe('attachWorkflowPlainOutput', () => {
  it('writes phase, call, log, and completion lines in stable order', () => {
    const beforeWrite = vi.fn();
    const { events, lines, detach } = startProjection(beforeWrite);
    startWorkflow(events);

    emit(events, {
      type: 'stage.start',
      id: 'phase-map',
      label: 'Map',
      kind: 'phase',
      index: 0,
      total: 2,
    });
    emit(events, readTask('planned'));
    emit(events, readTask('running'));
    // Resolving the navigation target updates the structured card but does not
    // change its human-readable line.
    emit(events, readTask('running', otherStreamId));
    logMessage(events, 'Found two boundary cases.');
    logMessage(events, 'hidden debug detail', { level: 'debug' });
    logMessage(events, 'hidden internal detail', {
      messageType: MESSAGE_TYPES.INTERNAL,
    });
    emit(events, readTask('completed', otherStreamId));
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

    // A log reader wants "started" and "finished": the pre-start states are
    // dropped, and the second running card (which only resolves the navigation
    // target) does not repeat the `Running:` line.
    expect(lines).toEqual([
      '◆ Map (1/2)',
      'Running: Read the argument',
      'Found two boundary cases.',
      'Finished: Read the argument · GPT-5.6 Terra',
      'Finished: proof-workflow',
    ]);
    expect(beforeWrite).toHaveBeenCalledTimes(lines.length);

    detach();
    logMessage(events, 'after detach');
    expect(lines.at(-1)).toBe('Finished: proof-workflow');
  });

  it('ignores ordinary workflow-agent streams', () => {
    const { events, lines, detach } = startProjection();

    emit(events, {
      type: 'run.start',
      streamId,
      executionId,
      identity: { kind: 'agent', agent: 'ordinary-workflow' },
    });
    emit(events, {
      type: 'workflow.call',
      logId: 'ordinary-task',
      call: { id: 'ordinary', label: 'Ordinary task', status: 'running' },
    });
    completeWorkflow(events, STREAM_PHASE.FAILED);

    expect(lines).toEqual([]);
    detach();
  });

  it('prints calls as they arrive under their already-open phase', () => {
    const { events, lines, detach } = startProjection();
    startWorkflow(events);

    emit(events, {
      type: 'workflow.call',
      stageId: 'run',
      logId: 'loose',
      call: { id: 'loose', label: 'Loose check', status: 'running' },
    });
    logMessage(events, 'Preparing the phase-less check.', { stageId: 'run' });
    emit(events, {
      type: 'workflow.call',
      stageId: 'phase-write',
      logId: 'draft',
      call: {
        id: 'draft',
        label: 'Draft proof',
        phase: 'Write',
        status: 'running',
      },
    });
    completeWorkflow(events, STREAM_PHASE.CANCELLED);

    expect(lines).toEqual([
      'Running: Loose check',
      'Preparing the phase-less check.',
      'Running: Draft proof',
      'Cancelled: proof-workflow',
    ]);
    detach();
  });

  it('prints one running line per call even when a later card adds the model', () => {
    const { events, lines, detach } = startProjection();
    startWorkflow(events);

    emit(events, readTask('planned'));
    emit(events, readTask('running'));
    emit(events, {
      type: 'workflow.call',
      stageId: 'phase-map',
      logId: 'task-read',
      call: {
        id: 'read',
        label: 'Read the argument',
        phase: 'Map',
        status: 'running',
        model: 'gpt56-',
      },
    });
    completeWorkflow(events, STREAM_PHASE.COMPLETED);

    expect(lines).toEqual([
      'Running: Read the argument',
      'Finished: proof-workflow',
    ]);
    detach();
  });
});
