// The TUI host's side of the request protocol (one run model, 3.7): what it
// answers from `view.requests` with nobody to ask, the bypass a decision turns
// on, and the credential work behind a retry on the user's own key. A run asks
// with `session.openRequest`; the surface answers with `request.decide`.

import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber, SubscriptionRef } from 'effect';
import { afterEach, beforeAll, beforeEach, describe, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  hasUsableApiKey: vi.fn(),
  preferSubscription: true,
  notify: vi.fn(),
  setCliSubscriptionPreference: vi.fn(),
  setCliCodingPlanSubscription: vi.fn(),
  setGLMCodingPlan: vi.fn((_enabled: boolean) => Effect.void),
}));

vi.mock('@model/codex/codexSubscription', () => ({
  isPreferCodexSubscription: () => mocks.preferSubscription,
}));

vi.mock('@cli/chat/tui/notifications/terminalNotifier', () => ({
  notify: mocks.notify,
}));

vi.mock('@cli/chat/tui/state/subscriptionPreference', () => ({
  setCliSubscriptionPreference: mocks.setCliSubscriptionPreference,
}));

vi.mock('@utils/config/providerConfig', async (importActual) => {
  const actual =
    await importActual<typeof import('@utils/config/providerConfig')>();
  return {
    ...actual,
    setGLMCodingPlan: mocks.setGLMCodingPlan,
  };
});

vi.mock('@model/apiProviders', async (importActual) => {
  const actual = await importActual<typeof import('@model/apiProviders')>();
  return {
    ...actual,
    hasUsableApiKey: mocks.hasUsableApiKey,
  };
});

import { currentApproval } from '@cli/chat/tui/state/approvalQueue';
import { bindSessionView } from '@cli/chat/tui/state/sessionView';
import { resetCliState, rootRunId } from '@cli/chat/tui/state/cliState';
import { createTuiHostInteractions } from '@cli/chat/tui/state/subscribeApprovals';
import type { CliContext } from '@cli/runtime/cliContext';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { runOutcomeExitCode } from '@cli/runtime/terminalStatus';
import type { CliRuntimeHost } from '@cli/runtime/cliPresentationHost';
import {
  AgentCategory,
  aggregateId,
  RUN_OUTCOME,
  type AgentProposalPermission,
  type PermissionPayload,
  type RequestDecision,
  type RetryPermission,
  type RunId,
} from '@shared/schemas';
import {
  APPROVE_ALL_DELEGATED_WORK_ACTION,
  APPROVE_SESSION_ACTION,
  type SurfaceDecision,
} from '@shared/session/approvalDecision';
import { testRuntime } from '@test/support/testProcessRuntime';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { createTuiCliContext } from '@test/cli/fixtures/cliContext';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { installedHost } from '@test/support/setupPlatform';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import { testRunHandle } from '@test/support/runHandleFixtures';
import { setGoalSessionAutoApproval } from '@tools/goal';
import { requestToolEditApproval } from '@tools/approval/toolEditApproval';
import { bashApprovalRequest } from '../agent/progressTestUtils';

let detachHost = (): void => {};

function host(): CliRuntimeHost {
  return {
    emit: vi.fn(),
    close: vi.fn(() => Effect.void),
  } as unknown as CliRuntimeHost;
}

/**
 * Attach the TUI presentation host for one test. It answers nothing on its
 * own: it stages what a request needs before it can be shown, and performs
 * the `useOwnApiKey` capability a retry decision names.
 */
function tui(
  presentationHost = host(),
  contextOverrides: Partial<CliContext> = {},
): { readonly presentationHost: CliRuntimeHost; readonly dispose: () => void } {
  const cliContext = createTuiCliContext(contextOverrides);
  testDefaultSession().setApprovalPolicy(cliContext.approvalPolicy);
  // The installed fake host's secret store: the credential work takes it
  // directly, and the key-check expectations name exactly this object.
  const { secrets } = installedHost();
  detachHost();
  detachHost = Effect.runSync(
    testDefaultSession().interactions.use(
      createTuiHostInteractions(presentationHost, cliContext, {
        session: testDefaultSession(),
        secrets,
        settings: makeFakeSettingsStores().stores,
        runtime: testRuntime(),
      }),
    ),
  );
  return {
    presentationHost,
    dispose: () => {
      detachHost();
      detachHost = () => {};
    },
  };
}

/** Run ids are hex-branded, so a readable case label hashes to a stable one. */
function runIdFor(label: string): RunId {
  let hash = 0x811c9dc5;
  for (const character of label) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0') as RunId;
}

/** The runs this file opens requests on; a request is a row on its run, so
 *  the run exists before the first one opens. */
const started = new Set<RunId>();

function ensureRun(runId: RunId): Effect.Effect<void> {
  return Effect.gen(function* () {
    const root = rootRunId.get();
    if (root === undefined) rootRunId.set(runId);
    if (started.has(runId)) return;
    started.add(runId);
    const session = testDefaultSession();
    publishTestRunStart(session, runId, { parent: root ?? null });
    yield* session.settlePublications().pipe(Effect.orDie);
  });
}

function requestEdit(runId: RunId) {
  return requestToolEditApproval({
    path: '/work/main.tex',
    originalContent: 'old',
    proposedContent: 'new',
    sourceTool: 'edit',
    runId,
  }).pipe(
    Effect.provide(
      nativeToolTestLayer({
        workingDirectory: '/work',
        run: { runId, session: testDefaultSession(), toolPolicy: {} },
      }),
    ),
  );
}

/** Ask through the protocol the TUI host answers: `request.opened` on the
 *  run, settled by the `request.decided` a surface commits. */
function openRequest(
  runId: RunId,
  payload: PermissionPayload,
): Effect.Effect<RequestDecision, Error> {
  return Effect.gen(function* () {
    yield* ensureRun(runId);
    return yield* testDefaultSession().openRequest(runId, payload);
  }).pipe(Effect.mapError((cause) => new Error(String(cause))));
}

function openRetry(
  permission: RetryPermission,
): Effect.Effect<RequestDecision, Error> {
  return openRequest(permission.runId as RunId, {
    kind: 'retry',
    data: permission,
  });
}

function proposalPayload(
  requestId: string,
  runId: RunId,
  instruction = 'Check the local compactness claim.',
): AgentProposalPermission {
  return {
    requestId,
    runId,
    agent: 'critic',
    agentSource: null,
    model: 'kimi26T',
    instruction,
    memories: [],
    workingDirectory: null,
    agentCategory: AgentCategory.ToolUse,
  };
}

/** Transient retry with no subscription exhaustion behind it. */
function ordinaryRetry(
  label: string,
  requestId: string = label,
): RetryPermission {
  return {
    requestId,
    runId: runIdFor(label),
    operation: 'model request',
    errorMessage: 'Temporary connection error.',
  };
}

let retrySeq = 0;
/** A fresh request id per fixture: the fold keys a request by it. */
function retryRequestId(label: string): string {
  retrySeq += 1;
  return `retry-${label}-${retrySeq}`;
}

function chatGptSubscriptionRetry(label: string): RetryPermission {
  const message = 'ChatGPT subscription usage limit reached.';
  return {
    requestId: retryRequestId(label),
    runId: runIdFor(label),
    operation: 'model request',
    errorMessage: message,
    errorDetails: {
      message,
      classification: { kind: 'chatgpt-subscription' },
      provider: 'openai',
    },
    credentialSwitch: {
      kind: 'decline-route',
      route: 'chatgpt-subscription',
      provider: 'openai',
      automatic: false,
    },
  };
}

/** Answer the request the modal is showing. */
function decideCurrent(decision: SurfaceDecision): void {
  const pending = currentApproval.get();
  expect(pending).toBeDefined();
  pending?.decide(testDefaultSession(), testRuntime(), decision);
}

function decideRetry(decision: SurfaceDecision): void {
  expect(currentApproval.get()?.payload.kind).toBe('retry');
  decideCurrent(decision);
}

/** The decision a retry on the user's own key lands. */
const PERSONAL_KEY_RETRY = {
  action: 'retry',
  credentials: 'personal',
} as const;

/** The pre-switch route: the ChatGPT subscription is still preferred. */
function expectChatGptSubscriptionRoute(): void {
  expect(mocks.preferSubscription).toBe(true);
}

/** The retry writes no access setting: the run declines the exhausted route
 *  on its own ledger and the user's switches stay theirs. */
function expectNoPreferenceWrites(): void {
  expect(mocks.setCliSubscriptionPreference).not.toHaveBeenCalled();
  expect(mocks.setCliCodingPlanSubscription).not.toHaveBeenCalled();
  expect(mocks.setGLMCodingPlan).not.toHaveBeenCalled();
}

function waitFor(assertion: () => void): Effect.Effect<void> {
  return Effect.promise(async () => {
    await vi.waitFor(assertion);
  });
}

/** Two macrotasks: enough for the host's own async work to reach its next
 *  await, used where the assertion is that nothing further happened. */
function settle(): Effect.Effect<void> {
  return Effect.promise(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function waitForApproval(
  kind: string,
  data: Record<string, unknown>,
): Effect.Effect<void> {
  return waitFor(() => {
    expect(currentApproval.get()?.payload).toMatchObject({ kind, data });
  });
}

function waitForNoApproval(): Effect.Effect<void> {
  return waitFor(() => expect(currentApproval.get()).toBeUndefined());
}

beforeAll(() => {
  bindSessionView(testRuntime(), testDefaultSession().view);
});

beforeEach(() => {
  mocks.preferSubscription = true;
  mocks.hasUsableApiKey.mockReturnValue(Effect.succeed(false));
  mocks.setCliSubscriptionPreference.mockImplementation((_id, enabled) => {
    mocks.preferSubscription = enabled;
    return Effect.void;
  });
});

afterEach(async () => {
  detachHost();
  detachHost = () => {};
  // A request left open outlives its test on the file's session, so close
  // whatever this test did not answer before the next one reads the head.
  const session = testDefaultSession();
  for (const request of SubscriptionRef.getUnsafe(session.view).requests) {
    await testRuntime().runPromise(
      session.requests
        .request({
          kind: 'request.decide',
          runId: request.runId,
          requestId: request.requestId,
          decision: { action: 'cancel', cause: 'Test finished.' },
        })
        .pipe(Effect.ignore),
    );
  }
  await Effect.runPromise(session.settlePublications());
  session.approvals.clearAll();
  resetCliState();
  mocks.hasUsableApiKey.mockReset();
  mocks.notify.mockReset();
  mocks.setCliSubscriptionPreference.mockReset();
  mocks.setCliCodingPlanSubscription.mockReset();
  mocks.setGLMCodingPlan.mockReset();
});

describe('TUI request decisions', () => {
  it.effect(
    'reconsiders a detached child delegation when live policy changes to yolo',
    () =>
      Effect.gen(function* () {
        tui();
        yield* ensureRun(runIdFor('waiting-proposal-parent'));
        const runId = runIdFor('waiting-proposal-policy-change');
        yield* ensureRun(runId);
        const session = testDefaultSession();
        session.runs.track(testRunHandle({ runId, agent: 'orchestrator' }));
        const pending = yield* Effect.forkChild(
          openRequest(runId, {
            kind: 'proposal',
            data: proposalPayload('waiting-proposal-policy-change', runId),
          }),
        );
        yield* waitForApproval('proposal', { runId });
        session.publish([
          { type: 'run.detach', aggregateId: aggregateId('run', runId) },
        ]);
        yield* session.settlePublications();
        expect(
          SubscriptionRef.getUnsafe(session.view).runs.get(runId)?.ownedHere,
        ).toBe(true);
        yield* waitForApproval('proposal', { runId });
        session.setApprovalPolicy('yolo');
        expect(yield* Fiber.join(pending)).toEqual({ action: 'approve' });
        yield* waitForNoApproval();
        session.runs.untrack(runId);
      }),
  );

  it.effect(
    'reports an automatic yolo retry rejection as a policy denial',
    () =>
      Effect.gen(function* () {
        tui(host(), { approvalPolicy: 'yolo' });

        const decision = yield* openRetry(
          ordinaryRetry('yolo-transient', 'yolo-transient-retry'),
        );

        expect(decision).toEqual({
          action: 'deny',
          reason:
            'Retry skipped: explicit interactive approval is required after automatic attempts are exhausted.',
        });
        expect(runOutcomeExitCode(RUN_OUTCOME.FAILED)).toBe(
          CliExitCode.AgentError,
        );
        yield* waitForNoApproval();
      }),
  );

  it.effect('sets the run bash bypass at the approval decision site', () =>
    Effect.gen(function* () {
      tui();
      const runId = runIdFor('bash-bypass');
      const pending = yield* Effect.forkChild(
        openRequest(runId, {
          kind: 'bash',
          data: bashApprovalRequest({ command: 'echo ok', runId }),
        }),
      );

      yield* waitForApproval('bash', { runId });
      decideCurrent({ action: APPROVE_SESSION_ACTION });

      expect(yield* Fiber.join(pending)).toEqual({ action: 'approve' });
      yield* waitFor(() =>
        expect(
          testDefaultSession().approvals.bash.bypass.isBypassed(runId),
        ).toBe(true),
      );
    }),
  );

  it.effect(
    'sets the run command bypass for a goal and revokes only what the goal granted',
    () =>
      Effect.gen(function* () {
        tui();
        const runId = runIdFor('goal-bypass');
        yield* ensureRun(runId);

        const { approvals } = testDefaultSession();
        setGoalSessionAutoApproval(testDefaultSession(), runId, 'commands');
        expect(approvals.bash.bypass.isBypassed(runId)).toBe(true);
        // The user answers an edit prompt with "approve for this session"
        // while the goal runs; ending the goal must not revoke that grant.
        approvals.toolEdit.bypass.setBypass(runId, true);

        setGoalSessionAutoApproval(testDefaultSession(), runId, false);
        expect(approvals.bash.bypass.isBypassed(runId)).toBe(false);
        expect(approvals.toolEdit.bypass.isBypassed(runId)).toBe(true);
      }),
  );

  it.effect('sets the run edit bypass at the approval decision site', () =>
    Effect.gen(function* () {
      tui();
      const runId = runIdFor('edit-bypass');
      yield* ensureRun(runId);
      const applied = yield* Effect.forkChild(requestEdit(runId));

      yield* waitForApproval('toolEdit', { runId });
      decideCurrent({ action: APPROVE_SESSION_ACTION });

      expect(yield* Fiber.join(applied)).toMatchObject({
        action: 'apply',
        appliedContent: 'new',
      });
      yield* waitFor(() =>
        expect(
          testDefaultSession().approvals.toolEdit.bypass.isBypassed(runId),
        ).toBe(true),
      );
    }),
  );

  it.effect(
    'enables the complete delegated-task approval mode at the proposal decision site',
    () =>
      Effect.gen(function* () {
        tui();
        const runId = runIdFor('proposal-bypass');
        const pending = yield* Effect.forkChild(
          openRequest(runId, {
            kind: 'proposal',
            data: proposalPayload('proposal-bypass', runId),
          }),
        );

        yield* waitForApproval('proposal', { runId });
        decideCurrent({ action: APPROVE_ALL_DELEGATED_WORK_ACTION });

        expect(yield* Fiber.join(pending)).toMatchObject({
          action: 'approve',
        });
        yield* waitFor(() => {
          expect(
            testDefaultSession().approvals.proposal.isBypassed(runId),
          ).toBe(true);
          expect(
            testDefaultSession().approvals.toolEdit.bypass.isBypassed(runId),
          ).toBe(true);
          expect(
            testDefaultSession().approvals.bash.bypass.isBypassed(runId),
          ).toBe(true);
        });
      }),
  );

  it.effect('approves delegated work already queued in the same run', () =>
    Effect.gen(function* () {
      tui();
      const runId = runIdFor('parallel-approval');
      yield* ensureRun(runId);
      const proposal = yield* Effect.forkChild(
        openRequest(runId, {
          kind: 'proposal',
          data: proposalPayload('proposal-current', runId),
        }),
      );
      const edit = yield* Effect.forkChild(requestEdit(runId));
      const bash = yield* Effect.forkChild(
        openRequest(runId, {
          kind: 'bash',
          data: bashApprovalRequest({ command: 'lake build', runId }),
        }),
      );
      yield* Effect.forkChild(
        openRequest(runId, {
          kind: 'planApproval',
          data: {
            requestId: 'plan-excluded',
            runId,
            goalEnabled: false,
            plan: { objective: 'Keep the approval categories distinct.' },
          },
        }),
      );

      yield* waitForApproval('proposal', { requestId: 'proposal-current' });
      decideCurrent({ action: APPROVE_ALL_DELEGATED_WORK_ACTION });

      expect(yield* Fiber.join(proposal)).toMatchObject({ action: 'approve' });
      expect(yield* Fiber.join(edit)).toMatchObject({
        action: 'apply',
        appliedContent: 'new',
      });
      expect(yield* Fiber.join(bash)).toEqual({ action: 'approve' });
      // A plan approval is not delegated work: it still waits for the user.
      yield* waitFor(() =>
        expect(currentApproval.get()?.payload.kind).toBe('planApproval'),
      );
    }),
  );

  it.effect(
    'keeps an ordinary proposal approval limited to the current request',
    () =>
      Effect.gen(function* () {
        tui();
        const runId = runIdFor('proposal-one-off');
        const pending = yield* Effect.forkChild(
          openRequest(runId, {
            kind: 'proposal',
            data: proposalPayload(
              'proposal-one-off',
              runId,
              'Check one calculation.',
            ),
          }),
        );

        yield* waitForApproval('proposal', { requestId: 'proposal-one-off' });
        decideCurrent({ action: 'approve' });

        expect(yield* Fiber.join(pending)).toEqual({ action: 'approve' });
        expect(testDefaultSession().approvals.proposal.isBypassed(runId)).toBe(
          false,
        );
        expect(
          testDefaultSession().approvals.toolEdit.bypass.isBypassed(runId),
        ).toBe(false);
        expect(
          testDefaultSession().approvals.bash.bypass.isBypassed(runId),
        ).toBe(false);
      }),
  );

  it.effect(
    'switches a ChatGPT subscription retry to the API key only on the explicit decision',
    () =>
      Effect.gen(function* () {
        mocks.hasUsableApiKey.mockReturnValue(Effect.succeed(true));
        tui();
        const pending = yield* Effect.forkChild(
          openRetry(chatGptSubscriptionRetry('s3')),
        );

        yield* waitForApproval('retry', {
          runId: runIdFor('s3'),
          errorMessage: 'ChatGPT subscription usage limit reached.',
        });
        expect(mocks.hasUsableApiKey).not.toHaveBeenCalled();

        decideRetry(PERSONAL_KEY_RETRY);

        expect(yield* Fiber.join(pending)).toEqual(PERSONAL_KEY_RETRY);
        // The decision is the whole switch: the run declines the exhausted
        // route on its own ledger, so the user's stored preference is not
        // rewritten on their behalf.
        expectNoPreferenceWrites();
        // The shared key entry checks the provider the run's offer named.
        expect(mocks.hasUsableApiKey).toHaveBeenCalledExactlyOnceWith(
          installedHost().secrets,
          'openai',
        );
        yield* waitForNoApproval();
      }),
  );

  it.effect(
    'does not publish a retry decision after its key lookup outlives the host',
    () =>
      Effect.gen(function* () {
        let finishLookup: (() => void) | undefined;
        const lookupCaptured = Deferred.makeUnsafe<void>();
        mocks.hasUsableApiKey.mockImplementation(() =>
          Effect.tryPromise(
            () =>
              new Promise<boolean>((_resolve, reject) => {
                finishLookup = () => reject(new Error('Keychain unavailable'));
                Deferred.doneUnsafe(lookupCaptured, Effect.void);
              }),
          ),
        );
        const attached = tui();
        const permission = chatGptSubscriptionRetry('disposed-key');
        const pending = yield* Effect.forkChild(openRetry(permission));
        yield* waitForApproval('retry', { runId: permission.runId });
        decideRetry(PERSONAL_KEY_RETRY);
        yield* Deferred.await(lookupCaptured);
        attached.dispose();
        finishLookup?.();
        yield* settle();
        yield* testDefaultSession().settlePublications();
        expect(
          SubscriptionRef.getUnsafe(testDefaultSession().view).requests.some(
            (request) => request.requestId === permission.requestId,
          ),
        ).toBe(true);
        yield* Fiber.interrupt(pending);
      }),
  );

  it.effect(
    'retries ChatGPT subscription access without changing credentials when the ordinary retry action is chosen',
    () =>
      Effect.gen(function* () {
        tui();
        const pending = yield* Effect.forkChild(
          openRetry(chatGptSubscriptionRetry('subscription-retry')),
        );

        yield* waitForApproval('retry', {
          runId: runIdFor('subscription-retry'),
        });
        decideRetry({ action: 'retry' });

        expect(yield* Fiber.join(pending)).toEqual({ action: 'retry' });
        expect(mocks.hasUsableApiKey).not.toHaveBeenCalled();
        expectNoPreferenceWrites();
        expectChatGptSubscriptionRoute();
      }),
  );

  it.effect('cancels the retry modal when the run interrupts its request', () =>
    Effect.gen(function* () {
      mocks.hasUsableApiKey.mockReturnValue(Effect.succeed(false));
      tui();
      const pending = yield* Effect.forkChild(
        openRetry(chatGptSubscriptionRetry('modal-interrupt')),
      );

      yield* waitForApproval('retry', { runId: runIdFor('modal-interrupt') });
      yield* Fiber.interrupt(pending);

      yield* waitForNoApproval();
    }),
  );
});
