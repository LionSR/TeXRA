// The app's native message boxes, each a call of `choose` over Electron's
// `showMessageBox`. A dialog a project's run raised names that project, since
// the window may be showing another.

import { BrowserWindow, dialog, type MessageBoxOptions } from 'electron';
import { Effect, Predicate, type Scope } from 'effect';

import { withLogChannel } from '@texra-ai/harness/plugins';
import { ensureError, toErrorMessage } from '@texra-ai/harness/schemas';
import {
  HostFailed,
  type ConfirmQuestion,
  type NoticeLevel,
} from '@texra/hosts/uiHosts';
import { TranscriptExportFailed } from '@texra/controllers/progressView/transcriptExportFailure';
import {
  INSTRUCTION_ACTION_BUTTON_LABELS,
  READ_GUIDE_BUTTON_LABEL,
  type InstructionAction,
} from '@ui/copy/instructionActions';
import type { DesktopSpawn } from './desktopWindows.js';

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

interface MessageBox<T> {
  readonly type: NonNullable<MessageBoxOptions['type']>;
  readonly message: string;
  readonly detail?: string;
  /** The project the box is about, shown as its title. */
  readonly project?: string;
  /** The answers, one button each. The default button is the one marked
   *  `default`, else the closing button. */
  readonly choices: readonly {
    readonly label: string;
    readonly value: T;
    readonly default?: true;
  }[];
  /** The closing button's label, after the choices; a box with no choices
   *  and no label shows the platform's own OK. */
  readonly close?: string;
}

/**
 * Ask the user to pick one of `box.choices`, answering its value, or
 * `undefined` when they close the box. The box sits on `parent`; one with no
 * window of its own (a startup warning) sits on the focused window, else any
 * open one, else on none.
 */
export function choose<T>(
  parent: BrowserWindow | undefined,
  box: MessageBox<T>,
): Effect.Effect<T | undefined, HostFailed> {
  const { choices } = box;
  const closeId = choices.length;
  const defaultIndex = choices.findIndex((choice) => choice.default);
  const options: MessageBoxOptions = {
    type: box.type,
    message: box.message,
    ...inProject(box.project, box.detail),
    ...((choices.length > 0 || box.close !== undefined) && {
      buttons: [...choices.map((choice) => choice.label), box.close ?? 'OK'],
      defaultId: defaultIndex === -1 ? closeId : defaultIndex,
      cancelId: closeId,
    }),
  };
  return Effect.tryPromise({
    try: () => {
      const window =
        parent ??
        BrowserWindow.getFocusedWindow() ??
        BrowserWindow.getAllWindows().find((open) => !open.isDestroyed());
      return window
        ? dialog.showMessageBox(window, options)
        : dialog.showMessageBox(options);
    },
    catch: (cause) =>
      new HostFailed({
        member: 'dialog.showMessageBox',
        message: `A desktop ${box.type} dialog could not be shown: ${toErrorMessage(cause)}`,
        cause,
      }),
  }).pipe(Effect.map(({ response }) => choices[response]?.value));
}

/** Show a box with nothing to answer on a fiber of `scope`, without waiting
 *  for the user. One that cannot be shown is logged with what it said, and
 *  once `scope` has closed a notice starts nothing. */
export const noticeIn =
  (scope: Scope.Scope) =>
  (type: 'info' | 'warning', message: string): Effect.Effect<void> =>
    choose(undefined, { type, message, choices: [] }).pipe(
      Effect.catch((error) =>
        Effect.logWarning(`${error.message}: ${message}`).pipe(
          withLogChannel('desktop'),
        ),
      ),
      Effect.forkIn(scope),
      Effect.asVoid,
    );

export function createDesktopDialogs(
  window: BrowserWindow,
  /** The window's fibers, where a notice waits for its dismissal. */
  spawn: DesktopSpawn,
  actions: {
    /** Open the guide page a refusal names. */
    openGuide(docsPage: string): void;
    dispatchInstructionAction(action: InstructionAction): void;
  },
) {
  /** A message box nobody answers or waits for, held by the window; one
   *  the window cannot show is logged at warn, and once the window's scope
   *  has closed a notice starts nothing. */
  const notify = (
    level: NoticeLevel,
    message: string,
    project?: string,
  ): Effect.Effect<void> =>
    Effect.sync(() =>
      spawn(
        choose(window, { type: level, message, project, choices: [] }).pipe(
          Effect.catch((error) =>
            Effect.logWarning(error.message).pipe(withLogChannel('desktop')),
          ),
          Effect.asVoid,
        ),
      ),
    );
  return {
    notify,
    confirm: (
      question: ConfirmQuestion,
      project?: string,
    ): Effect.Effect<boolean, HostFailed> =>
      choose(window, {
        type: 'warning',
        message: question.message,
        detail: question.detail,
        project,
        choices: [{ label: question.action, value: true, default: true }],
        close: 'Cancel',
      }).pipe(Effect.map((confirmed) => confirmed ?? false)),
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
      return choose(window, {
        type: 'error',
        message,
        project,
        choices: [{ label: READ_GUIDE_BUTTON_LABEL, value: docsPage }],
        close: 'OK',
      }).pipe(
        Effect.map((page) => {
          if (page) actions.openGuide(page);
        }),
      );
    },
    /**
     * Instructions (e.g. a missing API key) are actionable guidance, not
     * failures, so this stays an 'info' dialog, with each action token as a
     * real button. A native dialog has no persistent "never remind again"
     * control, so no notice is silenced here (`instructionSuppressible`).
     */
    showInstructionDialog: (
      message: string,
      choices: readonly InstructionAction[],
      project: string,
    ): Effect.Effect<void, HostFailed> =>
      choose(window, {
        type: 'info',
        message,
        project,
        choices: choices.map((action) => ({
          label: INSTRUCTION_ACTION_BUTTON_LABELS[action],
          value: action,
        })),
        close: 'Dismiss',
      }).pipe(
        Effect.map((action) => {
          if (action) actions.dispatchInstructionAction(action);
        }),
      ),
    /** The export's format dialog; a cancelled dialog answers `undefined`. */
    pickTranscriptExportFormat: (project: string) =>
      Effect.tryPromise({
        try: () => import('@texra/controllers/progressView/exportTranscript'),
        catch: ensureError,
      }).pipe(
        Effect.flatMap(({ TRANSCRIPT_EXPORT_FORMAT_CHOICES }) =>
          choose(window, {
            type: 'question',
            message: 'Export transcript',
            detail: 'Choose a format',
            project,
            choices: TRANSCRIPT_EXPORT_FORMAT_CHOICES.map(
              ({ label, format }, index) => ({
                label,
                value: format,
                ...(index === 0 && { default: true as const }),
              }),
            ),
            close: 'Cancel',
          }),
        ),
        Effect.mapError(
          (cause) =>
            new TranscriptExportFailed({
              message: toErrorMessage(cause),
              cause,
            }),
        ),
      ),
  };
}
