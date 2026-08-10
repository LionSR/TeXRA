/* eslint-disable import/order -- Vitest mocks must be declared before importing the module under test. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setupPlatform } from '@test/support/setupPlatform';
import { TraceEmitter } from '@agent/trace';
import {
  deriveWorkflowScriptCheckpointId,
  writeWorkflowScriptCheckpoint,
} from '@agent/workflowScript';
import { getExecutionStore } from '@agent/storage';
import { ExecutionLeaseActiveError } from '@agent/storage/executionLease';
import { withToolFileInteractionContext } from '@agent/followUp/ToolFileInteractionContext';
import type { LaunchRunContext } from '@agent/runtime/RunContext';
import { withRunContext } from '@agent/runtime/RunContext';
import {
  EXECUTION_STATUS,
  RUN_OUTCOME,
  USER_FOLLOW_UP_SUPPORT,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import type { WorkflowScriptFiles } from '@shared/schemas/workflowScriptFiles';
import {
  DELEGATION_TOOL_CATEGORY,
  DELEGATION_TOOLS,
} from '@shared/constants/delegationTools';
import { deriveExecutionId } from '@utils/core/idHash';
import { WorkspaceFS } from '@utils/files';
import { convertToolSchema } from '@agent/modelHandlers/toolConversion';

setupPlatform({ storagePath: '/storage', workspacePath: '/workspace' });

const mocks = vi.hoisted(() => ({
  registerExecution: vi.fn(),
  startChildRunLoop: vi.fn(),
  createRehydratedChildStream: vi.fn(),
  configureDelegatedChildApprovals: vi.fn(),
  requireWorkflowOrToolUseAgent: vi.fn(),
  selectAvailableDelegationModel: vi.fn(),
  createWorkflowScriptStrategy: vi.fn(),
  childLoggerError: vi.fn(),
  lastStrategyParams: undefined as { initialSnapshot?: unknown } | undefined,
}));

// Spread the real storage module so `getExecutionStore` stays authentic;
// only registration is spied so the launch can be observed without touching
// the async run loop. The executionLease mock below spreads the real
// `ExecutionLeaseActiveError` and lease helpers the same way.
vi.mock('@agent/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/storage')>();
  return { ...actual, registerExecution: mocks.registerExecution };
});

vi.mock('@tools/delegation/workflowScriptStrategy', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@tools/delegation/workflowScriptStrategy')
    >();
  return {
    ...actual,
    createWorkflowScriptStrategy: (params: { initialSnapshot?: unknown }) => {
      mocks.lastStrategyParams = params;
      mocks.createWorkflowScriptStrategy(params);
      return actual.createWorkflowScriptStrategy(
        params as Parameters<typeof actual.createWorkflowScriptStrategy>[0],
      );
    },
  };
});

vi.mock('@agent/storage/executionLease', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/storage/executionLease')>()),
  captureOwnedExecutionLease:
    (_executionId: ExecutionId) => (operation: () => unknown) =>
      operation(),
}));

vi.mock('@agent/runtime/childRunLoop', () => ({
  startChildRunLoop: mocks.startChildRunLoop,
}));

vi.mock('@tools/delegation/childStream', () => ({
  createRehydratedChildStream: mocks.createRehydratedChildStream,
  childStreamDescription: (raw: string) => raw,
  getChildStreamId: (executionId: string, prefix: string) =>
    `${prefix}#${executionId}`,
}));

vi.mock('@tools/approval', () => ({
  configureDelegatedChildApprovals: mocks.configureDelegatedChildApprovals,
}));

vi.mock('@tools/delegation/proposalFlow', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tools/delegation/proposalFlow')>()),
  requireWorkflowOrToolUseAgent: mocks.requireWorkflowOrToolUseAgent,
  selectAvailableDelegationModel: mocks.selectAvailableDelegationModel,
}));

import { WorkflowScriptTool } from '@tools/delegation/WorkflowScriptTool';
import { getDefaultToolRegistry } from '@tools/registry';

const executionId = '7154scripttool' as ExecutionId;
const streamId = 'stream:workflow-script-tool' as StreamTabId;
const script = `export const meta = {
  name: 'tool-test',
  description: 'tests the workflow script tool',
}
return await agent('saved call')`;

function parentContext(stopAfterCycle = false): LaunchRunContext {
  return {
    kind: 'launch',
    model: 'parent-model',
    stopAfterCycle,
    runScope: {
      executionId,
      streamId,
      agentName: 'orchestrator',
      session: { id: 'workflow-script-test' } as never,
      signal: new AbortController().signal,
    },
  };
}

/** The tool's durable identity for one meta.name under the test parent. */
function checkpointIdFor(name: string): string {
  return deriveWorkflowScriptCheckpointId({
    name,
    defaultAgent: 'correct',
    parentExecutionId: executionId,
  });
}

/** The deterministic run executionId derived from that checkpoint identity. */
function runExecutionIdFor(name: string): ExecutionId {
  return deriveExecutionId({ checkpointId: checkpointIdFor(name) });
}

/** The exact durable run record a launch of `name` must preserve. */
function registrationRecordFor(name: string, model = 'parent-model') {
  return {
    name,
    instruction: `Workflow script '${name}'`,
    model,
  };
}

/** The registration options a launch of `name` must record. */
function registrationOptionsFor(name: string) {
  return expect.objectContaining({
    streamId: `workflow-script#${runExecutionIdFor(name)}`,
    identity: { kind: 'multiAgentWorkflow', workflowName: name },
    userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
    parentExecutionId: executionId,
    description: 'tests the workflow script tool',
  });
}

async function writeWorkspaceScript(
  path: string,
  content: string,
): Promise<void> {
  await WorkspaceFS.ensureDir('.texra/workflow-scripts');
  await WorkspaceFS.write(path, content);
}

/** Point the run's persisted report and outcome at scripted values. */
function mockPersistedReport(
  name: string,
  report: string,
  outcome: (typeof RUN_OUTCOME)[keyof typeof RUN_OUTCOME],
): void {
  const store = getExecutionStore(runExecutionIdFor(name));
  vi.spyOn(store, 'readReport').mockResolvedValue(report);
  vi.spyOn(store, 'readMeta').mockResolvedValue({ outcome } as never);
}

async function callTool(
  options: {
    script?: string;
    files?: WorkflowScriptFiles;
    agent?: string;
    stopAfterCycle?: boolean;
  } = {},
) {
  return callToolInput(
    {
      agent: options.agent ?? 'correct',
      script: options.script ?? script,
      ...(options.files ? { files: options.files } : {}),
    },
    options.stopAfterCycle ?? false,
  );
}

async function callToolInput(
  input: {
    agent: string;
    script?: string | null;
    scriptPath?: string | null;
    files?: WorkflowScriptFiles;
  },
  stopAfterCycle = false,
) {
  return withRunContext(parentContext(stopAfterCycle), () =>
    withToolFileInteractionContext(
      {
        tracker: {} as never,
        toolCallId: 'tool-call',
        trace: new TraceEmitter(),
        hooks: { recordSubagentCost: vi.fn() },
      },
      () => new WorkflowScriptTool().call(input),
    ),
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.lastStrategyParams = undefined;
  await WorkspaceFS.ensureDir('.');
  await WorkspaceFS.write('paper.tex', '\\documentclass{article}');
  await WorkspaceFS.write('references.bib', '@book{example}');
  await WorkspaceFS.write('figure.pdf', 'pdf');
  mocks.registerExecution.mockResolvedValue(undefined);
  mocks.selectAvailableDelegationModel.mockResolvedValue('parent-model');
  mocks.startChildRunLoop.mockReturnValue({
    completion: Promise.resolve(),
  });
  mocks.requireWorkflowOrToolUseAgent.mockImplementation((name) => {
    if (name === 'missing-agent') {
      throw new Error(
        "Unknown workflow agent 'missing-agent'. Available: correct",
      );
    }
    return {
      agent: {
        name,
        source: 'builtInWorkflow',
        category: 'workflow',
        path: `/agents/${name}.yaml`,
      },
      category: 'workflow' as const,
    };
  });
  mocks.createRehydratedChildStream.mockImplementation(
    async (runId: ExecutionId): Promise<unknown> => {
      const logger = new TraceEmitter();
      vi.spyOn(logger, 'error').mockImplementation(mocks.childLoggerError);
      return {
        childStreamId: `workflow-script#${runId}` as StreamTabId,
        logger,
        waitForInput: vi.fn(),
        beginTurn: vi.fn(),
        failTurn: vi.fn(),
        finalize: vi.fn(),
      };
    },
  );
});

describe('WorkflowScriptTool', () => {
  it('is registered and classified without becoming a proposal tool', () => {
    expect(getDefaultToolRegistry().has('delegate_multi_agents')).toBe(true);
    expect(DELEGATION_TOOLS.has('delegate_multi_agents')).toBe(true);
    expect(DELEGATION_TOOL_CATEGORY.delegate_multi_agents).toBeUndefined();
  });

  it('owns a detached run completion rejection without delivering a second error', async () => {
    const lateFailure = new Error('late finalization failed');
    mocks.startChildRunLoop.mockReturnValueOnce({
      completion: Promise.reject(lateFailure),
    });

    const result = await callTool();

    expect(result).toMatchObject({
      status: 'executed',
      summary: "Launched workflow script 'tool-test' (async)",
    });
    await vi.waitFor(() => {
      expect(mocks.childLoggerError).toHaveBeenCalledWith(
        "Workflow script 'tool-test' run loop failed after launch",
        { data: lateFailure },
      );
    });
    // The detached completion owner logs only; it does not manufacture a
    // second parent follow-up or replace the already returned launch result.
    expect(mocks.startChildRunLoop).toHaveBeenCalledTimes(1);
  });

  it('declares the task-plan contract at the model-facing boundary', () => {
    const definition = new WorkflowScriptTool().definition;
    const description = definition.description;
    const providerSchema = convertToolSchema(definition);
    const providerProperties = providerSchema?.properties as
      Record<string, { description?: string }> | undefined;

    expect(providerSchema).toMatchObject({
      type: 'object',
      properties: {
        script: expect.any(Object),
        scriptPath: expect.any(Object),
      },
    });
    expect(providerProperties?.args?.description).toContain('JSON value');
    expect(providerProperties).not.toHaveProperty('scriptInput');
    expect(providerSchema?.required).not.toContain('script');
    expect(providerSchema?.required).not.toContain('scriptPath');
    expect(providerProperties?.script?.description).toContain(
      'Provide exactly one of script or scriptPath',
    );
    expect(providerProperties?.scriptPath?.description).toContain(
      'Provide exactly one of script or scriptPath',
    );
    expect(description).toContain(
      'declare meta.tasks as { id, label, phase? } records',
    );
    expect(description).toContain(
      "meta.phases accepts title strings such as ['Draft', 'Merge']",
    );
    expect(description).toContain(
      'progress shows the pending plan before execution',
    );
    expect(description).toContain(
      'A task phase must name a title in meta.phases',
    );
    expect(description).toContain(
      'Every agent() call must then reference one declared task with { id }',
    );
    expect(description).toContain(
      'omit label and phase from the call because meta.tasks owns them',
    );
    expect(description).toContain(
      'A call without meta.tasks may also use id, label, and phase',
    );
    expect(description).toContain(
      'Omit meta.tasks when the call set is data-dependent',
    );
    expect(
      definition.zodSchema?.safeParse({
        agent: 'review',
        script,
        args: { nested: ['text', 1, true, null] },
      }).success,
    ).toBe(true);
    expect(
      definition.zodSchema?.safeParse({
        agent: 'review',
        script,
        args: ['not', 'an', 'argument', 'object'],
      }).success,
    ).toBe(true);
  });

  it('rejects invalid JSON arguments at the schema boundary', async () => {
    const result = await new WorkflowScriptTool().call({
      agent: 'correct',
      script,
      scriptPath: null,
      args: { invalid: undefined },
    });

    expect(result.status).toBe('error');
    expect(result.diagnostics).toMatchObject({ type: 'validation_error' });
    expect(mocks.startChildRunLoop).not.toHaveBeenCalled();
  });

  it('requires a launched tool context', async () => {
    const outside = await new WorkflowScriptTool().call({
      agent: 'correct',
      script,
      scriptPath: null,
    });
    expect(outside).toMatchObject({
      status: 'error',
      error: expect.stringContaining('active launched agent session'),
    });
    expect(mocks.startChildRunLoop).not.toHaveBeenCalled();
  });

  it('launches the run as a detached child with a deterministic run id', async () => {
    const result = await callTool();

    const runExecutionId = runExecutionIdFor('tool-test');
    // The run id is derived from the checkpoint identity (NOT random), so a
    // relaunch with the same meta.name re-roots at the same anchor and resume
    // still works (#8712).
    expect(mocks.registerExecution).toHaveBeenCalledWith(
      runExecutionId,
      // The durable record is honest: workflow name, launch summary, and the
      // real delegation model. It has no fabricated agent identity or category.
      registrationRecordFor('tool-test'),
      'tool-test',
      registrationOptionsFor('tool-test'),
    );
    expect(mocks.createRehydratedChildStream).toHaveBeenCalledWith(
      runExecutionId,
      streamId,
      expect.objectContaining({
        streamPrefix: 'workflow-script',
        run: { kind: 'multiAgentWorkflow', workflowName: 'tool-test' },
      }),
    );
    // The run's own stream inherits the orchestrator's approval ancestry.
    expect(mocks.configureDelegatedChildApprovals).toHaveBeenCalledWith(
      `workflow-script#${runExecutionId}`,
      streamId,
      'inherit',
      expect.objectContaining({ id: 'workflow-script-test' }),
    );
    expect(mocks.startChildRunLoop).toHaveBeenCalledTimes(1);
    const loopParams = mocks.startChildRunLoop.mock.calls[0]?.[0];
    expect(loopParams).toMatchObject({
      childStreamId: `workflow-script#${runExecutionId}`,
      parentStreamId: streamId,
      executionId: runExecutionId,
      agentName: 'tool-test',
    });
    expect(loopParams.strategy).toMatchObject({
      stageLabel: "Workflow script 'tool-test'",
      launch: expect.any(Function),
      isTerminal: expect.any(Function),
    });
    // Terminal-only: no runTurn (workflow-script is the only strategy that
    // omits it — the native subagent strategy declares one unconditionally,
    // even for a workflow-category child).
    expect(loopParams.strategy.runTurn).toBeUndefined();
    expect(loopParams.recordCost).toEqual(expect.any(Function));

    expect(result).toMatchObject({
      status: 'executed',
      summary: "Launched workflow script 'tool-test' (async)",
    });
    expect(result.output).toContain(`Execution ID: ${runExecutionId}`);
    expect(result.output).toContain(
      'Script file: .texra/workflow-scripts/draft-tool-call.mjs',
    );
    expect(result.output).toContain('same meta.name');
  });

  it('saves submitted source as an editable workspace script', async () => {
    await callTool();

    expect(
      await WorkspaceFS.read('.texra/workflow-scripts/draft-tool-call.mjs'),
    ).toBe(script);
  });

  it('never overwrites an edited submitted-source draft', async () => {
    const originalPath = '.texra/workflow-scripts/draft-tool-call.mjs';
    await writeWorkspaceScript(originalPath, '// edited by the model');

    const result = await callTool();
    const savedPath = result.output?.match(
      /Script file: (\.texra\/workflow-scripts\/\S+?\.mjs)/,
    )?.[1];

    expect(savedPath).toBeTruthy();
    expect(savedPath).not.toBe(originalPath);
    expect(await WorkspaceFS.read(originalPath)).toBe('// edited by the model');
    expect(await WorkspaceFS.read(savedPath ?? '')).toBe(script);
  });

  it('loads an edited workflow script from scriptPath', async () => {
    const editedScript = script
      .replace("name: 'tool-test'", "name: 'edited-tool-test'")
      .replace('saved call', 'edited saved call');
    const scriptPath = '.texra/workflow-scripts/edited.mjs';
    await writeWorkspaceScript(scriptPath, editedScript);

    const result = await callToolInput({
      agent: 'correct',
      script: null,
      scriptPath,
    });

    expect(result).toMatchObject({
      status: 'executed',
      summary: "Launched workflow script 'edited-tool-test' (async)",
    });
    expect(result.output).toContain(`Script file: ${scriptPath}`);
    expect(mocks.registerExecution).toHaveBeenCalledWith(
      runExecutionIdFor('edited-tool-test'),
      registrationRecordFor('edited-tool-test'),
      'edited-tool-test',
      registrationOptionsFor('edited-tool-test'),
    );
  });

  it('saves invalid submitted source and returns its editable draft path', async () => {
    const invalidScript = 'return await agent("missing meta")';

    const result = await callTool({ script: invalidScript });

    expect(result).toMatchObject({
      status: 'error',
      error: expect.stringContaining('Script file:'),
    });
    const draftPath = result.error?.match(
      /Script file: (\.texra\/workflow-scripts\/\S+?\.mjs)/,
    )?.[1];
    expect(draftPath).toBeTruthy();
    expect(await WorkspaceFS.read(draftPath ?? '')).toBe(invalidScript);
    expect(mocks.registerExecution).not.toHaveBeenCalled();
  });

  it('reports the same editable file when file-mode parsing fails', async () => {
    const scriptPath = '.texra/workflow-scripts/broken.mjs';
    await writeWorkspaceScript(scriptPath, 'return null');

    const result = await callToolInput({
      agent: 'correct',
      scriptPath,
    });

    expect(result).toMatchObject({
      status: 'error',
      error: expect.stringContaining(`Script file: ${scriptPath}`),
    });
    expect(result.error).toContain('with scriptPath:');
  });

  it('requires exactly one script source', async () => {
    for (const input of [
      { agent: 'correct' },
      {
        agent: 'correct',
        script,
        scriptPath: '.texra/workflow-scripts/stale.mjs',
      },
    ]) {
      const result = await new WorkflowScriptTool().call(input);
      expect(result).toMatchObject({
        status: 'error',
        diagnostics: { type: 'validation_error' },
      });
      expect(result.error).toContain(
        'Provide exactly one of script or scriptPath',
      );
    }
  });

  it('does not offer an edit-and-retry hint when the script file is unreadable', async () => {
    const scriptPath = '.texra/workflow-scripts/missing.mjs';

    const result = await callToolInput({
      agent: 'correct',
      scriptPath,
    });

    expect(result).toMatchObject({
      status: 'error',
      error: expect.stringContaining(
        `Unable to read workflow script '${scriptPath}'`,
      ),
    });
    expect(result.error).not.toContain('To revise and rerun it');
  });

  it('waits for the workflow report in a one-cycle headless run', async () => {
    const scriptReference =
      'Script file: .texra/workflow-scripts/draft-tool-call.mjs';
    mockPersistedReport(
      'tool-test',
      `<workflow-script-result>solved</workflow-script-result>\n\n${scriptReference}`,
      RUN_OUTCOME.COMPLETED,
    );

    const result = await callTool({ stopAfterCycle: true });

    const loopParams = mocks.startChildRunLoop.mock.calls[0]?.[0];
    expect(loopParams.strategy.deliveryMode).toBe('persistOnly');
    expect(loopParams.strategy.resolveDeliveryTarget).toBeUndefined();
    expect(result).toMatchObject({
      status: 'executed',
      summary: "Completed workflow script 'tool-test'",
      output: expect.stringContaining(
        '<workflow-script-result>solved</workflow-script-result>',
      ),
    });
    expect(result.output?.split(scriptReference)).toHaveLength(2);
  });

  it('returns a persisted headless failure without duplicating its script reference', async () => {
    const scriptReference =
      'Script file: .texra/workflow-scripts/draft-tool-call.mjs';
    mockPersistedReport(
      'tool-test',
      `<workflow-script-error>broken</workflow-script-error>\n\n${scriptReference}`,
      RUN_OUTCOME.FAILED,
    );

    const result = await callTool({ stopAfterCycle: true });

    expect(result).toMatchObject({
      status: 'error',
      summary: "Workflow script 'tool-test' failed",
      error: expect.stringContaining(
        '<workflow-script-error>broken</workflow-script-error>',
      ),
    });
    expect(result.error?.split(scriptReference)).toHaveLength(2);
  });

  it('does not return a prior report when a resumed headless run is interrupted before delivery', async () => {
    const resumedScript = script.replace(
      "name: 'tool-test'",
      "name: 'interrupted-resume'",
    );
    const runExecutionId = runExecutionIdFor('interrupted-resume');
    const store = getExecutionStore(runExecutionId);
    await store.writeReport('stale success from the prior attempt');
    vi.spyOn(store, 'readMeta').mockResolvedValue({
      outcome: RUN_OUTCOME.FAILED,
    } as never);

    // The default resolved completion writes no report, matching an
    // interruption before childRunLoop reaches deliverTurn.
    const result = await callTool({
      script: resumedScript,
      stopAfterCycle: true,
    });

    expect(result).toMatchObject({
      status: 'error',
      error: expect.stringContaining(
        "Workflow script 'interrupted-resume' completed without a persisted report.",
      ),
    });
    expect(result.error).not.toContain('stale success from the prior attempt');
    await expect(store.readReport()).resolves.toBeNull();
  });

  it('rejects an unknown default agent before registering a detached run', async () => {
    const result = await callTool({ agent: 'missing-agent' });

    expect(result).toMatchObject({
      status: 'error',
      error: expect.stringContaining("Unknown workflow agent 'missing-agent'"),
    });
    expect(result.error).toContain('Script file: .texra/workflow-scripts/');
    expect(mocks.registerExecution).not.toHaveBeenCalled();
    expect(mocks.createRehydratedChildStream).not.toHaveBeenCalled();
    expect(mocks.startChildRunLoop).not.toHaveBeenCalled();
  });

  it('gates the run model through delegation model availability', async () => {
    mocks.selectAvailableDelegationModel.mockResolvedValueOnce('served-model');

    await callTool();

    expect(mocks.selectAvailableDelegationModel).toHaveBeenCalledWith({
      parentModel: 'parent-model',
      agentCategory: 'workflow',
    });
    expect(mocks.registerExecution).toHaveBeenCalledWith(
      runExecutionIdFor('tool-test'),
      registrationRecordFor('tool-test', 'served-model'),
      'tool-test',
      registrationOptionsFor('tool-test'),
    );
  });

  it('rejects an unserveable run model before registering a detached run', async () => {
    mocks.selectAvailableDelegationModel.mockRejectedValueOnce(
      new Error('No models are currently available for delegation.'),
    );

    const result = await callTool();

    expect(result).toMatchObject({
      status: 'error',
      error: expect.stringContaining(
        'No models are currently available for delegation.',
      ),
    });
    expect(result.error).toContain('Script file: .texra/workflow-scripts/');
    expect(mocks.registerExecution).not.toHaveBeenCalled();
    expect(mocks.createRehydratedChildStream).not.toHaveBeenCalled();
    expect(mocks.startChildRunLoop).not.toHaveBeenCalled();
  });

  it('validates files and binds them to the live workflow run stream', async () => {
    const files = {
      inputFiles: ['paper.tex'],
      contextFiles: ['references.bib'],
      mediaFiles: ['figure.pdf'],
    } as const satisfies WorkflowScriptFiles;
    const result = await callTool({ files });

    expect(result.status).toBe('executed');
    // The durable record stays honest (no file lists); the binding rides the
    // checkpoint and the live stream config the agent steps consume.
    expect(mocks.createRehydratedChildStream).toHaveBeenCalledWith(
      runExecutionIdFor('tool-test'),
      expect.anything(),
      expect.objectContaining({
        config: expect.objectContaining({
          inputFiles: ['paper.tex'],
          contextFiles: ['references.bib'],
          mediaFiles: ['figure.pdf'],
        }),
      }),
    );
  });

  it('rejects an oversized bibliography bound as workflow context', async () => {
    await WorkspaceFS.write('large.bib', 'x'.repeat(100 * 1024 + 1));

    const result = await callTool({
      files: {
        inputFiles: ['paper.tex'],
        contextFiles: ['large.bib'],
        mediaFiles: [],
      },
    });

    expect(result).toMatchObject({
      status: 'error',
      summary: 'Rejected oversized BibTeX attachment',
      diagnostics: {
        type: 'oversized_bib_attachment',
        path: 'large.bib',
        sizeBytes: 100 * 1024 + 1,
        limitBytes: 100 * 1024,
      },
    });
    expect(mocks.registerExecution).not.toHaveBeenCalled();
    expect(mocks.startChildRunLoop).not.toHaveBeenCalled();
  });

  it('registers checkpoint files when a resume omits files', async () => {
    const resumeScript = script.replace("name: 'tool-test'", "name: 'resume'");
    const files = {
      inputFiles: ['paper.tex'],
      contextFiles: ['references.bib'],
      mediaFiles: ['figure.pdf'],
    } as const satisfies WorkflowScriptFiles;
    await writeWorkflowScriptCheckpoint(
      getExecutionStore(executionId),
      checkpointIdFor('resume'),
      {
        script: resumeScript,
        args: undefined,
        files,
        journal: [],
      },
    );

    const result = await callTool({ script: resumeScript });

    expect(result.status).toBe('executed');
    expect(mocks.createRehydratedChildStream).toHaveBeenCalledWith(
      runExecutionIdFor('resume'),
      expect.anything(),
      expect.objectContaining({
        config: expect.objectContaining({
          inputFiles: ['paper.tex'],
          contextFiles: ['references.bib'],
          mediaFiles: ['figure.pdf'],
        }),
      }),
    );
  });

  it('regenerates the same run id across relaunches of one meta.name', async () => {
    await callTool();
    const first = mocks.startChildRunLoop.mock.calls[0]?.[0].executionId;
    mocks.startChildRunLoop.mockClear();
    // A retrying model rewrites its source; the deterministic run id and the
    // meta.name-anchored checkpoint keep resume intact.
    await callTool({ script: `${script}\n// retry rewrote me` });
    const second = mocks.startChildRunLoop.mock.calls[0]?.[0].executionId;

    expect(first).toBe(runExecutionIdFor('tool-test'));
    expect(second).toBe(first);
  });

  it('captures prior workflow snapshot before registerExecution overwrites meta', async () => {
    const runId = runExecutionIdFor('tool-test');
    const store = getExecutionStore(runId);
    const priorWorkflow = {
      lifecycle: 'active' as const,
      stages: [],
      calls: [
        {
          id: 'interrupted',
          label: 'Interrupted call',
          files: { input: [], context: [], media: [] },
          attempts: [
            {
              number: 1,
              id: 'bbbbbb222222',
              startedAt: '2026-08-01T00:00:00.000Z',
            },
          ],
          status: 'running' as const,
          costUsd: 1.25,
          childExecutionId: 'bbbbbb222222',
          timestamps: {
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-01T00:00:01.000Z',
            startedAt: '2026-08-01T00:00:00.000Z',
          },
        },
      ],
      counts: {
        total: 1,
        waiting: 0,
        planned: 0,
        stageBlocked: 0,
        queued: 0,
        starting: 0,
        running: 1,
        completed: 0,
        failed: 0,
        cancelled: 0,
        skipped: 0,
        cached: 0,
      },
      timestamps: {
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:01.000Z',
      },
    };
    await store.writeMeta({
      timestamp: '2026-08-01T00:00:00.000Z',
      workflow: priorWorkflow,
    });

    const callOrder: string[] = [];
    const readStrict = vi
      .spyOn(store, 'readMetaStrict')
      .mockImplementation(async () => {
        callOrder.push('readMetaStrict');
        return {
          schemaVersion: 1,
          timestamp: '2026-08-01T00:00:00.000Z',
          workflow: priorWorkflow,
        };
      });
    mocks.registerExecution.mockImplementation(async () => {
      callOrder.push('registerExecution');
      // Simulate production: registration replaces meta without workflow.
      await store.writeMeta({
        timestamp: '2026-08-10T00:00:00.000Z',
        streamId: `workflow-script#${runId}`,
        identity: { kind: 'multiAgentWorkflow', workflowName: 'tool-test' },
        userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
      });
    });

    const result = await callTool();

    expect(result.status).toBe('executed');
    expect(callOrder).toEqual(['readMetaStrict', 'registerExecution']);
    // Strategy must receive the pre-register snapshot, not a post-wipe read.
    expect(mocks.lastStrategyParams?.initialSnapshot).toEqual(priorWorkflow);
    // Post-register meta no longer has workflow — a post-register read would
    // have lost hydration state.
    await expect(store.readMeta()).resolves.not.toHaveProperty('workflow');
    readStrict.mockRestore();
  });

  it('reports already-running when the deterministic id is still leased', async () => {
    const runExecutionId = runExecutionIdFor('tool-test');
    mocks.registerExecution.mockRejectedValueOnce(
      new ExecutionLeaseActiveError(runExecutionId, Date.now()),
    );

    const result = await callTool();

    expect(result).toMatchObject({
      status: 'executed',
      summary: "Workflow script 'tool-test' is already running",
    });
    expect(result.output).toContain(`Execution ID: ${runExecutionId}`);
    // A relaunch over a live run never starts a second competing loop.
    expect(mocks.createRehydratedChildStream).not.toHaveBeenCalled();
    expect(mocks.startChildRunLoop).not.toHaveBeenCalled();
  });

  it('derives distinct checkpoints when name or default agent differ', () => {
    const base = checkpointIdFor('tool-test');
    expect(checkpointIdFor('other-name')).not.toBe(base);
    expect(
      deriveWorkflowScriptCheckpointId({
        name: 'tool-test',
        defaultAgent: 'merge',
        parentExecutionId: executionId,
      }),
    ).not.toBe(base);
  });
});
