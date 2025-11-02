// Standard library imports
import * as path from 'path';

// Third-party imports
import { glob, globSync, type GlobOptionsWithFileTypesFalse } from 'glob';

// Local imports - agent runtime
import {
  AgentDirectorySource,
  type AgentPathResolution,
} from '@agent/runtime/AgentPathTypes';

export interface AgentDirectoryMap {
  custom?: string;
  builtIn?: string;
  builtInToolUse?: string;
}

export interface AgentDirectoryCandidate {
  directory: string;
  source: AgentDirectorySource;
}

export interface AgentDefinitionSearchOptions {
  preferMultiple?: boolean;
}

const YAML_EXTENSION = '.yaml';
const DIRECTORY_ORDER: ReadonlyArray<keyof AgentDirectoryMap> = [
  'custom',
  'builtIn',
  'builtInToolUse',
];

const BASE_GLOB_OPTIONS: GlobOptionsWithFileTypesFalse = {
  absolute: true,
  dot: false,
  nodir: true,
};

type AsyncFetcher = (
  pattern: string,
  options: GlobOptionsWithFileTypesFalse,
) => Promise<string[]>;

type SyncFetcher = (
  pattern: string,
  options: GlobOptionsWithFileTypesFalse,
) => string[];

function cleanDirectory(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function sourceForKey(key: keyof AgentDirectoryMap): AgentDirectorySource {
  switch (key) {
    case 'custom':
      return AgentDirectorySource.Custom;
    case 'builtIn':
      return AgentDirectorySource.BuiltIn;
    case 'builtInToolUse':
      return AgentDirectorySource.BuiltInToolUse;
    default:
      return AgentDirectorySource.Custom;
  }
}

export function mapToCandidates(map: AgentDirectoryMap): AgentDirectoryCandidate[] {
  return DIRECTORY_ORDER.reduce<AgentDirectoryCandidate[]>((acc, key) => {
    const directory = cleanDirectory(map[key]);
    if (directory) {
      acc.push({ directory, source: sourceForKey(key) });
    }
    return acc;
  }, []);
}

export function createCandidate(
  directory: string,
  source: AgentDirectorySource,
): AgentDirectoryCandidate {
  return { directory, source };
}

function buildCandidateNames(agentName: string, preferMultiple: boolean): string[] {
  const names = new Set<string>();
  if (preferMultiple) {
    const multiple = agentName.endsWith('_multiple')
      ? agentName
      : `${agentName}_multiple`;
    names.add(multiple);
  }
  names.add(agentName);
  return Array.from(names);
}

function createResolution(
  matchPath: string,
  candidate: AgentDirectoryCandidate,
  preferMultiple: boolean,
): AgentPathResolution {
  const resolvedName = path.basename(matchPath, YAML_EXTENSION);
  return {
    directory: path.dirname(matchPath),
    definitionPath: matchPath,
    resolvedName,
    source: candidate.source,
    usedFallback: preferMultiple && !resolvedName.endsWith('_multiple'),
  } satisfies AgentPathResolution;
}

async function resolveWithAsyncFetcher(
  agentName: string,
  candidates: AgentDirectoryCandidate[],
  options: AgentDefinitionSearchOptions | undefined,
  fetcher: AsyncFetcher,
): Promise<AgentPathResolution | undefined> {
  const preferMultiple = options?.preferMultiple ?? false;
  const candidateNames = buildCandidateNames(agentName, preferMultiple);

  for (const candidateName of candidateNames) {
    const pattern = `**/${candidateName}${YAML_EXTENSION}`;
    for (const candidate of candidates) {
      const matches = await fetcher(pattern, {
        ...BASE_GLOB_OPTIONS,
        cwd: candidate.directory,
      });
      const match = matches[0];
      if (match) {
        const absolute = path.isAbsolute(match)
          ? match
          : path.join(candidate.directory, match);
        return createResolution(absolute, candidate, preferMultiple);
      }
    }
  }

  return undefined;
}

function resolveWithSyncFetcher(
  agentName: string,
  candidates: AgentDirectoryCandidate[],
  options: AgentDefinitionSearchOptions | undefined,
  fetcher: SyncFetcher,
): AgentPathResolution | undefined {
  const preferMultiple = options?.preferMultiple ?? false;
  const candidateNames = buildCandidateNames(agentName, preferMultiple);

  for (const candidateName of candidateNames) {
    const pattern = `**/${candidateName}${YAML_EXTENSION}`;
    for (const candidate of candidates) {
      const matches = fetcher(pattern, {
        ...BASE_GLOB_OPTIONS,
        cwd: candidate.directory,
      });
      const match = matches[0];
      if (match) {
        const absolute = path.isAbsolute(match)
          ? match
          : path.join(candidate.directory, match);
        return createResolution(absolute, candidate, preferMultiple);
      }
    }
  }

  return undefined;
}

export async function resolveAgentDefinition(
  agentName: string,
  candidates: AgentDirectoryCandidate[],
  options?: AgentDefinitionSearchOptions,
): Promise<AgentPathResolution | undefined> {
  return resolveWithAsyncFetcher(agentName, candidates, options, (pattern, opts) =>
    glob(pattern, opts),
  );
}

export function resolveAgentDefinitionSync(
  agentName: string,
  candidates: AgentDirectoryCandidate[],
  options?: AgentDefinitionSearchOptions,
): AgentPathResolution | undefined {
  return resolveWithSyncFetcher(agentName, candidates, options, (pattern, opts) =>
    globSync(pattern, opts),
  );
}

export async function resolveAgentDefinitionInDirectory(
  directory: string,
  source: AgentDirectorySource,
  agentName: string,
  options?: AgentDefinitionSearchOptions,
): Promise<AgentPathResolution | undefined> {
  return resolveAgentDefinition(agentName, [createCandidate(directory, source)], options);
}

export function resolveAgentDefinitionInDirectorySync(
  directory: string,
  source: AgentDirectorySource,
  agentName: string,
  options?: AgentDefinitionSearchOptions,
): AgentPathResolution | undefined {
  return resolveAgentDefinitionSync(agentName, [createCandidate(directory, source)], options);
}
