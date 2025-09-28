// Third-party imports
import { encode as encodeHtml } from 'he';
import { globSync } from 'glob';
import * as yaml from 'yaml';

// Local imports - agent core
import {
  AgentType,
  parseAgentSetting,
  type AgentSetting,
} from '@agent/core/AgentDataclass';

// Local imports - filesystem
import { AbsoluteFS } from '@utils/files';

export interface AgentDirectoryMap {
  custom?: string;
  builtIn?: string;
  builtInToolUse?: string;
}

export interface AgentOptionMetadata {
  hasDefinition: boolean;
  hasMultipleSibling: boolean;
  isMultipleOutput: boolean;
  isToolUse: boolean;
}

export interface AgentOptionsPayload {
  workflow: string;
  toolUse: string;
}

const DIRECTORY_KEYS: (keyof AgentDirectoryMap)[] = [
  'custom',
  'builtIn',
  'builtInToolUse',
];
const YAML_EXTENSION = '.yaml';
const MULTIPLE_SUFFIX = '_multiple';
const TOOL_USE_AGENT_TYPE = AgentType.ToolUse;

function normalizeDirectory(dir?: string): string | undefined {
  if (!dir) {
    return undefined;
  }
  if (!/\S/.test(dir)) {
    return undefined;
  }
  const trimmed = dir.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function findAgentYaml(
  agentName: string,
  directories: AgentDirectoryMap,
  suffix = '',
): string | undefined {
  const fileName = `${agentName}${suffix}${YAML_EXTENSION}`;
  for (const key of DIRECTORY_KEYS) {
    const baseDir = normalizeDirectory(directories[key]);
    if (!baseDir) {
      continue;
    }
    try {
      const matches = globSync(`**/${fileName}`, {
        cwd: baseDir,
        nodir: true,
        dot: false,
        absolute: true,
      });
      if (matches.length > 0) {
        return matches[0];
      }
    } catch {
      // Ignore filesystem errors so dropdown rendering continues.
    }
  }
  return undefined;
}

function readAgentDefinition(yamlPath?: string): AgentSetting | undefined {
  if (!yamlPath) {
    return undefined;
  }
  try {
    const fileContent = AbsoluteFS.readSync(yamlPath);
    const parsed = yaml.parse(fileContent) as { settings?: unknown };
    return parseAgentSetting(parsed?.settings ?? {});
  } catch {
    return undefined;
  }
}

function getMultipleOutputFlag(setting?: AgentSetting): boolean {
  if (!setting) {
    return false;
  }
  if (setting.agentType === AgentType.ToolUse) {
    return false;
  }
  return setting.isMultipleOutput ?? false;
}

export function getAgentOptionMetadata(
  agentName: string,
  directories: AgentDirectoryMap,
): AgentOptionMetadata {
  const definitionPath = findAgentYaml(agentName, directories);
  const multiplePath = findAgentYaml(agentName, directories, MULTIPLE_SUFFIX);
  const definition = readAgentDefinition(definitionPath);
  const isMultipleOutput = getMultipleOutputFlag(definition);
  return {
    hasDefinition: Boolean(definitionPath),
    hasMultipleSibling: Boolean(multiplePath),
    isMultipleOutput,
    isToolUse: definition?.agentType === TOOL_USE_AGENT_TYPE,
  };
}

function decorateLabel(
  agentName: string,
  metadata: AgentOptionMetadata,
): string {
  let label = agentName;
  if (metadata.hasMultipleSibling || metadata.isMultipleOutput) {
    label += ' ∶∶';
  }
  if (metadata.isToolUse) {
    label += 'ᵗ';
  }
  return label;
}

export function createAgentOptionTag(
  agentName: string,
  metadata: AgentOptionMetadata,
): string {
  const attributes = [
    `value="${encodeHtml(agentName)}"`,
    `data-label="${encodeHtml(agentName)}"`,
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

  const label = decorateLabel(agentName, metadata);
  return `<option ${attributes.join(' ')}>${encodeHtml(label)}</option>`;
}

export function buildAgentOptionsPayload(
  agentNames: Iterable<string>,
  directories: AgentDirectoryMap,
): AgentOptionsPayload {
  const workflowOptions: string[] = [];
  const toolUseOptions: string[] = [];

  const seen = new Set<string>();
  for (const agentName of agentNames) {
    if (!agentName || seen.has(agentName)) {
      continue;
    }
    seen.add(agentName);
    const metadata = getAgentOptionMetadata(agentName, directories);
    const optionTag = createAgentOptionTag(agentName, metadata);
    if (metadata.isToolUse) {
      toolUseOptions.push(optionTag);
    } else {
      workflowOptions.push(optionTag);
    }
  }

  const ensureOptions = (
    options: string[],
    placeholder: string,
    emptyMessage: string,
  ): string => {
    if (options.length === 0) {
      return `<option value="">${emptyMessage}</option>`;
    }
    return [`<option value="">${placeholder}</option>`, ...options].join('\n');
  };

  return {
    workflow: ensureOptions(
      workflowOptions,
      'Select a workflow agent',
      'No workflow agents available',
    ),
    toolUse: ensureOptions(
      toolUseOptions,
      'Select a tool-use agent',
      'No tool-use agents available',
    ),
  };
}
