// The app's native message boxes, each a call of `choose` over Electron's
// `showMessageBox`. A dialog a project's run raised names that project, since
// the window may be showing another.

import { BrowserWindow, dialog, type MessageBoxOptions } from 'electron';
import { Effect, Predicate, type Scope } from 'effect';

import { withLogChannel } from '@texra-ai/worldline/plugins';
import { fromHost } from '@texra/controllers/session/hostCallFailure';
import type {
  HostFailed,
  ConfirmQuestion,
  NoticeLevel,
} from '@texra/hosts/uiHosts';
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
  return fromHost(
    'dialog.showMessageBox',
    () => {
      const window =
        parent ??
        BrowserWindow.getFocusedWindow() ??
        BrowserWindow.getAllWindows().find((open) => !open.isDestroyed());
      return window
        ? dialog.showMessageBox(window, options)
        : dialog.showMessageBox(options);
    },
    `A desktop ${box.type} dialog could not be shown`,
  ).pipe(Effect.map(({ response }) => choices[response]?.value));
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
    /** A message with one button per label, closed by "Dismiss": the
     *  label chosen, or `undefined` when closed. With no labels it is a
     *  plain notice with the platform's own OK. */
    ask: (
      level: NoticeLevel,
      message: string,
      labels: readonly string[],
      project?: string,
    ): Effect.Effect<string | undefined, HostFailed> =>
      choose(window, {
        type: level,
        message,
        project,
        choices: labels.map((label) => ({ label, value: label })),
        ...(labels.length > 0 && { close: 'Dismiss' }),
      }),
    /** The export's format dialog; a cancelled dialog answers `undefined`. */
    pickTranscriptExportFormat: (project: string) =>
      fromHost(
        'pickTranscriptExportFormat',
        () => import('@texra/controllers/progressView/exportTranscript'),
      ).pipe(
        Effect.flatMap(
          ({ TRANSCRIPT_EXPORT_FORMAT_CHOICES, TRANSCRIPT_EXPORT_PICK }) =>
            choose(window, {
              type: 'question',
              message: TRANSCRIPT_EXPORT_PICK.title,
              detail: TRANSCRIPT_EXPORT_PICK.prompt,
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
      ),
  };
}
