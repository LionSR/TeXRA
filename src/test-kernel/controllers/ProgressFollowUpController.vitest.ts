// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import type { WorkflowTaskState } from '@agent/core/state/TaskState';
import {
  ProgressFollowUpController,
  type ProgressFollowUpState,
} from '@controllers/progressView/ProgressFollowUpController';
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

const emptyFollowUpState: ProgressFollowUpState = {
  getTaskState: () => undefined,
  getOutputFiles: () => ({}),
  getCompileFailures: () => ({}),
  getExecutionId: () => undefined,
};

function createController(
  existingFiles: Set<string>,
): ProgressFollowUpController {
  return new ProgressFollowUpController({
    getAgentCategory: () => AgentCategory.ToolUse,
    loadModelOptions: async () => [],
    state: emptyFollowUpState,
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
  it('keeps generated latexdiff artifacts and exposes the source as an extra target', async () => {
    const plan = await createController(
      new Set(['main.tex', 'main-diffea268c1.tex']),
    ).planCompileFixer({
      streamId: 'stream-a',
      taskState: createWorkflowTaskState({
        inputFiles: ['main-diffea268c1.tex'],
      }),
      compileFailures: [createCompileFailure()],
      runOutputs: { 2: [createRunStorageOutputFile('main-diffea268c1.tex')] },
      modelOptions: [{ value: 'gemini31p' }],
      executionId: 'exec-123',
    });

    expect(plan.kind).toBe('execute');
    if (plan.kind !== 'execute') return;
    expect(plan.request.config.inputFiles).toEqual([
      'main-diffea268c1.tex',
      'main.tex',
    ]);
    expect(plan.request.config.instruction).toContain(
      'main-diffea268c1.tex is a latexdiff artifact generated from main.tex',
    );
    expect(plan.request.config.instruction).toContain(
      'repair this artifact in place',
    );
    expect(plan.request.config.instruction).toContain(
      'fix main.tex too so a regenerated diff stays fixed',
    );
  });

  it('keeps strong generated latexdiff artifacts when the source is absent', async () => {
    const plan = await createController(
      new Set(['main-diffea268c1.tex']),
    ).planCompileFixer({
      streamId: 'stream-a',
      taskState: createWorkflowTaskState({
        inputFiles: ['main-diffea268c1.tex'],
      }),
      compileFailures: [createCompileFailure()],
      runOutputs: { 2: [createRunStorageOutputFile('main-diffea268c1.tex')] },
      modelOptions: [{ value: 'gemini31p' }],
      executionId: 'exec-123',
    });

    expect(plan.kind).toBe('execute');
    if (plan.kind !== 'execute') return;
    expect(plan.request.config.inputFiles).toEqual(['main-diffea268c1.tex']);
    expect(plan.request.config.instruction).toContain(
      'main-diffea268c1.tex is a latexdiff artifact; inferred source main.tex is not present in the workspace',
    );
  });

  it('uses the inferred source when a generated latexdiff artifact is absent', async () => {
    const plan = await createController(new Set(['main.tex'])).planCompileFixer(
      {
        streamId: 'stream-a',
        taskState: createWorkflowTaskState({
          inputFiles: ['main-diffea268c1.tex'],
        }),
        compileFailures: [createCompileFailure()],
        runOutputs: { 2: [createRunStorageOutputFile('main-diffea268c1.tex')] },
        modelOptions: [{ value: 'gemini31p' }],
        executionId: 'exec-123',
      },
    );

    expect(plan.kind).toBe('execute');
    if (plan.kind !== 'execute') return;
    expect(plan.request.config.inputFiles).toEqual(['main.tex']);
    expect(plan.request.config.instruction).toContain(
      'main-diffea268c1.tex was a latexdiff artifact candidate, but it is not present in the workspace. main.tex is the inferred source fallback.',
    );
  });

  it('keeps missing latexdiff context when a source target is already present', async () => {
    const plan = await createController(new Set(['main.tex'])).planCompileFixer(
      {
        streamId: 'stream-a',
        taskState: createWorkflowTaskState({
          inputFiles: ['main.tex', 'main-diffea268c1.tex'],
        }),
        compileFailures: [createCompileFailure()],
        runOutputs: {},
        modelOptions: [{ value: 'gemini31p' }],
        executionId: 'exec-123',
      },
    );

    expect(plan.kind).toBe('execute');
    if (plan.kind !== 'execute') return;
    expect(plan.request.config.inputFiles).toEqual(['main.tex']);
    expect(plan.request.config.instruction).toContain(
      'main-diffea268c1.tex was a latexdiff artifact candidate, but it is not present in the workspace. main.tex is the inferred source fallback.',
    );
  });
});
