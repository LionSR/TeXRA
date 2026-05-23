/**
 * TexraTraceEmitter — TraceEmitter with TeXRA-specific sugar.
 *
 * The core {@link TraceEmitter} only knows agent-general primitives. This
 * subclass adds the helpers that depend on TeXRA's MessageType taxonomy,
 * tool-use card shape, and latex-specific events. Nothing in
 * `src/agent/trace/` references this file — the dependency runs from
 * `@logger` → `@agent/trace`, never the other way.
 */
import { randomUUID } from 'node:crypto';

import { TraceEmitter } from '@agent/trace';
import type { StagedEmitOptions, ToolStatus } from '@agent/trace';
import { buildErrorLogData } from '@common/errors/sdkErrorUtils';
import {
  END_GROUP_STATUS,
  MESSAGE_TYPES,
  type ContextManagementData,
  type EndGroupStatus,
  type ErrorContext,
  type ExtendedTokenUsageStats,
  type FileListEntry,
} from '@shared/schemas';

import type { FilesLoadedInput, TexraTrace, ToolStartRef } from './TexraTrace';

export class TexraTraceEmitter extends TraceEmitter implements TexraTrace {
  // ─── Domain log-event sugar ────────────────────────────────────────

  logError(
    message: string,
    err: unknown,
    context?: ErrorContext,
    groupId?: string,
  ): void {
    this.error(message, {
      messageType: MESSAGE_TYPES.ERROR,
      data: buildErrorLogData(err, context),
      stageId: groupId,
    });
  }

  logProgress(message: string, context?: ErrorContext, groupId?: string): void {
    this.info(message, {
      messageType: MESSAGE_TYPES.PROGRESS_STATUS,
      data: context,
      stageId: groupId,
    });
  }

  logErrorData(message: string, errorData: unknown, groupId?: string): void {
    this.error(message, {
      messageType: MESSAGE_TYPES.ERROR,
      data: errorData,
      stageId: groupId,
    });
  }

  logInternal(message: string, groupId?: string): void {
    this.info(message, {
      messageType: MESSAGE_TYPES.INTERNAL,
      stageId: groupId,
    });
  }

  debugInternal(message: string, groupId?: string): void {
    this.debug(message, {
      messageType: MESSAGE_TYPES.INTERNAL,
      stageId: groupId,
    });
  }

  logScratchpad(content: string, groupId?: string): void {
    this.info(content, {
      messageType: MESSAGE_TYPES.SCRATCHPAD,
      stageId: groupId,
    });
  }

  logContextManagement(
    message: string,
    data?: ContextManagementData,
    groupId?: string,
  ): void {
    this.info(message, {
      messageType: MESSAGE_TYPES.CONTEXT_MANAGEMENT,
      data,
      stageId: groupId,
    });
  }

  logContextState(
    inputTokens: number,
    contextWindow: number,
    groupId?: string,
  ): void {
    this.emit({
      type: 'context.state',
      inputTokens,
      contextWindow,
      stageId: groupId,
    });
  }

  missingOutputs(info: unknown, groupId?: string): void {
    const missing = (info as { missing?: unknown[] } | null)?.missing;
    const count = Array.isArray(missing) ? missing.length : 0;
    this.info(`${count} output file${count === 1 ? '' : 's'} missing`, {
      messageType: MESSAGE_TYPES.MISSING_OUTPUTS,
      data: info,
      stageId: groupId,
    });
  }

  latexDiff(results: unknown[], groupId?: string): void {
    this.info(`Latexdiff results: ${results.length}`, {
      messageType: MESSAGE_TYPES.LATEXDIFF,
      data: results,
      stageId: groupId,
    });
  }

  userMessage(message: string): void {
    this.info(message, { messageType: MESSAGE_TYPES.USER_MESSAGE });
  }

  // ─── File-list events ──────────────────────────────────────────────

  filesLoaded(input: FilesLoadedInput, options: StagedEmitOptions = {}): void {
    this.domain({
      key: 'filesLoaded',
      data: { category: input.category, entries: input.entries },
      text: input.category,
      stageId: options.stageId,
    });
  }

  logFileCategory(
    category: string,
    files: Array<Pick<FileListEntry, 'path'> & { ok?: boolean }>,
    groupId?: string,
  ): void {
    if (files.length === 0) return;
    const entries: FileListEntry[] = files.map((f) => ({
      path: f.path,
      ok: f.ok === true,
      source: category,
      sourceDisplay: category,
    }));
    this.filesLoaded({ category, entries }, { stageId: groupId });
  }

  // ─── Tool-use sugar ────────────────────────────────────────────────

  emitToolUse(data: unknown, groupId?: string): ToolStartRef {
    const logId = randomUUID();
    const resolvedGroupId = groupId ?? this.activeStageId();
    const toolName =
      (data as { toolName?: string } | null)?.toolName ?? 'unknown';
    const input = (data as { input?: unknown } | null)?.input;
    this.toolStart({ logId, toolName, input }, { stageId: resolvedGroupId });
    return { logId, groupId: resolvedGroupId };
  }

  logToolUseStart(
    toolName: string,
    input: unknown,
    groupId?: string,
  ): ToolStartRef {
    // Tool start is already announced by the `tool.start` event — subscribers
    // render the tool-use card from that. A second debug log line would be
    // redundant (transcript shows the card; channel filters debug by default).
    return this.emitToolUse({ toolName, input }, groupId);
  }

  updateToolUse(
    logId: string,
    toolUseLog: { toolName?: string; input?: unknown; output?: unknown },
    groupId?: string,
    status: ToolStatus = 'completed',
  ): void {
    this.toolEnd(
      { logId, status, result: { ...toolUseLog } },
      { stageId: groupId },
    );
  }

  logWebSearch(data: unknown, groupId?: string): void {
    this.domain({ key: 'webSearch', data, stageId: groupId });
  }

  logWebFetch(data: unknown, groupId?: string): void {
    this.domain({ key: 'webFetch', data, stageId: groupId });
  }

  statistics(stats: ExtendedTokenUsageStats, groupId?: string): void {
    this.usage(stats, { stageId: groupId });
  }

  // ─── Group primitives ──────────────────────────────────────────────

  startGroup(name: string, id?: string, parentGroupId?: string): string {
    // Direct emit — explicit `parentGroupId: undefined` produces a ROOT
    // group rather than inheriting the active stage. openStage's higher-
    // level API has the inherit-on-omit fallback; this primitive does not.
    const groupId = id ?? randomUUID();
    this.emit({
      type: 'stage.start',
      id: groupId,
      label: name,
      parentId: parentGroupId,
    });
    return groupId;
  }

  endGroup(
    id: string,
    status: EndGroupStatus = END_GROUP_STATUS.STOPPED,
  ): void {
    this.emit({ type: 'stage.end', id, status });
  }
}
