// The window's native dialogs, each a program over Electron's `showMessageBox`
// that raises the failure its port names. A dialog a project's run raised
// names that project, since the window may be showing another.

import { type BrowserWindow, dialog } from 'electron';
import { Effect } from 'effect';

import { TeamCatalogPortFailed } from '@common/teams/TeamAvailabilityPreflight';
import type { TeamAvailabilityPrompt } from '@common/teams/TeamPlan';
import { TranscriptExportFailed } from '@controllers/progressView/transcriptExportFailure';
import { NotificationFailed, PromptFailed } from '@hosts/uiHosts';
import { INSTRUCTION_ACTION, type InstructionAction } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

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
      .filter((line) => line !== undefined)
      .join('\n\n'),
  };
}

export function createDesktopDialogs(
  window: BrowserWindow,
  actions: {
    /** Open the guide page a refusal names. */
    openGuide(docsCommand: string): void;
    dispatchInstructionAction(action: InstructionAction): void;
  },
) {
  const showMessageBoxOfType =
    (
      member: NotificationFailed['member'],
      type: 'error' | 'info' | 'warning',
    ) =>
    (
      message: string,
      project?: string,
    ): Effect.Effect<void, NotificationFailed> =>
      Effect.tryPromise({
        try: async () => {
          await dialog.showMessageBox(window, {
            type,
            message,
            ...inProject(project),
          });
        },
        catch: (cause) =>
          new NotificationFailed({
            member,
            message: toErrorMessage(cause),
            cause,
          }),
      });
  const showErrorMessage = showMessageBoxOfType('showErrorMessage', 'error');
  return {
    showErrorMessage,
    showInfoMessage: showMessageBoxOfType('showInfoMessage', 'info'),
    showWarningMessage: showMessageBoxOfType('showWarningMessage', 'warning'),
    /**
     * Shared shape for the "confirm this action" dialog: a warning with a
     * confirm button (defaulted, id 0) and a 'Cancel' button (id 1),
     * collapsed to a boolean. Used by confirmAcceptFile, the agent-settings
     * confirm prompt, the credential-settings confirm prompt, and
     * settingsUi.confirmAction.
     */
    confirmDialog: (options: {
      message: string;
      title?: string;
      detail?: string;
      confirmLabel?: string;
      project?: string;
    }): Effect.Effect<boolean, PromptFailed> =>
      Effect.tryPromise({
        try: () =>
          dialog.showMessageBox(window, {
            type: 'warning',
            ...inProject(options.project, options.detail),
            ...(options.title === undefined ? {} : { title: options.title }),
            message: options.message,
            buttons: [options.confirmLabel ?? 'OK', 'Cancel'],
            defaultId: 0,
            cancelId: 1,
          }),
        catch: (cause) =>
          new PromptFailed({
            reason: 'presentation-failed',
            member: 'confirm',
            message: `The confirmation dialog could not be shown: ${toErrorMessage(cause)}`,
            cause,
          }),
      }).pipe(Effect.map((result) => result.response === 0)),
    /**
     * Sole owner of the native unavailable-member prompt. Both the main-view
     * launch path and settings path route here so wording and button labels
     * cannot drift. The Electron dialog is the team-availability `choose`
     * port's own foreign edge, so it is wrapped here once and raises the
     * port's `TeamCatalogPortFailed`.
     */
    presentTeamAvailabilityPrompt: (
      prompt: TeamAvailabilityPrompt,
      project?: string,
    ): Effect.Effect<
      'sign-in' | 'continue' | 'cancel',
      TeamCatalogPortFailed
    > =>
      Effect.tryPromise({
        try: async () => {
          const { response } = await dialog.showMessageBox(window, {
            type: prompt.severity,
            message: prompt.message,
            ...inProject(project),
            buttons: prompt.actions.map((action) => action.label),
            defaultId: 0,
            cancelId: 2,
          });
          return prompt.actions[response]?.choice ?? 'cancel';
        },
        catch: (cause) =>
          new TeamCatalogPortFailed({
            member: 'choose',
            message: `The host could not ask about the unavailable members: ${toErrorMessage(cause)}`,
            cause,
          }),
      }),
    /**
     * A failure is an 'error' dialog; a refusal that names a docs page
     * (`docsCommand`, e.g. a launch without an input file) adds a guide
     * button so the desktop dialog keeps the link the extension's
     * request-error callout renders. The URL path is host-originated, never
     * network data.
     */
    showErrorDialog: (
      message: string,
      docsCommand: string | undefined,
      project: string,
    ): Effect.Effect<void, NotificationFailed> => {
      if (!docsCommand) return showErrorMessage(message, project);
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
          new NotificationFailed({
            member: 'showErrorMessage',
            message: `A desktop error dialog could not be shown: ${toErrorMessage(cause)}`,
            cause,
          }),
      }).pipe(
        Effect.map(({ response }) => {
          if (response === 0) actions.openGuide(docsCommand);
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
      tokens: readonly InstructionAction[] | undefined,
      project: string,
    ): Effect.Effect<void, NotificationFailed> => {
      const choices = tokens ?? [];
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
          new NotificationFailed({
            member: 'showInfoMessage',
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
            await import('@controllers/progressView/exportTranscript');
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
            step: 'pickFormat',
            message: toErrorMessage(cause),
            cause,
          }),
      }),
  };
}
