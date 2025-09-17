// Third-party imports
import { glob, globSync } from 'glob';
import * as yaml from 'yaml';

// Local imports - agent runtime
import { loadYaml } from '@agent/runtime/agentLoad';

// Local imports - filesystem
import { AbsoluteFS } from '@utils/files';

/** Map of agent directory locations used for lookup. */
export interface AgentDirectoryMap {
  custom?: string;
  builtIn?: string;
  builtInToolUse?: string;
}

/** Metadata that controls how an agent option is rendered. */
export interface AgentOptionMetadata {
  hasDefinition: boolean;
  hasMultiple: boolean;
  isToolUse: boolean;
}

const YAML_EXTENSION = '.yaml';
const MULTIPLE_SUFFIX = '_multiple.yaml';
const TOOL_USE_AGENT_TYPE = 'toolUse';

interface AgentDefinitionLike {
  settings?: {
    agentType?: unknown;
  };
}

type Globber = typeof glob;
type GlobberSync = typeof globSync;

type MatchResolver<T> = (
  directories: AgentDirectoryMap,
  globFn: T,
  pattern: string,
) => Promise<string | undefined> | string | undefined;

const normalizeDirectory = (dir?: string): string | undefined => {
  if (!dir) {
    return undefined;
  }
  const trimmed = dir.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const directoryOrder: (keyof AgentDirectoryMap)[] = [
  'custom',
  'builtIn',
  'builtInToolUse',
];

const resolveMatch = async (
  directories: AgentDirectoryMap,
  globFn: Globber,
  pattern: string,
): Promise<string | undefined> => {
  for (const key of directoryOrder) {
    const baseDir = normalizeDirectory(directories[key]);
    if (!baseDir) {
      continue;
    }
    try {
      const matches = await globFn(pattern, {
        cwd: baseDir,
        dot: false,
        nodir: true,
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
};

const resolveMatchSync = (
  directories: AgentDirectoryMap,
  globFn: GlobberSync,
  pattern: string,
): string | undefined => {
  for (const key of directoryOrder) {
    const baseDir = normalizeDirectory(directories[key]);
    if (!baseDir) {
      continue;
    }
    try {
      const matches = globFn(pattern, {
        cwd: baseDir,
        dot: false,
        nodir: true,
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
};

const hasToolUseAgentType = (
  definition: AgentDefinitionLike | null,
): boolean => {
  if (!definition?.settings) {
    return false;
  }
  const { agentType } = definition.settings;
  return typeof agentType === 'string' && agentType === TOOL_USE_AGENT_TYPE;
};

const getAgentDefinition = async (
  yamlPath: string,
): Promise<AgentDefinitionLike | null> => {
  try {
    return (await loadYaml(yamlPath)) as AgentDefinitionLike;
  } catch {
    return null;
  }
};

const getAgentDefinitionSync = (
  yamlPath: string,
): AgentDefinitionLike | null => {
  try {
    const fileContent = AbsoluteFS.readSync(yamlPath);
    return yaml.parse(fileContent) as AgentDefinitionLike;
  } catch {
    return null;
  }
};

const computeMetadata = (params: {
  agentName: string;
  directories: AgentDirectoryMap;
  resolver: MatchResolver<typeof glob>;
  multipleResolver: MatchResolver<typeof glob>;
  definitionLoader: (yamlPath: string) => Promise<AgentDefinitionLike | null>;
}): Promise<AgentOptionMetadata> => {
  const {
    agentName,
    directories,
    resolver,
    multipleResolver,
    definitionLoader,
  } = params;
  return Promise.all([
    resolver(directories, glob, `**/${agentName}${YAML_EXTENSION}`) as Promise<
      string | undefined
    >,
    multipleResolver(
      directories,
      glob,
      `**/${agentName}${MULTIPLE_SUFFIX}`,
    ) as Promise<string | undefined>,
  ]).then(async ([yamlPath, multiplePath]) => {
    const definition = yamlPath ? await definitionLoader(yamlPath) : null;
    return {
      hasDefinition: Boolean(yamlPath),
      hasMultiple: Boolean(multiplePath),
      isToolUse: Boolean(yamlPath && hasToolUseAgentType(definition)),
    };
  });
};

const computeMetadataSync = (params: {
  agentName: string;
  directories: AgentDirectoryMap;
  resolver: MatchResolver<typeof globSync>;
  multipleResolver: MatchResolver<typeof globSync>;
  definitionLoader: (yamlPath: string) => AgentDefinitionLike | null;
}): AgentOptionMetadata => {
  const {
    agentName,
    directories,
    resolver,
    multipleResolver,
    definitionLoader,
  } = params;
  const yamlPath = resolver(
    directories,
    globSync,
    `**/${agentName}${YAML_EXTENSION}`,
  ) as string | undefined;
  const multiplePath = multipleResolver(
    directories,
    globSync,
    `**/${agentName}${MULTIPLE_SUFFIX}`,
  ) as string | undefined;
  const definition = yamlPath ? definitionLoader(yamlPath) : null;
  return {
    hasDefinition: Boolean(yamlPath),
    hasMultiple: Boolean(multiplePath),
    isToolUse: Boolean(yamlPath && hasToolUseAgentType(definition)),
  };
};

/**
 * Determine metadata for rendering an agent option asynchronously.
 */
export async function getAgentOptionMetadata(
  agentName: string,
  directories: AgentDirectoryMap,
): Promise<AgentOptionMetadata> {
  return computeMetadata({
    agentName,
    directories,
    resolver: resolveMatch,
    multipleResolver: resolveMatch,
    definitionLoader: getAgentDefinition,
  });
}

/**
 * Determine metadata for rendering an agent option synchronously.
 */
export function getAgentOptionMetadataSync(
  agentName: string,
  directories: AgentDirectoryMap,
): AgentOptionMetadata {
  return computeMetadataSync({
    agentName,
    directories,
    resolver: resolveMatchSync,
    multipleResolver: resolveMatchSync,
    definitionLoader: getAgentDefinitionSync,
  });
}

const MULTIPLE_DECORATOR = ' ∶∶';
const TOOL_USE_DECORATOR = 'ᵗ';

/**
 * Decorate an agent label with markers for special capabilities.
 */
export function decorateAgentLabel(
  agentName: string,
  metadata: AgentOptionMetadata,
): string {
  let label = agentName;
  if (metadata.hasMultiple) {
    label += MULTIPLE_DECORATOR;
  }
  if (metadata.isToolUse) {
    label += TOOL_USE_DECORATOR;
  }
  return label;
}

const escapeAttribute = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const escapeContent = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Create an HTML option tag string for the given agent and metadata.
 */
export function createAgentOptionTag(
  agentName: string,
  metadata: AgentOptionMetadata,
): string {
  const attributes = [
    `value="${escapeAttribute(agentName)}"`,
    `data-label="${escapeAttribute(agentName)}"`,
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

  const label = decorateAgentLabel(agentName, metadata);
  return `<option ${attributes.join(' ')}>${escapeContent(label)}</option>`;
}
