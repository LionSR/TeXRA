import * as path from 'node:path';

import { isRemoteAgent } from '@agent/index/agentRegistry';
import { getRuntimeModelConfig } from '@model/runtimeModelRegistry';
import type { StreamTabInfo, WorktreeInfo } from '@shared/schemas';
import { runIdentityName } from '@shared/schemas';
import { AgentCategory, getCleanAgentName } from '@shared/schemas/agent';
import type { ProgressStreamMetadata } from './ProgressViewState';

export interface StreamTabInfoInputs {
  streamId: string;
  metadata: Readonly<ProgressStreamMetadata>;
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
 */
export function buildStreamTabInfo(inputs: StreamTabInfoInputs): StreamTabInfo {
  const { streamId, metadata } = inputs;
  const { identity, config } = metadata;

  const identityName = identity
    ? getCleanAgentName(runIdentityName(identity))
    : streamId;

  const inputFile = (identity?.kind === 'agent' ? config?.inputFile : '') ?? '';

  // Workflow agents include the input filename in the tab label so users
  // can tell parallel runs apart at a glance. Tool-use agents don't have
  // a single canonical input file, so we just show the agent name.
  const label =
    metadata.agentCategory === AgentCategory.Workflow && inputFile
      ? `${identityName}: ${path.basename(inputFile)}`
      : identityName;

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
    label,
    identity,
    agentCategory: metadata.agentCategory,
    model,
    modelLabel: model
      ? (getRuntimeModelConfig(model)?.label ?? model)
      : undefined,
    command,
    isRemote,
    inputFile,
    creationTimestamp: metadata.creationTimestamp,
    executionId: metadata.executionId,
    parentStreamId: metadata.parentStreamId,
    description: metadata.description,
    worktree,
  };
}
