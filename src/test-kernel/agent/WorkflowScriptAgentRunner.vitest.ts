import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Cause, Deferred, Effect, Exit } from 'effect';

import { beforeEach, describe, expect, vi } from 'vitest';

import { FileInteractionState } from '@agent/core/state/AgentWorkspaceState';
import { RunLanes } from '@agent/runtime/runLanes';
import type { WorkflowAgentInvocation } from '@agent/workflowScript/types';
import type { AgentEntry } from '@agent/index/agentEntry';
import { RunUsageTotalsSchema, type RunEnd, type RunId } from '@shared/schemas';
import { FakeConfigProvider } from '@test/support/FakePlatform';
import { fakeProcessServices } from '@test/support/setupPlatform';
import { createWorkflowScriptAgentRunner as createNativeWorkflowScriptAgentRunner } from '@tools/delegation/workflowScriptAgentRunner';
import { fingerprintWorkflowAgentDependencies as fingerprintInputDependencies } from '@tools/delegation/inputFields';
import type { DelegationParent } from '@tools/delegation/proposalFlow';
import { SubagentDurabilityError } from '@tools/delegation/inBandSubagentRun';
import { ensureError } from '@utils/errors/errorMessage';
import { deriveRunId } from '@utils/core/idHash';
import { StorageFS } from '@utils/files/storageFS';

const WORKSPACE_PATH = path.resolve(path.sep, 'workspace');
const STORAGE_PATH = path.resolve(path.sep, 'storage');
const CANONICAL_PATH = path.resolve(path.sep, 'canonical');

const workspacePath = (...segments: string[]) =>
  path.join(WORKSPACE_PATH, ...segments);
const storagePath = (...segments: string[]) =>
  path.join(STORAGE_PATH, ...segments);
const canonicalPath = (...segments: string[]) =>
  path.join(CANONICAL_PATH, ...segments);

function createWorkflowScriptAgentRunner(
  ...args: Parameters<typeof createNativeWorkflowScriptAgentRunner>
) {
  const runner = createNativeWorkflowScriptAgentRunner(...args);
  return (invocation: WorkflowAgentInvocation) =>
    Effect.provide(runner(invocation), fakeProcessServices());
}

function fingerprintWorkflowAgentDependencies(
  ...args: Parameters<typeof fingerprintInputDependencies> extends [
    unknown,
    ...infer Rest,
  ]
    ? Rest
    : never
) {
  return fingerprintInputDependencies(parentContext().run.session, ...args);
}

const mocks = vi.hoisted(() => ({
  executeSubagentInBand: vi.fn(),
  acquireClaims: vi.fn(),
  getRunRecords: vi.fn(),
  resolveRunLiveness: vi.fn(),
  readWorkflowCallAttempt: vi.fn(),
  recordWorkflowCallAttempt: vi.fn(),
  probedRunIds: [] as string[],
  preparedOptions: [] as unknown[],
  requireVisibleAgent: vi.fn(),
  selectAvailableDelegationModel: vi.fn(),
  resolveChildRunOutput: vi.fn(),
  runStorageLocationFromAnyAbsolutePath: vi.fn(),
  workspaceExists: vi.fn(),
  rejectOversizedBibAttachments: vi.fn(),
  configureDelegatedChildApprovals: vi.fn(),
  workspaceToAbsolute: vi.fn(),
  realpath: vi.fn(),
  absoluteReadBytes: vi.fn(),
}));

vi.mock('@tools/approval', () => ({
  configureDelegatedChildApprovals: mocks.configureDelegatedChildApprovals,
}));

vi.mock('@tools/delegation/inBandSubagentRun', async (importOriginal) => {
  // Only the launch entry point is faked; the durability error the runner
  // classifies is the real class.
  return {
    ...(await importOriginal<
      typeof import('@tools/delegation/inBandSubagentRun')
    >()),
    executeSubagentInBand: mocks.executeSubagentInBand,
  };
});

vi.mock('@tools/delegation/proposalFlow', () => ({
  requireVisibleAgent: mocks.requireVisibleAgent,
}));

vi.mock('@tools/delegation/delegationAvailability', () => ({
  selectAvailableDelegationModel: mocks.selectAvailableDelegationModel,
}));

vi.mock('@tools/executions/runLiveness', () => ({
  resolveRunLiveness: mocks.resolveRunLiveness,
}));

// The parent's attempt mark lives on the checkpoint aggregate; this suite's
// session is a stub, so the journal is faked at its two entry points.
vi.mock('@agent/workflowScript/checkpoint', () => ({
  readWorkflowCallAttempt: mocks.readWorkflowCallAttempt,
  recordWorkflowCallAttempt: mocks.recordWorkflowCallAttempt,
}));

vi.mock('@agent/storage', () => ({
  resolveChildRunOutput: mocks.resolveChildRunOutput,
  getRunRecords: mocks.getRunRecords,
}));

vi.mock('@utils/files/runStorageFs', () => ({
  runStorageLocationFromAnyAbsolutePath:
    mocks.runStorageLocationFromAnyAbsolutePath,
}));

vi.mock('@tools/delegation/inputFields', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tools/delegation/inputFields')>()),
  rejectOversizedBibAttachments: mocks.rejectOversizedBibAttachments,
}));

vi.mock('@utils/files/workspaceFS', () => ({
  WorkspaceFS: {
    toAbsolute: mocks.workspaceToAbsolute,
    exists: mocks.workspaceExists,
  },
}));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  realpath: mocks.realpath,
}));
vi.mock('@utils/files/absoluteFS', () => ({
  AbsoluteFS: { readBytes: mocks.absoluteReadBytes },
}));

const parentRunId = 'aaaaaa111111' as RunId;
// The detached workflow-run's own identity — grandchild agent() calls re-root
// here, not on the orchestrator (#8712).
const runId = 'run0run0run0' as RunId;
const run = { runId };
const defaultAgent = {
  name: 'correct',
  source: 'builtInWorkflow',
  category: 'workflow',
  path: '/agents/correct.yml',
} as AgentEntry;
// No usage recorded, so this run's terminal cost is zero.
const result: RunEnd = {
  outcome: 'completed',
  output: {
    category: 'workflow',
    outputs: [
      {
        round: 0,
        relativePath: 'r0/draft.tex',
        absolutePath: storagePath(
          'executions',
          'bbbbbb222222',
          'r0',
          'draft.tex',
        ),
        location: 'runStorage',
        originalPath: workspacePath('draft.tex'),
        added: 1,
        removed: 0,
      },
    ],
    compileFailures: [],
    diffs: [],
  },
};

/** Run totals carrying the spend an assertion reads. */
function spent(totalCost: number): RunEnd['usage'] {
  return RunUsageTotalsSchema.parse({ totalCost });
}
// A completed tool-use result carrying a structured value, as a schema call
// resolves once the agent submits output.
const structuredResult: RunEnd = {
  outcome: 'completed',
  output: {
    category: 'toolUse',
    response: '',
    files: [],
    structured: { title: 'Lemma 1' },
  },
};

// The in-process half of the fence, real: a case makes a run live here by
// taking its lane, exactly as a launch or a resume of that run would. One
// registry stub for every stub session, so sessions compare equal.
let lanes = new RunLanes();
const runs = {
  holdInactiveRun: (runId: RunId) => lanes.holdInactive(runId, () => false),
};

function parentContext(): DelegationParent {
  // The probe fences an interrupted attempt on its run lane and its run claim
  // before it may advance past it, so the stub session answers both.
  const session = {
    id: 'session',
    acquireClaims: mocks.acquireClaims,
    runs,
  } as never;
  return {
    config: new FakeConfigProvider(),
    model: 'parent-model',
    tracker: new FileInteractionState(),
    workingDirectory: WORKSPACE_PATH,
    delegationAgentScope: {
      workflow: ['builtInWorkflow:correct'],
      toolUse: ['builtInToolUse:assistant'],
    },
    run: {
      runId: parentRunId,
      session,
      toolPolicy: {
        approvalPromptsUnavailable: true,
        runtimeUnavailableTools: ['user_question'],
      },
    },
    inScope: (operation) => operation(),
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
    report: vi.fn(),
  };
}

interface InBandRunOptions {
  runId: string;
  prepare: () => Effect.Effect<unknown, Error>;
}

/** The child aggregate a probed attempt id reads back, in probe order. */
interface ProbedChild {
  readonly exists: boolean;
  readonly runEnd?: RunEnd;
  readonly resultMeta?: { readonly producer: string; readonly output: unknown };
}

/** Answer the attempt probe with one child aggregate per attempt, in order. */
function probeAnswers(...children: ProbedChild[]): void {
  mocks.getRunRecords.mockImplementation((_session: unknown, id: string) => {
    const child = children[mocks.probedRunIds.length] ?? { exists: false };
    mocks.probedRunIds.push(id);
    return {
      exists: () => Effect.succeed(child.exists),
      // No probed id here is deleted: a tombstone closes an id for good, and
      // the probe reads that apart from an id that never started.
      isRemoved: () => Effect.succeed(false),
      readRunEnd: () => Effect.succeed(child.runEnd ?? null),
      readResultMeta: () => Effect.succeed(child.resultMeta ?? null),
    };
  });
}

/** The merged attempt-facts channel the runner reports every fact through. */
type AttemptFacts = Parameters<WorkflowAgentInvocation['report']>[0];

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

// In-band launch that runs the child's prepare step and records the options it
// produced, under the run id the caller derived, as the real executor does.
function inBandRunReturning(finalResult: RunEnd) {
  return (options: InBandRunOptions) =>
    Effect.gen(function* () {
      mocks.preparedOptions.push(yield* options.prepare());
      return { runId: options.runId, result: finalResult };
    });
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
    lanes = new RunLanes();
    mocks.preparedOptions.length = 0;
    mocks.probedRunIds.length = 0;
    probeAnswers();
    // Nothing alive owns a probed run unless a case says so: the claim is the
    // liveness authority, and a dead owner is what lets the probe advance.
    mocks.resolveRunLiveness.mockReturnValue(
      Effect.succeed({ kind: 'interrupted' }),
    );
    // Nothing holds a probed run's claim unless a case says so: the fence
    // hands back the release the call's scope runs.
    mocks.acquireClaims.mockReturnValue(Effect.succeed(Effect.void));
    // No attempt journaled yet: the probe starts at 0 unless a case says the
    // parent already launched further.
    mocks.readWorkflowCallAttempt.mockReturnValue(Effect.succeed(0));
    mocks.recordWorkflowCallAttempt.mockReturnValue(Effect.void);
    mocks.requireVisibleAgent.mockImplementation((_category, name) => ({
      name,
      source: 'builtInWorkflow',
      category: 'workflow',
      path: `/agents/${name}.yml`,
    }));
    mocks.selectAvailableDelegationModel.mockReturnValue(
      Effect.succeed('child-model'),
    );
    mocks.workspaceExists.mockResolvedValue(true);
    mocks.rejectOversizedBibAttachments.mockResolvedValue(null);
    mocks.runStorageLocationFromAnyAbsolutePath.mockReturnValue(undefined);
    mocks.workspaceToAbsolute.mockImplementation((file: string) =>
      path.resolve(WORKSPACE_PATH, file),
    );
    mocks.realpath.mockImplementation(async (file: string) => file);
    mocks.absoluteReadBytes.mockResolvedValue(Buffer.from('run bytes'));
    mocks.executeSubagentInBand.mockImplementation(inBandRunReturning(result));
  });

  it.effect('fingerprints file bytes rather than only their paths', () =>
    Effect.gen(function* () {
      const options = { inputFiles: ['proof.tex'] };
      mocks.absoluteReadBytes.mockResolvedValueOnce(Buffer.from('old proof'));
      const oldFingerprint = yield* fingerprintWorkflowAgentDependencies(
        runId,
        options,
      );
      mocks.absoluteReadBytes.mockResolvedValueOnce(Buffer.from('new proof'));
      const newFingerprint = yield* fingerprintWorkflowAgentDependencies(
        runId,
        options,
      );

      expect(oldFingerprint).not.toBe(newFingerprint);
      expect(mocks.absoluteReadBytes).toHaveBeenCalledWith(
        workspacePath('proof.tex'),
      );
    }),
  );

  it.effect.each([
    'absolute',
    'relative traversal',
    'workspace symlink',
  ] as const)(
    'rejects a private storage file supplied through %s before reading dependencies',
    (spelling) =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* Effect.tryPromise({
            try: () => fs.mkdtemp(path.join(os.tmpdir(), 'texra-inputs-')),
            catch: ensureError,
          });
          const workspace = path.join(root, 'workspace');
          const storage = path.join(root, 'storage');
          const privateFile = path.join(storage, 'streamLogs/private.json');
          const link = path.join(workspace, 'input.json');
          const storagePath = vi
            .spyOn(StorageFS, 'fullPath')
            .mockImplementation((file: string) => path.join(storage, file));
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              storagePath.mockRestore();
              await fs.rm(root, { recursive: true, force: true });
            }),
          );
          yield* Effect.tryPromise({
            try: () => fs.mkdir(workspace),
            catch: ensureError,
          });
          yield* Effect.tryPromise({
            try: () => fs.mkdir(path.dirname(privateFile), { recursive: true }),
            catch: ensureError,
          });
          yield* Effect.tryPromise({
            try: () => fs.writeFile(privateFile, 'private transcript'),
            catch: ensureError,
          });
          yield* Effect.tryPromise({
            try: () => fs.symlink(privateFile, link),
            catch: ensureError,
          });
          mocks.realpath.mockImplementation((file: string) =>
            fs.realpath(file),
          );
          mocks.workspaceToAbsolute.mockImplementation((file: string) =>
            path.resolve(workspace, file),
          );
          const spellings = {
            absolute: privateFile,
            'relative traversal': path.relative(workspace, privateFile),
            'workspace symlink': 'input.json',
          };
          const file = spellings[spelling];

          const error = yield* Effect.flip(
            fingerprintWorkflowAgentDependencies(runId, {
              inputFiles: [file],
            }),
          );
          expect(error).toMatchObject({
            name: 'WorkflowRunAbortError',
            message: expect.stringContaining(file),
          });
          expect(mocks.workspaceExists).not.toHaveBeenCalled();
          expect(mocks.absoluteReadBytes).not.toHaveBeenCalled();
        }),
      ),
  );

  it.effect(
    'keeps the requested workspace symlink name in the launched inputs',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* Effect.tryPromise({
            try: () => fs.mkdtemp(path.join(os.tmpdir(), 'texra-inputs-')),
            catch: ensureError,
          });
          const workspace = path.join(root, 'workspace');
          const storage = path.join(root, 'storage');
          const target = path.join(workspace, 'versions/v1.tex');
          const requested = path.join(workspace, 'chapters/current.tex');
          const storagePath = vi
            .spyOn(StorageFS, 'fullPath')
            .mockImplementation((file: string) => path.join(storage, file));
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              storagePath.mockRestore();
              await fs.rm(root, { recursive: true, force: true });
            }),
          );
          yield* Effect.tryPromise({
            try: () => fs.mkdir(storage),
            catch: ensureError,
          });
          yield* Effect.tryPromise({
            try: () => fs.mkdir(path.dirname(target), { recursive: true }),
            catch: ensureError,
          });
          yield* Effect.tryPromise({
            try: () => fs.mkdir(path.dirname(requested), { recursive: true }),
            catch: ensureError,
          });
          yield* Effect.tryPromise({
            try: () => fs.writeFile(target, 'Current chapter'),
            catch: ensureError,
          });
          yield* Effect.tryPromise({
            try: () => fs.symlink(target, requested),
            catch: ensureError,
          });
          mocks.realpath.mockImplementation((file: string) =>
            fs.realpath(file),
          );
          mocks.workspaceToAbsolute.mockImplementation((file: string) =>
            path.resolve(workspace, file),
          );

          yield* defaultRunner()(
            invocation({ inputFiles: ['chapters/current.tex'] }),
          );

          expect(mocks.preparedOptions[0]).toEqual(
            expect.objectContaining({
              configPayload: expect.objectContaining({
                inputFiles: ['chapters/current.tex'],
              }),
            }),
          );
          expect(mocks.resolveChildRunOutput).not.toHaveBeenCalled();
        }),
      ),
  );

  it.effect('uses delegation policy and executes a direct in-band child', () =>
    Effect.gen(function* () {
      const call = invocation({
        inputFiles: ['paper.tex'],
        contextFiles: ['notes.tex'],
        mediaFiles: ['figure.pdf'],
        label: 'Draft paper',
      });
      const report = reportSpy();
      call.report = report;
      mocks.executeSubagentInBand.mockImplementationOnce((options) =>
        Effect.gen(function* () {
          const prepared = yield* options.prepare();
          mocks.preparedOptions.push(prepared);
          expect(reported(report, 'childRunId')).toEqual([options.runId]);
          prepared.onRunResolved?.(options.runId);
          return { runId: options.runId, result };
        }),
      );
      const runner = defaultRunner();

      expect(yield* runner(call)).toBe(result);
      expect(mocks.requireVisibleAgent).not.toHaveBeenCalled();
      expect(mocks.workspaceExists).toHaveBeenCalledWith(
        workspacePath('paper.tex'),
      );
      expect(mocks.workspaceExists).toHaveBeenCalledWith(
        workspacePath('notes.tex'),
      );
      expect(mocks.rejectOversizedBibAttachments).toHaveBeenCalledWith([
        'notes.tex',
      ]);
      expect(mocks.workspaceExists).toHaveBeenCalledWith(
        workspacePath('figure.pdf'),
      );
      expect(mocks.selectAvailableDelegationModel).toHaveBeenCalledWith({
        parentModel: 'parent-model',
        withScope: expect.any(Function),
      });
      expect(mocks.executeSubagentInBand).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: expect.stringMatching(/^[a-f0-9]{24}$/),
          parentRunId: runId,
          signal: call.signal,
          prepare: expect.any(Function),
        }),
      );
      expect(mocks.preparedOptions[0]).toEqual(
        expect.objectContaining({
          agentName: 'correct',
          parentRunId: runId,
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
            workingDirectory: WORKSPACE_PATH,
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
      expect(reported(report, 'childRunId')).toEqual([
        expect.stringMatching(/^[a-f0-9]{24}$/),
      ]);
      expect(reported(report, 'costUsd')).toEqual([0]);
    }),
  );

  it.effect('treats missing workspace files as run-fatal configuration', () =>
    Effect.gen(function* () {
      mocks.workspaceExists.mockResolvedValueOnce(false);
      const runner = defaultRunner();

      const error = yield* Effect.flip(
        runner(invocation({ inputFiles: ['absent.tex'] })),
      );
      expect(error).toMatchObject({
        name: 'WorkflowRunAbortError',
        message: expect.stringContaining('absent.tex'),
      });
      expect(mocks.preparedOptions).toHaveLength(0);
    }),
  );

  it.effect('fails the workflow when a declared model is unavailable', () =>
    Effect.gen(function* () {
      mocks.selectAvailableDelegationModel.mockReturnValueOnce(
        Effect.fail(
          new Error('Model "missing-model" is not currently available.'),
        ),
      );
      mocks.workspaceExists.mockResolvedValue(false);
      const runner = defaultRunner();

      const error = yield* Effect.flip(
        runner(
          invocation({
            model: 'missing-model',
            inputFiles: ['paper.tex'],
          }),
        ),
      );
      expect(error).toMatchObject({
        name: 'WorkflowRunAbortError',
        message: expect.stringContaining('missing-model'),
      });
      expect(mocks.workspaceExists).not.toHaveBeenCalled();
    }),
  );

  it.effect('preserves delegation failures when no model is declared', () =>
    Effect.gen(function* () {
      const selectionError = new Error('No delegation models are available.');
      mocks.selectAvailableDelegationModel.mockReturnValueOnce(
        Effect.fail(selectionError),
      );
      const runner = defaultRunner();

      const error = yield* Effect.flip(
        runner(invocation({ inputFiles: ['paper.tex'] })),
      );
      expect(error).toBe(selectionError);
    }),
  );

  it.effect('honors an explicit agent and binds verified run outputs', () =>
    Effect.gen(function* () {
      const firstRequested = storagePath(
        'executions',
        'bbbbbb222222',
        'r1',
        'introduction.tex',
      );
      const firstCanonical = canonicalPath(
        'executions',
        'bbbbbb222222',
        'r1',
        'introduction.tex',
      );
      const secondRequested = storagePath(
        'executions',
        'cccccc333333',
        'r1',
        'conclusion.tex',
      );
      const secondCanonical = canonicalPath(
        'executions',
        'cccccc333333',
        'r1',
        'conclusion.tex',
      );
      mocks.runStorageLocationFromAnyAbsolutePath.mockImplementation((file) =>
        file === firstRequested || file === secondRequested
          ? { kind: 'runStorage' }
          : undefined,
      );
      mocks.resolveChildRunOutput.mockImplementation((_parentRunId, file) =>
        Effect.succeed({
          kind: 'runStorage',
          absolutePath:
            file === firstRequested ? firstCanonical : secondCanonical,
          relativePath:
            file === firstRequested
              ? 'r1/introduction.tex'
              : 'r1/conclusion.tex',
          runId: file === firstRequested ? 'bbbbbb222222' : 'cccccc333333',
        }),
      );
      mocks.realpath.mockImplementation(async (file: string) => {
        if (file === firstRequested) return firstCanonical;
        if (file === secondRequested) return secondCanonical;
        return file;
      });
      const runner = defaultRunner();

      yield* runner(
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
        runId,
        firstRequested,
        parentContext().run.session,
      );
      expect(mocks.resolveChildRunOutput).toHaveBeenNthCalledWith(
        2,
        runId,
        secondRequested,
        parentContext().run.session,
      );
      expect(mocks.workspaceExists).toHaveBeenCalledWith(
        workspacePath('notes.tex'),
      );
      expect(mocks.preparedOptions[0]).toEqual(
        expect.objectContaining({
          agentName: 'merge',
          configPayload: expect.objectContaining({
            inputFiles: [firstCanonical, 'notes.tex', secondCanonical],
          }),
        }),
      );
    }),
  );

  it.effect('rejects a run-storage input that no longer resolves', () =>
    Effect.gen(function* () {
      const placeholder = storagePath(
        'executions',
        'bbbbbb222222',
        'r1',
        'unchanged.tex',
      );
      mocks.runStorageLocationFromAnyAbsolutePath.mockReturnValue({
        kind: 'runStorage',
      });
      mocks.resolveChildRunOutput.mockReturnValue(Effect.succeed(undefined));
      const runner = defaultRunner();

      const error = yield* Effect.flip(
        runner(invocation({ inputFiles: [placeholder] })),
      );
      expect(error).toMatchObject({
        name: 'WorkflowRunAbortError',
        message: expect.stringContaining(placeholder),
      });
      expect(mocks.preparedOptions).toHaveLength(0);
    }),
  );

  it.effect(
    'makes oversized bibliography context run-fatal before launch',
    () =>
      Effect.gen(function* () {
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

        const error = yield* Effect.flip(
          runner(
            invocation({
              inputFiles: ['draft.tex'],
              contextFiles: ['large.bib'],
            }),
          ),
        );
        expect(error).toMatchObject({
          name: 'WorkflowRunAbortError',
          message,
        });
        expect(mocks.preparedOptions).toHaveLength(0);
      }),
  );

  it.effect('makes storage resolver failures run-fatal', () =>
    Effect.gen(function* () {
      const placeholder = storagePath(
        'executions',
        'bbbbbb222222',
        'r1',
        'deleted.tex',
      );
      const storageError = new Error(
        'Declared output r1/deleted.tex is missing from run bbbbbb222222.',
      );
      mocks.runStorageLocationFromAnyAbsolutePath.mockReturnValue({
        kind: 'runStorage',
      });
      mocks.resolveChildRunOutput.mockReturnValue(Effect.fail(storageError));
      const runner = defaultRunner();

      const error = yield* Effect.flip(
        runner(invocation({ inputFiles: [placeholder] })),
      );
      expect(error).toMatchObject({
        name: 'WorkflowRunAbortError',
        message: expect.stringContaining(storageError.message),
        cause: storageError,
      });
      expect(mocks.preparedOptions).toHaveLength(0);
    }),
  );

  it.effect(
    'rejects mixed inputs when any run-storage input no longer resolves',
    () =>
      Effect.gen(function* () {
        const resolved = storagePath(
          'executions',
          'bbbbbb222222',
          'r1',
          'draft.tex',
        );
        const stale = storagePath(
          'executions',
          'cccccc333333',
          'r1',
          'review.tex',
        );
        mocks.runStorageLocationFromAnyAbsolutePath.mockImplementation(
          (file) =>
            file === resolved || file === stale
              ? { kind: 'runStorage' }
              : undefined,
        );
        mocks.resolveChildRunOutput.mockImplementation((_parent, file) =>
          Effect.succeed(
            file === resolved
              ? {
                  kind: 'runStorage',
                  absolutePath: canonicalPath(
                    'executions',
                    'bbbbbb222222',
                    'r1',
                    'draft.tex',
                  ),
                  relativePath: 'r1/draft.tex',
                  runId: 'bbbbbb222222',
                }
              : undefined,
          ),
        );
        const runner = defaultRunner();

        const error = yield* Effect.flip(
          runner(invocation({ inputFiles: ['notes.tex', resolved, stale] })),
        );
        expect(error).toMatchObject({
          name: 'WorkflowRunAbortError',
          message: expect.stringContaining(stale),
        });
        expect(mocks.preparedOptions).toHaveLength(0);
      }),
  );

  it.effect(
    'links child approval ancestry to the parent stream on resolve',
    () =>
      Effect.gen(function* () {
        const runner = defaultRunner();

        yield* runner(invocation());

        const prepared = mocks.preparedOptions[0] as {
          onRunResolved?: (runId: RunId) => void;
        };
        expect(prepared.onRunResolved).toEqual(expect.any(Function));
        prepared.onRunResolved?.('stream:child' as RunId);
        expect(mocks.configureDelegatedChildApprovals).toHaveBeenCalledWith(
          'stream:child',
          runId,
          'inherit',
          expect.objectContaining({ id: 'session' }),
        );
      }),
  );

  it.effect(
    'reports live child cost with its workflow invocation identity',
    () =>
      Effect.gen(function* () {
        const onCost = vi.fn();
        const report = reportSpy();
        mocks.executeSubagentInBand.mockImplementationOnce((options) =>
          Effect.gen(function* () {
            const prepared = yield* options.prepare();
            prepared.onCost?.(0.25);
            return { runId: options.runId, result };
          }),
        );
        const runner = defaultRunner({ onCost });
        const call = { ...invocation(), report };

        yield* runner(call);

        expect(onCost).toHaveBeenCalledWith(call, 0.25);
        // Progressive onCost stamps the live snapshot attempt (not only success),
        // and the terminal result cost is stamped after it (same value here).
        expect(reported(report, 'costUsd')).toEqual([0.25, 0]);
      }),
  );

  it.effect('stamps terminal cost on failed outcomes before throwing', () =>
    Effect.gen(function* () {
      const report = reportSpy();
      mocks.executeSubagentInBand.mockImplementationOnce((options) =>
        Effect.gen(function* () {
          yield* options.prepare();
          return {
            runId: options.runId,
            result: {
              ...result,
              outcome: 'failed',
              usage: spent(0.42),
            },
          };
        }),
      );
      const runner = defaultRunner();

      const error = yield* Effect.flip(runner({ ...invocation(), report }));
      expect(error.message).toMatch(/ended with failed outcome/);
      expect(reported(report, 'costUsd')).toEqual([0.42]);
    }),
  );

  it.effect(
    'recovers a completed child without charging it as a live run',
    () =>
      // Owner ruling 2026-09-13: a COMPLETED `run.end` with a
      // `producer: 'subagent'` manifest is durable completion on its own, with
      // no parent-owned attestation to corroborate it.
      Effect.gen(function* () {
        const onCost = vi.fn();
        const report = reportSpy();
        probeAnswers({
          exists: true,
          runEnd: { ...result, usage: spent(0.25) },
          resultMeta: { producer: 'subagent', output: result.output },
        });
        const runner = defaultRunner({ onCost });

        yield* runner({ ...invocation(), index: 3, report });

        expect(mocks.executeSubagentInBand).not.toHaveBeenCalled();
        expect(onCost).not.toHaveBeenCalled();
        // Recovery never launched, so re-attach the recovered child's own id,
        // but do not charge the synthetic resume attempt.
        expect(reported(report, 'childRunId')).toEqual([mocks.probedRunIds[0]]);
        expect(reported(report, 'recovered')).toEqual([true]);
        expect(reported(report, 'costUsd')).toEqual([]);
      }),
  );

  it.effect('rejects a tool-use default agent used as a workflow agent', () =>
    Effect.gen(function* () {
      const runner = createWorkflowScriptAgentRunner(
        parentContext(),
        { ...defaultAgent, category: 'toolUse', source: 'builtInToolUse' },
        'tool-call-8',
        run,
      );

      const error = yield* Effect.flip(runner(invocation({})));
      expect(error).toMatchObject({
        name: 'WorkflowRunAbortError',
        message: expect.stringMatching(
          /is a toolUse agent but was launched as workflow/,
        ),
      });
    }),
  );

  it.effect('derives one child id per workflow call identity', () =>
    Effect.gen(function* () {
      const runner = defaultRunner();

      yield* runner(invocation());
      yield* runner(invocation());
      yield* runner({ ...invocation(), index: 1 });
      yield* runner({ ...invocation(), key: 'fedcba9876543210' });

      const runIds = mocks.executeSubagentInBand.mock.calls.map(
        ([options]) => options.runId,
      );
      expect(runIds[0]).toBe(runIds[1]);
      expect(runIds[2]).toBe(runIds[0]);
      expect(runIds[3]).not.toBe(runIds[0]);
    }),
  );

  it.effect(
    'rejects a cancelled child so the workflow journal can retry it',
    () =>
      Effect.gen(function* () {
        mocks.executeSubagentInBand.mockReturnValueOnce(
          Effect.succeed({
            runId: 'bbbbbb222222',
            result: {
              outcome: 'cancelled',
              output: { category: 'toolUse', response: '', files: [] },
            },
          }),
        );
        const runner = defaultRunner();

        const error = yield* Effect.flip(runner(invocation()));
        expect(error.message).toContain(
          'Workflow subagent ended with cancelled outcome.',
        );
      }),
  );

  it.effect(
    'rejects a completed workflow child that produced no output files',
    () =>
      Effect.gen(function* () {
        mocks.executeSubagentInBand.mockReturnValueOnce(
          Effect.succeed({
            runId: 'bbbbbb222222',
            result: { ...result, output: { ...result.output, outputs: [] } },
          }),
        );
        const runner = defaultRunner();

        const error = yield* Effect.flip(runner(invocation()));
        expect(error.message).toContain(
          'Workflow subagent completed without producing any output files.',
        );
      }),
  );

  it.effect('turns manifest-write failures into fatal workflow aborts', () =>
    Effect.gen(function* () {
      const durabilityError = new SubagentDurabilityError(
        'result manifest unavailable',
        { cause: new Error('storage offline') },
      );
      mocks.executeSubagentInBand.mockReturnValueOnce(
        Effect.fail(durabilityError),
      );
      const runner = defaultRunner();

      const error = yield* Effect.flip(runner(invocation()));
      expect(error).toMatchObject({
        name: 'WorkflowRunAbortError',
        message: 'result manifest unavailable',
        cause: durabilityError,
      });
    }),
  );

  it.effect.each([
    {
      cause: Cause.interrupt(),
      name: 'an interrupt',
      hasDurabilityError: false,
    },
    {
      cause: Cause.fromReasons([
        Cause.makeInterruptReason(),
        Cause.makeFailReason(
          new SubagentDurabilityError('result manifest unavailable'),
        ),
      ]),
      name: 'an interrupt with a durability failure',
      hasDurabilityError: true,
    },
  ])(
    'preserves $name from the in-band child',
    ({ cause, hasDurabilityError }) =>
      Effect.gen(function* () {
        mocks.executeSubagentInBand.mockReturnValueOnce(
          Effect.failCause(cause),
        );

        const exit = yield* Effect.exit(defaultRunner()(invocation()));

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterrupts(exit.cause)).toBe(true);
          const failure = exit.cause.reasons.find(Cause.isFailReason)?.error;
          if (hasDurabilityError) {
            expect(failure).toMatchObject({
              name: 'WorkflowRunAbortError',
              message: 'result manifest unavailable',
              cause: { name: 'SubagentDurabilityError' },
            });
          } else {
            expect(failure).toBeUndefined();
          }
        }
      }),
  );

  it.effect('refuses to repeat a child a live owner still holds', () =>
    Effect.gen(function* () {
      probeAnswers({ exists: true });
      mocks.resolveRunLiveness.mockReturnValueOnce(
        Effect.succeed({
          kind: 'unsettled',
          reason: 'held by another TeXRA process (pid 42 on studio)',
        }),
      );

      const error = yield* Effect.flip(defaultRunner()(invocation()));

      expect(error).toMatchObject({
        name: 'WorkflowRunAbortError',
        message: expect.stringContaining(
          'held by another TeXRA process (pid 42 on studio); refusing to repeat it',
        ),
      });
      expect(mocks.executeSubagentInBand).not.toHaveBeenCalled();
    }),
  );

  it.effect('launches the next attempt id after a failed child', () =>
    Effect.gen(function* () {
      // The logical call identity is a journal key, never a run id: each
      // attempt derives its own, and the one the runner launches is the id its
      // child stream and roster expose, so a host's skip/retry finds the row.
      probeAnswers(
        { exists: true, runEnd: { ...result, outcome: 'failed' } },
        { exists: false },
      );
      const report = reportSpy();
      const runner = defaultRunner();

      expect(yield* runner({ ...invocation(), report })).toBe(result);

      expect(mocks.probedRunIds).toHaveLength(2);
      expect(mocks.probedRunIds[0]).toMatch(/^[a-f0-9]{24}$/);
      expect(mocks.probedRunIds[1]).not.toBe(mocks.probedRunIds[0]);
      expect(reported(report, 'childRunId')).toEqual([mocks.probedRunIds[1]]);
      // The parent journals the attempt it is about to launch, before it
      // launches: that mark is what a resume probes from once the child
      // aggregates behind it are deleted and collected.
      expect(mocks.recordWorkflowCallAttempt).toHaveBeenCalledWith(
        expect.anything(),
        'tool-call-7',
        '0123456789abcdef',
        1,
      );
      expect(
        mocks.recordWorkflowCallAttempt.mock.invocationCallOrder[0],
      ).toBeLessThan(
        mocks.executeSubagentInBand.mock.invocationCallOrder[0] ?? 0,
      );
    }),
  );

  it.effect('probes from the attempt the parent journaled', () =>
    Effect.gen(function* () {
      // Attempt 0 was deleted and its tombstone collected, so nothing of it
      // reads back: without the parent's mark the probe would launch into that
      // hole and never reach the attempt that answered the call.
      mocks.readWorkflowCallAttempt.mockReturnValue(Effect.succeed(1));
      probeAnswers({
        exists: true,
        runEnd: result,
        resultMeta: { producer: 'subagent', output: result.output },
      });
      const report = reportSpy();

      yield* defaultRunner()({ ...invocation(), report });

      expect(mocks.probedRunIds).toEqual([
        deriveRunId({
          attempt: 1,
          checkpointId: 'tool-call-7',
          key: '0123456789abcdef',
          parentRunId: runId,
        }),
      ]);
      expect(mocks.executeSubagentInBand).not.toHaveBeenCalled();
      expect(reported(report, 'recovered')).toEqual([true]);
    }),
  );

  it.effect('recovers a child that ended while the probe was reading it', () =>
    Effect.gen(function* () {
      // The child committed `run.end` and released its claim between the
      // terminal read and the claim observation: the first copy is stale, the
      // claim reads free, and only re-reading the row keeps the finished run
      // from being repeated.
      let terminalReads = 0;
      mocks.getRunRecords.mockImplementation(
        (_session: unknown, id: string) => {
          mocks.probedRunIds.push(id);
          return {
            exists: () => Effect.succeed(true),
            isRemoved: () => Effect.succeed(false),
            readRunEnd: () =>
              Effect.succeed(terminalReads++ === 0 ? null : result),
            readResultMeta: () =>
              Effect.succeed({ producer: 'subagent', output: result.output }),
          };
        },
      );
      const report = reportSpy();

      yield* defaultRunner()({ ...invocation(), report });

      expect(mocks.probedRunIds).toHaveLength(1);
      expect(mocks.executeSubagentInBand).not.toHaveBeenCalled();
      expect(reported(report, 'recovered')).toEqual([true]);
    }),
  );

  it.effect(
    'refuses an interrupted child whose claim a concurrent resume holds',
    () =>
      Effect.gen(function* () {
        // A free lease only says nobody owned the run when it was read. The
        // claim is what the resume takes, so an acquire it refuses is the
        // fact that a new owner is starting this child right now.
        probeAnswers({ exists: true }, { exists: false });
        mocks.acquireClaims.mockReturnValueOnce(
          Effect.fail(new Error('held by owner-2 (alive)')),
        );

        const error = yield* Effect.flip(defaultRunner()(invocation()));

        expect(error).toMatchObject({
          name: 'WorkflowRunAbortError',
          message: expect.stringContaining(
            'could not be claimed against a concurrent resume',
          ),
        });
        expect(mocks.executeSubagentInBand).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    'refuses a failed child whose claim a concurrent resume holds',
    () =>
      Effect.gen(function* () {
        // A terminal row does not close the aggregate: a resume can append
        // `run.activate` after it, so advancing past a failed attempt takes the
        // same claim as advancing past an interrupted one, and an acquire the
        // resume refuses stops a second child from starting beside it.
        probeAnswers(
          { exists: true, runEnd: { ...result, outcome: 'failed' } },
          { exists: false },
        );
        mocks.acquireClaims.mockReturnValueOnce(
          Effect.fail(new Error('held by owner-2 (alive)')),
        );

        const error = yield* Effect.flip(defaultRunner()(invocation()));

        expect(error).toMatchObject({
          name: 'WorkflowRunAbortError',
          message: expect.stringContaining(
            'could not be claimed against a concurrent resume',
          ),
        });
        expect(mocks.executeSubagentInBand).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    'refuses a completed child whose claim a concurrent resume holds',
    () =>
      Effect.gen(function* () {
        // A completed row is resumable too: a snapshot outlives it, so a
        // resume can be replaying this child right now and the recorded
        // result is stale. Recovering it takes the same claim as advancing
        // past a failed attempt, and an acquire the resume refuses stops the
        // parent journaling a result beside a child still running.
        probeAnswers({
          exists: true,
          runEnd: result,
          resultMeta: { producer: 'subagent', output: result.output },
        });
        mocks.acquireClaims.mockReturnValueOnce(
          Effect.fail(new Error('held by owner-2 (alive)')),
        );

        const error = yield* Effect.flip(defaultRunner()(invocation()));

        expect(error).toMatchObject({
          name: 'WorkflowRunAbortError',
          message: expect.stringContaining(
            'could not be claimed against a concurrent resume',
          ),
        });
        expect(mocks.executeSubagentInBand).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    'refuses an interrupted child whose lane a same-session resume holds',
    () =>
      Effect.gen(function* () {
        // The claim cannot see a resume started here: it is keyed by owner,
        // and a row this owner already holds is reclaimable. The run lane is
        // the authority that does see it.
        probeAnswers({ exists: true }, { exists: false });
        const resumed = deriveRunId({
          attempt: 0,
          checkpointId: 'tool-call-7',
          key: '0123456789abcdef',
          parentRunId: runId,
        });
        const holding = yield* Deferred.make<void>();
        yield* Effect.forkScoped(
          lanes.launch(
            resumed,
            Deferred.succeed(holding, undefined).pipe(
              Effect.andThen(Effect.never),
            ),
          ),
        );
        yield* Deferred.await(holding);

        const error = yield* Effect.flip(defaultRunner()(invocation()));

        expect(error).toMatchObject({
          name: 'WorkflowRunAbortError',
          message: expect.stringContaining('is live in this session'),
        });
        expect(mocks.executeSubagentInBand).not.toHaveBeenCalled();
      }).pipe(Effect.scoped),
  );

  it.effect(
    'routes an agent({ schema }) call to a tool-use agent with an output schema',
    () =>
      Effect.gen(function* () {
        useToolUseAgentEntries();
        mocks.executeSubagentInBand.mockImplementationOnce(
          inBandRunReturning(structuredResult),
        );
        const schema = {
          type: 'object',
          properties: { title: { type: 'string' } },
          required: ['title'],
          additionalProperties: false,
        };
        const runner = defaultRunner();

        expect(
          yield* runner(invocation({ agentName: 'assistant', schema })),
        ).toBe(structuredResult);

        expect(mocks.requireVisibleAgent).toHaveBeenCalledWith(
          'toolUse',
          'assistant',
          expect.anything(),
        );
        expect(mocks.selectAvailableDelegationModel).toHaveBeenCalledWith({
          parentModel: 'parent-model',
          withScope: expect.any(Function),
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
        expect(mocks.workspaceExists).not.toHaveBeenCalled();
      }),
  );

  it.effect('exempts a schema call from the workflow empty-files guard', () =>
    Effect.gen(function* () {
      useToolUseAgentEntries();
      mocks.executeSubagentInBand.mockImplementationOnce(
        inBandRunReturning(structuredResult),
      );
      const schema = { type: 'object', additionalProperties: false };
      const runner = defaultRunner();

      // No input files and no default outputs: the workflow path aborts, but a
      // schema call runs a tool-use agent whose result is the submitted value.
      expect(
        yield* runner(invocation({ agentName: 'assistant', schema })),
      ).toBe(structuredResult);
      expect(mocks.preparedOptions[0]).toEqual(
        expect.objectContaining({
          configPayload: expect.objectContaining({ agentCategory: 'toolUse' }),
        }),
      );
    }),
  );
});
