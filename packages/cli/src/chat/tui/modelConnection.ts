// The chat's "no model connected yet" state: the fact itself, the wait a
// message typed before connecting goes through, and re-resolving the chat's
// model once a credential lands. The "Connect a model" panel is the `/login` form in
// connect mode; everything else about the state lives here.

import { signal } from '@lit-labs/signals';
import { Effect, Latch, Result } from 'effect';

import {
  withLogChannel,
  type RunModelDecisionReason,
} from '@texra-ai/harness/host';
import { toErrorMessage } from '@texra-ai/harness/schemas';
import { setCliHelperModel } from '@cli/runtime/initPlatform';
import {
  formatCliNoAvailableModelsRecovery,
  selectCliRunnableModel,
  type CliNoAvailableModelsRecoveryOptions,
} from '@cli/runtime/modelAccess';
import type { CliPlatformServices } from '@cli/runtime/initPlatform';
import { SETUP_AGENT_HANDOFF_NOTICE } from '@cli/onboarding/setupContinuation';
import { hasUsableSetupCredential } from '@texra/model/setupCredentialAccess';

import { applyInitialCliAgentSelection } from './commands/handlers/agentModelCommands';
import { openRegisteredCliSlashForm } from './commands/slashForms';
import {
  patchSessionMeta,
  sessionMeta,
  setTransientNotice,
} from './state/cliState';
import { chatTuiCanStartRootRun } from './state/sessionRunState';
import {
  appendLocalErrorTranscript,
  appendLocalNotice,
} from './state/transcript';
import type { SlashCommandContext } from './commands/handlers/slashContext';

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
  /** The model is connected: every waiting message goes out. True when one
   *  was waiting. */
  readonly open: Effect.Effect<boolean>;
}

/** The chat's model connection, open unless {@link modelConnectionNeeded}.
 *  `openConnectPanel` puts the "Connect a model" panel in front. */
export function makeModelConnection(
  openConnectPanel: () => void,
): ModelConnection {
  const latch = Latch.makeUnsafe(!modelConnectionNeeded.get());
  let waiting = 0;
  return {
    connected: Effect.suspend(() => {
      if (Latch.isOpen(latch)) return Effect.void;
      setTransientNotice(
        'Connect a model and your message will be sent right away.',
      );
      openConnectPanel();
      waiting += 1;
      return Latch.await(latch).pipe(
        Effect.ensuring(Effect.sync(() => (waiting -= 1))),
      );
    }),
    open: Effect.sync(() => {
      const messageWaiting = waiting > 0;
      Latch.openUnsafe(latch);
      return messageWaiting;
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
 * Re-check after an account change. When a model can answer now: clear the
 * state, resolve the chat's model the way startup does, hand a first run to
 * the setup agent, then let the waiting messages go — or, with none waiting
 * on a first run, open `/agent` so a newcomer sees the agents and teams.
 */
export const connectChatModel = Effect.fn('connectChatModel')(function* (
  context: SlashCommandContext,
  options: {
    readonly modelSource: RunModelDecisionReason;
    readonly recovery: CliNoAvailableModelsRecoveryOptions;
    readonly firstRunSetupAgent: string | undefined;
  },
  connection: ModelConnection,
) {
  if (!modelConnectionNeeded.get()) return;
  const { stores, runtime } = context;
  // A check that cannot be answered fails to the transcript report below and
  // leaves the panel state as it was.
  const ready = yield* hasUsableSetupCredential(stores);
  // Checked again after the read: a recheck forked by an earlier form may
  // have connected meanwhile, and only one connects.
  if (!ready || !modelConnectionNeeded.get()) return;
  modelConnectionNeeded.set(false);
  const setupAgent = options.firstRunSetupAgent;
  // The waiting messages go once the model is resolved, or once resolving it
  // failed or stopped: a failure is said in the transcript, and a run
  // resolves the chat's model again when it starts.
  const messageWaiting = yield* Effect.gen(function* () {
    // A typed failure is said here; a defect goes to the reporting below, and
    // an interruption (the chat closing) goes on unreported.
    const selection = yield* Effect.result(
      selectCliRunnableModel(
        [{ model: sessionMeta.get().model, reason: options.modelSource }],
        {
          stores: { ...stores, runtime },
          noAvailableModelsMessage: formatCliNoAvailableModelsRecovery(
            options.recovery,
          ),
        },
      ),
    );
    if (Result.isFailure(selection)) {
      appendLocalErrorTranscript(toErrorMessage(selection.failure));
    } else {
      patchSessionMeta({ model: selection.success.model });
      yield* setCliHelperModel(stores.globalState, selection.success.model);
      appendLocalNotice(`Model connected: ${selection.success.model}.`);
    }
    if (setupAgent && chatTuiCanStartRootRun(context.session)) {
      yield* applyInitialCliAgentSelection(setupAgent, context);
      appendLocalNotice(SETUP_AGENT_HANDOFF_NOTICE);
    }
  }).pipe(
    Effect.onInterrupt(() => connection.open),
    reportInTranscript,
    Effect.andThen(connection.open),
  );
  if (!messageWaiting && setupAgent)
    openRegisteredCliSlashForm(context.commands.agent);
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
