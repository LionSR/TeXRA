import { isRemoteAgent } from '@agent/index/agentRegistry';
import { getStreamTabDisplayName } from '@agent/runtime/streamTab';
import type { SessionStreamMetadata } from '@controllers/session/SessionState';
import { getRuntimeModelLabel } from '@model/runtimeModelRegistry';
import type { StreamTabInfo, WorktreeInfo } from '@shared/schemas';
import {
  getCleanAgentName,
  projectStreamIdentityFields,
  runIdentityDisplayName,
} from '@shared/schemas';

interface StreamTabInfoInputs {
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
 * The parsed `RunIdentity` travels verbatim; display fields sit beside
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
  const { config } = metadata;
  const identityFields = projectStreamIdentityFields(metadata);
  const { identity } = identityFields;

  // A stream whose identity hasn't resolved yet (no `run.start` seen, no
  // durable record hydrated) has no RunIdentity to name it by. Its id's
  // prefix is the clean agent name, so showing that (not the whole
  // `agent#executionId` handle, and not a generic placeholder — #9861 tried
  // that and it hid the only real information available) lands these rows on
  // exactly the same label as a resolved run: the agent name, with the full
  // id on `name` for tooltips and parallel-run disambiguation.
  const identityName = identity
    ? runIdentityDisplayName(identity)
    : getStreamTabDisplayName(streamId);

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
    ...identityFields,
    name: streamId,
    label: identityName,
    model,
    modelLabel: model ? getRuntimeModelLabel(model) : undefined,
    command,
    isRemote,
    worktree,
  };
}
