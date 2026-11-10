// The TUI host's side of the request protocol (one run model, 3.7): the
// bypass a decision turns on, and the credential work behind a retry on the
// user's own key. A run asks with `session.openRequest`; the surface answers
// with `request.decide`, which the session stores as the request's
// `request.decided`.

import { computed } from '@lit-labs/signals';
import { layer } from '@effect/vitest';
import { Context, Effect, Fiber, Layer, Schema, SubscriptionRef } from 'effect';
import { expect } from 'vitest';
import { apiKeySecretName } from '@texra-ai/llm';

import { SubscriptionPreference } from '@texra-ai/harness/host';
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
import { startChat, rootRunId } from '@cli/chat/tui/state/cliState';
import { createTuiHostInteractions } from '@cli/chat/tui/state/subscribeApprovals';
import { createCliRuntimeHost } from '@cli/runtime/headless/cliPresentationHost';
import { subscribeToSignalChanges } from '@texra/shared/signals';
import type { HostCommand } from '@texra/shared/session/hostRequest';
import {
  SessionLog,
  SessionViewAccess,
  runStateAppend,
} from '@shared/session/runHistory';
import { createTuiCliContext } from '@test/cli/fixtures/cliContext';
import {
  holdTestRun,
  publishTestRunStart,
  setTestApprovalPolicy,
} from '@test/support/sessionTestUtils';
import { storedRows } from '@test/support/storeFaults';
import {
  FakeHost,
  SessionGraph,
  sessionHandleOf,
  TestSession,
} from '@test/support/testKernel';
import {
  APPROVE_SESSION_ACTION,
  type SurfaceDecision,
} from '@texra/shared/session/surfaceDecision';
import { bashApprovalRequest } from '../agent/progressTestUtils';

/** The file's session as the harness holds it: its requests, interactions,
 *  log and view. */
const sessionHandle = Effect.flatMap(TestSession, sessionHandleOf);

/** Done once `holds` reads true of the TUI's signals. */
const until = (holds: () => boolean): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    const watched = computed(holds);
    if (watched.get()) return resume(Effect.void);
    const unsubscribe = subscribeToSignalChanges([watched], () => {
      if (!watched.get()) return;
      unsubscribe();
      resume(Effect.void);
    });
    return Effect.sync(unsubscribe);
  });

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
  startChat();
});

/**
 * Attach the TUI presentation host for one test, in a fresh conversation,
 * until its scope closes, over the host's own settings. It answers nothing on its own: it stages
 * what a request needs before it can be shown, and performs the
 * `useOwnApiKey` capability a retry decision names. The scope's close
 * detaches it, cancels the requests left open, then drops the stored OpenAI
 * key, so each case starts with none.
 */
const tui = Effect.gen(function* () {
  // A fresh conversation: the chat's root decides where this file's runs
  // hang, and an earlier suite in the worker may have left its own.
  startChat();
  const { roots, secrets } = yield* FakeHost;
  yield* Effect.addFinalizer(() =>
    secrets.delete(OPENAI_KEY).pipe(Effect.orDie),
  );
  const cliContext = createTuiCliContext();
  yield* setTestApprovalPolicy(cliContext.approvalPolicy);
  const session = yield* sessionHandle;
  yield* Effect.addFinalizer(() => cancelOpenRequests);
  const interactions = createTuiHostInteractions(
    createCliRuntimeHost(cliContext),
    cliContext,
    {
      requests: yield* TestSession,
      settings: roots,
      runtime: yield* SessionGraph.runtime,
    },
  );
  yield* attachInteractions(Context.get(session, Interactions), interactions);
  return interactions.performHost;
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
    yield* publishTestRunStart(session, runId, { parent: root ?? null });
    yield* Context.get(session, SessionLog).settled.pipe(Effect.orDie);
    yield* holdTestRun(session, runId);
  });
}

/** Ask through the protocol the TUI host answers: `request.opened` on the
 *  run, answered by the `request.decided` a surface commits. A command is
 *  the shell's, which the run's command grant answers. */
function openRequest(runId: RunId, payload: RequestPayload) {
  return Effect.gen(function* () {
    yield* ensureRun(runId);
    const session = yield* sessionHandle;
    const log = Context.get(session, SessionLog);
    return yield* openRunRequest(runId, payload, {
      ...(payload.kind === 'bash' && { operation: 'bash' }),
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
  return {
    requestId: `retry-${label}`,
    runId: runIdFor(label),
    operation: 'model request',
    failure: {
      source: 'model',
      kind: 'provider-rejection',
      message: 'Usage limit reached.',
      quota: { plan: 'chatgpt-subscription' },
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

/** Answer the request the modal is showing, with the attached host's
 *  `performHost`. */
const decideCurrent = (
  performHost: (command: HostCommand) => void,
  decision: SurfaceDecision,
) =>
  Effect.gen(function* () {
    currentApproval.get()?.decide(
      {
        requests: yield* TestSession,
        runtime: yield* SessionGraph.runtime,
        performHost,
      },
      decision,
    );
  });

/** The decision a retry on the user's own key lands. */
const PERSONAL_KEY_RETRY = {
  action: 'retry',
  credentials: 'personal',
} as const;

/** Done once the modal shows a `kind` request whose data matches `data`. */
const untilApproval = (kind: string, data: { readonly runId: RunId }) =>
  until(() => {
    const payload = currentApproval.get()?.payload;
    return payload?.kind === kind && payload.data.runId === data.runId;
  });

/** The stored rows of `type` on `runId`, as the session's store holds them,
 *  their data decoded. */
const storedOf = (runId: RunId, type: string) =>
  Effect.gen(function* () {
    const session = yield* sessionHandle;
    yield* Context.get(session, SessionLog).settled.pipe(Effect.orDie);
    const { roots } = yield* FakeHost;
    return storedRows(roots.storage)
      .filter((row) => row.run === runId && row.type === type)
      .map((row): unknown => JSON.parse(row.data));
  });

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

/** The OpenAI key's entry in the fake host's secret store. */
const OPENAI_KEY = apiKeySecretName('openai');

// One persistent session for the file, its view bound for the file. Live
// clock: the host's key work and the surface's decisions finish on real
// event-loop turns.
layer(
  boundSessionView.pipe(
    Layer.provideMerge(TestSession.layer(undefined, { persistent: true })),
    Layer.provideMerge(SessionGraph.hosted),
  ),
  { excludeTestServices: true },
)('TUI request decisions', (it) => {
  it.effect('sets the run bash bypass at the approval decision site', () =>
    Effect.gen(function* () {
      const performHost = yield* tui;
      const runId = runIdFor('bash-bypass');
      const pending = yield* Effect.forkChild(
        openRequest(runId, {
          kind: 'bash',
          data: bashApprovalRequest({ command: 'echo ok', runId }),
        }),
      );

      yield* untilApproval('bash', { runId });
      yield* decideCurrent(performHost, { action: APPROVE_SESSION_ACTION });
      yield* Fiber.join(pending);

      expect(yield* storedOf(runId, 'request.decided')).toMatchObject([
        { decision: { action: 'approve' } },
      ]);
      // The grant the approval offered is the run's own from now on.
      expect(yield* storedOf(runId, 'approval.policy')).toMatchObject([
        { snapshot: { own: { bash: 'on' } } },
      ]);
    }),
  );

  it.effect(
    'switches a ChatGPT subscription retry to the API key only on the explicit decision',
    () =>
      Effect.gen(function* () {
        const { roots, secrets } = yield* FakeHost;
        yield* secrets.set(OPENAI_KEY, 'sk-own-key');
        // The run is on the ChatGPT subscription the user prefers.
        yield* SubscriptionPreference.set('chatgpt', roots, true).pipe(
          Effect.orDie,
        );
        const performHost = yield* tui;
        const runId = runIdFor('s3');
        const pending = yield* Effect.forkChild(
          openRetry(chatGptSubscriptionRetry('s3')),
        );

        yield* untilApproval('retry', { runId });
        yield* decideCurrent(performHost, PERSONAL_KEY_RETRY);
        yield* Fiber.join(pending);

        // The decision is the whole switch: the run declines the exhausted
        // route on its own run history, and the stored key served it
        // without a prompt.
        expect(yield* storedOf(runId, 'request.decided')).toMatchObject([
          { decision: PERSONAL_KEY_RETRY },
        ]);
        // The user's stored preference is not rewritten on their behalf.
        expect(SubscriptionPreference.get('chatgpt', roots)).toBe(true);
      }),
  );
});
