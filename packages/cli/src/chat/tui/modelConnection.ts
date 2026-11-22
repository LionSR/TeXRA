// The chat's "no model connected yet" state: the fact itself, the wait a
// message typed before connecting goes through, and re-resolving the chat's
// model once a credential lands (every model-access change this process
// announces). The "Connect a model" panel is the `/login` form in
// connect mode; everything else about the state lives here.

import { signal } from '@lit-labs/signals';
import { Effect, Latch, Stream } from 'effect';

import { apiKeyEntry } from '@texra-ai/llm';
import {
  appSignalStream,
  type ProcessServices,
  type RunModelDecisionReason,
} from '@texra-ai/harness/host';
import { type SettingsStores, withLogChannel } from '@texra-ai/harness/plugins';
import { toErrorMessage } from '@texra-ai/harness/schemas';
import type { CliPlatformServices } from '@cli/runtime/platform/initPlatform';
import { hasUsableSetupCredential } from '@texra/model/setupCredentialAccess';

import {
  patchSessionMeta,
  sessionMeta,
  setTransientNotice,
} from './state/cliState';
import {
  appendLocalErrorTranscript,
  appendLocalNotice,
} from './state/transcript';
import { selectChatModel } from './commands/handlers/slashContext';

/** A change in this process to what routes a model: a provider key, or an
 *  access preference (every sign-in and sign-out writes one). */
export const modelAccessChanges: Stream.Stream<void, never, ProcessServices> =
  Stream.merge(
    appSignalStream('credentialChanged').pipe(
      Stream.filter(({ key }) => {
        // An unknown provider's key routes no model.
        const provider = apiKeyEntry(key);
        return provider !== undefined && provider !== 'unknown';
      }),
    ),
    appSignalStream('modelAccessChanged'),
  ).pipe(Stream.as(undefined));

/**
 * No model route is usable yet: the chat opened without a credential, so the
 * "Connect a model" panel owns the first foreground slot and a submitted
 * message waits for a connection instead of failing. A process fact, not a
 * session one, so `/clear` leaves it alone.
 */
export const modelConnectionNeeded = signal(false);

/** The chat's model, connected or awaited: chat messages wait in order until
 *  it is (slash commands never wait: `/login` is how a connection happens). */
export interface ModelConnection {
  /** Waits until a model is connected; with none, puts the connect panel
   *  back in front first. */
  readonly connected: Effect.Effect<void>;
  /** The model is connected: every waiting message goes out. */
  readonly open: Effect.Effect<void>;
}

/** The chat's model connection, open unless {@link modelConnectionNeeded}.
 *  `openConnectPanel` puts the "Connect a model" panel in front. */
export function makeModelConnection(
  openConnectPanel: () => void,
): ModelConnection {
  const latch = Latch.makeUnsafe(!modelConnectionNeeded.get());
  return {
    connected: Effect.suspend(() => {
      if (Latch.isOpen(latch)) return Effect.void;
      setTransientNotice(
        'Connect a model and your message will be sent right away.',
      );
      openConnectPanel();
      return Latch.await(latch);
    }),
    open: Effect.sync(() => {
      Latch.openUnsafe(latch);
    }),
  };
}

/**
 * Startup's check: record whether the chat opens without a usable model. A
 * check that cannot be answered is not "no credential": the connect panel is
 * not forced on a user who may have one, the failure is said as a startup
 * notice, and the chat's model is resolved when a run asks for it.
 */
export const checkModelConnection = Effect.fn('checkModelConnection')(
  function* (services: CliPlatformServices) {
    const probe = yield* Effect.result(hasUsableSetupCredential(services));
    if (probe._tag === 'Failure') {
      yield* Effect.logWarning(
        `Setup credential check failed: ${probe.failure.message}`,
      ).pipe(withLogChannel('Setup Credentials'));
      return {
        ready: false,
        notice: `The model credential check failed, so no model was resolved at startup: ${probe.failure.message}`,
      };
    }
    modelConnectionNeeded.set(!probe.success);
    return { ready: probe.success, notice: undefined };
  },
);

/**
 * While the chat has no model, re-check on every model-access change, from
 * whichever surface made it (`/login`, `/key`, `/config`, a settings view).
 * When a model can answer: clear the state, resolve the chat's model the way
 * startup does, then let the waiting messages go.
 */
export const followModelConnection = (
  stores: SettingsStores,
  modelSource: RunModelDecisionReason,
  connection: ModelConnection,
): Effect.Effect<void, never, ProcessServices> =>
  Stream.runForEach(modelAccessChanges, () =>
    connectChatModel(stores, modelSource, connection),
  );

const connectChatModel = Effect.fn('connectChatModel')(function* (
  stores: SettingsStores,
  modelSource: RunModelDecisionReason,
  connection: ModelConnection,
) {
  if (!modelConnectionNeeded.get()) return;
  // A check that cannot be answered fails to the transcript report below and
  // leaves the panel state as it was.
  const ready = yield* hasUsableSetupCredential(stores);
  if (!ready) return;
  modelConnectionNeeded.set(false);
  // The waiting messages go once the model is resolved, or once resolving it
  // failed or stopped: a failure is said in the transcript, and a run
  // resolves the chat's model again when it starts.
  yield* Effect.suspend(() =>
    selectChatModel(stores, {
      model: sessionMeta.get().model,
      reason: modelSource,
    }),
  ).pipe(
    // A typed failure is said here; a defect goes to the reporting below, and
    // an interruption (the chat closing) goes on unreported.
    Effect.match({
      onFailure: (error) => appendLocalErrorTranscript(toErrorMessage(error)),
      onSuccess: ({ model }) => {
        patchSessionMeta({ model });
        appendLocalNotice(`Model connected: ${model}.`);
      },
    }),
    Effect.onInterrupt(() => connection.open),
    reportInTranscript,
    Effect.andThen(connection.open),
  );
}, reportInTranscript);

// Every step already speaks in the transcript; a failure or defect in one does
// too. An interruption is the chat closing, not a failure, so it goes on.
function reportInTranscript<A, E, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A | void, never, R> {
  const report = (error: unknown) =>
    Effect.sync(() => appendLocalErrorTranscript(toErrorMessage(error)));
  return self.pipe(Effect.catch(report), Effect.catchDefect(report));
}
