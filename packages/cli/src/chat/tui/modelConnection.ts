// The chat's "no model connected yet" state: the fact itself, the message a
// user typed before connecting, and re-resolving the chat's model once a
// credential lands. The "Connect a model" panel is the `/login` form in
// connect mode; everything else about the state lives here.

import { signal } from '@lit-labs/signals';
import { Cause, Effect, Exit } from 'effect';

import { setCliHelperModel } from '@cli/runtime/initPlatform';
import {
  formatCliNoAvailableModelsRecovery,
  selectCliRunnableModel,
  type CliNoAvailableModelsRecoveryOptions,
} from '@cli/runtime/modelAccess';
import type { CliPlatformServices } from '@cli/runtime/initPlatform';
import { SETUP_AGENT_HANDOFF_NOTICE } from '@cli/onboarding/setupContinuation';
import { withLogChannel } from '@logger/effectLog';
import { hasUsableSetupCredential } from '@model/setupCredentialAccess';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { applyInitialCliAgentSelection } from './commands/handlers/agentModelCommands';
import { openCliSlashCommandForm } from './commands/slashForms';
import { parseSlashInput } from './commands/slashRegistry';
import {
  patchSessionMeta,
  sessionMeta,
  setTransientNotice,
} from './state/cliState';
import { chatTuiCanStartRootRun } from './state/sessionRunState';
import { appendLocalAssistantTranscript } from './state/transcript';
import type {
  SlashCommandContext,
  SlashCommandEffect,
} from './commands/handlers/slashContext';
import type { PastedImageEntry } from './input/draftAttachments';

/**
 * No model route is usable yet: the chat opened without a credential, so the
 * "Connect a model" panel owns the first foreground slot and a submitted
 * message waits for a connection instead of failing. A process fact, not a
 * session one, so `/clear` leaves it alone.
 */
export const modelConnectionNeeded = signal(false);

interface HeldMessage {
  readonly line: string;
  readonly mediaFiles: readonly string[] | undefined;
  readonly images: readonly PastedImageEntry[] | undefined;
}

let heldMessage: HeldMessage | undefined;

/**
 * With no model connected, keep a chat message (the latest wins) and put the
 * connect panel back in front; the connection sends it. Slash commands never
 * wait: `/login` is how a connection happens. True when the message was held.
 */
export function holdUntilConnected(message: HeldMessage): boolean {
  if (!modelConnectionNeeded.get() || parseSlashInput(message.line)) {
    return false;
  }
  heldMessage = message;
  setTransientNotice(
    'Connect a model and your message will be sent right away.',
  );
  openCliSlashCommandForm('login', '');
  return true;
}

/** Startup's check: record whether the chat opens without a usable model. */
export const checkModelConnection = Effect.fn('checkModelConnection')(
  function* (services: CliPlatformServices) {
    const ready = yield* hasUsableSetupCredential(
      services,
      services.secrets,
    ).pipe(withLogChannel('Setup Credentials'));
    modelConnectionNeeded.set(!ready);
    return ready;
  },
);

/**
 * Re-check after an account change. When a model can answer now: clear the
 * state, resolve the chat's model the way startup does, hand a first run to
 * the setup agent, then send the held message — or, with none waiting on a
 * first run, open `/agent` so a newcomer sees the agents and teams.
 */
export const connectChatModel = Effect.fn('connectChatModel')(function* (
  context: SlashCommandContext,
  options: {
    readonly startupModel: string;
    readonly modelSource: Parameters<
      typeof selectCliRunnableModel
    >[1]['fallbackReason'];
    readonly recovery: CliNoAvailableModelsRecoveryOptions;
    readonly firstRunSetupAgent: string | undefined;
  },
  send: (message: HeldMessage) => SlashCommandEffect,
) {
  if (!modelConnectionNeeded.get()) return;
  const { stores, secrets, runtime } = context;
  const ready = yield* hasUsableSetupCredential(stores, secrets).pipe(
    withLogChannel('Setup Credentials'),
  );
  if (!ready) return;
  modelConnectionNeeded.set(false);
  const selection = yield* Effect.exit(
    selectCliRunnableModel(sessionMeta.get().model || options.startupModel, {
      stores: { ...stores, secrets, runtime },
      fallbackReason: options.modelSource,
      noAvailableModelsMessage: formatCliNoAvailableModelsRecovery(
        options.recovery,
      ),
    }),
  );
  if (Exit.isFailure(selection)) {
    appendLocalAssistantTranscript(
      toErrorMessage(Cause.squash(selection.cause)),
    );
  } else {
    patchSessionMeta({ model: selection.value.model });
    yield* setCliHelperModel(stores.globalState, selection.value.model);
    appendLocalAssistantTranscript(
      `Model connected: ${selection.value.model}.`,
    );
  }
  const setupAgent = options.firstRunSetupAgent;
  if (setupAgent && chatTuiCanStartRootRun(context.session)) {
    yield* applyInitialCliAgentSelection(setupAgent, context);
    appendLocalAssistantTranscript(SETUP_AGENT_HANDOFF_NOTICE);
  }
  const held = heldMessage;
  heldMessage = undefined;
  if (held) yield* send(held);
  else if (setupAgent) openCliSlashCommandForm('agent', '');
}, Effect.catchCause(reportInTranscript));

// Every step already speaks in the transcript; a failure in one does too.
function reportInTranscript(cause: Cause.Cause<unknown>) {
  return Effect.sync(() =>
    appendLocalAssistantTranscript(toErrorMessage(Cause.squash(cause))),
  );
}
