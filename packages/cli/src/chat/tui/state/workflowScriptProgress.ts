import type { AgentEvent } from '@agent/trace';
import { TOOL_USE_STATUS, type StreamTabId } from '@shared/schemas';
import { normalizeToolUseData } from '@shared/toolUse';
import { DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME } from '@shared/constants/delegationTools';
import { isObject } from '@utils/core';

import {
  patchStream,
  streams,
  type ActiveWorkflowScriptInvocation,
  type ConversationEntry,
  type WorkflowScriptProgressFact,
} from './cliState';
import { syncStreamLog } from './subscribeStreamLog';

type ToolConversationEntry = Extract<ConversationEntry, { role: 'tool' }>;

function patchWorkflowScriptOwner(
  streamId: StreamTabId,
  logId: string,
  update: (entry: ToolConversationEntry) => ToolConversationEntry,
): void {
  patchStream(streamId, (slice) => {
    const index = slice.entries.findIndex(
      (entry) => entry.role === 'tool' && entry.id === logId,
    );
    const entry = slice.entries[index];
    if (index < 0 || entry?.role !== 'tool') return slice;

    const entries = [...slice.entries];
    entries[index] = update(entry);
    return { ...slice, entries };
  });
}

function appendWorkflowScriptFact(
  streamId: StreamTabId,
  logId: string,
  fact: WorkflowScriptProgressFact,
): void {
  patchWorkflowScriptOwner(streamId, logId, (entry) => ({
    ...entry,
    workflowScriptFacts: [...(entry.workflowScriptFacts ?? []), fact],
  }));
}

function startWorkflowScriptOwnership(
  streamId: StreamTabId,
  logId: string,
  parentStageId: string | undefined,
): void {
  patchStream(streamId, (slice) => {
    const index = slice.entries.findIndex(
      (entry) => entry.role === 'tool' && entry.id === logId,
    );
    const entry = slice.entries[index];
    if (index < 0 || entry?.role !== 'tool') return slice;
    const entries = [...slice.entries];
    entries[index] = {
      ...entry,
      workflowScriptFacts: entry.workflowScriptFacts ?? [],
    };
    return {
      ...slice,
      entries,
      activeWorkflowScript: {
        logId,
        parentStageId,
        phaseIds: new Set(),
        nextFactIndex: 0,
      },
    };
  });
}

function activeWorkflowScript(
  streamId: StreamTabId,
): ActiveWorkflowScriptInvocation | undefined {
  return streams.get().get(streamId)?.activeWorkflowScript;
}

function terminalWorkflowScriptToolUse(
  entry: ToolConversationEntry,
  outcome: 'completed' | 'failed',
  result: unknown,
): ToolConversationEntry['toolUse'] {
  let resultData: Record<string, unknown>;
  if (isObject(result)) resultData = result;
  else if (result === undefined) resultData = {};
  else resultData = { output: result };
  const normalized = normalizeToolUseData({
    ...entry.toolUse.parsed,
    ...resultData,
    status: TOOL_USE_STATUS.COMPLETED,
  });
  const terminal = normalized ?? {
    ...entry.toolUse,
    status: TOOL_USE_STATUS.COMPLETED,
  };
  if (outcome === 'completed') return terminal;

  const failureText =
    (typeof resultData.error === 'string' && resultData.error.trim()) ||
    (typeof resultData.output === 'string' && resultData.output.trim()) ||
    'Workflow script failed.';
  return {
    ...terminal,
    errorText: terminal.errorText || failureText,
    headerSummary: terminal.headerSummary || failureText,
    isError: true,
  };
}

function finishWorkflowScriptOwnership(
  streamId: StreamTabId,
  invocation: ActiveWorkflowScriptInvocation,
  outcome: 'completed' | 'failed',
  result: unknown,
): void {
  patchStream(streamId, (slice) => {
    if (slice.activeWorkflowScript !== invocation) return slice;
    const index = slice.entries.findIndex(
      (entry) => entry.role === 'tool' && entry.id === invocation.logId,
    );
    const entry = slice.entries[index];
    if (index < 0 || entry?.role !== 'tool') return slice;

    const entries = [...slice.entries];
    entries[index] = {
      ...entry,
      toolUse: terminalWorkflowScriptToolUse(entry, outcome, result),
      workflowScriptOutcome: outcome,
    };
    const { activeWorkflowScript: _finished, ...rest } = slice;
    return { ...rest, entries };
  });
}

/** Project workflow-script lifecycle facts into their owning CLI tool row. */
export function applyWorkflowScriptProgressEvent(
  event: AgentEvent,
  streamId: StreamTabId,
): boolean {
  switch (event.type) {
    case 'stage.start': {
      if (event.kind !== 'phase') return false;
      const invocation = activeWorkflowScript(streamId);
      if (!invocation || event.parentId !== invocation.parentStageId) {
        return false;
      }
      appendWorkflowScriptFact(streamId, invocation.logId, {
        type: 'phase',
        id: `${invocation.logId}:phase:${event.id}`,
        stageId: event.id,
        label: event.label,
      });
      patchStream(streamId, (slice) =>
        slice.activeWorkflowScript === invocation
          ? {
              ...slice,
              activeWorkflowScript: {
                ...invocation,
                phaseIds: new Set([...invocation.phaseIds, event.id]),
              },
            }
          : slice,
      );
      return true;
    }
    case 'log': {
      const invocation = activeWorkflowScript(streamId);
      if (!invocation || event.stageId === undefined) return false;
      const inPhase = invocation.phaseIds.has(event.stageId);
      if (!inPhase && event.stageId !== invocation.parentStageId) return false;
      appendWorkflowScriptFact(streamId, invocation.logId, {
        type: 'log',
        id: `${invocation.logId}:log:${invocation.nextFactIndex}`,
        level: event.level,
        message: event.message,
        ...(inPhase ? { phaseId: event.stageId } : {}),
      });
      patchStream(streamId, (slice) =>
        slice.activeWorkflowScript === invocation
          ? {
              ...slice,
              activeWorkflowScript: {
                ...invocation,
                nextFactIndex: invocation.nextFactIndex + 1,
              },
            }
          : slice,
      );
      return true;
    }
    case 'tool.start':
      if (event.toolName !== DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME) return false;
      // The recorder runs before this bridge, so the canonical tool row is
      // available before synchronous workflow phase and log events arrive.
      syncStreamLog(streamId);
      startWorkflowScriptOwnership(streamId, event.logId, event.stageId);
      // Ordered prefix finalization keeps this row behind any earlier live tool.
      syncStreamLog(streamId);
      return true;
    case 'tool.end': {
      const invocation = activeWorkflowScript(streamId);
      if (!invocation || invocation.logId !== event.logId) return false;
      if (event.status === 'in_progress') {
        syncStreamLog(streamId);
        return true;
      }
      finishWorkflowScriptOwnership(
        streamId,
        invocation,
        event.status,
        event.result,
      );
      syncStreamLog(streamId);
      return true;
    }
    default:
      return false;
  }
}
