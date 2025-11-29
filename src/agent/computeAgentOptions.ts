/**
 * Agent options computation using the AgentIndex.
 *
 * This module provides functions to compute agent dropdown options
 * from the cached AgentIndex, eliminating redundant file scanning.
 */

import {
  AgentIndex,
  AgentIndexLoader,
  buildAgentOptionsFromIndex,
  getDefaultWorkflowAgent,
  getDefaultToolUseAgent,
  DEFAULT_WORKFLOW_AGENT,
  DEFAULT_TOOL_USE_AGENT,
  type AgentOptionsPayload,
} from '@agent/index';

// Re-export types and constants for backwards compatibility
export type { AgentOptionsPayload };
export { DEFAULT_WORKFLOW_AGENT, DEFAULT_TOOL_USE_AGENT };

/**
 * Compute agent <vscode-option> tags for the agent dropdown.
 *
 * This function uses the cached AgentIndex instead of scanning files,
 * making it fast and suitable for both sync and async contexts.
 *
 * If the index hasn't been initialized yet, it will trigger initialization.
 */
export async function computeAgentOptions(): Promise<AgentOptionsPayload> {
  // Ensure the index is initialized
  if (!AgentIndex.isInitialized()) {
    await AgentIndexLoader.initialize();
  } else {
    // Wait for any in-progress initialization
    await AgentIndex.waitForInitialization();
  }

  // Build options from the cached index
  return buildAgentOptionsFromIndex({
    workflowAgent: getDefaultWorkflowAgent(),
    toolUseAgent: getDefaultToolUseAgent(),
  });
}

/**
 * Refresh the agent index and recompute options.
 * Call this when agent files change or remote agents are updated.
 */
export async function refreshAgentOptions(): Promise<AgentOptionsPayload> {
  await AgentIndexLoader.refreshAll();
  return buildAgentOptionsFromIndex({
    workflowAgent: getDefaultWorkflowAgent(),
    toolUseAgent: getDefaultToolUseAgent(),
  });
}

/**
 * Get agent options synchronously from the cached index.
 * Returns empty options if the index hasn't been initialized.
 *
 * Use this for initial HTML template generation where async isn't possible.
 */
export function computeAgentOptionsSync(): AgentOptionsPayload {
  if (!AgentIndex.isInitialized()) {
    // Return placeholder options - will be replaced by async call
    return {
      workflow: `<vscode-option value="${DEFAULT_WORKFLOW_AGENT}">${DEFAULT_WORKFLOW_AGENT}</vscode-option>`,
      toolUse: `<vscode-option value="${DEFAULT_TOOL_USE_AGENT}">${DEFAULT_TOOL_USE_AGENT}</vscode-option>`,
    };
  }

  return buildAgentOptionsFromIndex({
    workflowAgent: getDefaultWorkflowAgent(),
    toolUseAgent: getDefaultToolUseAgent(),
  });
}
