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

function hasToolUseAgentType(yamlPath?: string): boolean {
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

export function getAgentOptionMetadata(
  agentName: string,
  directories: AgentDirectoryMap,
): AgentOptionMetadata {
  const definitionPath = findAgentYaml(agentName, directories);
  const multiplePath = findAgentYaml(agentName, directories, MULTIPLE_SUFFIX);
  return {
    hasDefinition: Boolean(definitionPath),
    hasMultiple: Boolean(multiplePath),
    isToolUse: hasToolUseAgentType(definitionPath),
  };
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
    label += 'ᵗ 🛠️';
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

  const classes: string[] = [];

  if (!metadata.hasDefinition) {
    classes.push('disabled-option', 'disabled-agent');
  }
  if (metadata.hasMultiple) {
    attributes.push('data-multiple="true"');
  }
  if (metadata.isToolUse) {
    attributes.push('data-tool-use="true"');
    classes.push('tool-use-option');
  }

  if (classes.length > 0) {
    attributes.push(`class="${classes.join(' ')}"`);
  }

  const label = decorateLabel(agentName, metadata);
  return `<option ${attributes.join(' ')}>${encodeHtml(label)}</option>`;
}

const WORKFLOW_GROUP_LABEL = 'Workflow Agents';
const TOOL_USE_GROUP_LABEL = 'Tool-Use Agents';

export function buildGroupedAgentOptions(
  agentNames: string[],
  directories: AgentDirectoryMap,
): string {
  const workflowOptions: string[] = [];
  const toolUseOptions: string[] = [];

  for (const agentName of agentNames) {
    const metadata = getAgentOptionMetadata(agentName, directories);
    const optionTag = createAgentOptionTag(agentName, metadata);
    if (metadata.isToolUse) {
      toolUseOptions.push(optionTag);
      continue;
    }
    workflowOptions.push(optionTag);
  }

  const sections: string[] = [];
  if (workflowOptions.length > 0) {
    sections.push(
      `<optgroup label="${encodeHtml(WORKFLOW_GROUP_LABEL)}" data-group="workflow">${workflowOptions.join('\n')}</optgroup>`,
    );
  }
  if (toolUseOptions.length > 0) {
    sections.push(
      `<optgroup label="${encodeHtml(TOOL_USE_GROUP_LABEL)}" data-group="tool-use">${toolUseOptions.join('\n')}</optgroup>`,
    );
  }

  return sections.join('\n');
}
