// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Exit, Scope } from 'effect';
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
import { type CliApprovalPromptHooks } from '@cli/runtime/approval/approvalPrompts';
import {
  type AgentProposalPermission,
  type PermissionPayload,
  type RequestDecision,
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

function useCliHostInteractions(
  cliContext: CliContext,
  hooks: CliApprovalPromptHooks = {},
): void {
  detachHostInteractions();
  setTestApprovalPolicy(cliContext.approvalPolicy);
  // The host's view watch lives in this scope; detaching closes it.
  const scope = Scope.makeUnsafe();
  const detach = Effect.runSync(
    testDefaultSession().interactions.use(
      testRuntime().runSync(
        createHeadlessCliHostInteractions(
          testSessionOf(testDefaultSession()),
          cliContext,
          hooks,
        ).pipe(Scope.provide(scope)),
      ),
    ),
  );
  detachHostInteractions = () => {
    detach();
    Effect.runFork(Scope.close(scope, Exit.void));
  };
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

describe('buildToolEditApprovalContent', () => {
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
