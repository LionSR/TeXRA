import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkflowAgentInvocation } from '@agent/workflowScript';
import type { AgentEntry } from '@agent/index/agentEntry';
import type { LaunchRunContext } from '@agent/runtime/RunContext';
import type { AgentFinalResult } from '@agent/runtime/AgentFinalResult';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import {
  createWorkflowScriptAgentRunner,
  fingerprintWorkflowAgentDependencies,
} from '@tools/delegation/workflowScriptAgentRunner';
import {
  SubagentDurabilityError,
  SubagentReconciliationError,
} from '@tools/delegation/inBandSubagentExecution';

const mocks = vi.hoisted(() => ({
  executeStableSubagentInBand: vi.fn(),
  preparedOptions: [] as unknown[],
  requireVisibleAgent: vi.fn(),
  selectAvailableDelegationModel: vi.fn(),
  resolveChildRunOutput: vi.fn(),
  runStorageLocationFromAnyAbsolutePath: vi.fn(),
  assertWorkflowFilesExist: vi.fn(),
  rejectOversizedBibAttachments: vi.fn(),
  configureDelegatedChildApprovals: vi.fn(),
  workspaceReadBytes: vi.fn(),
  absoluteReadBytes: vi.fn(),
  readExecutionMeta: vi.fn(),
}));

vi.mock('@tools/approval', () => ({
  configureDelegatedChildApprovals: mocks.configureDelegatedChildApprovals,
}));

vi.mock('@tools/delegation/inBandSubagentExecution', () => {
  class SubagentDurabilityError extends Error {
    constructor(message: string, options?: ErrorOptions) {
      super(message, options);
      this.name = 'SubagentDurabilityError';
    }
  }
  class SubagentReconciliationError extends SubagentDurabilityError {
    constructor(message: string) {
      super(message);
      this.name = 'SubagentReconciliationError';
    }
  }
  return {
    executeStableSubagentInBand: mocks.executeStableSubagentInBand,
    SubagentDurabilityError,
    SubagentReconciliationError,
  };
});

vi.mock('@tools/delegation/proposalFlow', () => ({
  requireVisibleAgent: mocks.requireVisibleAgent,
  selectAvailableDelegationModel: mocks.selectAvailableDelegationModel,
}));

vi.mock('@agent/storage', () => ({
  getExecutionStore: vi.fn(() => ({ readMeta: mocks.readExecutionMeta })),
  resolveChildRunOutput: mocks.resolveChildRunOutput,
}));

vi.mock('@utils/files/runStorageFs', () => ({
  runStorageLocationFromAnyAbsolutePath:
    mocks.runStorageLocationFromAnyAbsolutePath,
}));

vi.mock('@tools/delegation/inputFields', () => ({
  assertWorkflowFilesExist: mocks.assertWorkflowFilesExist,
  rejectOversizedBibAttachments: mocks.rejectOversizedBibAttachments,
}));

vi.mock('@utils/files/workspaceFS', () => ({
  WorkspaceFS: { readBytes: mocks.workspaceReadBytes },
}));
vi.mock('@utils/files/absoluteFS', () => ({
  AbsoluteFS: { readBytes: mocks.absoluteReadBytes },
}));

const parentExecutionId = 'aaaaaa111111' as ExecutionId;
const parentStreamId = 'stream:workflow-script' as StreamTabId;
// The detached workflow-run's own identity — grandchild agent() calls re-root
// here, not on the orchestrator (#8712).
const runExecutionId = 'run0run0run0' as ExecutionId;
const runStreamId = 'workflow-script#run0run0run0' as StreamTabId;
const run = { executionId: runExecutionId, streamId: runStreamId };
const defaultAgent = {
  name: 'correct',
  source: 'builtInWorkflow',
  category: 'workflow',
  path: '/agents/correct.yml',
} as AgentEntry;
const result: AgentFinalResult = {
  category: 'workflow',
  outcome: 'completed',
  outputs: [
    {
      round: 0,
      relativePath: 'r0/draft.tex',
      absolutePath: '/storage/executions/bbbbbb222222/r0/draft.tex',
      location: 'runStorage',
      originalPath: '/workspace/draft.tex',
      added: 1,
      removed: 0,
    },
  ],
  compileFailures: [],
  diffs: [],
  cost: 0,
};
// A completed tool-use result carrying a structured value, as a schema call
// resolves once the agent submits output.
const structuredResult: AgentFinalResult = {
  category: 'toolUse',
  outcome: 'completed',
  response: '',
  files: [],
  cost: 0,
  structured: { title: 'Lemma 1' },
};

function parentContext(): LaunchRunContext {
  return {
    kind: 'launch',
    model: 'parent-model',
    approvalPromptsUnavailable: true,
    runtimeUnavailableTools: ['user_question'],
    runScope: {
      executionId: parentExecutionId,
      streamId: parentStreamId,
      agentName: 'orchestrator',
      workingDirectory: '/workspace',
      delegationAgentScope: {
        workflow: ['builtInWorkflow:correct'],
        toolUse: ['builtInToolUse:assistant'],
      },
      session: { id: 'session' } as never,
      signal: new AbortController().signal,
    },
  };
}

function defaultRunner(
  hooks?: Parameters<typeof createWorkflowScriptAgentRunner>[4],
): ReturnType<typeof createWorkflowScriptAgentRunner> {
  return createWorkflowScriptAgentRunner(
    parentContext(),
    defaultAgent,
    'tool-call-7',
    run,
    hooks,
  );
}

// Default options carry inputFiles: workflow agents without input files (and
// without declared default outputs) fail fast by design; the dedicated test
// below covers that path.
function invocation(
  options: WorkflowAgentInvocation['options'] = { inputFiles: ['draft.tex'] },
): WorkflowAgentInvocation {
  return {
    index: 0,
    progressId: 'call-0',
    key: '0123456789abcdef',
    prompt: 'Draft the section.',
    options,
    signal: new AbortController().signal,
  };
}

interface InBandRunOptions {
  executionId: string;
  onActiveExecutionId?: (executionId: string) => void;
  prepare: () => Promise<unknown>;
}

/** The merged attempt-facts channel the runner reports every fact through. */
type AttemptFacts = Parameters<
  NonNullable<WorkflowAgentInvocation['report']>
>[0];

function reportSpy(): ReturnType<typeof vi.fn<(facts: AttemptFacts) => void>> {
  return vi.fn<(facts: AttemptFacts) => void>();
}

/** Every value one fact carried, in report order — a per-field view of the merged channel. */
function reported<Field extends keyof AttemptFacts>(
  report: ReturnType<typeof reportSpy>,
  field: Field,
): NonNullable<AttemptFacts[Field]>[] {
  return report.mock.calls.flatMap(([facts]) =>
    facts[field] === undefined ? [] : [facts[field]],
  );
}

// Stable in-band execution that runs the child's prepare step and records the
// options it produced, as the real executor does.
function inBandRunReturning(finalResult: AgentFinalResult) {
  return async (options: InBandRunOptions) => {
    options.onActiveExecutionId?.(options.executionId);
    mocks.preparedOptions.push(await options.prepare());
    return { executionId: 'bbbbbb222222', result: finalResult };
  };
}

function useToolUseAgentEntries(): void {
  mocks.requireVisibleAgent.mockImplementation((_category, name) => ({
    name,
    source: 'builtInToolUse',
    category: 'toolUse',
    path: `/agents/${name}.yml`,
  }));
}

describe('createWorkflowScriptAgentRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.preparedOptions.length = 0;
    mocks.requireVisibleAgent.mockImplementation((_category, name) => ({
      name,
      source: 'builtInWorkflow',
      category: 'workflow',
      path: `/agents/${name}.yml`,
    }));
    mocks.selectAvailableDelegationModel.mockResolvedValue('child-model');
    mocks.assertWorkflowFilesExist.mockResolvedValue(undefined);
    mocks.rejectOversizedBibAttachments.mockResolvedValue(null);
    mocks.runStorageLocationFromAnyAbsolutePath.mockReturnValue(undefined);
    mocks.workspaceReadBytes.mockResolvedValue(Buffer.from('workspace bytes'));
    mocks.absoluteReadBytes.mockResolvedValue(Buffer.from('run bytes'));
    mocks.readExecutionMeta.mockResolvedValue(undefined);
    mocks.executeStableSubagentInBand.mockImplementation(
      inBandRunReturning(result),
    );
  });

  it('fingerprints file bytes rather than only their paths', async () => {
    const options = { inputFiles: ['proof.tex'] };
    mocks.workspaceReadBytes.mockResolvedValueOnce(Buffer.from('old proof'));
    const oldFingerprint = await fingerprintWorkflowAgentDependencies(
      runExecutionId,
      options,
    );
    mocks.workspaceReadBytes.mockResolvedValueOnce(Buffer.from('new proof'));
    const newFingerprint = await fingerprintWorkflowAgentDependencies(
      runExecutionId,
      options,
    );

    expect(oldFingerprint).not.toBe(newFingerprint);
    expect(mocks.workspaceReadBytes).toHaveBeenCalledWith('proof.tex');
  });

  it('keeps dependency fingerprints stable for unchanged binary bytes', async () => {
    const bytes = Buffer.from([0, 255, 1, 128]);
    mocks.workspaceReadBytes.mockResolvedValue(bytes);
    const options = {
      inputFiles: ['proof.bin'],
      contextFiles: ['context.bin'],
    };

    const [first, second] = await Promise.all([
      fingerprintWorkflowAgentDependencies(runExecutionId, options),
      fingerprintWorkflowAgentDependencies(runExecutionId, options),
    ]);

    expect(first).toEqual(expect.any(String));
    expect(first).toBe(second);
  });

  it('uses delegation policy and executes a direct in-band child', async () => {
    const call = invocation({
      inputFiles: ['paper.tex'],
      contextFiles: ['notes.tex'],
      mediaFiles: ['figure.pdf'],
      label: 'Draft paper',
    });
    const report = reportSpy();
    call.report = report;
    mocks.executeStableSubagentInBand.mockImplementationOnce(
      async (options) => {
        options.onActiveExecutionId?.(options.executionId);
        const prepared = await options.prepare();
        mocks.preparedOptions.push(prepared);
        expect(reported(report, 'childStreamId')).toEqual([]);
        prepared.onStreamResolved?.(
          `correct@child-model#${options.executionId}` as StreamTabId,
        );
        return { executionId: 'bbbbbb222222', result };
      },
    );
    const runner = defaultRunner();

    await expect(runner(call)).resolves.toBe(result);
    expect(mocks.requireVisibleAgent).not.toHaveBeenCalled();
    expect(mocks.assertWorkflowFilesExist).toHaveBeenCalledWith([
      { label: 'Input file', files: ['paper.tex'] },
    ]);
    expect(mocks.assertWorkflowFilesExist).toHaveBeenCalledWith([
      { label: 'Context file', files: ['notes.tex'] },
    ]);
    expect(mocks.rejectOversizedBibAttachments).toHaveBeenCalledWith([
      'notes.tex',
    ]);
    expect(mocks.assertWorkflowFilesExist).toHaveBeenCalledWith([
      { label: 'Media file', files: ['figure.pdf'] },
    ]);
    expect(mocks.selectAvailableDelegationModel).toHaveBeenCalledWith({
      parentModel: 'parent-model',
    });
    expect(mocks.executeStableSubagentInBand).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: expect.stringMatching(/^[a-f0-9]{24}$/),
        parentExecutionId: runExecutionId,
        signal: call.signal,
        prepare: expect.any(Function),
      }),
    );
    expect(mocks.preparedOptions[0]).toEqual(
      expect.objectContaining({
        agentName: 'correct',
        parentExecutionId: runExecutionId,
        parentStreamId: runStreamId,
        signal: call.signal,
        approvalPromptsUnavailable: true,
        runtimeUnavailableTools: ['user_question'],
        configPayload: expect.objectContaining({
          agent: 'correct',
          agentSource: 'builtInWorkflow',
          agentCategory: 'workflow',
          model: 'child-model',
          instruction: 'Draft the section.',
          inputFiles: ['paper.tex'],
          contextFiles: ['notes.tex'],
          mediaFiles: ['figure.pdf'],
          workingDirectory: '/workspace',
          delegationAgentScope: {
            workflow: ['builtInWorkflow:correct'],
            toolUse: ['builtInToolUse:assistant'],
          },
        }),
      }),
    );
    // Model and agent resolve together, so they ride one report.
    expect(report).toHaveBeenCalledWith({
      model: 'child-model',
      agent: 'correct',
    });
    expect(reported(report, 'childExecutionId')).toEqual([
      expect.stringMatching(/^[a-f0-9]{24}$/),
    ]);
    expect(reported(report, 'costUsd')).toEqual([result.cost]);
    expect(reported(report, 'childStreamId')).toEqual([
      expect.stringMatching(/^correct@child-model#[a-f0-9]{24}$/),
    ]);
  });

  it('treats missing workspace files as run-fatal configuration', async () => {
    mocks.assertWorkflowFilesExist.mockRejectedValueOnce(
      new Error('Missing file: absent.tex'),
    );
    const runner = defaultRunner();

    await expect(
      runner(invocation({ inputFiles: ['absent.tex'] })),
    ).rejects.toMatchObject({
      name: 'WorkflowRunAbortError',
      message: expect.stringContaining('absent.tex'),
    });
    expect(mocks.preparedOptions).toHaveLength(0);
  });

  it('passes each declarative model override to delegation policy', async () => {
    const runner = defaultRunner();

    await runner(
      invocation({
        model: 'economy-model',
        inputFiles: ['paper.tex'],
      }),
    );
    await runner(
      invocation({
        agentName: 'assistant',
        model: 'strong-model',
        schema: { type: 'object' },
      }),
    );

    expect(mocks.selectAvailableDelegationModel).toHaveBeenNthCalledWith(1, {
      requestedModel: 'economy-model',
      parentModel: 'parent-model',
    });
    expect(mocks.selectAvailableDelegationModel).toHaveBeenNthCalledWith(2, {
      requestedModel: 'strong-model',
      parentModel: 'parent-model',
    });
  });

  it('fails the workflow when a declared model is unavailable', async () => {
    mocks.selectAvailableDelegationModel.mockRejectedValueOnce(
      new Error('Model "missing-model" is not currently available.'),
    );
    mocks.assertWorkflowFilesExist.mockRejectedValue(
      new Error('Input file "paper.tex" does not exist.'),
    );
    const runner = defaultRunner();

    await expect(
      runner(
        invocation({
          model: 'missing-model',
          inputFiles: ['paper.tex'],
        }),
      ),
    ).rejects.toMatchObject({
      name: 'WorkflowRunAbortError',
      message: expect.stringContaining('missing-model'),
    });
    expect(mocks.assertWorkflowFilesExist).not.toHaveBeenCalled();
  });

  it('preserves delegation failures when no model is declared', async () => {
    const selectionError = new Error('No delegation models are available.');
    mocks.selectAvailableDelegationModel.mockRejectedValueOnce(selectionError);
    const runner = defaultRunner();

    await expect(
      runner(invocation({ inputFiles: ['paper.tex'] })),
    ).rejects.toBe(selectionError);
  });

  it('honors an explicit agent and binds verified run outputs', async () => {
    const firstRequested =
      '/storage/executions/bbbbbb222222/r1/introduction.tex';
    const firstCanonical =
      '/canonical/executions/bbbbbb222222/r1/introduction.tex';
    const secondRequested =
      '/storage/executions/cccccc333333/r1/conclusion.tex';
    const secondCanonical =
      '/canonical/executions/cccccc333333/r1/conclusion.tex';
    mocks.runStorageLocationFromAnyAbsolutePath.mockImplementation((file) =>
      file === firstRequested || file === secondRequested
        ? { kind: 'runStorage' }
        : undefined,
    );
    mocks.resolveChildRunOutput.mockImplementation(
      async (_parentExecutionId, file) => ({
        kind: 'runStorage',
        absolutePath:
          file === firstRequested ? firstCanonical : secondCanonical,
        relativePath:
          file === firstRequested ? 'r1/introduction.tex' : 'r1/conclusion.tex',
        executionId: file === firstRequested ? 'bbbbbb222222' : 'cccccc333333',
      }),
    );
    const runner = defaultRunner();

    await runner(
      invocation({
        agentName: 'merge',
        inputFiles: [firstRequested, 'notes.tex', secondRequested],
      }),
    );

    expect(mocks.requireVisibleAgent).toHaveBeenCalledWith(
      'workflow',
      'merge',
      {
        workflow: ['builtInWorkflow:correct'],
        toolUse: ['builtInToolUse:assistant'],
      },
    );
    expect(mocks.resolveChildRunOutput).toHaveBeenNthCalledWith(
      1,
      runExecutionId,
      firstRequested,
    );
    expect(mocks.resolveChildRunOutput).toHaveBeenNthCalledWith(
      2,
      runExecutionId,
      secondRequested,
    );
    expect(mocks.assertWorkflowFilesExist).toHaveBeenCalledWith([
      { label: 'Input file', files: ['notes.tex'] },
    ]);
    expect(mocks.preparedOptions[0]).toEqual(
      expect.objectContaining({
        agentName: 'merge',
        configPayload: expect.objectContaining({
          inputFiles: [firstCanonical, 'notes.tex', secondCanonical],
        }),
      }),
    );
  });

  it('rejects a run-storage input that no longer resolves', async () => {
    const placeholder = '/storage/executions/bbbbbb222222/r1/unchanged.tex';
    mocks.runStorageLocationFromAnyAbsolutePath.mockReturnValue({
      kind: 'runStorage',
    });
    mocks.resolveChildRunOutput.mockResolvedValue(undefined);
    const runner = defaultRunner();

    await expect(
      runner(invocation({ inputFiles: [placeholder] })),
    ).rejects.toMatchObject({
      name: 'WorkflowRunAbortError',
      message: expect.stringContaining(placeholder),
    });
    expect(mocks.preparedOptions).toHaveLength(0);
  });

  it('makes oversized bibliography context run-fatal before launch', async () => {
    const message =
      'large.bib is over the 100 KiB limit. Extract the needed entries first.';
    mocks.rejectOversizedBibAttachments.mockResolvedValue({
      status: 'error',
      summary: 'Rejected oversized BibTeX attachment',
      error: message,
      diagnostics: {
        type: 'oversized_bib_attachment',
        path: 'large.bib',
        sizeBytes: 102_401,
        limitBytes: 102_400,
      },
    });
    const runner = defaultRunner();

    await expect(
      runner(
        invocation({
          inputFiles: ['draft.tex'],
          contextFiles: ['large.bib'],
        }),
      ),
    ).rejects.toMatchObject({
      name: 'WorkflowRunAbortError',
      message,
    });
    expect(mocks.preparedOptions).toHaveLength(0);
  });

  it('makes storage resolver failures run-fatal', async () => {
    const placeholder = '/storage/executions/bbbbbb222222/r1/deleted.tex';
    const storageError = new Error(
      'Declared output r1/deleted.tex is missing from execution bbbbbb222222.',
    );
    mocks.runStorageLocationFromAnyAbsolutePath.mockReturnValue({
      kind: 'runStorage',
    });
    mocks.resolveChildRunOutput.mockRejectedValue(storageError);
    const runner = defaultRunner();

    await expect(
      runner(invocation({ inputFiles: [placeholder] })),
    ).rejects.toMatchObject({
      name: 'WorkflowRunAbortError',
      message: expect.stringContaining(storageError.message),
      cause: storageError,
    });
    expect(mocks.preparedOptions).toHaveLength(0);
  });

  it('rejects mixed inputs when any run-storage input no longer resolves', async () => {
    const resolved = '/storage/executions/bbbbbb222222/r1/draft.tex';
    const stale = '/storage/executions/cccccc333333/r1/review.tex';
    mocks.runStorageLocationFromAnyAbsolutePath.mockImplementation((file) =>
      file === resolved || file === stale ? { kind: 'runStorage' } : undefined,
    );
    mocks.resolveChildRunOutput.mockImplementation(async (_parent, file) =>
      file === resolved
        ? {
            kind: 'runStorage',
            absolutePath: '/canonical/executions/bbbbbb222222/r1/draft.tex',
            relativePath: 'r1/draft.tex',
            executionId: 'bbbbbb222222',
          }
        : undefined,
    );
    const runner = defaultRunner();

    await expect(
      runner(invocation({ inputFiles: ['notes.tex', resolved, stale] })),
    ).rejects.toMatchObject({
      name: 'WorkflowRunAbortError',
      message: expect.stringContaining(stale),
    });
    expect(mocks.preparedOptions).toHaveLength(0);
  });

  it('links child approval ancestry to the parent stream on resolve', async () => {
    const runner = defaultRunner();

    await runner(invocation());

    const prepared = mocks.preparedOptions[0] as {
      onStreamResolved?: (streamId: StreamTabId) => void;
    };
    expect(prepared.onStreamResolved).toEqual(expect.any(Function));
    prepared.onStreamResolved?.('stream:child' as StreamTabId);
    expect(mocks.configureDelegatedChildApprovals).toHaveBeenCalledWith(
      'stream:child',
      runStreamId,
      'inherit',
      expect.objectContaining({ id: 'session' }),
    );
  });

  it('reports live child cost with its workflow invocation identity', async () => {
    const onCost = vi.fn();
    const report = reportSpy();
    mocks.executeStableSubagentInBand.mockImplementationOnce(
      async (options) => {
        options.onActiveExecutionId?.(options.executionId);
        const prepared = await options.prepare();
        await prepared.onCost?.(0.25);
        return { executionId: 'bbbbbb222222', result };
      },
    );
    const runner = defaultRunner({ onCost });
    const call = { ...invocation(), report };

    await runner(call);

    expect(onCost).toHaveBeenCalledWith(call, 0.25);
    // Progressive onCost stamps the live snapshot attempt (not only success),
    // and the terminal result cost is stamped after it (same value here).
    expect(reported(report, 'costUsd')).toEqual([0.25, result.cost]);
  });

  it('stamps terminal cost on failed outcomes before throwing', async () => {
    const report = reportSpy();
    mocks.executeStableSubagentInBand.mockImplementationOnce(
      async (options) => {
        options.onActiveExecutionId?.(options.executionId);
        await options.prepare();
        return {
          executionId: 'bbbbbb222222',
          result: {
            ...result,
            outcome: 'failed',
            cost: 0.42,
          },
        };
      },
    );
    const runner = defaultRunner();

    await expect(runner({ ...invocation(), report })).rejects.toThrow(
      /ended with failed outcome/,
    );
    expect(reported(report, 'costUsd')).toEqual([0.42]);
  });

  it('does not report recovered stable child cost as live execution', async () => {
    const onCost = vi.fn();
    const report = reportSpy();
    const recoveredStreamId = 'correct@child-model#bbbbbb222222' as StreamTabId;
    mocks.readExecutionMeta.mockResolvedValueOnce({
      streamId: recoveredStreamId,
    });
    mocks.executeStableSubagentInBand.mockResolvedValueOnce({
      executionId: 'bbbbbb222222',
      result: { ...result, cost: 0.25 },
    });
    const runner = defaultRunner({ onCost });

    await runner({ ...invocation(), index: 3, report });

    expect(onCost).not.toHaveBeenCalled();
    // Recovered durable children never fire onActiveExecutionId — re-attach the
    // known child id, but do not charge the synthetic resume attempt.
    expect(reported(report, 'childExecutionId')).toEqual(['bbbbbb222222']);
    expect(reported(report, 'childStreamId')).toEqual([recoveredStreamId]);
    expect(reported(report, 'costUsd')).toEqual([]);
  });

  it('keeps a recovered result when navigation metadata cannot be read', async () => {
    const report = reportSpy();
    mocks.readExecutionMeta.mockRejectedValueOnce(
      new Error('metadata unavailable'),
    );
    mocks.executeStableSubagentInBand.mockResolvedValueOnce({
      executionId: 'bbbbbb222222',
      result,
    });
    const runner = defaultRunner();

    await expect(runner({ ...invocation(), index: 3, report })).resolves.toBe(
      result,
    );
    expect(reported(report, 'childStreamId')).toEqual([]);
  });

  it('aborts the run when a file-editing agent gets no input files', async () => {
    const runner = defaultRunner();

    // Run-fatal (WorkflowRunAbortError), not a per-call failure: a plain
    // error would resolve to null inside parallel() and be silently filtered.
    await expect(runner(invocation({}))).rejects.toMatchObject({
      name: 'WorkflowRunAbortError',
      message: expect.stringMatching(
        /pass options\.inputFiles with files that still exist/,
      ),
    });
  });

  it('rejects a tool-use default agent used as a workflow agent', async () => {
    const runner = createWorkflowScriptAgentRunner(
      parentContext(),
      { ...defaultAgent, category: 'toolUse', source: 'builtInToolUse' },
      'tool-call-8',
      run,
    );

    await expect(runner(invocation({}))).rejects.toMatchObject({
      name: 'WorkflowRunAbortError',
      message: expect.stringMatching(
        /is a toolUse agent but was launched as workflow/,
      ),
    });
  });

  it('allows empty input files when the agent declares default outputs', async () => {
    const runner = createWorkflowScriptAgentRunner(
      parentContext(),
      { ...defaultAgent, defaultOutputFiles: ['generated.tex'] },
      'tool-call-7',
      run,
    );

    await expect(runner(invocation({}))).resolves.toBe(result);
  });

  it('uses one stable child id per workflow call identity', async () => {
    const runner = defaultRunner();

    await runner(invocation());
    await runner(invocation());
    await runner({ ...invocation(), index: 1 });
    await runner({ ...invocation(), key: 'fedcba9876543210' });

    const executionIds = mocks.executeStableSubagentInBand.mock.calls.map(
      ([options]) => options.executionId,
    );
    expect(executionIds[0]).toBe(executionIds[1]);
    expect(executionIds[2]).toBe(executionIds[0]);
    expect(executionIds[3]).not.toBe(executionIds[0]);
  });

  it('rejects a cancelled child so the workflow journal can retry it', async () => {
    mocks.executeStableSubagentInBand.mockResolvedValueOnce({
      executionId: 'bbbbbb222222',
      result: {
        category: 'toolUse',
        outcome: 'cancelled',
        response: '',
        files: [],
        cost: 0,
      },
    });
    const runner = defaultRunner();

    await expect(runner(invocation())).rejects.toThrow(
      'Workflow subagent ended with cancelled outcome.',
    );
  });

  it('rejects a completed workflow child that produced no output files', async () => {
    mocks.executeStableSubagentInBand.mockResolvedValueOnce({
      executionId: 'bbbbbb222222',
      result: { ...result, outputs: [] },
    });
    const runner = defaultRunner();

    await expect(runner(invocation())).rejects.toThrow(
      'Workflow subagent completed without producing any output files.',
    );
  });

  it('turns durable reconciliation failures into fatal workflow aborts', async () => {
    mocks.executeStableSubagentInBand.mockRejectedValueOnce(
      new SubagentReconciliationError('incomplete child state'),
    );
    const runner = defaultRunner();

    await expect(runner(invocation())).rejects.toMatchObject({
      name: 'WorkflowRunAbortError',
      message: 'incomplete child state',
    });
  });

  it('turns manifest-write failures into fatal workflow aborts', async () => {
    const durabilityError = new SubagentDurabilityError(
      'result manifest unavailable',
      { cause: new Error('storage offline') },
    );
    mocks.executeStableSubagentInBand.mockRejectedValueOnce(durabilityError);
    const runner = defaultRunner();

    await expect(runner(invocation())).rejects.toMatchObject({
      name: 'WorkflowRunAbortError',
      message: 'result manifest unavailable',
      cause: durabilityError,
    });
  });

  it('reports the active-attempt execution id, not the logical id', async () => {
    // After a durable retry advances the attempt sequence, the live run uses an
    // attempt-specific execution id — the id its child stream / roster expose.
    // The runner must report THAT id, not the logical id it hands stable
    // execution, so a host's skip/retry finds the row.
    const attemptExecutionId = 'cccccc333333' as ExecutionId;
    let logicalExecutionId: string | undefined;
    mocks.executeStableSubagentInBand.mockImplementation(async (options) => {
      logicalExecutionId = options.executionId;
      options.onActiveExecutionId?.(attemptExecutionId);
      mocks.preparedOptions.push(await options.prepare());
      return { executionId: attemptExecutionId, result };
    });
    const report = reportSpy();
    const runner = defaultRunner();

    await expect(runner({ ...invocation(), report })).resolves.toBe(result);

    expect(logicalExecutionId).toMatch(/^[a-f0-9]{24}$/);
    expect(logicalExecutionId).not.toBe(attemptExecutionId);
    expect(reported(report, 'childExecutionId')).toEqual([attemptExecutionId]);
  });

  it('routes an agent({ schema }) call to a tool-use agent with an output schema', async () => {
    useToolUseAgentEntries();
    mocks.executeStableSubagentInBand.mockImplementationOnce(
      inBandRunReturning(structuredResult),
    );
    const schema = {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    };
    const runner = defaultRunner();

    await expect(
      runner(invocation({ agentName: 'assistant', schema })),
    ).resolves.toBe(structuredResult);

    expect(mocks.requireVisibleAgent).toHaveBeenCalledWith(
      'toolUse',
      'assistant',
      expect.anything(),
    );
    expect(mocks.selectAvailableDelegationModel).toHaveBeenCalledWith({
      parentModel: 'parent-model',
    });
    expect(mocks.preparedOptions[0]).toEqual(
      expect.objectContaining({
        agentName: 'assistant',
        configPayload: expect.objectContaining({
          agentCategory: 'toolUse',
          outputSchema: schema,
        }),
      }),
    );
    expect(
      (mocks.preparedOptions[0] as { configPayload: object }).configPayload,
    ).not.toHaveProperty('inputFiles');
    expect(mocks.assertWorkflowFilesExist).not.toHaveBeenCalled();
  });

  it('exempts a schema call from the workflow empty-files guard', async () => {
    useToolUseAgentEntries();
    mocks.executeStableSubagentInBand.mockImplementationOnce(
      inBandRunReturning(structuredResult),
    );
    const schema = { type: 'object', additionalProperties: false };
    const runner = defaultRunner();

    // No input files and no default outputs: the workflow path aborts, but a
    // schema call runs a tool-use agent whose result is the submitted value.
    await expect(
      runner(invocation({ agentName: 'assistant', schema })),
    ).resolves.toBe(structuredResult);
    expect(mocks.preparedOptions[0]).toEqual(
      expect.objectContaining({
        configPayload: expect.objectContaining({ agentCategory: 'toolUse' }),
      }),
    );
  });

  it('reports a recovered attempt only through its recovered child id', async () => {
    // A recovered attempt never fires onActiveExecutionId, so the only child id
    // it reports is the durable one that supplied the result — no phantom live
    // attempt is announced for a call that never ran.
    mocks.executeStableSubagentInBand.mockImplementation(async () => ({
      executionId: 'bbbbbb222222',
      result,
    }));
    const report = reportSpy();
    const runner = defaultRunner();

    await expect(runner({ ...invocation(), report })).resolves.toBe(result);
    expect(reported(report, 'childExecutionId')).toEqual(['bbbbbb222222']);
    expect(reported(report, 'costUsd')).toEqual([]);
  });
});
