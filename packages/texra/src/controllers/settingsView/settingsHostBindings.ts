/**
 * The table a GUI host binds behind the shared settings body
 * (`sharedSettingsCommands.ts`): everything the host performs its own way,
 * and nothing it decides.
 */
import { Cause, Effect, PubSub } from 'effect';

import { withLogChannel } from '@texra-ai/harness/host';
import { formatError } from '@texra-ai/harness/schemas';
import type {
  Dialogs,
  ExternalOpener,
  NoticeLevel,
} from '@texra/hosts/uiHosts';
import type { EditorIntegrationShape } from '@texra/hosts/editorIntegration';
import type { SubscriptionProviderId } from '@texra/controllers/modelAccess/subscriptionProviders';
import { SETTINGS_VIEW_COMMANDS } from '@texra/shared/ipc';
import type {
  SettingsHostPage,
  SettingsHostState,
  SettingsViewOutboundMessage,
} from '@texra/shared/settingsView/settingsViewMessages';
import type { ProcessServices } from '@texra-ai/harness/host';
import type { RunId } from '@texra-ai/harness/schemas';

type HostEffect<A = void> = Effect.Effect<A, Error, ProcessServices>;

export const SETTINGS_LOG_CHANNEL = 'SettingsView';

/** What a host performs its own way behind the settings body. */
export interface SettingsHostBindings {
  /** Build and post one message to the open settings view; neither when
   *  none is open, so a closed view costs no reads. */
  post<E, R>(
    message: Effect.Effect<SettingsViewOutboundMessage, E, R>,
  ): Effect.Effect<void, E | Error, R>;
  readonly dialogs: Dialogs;
  readonly externalOpener: ExternalOpener;
  /** Open a file to read or edit it. */
  openPath(filePath: string): HostEffect;
  /** Show a file or folder in the system file manager. */
  revealPath(filePath: string): HostEffect;
  /** Show YAML the user must not save back over where it came from. */
  showReadOnlyYaml(filePath: string, text: string): HostEffect;
  pickFolder(title: string): HostEffect<string | undefined>;
  /** Reload the agent, team and model catalogs every open launcher shows,
   *  selecting the tool-use root a team just applied named. */
  refreshCatalogs(selectedToolUseAgent?: string): HostEffect;
  /** Re-read the credential probes outside this view: the launcher's
   *  banners and the onboarding funnel. */
  readonly refreshCredentialStatus: HostEffect;
  /** Run one subscription's sign-in, its routing preference included. */
  signInSubscription(providerId: SubscriptionProviderId): HostEffect;
  /** Select a run in the host's run view. */
  revealRun(runId: RunId): HostEffect<'revealed' | 'missing' | 'unavailable'>;
  runLabel(runId: RunId): string | undefined;
  /** Run a command in a terminal the user sees and can type into. */
  runInTerminal(name: string, command: string): HostEffect;
  /** The host's code editor, where it has one: the LaTeX page shows its
   *  recommended settings and LaTeX Workshop, and a plugin card offers to
   *  install the extension it names. */
  readonly editor?: EditorIntegrationShape;
  /** A workspace-target config write needs an open folder (the extension). */
  readonly requiresOpenWorkspace?: () => boolean;
}

/**
 * What a settings page's data is read from. A mutation says which input it
 * changed, never which page shows it; each page names the inputs it
 * follows. `view` is the view (re)opening, which every page follows.
 */
export type SettingsInput =
  | 'view'
  | 'settings'
  | 'credentials'
  | 'subscriptions'
  | 'usage'
  | 'agents'
  | 'github'
  | 'memory'
  | 'plugins'
  | 'latex';

/** One page of the view: the message it builds, rebuilt as its inputs
 *  change. */
export interface SettingsPage<R> {
  readonly follows: readonly SettingsInput[];
  readonly build: Effect.Effect<SettingsViewOutboundMessage, Error, R>;
}

/** A page whose data is one field of the host state. */
export const hostStatePage = <K extends SettingsHostPage, R>(
  page: K,
  follows: readonly SettingsInput[],
  build: Effect.Effect<SettingsHostState[K], Error, R>,
): SettingsPage<R> => ({
  follows,
  build: Effect.map(build, (value) => ({
    command: SETTINGS_VIEW_COMMANDS.UPDATE_HOST_STATE,
    // cast: a computed key widens to an index signature; `page` names
    // exactly this one field.
    patch: { [page]: value } as Partial<SettingsHostState>,
  })),
});

/** How the settings body tells the user and repaints, as its page modules
 *  use it. */
export interface SettingsPresentation {
  readonly post: SettingsHostBindings['post'];
  /** Say an input changed; the pages that follow it rebuild. */
  changed(input: SettingsInput): Effect.Effect<void>;
  /** An informational notice the program does not wait on. */
  notice(message: string): Effect.Effect<void>;
  /** An error notice the program does not wait on; logged as well. */
  alert(message: string): Effect.Effect<void>;
  /** {@link alert} for `prefix: reason`. */
  report(prefix: string, cause: unknown): Effect.Effect<void>;
  /** Run `program`, reporting its failure as `prefix: reason`. */
  reported<E, R>(
    prefix: string,
    program: Effect.Effect<void, E, R>,
  ): Effect.Effect<void, never, R>;
}

/** The presentation every page of the body reports through: a notice never
 *  holds the program that raised it. */
export function settingsPresentation(
  bindings: SettingsHostBindings,
  inputs: PubSub.PubSub<SettingsInput>,
): SettingsPresentation {
  const shown = (level: NoticeLevel, message: string) =>
    Effect.asVoid(Effect.forkDetach(bindings.dialogs.notify(level, message)));
  const alert = (message: string) =>
    Effect.andThen(
      Effect.logError(message).pipe(withLogChannel(SETTINGS_LOG_CHANNEL)),
      shown('error', message),
    );
  const report = (prefix: string, cause: unknown) =>
    alert(formatError(prefix, cause));
  return {
    post: bindings.post,
    changed: (input) => Effect.asVoid(PubSub.publish(inputs, input)),
    notice: (message) => shown('info', message),
    alert,
    report,
    // An interrupt is the runtime going away with the view it would report
    // to, so it passes through rather than raising a dialog.
    reported: (prefix, program) =>
      program.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : report(prefix, Cause.squash(cause)),
        ),
      ),
  };
}
