// The TUI host's side of the request protocol (one run model, 3.7): what it
// answers from `view.requests` with nobody to ask, the bypass a decision turns
// on, and the credential work behind a retry on the user's own key. A run asks
// with `session.openRequest`; the surface answers with `request.decide`.

import '@test/support/defaultSessionTestSetup';

import { it } from '@effect/vitest';
import { Effect, Fiber, SubscriptionRef } from 'effect';
import { afterEach, beforeAll, beforeEach, describe, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiKeyExistsUncached: vi.fn(),
  hasUsableApiKey: vi.fn(),
  invalidateApiKeyCache: vi.fn(),
  preferSubscription: true,
  preferKimiCode: false,
  glmCodingPlan: false,
  notify: vi.fn(),
  openRouter: false,
  secrets: {},
  setCliSubscriptionPreference: vi.fn(),
  setCliCodingPlanSubscription: vi.fn(),
  setGLMCodingPlan: vi.fn(),
  updateGlobalState: vi.fn(),
}));

vi.mock('@model/codex/codexPreference', () => ({
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
    getPreferKimiCode: () => mocks.preferKimiCode,
    getGLMCodingPlan: () => mocks.glmCodingPlan,
    setGLMCodingPlan: mocks.setGLMCodingPlan,
  };
});

vi.mock('@model/apiProviders', async (importActual) => {
  const actual = await importActual<typeof import('@model/apiProviders')>();
  return {
    ...actual,
    apiKeyExistsUncached: mocks.apiKeyExistsUncached,
    hasUsableApiKey: mocks.hasUsableApiKey,
    invalidateApiKeyCache: mocks.invalidateApiKeyCache,
  };
});

vi.mock('@platform/platform', async () => {
  const { GlobalStateKey } = await import('@shared/state/stateKeys');
  return {
    platform: () => ({
      secrets: mocks.secrets,
      workspace: { getWorkspacePath: () => undefined },
      globalState: {
        get: (key: string, fallback: unknown) =>
          key === GlobalStateKey.USE_OPENROUTER ? mocks.openRouter : fallback,
        update: mocks.updateGlobalState,
      },
    }),
  };
});

import { defaultSession } from '@agent/runtime/SessionHandle';
import { currentApproval } from '@cli/chat/tui/state/approvalQueue';
import { bindSessionView } from '@cli/chat/tui/state/sessionView';
import { resetCliState } from '@cli/chat/tui/state/cliState';
import { createTuiHostInteractions } from '@cli/chat/tui/state/subscribeApprovals';
import type { CliContext } from '@cli/runtime/cliContext';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { runOutcomeExitCode } from '@cli/runtime/terminalStatus';
import type { CliRuntimeHost } from '@cli/runtime/cliPresentationHost';
import type { ApiProvider } from '@model/apiProviders';
import { platform } from '@platform/platform';
import { effectRuntime } from '@platform/processRuntime';
import {
  AgentCategory,
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
import { GlobalStateKey } from '@shared/state/stateKeys';
import { createTuiCliContext } from '@test/cli/fixtures/cliContext';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import { setGoalSessionAutoApproval } from '@tools/goal';
import { proposalApprovals } from '@tools/approval';
import { requestToolEditApproval } from '@tools/approval/toolEditApproval';
import { bashApprovalRequest } from '../agent/progressTestUtils';

let detachHost = (): void => {};

function host(): CliRuntimeHost {
  return {
    emit: vi.fn(),
    emitApprovalBypassState: vi.fn(),
    close: vi.fn(async () => undefined),
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
  defaultSession().setApprovalPolicy(cliContext.approvalPolicy);
  // The suite's own fake stores, mocked above: the credential work takes them
  // directly, and the key-check expectations name exactly these objects.
  const { secrets, globalState } = platform();
  detachHost();
  detachHost = defaultSession().interactions.use(
    createTuiHostInteractions(presentationHost, cliContext, {
      secrets,
      state: globalState,
    }),
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
    if (started.has(runId)) return;
    started.add(runId);
    const session = defaultSession();
    publishTestRunStart(session, runId);
    yield* Effect.promise(() => session.settlePublications());
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
        run: { runId, session: defaultSession(), toolPolicy: {} },
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
    return yield* defaultSession().openRequest(runId, payload);
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
  } as RetryPermission;
}

function kimiCodeSubscriptionRetry(
  label: string,
  model = 'kimi3',
): RetryPermission {
  const message = 'Kimi Code subscription usage limit reached.';
  return {
    requestId: retryRequestId(label),
    runId: runIdFor(label),
    operation: 'model request',
    model,
    errorMessage: message,
    errorDetails: {
      message,
      classification: { kind: 'kimi-code-subscription' },
      provider: 'moonshot',
    },
  } as RetryPermission;
}

function glmCodingPlanRetry(label: string): RetryPermission {
  const message = 'GLM Coding Plan usage limit reached.';
  return {
    requestId: retryRequestId(label),
    runId: runIdFor(label),
    operation: 'model request',
    model: 'glm46',
    errorMessage: message,
    errorDetails: {
      message,
      classification: { kind: 'glm-coding-plan' },
      provider: 'glm',
    },
  } as RetryPermission;
}

/** Answer the request the modal is showing. */
function decideCurrent(decision: SurfaceDecision): void {
  const pending = currentApproval.get();
  expect(pending).toBeDefined();
  pending?.decide(decision);
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

function expectNoCredentialChange(): void {
  expect(mocks.invalidateApiKeyCache).not.toHaveBeenCalled();
  expectNoPreferenceWrites();
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
  tuiAdornments?: Record<string, unknown>,
): Effect.Effect<void> {
  return waitFor(() => {
    expect(currentApproval.get()?.payload).toMatchObject({
      kind,
      data,
      ...(tuiAdornments ? { tui: tuiAdornments } : {}),
    });
  });
}

function waitForNoApproval(): Effect.Effect<void> {
  return waitFor(() => expect(currentApproval.get()).toBeUndefined());
}

beforeAll(() => {
  bindSessionView(defaultSession().view);
});

beforeEach(() => {
  mocks.preferSubscription = true;
  mocks.openRouter = false;
  mocks.apiKeyExistsUncached.mockResolvedValue(true);
  mocks.hasUsableApiKey.mockResolvedValue(false);
  mocks.updateGlobalState.mockImplementation(
    async (key: string, value: unknown) => {
      if (key === GlobalStateKey.USE_OPENROUTER) {
        mocks.openRouter = value === true;
      }
      if (key === GlobalStateKey.KIMI_CODE_PREFER) {
        mocks.preferKimiCode = value === true;
      }
    },
  );
  mocks.setCliSubscriptionPreference.mockImplementation(
    async (_id, enabled) => {
      mocks.preferSubscription = enabled;
      return { effective: enabled, target: 'global' };
    },
  );
  mocks.setGLMCodingPlan.mockImplementation(async (enabled) => {
    mocks.glmCodingPlan = enabled;
  });
});

afterEach(async () => {
  detachHost();
  detachHost = () => {};
  // A request left open outlives its test on the file's session, so close
  // whatever this test did not answer before the next one reads the head.
  const session = defaultSession();
  for (const request of SubscriptionRef.getUnsafe(session.view).requests) {
    await effectRuntime().runPromise(
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
  await session.settlePublications();
  session.approvals.clearAll();
  resetCliState();
  mocks.apiKeyExistsUncached.mockReset();
  mocks.hasUsableApiKey.mockReset();
  mocks.invalidateApiKeyCache.mockReset();
  mocks.notify.mockReset();
  mocks.setCliSubscriptionPreference.mockReset();
  mocks.setCliCodingPlanSubscription.mockReset();
  mocks.setGLMCodingPlan.mockReset();
  mocks.updateGlobalState.mockReset();
});

describe('TUI request decisions', () => {
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

  it.effect('updates TUI bash bypass state at the approval decision site', () =>
    Effect.gen(function* () {
      const { presentationHost } = tui();
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
        expect(presentationHost.emitApprovalBypassState).toHaveBeenCalledWith({
          runId,
          kind: 'bash',
          bypassActive: true,
        }),
      );
    }),
  );

  it.effect(
    'updates TUI command bypass state when goal auto-approval is enabled and cleared',
    () =>
      Effect.gen(function* () {
        const { presentationHost } = tui();
        const runId = runIdFor('goal-bypass');
        yield* ensureRun(runId);

        yield* Effect.promise(() =>
          setGoalSessionAutoApproval(runId, 'commands'),
        );
        expect(presentationHost.emitApprovalBypassState).toHaveBeenCalledWith({
          runId,
          kind: 'bash',
          bypassActive: true,
        });

        yield* Effect.promise(() => setGoalSessionAutoApproval(runId, false));
        expect(presentationHost.emitApprovalBypassState).toHaveBeenCalledWith({
          runId,
          kind: 'bash',
          bypassActive: false,
        });
      }),
  );

  it.effect('updates TUI edit bypass state at the approval decision site', () =>
    Effect.gen(function* () {
      const { presentationHost } = tui();
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
        expect(presentationHost.emitApprovalBypassState).toHaveBeenCalledWith({
          runId,
          kind: 'toolEdit',
          bypassActive: true,
        }),
      );
    }),
  );

  it.effect(
    'enables the complete delegated-task approval mode at the proposal decision site',
    () =>
      Effect.gen(function* () {
        const { presentationHost } = tui();
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
          expect(proposalApprovals().isBypassed(runId)).toBe(true);
          expect(
            defaultSession().approvals.toolEdit.bypass.isBypassed(runId),
          ).toBe(true);
          expect(defaultSession().approvals.bash.bypass.isBypassed(runId)).toBe(
            true,
          );
        });
        for (const kind of ['superYolo', 'toolEdit', 'bash'] as const) {
          expect(presentationHost.emitApprovalBypassState).toHaveBeenCalledWith(
            { runId, kind, bypassActive: true },
          );
        }
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
        expect(proposalApprovals().isBypassed(runId)).toBe(false);
        expect(
          defaultSession().approvals.toolEdit.bypass.isBypassed(runId),
        ).toBe(false);
        expect(defaultSession().approvals.bash.bypass.isBypassed(runId)).toBe(
          false,
        );
      }),
  );

  it.effect(
    'fails closed when a switchable retry does not identify its provider',
    () =>
      Effect.gen(function* () {
        mocks.hasUsableApiKey.mockResolvedValue(true);
        tui();
        const pending = yield* Effect.forkChild(
          openRetry({
            requestId: 'retry-unknown-provider',
            runId: runIdFor('s1'),
            operation: 'model request',
            errorMessage: 'ChatGPT subscription usage limit reached.',
            errorDetails: {
              message: 'ChatGPT subscription usage limit reached.',
              classification: { kind: 'chatgpt-subscription' },
            },
          } as RetryPermission),
        );

        yield* waitForApproval(
          'retry',
          {},
          {
            personalApiKeyAvailable: false,
            missingPersonalApiKeyMessage: expect.stringContaining(
              'provider could not be identified',
            ),
          },
        );
        decideRetry({ action: 'reject' });

        expect(yield* Fiber.join(pending)).toEqual({ action: 'reject' });
        expect(mocks.hasUsableApiKey).not.toHaveBeenCalled();
        expectNoCredentialChange();
      }),
  );

  it.effect('falls back to the retry modal when API key lookup fails', () =>
    Effect.gen(function* () {
      mocks.hasUsableApiKey.mockRejectedValue(
        new Error('keychain unavailable'),
      );
      tui();
      yield* Effect.forkChild(openRetry(chatGptSubscriptionRetry('s2')));

      yield* waitForApproval(
        'retry',
        { runId: runIdFor('s2') },
        {
          personalApiKeyAvailable: false,
          missingPersonalApiKeyMessage:
            'TeXRA could not check whether the OpenAI API key is available. Press n to dismiss, then use `/key` to try again.',
        },
      );
    }),
  );

  it.effect(
    'does not auto-switch when a retry provider is not an API provider',
    () =>
      Effect.gen(function* () {
        mocks.hasUsableApiKey.mockResolvedValue(true);
        tui();
        yield* Effect.forkChild(
          openRetry({
            requestId: retryRequestId('unknown-provider'),
            runId: runIdFor('unknown-provider'),
            operation: 'model request',
            errorMessage: 'ChatGPT subscription usage limit reached.',
            errorDetails: {
              message: 'ChatGPT subscription usage limit reached.',
              classification: { kind: 'chatgpt-subscription' },
              provider: 'custom-provider',
            },
          } as RetryPermission),
        );

        yield* waitForApproval('retry', {
          runId: runIdFor('unknown-provider'),
        });
        expect(mocks.hasUsableApiKey).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    'requires an explicit decision before switching a ChatGPT subscription retry to an API key',
    () =>
      Effect.gen(function* () {
        mocks.hasUsableApiKey.mockImplementation(
          async (_secrets, provider: ApiProvider) => provider === 'openai',
        );
        tui();
        const pending = yield* Effect.forkChild(
          openRetry(chatGptSubscriptionRetry('s3')),
        );

        yield* waitForApproval(
          'retry',
          {
            runId: runIdFor('s3'),
            errorMessage: 'ChatGPT subscription usage limit reached.',
          },
          { personalApiKeyAvailable: true },
        );
        expect(mocks.hasUsableApiKey).toHaveBeenCalledTimes(1);
        expectNoPreferenceWrites();

        decideRetry(PERSONAL_KEY_RETRY);

        expect(yield* Fiber.join(pending)).toEqual(PERSONAL_KEY_RETRY);
        // The decision is the whole switch: the run declines the exhausted
        // route on its own ledger, so the user's stored preference is not
        // rewritten on their behalf.
        expectNoPreferenceWrites();
        expect(mocks.hasUsableApiKey).toHaveBeenCalledTimes(1);
        expect(mocks.apiKeyExistsUncached).toHaveBeenCalledWith(
          mocks.secrets,
          'openai',
        );
        expect(mocks.apiKeyExistsUncached).toHaveBeenCalledOnce();
        expect(mocks.invalidateApiKeyCache).toHaveBeenCalledOnce();
        yield* waitForNoApproval();
      }),
  );

  it.effect(
    'auto-switches a Kimi Code subscription limit to the stored Moonshot key',
    () =>
      Effect.gen(function* () {
        mocks.preferKimiCode = true;
        mocks.hasUsableApiKey.mockImplementation(
          async (_secrets, provider: ApiProvider) => provider === 'moonshot',
        );
        tui();

        const decision = yield* openRetry(
          kimiCodeSubscriptionRetry('kimi-limit'),
        );

        expect(decision).toEqual(PERSONAL_KEY_RETRY);
        // The run declines the exhausted coding route for itself when it
        // reads the decision; the user's plan preference stays on, so a
        // concurrent run keeps the route it is still entitled to.
        expectNoPreferenceWrites();
        // The modal's quota warning was skipped, so the terminal notification
        // is the only signal that the retry changed credentials.
        expect(mocks.notify).toHaveBeenCalledWith('credentialSwitched');
        yield* waitForNoApproval();
      }),
  );

  it.effect(
    'keeps the modal for a Kimi Code-exclusive model with no Moonshot fallback',
    () =>
      Effect.gen(function* () {
        mocks.preferKimiCode = true;
        mocks.hasUsableApiKey.mockImplementation(
          async (_secrets, provider: ApiProvider) => provider === 'moonshot',
        );
        tui();
        const pending = yield* Effect.forkChild(
          openRetry(kimiCodeSubscriptionRetry('kimi-exclusive', 'kimiCoding')),
        );

        // A stored Moonshot key must not auto-switch a kimi-for-coding model:
        // the coding endpoint is its only route, so the switch would retry the
        // same exhausted credential without a human decision. The modal is
        // shown without the API-key switch affordance, so the key availability
        // lookup is skipped as well.
        yield* waitForApproval('retry', { runId: runIdFor('kimi-exclusive') });
        expect(
          (
            currentApproval.get()?.payload as
              { tui?: { personalApiKeyAvailable?: boolean } } | undefined
          )?.tui?.personalApiKeyAvailable,
        ).toBeUndefined();
        expect(mocks.hasUsableApiKey).not.toHaveBeenCalled();
        decideRetry({ action: 'reject' });

        expect(yield* Fiber.join(pending)).toEqual({ action: 'reject' });
        expectNoCredentialChange();
        expect(mocks.notify).not.toHaveBeenCalledWith('credentialSwitched');
      }),
  );

  it.effect.each([
    {
      name: 'Kimi Code',
      retry: () => kimiCodeSubscriptionRetry('plan-no-key'),
    },
    { name: 'GLM Coding Plan', retry: () => glmCodingPlanRetry('plan-no-key') },
  ])(
    'falls back to the modal for a $name retry without a usable fallback key',
    ({ retry }) =>
      Effect.gen(function* () {
        mocks.preferKimiCode = true;
        mocks.glmCodingPlan = true;
        mocks.hasUsableApiKey.mockResolvedValue(false);
        tui();
        const pending = yield* Effect.forkChild(openRetry(retry()));

        yield* waitForApproval(
          'retry',
          { runId: runIdFor('plan-no-key') },
          { personalApiKeyAvailable: false },
        );
        decideRetry({ action: 'reject' });

        expect(yield* Fiber.join(pending)).toEqual({ action: 'reject' });
        expectNoCredentialChange();
      }),
  );

  it.effect('auto-switches a GLM Coding Plan limit to the stored GLM key', () =>
    Effect.gen(function* () {
      mocks.glmCodingPlan = true;
      mocks.hasUsableApiKey.mockImplementation(
        async (_secrets, provider: ApiProvider) => provider === 'glm',
      );
      tui();

      const decision = yield* openRetry(glmCodingPlanRetry('glm-limit'));

      expect(decision).toEqual(PERSONAL_KEY_RETRY);
      expectNoPreferenceWrites();
      expect(mocks.notify).toHaveBeenCalledWith('credentialSwitched');
      yield* waitForNoApproval();
    }),
  );

  it.effect(
    'does not offer or apply the subscription switch without an OpenAI API key',
    () =>
      Effect.gen(function* () {
        mocks.hasUsableApiKey.mockResolvedValue(false);
        tui();
        const pending = yield* Effect.forkChild(
          openRetry(chatGptSubscriptionRetry('missing-openai-key')),
        );

        yield* waitForApproval(
          'retry',
          { runId: runIdFor('missing-openai-key') },
          { personalApiKeyAvailable: false },
        );
        decideRetry({ action: 'reject' });

        expect(yield* Fiber.join(pending)).toEqual({ action: 'reject' });
        expectNoCredentialChange();
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
        expect(mocks.hasUsableApiKey).toHaveBeenCalledOnce();
        expectNoPreferenceWrites();
        expectChatGptSubscriptionRoute();
      }),
  );

  it.effect(
    'holds a preparing retry out of the queue, then joins behind the open modal',
    () =>
      Effect.gen(function* () {
        let resolveLookup: ((value: boolean) => void) | undefined;
        mocks.hasUsableApiKey.mockImplementation(
          () =>
            new Promise<boolean>((resolve) => {
              resolveLookup = resolve;
            }),
        );
        tui();
        const retry = yield* Effect.forkChild(
          openRetry(chatGptSubscriptionRetry('preparing-run')),
        );
        const bashRunId = runIdFor('bash-run');
        const bash = yield* Effect.forkChild(
          openRequest(bashRunId, {
            kind: 'bash',
            data: bashApprovalRequest({ command: 'echo ok', runId: bashRunId }),
          }),
        );

        yield* waitForApproval('bash', { runId: bashRunId });
        // The retry is listed from the moment it opens, but it is not a
        // request the user can act on until its key lookup finishes.
        yield* waitFor(() => expect(resolveLookup).toBeDefined());
        resolveLookup?.(false);
        yield* settle();
        // It joined behind the modal the user is already answering.
        expect(currentApproval.get()?.payload).toMatchObject({ kind: 'bash' });

        decideCurrent({ action: 'approve' });
        expect(yield* Fiber.join(bash)).toEqual({ action: 'approve' });

        yield* waitForApproval('retry', { runId: runIdFor('preparing-run') });
        decideRetry({ action: 'reject' });
        expect(yield* Fiber.join(retry)).toEqual({ action: 'reject' });
      }),
  );

  it.effect('cancels the retry modal when the run interrupts its request', () =>
    Effect.gen(function* () {
      mocks.hasUsableApiKey.mockResolvedValue(false);
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
