import {
  listRuntimeAgentsByCategory,
  loadRuntimeAgents,
} from '@agent/runtime/agentResolution';
import { AgentCategory } from '@shared/schemas/agent';

import { missingMultiAgentPresetMessage } from './agents';
import { CliUsageError } from './cliContext';
import { writeTextStderr } from './logSinks';
import {
  cliMultiAgentPlanHasGaps,
  findCliMultiAgentPreset,
  formatCliMultiAgentPresetRunWarnings,
  planCliMultiAgentPresetRun,
  planCliMultiAgentPresets,
  readCliMultiAgentPresets,
  type CliMultiAgentPreset,
  type CliMultiAgentPresetRunPlan,
} from './multiAgentPresets';
import { getCliAuthProvider } from './supabaseAuth';

interface MultiAgentRunPlanInit {
  readonly preset: string;
  readonly agent?: string;
}

interface RemoteAgentPlanReloadResult<T> {
  readonly value: T;
  readonly remoteAgentLoadAttempted: boolean;
}

export interface MultiAgentRunPlanLoadResult {
  readonly plan: CliMultiAgentPresetRunPlan;
  readonly remoteAgentLoadAttempted: boolean;
}

export interface MultiAgentPresetPlansLoadResult {
  readonly plans: readonly CliMultiAgentPresetRunPlan[];
  readonly remoteAgentLoadAttempted: boolean;
}

function planCurrentMultiAgentRun(
  init: MultiAgentRunPlanInit,
): CliMultiAgentPresetRunPlan {
  const preset = findCliMultiAgentPreset(
    readCliMultiAgentPresets(),
    init.preset,
  );
  if (!preset) {
    throw new CliUsageError(missingMultiAgentPresetMessage(init.preset));
  }
  return planCliMultiAgentPresetRun(preset, {
    workflowAgents: listRuntimeAgentsByCategory(AgentCategory.Workflow),
    toolUseAgents: listRuntimeAgentsByCategory(AgentCategory.ToolUse),
    agentOverride: init.agent,
  });
}

function planLoadedCliMultiAgentPresets(
  presets: readonly CliMultiAgentPreset[],
): CliMultiAgentPresetRunPlan[] {
  return planCliMultiAgentPresets(presets, {
    workflowAgents: listRuntimeAgentsByCategory(AgentCategory.Workflow),
    toolUseAgents: listRuntimeAgentsByCategory(AgentCategory.ToolUse),
  });
}

/**
 * Resolve a preset plan, then when it still has gaps and the user is
 * authenticated, perform a remote load and replan. Relay-served premium agents
 * are only visible after a remote load. Both headless `multi-agent run` and the
 * interactive `orchestrate` menu route through this runtime helper so command
 * entrypoints cannot drift.
 */
export async function loadCliMultiAgentRunPlan(
  init: MultiAgentRunPlanInit,
): Promise<MultiAgentRunPlanLoadResult> {
  await loadRuntimeAgents({ includeRemote: false });
  const result = await reloadRemoteAgentsForGaps(
    planCurrentMultiAgentRun(init),
    cliMultiAgentPlanHasGaps,
    () => planCurrentMultiAgentRun(init),
  );
  return {
    plan: result.value,
    remoteAgentLoadAttempted: result.remoteAgentLoadAttempted,
  };
}

export async function loadCliMultiAgentPresetPlanSet(
  presets: readonly CliMultiAgentPreset[],
): Promise<MultiAgentPresetPlansLoadResult> {
  await loadRuntimeAgents({ includeRemote: false });
  const result = await reloadRemoteAgentsForGaps(
    planLoadedCliMultiAgentPresets(presets),
    (plans) => plans.some(cliMultiAgentPlanHasGaps),
    () => planLoadedCliMultiAgentPresets(presets),
  );
  return {
    plans: result.value,
    remoteAgentLoadAttempted: result.remoteAgentLoadAttempted,
  };
}

async function reloadRemoteAgentsForGaps<T>(
  value: T,
  hasGaps: (value: T) => boolean,
  replan: () => T,
): Promise<RemoteAgentPlanReloadResult<T>> {
  if (hasGaps(value) && (await getCliAuthProvider().isAuthenticated())) {
    await loadRuntimeAgents();
    return { value: replan(), remoteAgentLoadAttempted: true };
  }
  return { value, remoteAgentLoadAttempted: false };
}

export function writeMissingPresetAgents(
  plan: CliMultiAgentPresetRunPlan,
): void {
  for (const warning of formatCliMultiAgentPresetRunWarnings(plan)) {
    writeTextStderr(warning);
  }
}
