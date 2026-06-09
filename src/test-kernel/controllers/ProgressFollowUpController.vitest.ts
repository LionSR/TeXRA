// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - controllers
import { ProgressFollowUpController } from '@controllers/progressView/ProgressFollowUpController';

// Local imports - agent
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import type { WorkflowTaskState } from '@agent/core/execution/TaskState';

// Local imports - shared
import type { CompileFailure, OutputFileInfo } from '@shared/schemas';

function createWorkflowTaskState(
  overrides: Omit<Partial<AgentConfig>, 'agentCategory'> = {},
): WorkflowTaskState {
  return {
    agentConfig: AgentConfigSchema.parse({
      agent: 'writer',
      model: 'gemini31p',
      inputFiles: ['main.tex'],
      outputFiles: ['answer.tex'],
      agentCategory: AgentCategory.Workflow,
      ...overrides,
    }) as AgentConfig & { agentCategory: typeof AgentCategory.Workflow },
    activeFiles: {
      input: true,
      context: false,
      media: false,
      output: true,
    },
  };
}

function createRunStorageOutputFile(source: string): OutputFileInfo {
  return {
    source,
    round: 2,
    lineage: null,
    diff: null,
    location: {
      kind: 'runStorage',
      absolutePath: '/tmp/exec/answer.tex',
      relativePath: 'answer.tex',
      executionId: 'exec-old',
    },
  };
}

function createCompileFailure(): CompileFailure {
  return {
    round: 2,
    displayName: 'answer.tex',
    output: {
      kind: 'runStorage',
      absolutePath: '/tmp/exec/answer.tex',
      relativePath: 'answer.tex',
      executionId: 'exec-old',
    },
    log: {
      kind: 'runStorage',
      absolutePath: '/tmp/exec/answer.log',
      relativePath: 'answer.log',
      executionId: 'exec-old',
    },
    logRelativePath: 'answer.log',
  };
}

function createController(
  existingFiles: Set<string>,
): ProgressFollowUpController {
  return new ProgressFollowUpController({
    getAgentCategory: () => AgentCategory.ToolUse,
    workspace: {
      locatePath: (candidate) =>
        candidate.startsWith('/external/')
          ? { kind: 'external' }
          : { kind: 'workspace', relativePath: candidate },
      exists: async (relativePath) => existingFiles.has(relativePath),
    },
  });
}

describe('ProgressFollowUpController', () => {
  it('maps generated latexdiff candidates back to editable sources', async () => {
    const plan = await createController(
      new Set(['main.tex', 'main-diffea268c1.tex']),
    ).planCompileFixer({
      streamId: 'stream-a',
      taskState: createWorkflowTaskState({
        inputFiles: ['main-diffea268c1.tex'],
      }),
      compileFailures: [createCompileFailure()],
      runOutputs: new Map([
        [2, [createRunStorageOutputFile('main-diffea268c1.tex')]],
      ]),
      modelOptions: [{ value: 'gemini31p' }],
      executionId: 'exec-123',
    });

    expect(plan.kind).toBe('execute');
    if (plan.kind !== 'execute') return;
    expect(plan.request.config.inputFiles).toEqual(['main.tex']);
  });

  it('does not edit generated latexdiff artifacts when source is absent', async () => {
    const plan = await createController(
      new Set(['main-diffea268c1.tex']),
    ).planCompileFixer({
      streamId: 'stream-a',
      taskState: createWorkflowTaskState({
        inputFiles: ['main-diffea268c1.tex'],
      }),
      compileFailures: [createCompileFailure()],
      runOutputs: new Map([
        [2, [createRunStorageOutputFile('main-diffea268c1.tex')]],
      ]),
      modelOptions: [{ value: 'gemini31p' }],
      executionId: 'exec-123',
    });

    expect(plan).toEqual({
      kind: 'warning',
      message:
        'No editable workspace source file matched the compile failure. Accept the output into the workspace first, then run latexFixer.',
    });
  });
});
