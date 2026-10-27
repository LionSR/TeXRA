// The TUI host's side of the request protocol (one run model, 3.7): the
// bypass a decision turns on, and the credential work behind a retry on the user's own key. A run asks
// with `session.openRequest`; the surface answers with `request.decide`.

import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber, SubscriptionRef } from 'effect';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  type MockInstance,
  vi,
} from 'vitest';
import {
  API_KEY_ENV_NAMES,
  apiKeySecretName,
  SecretsFailed,
} from '@texra-ai/llm';

const mocks = vi.hoisted(() => ({
  /** The key prompt: the user closes it without entering a key. */
  promptForCliProviderApiKey: vi.fn(() => Effect.void),
  setCliSubscriptionPreference: vi.fn(),
}));

vi.mock('@model/subscriptionAccess', async (importActual) => {
  const actual =
    await importActual<typeof import('@model/subscriptionAccess')>();
  const { get } = actual.SubscriptionPreference;
  return {
    ...actual,
    SubscriptionPreference: {
      ...actual.SubscriptionPreference,
      get: (...args: Parameters<typeof get>) =>
        args[0] === 'chatgpt' ? true : get(...args),
    },
  };
});

vi.mock('@cli/chat/tui/hosts/cliProviderKeys', async (importActual) => ({
  ...(await importActual<
    typeof import('@cli/chat/tui/hosts/cliProviderKeys')
  >()),
  promptForCliProviderApiKey: mocks.promptForCliProviderApiKey,
}));

vi.mock('@cli/chat/tui/notifications/terminalNotifier', () => ({
  notify: vi.fn(),
}));

vi.mock('@cli/chat/tui/state/subscriptionPreference', () => ({
  setCliSubscriptionPreference: mocks.setCliSubscriptionPreference,
}));

import { currentApproval } from '@cli/chat/tui/state/approvalQueue';
import { bindSessionView } from '@cli/chat/tui/state/sessionView';
import { resetCliState, rootRunId } from '@cli/chat/tui/state/cliState';
import { createTuiHostInteractions } from '@cli/chat/tui/state/subscribeApprovals';
import type { CliRuntimeHost } from '@cli/runtime/cliPresentationHost';
import {
  type PermissionPayload,
  type RequestDecision,
  type RetryPermission,
  type RunId,
} from '@shared/schemas';
import { testRuntime } from '@test/support/testProcessRuntime';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { createTuiCliContext } from '@test/cli/fixtures/cliContext';
import { installedHost } from '@test/support/setupPlatform';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';

import {
  publishTestRunStart,
  setTestApprovalPolicy,
} from '@test/support/sessionTestUtils';
import {
  APPROVE_SESSION_ACTION,
  type SurfaceDecision,
} from '@texra/shared/session/surfaceDecision';
import { bashApprovalRequest } from '../agent/progressTestUtils';
import type { PlatformSecrets } from '@texra-ai/harness';

/** The settings the TUI's retry decisions write through, if any. */
const settingsStores = makeFakeSettingsStores('cli');
let detachHost = (): void => {};

/**
 * Attach the TUI presentation host for one test. It answers nothing on its
 * own: it stages what a request needs before it can be shown, and performs
 * the `useOwnApiKey` capability a retry decision names.
 */
function tui(): void {
  const cliContext = createTuiCliContext();
  setTestApprovalPolicy(cliContext.approvalPolicy);
  const presentationHost = {
    emit: vi.fn(),
    close: vi.fn(() => Effect.void),
  } as unknown as CliRuntimeHost;
  detachHost();
  detachHost = Effect.runSync(
    testDefaultSession().interactions.use(
      createTuiHostInteractions(presentationHost, cliContext, {
        requests: testDefaultSession().requests,
        // The installed fake host's secret store: the key-check
        // expectations name exactly this object.
        secrets: installedHost().secrets,
        settings: settingsStores.stores,
        runtime: testRuntime(),
      }),
    ),
  );
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
    yield* session.log.settled.pipe(Effect.orDie);
  });
}

/** Ask through the protocol the TUI host answers: `request.opened` on the
 *  run, settled by the `request.decided` a surface commits. */
function openRequest(
  runId: RunId,
  payload: PermissionPayload,
): Effect.Effect<RequestDecision, Error> {
  return Effect.gen(function* () {
    yield* ensureRun(runId);
    return yield* testDefaultSession().requests.ask(runId, payload);
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

function chatGptSubscriptionRetry(label: string): RetryPermission {
  const message = 'ChatGPT subscription usage limit reached.';
  return {
    requestId: `retry-${label}`,
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
  currentApproval
    .get()
    ?.decide(testDefaultSession().requests, testRuntime(), decision);
}

/** The decision a retry on the user's own key lands. */
const PERSONAL_KEY_RETRY = {
  action: 'retry',
  credentials: 'personal',
} as const;

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

beforeAll(() => {
  const { view } = testDefaultSession();
  bindSessionView(testRuntime(), {
    current: () => SubscriptionRef.getUnsafe(view.ref),
    changes: view.changes,
  });
});

/** The OpenAI key's entry in the installed host's secret store. */
const OPENAI_KEY = apiKeySecretName('openai');

/** Reads of the installed host's secret store; a key check is a read of
 *  the provider's entry. Each case starts with no OpenAI key stored. */
let secretReads: MockInstance<PlatformSecrets['get']>;
/** The store's own read, for a case that holds only the OpenAI entry. */
let readSecret: PlatformSecrets['get'];

/** Whether the store's OpenAI key entry was read: the own-key check. */
const openAiKeyChecks = (): number =>
  secretReads.mock.calls.filter(([key]) => key === OPENAI_KEY).length;

beforeEach(() => {
  const { secrets } = installedHost();
  readSecret = secrets.get.bind(secrets);
  secretReads = vi.spyOn(secrets, 'get');
  // The session runtime reads key variables from the process environment; a
  // blank one counts as unset, so an ambient key never stands in for one.
  for (const name of API_KEY_ENV_NAMES) vi.stubEnv(name, '');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  detachHost();
  detachHost = () => {};
  // A request left open outlives its test on the file's session, so close
  // whatever this test did not answer before the next one reads the head.
  const session = testDefaultSession();
  for (const request of SubscriptionRef.getUnsafe(session.view.ref).requests) {
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
  await Effect.runPromise(session.log.settled);
  resetCliState();
  secretReads.mockRestore();
  await Effect.runPromise(installedHost().secrets.delete(OPENAI_KEY));
  mocks.setCliSubscriptionPreference.mockReset();
});

describe('TUI request decisions', () => {
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
          testDefaultSession().approvals.bypass(runId, 'bash') !== null,
        ).toBe(true),
      );
    }),
  );

  it.effect(
    'switches a ChatGPT subscription retry to the API key only on the explicit decision',
    () =>
      Effect.gen(function* () {
        yield* installedHost().secrets.set(OPENAI_KEY, 'sk-own-key');
        tui();
        const pending = yield* Effect.forkChild(
          openRetry(chatGptSubscriptionRetry('s3')),
        );

        yield* waitForApproval('retry', {
          runId: runIdFor('s3'),
          errorMessage: 'ChatGPT subscription usage limit reached.',
        });
        expect(openAiKeyChecks()).toBe(0);

        decideCurrent(PERSONAL_KEY_RETRY);

        expect(yield* Fiber.join(pending)).toEqual(PERSONAL_KEY_RETRY);
        // The decision is the whole switch: the run declines the exhausted
        // route on its own run history, so the user's stored preference is not
        // rewritten on their behalf.
        expect(mocks.setCliSubscriptionPreference).not.toHaveBeenCalled();
        // The shared key entry checks the provider the run's offer named,
        // finds its key, and asks for none.
        expect(openAiKeyChecks()).toBe(1);
        expect(mocks.promptForCliProviderApiKey).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    'does not publish a retry decision after its key lookup outlives the host',
    () =>
      Effect.gen(function* () {
        let finishLookup: (() => void) | undefined;
        const lookupCaptured = Deferred.makeUnsafe<void>();
        secretReads.mockImplementation((key) =>
          key !== OPENAI_KEY
            ? readSecret(key)
            : Effect.tryPromise({
                try: () =>
                  new Promise<string | undefined>((_resolve, reject) => {
                    finishLookup = () =>
                      reject(new Error('Keychain unavailable'));
                    Deferred.doneUnsafe(lookupCaptured, Effect.void);
                  }),
                catch: (cause) =>
                  new SecretsFailed({
                    reason: 'io',
                    operation: 'get',
                    message: String(cause),
                    key,
                  }),
              }),
        );
        tui();
        const permission = chatGptSubscriptionRetry('disposed-key');
        const pending = yield* Effect.forkChild(openRetry(permission));
        yield* waitForApproval('retry', { runId: permission.runId });
        decideCurrent(PERSONAL_KEY_RETRY);
        yield* Deferred.await(lookupCaptured);
        detachHost();
        detachHost = () => {};
        finishLookup?.();
        yield* settle();
        yield* testDefaultSession().log.settled;
        expect(
          SubscriptionRef.getUnsafe(
            testDefaultSession().view.ref,
          ).requests.some(
            (request) => request.requestId === permission.requestId,
          ),
        ).toBe(true);
        yield* Fiber.interrupt(pending);
      }),
  );
});
