/**
 * Agent path resolution utilities for glob-based agent discovery.
 *
 * This module provides fallback path resolution when agents are not found
 * in the AgentIndex cache. The primary path resolution should use AgentIndex
 * for fast lookups; these functions are used when:
 * - An agent was just added and the index hasn't refreshed yet
 * - The index needs to be bypassed for some reason
 */

// Standard library imports
import * as path from 'path';

// Third-party imports
import { glob, type GlobOptionsWithFileTypesFalse } from 'glob';

// Local imports - agent runtime
import {
  AgentDirectorySource,
  type AgentPathResolution,
} from '@agent/runtime/AgentPathTypes';

export interface AgentDirectoryCandidate {
  directory: string;
  source: AgentDirectorySource;
}

export interface AgentDefinitionSearchOptions {
  preferMultiple?: boolean;
}

const YAML_EXTENSION = '.yaml';

const BASE_GLOB_OPTIONS: GlobOptionsWithFileTypesFalse = {
  absolute: true,
  dot: false,
  nodir: true,
};

type AsyncFetcher = (
  pattern: string,
  options: GlobOptionsWithFileTypesFalse,
) => Promise<string[]>;

export function createCandidate(
  directory: string,
  source: AgentDirectorySource,
): AgentDirectoryCandidate {
  return { directory, source };
}

function buildCandidateNames(
  agentName: string,
  preferMultiple: boolean,
): string[] {
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

export async function resolveAgentDefinition(
  agentName: string,
  candidates: AgentDirectoryCandidate[],
  options?: AgentDefinitionSearchOptions,
): Promise<AgentPathResolution | undefined> {
  return resolveWithAsyncFetcher(
    agentName,
    candidates,
    options,
    (pattern, opts) => glob(pattern, opts),
  );
}

export async function resolveAgentDefinitionInDirectory(
  directory: string,
  source: AgentDirectorySource,
  agentName: string,
  options?: AgentDefinitionSearchOptions,
): Promise<AgentPathResolution | undefined> {
  return resolveAgentDefinition(
    agentName,
    [createCandidate(directory, source)],
    options,
  );
}
