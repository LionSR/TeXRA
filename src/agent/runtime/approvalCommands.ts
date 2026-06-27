import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { StreamTabId } from '@shared/schemas';
import type { LineChanges } from '@shared/schemas/lineChanges';
import type { BashApprovalAction } from '@shared/schemas/prompts';
import {
  handleProgressViewBashApprovalAction,
  setBashApprovalSessionBypass,
} from '@tools/approval/bashApproval';
import {
  computeLineChangeSummary,
  computeUserPatch,
  emitToolEditApprovalPrompt,
  firstChangedLine,
  registerPendingApproval,
  setToolEditApprovalHandler,
  setToolEditApprovalSessionBypass,
  type ToolEditApprovalRequest,
  type ToolEditApprovalResult,
  unregisterPendingApproval,
} from '@tools/approval/toolEditApproval';

export type RuntimeToolEditApprovalRequest = ToolEditApprovalRequest;
export type RuntimeToolEditApprovalResult = ToolEditApprovalResult;
export type RuntimeToolEditApprovalHandler = (
  request: RuntimeToolEditApprovalRequest,
) => Promise<RuntimeToolEditApprovalResult>;

export interface RuntimeBashApprovalResolution {
  readonly requestId: string;
  readonly action: BashApprovalAction;
  readonly feedback?: string;
}

export interface RuntimeApprovalBypassRequest {
  readonly streamId: StreamTabId;
  readonly enabled: boolean;
  readonly runtimeHost: AgentRuntimeHost;
  readonly silent?: boolean;
}

export interface RuntimePendingToolEditApprovalEntry {
  readonly streamId?: StreamTabId;
  readonly runtimeHost?: AgentRuntimeHost;
  readonly isSettled: () => boolean;
  readonly settle: (result: RuntimeToolEditApprovalResult) => void;
}

export interface RuntimeToolEditApprovalPrompt {
  readonly requestId: string;
  readonly request: RuntimeToolEditApprovalRequest;
  readonly relativePath: string;
  readonly lineChanges: LineChanges;
}

/** Resolve a pending bash approval request from a host/user decision. */
export function resolveRuntimeBashApproval(
  request: RuntimeBashApprovalResolution,
): Promise<void> {
  return handleProgressViewBashApprovalAction(request);
}

/** Set bash approval bypass for a runtime stream. */
export function setRuntimeBashApprovalSessionBypass({
  streamId,
  enabled,
  runtimeHost,
  silent,
}: RuntimeApprovalBypassRequest): void {
  const options = silent === undefined ? undefined : { silent };
  setBashApprovalSessionBypass(streamId, enabled, runtimeHost, options);
}

/** Set tool-edit approval bypass for a runtime stream. */
export function setRuntimeToolEditApprovalSessionBypass({
  streamId,
  enabled,
  runtimeHost,
  silent,
}: RuntimeApprovalBypassRequest): void {
  const options = silent === undefined ? undefined : { silent };
  setToolEditApprovalSessionBypass(streamId, enabled, runtimeHost, options);
}

/** Install or clear the host-provided tool-edit approval handler. */
export function setRuntimeToolEditApprovalHandler(
  handler?: RuntimeToolEditApprovalHandler,
): void {
  setToolEditApprovalHandler(handler);
}

/** Register a pending runtime tool-edit approval for rejection tracking. */
export function registerRuntimePendingToolEditApproval(
  id: string,
  entry: RuntimePendingToolEditApprovalEntry,
): void {
  registerPendingApproval(id, entry);
}

/** Unregister a completed runtime tool-edit approval. */
export function unregisterRuntimePendingToolEditApproval(id: string): void {
  unregisterPendingApproval(id);
}

/** Emit the runtime prompt for a pending tool-edit approval. */
export function emitRuntimeToolEditApprovalPrompt(
  runtimeHost: AgentRuntimeHost,
  prompt: RuntimeToolEditApprovalPrompt,
): void {
  emitToolEditApprovalPrompt(runtimeHost, prompt);
}

export function computeRuntimeToolEditLineChangeSummary(
  original: string,
  proposed: string,
): LineChanges {
  return computeLineChangeSummary(original, proposed);
}

export function computeRuntimeToolEditUserPatch(
  suggestedContent: string,
  appliedContent: string,
): string | undefined {
  return computeUserPatch(suggestedContent, appliedContent);
}

export function findRuntimeToolEditFirstChangedLine(
  original: string,
  proposed: string,
): number | null {
  return firstChangedLine(original, proposed);
}
