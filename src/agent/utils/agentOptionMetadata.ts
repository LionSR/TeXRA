// Third-party imports
import { glob, globSync } from 'glob';
import * as yaml from 'yaml';

// Local imports - agent runtime
import { loadYaml } from '@agent/runtime/agentLoad';

// Local imports - filesystem
import { AbsoluteFS } from '@utils/files';

export interface AgentDirectoryMap {
  custom?: string;
  builtIn?: string;
  builtInToolUse?: string;
}

export interface AgentOptionMetadata {
  hasDefinition: boolean;
  hasMultiple: boolean;
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
  };
};

function normalizeDirectory(dir?: string): string | undefined {
  if (!dir) {
    return undefined;
  }
  const trimmed = dir.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function findAgentYaml(
  agentName: string,
  directories: AgentDirectoryMap,
  suffix = '',
): Promise<string | undefined> {
  const fileName = `${agentName}${suffix}${YAML_EXTENSION}`;
  for (const key of DIRECTORY_KEYS) {
    const baseDir = normalizeDirectory(directories[key]);
    if (!baseDir) {
      continue;
    }
    try {
      const matches = await glob(`**/${fileName}`, {
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

function findAgentYamlSync(
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

async function hasToolUseAgentType(yamlPath?: string): Promise<boolean> {
  if (!yamlPath) {
    return false;
  }
  try {
    const definition = (await loadYaml(yamlPath)) as AgentDefinition;
    return definition?.settings?.agentType === TOOL_USE_AGENT_TYPE;
  } catch {
    return false;
  }
}

function hasToolUseAgentTypeSync(yamlPath?: string): boolean {
  if (!yamlPath) {
    return false;
  }
  try {
    const fileContent = AbsoluteFS.readSync(yamlPath);
    const definition = yaml.parse(fileContent) as AgentDefinition;
    return definition?.settings?.agentType === TOOL_USE_AGENT_TYPE;
  } catch {
    return false;
  }
}

export async function getAgentOptionMetadata(
  agentName: string,
  directories: AgentDirectoryMap,
): Promise<AgentOptionMetadata> {
  const definitionPath = await findAgentYaml(agentName, directories);
  const multiplePath = await findAgentYaml(
    agentName,
    directories,
    MULTIPLE_SUFFIX,
  );
  return {
    hasDefinition: Boolean(definitionPath),
    hasMultiple: Boolean(multiplePath),
    isToolUse: await hasToolUseAgentType(definitionPath),
  };
}

export function getAgentOptionMetadataSync(
  agentName: string,
  directories: AgentDirectoryMap,
): AgentOptionMetadata {
  const definitionPath = findAgentYamlSync(agentName, directories);
  const multiplePath = findAgentYamlSync(
    agentName,
    directories,
    MULTIPLE_SUFFIX,
  );
  return {
    hasDefinition: Boolean(definitionPath),
    hasMultiple: Boolean(multiplePath),
    isToolUse: hasToolUseAgentTypeSync(definitionPath),
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function decorateLabel(
  agentName: string,
  metadata: AgentOptionMetadata,
): string {
  let label = agentName;
  if (metadata.hasMultiple) {
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
    `value="${escapeHtml(agentName)}"`,
    `data-label="${escapeHtml(agentName)}"`,
  ];

  if (!metadata.hasDefinition) {
    attributes.push('class="disabled-option disabled-agent"');
  }
  if (metadata.hasMultiple) {
    attributes.push('data-multiple="true"');
  }
  if (metadata.isToolUse) {
    attributes.push('data-tool-use="true"');
  }

  const label = decorateLabel(agentName, metadata);
  return `<option ${attributes.join(' ')}>${escapeHtml(label)}</option>`;
}
