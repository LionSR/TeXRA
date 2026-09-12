// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
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

import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { createHeadlessCliHostInteractions } from '@cli/runtime/approvalAdapter';
import type { CliContext } from '@cli/runtime/cliContext';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { runOutcomeExitCode } from '@cli/runtime/terminalStatus';
import {
  askApproval,
  cliRetryQuotaRoute,
  isCliApiSwitchableRetry,
  type CliApprovalPromptHooks,
} from '@cli/runtime/approval/approvalPrompts';
import {
  buildAgentProposalApprovalContent,
  buildToolEditApprovalContent,
  formatRetryRequestMessage,
} from '@cli/runtime/approval/approvalSummaries';
import { decideRetryApproval } from '@shared/approvalPolicy';
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
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import { requestToolEditApproval } from '@tools/approval/toolEditApproval';

function context(overrides: Partial<CliContext> = {}): CliContext {
  const ctx = createTestCliContext({
    cwd: '/tmp',
    mode: 'interactive',
    approvalPolicy: 'ask',
    version: 'test',
    ...overrides,
  });
  defaultSession().setApprovalPolicy(ctx.approvalPolicy);
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
  defaultSession().setApprovalPolicy(cliContext.approvalPolicy);
  detachHostInteractions = defaultSession().interactions.use(
    createHeadlessCliHostInteractions(cliContext, hooks),
  );
}

function requestNewProofEdit(): ReturnType<typeof requestToolEditApproval> {
  return requestToolEditApproval({
    path: '/tmp/new-proof.tex',
    originalContent: '',
    proposedContent: '\\section{Proof}\nA concise proof.\n',
    sourceTool: 'write_file',
    runId: ROOT_RUN,
  });
}

const ROOT_RUN = 'a00001' as RunId;
/** The runs this file opens requests on; a request is a row on its run, so
 *  the run exists before the first one opens. */
const started = new Set<RunId>();

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
    const session = defaultSession();
    if (!started.has(runId)) {
      started.add(runId);
      publishTestRunStart(session, runId);
      yield* Effect.promise(() => session.settlePublications());
    }
    return yield* session.openRequest(runId, payload);
  }).pipe(Effect.mapError((cause) => new Error(String(cause))));
}

function openRequest(
  payload: PermissionPayload,
): Effect.Effect<RequestDecision, Error> {
  return openRequestOn(ROOT_RUN, payload);
}

function agentProposal(
  overrides: Partial<AgentProposalPermission> = {},
): AgentProposalPermission {
  const base = {
    requestId: 'proposal-1',
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
  const { initPlatform: init } = await import('@platform/platform');
  const { createFakePlatform } = await import('@test/support/FakePlatform');
  init(createFakePlatform());
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

describe('shared retry and human-input decisions', () => {
  it.effect('denies an ordinary transient retry in yolo', () =>
    Effect.gen(function* () {
      useCliHostInteractions(context({ approvalPolicy: 'yolo' }));
      const result = yield* openRequest({
        kind: 'retry',
        data: {
          requestId: 'transient-retry',
          runId: ROOT_RUN,
          operation: 'Model request',
          errorMessage: 'stream dropped before first token',
        },
      });

      expect(result).toMatchObject({ action: 'deny' });
    }),
  );
});

describe('human input approval policy', () => {
  it.effect(
    'reports a shared edit-policy denial through the run-context hook',
    () =>
      Effect.gen(function* () {
        const ctx = context({ approvalPolicy: 'never', mode: 'headless' });
        useCliHostInteractions(ctx);
        let policyDenials = 0;

        const result = yield* Effect.promise(() =>
          withRunContext(
            createRunContext({
              onApprovalPolicyDenial: () => {
                policyDenials += 1;
              },
            }),
            () => Effect.runPromise(requestNewProofEdit()),
          ),
        );
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
  const proposal = agentProposal();

  it.effect('runs the before-prompt hook for interactive approval events', () =>
    Effect.gen(function* () {
      const tracker = trackPromptEvents();
      useCliHostInteractions(
        context({ approvalPrompt: tracker.answerWith('n no review needed') }),
        tracker.hooks,
      );
      const result = yield* openRequest({ kind: 'proposal', data: proposal });

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
        const result = yield* openRequest({ kind: 'proposal', data: proposal });

        expect(result).toEqual({ action: 'approve' });
        expect(tracker.events).toEqual([]);
      }),
  );

  it.effect(
    'routes automatic proposal rejection through the headless interaction port',
    () =>
      Effect.gen(function* () {
        useCliHostInteractions(context({ approvalPolicy: 'never' }));
        const result = yield* openRequest({ kind: 'proposal', data: proposal });

        expect(result).toEqual({
          action: 'deny',
          reason: 'Denied by TeXRA approval policy.',
        });
      }),
  );
});

describe('retry request classification (#7331)', () => {
  const retryRequest: RetryPermission = {
    requestId: 'headless-retry',
    runId: ROOT_RUN,
    operation: 'Model invocation',
    errorMessage: 'stream dropped before first token',
  };

  function requestHeadlessRetry(
    ctx: CliContext,
    overrides: Partial<RetryPermission> = {},
  ): Effect.Effect<RequestDecision, Error> {
    useCliHostInteractions(ctx);
    return openRequest({
      kind: 'retry',
      data: { ...retryRequest, ...overrides },
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
  it.effect('passes the diff summary to the interactive approval prompt', () =>
    Effect.gen(function* () {
      let promptSummary = '';
      useCliHostInteractions(
        context({
          approvalPrompt: async (request) => {
            promptSummary = request.summary;
            return 'n needs revision';
          },
        }),
      );

      const result = yield* requestNewProofEdit();

      expect(result.action).toBe('reject');
      expect(promptSummary).toContain('Tool edit requested by write_file');
      expect(promptSummary).toContain('+\\section{Proof}');
      expect(promptSummary).toContain('+A concise proof.');
    }),
  );

  it.effect('runs the before-prompt hook for tool edit approvals', () =>
    Effect.gen(function* () {
      const tracker = trackPromptEvents();
      useCliHostInteractions(
        context({ approvalPrompt: tracker.answerWith('y') }),
        tracker.hooks,
      );

      const result = yield* requestNewProofEdit();

      expect(result.action).toBe('apply');
      expect(tracker.events).toEqual(['before', 'prompt']);
    }),
  );

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

  it.effect('does not construct complete content unless it is requested', () =>
    Effect.gen(function* () {
      const details = vi.fn(() => 'complete proposal');
      const decision = yield* askApproval(
        context({
          approvalPrompt: async () => 'y',
        }),
        { summary: 'bounded preview', details },
      );

      expect(details).not.toHaveBeenCalled();
      expect(decision).toEqual({ action: 'approve' });
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
      stubStderrWrites();
      const cliContext = context({
        approvalPrompt: async (request) => {
          summaries.push(request.summary);
          if (request.summary !== 'first') return 'y';
          firstPromptCount += 1;
          return firstPromptCount === 1 ? viewAnswer : decisionAnswer;
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
      yield* Effect.promise(() =>
        vi.waitFor(() => expect(summaries).toEqual(['first', 'first'])),
      );

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

      const result = yield* requestToolEditApproval({
        path: '/tmp/auto-approved.tex',
        originalContent: '',
        proposedContent: '\\section{Auto-approved}\n',
        sourceTool: 'write_file',
        runId: ROOT_RUN,
      });

      expect(result).toMatchObject({
        action: 'apply',
        appliedContent: '\\section{Auto-approved}\n',
      });
    }),
  );
});

describe('buildAgentProposalApprovalContent', () => {
  it('formats subagent approvals without raw JSON internals', () => {
    const { summary, details } = buildAgentProposalApprovalContent(
      agentProposal({
        instruction:
          'Please verify the proof carefully.\nReport any gaps or hidden cases.',
      }),
    );

    expect(summary).toContain(
      'Agent proposal requested: review (tool-use agent)',
    );
    // The summary names the model the way the transcript does, by its
    // registry label rather than its persisted id.
    expect(summary).toContain('Model: DeepSeek V4 Flash (Thinking)');
    expect(summary).toContain('Instruction:');
    expect(summary).toContain('  Please verify the proof carefully.');
    expect(summary).not.toContain('requestId');
    expect(summary).not.toContain('runId');
    expect(summary).not.toContain('{');
    expect(details).toBeUndefined();
  });

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

  it('includes workflow proposal file groups', () => {
    const inputFiles = Array.from(
      { length: 12 },
      (_, index) => `draft-${index + 1}.tex`,
    );
    const { summary, details } = buildAgentProposalApprovalContent(
      agentProposal({
        agent: 'polish',
        instruction: 'Polish the draft and write the revised file.',
        inputFiles,
        contextFiles: ['notes.md'],
        mediaFiles: ['figure.png'],
        outputFiles: ['draft-polished.tex'],
        toolConfig: DEFAULT_TOOL_CONFIG,
        agentCategory: AgentCategory.Workflow,
      }),
    );

    expect(summary).toContain(
      'Agent proposal requested: polish (workflow agent)',
    );
    expect(summary).toContain('Input: draft-1.tex');
    expect(summary).toContain('+2 more');
    expect(summary).not.toContain('draft-12.tex');
    expect(details?.()).toContain('draft-12.tex');
    expect(details?.()).not.toContain('+2 more');
    expect(summary).toContain('Context: notes.md');
    expect(summary).toContain('Media: figure.png');
    expect(summary).toContain('Output: draft-polished.tex');
  });
});

describe('formatRetryRequestMessage', () => {
  it('shows the Moonshot API-key switch for a Kimi Code subscription limit', () => {
    const retry: RetryPermission = {
      ...credentialExhaustedRetry,
      errorDetails: {
        classification: { kind: 'kimi-code-subscription' },
        statusCode: 429,
      },
    };

    expect(isCliApiSwitchableRetry(retry)).toBe(true);
    expect(formatRetryRequestMessage(retry)).toContain(
      'Kimi Code subscription',
    );
    expect(formatRetryRequestMessage(retry)).toContain('Moonshot API keys');
    expect(cliRetryQuotaRoute(retry)?.id).toBe('kimiCode');
  });

  it('uses the same coding-plan decision for a GLM quota limit', () => {
    const retry: RetryPermission = {
      ...credentialExhaustedRetry,
      errorDetails: {
        classification: { kind: 'glm-coding-plan' },
        statusCode: 429,
      },
    };

    expect(cliRetryQuotaRoute(retry)?.id).toBe('glmCodingPlan');
    expect(formatRetryRequestMessage(retry)).toContain('regular GLM endpoint');
  });
});
