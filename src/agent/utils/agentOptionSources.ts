// Standard library imports
import * as path from 'path';

// Third-party imports
import { glob } from 'glob';
import { globSync } from 'glob';
import type * as vscode from 'vscode';

// Local imports - agent utilities
import { type AgentDirectoryMap } from './agentOptionMetadata';

// Local imports - frontend utilities
import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';

// Local imports - configuration
import { getConfig } from '@utils/config';

// Local imports - filesystem
import { GlobalStorageFS } from '@utils/files';

const BUILT_IN_DIR = 'agents';
const TOOL_USE_DIR = 'tool_use_agents';
const YAML_EXTENSION = '.yaml';

interface AgentOptionConfigSnapshot {
  configuredAgents: string[];
  includeToolUseAgents: boolean;
  configuredCustomDirectory: string;
}

export interface AgentOptionInputs {
  agentNames: string[];
  directories: AgentDirectoryMap;
}

function readAgentOptionConfigSnapshot(): AgentOptionConfigSnapshot {
  return {
    configuredAgents: getConfig<string[]>('agents', []),
    includeToolUseAgents: getConfig<boolean>('includeToolUseAgents', false),
    configuredCustomDirectory: getConfig<string>(
      'explorer.agentsDirectory',
      '',
    ),
  };
}

function normalizeDirectory(directory?: string): string | undefined {
  if (!directory) {
    return undefined;
  }

  const trimmed = directory.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed;
}

function mergeAgentNames(primary: string[], secondary: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const candidate of [...primary, ...secondary]) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    merged.push(candidate);
  }

  return merged;
}

function extractAgentNamesFromFiles(files: string[]): string[] {
  return files.map((file) => file.replace(/\.yaml$/, '').replace(/.*\//, ''));
}

async function discoverToolUseAgentsAsync(
  directory?: string,
): Promise<string[]> {
  const normalizedDirectory = normalizeDirectory(directory);
  if (!normalizedDirectory) {
    return [];
  }

  try {
    const files = await glob(`**/*${YAML_EXTENSION}`, {
      cwd: normalizedDirectory,
      absolute: false,
      nodir: true,
      dot: false,
    });
    return extractAgentNamesFromFiles(files);
  } catch {
    return [];
  }
}

function discoverToolUseAgentsSync(directory?: string): string[] {
  const normalizedDirectory = normalizeDirectory(directory);
  if (!normalizedDirectory) {
    return [];
  }

  try {
    const files = globSync(`**/*${YAML_EXTENSION}`, {
      cwd: normalizedDirectory,
      absolute: false,
      nodir: true,
      dot: false,
    });
    return extractAgentNamesFromFiles(files);
  } catch {
    return [];
  }
}

function finalizeDirectoryMap(
  base: Partial<AgentDirectoryMap>,
  includeToolUse: boolean,
): AgentDirectoryMap {
  const directories: AgentDirectoryMap = {
    custom: normalizeDirectory(base.custom),
    builtIn: normalizeDirectory(base.builtIn),
  };

  if (includeToolUse) {
    directories.builtInToolUse = normalizeDirectory(base.builtInToolUse);
  }

  return directories;
}

async function resolveDirectoriesAsync(
  context: vscode.ExtensionContext,
  includeToolUse: boolean,
): Promise<AgentDirectoryMap> {
  const [custom, builtIn] = await Promise.all([
    agentDirectories.custom(),
    agentDirectories.builtIn(context),
  ]);

  let builtInToolUse: string | undefined;
  if (includeToolUse) {
    builtInToolUse = await agentDirectories.builtInToolUse(context);
  }

  return finalizeDirectoryMap(
    {
      custom,
      builtIn,
      builtInToolUse,
    },
    includeToolUse,
  );
}

function resolveDirectoriesSync(
  config: AgentOptionConfigSnapshot,
): AgentDirectoryMap {
  const includeToolUse = config.includeToolUseAgents;
  const customCandidate = config.configuredCustomDirectory.trim();
  const custom = path.isAbsolute(customCandidate) ? customCandidate : '';

  const baseDirectories: Partial<AgentDirectoryMap> = {
    custom,
    builtIn: GlobalStorageFS.fullPath(BUILT_IN_DIR),
  };

  if (includeToolUse) {
    baseDirectories.builtInToolUse = GlobalStorageFS.fullPath(TOOL_USE_DIR);
  }

  return finalizeDirectoryMap(baseDirectories, includeToolUse);
}

export async function loadAgentOptionInputs(
  context: vscode.ExtensionContext,
): Promise<AgentOptionInputs> {
  const config = readAgentOptionConfigSnapshot();
  const directories = await resolveDirectoriesAsync(
    context,
    config.includeToolUseAgents,
  );

  const toolUseAgents = await discoverToolUseAgentsAsync(
    directories.builtInToolUse,
  );
  const agentNames = mergeAgentNames(config.configuredAgents, toolUseAgents);

  return { agentNames, directories };
}

export function loadAgentOptionInputsSync(
  _context: vscode.ExtensionContext,
): AgentOptionInputs {
  const config = readAgentOptionConfigSnapshot();
  const directories = resolveDirectoriesSync(config);

  const toolUseAgents = discoverToolUseAgentsSync(directories.builtInToolUse);
  const agentNames = mergeAgentNames(config.configuredAgents, toolUseAgents);

  return { agentNames, directories };
}
