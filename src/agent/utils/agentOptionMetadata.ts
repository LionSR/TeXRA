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

export interface AgentOptionEntry {
  agentName: string;
  metadata: AgentOptionMetadata;
}

export const AGENT_OPTION_GROUP_LABELS = {
  workflow: 'Workflows',
  toolUse: 'Tool-use agents',
} as const;

const AGENT_OPTION_GROUP_CLASSES = {
  workflow: 'agent-group agent-group--workflow',
  toolUse: 'agent-group agent-group--tool-use',
} as const;

const AGENT_OPTION_GROUP_DATA = {
  workflow: 'workflow',
  toolUse: 'tool-use',
} as const;

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

function createOptgroupMarkup(
  label: string,
  className: string,
  dataGroup: string,
  options: string[],
): string {
  if (options.length === 0) {
    return '';
  }

  return [
    `<optgroup class="${className}" data-group="${encodeHtml(
      dataGroup,
    )}" label="${encodeHtml(label)}">`,
    options.join('\n'),
    '</optgroup>',
  ]
    .filter(Boolean)
    .join('\n');
}

export function createGroupedAgentOptionMarkup(
  entries: AgentOptionEntry[],
): string {
  if (entries.length === 0) {
    return '';
  }

  const workflowOptions: string[] = [];
  const toolUseOptions: string[] = [];

  for (const { agentName, metadata } of entries) {
    const optionMarkup = createAgentOptionTag(agentName, metadata);
    if (metadata.isToolUse) {
      toolUseOptions.push(optionMarkup);
    } else {
      workflowOptions.push(optionMarkup);
    }
  }

  const groups: string[] = [];
  const workflowGroup = createOptgroupMarkup(
    AGENT_OPTION_GROUP_LABELS.workflow,
    AGENT_OPTION_GROUP_CLASSES.workflow,
    AGENT_OPTION_GROUP_DATA.workflow,
    workflowOptions,
  );
  if (workflowGroup) {
    groups.push(workflowGroup);
  }

  const toolUseGroup = createOptgroupMarkup(
    AGENT_OPTION_GROUP_LABELS.toolUse,
    AGENT_OPTION_GROUP_CLASSES.toolUse,
    AGENT_OPTION_GROUP_DATA.toolUse,
    toolUseOptions,
  );
  if (toolUseGroup) {
    groups.push(toolUseGroup);
  }

  return groups.join('\n');
}
