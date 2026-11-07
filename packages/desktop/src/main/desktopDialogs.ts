// The window's native dialogs, each a program over Electron's `showMessageBox`
// that raises the failure its port names. A dialog a project's run raised
// names that project, since the window may be showing another.

import { type BrowserWindow, dialog } from 'electron';
import { Effect, Predicate } from 'effect';

import { withLogChannel } from '@texra-ai/harness/host';
import { ensureError, toErrorMessage } from '@texra-ai/harness/schemas';
import {
  HostFailed,
  type ConfirmQuestion,
  type NoticeLevel,
} from '@texra/hosts/uiHosts';
import { TranscriptExportFailed } from '@texra/controllers/progressView/transcriptExportFailure';
import {
  INSTRUCTION_ACTION,
  type InstructionAction,
} from '@ui/copy/instructionActions';

// Button labels for the instruction dialog below. Desktop has one settings
// home (Settings tab), so SET_API_KEY opens it directly rather than the
// extension's separate "enter a key" quick pick.
const INSTRUCTION_ACTION_BUTTON_LABELS: Record<InstructionAction, string> = {
  [INSTRUCTION_ACTION.SET_API_KEY]: 'Set API Key',
  [INSTRUCTION_ACTION.OPEN_CONFIGURATION_GUIDE]: 'Configuration Guide',
  [INSTRUCTION_ACTION.OPEN_MODELS_DOC]: 'Model Documentation',
};

/** The project as the title where the platform draws one, and as a line of
 *  detail on macOS, which draws none. */
function inProject(project: string | undefined, detail?: string) {
  if (project === undefined) return { detail };
  return {
    title: project,
    detail: [detail, `Project: ${project}`]
      .filter(Predicate.isNotUndefined)
      .join('\n\n'),
  };
}

export function createDesktopDialogs(
  window: BrowserWindow,
  actions: {
    /** Open the guide page a refusal names. */
    openGuide(docsPage: string): void;
    dispatchInstructionAction(action: InstructionAction): void;
  },
) {
  /** A message box nobody answers; one that cannot be shown (its window
   *  gone) is logged at warn. */
  const notify = (
    level: NoticeLevel,
    message: string,
    project?: string,
  ): Effect.Effect<void> =>
    Effect.tryPromise({
      try: () =>
        dialog.showMessageBox(window, {
          type: level,
          message,
          ...inProject(project),
        }),
      catch: ensureError,
    }).pipe(
      Effect.asVoid,
      Effect.catch((cause) =>
        Effect.logWarning(
          `A desktop ${level} dialog could not be shown: ${cause.message}`,
        ).pipe(withLogChannel('desktop')),
      ),
    );
  return {
    notify,
    /**
     * A warning with the action's button (defaulted, id 0) and 'Cancel'
     * (id 1), collapsed to a boolean.
     */
    confirm: (
      question: ConfirmQuestion,
      project?: string,
    ): Effect.Effect<boolean, HostFailed> =>
      Effect.tryPromise({
        try: () =>
          dialog.showMessageBox(window, {
            type: 'warning',
            ...inProject(project, question.detail),
            message: question.message,
            buttons: [question.action, 'Cancel'],
            defaultId: 0,
            cancelId: 1,
          }),
        catch: (cause) =>
          new HostFailed({
            member: 'dialog.showMessageBox',
            message: `The confirmation dialog could not be shown: ${toErrorMessage(cause)}`,
            cause,
          }),
      }).pipe(Effect.map((result) => result.response === 0)),
    /**
     * A failure is an 'error' dialog; a refusal that names a docs page
     * (`docsPage`, e.g. a launch without an input file) adds a guide
     * button so the desktop dialog keeps the link the extension's
     * request-error callout renders. The URL path is host-originated, never
     * network data.
     */
    showErrorDialog: (
      message: string,
      docsPage: string | undefined,
      project: string,
    ): Effect.Effect<void, HostFailed> => {
      if (!docsPage) return notify('error', message, project);
      return Effect.tryPromise({
        try: () =>
          dialog.showMessageBox(window, {
            type: 'error',
            message,
            ...inProject(project),
            buttons: ['Read the guide', 'OK'],
            defaultId: 1,
            cancelId: 1,
          }),
        catch: (cause) =>
          new HostFailed({
            member: 'dialog.showMessageBox',
            message: `A desktop error dialog could not be shown: ${toErrorMessage(cause)}`,
            cause,
          }),
      }).pipe(
        Effect.map(({ response }) => {
          if (response === 0) actions.openGuide(docsPage);
        }),
      );
    },
    /**
     * Instructions (e.g. a missing API key) are actionable guidance, not
     * failures, so this stays an 'info' dialog — but each action token
     * renders as a real button instead of degrading to trailing hint text
     * with nothing to click. `showSuppress` still has no affordance to attach
     * to: a native dialog has no persistent "never remind again" control.
     */
    showInstructionDialog: (
      message: string,
      choices: readonly InstructionAction[],
      project: string,
    ): Effect.Effect<void, HostFailed> => {
      const buttons = [
        ...choices.map((token) => INSTRUCTION_ACTION_BUTTON_LABELS[token]),
        'Dismiss',
      ];
      const dismissId = buttons.length - 1;
      return Effect.tryPromise({
        try: () =>
          dialog.showMessageBox(window, {
            type: 'info',
            message,
            ...inProject(project),
            buttons,
            defaultId: dismissId,
            cancelId: dismissId,
          }),
        catch: (cause) =>
          new HostFailed({
            member: 'dialog.showMessageBox',
            message: `The instruction dialog could not be shown: ${toErrorMessage(cause)}`,
            cause,
          }),
      }).pipe(
        Effect.map(({ response }) => {
          const action = choices[response];
          if (action) actions.dispatchInstructionAction(action);
        }),
      );
    },
    /** The export's format dialog; a cancelled dialog answers `undefined`. */
    pickTranscriptExportFormat: (project: string) =>
      Effect.tryPromise({
        try: async () => {
          const { TRANSCRIPT_EXPORT_FORMAT_CHOICES } =
            await import('@texra/controllers/progressView/exportTranscript');
          const { response } = await dialog.showMessageBox(window, {
            type: 'question',
            message: 'Export transcript',
            ...inProject(project, 'Choose a format'),
            buttons: [
              ...TRANSCRIPT_EXPORT_FORMAT_CHOICES.map((choice) => choice.label),
              'Cancel',
            ],
            defaultId: 0,
            cancelId: TRANSCRIPT_EXPORT_FORMAT_CHOICES.length,
          });
          return TRANSCRIPT_EXPORT_FORMAT_CHOICES[response]?.format;
        },
        catch: (cause) =>
          new TranscriptExportFailed({
            message: toErrorMessage(cause),
            cause,
          }),
      }),
  };
}
