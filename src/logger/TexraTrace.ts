/**
 * TexraTrace — TeXRA-specific extension of {@link AgentTrace}.
 *
 * The core `AgentTrace` interface only carries agent-general primitives
 * (emit/subscribe/log/openStage/openStream/usage/etc.). Anything that
 * references TeXRA's MessageType taxonomy, latex-specific events, file-
 * loading semantics, or transcript-shaped tool-use payloads lives here.
 *
 * Host code (TeXRA's runtime, model handlers, output managers) uses
 * `TexraTrace`. Future SDK consumers that don't depend on TeXRA's
 * presentation layer can program against `AgentTrace`.
 */

import type {
  AgentTrace,
  StagedEmitOptions,
} from '@agent/trace';
import type { ToolStatus } from '@agent/trace';
import type {
  ContextManagementData,
  ErrorContext,
  ExtendedTokenUsageStats,
  FileListEntry,
} from '@shared/schemas';

/** Payload returned by tool-start helpers. */
export interface ToolStartRef {
  readonly logId: string;
  readonly groupId: string | undefined;
}

/** Input accepted by `filesLoaded` — entries plus a TeXRA category label. */
export interface FilesLoadedInput {
  readonly category: string;
  readonly entries: readonly FileListEntry[];
}

export interface TexraTrace extends AgentTrace {
  // ─── Domain log-event sugar (each emits a single `log` event with
  // a TeXRA messageType) ──────────────────────────────────────────────
  logError(
    message: string,
    err: unknown,
    context?: ErrorContext,
    groupId?: string,
  ): void;
  logProgress(message: string, context?: ErrorContext, groupId?: string): void;
  logErrorData(message: string, errorData: unknown, groupId?: string): void;
  logInternal(message: string, groupId?: string): void;
  debugInternal(message: string, groupId?: string): void;
  logScratchpad(content: string, groupId?: string): void;
  logContextManagement(
    message: string,
    data?: ContextManagementData,
    groupId?: string,
  ): void;
  logContextState(
    inputTokens: number,
    contextWindow: number,
    groupId?: string,
  ): void;
  missingOutputs(info: unknown, groupId?: string): void;
  latexDiff(results: unknown[], groupId?: string): void;
  userMessage(message: string): void;

  // ─── File-list events (TeXRA's prompt file-loading UI) ─────────────
  filesLoaded(input: FilesLoadedInput, options?: StagedEmitOptions): void;
  logFileCategory(
    category: string,
    files: Array<Pick<FileListEntry, 'path'> & { ok?: boolean }>,
    groupId?: string,
  ): void;

  // ─── Tool-use sugar (TeXRA's transcript tool-call cards) ──────────
  emitToolUse(data: unknown, groupId?: string): ToolStartRef;
  logToolUseStart(
    toolName: string,
    input: unknown,
    groupId?: string,
  ): ToolStartRef;
  updateToolUse(
    logId: string,
    toolUseLog: { toolName?: string; input?: unknown; output?: unknown },
    groupId?: string,
    status?: ToolStatus,
  ): void;
  logWebSearch(data: unknown, groupId?: string): void;
  logWebFetch(data: unknown, groupId?: string): void;

  // ─── Statistics is a TeXRA-typed wrapper of usage() ────────────────
  statistics(stats: ExtendedTokenUsageStats, groupId?: string): void;

  // ─── Group primitives kept on the TeXRA layer because the legacy
  // semantics (literal parentId = root group) are TeXRA-specific. The
  // agent-general API uses `openStage` with an inheriting fallback.
  startGroup(name: string, id?: string, parentGroupId?: string): string;
  endGroup(id: string, status?: import('@shared/schemas').EndGroupStatus): void;
}
