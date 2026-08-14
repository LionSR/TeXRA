import { describe, expect, it } from 'vitest';

import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import {
  ProgressFollowUpController,
  type ProgressFollowUpModelOption,
  type ProgressFollowUpState,
} from '@controllers/progressView/ProgressFollowUpController';
import type { CompileFailure, OutputFileInfo } from '@shared/schemas';
import { AgentCategory } from '@shared/schemas';
import {
  createOutputFile,
  createWorkflowConfig,
  type OutputFileHarnessOptions,
} from '../support/ProgressControllerHarnesses';

const followUpWorkflowDefaults: Partial<AgentConfig> = {
  inputFiles: ['main.tex'],
  outputFiles: ['answer.tex'],
};

const runStorageOutputDefaults = {
  source: 'main.tex',
  location: { kind: 'runStorage' },
  round: 2,
} satisfies OutputFileHarnessOptions;

type RunStorageOutputOverrides = Omit<OutputFileHarnessOptions, 'location'> & {
  location?: Omit<
    Extract<OutputFileInfo['location'], { kind: 'runStorage' }>,
    'kind'
  >;
};

/** Workflow config built from the shared harness. */
function createFollowUpWorkflowConfig(
  overrides: Omit<Partial<AgentConfig>, 'agentCategory'> = {},
): AgentConfig {
  return createWorkflowConfig({
    ...followUpWorkflowDefaults,
    ...overrides,
  });
}

/** Workflow config whose `inputFiles` are exactly the ones passed in. */
function createExactInputsConfig(
  overrides: Omit<Partial<AgentConfig>, 'agentCategory'> = {},
): AgentConfig {
  return AgentConfigSchema.parse({
    agent: 'writer',
    model: 'gemini31p',
    ...followUpWorkflowDefaults,
    agentCategory: AgentCategory.Workflow,
    ...overrides,
  });
}

function createRunStorageOutputFile(
  overrides: RunStorageOutputOverrides = {},
): OutputFileInfo {
  return createOutputFile({
    ...runStorageOutputDefaults,
    ...overrides,
    location: {
      ...runStorageOutputDefaults.location,
      ...overrides.location,
    },
  });
}

function createCompileFailure(
  overrides: Partial<CompileFailure> = {},
): CompileFailure {
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
    ...overrides,
  };
}

const emptyFollowUpState: ProgressFollowUpState = {
  getRunMetadata: () => ({}),
  getOutputFiles: () => ({}),
  getCompileFailures: () => ({}),
};

function createController({
  existingFiles = new Set(['main.tex']),
  modelOptions = [],
  state = emptyFollowUpState,
}: {
  existingFiles?: Set<string>;
  modelOptions?: readonly ProgressFollowUpModelOption[];
  state?: ProgressFollowUpState;
} = {}): ProgressFollowUpController {
  return new ProgressFollowUpController({
    loadModelOptions: async () => modelOptions,
    state,
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
  it('plans latexFixer with generated output sources before input recovery', async () => {
    const controller = createController({
      existingFiles: new Set(['source.tex', 'main.tex']),
    });
    const output = createRunStorageOutputFile({ source: 'source.tex' });
    const plan = await controller.planCompileFixer({
      streamId: 'stream-a',
      runConfig: createFollowUpWorkflowConfig({
        inputFiles: ['main.tex', 'source.tex'],
      }),
      compileFailures: [createCompileFailure()],
      runOutputs: { 2: [output] },
      modelOptions: [{ value: 'other-model' }],
      executionId: 'exec-123',
    });

    expect(plan.kind).toBe('execute');
    if (plan.kind !== 'execute') return;
    const config = plan.request.config;
    expect(config.agent).toBe('latexFixer');
    expect(config.model).toBe('other-model');
    expect(config.inputFiles).toEqual(['source.tex', 'main.tex']);
    expect(config.instruction ?? '').toMatch(
      /Editable workspace targets: source\.tex, main\.tex/,
    );
    expect(config.instruction ?? '').toMatch(
      /output \/executions\/exec-123\/files\/answer\.tex; compile log \/executions\/exec-123\/files\/answer\.log/,
    );
  });

  it('uses original workflow inputs as recovery when source metadata is absent', async () => {
    const controller = createController({
      existingFiles: new Set(['main.tex', 'chapter.tex']),
    });
    const plan = await controller.planCompileFixer({
      streamId: 'stream-a',
      runConfig: createFollowUpWorkflowConfig({
        inputFiles: ['main.tex', 'chapter.tex'],
      }),
      compileFailures: [createCompileFailure()],
      runOutputs: {},
      modelOptions: [{ value: 'gemini31p' }],
      executionId: 'exec-123',
    });

    expect(plan.kind).toBe('execute');
    if (plan.kind !== 'execute') return;
    const config = plan.request.config;
    expect(config.inputFiles).toEqual(['main.tex', 'chapter.tex']);
    expect(config.instruction ?? '').toMatch(
      /Editable workspace targets: main\.tex, chapter\.tex/,
    );
  });

  it('warns when compile failures have no editable workspace source', async () => {
    const plan = await createController({
      existingFiles: new Set(),
    }).planCompileFixer({
      streamId: 'stream-a',
      runConfig: createFollowUpWorkflowConfig({
        inputFiles: ['/external/main.tex'],
      }),
      compileFailures: [createCompileFailure()],
      runOutputs: {
        2: [createRunStorageOutputFile({ source: '/external/main.tex' })],
      },
      modelOptions: [{ value: 'gemini31p' }],
      executionId: 'exec-123',
    });

    expect(plan).toEqual({
      kind: 'warning',
      message:
        'No editable workspace file matched the compile failure. Accept the output into the workspace first, then run latexFixer.',
    });
  });

  it('keeps generated latexdiff artifacts and exposes the source as an extra target', async () => {
    const plan = await createController({
      existingFiles: new Set(['main.tex', 'main-diffea268c1.tex']),
    }).planCompileFixer({
      streamId: 'stream-a',
      runConfig: createExactInputsConfig({
        inputFiles: ['main-diffea268c1.tex'],
      }),
      compileFailures: [createCompileFailure()],
      runOutputs: {
        2: [createRunStorageOutputFile({ source: 'main-diffea268c1.tex' })],
      },
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
    const plan = await createController({
      existingFiles: new Set(['main-diffea268c1.tex']),
    }).planCompileFixer({
      streamId: 'stream-a',
      runConfig: createExactInputsConfig({
        inputFiles: ['main-diffea268c1.tex'],
      }),
      compileFailures: [createCompileFailure()],
      runOutputs: {
        2: [createRunStorageOutputFile({ source: 'main-diffea268c1.tex' })],
      },
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
    const plan = await createController().planCompileFixer({
      streamId: 'stream-a',
      runConfig: createExactInputsConfig({
        inputFiles: ['main-diffea268c1.tex'],
      }),
      compileFailures: [createCompileFailure()],
      runOutputs: {
        2: [createRunStorageOutputFile({ source: 'main-diffea268c1.tex' })],
      },
      modelOptions: [{ value: 'gemini31p' }],
      executionId: 'exec-123',
    });

    expect(plan.kind).toBe('execute');
    if (plan.kind !== 'execute') return;
    expect(plan.request.config.inputFiles).toEqual(['main.tex']);
    expect(plan.request.config.instruction).toContain(
      'main-diffea268c1.tex was a latexdiff artifact candidate, but it is not present in the workspace. main.tex is the inferred source fallback.',
    );
  });

  it('keeps missing latexdiff context when a source target is already present', async () => {
    const plan = await createController().planCompileFixer({
      streamId: 'stream-a',
      runConfig: createExactInputsConfig({
        inputFiles: ['main.tex', 'main-diffea268c1.tex'],
      }),
      compileFailures: [createCompileFailure()],
      runOutputs: {},
      modelOptions: [{ value: 'gemini31p' }],
      executionId: 'exec-123',
    });

    expect(plan.kind).toBe('execute');
    if (plan.kind !== 'execute') return;
    expect(plan.request.config.inputFiles).toEqual(['main.tex']);
    expect(plan.request.config.instruction).toContain(
      'main-diffea268c1.tex was a latexdiff artifact candidate, but it is not present in the workspace. main.tex is the inferred source fallback.',
    );
  });
});
