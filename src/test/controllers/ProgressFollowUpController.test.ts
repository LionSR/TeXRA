// Standard library imports
import { strict as assert } from 'assert';

// Local imports - agent
import { ProgressFollowUpController } from '@controllers/progressView/ProgressFollowUpController';
import { AgentCategory } from '@agent/core/AgentDataclass';
import type { AgentConfig } from '@agent/core/AgentConfig';

// Local imports - shared
import type { CompileFailure, OutputFileInfo } from '@shared/schemas';

// Local imports - test support
import {
  createOutputFile,
  type OutputFileHarnessOptions,
  createWorkflowTaskState,
} from '../support/ProgressControllerHarnesses';

// Local imports - controllers

const followUpWorkflowDefaults: Partial<AgentConfig> = {
  inputFile: 'main.tex',
  inputFiles: [],
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

function createFollowUpWorkflowTaskState(
  overrides: Omit<Partial<AgentConfig>, 'agentCategory'> = {},
) {
  return createWorkflowTaskState({
    ...followUpWorkflowDefaults,
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

function createController(
  existingFiles = new Set(['main.tex']),
): ProgressFollowUpController {
  return new ProgressFollowUpController({
    getAgentCategory: (agent) =>
      agent === 'tool-agent' ? AgentCategory.ToolUse : AgentCategory.Workflow,
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
  it('builds a tool-use follow-up restore plan from workflow outputs', () => {
    const controller = createController();
    const plan = controller.planToolUseFollowUp({
      streamId: 'stream-a',
      taskState: createFollowUpWorkflowTaskState(),
      outputFiles: [createRunStorageOutputFile()],
      agent: 'tool-agent',
      model: 'gemini31p',
      initialQuestion: ' Please inspect the proof. ',
      executeImmediately: true,
      modelOptions: [{ value: 'gemini31p' }],
      executionId: 'exec-123',
    });

    assert.equal(plan.kind, 'restoreState');
    if (plan.kind !== 'restoreState') return;
    assert.equal(plan.executeImmediately, true);
    assert.equal(plan.taskState.agentConfig.agent, 'tool-agent');
    assert.equal(
      plan.taskState.agentConfig.agentCategory,
      AgentCategory.ToolUse,
    );
    assert.equal(plan.taskState.agentConfig.inputFile, 'main.tex');
    assert.equal(plan.taskState.agentConfig.outputFiles.length, 0);
    assert.match(
      plan.taskState.agentConfig.instruction,
      /\/executions\/exec-123\/files\/answer\.tex/,
    );
    assert.match(
      plan.taskState.agentConfig.instruction,
      /User follow-up request: Please inspect the proof\./,
    );
  });

  it('rejects follow-up setup when the selected model is disabled', () => {
    const plan = createController().planToolUseFollowUp({
      streamId: 'stream-a',
      taskState: createFollowUpWorkflowTaskState(),
      outputFiles: [createRunStorageOutputFile()],
      agent: 'tool-agent',
      model: 'gemini31p',
      executeImmediately: false,
      modelOptions: [{ value: 'gemini31p', disabled: true }],
    });

    assert.deepEqual(plan, {
      kind: 'warning',
      message: 'Select an available model before starting a follow-up.',
    });
  });

  it('plans latexFixer with generated output sources before input recovery', async () => {
    const controller = createController(new Set(['source.tex', 'main.tex']));
    const output = createRunStorageOutputFile({ source: 'source.tex' });
    const plan = await controller.planCompileFixer({
      streamId: 'stream-a',
      taskState: createFollowUpWorkflowTaskState({
        inputFile: 'main.tex',
        inputFiles: ['source.tex'],
      }),
      compileFailures: [createCompileFailure()],
      runOutputs: new Map([[2, [output]]]),
      modelOptions: [{ value: 'other-model' }],
      executionId: 'exec-123',
    });

    assert.equal(plan.kind, 'execute');
    if (plan.kind !== 'execute') return;
    const config = plan.request.config;
    assert.equal(config.agent, 'latexFixer');
    assert.equal(config.model, 'other-model');
    assert.equal(config.inputFile, 'source.tex');
    assert.deepEqual(config.inputFiles, ['main.tex']);
    assert.match(
      config.instruction ?? '',
      /Editable workspace targets: source\.tex, main\.tex/,
    );
    assert.match(
      config.instruction ?? '',
      /output \/executions\/exec-123\/files\/answer\.tex; compile log \/executions\/exec-123\/files\/answer\.log/,
    );
  });

  it('uses original workflow inputs as recovery when source metadata is absent', async () => {
    const controller = createController(new Set(['main.tex', 'chapter.tex']));
    const plan = await controller.planCompileFixer({
      streamId: 'stream-a',
      taskState: createFollowUpWorkflowTaskState({
        inputFile: 'main.tex',
        inputFiles: ['chapter.tex'],
      }),
      compileFailures: [createCompileFailure()],
      runOutputs: new Map(),
      modelOptions: [{ value: 'gemini31p' }],
      executionId: 'exec-123',
    });

    assert.equal(plan.kind, 'execute');
    if (plan.kind !== 'execute') return;
    const config = plan.request.config;
    assert.equal(config.inputFile, 'main.tex');
    assert.deepEqual(config.inputFiles, ['chapter.tex']);
    assert.match(
      config.instruction ?? '',
      /Editable workspace targets: main\.tex, chapter\.tex/,
    );
  });

  it('warns when compile failures have no editable workspace source', async () => {
    const plan = await createController(new Set()).planCompileFixer({
      streamId: 'stream-a',
      taskState: createFollowUpWorkflowTaskState({
        inputFile: '/external/main.tex',
      }),
      compileFailures: [createCompileFailure()],
      runOutputs: new Map([
        [2, [createRunStorageOutputFile({ source: '/external/main.tex' })]],
      ]),
      modelOptions: [{ value: 'gemini31p' }],
      executionId: 'exec-123',
    });

    assert.deepEqual(plan, {
      kind: 'warning',
      message:
        'No editable workspace source file matched the compile failure. Accept the output into the workspace first, then run latexFixer.',
    });
  });
});
