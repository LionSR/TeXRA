// Third-party imports
import { encode as encodeHtml } from 'he';
import { globSync } from 'glob';
import * as yaml from 'yaml';

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

const DIRECTORY_KEYS: (keyof AgentDirectoryMap)[] = [
  'custom',
  'builtIn',
  'builtInToolUse',
];
const YAML_EXTENSION = '.yaml';
const MULTIPLE_SUFFIX = '_multiple';
const TOOL_USE_AGENT_TYPE = 'toolUse';

type AgentDefinition = {
  settings?: {
    agentType?: unknown;
    isMultipleOutput?: unknown;
  };
};

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

function readAgentDefinition(yamlPath?: string): AgentDefinition | undefined {
  if (!yamlPath) {
    return undefined;
  }
  try {
    const fileContent = AbsoluteFS.readSync(yamlPath);
    return yaml.parse(fileContent) as AgentDefinition;
  } catch {
    return undefined;
  }
}

function hasToolUseAgentType(definition?: AgentDefinition): boolean {
  return definition?.settings?.agentType === TOOL_USE_AGENT_TYPE;
}

function hasMultipleOutputFlag(definition?: AgentDefinition): boolean {
  return typeof definition?.settings?.isMultipleOutput === 'boolean'
    ? Boolean(definition?.settings?.isMultipleOutput)
    : false;
}

export function getAgentOptionMetadata(
  agentName: string,
  directories: AgentDirectoryMap,
): AgentOptionMetadata {
  const definitionPath = findAgentYaml(agentName, directories);
  const multiplePath = findAgentYaml(agentName, directories, MULTIPLE_SUFFIX);
  const definition = readAgentDefinition(definitionPath);
  return {
    hasDefinition: Boolean(definitionPath),
    hasMultipleSibling: Boolean(multiplePath),
    isMultipleOutput: hasMultipleOutputFlag(definition),
    isToolUse: hasToolUseAgentType(definition),
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
