import { isRemoteAgent } from '@agent/index/agentRegistry';
import type { SessionStreamMetadata } from '@controllers/session/SessionState';
import { getRuntimeModelConfig } from '@model/runtimeModelRegistry';
import type { StreamTabInfo, WorktreeInfo } from '@shared/schemas';
import { runIdentityName } from '@shared/schemas';
import { getCleanAgentName } from '@shared/schemas/agent';

export interface StreamTabInfoInputs {
  streamId: string;
  metadata: Readonly<SessionStreamMetadata>;
  /** Pre-resolved worktree context (branch, dirty, PR). Callers that have
   *  asynchronously resolved this pass it in so the stream tab can render a
   *  worktree chip without async work in this builder. */
  worktreeInfo?: WorktreeInfo;
}

/**
 * Build a StreamTabInfo from already-resolved primitives. Host-neutral so
 * both the extension's progress view and the Electron desktop main can
 * emit identical metadata to the shared <stream-tab> renderer.
 *
 * The parsed {@link RunIdentity} travels verbatim; display fields sit beside
 * it. A stream whose identity has not resolved yet (no `run.start` seen, no
 * durable record hydrated) renders pending — never a fabricated default kind
 * or category.
 *
 * Tab labels are the cleaned identity name only. Parallel runs are already
 * distinct via `name` (`agent#executionId`); input files stay on the run
 * config / files panel, not on the tab chip.
 */
export function buildStreamTabInfo(inputs: StreamTabInfoInputs): StreamTabInfo {
  const { streamId, metadata } = inputs;
  const { identity, config } = metadata;

  // A stream whose identity hasn't resolved yet (no `run.start` seen, no
  // durable record hydrated) has nothing readable to show. `streamId` is the
  // opaque `agent#executionId` handle (never parsed back; see
  // `src/agent/runtime/streamTab.ts`) — but it's what we have, and its
  // prefix (minted by `getStreamTabId()`) already *is* the clean agent name,
  // so it reads as e.g. "review#a4c8939992cf" rather than pure noise. A
  // generic placeholder here (tried in #9861, reverted) is strictly worse:
  // it hides the one piece of real information — which agent this is — that
  // the id string still carries even before identity resolves.
  const identityName = identity
    ? getCleanAgentName(runIdentityName(identity))
    : streamId;

  // Surface the full untruncated command for process streams (description
  // is capped for tab/tooltip rendering).
  const command =
    identity?.kind === 'process' ? config?.instruction : undefined;

  // Canonical host-known status takes precedence because setActiveStream can
  // identify a remote run before its agent is present in the registry.
  const isRemote =
    metadata.isRemote ??
    (identity?.kind === 'agent'
      ? isRemoteAgent(getCleanAgentName(identity.agent))
      : false);

  // Worktree context comes from one of two sources, in order:
  //   1. An explicit hint passed in by the caller (already resolved branch /
  //      dirty / PR info via `resolveWorktreeInfo`).
  //   2. The run's `workingDirectory` — surfaced as a minimal chip carrying
  //      just the path until async resolution lands.
  const worktree: WorktreeInfo | undefined =
    inputs.worktreeInfo ??
    (config?.workingDirectory
      ? { workingDirectory: config.workingDirectory }
      : undefined);

  // Process streams carry a synthetic AgentConfig whose `model` is the
  // schema's prefault, not a real inference model — only agent runs show one.
  const model = identity?.kind === 'agent' ? config?.model : undefined;

  return {
    name: streamId,
    label: identityName,
    identity,
    agentCategory: metadata.agentCategory,
    model,
    modelLabel: model
      ? (getRuntimeModelConfig(model)?.label ?? model)
      : undefined,
    command,
    isRemote,
    creationTimestamp: metadata.creationTimestamp,
    executionId: metadata.executionId,
    parentStreamId: metadata.parentStreamId,
    description: metadata.description,
    worktree,
  };
}
