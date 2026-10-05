// Local imports
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import type { OutputFileInfo, RunId } from '@shared/schemas';
import { documentTaskConfig } from '@texra/agent/output/documentRecipe';

function createAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return AgentConfigSchema.parse({
    agent: 'correct',
    model: 'google/gemini-3.1-pro-preview',
    inputFiles: ['input.tex'],
    outputFiles: ['declared.tex'],
    ...overrides,
  });
}

/** A document task's config: the persona's config opened on the recipe. */
export function createWorkflowConfig(
  overrides: Partial<AgentConfig> = {},
): AgentConfig {
  return documentTaskConfig(createAgentConfig(overrides));
}

type WorkspaceLocationOverrides = {
  kind?: 'workspace';
  absolutePath?: string;
  relativePath?: string;
};

type RunStorageLocationOverrides = {
  kind: 'runStorage';
  absolutePath?: string;
  relativePath?: string;
  runId?: RunId;
};

type ExternalLocationOverrides = {
  kind: 'external';
  absolutePath?: string;
};

type OutputFileLocationOverrides =
  | WorkspaceLocationOverrides
  | RunStorageLocationOverrides
  | ExternalLocationOverrides;

export type OutputFileHarnessOptions = Partial<
  Omit<OutputFileInfo, 'location'>
> & {
  location?: OutputFileLocationOverrides;
};

function createOutputFileLocation(
  overrides: OutputFileLocationOverrides = {},
): OutputFileInfo['location'] {
  if (overrides.kind === 'external') {
    return {
      kind: 'external',
      absolutePath: overrides.absolutePath ?? '/external/generated.tex',
    };
  }

  if (overrides.kind === 'runStorage') {
    return {
      kind: 'runStorage',
      absolutePath: overrides.absolutePath ?? '/tmp/exec/answer.tex',
      relativePath: overrides.relativePath ?? 'answer.tex',
      runId: overrides.runId ?? ('exec-old' as RunId),
    };
  }

  return {
    kind: 'workspace',
    absolutePath: overrides.absolutePath ?? '/workspace/generated.tex',
    relativePath: overrides.relativePath ?? 'generated.tex',
  };
}

export function createOutputFile(
  overrides: OutputFileHarnessOptions = {},
): OutputFileInfo {
  const { location, ...outputOverrides } = overrides;
  return {
    source: 'input.tex',
    location: createOutputFileLocation(location),
    round: 1,
    lineage: null,
    diff: null,
    ...outputOverrides,
  };
}
