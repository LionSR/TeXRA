/**
 * The table a GUI host binds behind the shared settings body
 * (`sharedSettingsCommands.ts`): everything the host performs its own way,
 * and nothing it decides.
 */
import { Cause, Effect } from 'effect';

import { formatError } from '@common/errors/errorFormatUtils';
import type { SignInFailed } from '@common/errors/signInFailed';
import type {
  TeamAvailabilityChoice,
  TeamCatalogPortFailed,
} from '@common/teams/TeamAvailabilityPreflight';
import type { TeamAvailabilityPrompt } from '@common/teams/TeamPlan';
import type { SubscriptionProviderId } from '@controllers/modelAccess/subscriptionProviders';
import type {
  ExternalOpener,
  MessageHost,
  NotificationFailed,
  PromptHost,
} from '@hosts/uiHosts';
import { withLogChannel } from '@logger/effectLog';
import type { ProcessServices } from '@platform/processRuntime';
import type { RunId } from '@shared/schemas';
import type { SettingsViewOutboundMessage } from '@shared/settingsView/settingsViewMessages';

type HostEffect<A = void> = Effect.Effect<A, Error, ProcessServices>;

export const SETTINGS_LOG_CHANNEL = 'SettingsView';

/** What a host performs its own way behind the settings body. */
export interface SettingsHostBindings {
  /** Build and post one message to the open settings view; neither when
   *  none is open, so a closed view costs no reads. */
  post<E, R>(
    message: Effect.Effect<SettingsViewOutboundMessage, E, R>,
  ): Effect.Effect<void, E | Error, R>;
  readonly notify: Pick<MessageHost, 'showInfoMessage' | 'showErrorMessage'>;
  readonly prompt: Pick<PromptHost, 'input' | 'confirm' | 'info' | 'warning'>;
  readonly externalOpener: ExternalOpener;
  /** Open a file to read or edit it. */
  openPath(filePath: string): HostEffect;
  /** Show a file or folder in the system file manager. */
  revealPath(filePath: string): HostEffect;
  /** Show YAML the user must not save back over where it came from. */
  showReadOnlyYaml(fileName: string, text: string): HostEffect;
  pickFolder(title: string): HostEffect<string | undefined>;
  /** Reload the agent, team and model catalogs every open launcher shows,
   *  selecting the tool-use root a team just applied named. */
  refreshCatalogs(selectedToolUseAgent?: string): HostEffect;
  /** Re-read the credential probes outside this view: the launcher's
   *  banners and the onboarding funnel. */
  readonly refreshCredentialStatus: HostEffect;
  /** Run one subscription's sign-in, its routing preference included. */
  signInSubscription(providerId: SubscriptionProviderId): HostEffect;
  createAgentWithAI(category: 'workflow' | 'toolUse'): HostEffect;
  /** The custom agent directory setting changed. */
  readonly customAgentDirChanged: HostEffect;
  readonly remoteCatalog: {
    canAccess(): Effect.Effect<boolean>;
    signIn(): Effect.Effect<boolean, SignInFailed>;
  };
  chooseTeamAvailability(
    prompt: TeamAvailabilityPrompt,
  ): Effect.Effect<TeamAvailabilityChoice | undefined, TeamCatalogPortFailed>;
  /** Select a run in the host's run view. */
  revealRun(runId: RunId): HostEffect<'revealed' | 'missing' | 'unavailable'>;
  runLabel(runId: RunId): string | undefined;
  /** A catalog-backed setting was written; the host's own side effects. */
  stateSettingApplied(key: string): HostEffect;
  /** The opening data of the pages only the host answers (Tools, LaTeX). */
  readonly postHostStartup: HostEffect;
  /** A workspace-target config write needs an open folder (the extension). */
  readonly requiresOpenWorkspace?: () => boolean;
}

/** How the settings body tells the user and repaints, as its page modules
 *  use it. */
export interface SettingsPresentation {
  readonly post: SettingsHostBindings['post'];
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
 *  holds the program that raised it, and a refused notice is logged. */
export function settingsPresentation(
  bindings: SettingsHostBindings,
): SettingsPresentation {
  const shown = (notice: Effect.Effect<void, NotificationFailed>) =>
    Effect.forkDetach(
      notice.pipe(
        Effect.catchTag('NotificationFailed', (failure) =>
          Effect.logWarning(
            `Could not show a settings notice: ${failure.message}`,
          ).pipe(withLogChannel(SETTINGS_LOG_CHANNEL)),
        ),
      ),
    ).pipe(Effect.asVoid);
  const alert = (message: string) =>
    Effect.andThen(
      Effect.logError(message).pipe(withLogChannel(SETTINGS_LOG_CHANNEL)),
      shown(bindings.notify.showErrorMessage(message)),
    );
  const report = (prefix: string, cause: unknown) =>
    alert(formatError(prefix, cause));
  return {
    post: bindings.post,
    notice: (message) => shown(bindings.notify.showInfoMessage(message)),
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
