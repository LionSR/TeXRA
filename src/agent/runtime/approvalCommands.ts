import type { AgentRuntimeHost } from '@hosts/AgentRuntimeHost';
import type { StreamTabId } from '@shared/schemas';
import type { LineChanges } from '@shared/schemas/lineChanges';
import type { BashApprovalAction } from '@shared/schemas/prompts';
import {
  handleProgressViewBashApprovalAction,
  setBashApprovalSessionBypass,
} from '@tools/approval/bashApproval';
import { proposalApprovalState } from '@tools/approval/proposalApproval';
import {
  emitToolEditApprovalPrompt,
  isApprovalBypassedForStream,
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

export interface RuntimeApprovalBypassStatus {
  readonly toolEditBypass: boolean;
  readonly delegatedTaskBypass: boolean;
}

export interface RuntimeApprovalBypassToggleRequest {
  readonly streamId: StreamTabId;
  readonly runtimeHost: AgentRuntimeHost;
}

export type RuntimeApprovalDecisionBypassKind =
  | 'bash'
  | 'toolEdit'
  | 'superYolo';

export interface RuntimeApprovalDecisionBypassRequest {
  readonly accepted: boolean;
  readonly bypass?: RuntimeApprovalDecisionBypassKind | null;
  readonly streamId?: StreamTabId | null;
  readonly runtimeHost: AgentRuntimeHost;
}

export type RuntimeApprovalDecisionBypassResult =
  | {
      readonly status: 'applied';
      readonly bypass: RuntimeApprovalDecisionBypassKind;
      readonly streamId: StreamTabId;
    }
  | {
      readonly status: 'ignored';
      readonly reason: 'rejected' | 'no_bypass' | 'no_stream';
      readonly bypass?: RuntimeApprovalDecisionBypassKind;
      readonly streamId?: StreamTabId;
    };

export interface RuntimePendingToolEditApprovalEntry {
  readonly streamId?: StreamTabId;
  readonly runtimeHost?: AgentRuntimeHost;
  readonly isSettled: () => boolean;
  readonly settle: (result: RuntimeToolEditApprovalResult) => void;
}

export interface RuntimeToolEditApprovalPromptStartRequest {
  readonly requestId: string;
  readonly request: RuntimeToolEditApprovalRequest;
  readonly runtimeHost: AgentRuntimeHost;
  readonly pending: RuntimePendingToolEditApprovalEntry;
}

export interface RuntimeToolEditApprovalPromptDisplay {
  readonly relativePath: string;
  readonly lineChanges: LineChanges;
}

export interface RuntimeToolEditApprovalPromptSession {
  readonly requestId: string;
  emitPrompt(prompt: RuntimeToolEditApprovalPromptDisplay): void;
  complete(): void;
}

/** Resolve a pending bash approval request from a host/user decision. */
export function resolveRuntimeBashApproval(
  request: RuntimeBashApprovalResolution,
): Promise<void> {
  return handleProgressViewBashApprovalAction(request);
}

/** Set bash approval bypass for a runtime stream. */
function setRuntimeBashApprovalSessionBypass({
  streamId,
  enabled,
  runtimeHost,
  silent,
}: RuntimeApprovalBypassRequest): void {
  const options = silent === undefined ? undefined : { silent };
  setBashApprovalSessionBypass(streamId, enabled, runtimeHost, options);
}

/** Set tool-edit approval bypass for a runtime stream. */
function setRuntimeToolEditApprovalSessionBypass({
  streamId,
  enabled,
  runtimeHost,
  silent,
}: RuntimeApprovalBypassRequest): void {
  const options = silent === undefined ? undefined : { silent };
  setToolEditApprovalSessionBypass(streamId, enabled, runtimeHost, options);
}

function setRuntimeDelegatedTaskApprovalBypass({
  streamId,
  enabled,
  runtimeHost,
}: RuntimeApprovalBypassRequest): void {
  proposalApprovalState.setBypass(streamId, enabled, runtimeHost);
  setRuntimeToolEditApprovalSessionBypass({
    streamId,
    enabled,
    runtimeHost,
  });
  setRuntimeBashApprovalSessionBypass({
    streamId,
    enabled,
    runtimeHost,
    silent: true,
  });
}

/**
 * Apply the session bypass carried by an accepted host approval decision.
 *
 * Hosts should pass the decision facts here instead of remembering which
 * lower-level approval bypass store belongs to bash, tool-edit, or delegated
 * tasks.
 */
export function applyRuntimeApprovalDecisionBypass({
  accepted,
  bypass,
  streamId,
  runtimeHost,
}: RuntimeApprovalDecisionBypassRequest): RuntimeApprovalDecisionBypassResult {
  if (!accepted) {
    return {
      status: 'ignored',
      reason: 'rejected',
      ...(bypass ? { bypass } : {}),
      ...(streamId ? { streamId } : {}),
    };
  }
  if (!bypass) {
    return {
      status: 'ignored',
      reason: 'no_bypass',
      ...(streamId ? { streamId } : {}),
    };
  }
  if (!streamId) {
    return {
      status: 'ignored',
      reason: 'no_stream',
      bypass,
    };
  }

  switch (bypass) {
    case 'bash':
      setRuntimeBashApprovalSessionBypass({
        streamId,
        enabled: true,
        runtimeHost,
      });
      break;
    case 'toolEdit':
      setRuntimeToolEditApprovalSessionBypass({
        streamId,
        enabled: true,
        runtimeHost,
      });
      break;
    case 'superYolo':
      setRuntimeDelegatedTaskApprovalBypass({
        streamId,
        enabled: true,
        runtimeHost,
      });
      break;
  }

  return { status: 'applied', bypass, streamId };
}

/** Return host-safe approval bypass flags for a runtime stream. */
export function getRuntimeApprovalBypassStatus(
  streamId: StreamTabId,
): RuntimeApprovalBypassStatus {
  return {
    toolEditBypass: isApprovalBypassedForStream(streamId),
    delegatedTaskBypass: proposalApprovalState.isBypassed(streamId),
  };
}

/**
 * Set the visible tool-action shield state for a runtime stream.
 *
 * The shield represents one user concept, but it owns two runtime bypasses:
 * tool edits and bash execution. Bash is updated silently because the shield
 * state is rendered from the tool-edit bypass event.
 */
export function setRuntimeCoupledApprovalBypass({
  streamId,
  enabled,
  runtimeHost,
}: RuntimeApprovalBypassRequest): boolean {
  setRuntimeToolEditApprovalSessionBypass({
    streamId,
    enabled,
    runtimeHost,
  });
  setRuntimeBashApprovalSessionBypass({
    streamId,
    enabled,
    runtimeHost,
    silent: true,
  });
  return enabled;
}

/** Toggle the visible tool-action shield and return its new state. */
export function toggleRuntimeCoupledApprovalBypass({
  streamId,
  runtimeHost,
}: RuntimeApprovalBypassToggleRequest): boolean {
  return setRuntimeCoupledApprovalBypass({
    streamId,
    enabled: !isApprovalBypassedForStream(streamId),
    runtimeHost,
  });
}

/**
 * Toggle delegated-task auto-approval and maintain its implied bypasses.
 *
 * Enabling delegated-task auto-approval must also enable tool-edit and bash
 * bypasses. Disabling it lowers both again so the visible stream controls
 * remain a coherent state vector.
 */
export function toggleRuntimeDelegatedTaskApprovalBypass({
  streamId,
  runtimeHost,
}: RuntimeApprovalBypassToggleRequest): boolean {
  const enabled = proposalApprovalState.toggleBypass(streamId, runtimeHost);
  if (enabled) {
    if (!isApprovalBypassedForStream(streamId)) {
      setRuntimeToolEditApprovalSessionBypass({
        streamId,
        enabled: true,
        runtimeHost,
      });
    }
  } else {
    setRuntimeToolEditApprovalSessionBypass({
      streamId,
      enabled: false,
      runtimeHost,
    });
  }
  setRuntimeBashApprovalSessionBypass({
    streamId,
    enabled,
    runtimeHost,
    silent: true,
  });
  return enabled;
}

/** Install or clear the host-provided tool-edit approval handler. */
export function setRuntimeToolEditApprovalHandler(
  handler?: RuntimeToolEditApprovalHandler,
): void {
  setToolEditApprovalHandler(handler);
}

/**
 * Start a runtime tool-edit approval prompt lifecycle.
 *
 * The returned session keeps pending-approval registration, prompt emission,
 * and progress-view prompt resolution paired behind one runtime object. Hosts
 * still own diff editors, temp files, and previews, but they should not need to
 * remember that unregistering the pending approval and resolving the progress
 * prompt are one cleanup transition.
 */
export function startRuntimeToolEditApprovalPrompt({
  requestId,
  request,
  runtimeHost,
  pending,
}: RuntimeToolEditApprovalPromptStartRequest): RuntimeToolEditApprovalPromptSession {
  let completed = false;
  registerPendingApproval(requestId, pending);

  return {
    requestId,
    emitPrompt({ relativePath, lineChanges }) {
      if (completed) return;
      emitToolEditApprovalPrompt(runtimeHost, {
        requestId,
        request,
        relativePath,
        lineChanges,
      });
    },
    complete() {
      if (completed) return;
      completed = true;
      unregisterPendingApproval(requestId);
      runtimeHost.emit('resolveToolEditPermission', { requestId });
    },
  };
}
