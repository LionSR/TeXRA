// Third-party imports
import { vi } from 'vitest';

// Local imports
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import {
  ProgressWorkflowRunActionsController,
  type WorkflowDiffRequest,
  type WorkflowFileOperation,
  type WorkflowFileOperationRequest,
} from '@controllers/progressView/ProgressWorkflowRunActionsController';
import type {
  OutputFileInfo,
  RoundIndexed,
  RunId,
} from '@shared/schemas';
import { AgentCategory } from '@shared/schemas';

export function createAgentConfig(
  overrides: Partial<AgentConfig> = {},
): AgentConfig {
  return AgentConfigSchema.parse({
    agent: 'correct',
    model: 'gemini31p',
    inputFiles: ['input.tex'],
    outputFiles: ['declared.tex'],
    agentCategory: AgentCategory.Workflow,
    ...overrides,
  });
}

export function createWorkflowConfig(
  overrides: Omit<Partial<AgentConfig>, 'agentCategory'> = {},
): AgentConfig {
  return createAgentConfig({
    ...overrides,
    agentCategory: AgentCategory.Workflow,
  });
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
  runId?: string;
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
      runId: overrides.runId ?? 'exec-old',
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

export interface ProgressWorkflowRunActionsHarnessOptions {
  runIds?: Map<RunId, string>;
  outputs?: Map<RunId, RoundIndexed<OutputFileInfo>>;
  knownWorkspaceOutputs?: Map<RunId, Set<string>>;
}

export interface ProgressWorkflowRunActionsHarness {
  controller: ProgressWorkflowRunActionsController;
  metadataReads: RunId[];
  diffs: WorkflowDiffRequest[];
  fileOperations: Array<{
    operation: WorkflowFileOperation;
    request: WorkflowFileOperationRequest;
  }>;
}

export function createProgressWorkflowRunActionsHarness(
  options: ProgressWorkflowRunActionsHarnessOptions = {},
): ProgressWorkflowRunActionsHarness {
  const metadataReads: RunId[] = [];
  const diffs: WorkflowDiffRequest[] = [];
  const fileOperations: Array<{
    operation: WorkflowFileOperation;
    request: WorkflowFileOperationRequest;
  }> = [];

  return {
    controller: new ProgressWorkflowRunActionsController({
      state: {
        getRunMetadata: (stream) => {
          metadataReads.push(stream);
          return {
            runId: options.runIds?.get(stream),
          };
        },
        getOutputFiles: (stream) => options.outputs?.get(stream) ?? {},
        getKnownWorkspaceOutputPaths: (stream) =>
          new Set(options.knownWorkspaceOutputs?.get(stream) ?? []),
      },
      runDiff: async (request) => {
        diffs.push(request);
      },
      runFileOperation: async (operation, request) => {
        fileOperations.push({ operation, request });
      },
    }),
    metadataReads,
    diffs,
    fileOperations,
  };
}
