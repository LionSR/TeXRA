// Local imports
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import type { OutputFileInfo, RunId } from '@shared/schemas';
import { documentTaskPatch } from '@texra/agent/output/documentRecipe';

function createAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return AgentConfigSchema.parse({
    agent: 'correct',
    model: 'google/gemini-3.1-pro-preview',
    inputFiles: ['input.tex'],
    outputFiles: ['declared.tex'],
    ...overrides,
  });
}

/**
 * `config` opened on the document recipe of its agent, as a launcher builds
 * it once the catalog resolved an entry with a `task:` block; the outputs
 * stay as the case wrote them.
 */
export function asDocumentTask<
  C extends Pick<AgentConfig, 'agent'> & Partial<AgentConfig>,
>(config: C) {
  const source = config.agentSource ?? 'builtIn';
  const patch = documentTaskPatch(
    {
      agent: config.agent,
      agentSource: config.agentSource,
      inputFiles: config.inputFiles ?? [],
      outputFiles: config.outputFiles ?? [],
    },
    {
      name: config.agent,
      source,
      path: `/agents/${config.agent}.yaml`,
      persona: { prompt: '', tools: [], temperature: 1 },
      blocks: {
        task: {
          rewrite: true,
          outputs: [],
          files: {},
          prefix: '',
          requests: ['Revise.'],
        },
      },
    },
  );
  if (patch === null) throw new Error('a task entry always patches');
  // The recipe only: the launch's outputs stay as the case wrote them.
  return { ...config, script: patch.script };
}

/** A document task's config: the persona's config opened on the recipe. */
export function createWorkflowConfig(
  overrides: Partial<AgentConfig> = {},
): AgentConfig {
  return asDocumentTask(createAgentConfig(overrides));
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
