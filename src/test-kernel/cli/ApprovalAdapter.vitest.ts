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
import {
  buildAgentProposalApprovalContent,
  buildToolEditApprovalContent,
  formatRetryRequestMessage,
} from '@cli/runtime/approval/approvalSummaries';
import {
  AgentCategory,
  DEFAULT_TOOL_CONFIG,
  RUN_OUTCOME,
  type AgentProposalPermission,
  type PermissionPayload,
  type RequestDecision,
  type RetryPermission,
  type RunId,
} from '@shared/schemas';
import { testRuntime } from '@test/support/testProcessRuntime';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { requestToolEditApproval } from '@tools/approval/toolEditApproval';

function context(overrides: Partial<CliContext> = {}): CliContext {
  const ctx = createTestCliContext({
    cwd: '/tmp',
    mode: 'interactive',
    approvalPolicy: 'ask',
    version: 'test',
    ...overrides,
  });
  testDefaultSession().setApprovalPolicy(ctx.approvalPolicy);
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
  testDefaultSession().setApprovalPolicy(cliContext.approvalPolicy);
  detachHostInteractions = Effect.runSync(
    testDefaultSession().interactions.use(
      createHeadlessCliHostInteractions(
        testDefaultSession(),
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
    yield* testDefaultSession().settlePublications();
  });
}

function approvalLayer(runId: RunId, onApprovalPolicyDenial?: () => void) {
  return nativeToolTestLayer({
    workingDirectory: '/tmp',
    run: {
      runId,
      session: testDefaultSession(),
      toolPolicy: {},
      onApprovalPolicyDenial,
    },
  });
}

function requestNewProofEdit(onApprovalPolicyDenial?: () => void) {
  return Effect.gen(function* () {
    yield* ensureRun(ROOT_RUN);
    return yield* requestToolEditApproval({
      path: '/tmp/new-proof.tex',
      originalContent: '',
      proposedContent: '\\section{Proof}\nA concise proof.\n',
      sourceTool: 'write_file',
      runId: ROOT_RUN,
    }).pipe(Effect.provide(approvalLayer(ROOT_RUN, onApprovalPolicyDenial)));
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
    return yield* session.openRequest(runId, payload);
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
    model: 'deepseekT',
    instruction: 'Please check this proof.',
    memories: [],
  };
  const { agentCategory, ...rest } = overrides;
  if (agentCategory === AgentCategory.Workflow) {
    return {
      ...base,
      agentCategory,
      inputFiles: [],
      contextFiles: [],
      mediaFiles: [],
      outputFiles: [],
      toolConfig: DEFAULT_TOOL_CONFIG,
      ...rest,
    };
  }
  return {
    ...base,
    agentCategory: AgentCategory.ToolUse,
    ...rest,
  };
}

/** Records before-prompt/prompt ordering for approval-prompt hook tests. */
function trackPromptEvents(): {
  events: string[];
  hooks: CliApprovalPromptHooks;
  answerWith: (answer: string) => () => Promise<string>;
} {
  const events: string[] = [];
  return {
    events,
    hooks: {
      beforePrompt: () => {
        events.push('before');
      },
    },
    answerWith: (answer) => async () => {
      events.push('prompt');
      return answer;
    },
  };
}

const credentialExhaustedRetry: RetryPermission = {
  requestId: 'upstream-credit-retry',
  runId: 'test-stream' as RetryPermission['runId'],
  operation: 'Model request',
  errorMessage: 'HTTP 429 Too Many Requests',
  errorDetails: {
    classification: { kind: 'upstream-credit' },
    statusCode: 429,
  },
};

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

describe('human input approval policy', () => {
  it.effect(
    'reports a shared edit-policy denial through the run-context hook',
    () =>
      Effect.gen(function* () {
        const ctx = context({ approvalPolicy: 'never', mode: 'headless' });
        useCliHostInteractions(ctx);
        let policyDenials = 0;

        const result = yield* requestNewProofEdit(() => {
          policyDenials += 1;
        });
        // A policy refusal with nobody to ask is a denial, not a person's
        // rejection: the model reads the reason and routes around it.
        expect(result).toMatchObject({ action: 'deny' });
        expect(policyDenials).toBe(1);
        // The model routes around the denial, so the run's exit code is untouched.
        expect(runOutcomeExitCode(RUN_OUTCOME.COMPLETED)).toBe(
          CliExitCode.Success,
        );
        expect(runOutcomeExitCode(RUN_OUTCOME.CANCELLED)).toBe(
          CliExitCode.Interrupted,
        );
      }),
  );
});

describe('approval prompt hooks', () => {
  it.effect('runs the before-prompt hook for interactive approval events', () =>
    Effect.gen(function* () {
      const tracker = trackPromptEvents();
      useCliHostInteractions(
        context({ approvalPrompt: tracker.answerWith('n no review needed') }),
        tracker.hooks,
      );
      const result = yield* openRequest({
        kind: 'proposal',
        data: agentProposal(),
      });

      expect(result).toEqual({
        action: 'reject',
        feedback: 'no review needed',
      });
      expect(tracker.events).toEqual(['before', 'prompt']);
    }),
  );

  it.effect(
    'does not run the before-prompt hook for auto-approved events',
    () =>
      Effect.gen(function* () {
        const tracker = trackPromptEvents();
        useCliHostInteractions(
          context({ approvalPolicy: 'yolo' }),
          tracker.hooks,
        );
        const result = yield* openRequest({
          kind: 'proposal',
          data: agentProposal(),
        });

        expect(result).toEqual({ action: 'approve' });
        expect(tracker.events).toEqual([]);
      }),
  );

  it.effect(
    'routes automatic proposal rejection through the headless interaction port',
    () =>
      Effect.gen(function* () {
        useCliHostInteractions(context({ approvalPolicy: 'never' }));
        const result = yield* openRequest({
          kind: 'proposal',
          data: agentProposal(),
        });

        expect(result).toEqual({
          action: 'deny',
          reason: 'Denied by TeXRA approval policy.',
        });
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

  it.effect(
    'denies (not cancels) a retry when no human input is available',
    () =>
      Effect.gen(function* () {
        const ctx = context({ approvalPolicy: 'never', mode: 'headless' });
        const result = yield* requestHeadlessRetry(ctx);

        // A policy/headless auto-denial is a deny, not a user cancel: the model
        // receives the reason as feedback instead of the turn being abandoned.
        expect(result).toEqual({
          action: 'deny',
          reason: 'Denied by TeXRA approval policy.',
        });
      }),
  );

  it.effect.each([
    { approvalPolicy: 'never' as const, mode: 'interactive' as const },
    { approvalPolicy: 'ask' as const, mode: 'headless' as const },
  ])(
    'preserves the credential denial reason in $approvalPolicy/$mode mode',
    ({ approvalPolicy, mode }) =>
      Effect.gen(function* () {
        const result = yield* requestHeadlessRetry(
          context({ approvalPolicy, mode }),
          { errorDetails: credentialExhaustedRetry.errorDetails },
        );

        expect(result).toEqual({
          action: 'deny',
          reason: 'Retry skipped: credential exhausted or unauthorized.',
        });
      }),
  );

  it.effect(
    'denies a yolo retry without changing provider-failure exit classification',
    () =>
      Effect.gen(function* () {
        const result = yield* requestHeadlessRetry(
          context({ approvalPolicy: 'yolo' }),
        );

        expect(result).toEqual({
          action: 'deny',
          reason:
            'Retry skipped: explicit interactive approval is required after automatic attempts are exhausted.',
        });
        expect(runOutcomeExitCode(RUN_OUTCOME.FAILED)).toBe(
          CliExitCode.AgentError,
        );
      }),
  );

  it.effect.each([
    credentialExhaustedRetry.errorDetails,
    { message: 'Unauthorized', statusCode: 401 },
    { message: 'Forbidden', statusCode: 403 },
  ])(
    'preserves the credential denial reason for yolo credential/auth failure %#',
    (errorDetails) =>
      Effect.gen(function* () {
        const result = yield* requestHeadlessRetry(
          context({ approvalPolicy: 'yolo' }),
          { errorDetails },
        );

        expect(result).toEqual({
          action: 'deny',
          reason: 'Retry skipped: credential exhausted or unauthorized.',
        });
      }),
  );

  it.effect('cancels a retry the interactive user explicitly rejects', () =>
    Effect.gen(function* () {
      const result = yield* requestHeadlessRetry(
        context({ approvalPrompt: async () => 'n not now' }),
      );

      // The operator's note rides the cancellation: a dismissed retry is
      // their call, and the reason they gave is the cause.
      expect(result).toEqual({ action: 'cancel', cause: 'not now' });
    }),
  );
});

describe('bounded yolo retry batches (#9532)', () => {
  it.effect('denies every representative run sharing one policy adapter', () =>
    Effect.gen(function* () {
      // Representative runs share the session's CLI policy adapter. This
      // proves stream-agnostic bounding, not delegation inheritance: the
      // second run's request is denied exactly as the first one's was, so
      // neither can buy a second automatic batch off the other's decision.
      useCliHostInteractions(context({ approvalPolicy: 'yolo' }));

      const decisions = yield* Effect.forEach(
        ['a00002', 'a00003'] as RunId[],
        (runId) =>
          openRequestOn(runId, {
            kind: 'retry',
            data: {
              requestId: `retry-${runId}`,
              runId,
              operation: 'Model invocation',
              errorMessage: 'permanent provider failure',
            },
          }),
        { concurrency: 'unbounded' },
      );

      expect(decisions).toEqual([
        {
          action: 'deny',
          reason:
            'Retry skipped: explicit interactive approval is required after automatic attempts are exhausted.',
        },
        {
          action: 'deny',
          reason:
            'Retry skipped: explicit interactive approval is required after automatic attempts are exhausted.',
        },
      ]);
    }),
  );
});

describe('buildToolEditApprovalContent', () => {
  it.effect('passes one-line rejection feedback to the tool result', () =>
    Effect.gen(function* () {
      useCliHostInteractions(
        context({
          approvalPrompt: async () => 'n proof misses the p = 5 case',
        }),
      );

      const result = yield* requestNewProofEdit();

      expect(result).toMatchObject({
        action: 'reject',
        feedback: 'proof misses the p = 5 case',
      });
    }),
  );

  it.effect('does not synthesize feedback for a note-free rejection', () =>
    Effect.gen(function* () {
      useCliHostInteractions(
        context({
          approvalPrompt: async () => '',
        }),
      );

      const result = yield* requestNewProofEdit();

      expect(result).toEqual({ action: 'reject', feedback: null });
    }),
  );

  it.effect('preserves a failed edit prompt as an automatic cancellation', () =>
    Effect.gen(function* () {
      useCliHostInteractions(
        context({
          approvalPrompt: async () => {
            throw new Error('terminal input closed');
          },
        }),
      );

      const result = yield* requestNewProofEdit();

      // A prompt that never reached a person closes the request as an
      // automatic cancellation, never as that person's rejection.
      expect(result).toEqual({
        action: 'cancel',
        cause: 'CLI approval prompt failed.',
      });
    }),
  );

  it.effect('prompts for rejection feedback after an explicit no', () =>
    Effect.gen(function* () {
      const prompts: string[] = [];
      const summaries: string[] = [];
      const answers = ['n', 'use the workspace-local file path'];
      useCliHostInteractions(
        context({
          approvalPrompt: async (request) => {
            prompts.push(request.prompt);
            summaries.push(request.summary);
            return answers.shift() ?? '';
          },
        }),
      );

      const result = yield* requestNewProofEdit();

      expect(prompts).toEqual([
        'Approve? [y/N, or n <feedback>] ',
        'Rejection feedback (optional, Enter to skip): ',
      ]);
      expect(summaries[0]).toContain('Tool edit requested by write_file');
      expect(summaries[1]).toBe('');
      expect(result).toMatchObject({
        action: 'reject',
        feedback: 'use the workspace-local file path',
      });
    }),
  );

  it.effect(
    'shows complete bounded content without settling the approval',
    () =>
      Effect.gen(function* () {
        const prompts: string[] = [];
        const summaries: string[] = [];
        const answers = ['view', 'y'];
        const beforePrompt = vi.fn();
        const stderrWrite = stubStderrWrites();

        const decision = yield* askApproval(
          context({
            approvalPrompt: async (request) => {
              prompts.push(request.prompt);
              summaries.push(request.summary);
              return answers.shift() ?? '';
            },
          }),
          { summary: 'bounded preview', details: () => 'complete proposal' },
          { beforePrompt },
        );

        expect(decision).toEqual({ action: 'approve' });
        expect(prompts).toEqual([
          'Approve? [y/N, v view full, or n <feedback>] ',
          'Approve? [y/N, v view full, or n <feedback>] ',
        ]);
        expect(summaries).toEqual(['bounded preview', 'bounded preview']);
        expect(beforePrompt).toHaveBeenCalledTimes(2);
        expect(stderrWrite).toHaveBeenCalledWith(
          'complete proposal\n',
          expect.any(Function),
        );
      }),
  );

  it.effect('removes terminal control sequences from complete content', () =>
    Effect.gen(function* () {
      const answers = ['v', 'y'];
      const stderrWrite = stubStderrWrites();

      yield* askApproval(
        context({
          approvalPrompt: async () => answers.shift() ?? '',
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
        approvalPrompt: async (request) => {
          summaries.push(request.summary);
          if (request.summary !== 'first') return 'y';
          firstPromptCount += 1;
          if (firstPromptCount === 1) return viewAnswer;
          Deferred.doneUnsafe(secondFirstPrompt, Effect.void);
          return decisionAnswer;
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
      originalContent: '',
      proposedContent: `${longLine}\n`,
      sourceTool: 'write_file',
    });

    expect(summary).toContain('[line truncated]');
    expect(summary).not.toContain(longLine);
    expect(summary.length).toBeLessThan(1_000);
    expect(details?.()).toContain(longLine);
  });

  it('marks hidden diff lines when the line budget is exceeded', () => {
    const proposedContent = Array.from(
      { length: 100 },
      (_, index) => `generated line ${index + 1}`,
    ).join('\n');
    const { summary, details } = buildToolEditApprovalContent({
      path: '/tmp/generated.tex',
      originalContent: '',
      proposedContent,
      sourceTool: 'write_file',
    });

    expect(summary).toContain('diff lines hidden');
    expect(details?.()).toContain('+generated line 100');
    expect(details?.()).not.toContain('diff lines hidden');
  });

  it.effect('skips prompting for auto-approved edits', () =>
    Effect.gen(function* () {
      useCliHostInteractions(
        context({
          approvalPolicy: 'yolo',
          approvalPrompt: async () => {
            throw new Error('approval prompt should not be called');
          },
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

describe('buildAgentProposalApprovalContent', () => {
  it('bounds long subagent instructions before prompting', () => {
    const longLine = 'verify '.repeat(200);
    const instruction = Array.from(
      { length: 60 },
      (_, index) => `${index + 1}. ${longLine}`,
    ).join('\n');

    const { summary, details } = buildAgentProposalApprovalContent(
      agentProposal({
        instruction,
        memories: ['/memories/proof-style.md'],
        workingDirectory: '/tmp/project',
      }),
    );

    expect(summary).toContain('Working directory: /tmp/project');
    expect(summary).toContain('Memories: /memories/proof-style.md');
    expect(summary).toContain('[line truncated]');
    expect(summary).toContain('instruction lines hidden');
    expect(summary).not.toContain(longLine);
    expect(details?.()).toContain(`  60. ${longLine}`);
    expect(details?.()).not.toContain('instruction lines hidden');
  });
});

describe('formatRetryRequestMessage', () => {
  it("names the carried quota route's switch", () => {
    const retry: RetryPermission = {
      ...credentialExhaustedRetry,
      errorDetails: {
        classification: { kind: 'kimi-code-subscription' },
        statusCode: 429,
      },
      credentialSwitch: {
        kind: 'decline-route',
        route: 'kimi-code-subscription',
        provider: 'moonshot',
        automatic: false,
      },
    };

    expect(formatRetryRequestMessage(retry)).toContain(
      'Kimi Code subscription',
    );
    expect(formatRetryRequestMessage(retry)).toContain('Moonshot API keys');
    expect(
      formatRetryRequestMessage({ ...retry, credentialSwitch: null }),
    ).not.toContain('Press `k`');
  });
});
