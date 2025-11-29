/**
 * AgentOptionsBuilder - Builds dropdown HTML from the AgentIndex.
 *
 * This replaces the old agentOptionMetadata.ts logic with a simpler
 * implementation that reads from the cached index instead of scanning
 * files on every call.
 */

import { encode as encodeHtml } from 'he';

import { AgentCategory } from '@agent/core/AgentDataclass';
import { AgentDirectorySource } from '@agent/runtime/AgentPathTypes';
import { getConfig } from '@utils/config';

import { AgentIndex } from './AgentIndex';
import { AgentIndexLoader } from './AgentIndexLoader';
import {
  AgentIndexEntry,
  createAgentIndexKey,
  shouldShowSourceIndicator,
} from './AgentIndexEntry';

export const DEFAULT_WORKFLOW_AGENT = 'correct';
export const DEFAULT_TOOL_USE_AGENT = 'chat';

export interface AgentOptionsPayload {
  workflow: string;
  toolUse: string;
}

export interface AgentOptionDefaults {
  workflowAgent?: string;
  toolUseAgent?: string;
}

interface OptionEntry {
  key: string; // source:name format
  entry: AgentIndexEntry;
  isSelected: boolean;
}

/**
 * Build dropdown options HTML from the agent index.
 */
export function buildAgentOptionsFromIndex(
  defaults: AgentOptionDefaults = {},
): AgentOptionsPayload {
  const workflowEntries = AgentIndex.getWorkflowEntries();
  const toolUseEntries = AgentIndex.getToolUseEntries();

  // Get configured agents to determine visibility
  const configuredWorkflowAgents = getConfig<string[]>('texra.agents', []);
  const configuredToolUseAgents = getConfig<string[]>('texra.toolUseAgents', []);

  // Filter to only show configured agents (or all if none configured)
  const visibleWorkflowEntries = filterVisibleEntries(
    workflowEntries,
    configuredWorkflowAgents,
    DEFAULT_WORKFLOW_AGENT,
  );

  const visibleToolUseEntries = filterVisibleEntries(
    toolUseEntries,
    configuredToolUseAgents,
    DEFAULT_TOOL_USE_AGENT,
  );

  // Build option entries with selection state
  const workflowOptions = buildOptionEntries(
    visibleWorkflowEntries,
    defaults.workflowAgent ?? DEFAULT_WORKFLOW_AGENT,
  );

  const toolUseOptions = buildOptionEntries(
    visibleToolUseEntries,
    defaults.toolUseAgent ?? DEFAULT_TOOL_USE_AGENT,
  );

  return {
    workflow: renderOptions(workflowOptions, 'No workflow agents available'),
    toolUse: renderOptions(toolUseOptions, 'No tool-use agents available'),
  };
}

/**
 * Filter entries to only include configured agents.
 * If no agents are configured, include all entries.
 * Always includes the default agent.
 */
function filterVisibleEntries(
  entries: AgentIndexEntry[],
  configuredNames: string[],
  defaultName: string,
): AgentIndexEntry[] {
  if (configuredNames.length === 0) {
    // No explicit configuration - show all entries
    return entries;
  }

  const configuredSet = new Set(configuredNames);
  configuredSet.add(defaultName); // Always include default

  return entries.filter((entry) => configuredSet.has(entry.name));
}

/**
 * Build option entries with selection state.
 */
function buildOptionEntries(
  entries: AgentIndexEntry[],
  defaultName: string,
): OptionEntry[] {
  // Sort entries: selected first, then by name
  const options: OptionEntry[] = entries.map((entry) => ({
    key: createAgentIndexKey(entry.source, entry.name),
    entry,
    isSelected: entry.name === defaultName,
  }));

  // Move selected entry to the front
  const selectedIndex = options.findIndex((opt) => opt.isSelected);
  if (selectedIndex > 0) {
    const selected = options.splice(selectedIndex, 1)[0];
    options.unshift(selected);
  } else if (selectedIndex === -1 && options.length > 0) {
    // No match for default, select first available
    options[0].isSelected = true;
  }

  return options;
}

/**
 * Render option entries to HTML.
 */
function renderOptions(options: OptionEntry[], emptyMessage: string): string {
  if (options.length === 0) {
    return `<vscode-option value="">${emptyMessage}</vscode-option>`;
  }

  return options.map((opt) => createAgentOptionTag(opt)).join('\n');
}

/**
 * Create a single <vscode-option> tag.
 * The value is "source:name" for unique identification.
 * The display label is just the agent name.
 */
function createAgentOptionTag(option: OptionEntry): string {
  const { key, entry, isSelected } = option;

  const attributes: string[] = [
    `value="${encodeHtml(key)}"`,
    `data-label="${encodeHtml(entry.name)}"`,
    `data-source="${encodeHtml(entry.source)}"`,
  ];

  if (!entry.hasDefinition) {
    attributes.push('class="disabled-option disabled-agent"');
  }

  if (entry.hasMultipleSibling || entry.isMultipleOutput) {
    attributes.push('data-multiple="true"');
  }

  if (entry.category === AgentCategory.ToolUse) {
    attributes.push('data-tool-use="true"');
  }

  // Add source indicator attributes for CSS styling
  if (shouldShowSourceIndicator(entry.source)) {
    if (entry.source === AgentDirectorySource.Remote) {
      attributes.push('data-remote="true"');
    }
    if (entry.source === AgentDirectorySource.Custom) {
      attributes.push('data-custom="true"');
    }
  }

  if (entry.description) {
    attributes.push(`data-description="${encodeHtml(entry.description)}"`);
  }

  if (isSelected) {
    attributes.push('selected');
  }

  // Display label is just the clean name
  const displayLabel = entry.name;

  return `<vscode-option ${attributes.join(' ')}>${encodeHtml(displayLabel)}</vscode-option>`;
}

/**
 * Get the default workflow agent name from configuration.
 */
export function getDefaultWorkflowAgent(): string {
  const configured = getConfig<string[]>('texra.agents', []);
  if (configured.length > 0) {
    return configured.includes(DEFAULT_WORKFLOW_AGENT)
      ? DEFAULT_WORKFLOW_AGENT
      : configured[0];
  }
  return DEFAULT_WORKFLOW_AGENT;
}

/**
 * Get the default tool-use agent name.
 */
export function getDefaultToolUseAgent(): string {
  return DEFAULT_TOOL_USE_AGENT;
}

// ============================================================================
// Async/Sync Option Computation
// ============================================================================

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
