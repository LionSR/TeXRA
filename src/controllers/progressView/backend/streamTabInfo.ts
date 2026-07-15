import * as path from 'node:path';

import { isRemoteAgent } from '@agent/index/agentRegistry';
import { getRuntimeModelConfig } from '@model/runtimeModelRegistry';
import type { StreamTabInfo, WorktreeInfo } from '@shared/schemas';
import { AgentCategory, getCleanAgentName } from '@shared/schemas/agent';
import { isProcessAgent } from '@shared/streams/agentKind';
import type { ProgressStreamMetadata } from './state/ProgressViewState';

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
 * Replaces the duplicated, drift-prone implementations in
 * `streamInfoUtils.buildStreamInfo` (extension) and
 * `desktopAgentExecution.buildStreamInfo` (desktop).
 */
export function buildStreamTabInfo(inputs: StreamTabInfoInputs): StreamTabInfo {
  const { streamId, metadata } = inputs;

  const category = metadata.agentCategory ?? AgentCategory.Workflow;

  const inputFile = metadata.inputFile ?? '';
  const rawAgentName = metadata.agent ?? streamId.split('@')[0];
  const agentName = getCleanAgentName(rawAgentName);

  // Workflow agents include the input filename in the tab label so users
  // can tell parallel runs apart at a glance. Tool-use agents don't have
  // a single canonical input file, so we just show the agent name.
  const label =
    category !== AgentCategory.ToolUse && inputFile
      ? `${agentName}: ${path.basename(inputFile)}`
      : agentName;

  // Process agents (e.g. bash) carry a synthetic AgentConfig whose `model`
  // is the schema's prefault, not a real inference model — omit so the
  // tab footer doesn't lie.
  const resolvedAgent = metadata.agent ?? agentName;
  const processAgent = isProcessAgent(resolvedAgent);

  // Surface the full untruncated command for process streams (description
  // is capped for tab/tooltip rendering).
  const command =
    processAgent && metadata.instruction ? metadata.instruction : undefined;

  // Canonical host-known status takes precedence because setActiveStream can
  // identify a remote run before its agent is present in the registry.
  const isRemote =
    metadata.isRemote ?? (rawAgentName ? isRemoteAgent(rawAgentName) : false);

  // Worktree context comes from one of two sources, in order:
  //   1. An explicit hint passed in by the caller (already resolved branch /
  //      dirty / PR info via `resolveWorktreeInfo`).
  //   2. The agent config's `workingDirectory` override — surfaced as a
  //      minimal chip carrying just the path until async resolution lands.
  const worktree: WorktreeInfo | undefined =
    inputs.worktreeInfo ??
    (metadata.workingDirectory
      ? { workingDirectory: metadata.workingDirectory }
      : undefined);

  const base = {
    name: streamId,
    label,
    agent: resolvedAgent,
    agentCategory: category,
    isRemote,
    inputFile,
    creationTimestamp: metadata.creationTimestamp,
    executionId: metadata.executionId,
    parentStreamId: metadata.parentStreamId,
    description: metadata.description,
    worktree,
  };

  return processAgent
    ? { ...base, kind: 'process', command }
    : {
        ...base,
        kind: 'agent',
        model: metadata.model,
        modelLabel: metadata.model
          ? (getRuntimeModelConfig(metadata.model)?.label ?? metadata.model)
          : undefined,
      };
}
