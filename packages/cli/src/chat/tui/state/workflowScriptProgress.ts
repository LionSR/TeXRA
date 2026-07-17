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

/** Locate the tool row a workflow-script invocation is projecting onto. */
function findWorkflowToolEntry(
  entries: readonly ConversationEntry[],
  logId: string,
):
  | { readonly index: number; readonly entry: ToolConversationEntry }
  | undefined {
  const index = entries.findIndex(
    (entry) => entry.role === 'tool' && entry.id === logId,
  );
  const entry = entries[index];
  return entry?.role === 'tool' ? { index, entry } : undefined;
}

function patchWorkflowScriptOwner(
  streamId: StreamTabId,
  logId: string,
  update: (entry: ToolConversationEntry) => ToolConversationEntry,
): void {
  patchStream(streamId, (slice) => {
    const found = findWorkflowToolEntry(slice.entries, logId);
    if (!found) return slice;

    const entries = [...slice.entries];
    entries[found.index] = update(found.entry);
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
    const found = findWorkflowToolEntry(slice.entries, logId);
    if (!found) return slice;
    const entries = [...slice.entries];
    entries[found.index] = {
      ...found.entry,
      workflowScriptFacts: found.entry.workflowScriptFacts ?? [],
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

/** Patch the active-workflow-script invocation in place; no-op if a newer
 *  invocation has since taken ownership of the stream. */
function updateActiveWorkflowScript(
  streamId: StreamTabId,
  invocation: ActiveWorkflowScriptInvocation,
  update: (
    invocation: ActiveWorkflowScriptInvocation,
  ) => ActiveWorkflowScriptInvocation,
): void {
  patchStream(streamId, (slice) =>
    slice.activeWorkflowScript === invocation
      ? { ...slice, activeWorkflowScript: update(invocation) }
      : slice,
  );
}

function terminalWorkflowScriptState(
  entry: ToolConversationEntry,
  status: 'completed' | 'failed',
  result: unknown,
): Pick<ToolConversationEntry, 'toolUse' | 'workflowScriptOutcome'> {
  let resultData: Record<string, unknown>;
  if (isObject(result)) resultData = result;
  else if (result === undefined) resultData = {};
  else resultData = { output: result };
  const normalized = normalizeToolUseData({
    ...entry.toolUse.parsed,
    ...resultData,
    status,
  });
  const terminal = normalized ?? {
    ...entry.toolUse,
    status,
  };
  const failed = status === 'failed' || terminal.isError;
  if (!failed) {
    return { toolUse: terminal, workflowScriptOutcome: 'completed' };
  }

  const failureText =
    (typeof resultData.error === 'string' && resultData.error.trim()) ||
    (typeof resultData.output === 'string' && resultData.output.trim()) ||
    'Workflow script failed.';
  return {
    toolUse: {
      ...terminal,
      status: TOOL_USE_STATUS.FAILED,
      errorText: terminal.errorText || failureText,
      headerSummary: terminal.headerSummary || failureText,
      isError: true,
    },
    workflowScriptOutcome: 'failed',
  };
}

function finishWorkflowScriptOwnership(
  streamId: StreamTabId,
  invocation: ActiveWorkflowScriptInvocation,
  status: 'completed' | 'failed',
  result: unknown,
): void {
  patchStream(streamId, (slice) => {
    if (slice.activeWorkflowScript !== invocation) return slice;
    const found = findWorkflowToolEntry(slice.entries, invocation.logId);
    if (!found) return slice;

    const entries = [...slice.entries];
    const terminal = terminalWorkflowScriptState(found.entry, status, result);
    entries[found.index] = {
      ...found.entry,
      ...terminal,
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
      updateActiveWorkflowScript(streamId, invocation, (inv) => ({
        ...inv,
        phaseIds: new Set([...inv.phaseIds, event.id]),
      }));
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
      updateActiveWorkflowScript(streamId, invocation, (inv) => ({
        ...inv,
        nextFactIndex: inv.nextFactIndex + 1,
      }));
      return true;
    }
    case 'tool.start':
      if (event.toolName !== DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME) return false;
      if (!streams.get().has(streamId)) return false;
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
