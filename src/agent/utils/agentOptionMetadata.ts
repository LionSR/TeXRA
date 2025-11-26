// Third-party imports
import { encode as encodeHtml } from 'he';
import * as yaml from 'yaml';

// Local imports - agent core
import {
  AgentType,
  AgentDefinitionSchema,
  parseAgentSetting,
  type AgentSetting,
} from '@agent/core/AgentDataclass';
import {
  mapToCandidates,
  resolveAgentDefinitionSync,
  type AgentDirectoryMap,
} from '@agent/utils/agentPathResolver';
import { RemoteAgentRegistry } from '@agent/remote/RemoteAgentRegistry';
import { AbsoluteFS } from '@utils/files';

export type { AgentDirectoryMap } from '@agent/utils/agentPathResolver';

export interface AgentOptionMetadata {
  hasDefinition: boolean;
  hasMultipleSibling: boolean;
  isMultipleOutput: boolean;
  isToolUse: boolean;
  isRemote: boolean;
  description?: string;
}

export interface AgentOptionsPayload {
  workflow: string;
  toolUse: string;
}

export interface AgentOptionDefaults {
  workflowAgent?: string;
  toolUseAgent?: string;
}

export const DEFAULT_WORKFLOW_AGENT = 'correct';
export const DEFAULT_TOOL_USE_AGENT = 'chat';

const MULTIPLE_SUFFIX = '_multiple';
const TOOL_USE_AGENT_TYPE = AgentType.ToolUse;

interface ParsedAgentDefinition {
  settings: AgentSetting;
  description?: string;
}

function readAgentDefinition(
  yamlPath?: string,
): ParsedAgentDefinition | undefined {
  if (!yamlPath) {
    return undefined;
  }
  try {
    const fileContent = AbsoluteFS.readSync(yamlPath);
    const parsed = AgentDefinitionSchema.parse(yaml.parse(fileContent));
    return {
      settings: parseAgentSetting(parsed.settings),
      description: parsed.description,
    };
  } catch {
    return undefined;
  }
}

function getMultipleOutputFlag(parsed?: ParsedAgentDefinition): boolean {
  if (!parsed?.settings) {
    return false;
  }
  if (parsed.settings.agentType === AgentType.ToolUse) {
    return false;
  }
  return parsed.settings.isMultipleOutput ?? false;
}

export function getAgentOptionMetadata(
  agentName: string,
  directories: AgentDirectoryMap,
): AgentOptionMetadata {
  // Check if this is a remote agent using the registry
  const isRemote = RemoteAgentRegistry.isRemote(agentName);
  const cleanName = RemoteAgentRegistry.getCleanName(agentName);

  // Handle remote agents specially
  if (isRemote) {
    return {
      hasDefinition: true, // Remote agents always have definitions (on server)
      hasMultipleSibling: false,
      isMultipleOutput: false,
      isToolUse: false, // Remote agents are workflow agents by default
      isRemote: true,
    };
  }

  const candidates = mapToCandidates(directories);
  const definitionResolution = resolveAgentDefinitionSync(
    cleanName,
    candidates,
  );
  const multipleResolution = resolveAgentDefinitionSync(cleanName, candidates, {
    preferMultiple: true,
  });
  const parsed = readAgentDefinition(definitionResolution?.definitionPath);
  const isMultipleOutput = getMultipleOutputFlag(parsed);
  const hasMultipleSibling = Boolean(
    multipleResolution &&
      !multipleResolution.usedFallback &&
      multipleResolution.resolvedName.endsWith(MULTIPLE_SUFFIX),
  );
  return {
    hasDefinition: Boolean(definitionResolution),
    hasMultipleSibling,
    isMultipleOutput,
    isToolUse: parsed?.settings.agentType === TOOL_USE_AGENT_TYPE,
    isRemote: false,
    description: parsed?.description,
  };
}

function decorateLabel(
  agentName: string,
  metadata: AgentOptionMetadata,
): string {
  const cleanName = RemoteAgentRegistry.getCleanName(agentName);
  let label = cleanName;

  // Add cloud icon for remote agents
  if (metadata.isRemote) {
    label = `☁ ${cleanName}`;
  }

  if (metadata.hasMultipleSibling || metadata.isMultipleOutput) {
    label += ' ∶∶';
  }
  return label;
}

interface AgentOptionTagOptions {
  isSelected?: boolean;
}

export function createAgentOptionTag(
  agentName: string,
  metadata: AgentOptionMetadata,
  options: AgentOptionTagOptions = {},
): string {
  // Use the clean name (without remote:// prefix)
  const cleanName = RemoteAgentRegistry.getCleanName(agentName);

  const attributes = [
    `value="${encodeHtml(cleanName)}"`,
    `data-label="${encodeHtml(cleanName)}"`,
  ];

  if (!metadata.hasDefinition) {
    attributes.push('class="disabled-option disabled-agent"');
  }
  if (metadata.hasMultipleSibling || metadata.isMultipleOutput) {
    attributes.push('data-multiple="true"');
  }
  if (metadata.isToolUse) {
    attributes.push('data-tool-use="true"');
  }
  if (metadata.isRemote) {
    attributes.push('data-remote="true"');
  }
  if (metadata.description) {
    attributes.push(`data-description="${encodeHtml(metadata.description)}"`);
  }
  if (options.isSelected) {
    attributes.push('selected');
  }

  const label = decorateLabel(agentName, metadata);
  return `<vscode-option ${attributes.join(' ')}>${encodeHtml(label)}</vscode-option>`;
}

export function buildAgentOptionsPayload(
  agentNames: Iterable<string>,
  directories: AgentDirectoryMap,
  configuredToolUseAgents: Iterable<string> = [],
  defaults: AgentOptionDefaults = {},
): AgentOptionsPayload {
  interface OptionEntry {
    name: string;
    metadata: AgentOptionMetadata;
    isSelected: boolean;
  }

  const workflowEntries: OptionEntry[] = [];
  const toolUseEntries: OptionEntry[] = [];
  const configuredToolUseSet = new Set(configuredToolUseAgents);

  const seen = new Set<string>();
  for (const agentName of agentNames) {
    if (!agentName || seen.has(agentName)) {
      continue;
    }
    seen.add(agentName);
    const metadata = getAgentOptionMetadata(agentName, directories);
    const metadataWithConfig = configuredToolUseSet.has(agentName)
      ? { ...metadata, isToolUse: true }
      : metadata;
    const isDefaultWorkflow =
      defaults.workflowAgent && agentName === defaults.workflowAgent;
    const isDefaultToolUse =
      defaults.toolUseAgent && agentName === defaults.toolUseAgent;
    const entry: OptionEntry = {
      name: agentName,
      metadata: metadataWithConfig,
      isSelected: metadataWithConfig.isToolUse
        ? Boolean(isDefaultToolUse)
        : Boolean(isDefaultWorkflow),
    };
    if (metadataWithConfig.isToolUse) {
      toolUseEntries.push(entry);
    } else {
      workflowEntries.push(entry);
    }
  }

  const ensureOptions = (
    entries: OptionEntry[],
    defaultName: string | undefined,
    emptyMessage: string,
  ): string => {
    if (entries.length === 0) {
      return `<vscode-option value="">${emptyMessage}</vscode-option>`;
    }

    let orderedEntries = [...entries];
    let selectedName =
      orderedEntries.find((entry) => entry.isSelected)?.name ?? defaultName;

    let selectedIndex = selectedName
      ? orderedEntries.findIndex((entry) => entry.name === selectedName)
      : -1;

    if (
      selectedIndex === -1 ||
      !orderedEntries[selectedIndex]?.metadata.hasDefinition
    ) {
      const fallbackEntry =
        orderedEntries.find((entry) => entry.metadata.hasDefinition) ??
        orderedEntries[0];

      if (defaultName) {
        console.warn(
          `Default agent "${defaultName}" is missing or disabled. Falling back to "${fallbackEntry.name}".`,
        );
      }

      selectedName = fallbackEntry.name;
      selectedIndex = orderedEntries.findIndex(
        (entry) => entry.name === selectedName,
      );
    }

    if (selectedIndex > 0) {
      orderedEntries = [
        orderedEntries[selectedIndex],
        ...orderedEntries.slice(0, selectedIndex),
        ...orderedEntries.slice(selectedIndex + 1),
      ];
    }

    return orderedEntries
      .map((entry) =>
        createAgentOptionTag(entry.name, entry.metadata, {
          isSelected: entry.name === selectedName,
        }),
      )
      .join('\n');
  };

  return {
    workflow: ensureOptions(
      workflowEntries,
      defaults.workflowAgent,
      'No workflow agents available',
    ),
    toolUse: ensureOptions(
      toolUseEntries,
      defaults.toolUseAgent,
      'No tool-use agents available',
    ),
  };
}
