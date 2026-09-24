/* eslint-disable import/order -- Vitest mocks must be declared before importing the module under test. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import * as nodePath from 'node:path';

import { it } from '@effect/vitest';
import { Cause, Deferred, Effect, Exit, Fiber } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';
import '@test/support/sessionGraphTestSetup';

import { publishTestRunStart } from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import { fakePath } from '@test/support/FakePlatform';
import { TraceEmitter } from '@agent/trace';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { deriveWorkflowScriptCheckpointId } from '@agent/workflowScript/checkpoint';
import { getRunRecords } from '@agent/storage';
import { type SessionHandle } from '@agent/runtime/SessionHandle';
import { initializeDefaultSession } from '@agent/runtime/sessionGraph';
import { closeSession } from '@agent/runtime/sessionGraph';
import {
  AgentCategory,
  aggregateId,
  emptyRunEndOutput,
  RUN_OUTCOME,
  USER_FOLLOW_UP_SUPPORT,
} from '@shared/schemas';
import type { RunId, WorkflowScriptFiles } from '@shared/schemas';
import {
  DatabaseClaimRefused,
  DatabaseNotOwner,
  DatabaseWriteFailed,
} from '@shared/session/database';
import {
  DELEGATION_TOOL_CATEGORY,
  DELEGATION_TOOLS,
} from '@shared/constants/delegationTools';
import { deriveRunId } from '@utils/core/idHash';
import { convertToolSchema } from '@agent/runtime/run/toolSchema';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';

setupPlatform({
  storagePath: fakePath('storage'),
  workspacePath: fakePath('workspace'),
});

const mocks = vi.hoisted(() => ({
  registerRun: vi.fn(),
  recordStores: new Map<string, ReturnType<typeof getRunRecords>>(),
  startChildRunLoop: vi.fn(),
  createChildRun: vi.fn(),
  configureDelegatedChildApprovals: vi.fn(),
  requireWorkflowOrToolUseAgent: vi.fn(),
  selectAvailableDelegationModel: vi.fn(),
  requestDelegationProposal: vi.fn(),
  createWorkflowScriptStrategy: vi.fn(),
  childLoggerError: vi.fn(),
}));

// Spread the real storage module so every reader stays authentic; only
// registration is spied so the launch can be observed without touching the
// async run loop.
vi.mock('@agent/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/storage')>();
  const { createFakeRunRecords } = await import('@test/support/FakeRunRecords');
  return {
    ...actual,
    registerRun: mocks.registerRun,
    getRunRecords: (_session: unknown, id: string) => {
      const existing = mocks.recordStores.get(id);
      if (existing) return existing;
      let report: string | null = null;
      const records = createFakeRunRecords({
        readReport: () => Effect.succeed(report),
        writeReport: (value) =>
          Effect.sync(() => {
            report = value;
          }),
        clearReport: () =>
          Effect.sync(() => {
            report = null;
          }),
      });
      mocks.recordStores.set(id, records);
      return records;
    },
  };
});

// The launch sites register through `registerRun`; route the spy through it.
vi.mock('@agent/storage/runLifecycle', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent/storage/runLifecycle')>();
  return {
    ...actual,
    registerRun: mocks.registerRun,
  };
});

vi.mock('@tools/delegation/workflowScriptStrategy', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@tools/delegation/workflowScriptStrategy')
    >();
  return {
    ...actual,
    createWorkflowScriptStrategy: (
      params: Parameters<typeof actual.createWorkflowScriptStrategy>[0],
    ) => {
      mocks.createWorkflowScriptStrategy(params);
      return actual.createWorkflowScriptStrategy(params);
    },
  };
});

vi.mock('@agent/runtime/childRunLoop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/runtime/childRunLoop')>()),
  startChildRunLoop: mocks.startChildRunLoop,
}));

vi.mock('@tools/delegation/childRun', () => ({
  createChildRun: mocks.createChildRun,
  childRunDescription: (raw: string) => raw,
}));

vi.mock('@tools/approval', () => ({
  configureDelegatedChildApprovals: mocks.configureDelegatedChildApprovals,
}));

vi.mock('@tools/delegation/proposalFlow', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tools/delegation/proposalFlow')>()),
  requireWorkflowOrToolUseAgent: mocks.requireWorkflowOrToolUseAgent,
  requestDelegationProposal: mocks.requestDelegationProposal,
}));

vi.mock('@tools/delegation/delegationAvailability', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@tools/delegation/delegationAvailability')
  >()),
  selectAvailableDelegationModel: mocks.selectAvailableDelegationModel,
}));

import { WorkflowScriptTool } from '@tools/delegation/WorkflowScriptTool';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';

const parentRunId = '7154c4700700' as RunId;
let session: SessionHandle;
const script = `export const meta = {
  name: 'tool-test',
  description: 'tests the workflow script tool',
}
return await agent('saved call')`;

function toolLayer(stopAfterCycle = false) {
  return nativeToolTestLayer({
    toolCallId: 'tool-call',
    hooks: { recordSubagentCost: vi.fn() },
    run: {
      runId: parentRunId,
      session: testDefaultSession(),
      config: AgentConfigSchema.parse({
        agent: 'chat',
        model: 'parent-model',
      }),
      logger: new TraceEmitter(),
      toolPolicy: { stopAfterCycle },
    },
  });
}

/** The tool's durable identity for one meta.name under the test parent. */
function checkpointIdFor(name: string): string {
  return deriveWorkflowScriptCheckpointId({
    name,
    defaultAgent: 'correct',
    parentRunId,
  });
}

/** The deterministic run id derived from that checkpoint identity. */
function runIdFor(name: string): RunId {
  return deriveRunId({ checkpointId: checkpointIdFor(name) });
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
    identity: { kind: 'multiAgentWorkflow', workflowName: name },
    userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
    parentRunId,
    description: 'tests the workflow script tool',
  });
}

/** The test workspace root every relative path below resolves against. */
const WORKSPACE_ROOT = fakePath('workspace');

function inWorkspace(target: string): string {
  return nodePath.join(WORKSPACE_ROOT, target);
}

async function writeWorkspaceScript(
  path: string,
  content: string,
): Promise<void> {
  await mkdir(inWorkspace('.texra/workflow-scripts'), { recursive: true });
  await writeFile(inWorkspace(path), content);
}

/** Point the run's persisted report and terminal fact at scripted values. */
function mockPersistedReport(
  name: string,
  report: string,
  outcome: (typeof RUN_OUTCOME)[keyof typeof RUN_OUTCOME],
): void {
  const store = getRunRecords(testDefaultSession(), runIdFor(name));
  vi.spyOn(store, 'readReport').mockReturnValue(Effect.succeed(report));
  vi.spyOn(store, 'readRunEnd').mockReturnValue(
    Effect.succeed({ outcome, output: emptyRunEndOutput('workflow') }),
  );
}

const WORKFLOW_ATTEMPT_ID = 'attempt-1';

function publishWorkflowBoard(
  runId: RunId,
  phase: string,
  label: string,
): Effect.Effect<void, never> {
  return Effect.promise(async () => {
    const session = testDefaultSession();
    session.publishRunEvent(runId, {
      type: 'workflow.plan',
      attemptId: WORKFLOW_ATTEMPT_ID,
      phases: [{ title: phase }],
      tasks: [],
    });
    session.publishRunEvent(runId, {
      type: 'stage.start',
      id: 'phase-1',
      label: phase,
      kind: 'phase',
    });
    session.publishRunEvent(runId, {
      type: 'workflow.call',
      logId: 'workflow-task-1',
      stageId: 'phase-1',
      call: {
        id: 'call-1',
        label,
        phase,
        kind: 'document',
        files: { input: [], context: [], media: [] },
        childRunId: 'bbbbbb222222' as RunId,
        attemptId: WORKFLOW_ATTEMPT_ID,
        status: 'running',
      },
    });
    await Effect.runPromise(session.settlePublications());
  });
}

function callTool(
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

function callToolInput(
  input: {
    agent: string;
    script?: string | null;
    scriptPath?: string | null;
    files?: WorkflowScriptFiles;
  },
  stopAfterCycle = false,
) {
  return WorkflowScriptTool.call(input).pipe(
    Effect.provide(toolLayer(stopAfterCycle)),
  );
}

beforeEach(async () => {
  // `setupPlatform` installs this suite's host first. Open the default session
  // only after that final root exists, rather than retaining the setup file's
  // host through the per-test platform swap.
  session = await Effect.runPromise(
    initializeDefaultSession({
      roots: testWorkspaceRoots(),
      transcriptMode: {
        kind: 'ephemeral',
        reason: 'workflow script tool test session',
      },
    }),
  );
  publishTestRunStart(session, parentRunId);
  await Effect.runPromise(session.settlePublications());
  vi.clearAllMocks();
  mocks.recordStores.clear();
  await mkdir(WORKSPACE_ROOT, { recursive: true });
  await writeFile(inWorkspace('paper.tex'), '\\documentclass{article}');
  await writeFile(inWorkspace('references.bib'), '@book{example}');
  await writeFile(inWorkspace('figure.pdf'), 'pdf');
  mocks.registerRun.mockReturnValue(Effect.void);
  mocks.selectAvailableDelegationModel.mockReturnValue(
    Effect.succeed('parent-model'),
  );
  mocks.requestDelegationProposal.mockReturnValue(
    Effect.succeed({ result: { action: 'approve' }, autoApproved: false }),
  );
  mocks.startChildRunLoop.mockReturnValue(Effect.forkDetach(Effect.void));
  mocks.requireWorkflowOrToolUseAgent.mockImplementation((_stores, name) => {
    if (name === 'missing-agent') {
      return Effect.fail(
        new Error("Unknown workflow agent 'missing-agent'. Available: correct"),
      );
    }
    return Effect.succeed({
      name,
      source: 'builtInWorkflow',
      category: 'workflow',
      path: `/agents/${name}.yaml`,
    });
  });
  mocks.createChildRun.mockImplementation((_session: unknown, runId: RunId) =>
    Effect.sync(() => {
      const logger = new TraceEmitter();
      vi.spyOn(logger, 'error').mockImplementation(mocks.childLoggerError);
      return {
        childRunId: runId,
        logger,
        waitForInput: vi.fn(),
        beginTurn: vi.fn(),
        failTurn: vi.fn(),
        finalize: vi.fn(() => Effect.void),
      };
    }),
  );
});

afterEach(async () => {
  await Effect.runPromise(closeSession(session.roots.storage));
});

describe('WorkflowScriptTool', () => {
  it.effect('does not register or execute the workflow before approval', () =>
    Effect.gen(function* () {
      const asked = yield* Deferred.make<void>();
      const decided = yield* Deferred.make<{
        result: { action: 'approve' };
        autoApproved: boolean;
      }>();
      mocks.requestDelegationProposal.mockReturnValueOnce(
        Deferred.succeed(asked, undefined).pipe(
          Effect.andThen(Deferred.await(decided)),
        ),
      );

      const pending = yield* Effect.forkChild(callTool());
      yield* Deferred.await(asked);
      expect(mocks.requestDelegationProposal).toHaveBeenCalledOnce();
      expect(mocks.registerRun).not.toHaveBeenCalled();
      expect(mocks.startChildRunLoop).not.toHaveBeenCalled();

      yield* Deferred.succeed(decided, {
        result: { action: 'approve' as const },
        autoApproved: false,
      });
      yield* Fiber.join(pending);
      expect(mocks.registerRun).toHaveBeenCalledOnce();
      expect(mocks.startChildRunLoop).toHaveBeenCalledOnce();
    }),
  );

  it.effect(
    'pins the workflow child edit grant when proposal bypass approved it',
    () =>
      Effect.gen(function* () {
        mocks.requestDelegationProposal.mockReturnValueOnce(
          Effect.succeed({ result: { action: 'approve' }, autoApproved: true }),
        );

        yield* callTool();

        expect(mocks.configureDelegatedChildApprovals).toHaveBeenCalledWith(
          runIdFor('tool-test'),
          parentRunId,
          'auto-approved',
          testDefaultSession(),
        );
      }),
  );

  it.effect.each([
    {
      decision: { action: 'reject', feedback: 'Use fewer agents.' } as const,
      status: 'error',
    },
    { decision: { action: 'setup' } as const, status: 'executed' },
  ])('does not execute after $decision.action', ({ decision, status }) =>
    Effect.gen(function* () {
      mocks.requestDelegationProposal.mockReturnValueOnce(
        Effect.succeed({ result: decision, autoApproved: false }),
      );

      const result = yield* callTool();

      expect(result.status).toBe(status);
      expect(mocks.registerRun).not.toHaveBeenCalled();
      expect(mocks.startChildRunLoop).not.toHaveBeenCalled();
      if (decision.action === 'reject') {
        expect(result).toMatchObject({
          error: expect.stringContaining('Use fewer agents.'),
        });
      }
    }),
  );

  it.effect(
    'includes workflow identity, agent, phases, tasks, and script path in the approval payload',
    () =>
      Effect.gen(function* () {
        const plannedScript = `export const meta = {
  name: 'review-team',
  description: 'Review the draft in parallel',
  phases: ['Review', 'Synthesize'],
  tasks: [
    { id: 'review', label: 'Review draft', phase: 'Review' },
    { id: 'merge', label: 'Merge findings', phase: 'Synthesize' },
  ],
}
return null`;

        yield* callTool({ script: plannedScript, agent: 'correct' });

        expect(mocks.requestDelegationProposal).toHaveBeenCalledWith(
          expect.objectContaining({
            agent: 'correct',
            model: 'parent-model',
            instruction: 'Review the draft in parallel',
            workflowScript: expect.objectContaining({
              name: 'review-team',
              description: 'Review the draft in parallel',
              scriptPath: expect.stringMatching(
                /^\.texra\/workflow-scripts\/draft-tool-call(?:-\d+)?\.mjs$/,
              ),
              phases: [{ title: 'Review' }, { title: 'Synthesize' }],
              tasks: [
                { id: 'review', label: 'Review draft', phase: 'Review' },
                { id: 'merge', label: 'Merge findings', phase: 'Synthesize' },
              ],
            }),
          }),
          expect.objectContaining({
            run: expect.objectContaining({
              runId: parentRunId,
              config: expect.objectContaining({ model: 'parent-model' }),
            }),
          }),
        );
      }),
  );

  it.effect(
    'owns a detached run completion rejection without delivering a second error',
    () =>
      Effect.gen(function* () {
        const lateFailure = new Error('late finalization failed');
        mocks.startChildRunLoop.mockReturnValueOnce(
          Effect.forkDetach(Effect.fail(lateFailure)),
        );
        const logged = yield* Deferred.make<void>();
        mocks.childLoggerError.mockImplementationOnce(() => {
          Deferred.doneUnsafe(logged, Effect.void);
        });

        const result = yield* callTool();

        expect(result).toMatchObject({
          status: 'executed',
          summary: "Launched workflow script 'tool-test' (async)",
        });
        yield* Deferred.await(logged);
        expect(mocks.childLoggerError).toHaveBeenCalledWith(
          "Workflow script 'tool-test' run loop failed after launch",
          { data: lateFailure },
        );
        expect(mocks.startChildRunLoop).toHaveBeenCalledTimes(1);
      }),
  );

  it('pins the provider schema shape at the model-facing boundary', () => {
    const definition = WorkflowScriptTool.definition;
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

  it.effect('rejects invalid JSON arguments at the schema boundary', () =>
    Effect.gen(function* () {
      const result = yield* WorkflowScriptTool.call({
        agent: 'correct',
        script,
        scriptPath: null,
        args: { invalid: undefined },
      }).pipe(Effect.provide(nativeToolTestLayer()));

      expect(result.status).toBe('error');
      expect(result.diagnostics).toMatchObject({ type: 'validation_error' });
      expect(mocks.startChildRunLoop).not.toHaveBeenCalled();
    }),
  );

  it.effect('requires a launched tool context', () =>
    Effect.gen(function* () {
      const outside = yield* WorkflowScriptTool.call({
        agent: 'correct',
        script,
        scriptPath: null,
      }).pipe(Effect.provide(nativeToolTestLayer()));
      expect(outside).toMatchObject({
        status: 'error',
        error: expect.stringContaining('active run context'),
      });
      expect(mocks.startChildRunLoop).not.toHaveBeenCalled();
    }),
  );

  it.effect(
    'launches the run as a detached child with a deterministic run id',
    () =>
      Effect.gen(function* () {
        const result = yield* callTool();

        const runId = runIdFor('tool-test');
        // The run id is derived from the checkpoint identity (NOT random), so a
        // relaunch with the same meta.name re-roots at the same anchor and resume
        // still works (#8712).
        expect(mocks.registerRun).toHaveBeenCalledWith(
          testDefaultSession(),
          runId,
          // The durable record is honest: workflow name, launch summary, and the
          // real delegation model. It has no fabricated agent identity or category.
          registrationRecordFor('tool-test'),
          registrationOptionsFor('tool-test'),
        );
        expect(mocks.createChildRun).toHaveBeenCalledWith(
          testDefaultSession(),
          runId,
          parentRunId,
          expect.objectContaining({
            run: { kind: 'multiAgentWorkflow', workflowName: 'tool-test' },
          }),
        );
        // The child run inherits the orchestrator's approval ancestry.
        expect(mocks.configureDelegatedChildApprovals).toHaveBeenCalledWith(
          runId,
          parentRunId,
          'inherit',
          testDefaultSession(),
        );
        expect(mocks.startChildRunLoop).toHaveBeenCalledTimes(1);
        const loopParams = mocks.startChildRunLoop.mock.calls[0]?.[0];
        expect(loopParams).toMatchObject({
          parentRunId,
          runId,
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
        expect(result.output).toContain(`launched as run ${runId}.`);
        expect(result.output).toContain(
          'Script file: .texra/workflow-scripts/draft-tool-call.mjs',
        );
        expect(result.output).toContain('same meta.name');
      }),
  );

  it.effect('never overwrites an edited submitted-source draft', () =>
    Effect.gen(function* () {
      const originalPath = '.texra/workflow-scripts/draft-tool-call.mjs';
      yield* Effect.promise(() =>
        writeWorkspaceScript(originalPath, '// edited by the model'),
      );

      const result = yield* callTool();
      const savedPath = result.output?.match(
        /Script file: (\.texra\/workflow-scripts\/\S+?\.mjs)/,
      )?.[1];

      expect(savedPath).toBeTruthy();
      expect(savedPath).not.toBe(originalPath);
      expect(
        yield* Effect.promise(() =>
          readFile(inWorkspace(originalPath), 'utf-8'),
        ),
      ).toBe('// edited by the model');
      expect(
        yield* Effect.promise(() =>
          readFile(inWorkspace(savedPath ?? ''), 'utf-8'),
        ),
      ).toBe(script);
    }),
  );

  it.effect('loads an edited workflow script from scriptPath', () =>
    Effect.gen(function* () {
      const editedScript = script
        .replace("name: 'tool-test'", "name: 'edited-tool-test'")
        .replace('saved call', 'edited saved call');
      const scriptPath = '.texra/workflow-scripts/edited.mjs';
      yield* Effect.promise(() =>
        writeWorkspaceScript(scriptPath, editedScript),
      );

      const result = yield* callToolInput({
        agent: 'correct',
        script: null,
        scriptPath,
      });

      expect(result).toMatchObject({
        status: 'executed',
        summary: "Launched workflow script 'edited-tool-test' (async)",
      });
      expect(result.output).toContain(`Script file: ${scriptPath}`);
      expect(mocks.registerRun).toHaveBeenCalledWith(
        testDefaultSession(),
        runIdFor('edited-tool-test'),
        registrationRecordFor('edited-tool-test'),
        registrationOptionsFor('edited-tool-test'),
      );
    }),
  );

  it.effect(
    'saves invalid submitted source and returns its editable draft path',
    () =>
      Effect.gen(function* () {
        const invalidScript = 'return await agent("missing meta")';

        const result = yield* callTool({ script: invalidScript });

        expect(result).toMatchObject({
          status: 'error',
          error: expect.stringContaining('Script file:'),
        });
        const draftPath = result.error?.match(
          /Script file: (\.texra\/workflow-scripts\/\S+?\.mjs)/,
        )?.[1];
        expect(draftPath).toBeTruthy();
        expect(
          yield* Effect.promise(() =>
            readFile(inWorkspace(draftPath ?? ''), 'utf-8'),
          ),
        ).toBe(invalidScript);
        expect(mocks.registerRun).not.toHaveBeenCalled();
      }),
  );

  it.effect('reports the same editable file when file-mode parsing fails', () =>
    Effect.gen(function* () {
      const scriptPath = '.texra/workflow-scripts/broken.mjs';
      yield* Effect.promise(() =>
        writeWorkspaceScript(scriptPath, 'return null'),
      );

      const result = yield* callToolInput({
        agent: 'correct',
        scriptPath,
      });

      expect(result).toMatchObject({
        status: 'error',
        error: expect.stringContaining(`Script file: ${scriptPath}`),
      });
      expect(result.error).toContain('with scriptPath:');
    }),
  );

  it.effect('requires exactly one script source', () =>
    Effect.gen(function* () {
      for (const input of [
        { agent: 'correct' },
        {
          agent: 'correct',
          script,
          scriptPath: '.texra/workflow-scripts/stale.mjs',
        },
      ]) {
        const result = yield* WorkflowScriptTool.call(input).pipe(
          Effect.provide(nativeToolTestLayer()),
        );
        expect(result).toMatchObject({
          status: 'error',
          diagnostics: { type: 'validation_error' },
        });
        expect(result.error).toContain(
          'Provide exactly one of script or scriptPath',
        );
      }
    }),
  );

  it.effect(
    'does not offer an edit-and-retry hint when the script file is unreadable',
    () =>
      Effect.gen(function* () {
        const scriptPath = '.texra/workflow-scripts/missing.mjs';

        const result = yield* callToolInput({
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
      }),
  );

  it.effect('waits for the workflow report in a one-cycle headless run', () =>
    Effect.gen(function* () {
      const scriptReference =
        'Script file: .texra/workflow-scripts/draft-tool-call.mjs';
      mockPersistedReport(
        'tool-test',
        `<workflow-script-result>solved</workflow-script-result>\n\n${scriptReference}`,
        RUN_OUTCOME.COMPLETED,
      );

      const result = yield* callTool({ stopAfterCycle: true });

      const loopParams = mocks.startChildRunLoop.mock.calls[0]?.[0];
      expect(loopParams.strategy.deliveryMode).toBe('persistOnly');
      expect(result).toMatchObject({
        status: 'executed',
        summary: "Completed workflow script 'tool-test'",
        output: expect.stringContaining(
          '<workflow-script-result>solved</workflow-script-result>',
        ),
      });
      expect(result.output?.split(scriptReference)).toHaveLength(2);
    }),
  );

  it.effect.each([
    { cause: Cause.interrupt(), name: 'an interrupt', hasDefect: false },
    {
      cause: Cause.fromReasons([
        Cause.makeInterruptReason(),
        Cause.makeDieReason(new Error('launch cleanup failed')),
      ]),
      name: 'an interrupted cleanup defect',
      hasDefect: true,
    },
  ])('preserves $name from workflow launch', ({ cause, hasDefect }) =>
    Effect.gen(function* () {
      mocks.startChildRunLoop.mockReturnValueOnce(Effect.failCause(cause));

      const exit = yield* Effect.exit(callTool());

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.hasInterrupts(exit.cause)).toBe(true);
        expect(Cause.hasDies(exit.cause)).toBe(hasDefect);
      }
    }),
  );

  it.effect(
    'returns a persisted headless failure without duplicating its script reference',
    () =>
      Effect.gen(function* () {
        const scriptReference =
          'Script file: .texra/workflow-scripts/draft-tool-call.mjs';
        mockPersistedReport(
          'tool-test',
          `<workflow-script-error>broken</workflow-script-error>\n\n${scriptReference}`,
          RUN_OUTCOME.FAILED,
        );

        const result = yield* callTool({ stopAfterCycle: true });

        expect(result).toMatchObject({
          status: 'error',
          summary: "Workflow script 'tool-test' failed",
          error: expect.stringContaining(
            '<workflow-script-error>broken</workflow-script-error>',
          ),
        });
        expect(result.error?.split(scriptReference)).toHaveLength(2);
      }),
  );

  it.effect(
    'does not return a prior report when a resumed headless run is interrupted before delivery',
    () =>
      Effect.gen(function* () {
        const resumedScript = script.replace(
          "name: 'tool-test'",
          "name: 'interrupted-resume'",
        );
        const runId = runIdFor('interrupted-resume');
        const store = getRunRecords(testDefaultSession(), runId);
        yield* store.writeReport('stale success from the prior attempt');
        vi.spyOn(store, 'readRunEnd').mockReturnValue(
          Effect.succeed({
            outcome: RUN_OUTCOME.FAILED,
            output: emptyRunEndOutput('workflow'),
          }),
        );

        // The default resolved completion writes no report, matching an
        // interruption before childRunLoop reaches deliverTurn.
        const result = yield* callTool({
          script: resumedScript,
          stopAfterCycle: true,
        });

        expect(result).toMatchObject({
          status: 'error',
          error: expect.stringContaining(
            "Workflow script 'interrupted-resume' completed without a persisted report.",
          ),
        });
        expect(result.error).not.toContain(
          'stale success from the prior attempt',
        );
        expect(yield* store.readReport()).toBeNull();
      }),
  );

  it.effect(
    'rejects an unknown default agent before registering a detached run',
    () =>
      Effect.gen(function* () {
        const result = yield* callTool({ agent: 'missing-agent' });

        expect(result).toMatchObject({
          status: 'error',
          error: expect.stringContaining(
            "Unknown workflow agent 'missing-agent'",
          ),
        });
        expect(result.error).toContain('Script file: .texra/workflow-scripts/');
        expect(mocks.registerRun).not.toHaveBeenCalled();
        expect(mocks.createChildRun).not.toHaveBeenCalled();
        expect(mocks.startChildRunLoop).not.toHaveBeenCalled();
      }),
  );

  it.effect('gates the run model through delegation model availability', () =>
    Effect.gen(function* () {
      mocks.selectAvailableDelegationModel.mockReturnValueOnce(
        Effect.succeed('served-model'),
      );

      yield* callTool();

      expect(mocks.selectAvailableDelegationModel).toHaveBeenCalledWith({
        parentModel: 'parent-model',
        settings: expect.objectContaining({ globalState: expect.anything() }),
      });
      expect(mocks.registerRun).toHaveBeenCalledWith(
        testDefaultSession(),
        runIdFor('tool-test'),
        registrationRecordFor('tool-test', 'served-model'),
        registrationOptionsFor('tool-test'),
      );
    }),
  );

  it.effect(
    'rejects an unserveable run model before registering a detached run',
    () =>
      Effect.gen(function* () {
        mocks.selectAvailableDelegationModel.mockReturnValueOnce(
          Effect.fail(
            new Error('No models are currently available for delegation.'),
          ),
        );

        const result = yield* callTool();

        expect(result).toMatchObject({
          status: 'error',
          error: expect.stringContaining(
            'No models are currently available for delegation.',
          ),
        });
        expect(result.error).toContain('Script file: .texra/workflow-scripts/');
        expect(mocks.registerRun).not.toHaveBeenCalled();
        expect(mocks.createChildRun).not.toHaveBeenCalled();
        expect(mocks.startChildRunLoop).not.toHaveBeenCalled();
      }),
  );

  it.effect('validates files and binds them to the live workflow run', () =>
    Effect.gen(function* () {
      const files = {
        inputFiles: ['paper.tex'],
        contextFiles: ['references.bib'],
        mediaFiles: ['figure.pdf'],
      } as const satisfies WorkflowScriptFiles;
      const result = yield* callTool({ files });

      expect(result.status).toBe('executed');
      // The durable record stays honest (no file lists); the binding rides the
      // checkpoint and the live run config the agent steps consume.
      expect(mocks.createChildRun).toHaveBeenCalledWith(
        testDefaultSession(),
        runIdFor('tool-test'),
        expect.anything(),
        expect.objectContaining({
          config: expect.objectContaining({
            inputFiles: ['paper.tex'],
            contextFiles: ['references.bib'],
            mediaFiles: ['figure.pdf'],
          }),
        }),
      );
    }),
  );

  it.effect('rejects an oversized bibliography bound as workflow context', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeFile(inWorkspace('large.bib'), 'x'.repeat(100 * 1024 + 1)),
      );

      const result = yield* callTool({
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
      expect(mocks.registerRun).not.toHaveBeenCalled();
      expect(mocks.startChildRunLoop).not.toHaveBeenCalled();
    }),
  );

  it.effect('registers checkpoint files when a resume omits files', () =>
    Effect.gen(function* () {
      const resumeScript = script.replace(
        "name: 'tool-test'",
        "name: 'resume'",
      );
      const files = {
        inputFiles: ['paper.tex'],
        contextFiles: ['references.bib'],
        mediaFiles: ['figure.pdf'],
      } as const satisfies WorkflowScriptFiles;
      // The checkpoint's source of record: one `workflow.script` row on the
      // aggregate the run's `checkpointId` names, with no journal behind it.
      yield* testDefaultSession().commit([
        {
          type: 'workflow.script',
          aggregateId: aggregateId(
            'workflow-checkpoint',
            checkpointIdFor('resume'),
          ),
          parentRunId,
          script: resumeScript,
          args: { kind: 'undefined' },
          files,
        },
      ]);

      const result = yield* callTool({ script: resumeScript });

      expect(result.status).toBe('executed');
      expect(mocks.createChildRun).toHaveBeenCalledWith(
        testDefaultSession(),
        runIdFor('resume'),
        expect.anything(),
        expect.objectContaining({
          config: expect.objectContaining({
            inputFiles: ['paper.tex'],
            contextFiles: ['references.bib'],
            mediaFiles: ['figure.pdf'],
          }),
        }),
      );
    }),
  );

  it.effect(
    'regenerates the same run id across relaunches of one meta.name',
    () =>
      Effect.gen(function* () {
        yield* callTool();
        const first = mocks.startChildRunLoop.mock.calls[0]?.[0].runId;
        mocks.startChildRunLoop.mockClear();
        // A retrying model rewrites its source; the deterministic run id and the
        // meta.name-anchored checkpoint keep resume intact.
        yield* callTool({ script: `${script}\n// retry rewrote me` });
        const second = mocks.startChildRunLoop.mock.calls[0]?.[0].runId;

        expect(first).toBe(runIdFor('tool-test'));
        expect(second).toBe(first);
      }),
  );

  it.effect(
    'keeps the committed workflow board when reopening a named run',
    () =>
      Effect.gen(function* () {
        const runId = runIdFor('tool-test');
        const phase = 'Research';
        const label = 'Interrupted call';
        let reopenedTasks: unknown;
        yield* testDefaultSession().commit([
          {
            type: 'run.start',
            aggregateId: aggregateId('run', runId),
            identity: {
              kind: 'multiAgentWorkflow',
              workflowName: 'tool-test',
            },
            userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
            category: AgentCategory.Workflow,
            isRemote: false,
            parent: { id: parentRunId },
            checkpointId: checkpointIdFor('tool-test'),
          },
          {
            type: 'run.activate',
            aggregateId: aggregateId('run', runId),
            category: AgentCategory.Workflow,
          },
        ]);
        yield* publishWorkflowBoard(runId, phase, label);

        mocks.createChildRun.mockImplementationOnce(
          (_session: unknown, childRunId: RunId) =>
            Effect.gen(function* () {
              const view = yield* testDefaultSession().readView([childRunId]);
              reopenedTasks = view.runs.get(childRunId)?.transcript.run?.tasks;
              const logger = new TraceEmitter();
              vi.spyOn(logger, 'error').mockImplementation(
                mocks.childLoggerError,
              );
              return {
                childRunId,
                logger,
                waitForInput: vi.fn(),
                beginTurn: vi.fn(),
                failTurn: vi.fn(),
                finalize: vi.fn(() => Effect.void),
              };
            }),
        );

        const result = yield* callTool();

        expect(result.status).toBe('executed');
        expect(reopenedTasks).toEqual([
          expect.objectContaining({
            call: expect.objectContaining({ label }),
          }),
        ]);
        expect(mocks.createChildRun).toHaveBeenCalledWith(
          testDefaultSession(),
          runId,
          expect.anything(),
          expect.anything(),
        );
      }),
  );

  it.effect(
    'reports already-running when another process holds the deterministic id',
    () =>
      Effect.gen(function* () {
        const runId = runIdFor('tool-test');
        mocks.registerRun.mockReturnValueOnce(
          Effect.fail(
            new DatabaseWriteFailed({
              path: 'session.db',
              cause: new DatabaseClaimRefused({
                ownerId: JSON.stringify(['test-host', 1, '1']),
                verdict: 'alive',
              }),
            }),
          ),
        );

        const result = yield* callTool();

        expect(result).toMatchObject({
          status: 'executed',
          summary: "Workflow script 'tool-test' is already running",
        });
        expect(result.output).toContain(`Run ID: ${runId}`);
        // A relaunch over a live run never starts a second competing loop.
        expect(mocks.createChildRun).not.toHaveBeenCalled();
        expect(mocks.startChildRunLoop).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    'classifies a first-launch DatabaseNotOwner by whether the refusing aggregate is closed',
    () =>
      Effect.gen(function* () {
        const runId = runIdFor('tool-test');
        const aggregate = aggregateId('run', runId);
        // A first launch of this id has no prior row to acquire the claim
        // from, so the claim rides the birth append and a foreign winner
        // refuses that append as `DatabaseNotOwner` rather than as a refused
        // claim acquisition. An open aggregate is a live run to wait on; a
        // closed one is a tombstone and stays a failure. A real closed-row
        // refusal keeps the closing owner.
        mocks.registerRun.mockReturnValueOnce(
          Effect.fail(
            new DatabaseNotOwner({
              aggregateId: aggregate,
              ownerId: JSON.stringify(['other-host', 2, '1']),
              closed: false,
            }),
          ),
        );

        const open = yield* callTool();
        expect(open).toMatchObject({
          status: 'executed',
          summary: "Workflow script 'tool-test' is already running",
        });
        expect(open.output).toContain(`Run ID: ${runId}`);

        mocks.registerRun.mockReturnValueOnce(
          Effect.fail(
            new DatabaseNotOwner({
              aggregateId: aggregate,
              ownerId: JSON.stringify(['closing-host', 1, '1']),
              closed: true,
            }),
          ),
        );

        const closed = yield* callTool();
        expect(closed).toMatchObject({
          status: 'error',
          error: expect.stringContaining(
            "Failed to launch workflow script 'tool-test'",
          ),
        });
        expect(mocks.createChildRun).not.toHaveBeenCalled();
        expect(mocks.startChildRunLoop).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    'reports already-running when this process still runs the deterministic id',
    () =>
      Effect.gen(function* () {
        const runId = runIdFor('tool-test');
        // The claim never refuses its own holder, so the run's lane is what
        // separates two dispatches of one deterministic id: the first holds
        // it from admission through registration, and the second is refused
        // where a read of the same fact would have let it register too.
        const registering = yield* Deferred.make<void>();
        const finishRegistration = yield* Deferred.make<void>();
        mocks.registerRun.mockImplementation(() =>
          Deferred.succeed(registering, undefined).pipe(
            Effect.andThen(Deferred.await(finishRegistration)),
          ),
        );

        const first = yield* Effect.forkChild(callTool());
        yield* Deferred.await(registering);
        const second = yield* Fiber.join(yield* Effect.forkChild(callTool()));

        expect(second).toMatchObject({
          status: 'executed',
          summary: "Workflow script 'tool-test' is already running",
        });
        expect(second.output).toContain(`Run ID: ${runId}`);

        yield* Deferred.succeed(finishRegistration, undefined);
        expect((yield* Fiber.join(first)).status).toBe('executed');
        // One admission, so one registration and one child loop.
        expect(mocks.registerRun).toHaveBeenCalledOnce();
        expect(mocks.createChildRun).toHaveBeenCalledOnce();
        expect(mocks.startChildRunLoop).toHaveBeenCalledOnce();
      }),
  );
});
