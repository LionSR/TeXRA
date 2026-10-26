// Third-party imports
import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

const formatRetryRequestMessageMock = vi.hoisted(() => vi.fn());
let detachHostInteractions = (): void => {};

vi.mock('@cli/runtime/approval/approvalSummaries', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@cli/runtime/approval/approvalSummaries')
    >();
  return {
    ...actual,
    formatRetryRequestMessage: formatRetryRequestMessageMock,
  };
});

import { createHeadlessCliHostInteractions } from '@cli/runtime/approvalAdapter';
import type { CliContext } from '@cli/runtime/cliContext';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { runOutcomeExitCode } from '@cli/runtime/terminalStatus';
import {
  askApproval,
  type CliApprovalPromptHooks,
} from '@cli/runtime/approval/approvalPrompts';
import { buildToolEditApprovalContent } from '@cli/runtime/approval/approvalSummaries';
import {
  RUN_OUTCOME,
  type AgentProposalPermission,
  type PermissionPayload,
  type RequestDecision,
  type RetryPermission,
  type RunId,
} from '@shared/schemas';
import { testRuntime, testSessionOf } from '@test/support/testProcessRuntime';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import {
  publishTestRunStart,
  setTestApprovalPolicy,
} from '@test/support/sessionTestUtils';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { requestToolEditApproval } from '@tools/approval/toolEditApproval';
import { buildDiffHunks } from '@utils/text/unifiedDiff';

/** An edit's content with the diff its request carries. */
function editContent(originalContent: string, proposedContent: string) {
  return {
    originalContent,
    proposedContent,
    hunks: buildDiffHunks(originalContent, proposedContent).hunks,
    firstChangedLine: 0,
  };
}

function context(overrides: Partial<CliContext> = {}): CliContext {
  const ctx = createTestCliContext({
    cwd: '/tmp',
    mode: 'interactive',
    approvalPolicy: 'ask',
    version: 'test',
    ...overrides,
  });
  setTestApprovalPolicy(ctx.approvalPolicy);
  return ctx;
}

function stubStderrWrites() {
  return vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
}

function useCliHostInteractions(
  cliContext: CliContext,
  hooks: CliApprovalPromptHooks = {},
): void {
  detachHostInteractions();
  setTestApprovalPolicy(cliContext.approvalPolicy);
  detachHostInteractions = Effect.runSync(
    testDefaultSession().interactions.use(
      createHeadlessCliHostInteractions(
        testSessionOf(testDefaultSession()),
        testRuntime(),
        cliContext,
        hooks,
      ),
    ),
  );
}

const ROOT_RUN = 'a00001' as RunId;
/** The runs this file opens requests on; a request is a row on its run, so
 *  the run exists before the first one opens. */
const started = new Set<RunId>();

function ensureRun(runId: RunId) {
  return Effect.gen(function* () {
    if (started.has(runId)) return;
    started.add(runId);
    publishTestRunStart(testDefaultSession(), runId);
    yield* testDefaultSession().log.settled;
  });
}

function approvalLayer(runId: RunId) {
  return nativeToolTestLayer({
    workingDirectory: '/tmp',
    run: {
      runId,
      session: testDefaultSession(),
      toolPolicy: {},
    },
  });
}

function requestNewProofEdit() {
  return Effect.gen(function* () {
    yield* ensureRun(ROOT_RUN);
    return yield* requestToolEditApproval({
      path: '/tmp/new-proof.tex',
      originalContent: '',
      proposedContent: '\\section{Proof}\nA concise proof.\n',
      sourceTool: 'write_file',
      runId: ROOT_RUN,
    }).pipe(Effect.provide(approvalLayer(ROOT_RUN)));
  });
}

/**
 * Ask through the protocol the headless host answers: `request.opened` on the
 * run, then the `request.decided` the attached host commits (one run model,
 * 3.7). The host must already be attached with {@link useCliHostInteractions}.
 */
function openRequestOn(
  runId: RunId,
  payload: PermissionPayload,
): Effect.Effect<RequestDecision, Error> {
  return Effect.gen(function* () {
    const session = testDefaultSession();
    yield* ensureRun(runId);
    return yield* session.requests.ask(runId, payload);
  }).pipe(Effect.mapError((cause) => new Error(String(cause))));
}

function openRequest(
  payload: PermissionPayload,
): Effect.Effect<RequestDecision, Error> {
  return openRequestOn(ROOT_RUN, payload);
}

/** A request id is opened once per run (`runRows.ts`), and this file opens
 *  every one of them on the same long-lived session, so each fixture mints
 *  its own. */
let proposalOrdinal = 0;

function agentProposal(
  overrides: Partial<AgentProposalPermission> = {},
): AgentProposalPermission {
  const base = {
    requestId: `proposal-${(proposalOrdinal += 1)}`,
    runId: ROOT_RUN,
    agent: 'review',
    model: 'deepseek/deepseek-v4-flash',
    instruction: 'Please check this proof.',
    memories: [],
  };
  return {
    ...base,
    inputFiles: [],
    contextFiles: [],
    mediaFiles: [],
    outputFiles: [],
    task: false,
    options: {},
    ...overrides,
  };
}

/** Records before-prompt/prompt ordering for approval-prompt hook tests. */
function trackPromptEvents(): {
  events: string[];
  hooks: CliApprovalPromptHooks;
  answerWith: (answer: string) => () => Effect.Effect<string>;
} {
  const events: string[] = [];
  return {
    events,
    hooks: {
      prompting: () => {
        events.push('before');
        return () => {
          events.push('after');
        };
      },
    },
    answerWith: (answer) => () =>
      Effect.sync(() => {
        events.push('prompt');
        return answer;
      }),
  };
}

beforeEach(async () => {
  const actual = await vi.importActual<
    typeof import('@cli/runtime/approval/approvalSummaries')
  >('@cli/runtime/approval/approvalSummaries');
  formatRetryRequestMessageMock.mockImplementation(
    actual.formatRetryRequestMessage,
  );
});

afterEach(() => {
  detachHostInteractions();
  detachHostInteractions = () => {};
  formatRetryRequestMessageMock.mockReset();
  vi.restoreAllMocks();
});

describe('approval prompt hooks', () => {
  it.effect(
    'warns the operator of a shared edit-policy denial through the host',
    () =>
      Effect.gen(function* () {
        const ctx = context({ approvalPolicy: 'never', mode: 'headless' });
        useCliHostInteractions(ctx);
        const stderr = stubStderrWrites();

        const result = yield* requestNewProofEdit();
        // A policy refusal with nobody to ask is a denial, not a person's
        // rejection: the model reads the reason and routes around it.
        expect(result).toMatchObject({ action: 'deny' });
        expect(stderr).toHaveBeenCalledTimes(1);
        expect(String(stderr.mock.calls[0]?.[0])).toContain(
          'Command or edit denied',
        );
        // The model routes around the denial, so the run's exit code is untouched.
        expect(runOutcomeExitCode(RUN_OUTCOME.COMPLETED)).toBe(
          CliExitCode.Success,
        );
        expect(runOutcomeExitCode(RUN_OUTCOME.CANCELLED)).toBe(
          CliExitCode.Interrupted,
        );
      }),
  );

  it.effect(
    'denies a request still listed pending when the run has nobody to ask',
    () =>
      Effect.gen(function* () {
        // A request opened before the host changed is listed pending; a
        // prompt on a closed stdin would never settle it.
        const tracker = trackPromptEvents();
        useCliHostInteractions(
          context({
            mode: 'headless',
            approvalPrompt: tracker.answerWith('y'),
          }),
          tracker.hooks,
        );
        const result = yield* openRequest({
          kind: 'proposal',
          data: agentProposal(),
        });

        expect(result).toMatchObject({ action: 'deny' });
        expect(tracker.events).toEqual([]);
      }),
  );
});

describe('retry request classification (#7331)', () => {
  let retryOrdinal = 0;
  const retryRequest = (): RetryPermission => ({
    requestId: `headless-retry-${(retryOrdinal += 1)}`,
    runId: ROOT_RUN,
    operation: 'Model invocation',
    errorMessage: 'stream dropped before first token',
  });

  function requestHeadlessRetry(
    ctx: CliContext,
    overrides: Partial<RetryPermission> = {},
  ): Effect.Effect<RequestDecision, Error> {
    useCliHostInteractions(ctx);
    return openRequest({
      kind: 'retry',
      data: { ...retryRequest(), ...overrides },
    });
  }

  it.effect('cancels a retry the interactive user explicitly rejects', () =>
    Effect.gen(function* () {
      const result = yield* requestHeadlessRetry(
        context({ approvalPrompt: () => Effect.succeed('n not now') }),
      );

      // The operator's note rides the cancellation: a dismissed retry is
      // their call, and the reason they gave is the cause.
      expect(result).toEqual({ action: 'cancel', cause: 'not now' });
    }),
  );
});

describe('buildToolEditApprovalContent', () => {
  it.effect('passes one-line rejection feedback to the tool result', () =>
    Effect.gen(function* () {
      useCliHostInteractions(
        context({
          approvalPrompt: () => Effect.succeed('n proof misses the p = 5 case'),
        }),
      );

      const result = yield* requestNewProofEdit();

      expect(result).toMatchObject({
        action: 'reject',
        feedback: 'proof misses the p = 5 case',
      });
    }),
  );

  it.effect('preserves a failed edit prompt as an automatic cancellation', () =>
    Effect.gen(function* () {
      useCliHostInteractions(
        context({
          approvalPrompt: () => Effect.fail(new Error('terminal input closed')),
        }),
      );

      const result = yield* requestNewProofEdit();

      // A prompt that never reached a person closes the request as an
      // automatic cancellation, never as that person's rejection.
      expect(result).toEqual({
        action: 'cancel',
        cause: 'CLI approval prompt failed: terminal input closed',
      });
    }),
  );

  it.effect('removes terminal control sequences from complete content', () =>
    Effect.gen(function* () {
      const answers = ['v', 'y'];
      const stderrWrite = stubStderrWrites();

      yield* askApproval(
        context({
          approvalPrompt: () => Effect.sync(() => answers.shift() ?? ''),
        }),
        {
          summary: 'bounded preview',
          details: () => 'safe\u001b]0;unsafe\u0007\ntext',
        },
      );

      expect(stderrWrite).toHaveBeenCalledWith(
        'safe\ntext\n',
        expect.any(Function),
      );
    }),
  );

  it.effect('holds the prompt queue while complete content is viewed', () =>
    Effect.gen(function* () {
      const summaries: string[] = [];
      let firstPromptCount = 0;
      let resolveView!: (answer: string) => void;
      let resolveDecision!: (answer: string) => void;
      const viewAnswer = new Promise<string>((resolve) => {
        resolveView = resolve;
      });
      const decisionAnswer = new Promise<string>((resolve) => {
        resolveDecision = resolve;
      });
      const secondFirstPrompt = yield* Deferred.make<void>();
      stubStderrWrites();
      const cliContext = context({
        approvalPrompt: (request) => {
          summaries.push(request.summary);
          if (request.summary !== 'first') return Effect.succeed('y');
          firstPromptCount += 1;
          if (firstPromptCount === 1) return Effect.promise(() => viewAnswer);
          Deferred.doneUnsafe(secondFirstPrompt, Effect.void);
          return Effect.promise(() => decisionAnswer);
        },
      });

      const first = yield* Effect.forkChild(
        askApproval(cliContext, {
          summary: 'first',
          details: () => 'complete first proposal',
        }),
      );
      const second = yield* Effect.forkChild(
        askApproval(cliContext, { summary: 'second' }),
      );

      resolveView('v');
      yield* Deferred.await(secondFirstPrompt);
      expect(summaries).toEqual(['first', 'first']);

      resolveDecision('y');
      expect(yield* Fiber.join(first)).toEqual({ action: 'approve' });
      expect(yield* Fiber.join(second)).toEqual({ action: 'approve' });
      expect(summaries).toEqual(['first', 'first', 'second']);
    }),
  );

  it('bounds long diff lines before prompting', () => {
    const longLine = 'x'.repeat(1_000);
    const { summary, details } = buildToolEditApprovalContent({
      path: '/tmp/generated.json',
      ...editContent('', `${longLine}\n`),
      sourceTool: 'write_file',
    });

    expect(summary).toContain('[line truncated]');
    expect(summary).not.toContain(longLine);
    expect(summary.length).toBeLessThan(1_000);
    expect(details?.()).toContain(longLine);
  });

  it.effect('skips prompting for auto-approved edits', () =>
    Effect.gen(function* () {
      useCliHostInteractions(
        context({
          approvalPolicy: 'yolo',
          approvalPrompt: () =>
            Effect.die(new Error('approval prompt should not be called')),
        }),
      );

      yield* ensureRun(ROOT_RUN);
      const result = yield* requestToolEditApproval({
        path: '/tmp/auto-approved.tex',
        originalContent: '',
        proposedContent: '\\section{Auto-approved}\n',
        sourceTool: 'write_file',
        runId: ROOT_RUN,
      }).pipe(Effect.provide(approvalLayer(ROOT_RUN)));

      expect(result).toMatchObject({
        action: 'apply',
        appliedContent: '\\section{Auto-approved}\n',
      });
    }),
  );
});
