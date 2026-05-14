import * as path from 'path';

import { MODEL_CONFIGS } from 'llm-zoo';

import type { AgentConfig } from '@agent/core/AgentConfig';
import type {
  AgentCategory,
  StreamTabInfo,
  WorktreeInfo,
} from '@shared/schemas';
import { AGENT_CATEGORY } from '@shared/schemas/agent';
import { isProcessAgent } from '@shared/streams/agentKind';

import { getCleanAgentName, isRemoteAgent } from './agentRegistry';

export interface StreamTabInfoInputs {
  streamId: string;
  /** Live taskState's config — preferred source of truth when available. */
  config?: AgentConfig;
  /** Fallback hints (e.g. for hydrated ghost streams without taskState). */
  hints?: {
    agent?: string;
    agentCategory?: AgentCategory;
    inputFile?: string;
    isRemote?: boolean;
  };
  creationTimestamp: number;
  executionId?: string;
  parentStreamId?: string;
  description?: string;
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
  const { streamId, config, hints, creationTimestamp } = inputs;

  const category =
    config?.agentCategory ?? hints?.agentCategory ?? AGENT_CATEGORY.WORKFLOW;

  const inputFile = config?.inputFile ?? hints?.inputFile ?? '';
  const rawAgentName = config?.agent ?? hints?.agent ?? streamId.split('@')[0];
  const agentName = getCleanAgentName(rawAgentName);

  // Workflow agents include the input filename in the tab label so users
  // can tell parallel runs apart at a glance. Tool-use agents don't have
  // a single canonical input file, so we just show the agent name.
  const label =
    category !== AGENT_CATEGORY.TOOL_USE && inputFile
      ? `${agentName}: ${path.basename(inputFile)}`
      : agentName;

  // Process agents (e.g. bash) carry a synthetic AgentConfig whose `model`
  // is the schema's prefault, not a real inference model — omit so the
  // tab footer doesn't lie.
  const processAgent = isProcessAgent(config?.agent ?? hints?.agent);

  // Surface the full untruncated command for process streams (description
  // is capped for tab/tooltip rendering).
  const command =
    processAgent && config?.instruction ? config.instruction : undefined;

  // Hint takes precedence: the runtime/event layer sometimes knows
  // remote-ness (e.g. setActiveStream payload) before the agent registry
  // is loaded, in which case `isRemoteAgent` would return false for a
  // genuinely remote agent.
  const isRemote =
    hints?.isRemote ?? (rawAgentName ? isRemoteAgent(rawAgentName) : false);

  // Worktree context comes from one of two sources, in order:
  //   1. An explicit hint passed in by the caller (already resolved branch /
  //      dirty / PR info via `resolveWorktreeInfo`).
  //   2. The agent config's `workingDirectory` override — surfaced as a
  //      minimal chip carrying just the path until async resolution lands.
  const worktree: WorktreeInfo | undefined =
    inputs.worktreeInfo ??
    (config?.workingDirectory
      ? { workingDirectory: config.workingDirectory }
      : undefined);

  return {
    name: streamId,
    label,
    model: processAgent ? undefined : config?.model,
    modelLabel:
      !processAgent && config?.model
        ? (MODEL_CONFIGS[config.model]?.label ?? config.model)
        : undefined,
    agent: config?.agent ?? hints?.agent,
    agentCategory: category,
    isRemote,
    inputFile,
    creationTimestamp,
    executionId: inputs.executionId,
    parentStreamId: inputs.parentStreamId,
    description: inputs.description,
    command,
    worktree,
  };
}
