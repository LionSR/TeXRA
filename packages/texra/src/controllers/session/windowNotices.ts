/**
 * The notices with buttons a GUI window shows, worded and wired once for the
 * extension and the desktop: a request's failure (with "Read the guide" when
 * it names a docs page), an instruction (its key's actions, plus "Never
 * remind again" where the key allows it), and a GitHub token GitHub
 * rejected. A host supplies only its message with buttons; the verbs the
 * buttons run are the ones the window's requests run (`openGuiWindow`).
 */

// Third-party imports
import { Effect, Schema, Stream } from 'effect';

// Local imports
import type {
  HostPresentation,
  RuntimePresentationEventPayloads,
} from '@texra-ai/worldline';
import {
  appSignalStream,
  type PresentationEventHandlers,
} from '@texra-ai/worldline/host';
import {
  Settings,
  withLogChannel,
  type StateStore,
} from '@texra-ai/worldline/plugins';
import {
  decodingDefault,
  type RequestShowErrorPayload,
  type StateKey,
} from '@texra-ai/worldline/schemas';
import type { HostFailed, NoticeLevel } from '@texra/hosts/uiHosts';
import { settingsTabByCommand } from '@texra/shared/commands/catalog';
import type { SettingsTarget } from '@texra/shared/settingsView/settingsTarget';
import {
  INSTRUCTION_ACTION,
  INSTRUCTION_ACTION_BUTTON_LABELS,
  instructionActions,
  instructionSuppressible,
  READ_GUIDE_BUTTON_LABEL,
  type InstructionAction,
} from '@ui/copy/instructionActions';
import { shownFailureText } from '@ui/copy/modelAccess';

const CHANNEL = 'windowNotices';

const NEVER_REMIND = 'Never remind again';
const OPEN_GIT_SETTINGS = 'Open Git settings';

/** A message with one button per label: the label chosen, or `undefined`
 *  when the person dismissed it. */
export type AskNotice = (
  level: NoticeLevel,
  message: string,
  labels: readonly string[],
) => Effect.Effect<string | undefined, HostFailed>;

/** What a window's notices run: its host's message with buttons, and the
 *  window's own verbs behind the buttons. */
interface WindowNoticeHost {
  readonly ask: AskNotice;
  /** Ask for a provider API key, as the window's banner and onboarding
   *  card do. */
  readonly setApiKey: Effect.Effect<void, Error>;
  /** Open a page of the TeXRA guide. */
  openGuide(page: string): Effect.Effect<void, Error>;
  /** Where "Never remind again" is kept. */
  readonly globalState: StateStore;
}

/** A dismissal flag is off until the person chooses "Never remind again". */
const SilencedSchema = decodingDefault(Schema.Boolean, false);

const silencedFlag = (key: string) =>
  ({
    key: `instruction.${key}`,
    slot: 'globalState',
    schema: SilencedSchema,
  }) as const satisfies StateKey<boolean>;

/**
 * Ask an information notice with `labels` and "Never remind again", unless
 * the person chose that for `key` before. Answers the label chosen, and
 * `undefined` when the notice was dismissed, silenced, or silenced now.
 */
export const askUnlessSilenced = Effect.fn('askUnlessSilenced')(function* (
  ask: AskNotice,
  store: StateStore,
  key: string,
  message: string,
  labels: readonly string[],
) {
  const flag = silencedFlag(key);
  if (yield* Settings.state(store, flag)) return undefined;
  const choice = yield* ask('info', message, [...labels, NEVER_REMIND]);
  if (choice !== NEVER_REMIND) return choice;
  yield* store.update(flag.key, true);
  return undefined;
});

/** What each instruction action's button runs. */
const ACTION_RUN: Record<
  InstructionAction,
  (host: WindowNoticeHost) => Effect.Effect<void, Error>
> = {
  [INSTRUCTION_ACTION.SET_API_KEY]: (host) => host.setApiKey,
  [INSTRUCTION_ACTION.OPEN_CONFIGURATION_GUIDE]: (host) =>
    host.openGuide('configuration'),
  [INSTRUCTION_ACTION.OPEN_MODELS_DOC]: (host) => host.openGuide('models'),
};

/**
 * A window's failure and instruction notices. Each answers with the program
 * that presents it, which waits for the person's answer: the session forks
 * it, and warn-logs a notice the host could not show.
 */
export function windowNotices(
  host: WindowNoticeHost,
): Omit<
  PresentationEventHandlers<RuntimePresentationEventPayloads, HostPresentation>,
  'openFile'
> {
  const requestShowError = (
    failure: RequestShowErrorPayload,
  ): Effect.Effect<void, Error> => {
    const { docsPage } = failure;
    return host
      .ask(
        'error',
        shownFailureText(failure),
        docsPage ? [READ_GUIDE_BUTTON_LABEL] : [],
      )
      .pipe(
        Effect.flatMap((choice) =>
          choice && docsPage
            ? // The notice has been answered: a guide that fails to open is
              // a diagnostic.
              host.openGuide(docsPage).pipe(
                Effect.ignore({
                  log: 'Warn',
                  message: `Failed to open the ${docsPage} guide`,
                }),
                withLogChannel(CHANNEL),
              )
            : Effect.void,
        ),
      );
  };
  return {
    requestShowError,
    requestShowInstruction: ({ key, message }) => {
      const actions = instructionActions(key);
      const labels = actions.map(
        (action) => INSTRUCTION_ACTION_BUTTON_LABELS[action],
      );
      const asked = instructionSuppressible(key)
        ? askUnlessSilenced(host.ask, host.globalState, key, message, labels)
        : host.ask('info', message, labels);
      return asked.pipe(
        // The instruction may be a launch failure's only surface, so one
        // that could not be shown falls back to the error notice.
        Effect.catchCause((cause) =>
          Effect.logWarning(`Failed to show instruction "${key}"`, cause).pipe(
            withLogChannel(CHANNEL),
            Effect.andThen(requestShowError({ message })),
            Effect.as(undefined),
          ),
        ),
        Effect.flatMap((choice) => {
          const action = actions.find(
            (token) => INSTRUCTION_ACTION_BUTTON_LABELS[token] === choice,
          );
          return action === undefined
            ? Effect.void
            : ACTION_RUN[action](host).pipe(
                Effect.ignore({
                  log: 'Warn',
                  message: `The instruction action "${INSTRUCTION_ACTION_BUTTON_LABELS[action]}" failed`,
                }),
                withLogChannel(CHANNEL),
              );
        }),
      );
    },
  };
}

/**
 * Tell the person each time GitHub rejects the stored token, with a button
 * to the Git settings where they replace it, until the caller interrupts.
 * Each notice waits on a fiber of its own, so a second rejection does not
 * wait behind an unanswered one, and the interrupt closes any still open.
 */
export const followGitHubTokenRejections = <R>(
  ask: AskNotice,
  openSettings: (target: SettingsTarget) => Effect.Effect<void, Error, R>,
) =>
  appSignalStream('githubTokenInvalid').pipe(
    Stream.runForEach(({ message }) =>
      ask('error', `GitHub token rejected: ${message}`, [
        OPEN_GIT_SETTINGS,
      ]).pipe(
        Effect.flatMap((choice) =>
          choice === OPEN_GIT_SETTINGS
            ? openSettings(settingsTabByCommand['texra.showGitSettings'])
            : Effect.void,
        ),
        Effect.ignore({
          log: 'Warn',
          message: 'The rejected GitHub token notice failed',
        }),
        withLogChannel(CHANNEL),
        Effect.forkChild,
      ),
    ),
  );
