// The TUI host's side of the request protocol (one run model, 3.7): the
// bypass a decision turns on, and the credential work behind a retry on the user's own key. A run asks
// with `session.openRequest`; the surface answers with `request.decide`.

import { layer } from '@effect/vitest';
import { Effect, Fiber, Layer, Schema, SubscriptionRef, Context } from 'effect';
import { afterEach, beforeEach, expect, type MockInstance, vi } from 'vitest';
import { API_KEY_ENV_NAMES, apiKeySecretName } from '@texra-ai/llm';

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

import {
  RunIdSchema,
  type RequestPayload,
  type RetryRequest,
  type RunId,
} from '@texra-ai/harness/schemas';
import {
  attachInteractions,
  Interactions,
} from '@agent/runtime/HostInteractions';
import { openRequest as openRunRequest } from '@agent/runtime/requests';
import { currentApproval } from '@cli/chat/tui/state/approvalQueue';
import { bindSessionView } from '@cli/chat/tui/state/sessionView';
import { resetCliState, rootRunId } from '@cli/chat/tui/state/cliState';
import { createTuiHostInteractions } from '@cli/chat/tui/state/subscribeApprovals';
import type { CliRuntimeHost } from '@cli/runtime/headless/cliPresentationHost';
import {
  SessionLog,
  Approvals,
  SessionViewAccess,
  runStateAppend,
} from '@shared/session/runHistory';
import { createTuiCliContext } from '@test/cli/fixtures/cliContext';
import { installedHost } from '@test/support/setupPlatform';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';

import {
  holdTestRun,
  publishTestRunStart,
  setTestApprovalPolicy,
} from '@test/support/sessionTestUtils';
import {
  SessionGraph,
  sessionHandleOf,
  TestSession,
} from '@test/support/testKernel';
import {
  APPROVE_SESSION_ACTION,
  type SurfaceDecision,
} from '@texra/shared/session/surfaceDecision';
import { bashApprovalRequest } from '../agent/progressTestUtils';
import type { PlatformSecrets } from '@texra-ai/harness/host';

/** The settings the TUI's retry decisions write through, if any. */
const settingsStores = makeFakeSettingsStores();

/** The file's session as the harness holds it: its requests, interactions,
 *  log and view. */
const sessionHandle = Effect.flatMap(TestSession, sessionHandleOf);

/**
 * Close whatever the test did not answer: a request left open outlives its
 * test on the file's session, so the next one would read it at the head.
 */
const cancelOpenRequests = Effect.gen(function* () {
  const session = yield* sessionHandle;
  for (const request of SubscriptionRef.getUnsafe(
    Context.get(session, SessionViewAccess).ref,
  ).requests) {
    yield* (yield* TestSession)
      .request({
        kind: 'request.decide',
        runId: request.runId,
        requestId: request.requestId,
        decision: { action: 'cancel', cause: 'Test finished.' },
      })
      .pipe(Effect.ignore);
  }
  yield* Context.get(session, SessionLog).settled;
  resetCliState();
});

/**
 * Attach the TUI presentation host for one test, until its scope closes. It
 * answers nothing on its own: it stages what a request needs before it can
 * be shown, and performs the `useOwnApiKey` capability a retry decision
 * names. The scope's close detaches it, then cancels the requests left
 * open.
 */
const tui = Effect.gen(function* () {
  const cliContext = createTuiCliContext();
  setTestApprovalPolicy(cliContext.approvalPolicy);
  // cast: the TUI host interactions only emit through the presentation host.
  const presentationHost = {
    emit: vi.fn(),
    close: vi.fn(() => Effect.void),
  } as unknown as CliRuntimeHost;
  const session = yield* sessionHandle;
  yield* Effect.addFinalizer(() => cancelOpenRequests);
  yield* attachInteractions(
    Context.get(session, Interactions),
    createTuiHostInteractions(presentationHost, cliContext, {
      requests: yield* TestSession,
      settings: settingsStores.stores,
      runtime: yield* SessionGraph.runtime,
    }),
  );
});

/** Run ids are hex-branded, so a readable case label hashes to a stable one. */
function runIdFor(label: string): RunId {
  let hash = 0x811c9dc5;
  for (const character of label) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 0x01000193) >>> 0;
  }
  return Schema.decodeUnknownSync(RunIdSchema)(
    hash.toString(16).padStart(8, '0'),
  );
}

/** The runs this file opens requests on; a request is a row on its run, so
 *  the run exists before the first one opens. */
const started = new Set<RunId>();

function ensureRun(runId: RunId) {
  return Effect.gen(function* () {
    const root = rootRunId.get();
    if (root === undefined) rootRunId.set(runId);
    if (started.has(runId)) return;
    started.add(runId);
    const session = yield* sessionHandle;
    publishTestRunStart(session, runId, { parent: root ?? null });
    yield* Context.get(session, SessionLog).settled.pipe(Effect.orDie);
    yield* holdTestRun(session, runId);
  });
}

/** Ask through the protocol the TUI host answers: `request.opened` on the
 *  run, settled by the `request.decided` a surface commits. */
function openRequest(runId: RunId, payload: RequestPayload) {
  return Effect.gen(function* () {
    yield* ensureRun(runId);
    const session = yield* sessionHandle;
    const log = Context.get(session, SessionLog);
    return yield* openRunRequest(runId, payload, {
      commit: (rows) =>
        log
          .transact((tx) => runStateAppend(tx.append)(rows))
          .pipe(Effect.as(log.now())),
    }).pipe(Effect.provide(session));
  }).pipe(Effect.mapError((cause) => new Error(String(cause))));
}

function openRetry(permission: RetryRequest) {
  return openRequest(permission.runId, {
    kind: 'retry',
    data: permission,
  });
}

function chatGptSubscriptionRetry(label: string): RetryRequest {
  const message = 'ChatGPT subscription usage limit reached.';
  return {
    requestId: `retry-${label}`,
    runId: runIdFor(label),
    operation: 'model request',
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
const decideCurrent = (decision: SurfaceDecision) =>
  Effect.gen(function* () {
    currentApproval
      .get()
      ?.decide(yield* TestSession, yield* SessionGraph.runtime, decision);
  });

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

function waitForApproval(
  kind: string,
  data: Record<string, unknown>,
): Effect.Effect<void> {
  return waitFor(() => {
    expect(currentApproval.get()?.payload).toMatchObject({ kind, data });
  });
}

/** The session's view bound into the TUI's signal for the file, as the chat
 *  entry binds it. */
const boundSessionView = Layer.effectDiscard(
  Effect.gen(function* () {
    const view = Context.get(yield* sessionHandle, SessionViewAccess);
    const unbind = bindSessionView(yield* SessionGraph.runtime, {
      current: () => SubscriptionRef.getUnsafe(view.ref),
      changes: view.changes,
    });
    yield* Effect.addFinalizer(() => Effect.sync(unbind));
  }),
);

/** The OpenAI key's entry in the installed host's secret store. */
const OPENAI_KEY = apiKeySecretName('openai');

/** Reads of the installed host's secret store; a key check is a read of
 *  the provider's entry. Each case starts with no OpenAI key stored. */
let secretReads: MockInstance<PlatformSecrets['get']>;

/** Whether the store's OpenAI key entry was read: the own-key check. */
const openAiKeyChecks = (): number =>
  secretReads.mock.calls.filter(([key]) => key === OPENAI_KEY).length;

// One session for the file, its view bound for the file. Live clock: the
// host's key work and the surface's decisions settle on real event-loop
// turns.
layer(
  boundSessionView.pipe(
    Layer.provideMerge(TestSession.layer()),
    Layer.provideMerge(SessionGraph.hosted),
  ),
  { excludeTestServices: true },
)('TUI request decisions', (it) => {
  beforeEach(() => {
    const { secrets } = installedHost();
    secretReads = vi.spyOn(secrets, 'get');
    // The session runtime reads key variables from the process environment; a
    // blank one counts as unset, so an ambient key never stands in for one.
    for (const name of API_KEY_ENV_NAMES) vi.stubEnv(name, '');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    secretReads.mockRestore();
    await Effect.runPromise(installedHost().secrets.delete(OPENAI_KEY));
    mocks.setCliSubscriptionPreference.mockReset();
  });

  it.effect('sets the run bash bypass at the approval decision site', () =>
    Effect.gen(function* () {
      yield* tui;
      const runId = runIdFor('bash-bypass');
      const pending = yield* Effect.forkChild(
        openRequest(runId, {
          kind: 'bash',
          data: bashApprovalRequest({ command: 'echo ok', runId }),
        }),
      );

      yield* waitForApproval('bash', { runId });
      yield* decideCurrent({ action: APPROVE_SESSION_ACTION });

      expect(yield* Fiber.join(pending)).toEqual({ action: 'approve' });
      const session = yield* sessionHandle;
      yield* waitFor(() =>
        expect(
          Context.get(session, Approvals).bypass(runId, 'bash') !== null,
        ).toBe(true),
      );
    }),
  );

  it.effect(
    'switches a ChatGPT subscription retry to the API key only on the explicit decision',
    () =>
      Effect.gen(function* () {
        yield* installedHost().secrets.set(OPENAI_KEY, 'sk-own-key');
        yield* tui;
        const pending = yield* Effect.forkChild(
          openRetry(chatGptSubscriptionRetry('s3')),
        );

        yield* waitForApproval('retry', {
          runId: runIdFor('s3'),
          errorDetails: {
            message: 'ChatGPT subscription usage limit reached.',
          },
        });
        expect(openAiKeyChecks()).toBe(0);

        yield* decideCurrent(PERSONAL_KEY_RETRY);

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
});
