// The completion, busy-frame and error plumbing every built-in slash form
// runs its selection through.

import { Cause, Effect, Fiber } from 'effect';

import { toErrorMessage } from '@texra-ai/harness/schemas';

import { formProgress, setTransientNotice } from '../state/cliState';
import {
  appendLocalErrorTranscript,
  appendLocalNotice,
} from '../state/transcript';
import {
  type SlashCommandContext,
  type SlashCommandEffect,
  type SlashCommandOutput,
  transcriptSlashCommandOutput,
} from './handlers/slashContext';
import type { SlashFormProps } from './slashRegistry';

type SelectionCompletion = 'afterAction' | 'beforeAction' | 'busy';

/** A slash form's failure, said in the transcript. */
export const reportFormError = (error: unknown): void =>
  appendLocalErrorTranscript(toErrorMessage(error));

/** A form's selection does what the command's handler does: an action over
 *  the chat's slash context. */
export type FormAction<T> = (
  value: T,
  context: SlashCommandContext,
  output: SlashCommandOutput,
) => SlashCommandEffect;

/**
 * Bind a slash form's selection to its action: it runs on the chat's
 * runtime, a failure is said in the transcript, and it completes through the
 * form's done and persistence props. A picker passes only its action and
 * what it overrides.
 */
export function bindSelection<T>(
  context: SlashCommandContext,
  props: SlashFormProps,
  action: FormAction<T>,
  overrides: {
    readonly onDone?: (value: T) => void;
    readonly completion?: SelectionCompletion;
    readonly busyTitle?: (value: T) => string;
  } = {},
): (value: T) => void {
  const { runtime } = context;
  const { onPersist, echoOnPersist = false } = props;
  const onDone = overrides.onDone ?? props.onDone;
  const { completion = 'afterAction', busyTitle } = overrides;
  // Reporting is a step of the failure path, not a wait inside it.
  const reportError = (error: unknown): Effect.Effect<void> =>
    Effect.sync(() => reportFormError(error));
  return (value) => {
    if (completion === 'busy') {
      // The submission token is the single owner of "is this submission still
      // live": a new chat starts with no `formProgress`, so a stale token can never
      // match the current progress.
      const token = Symbol('form submission');
      const currentProgress = () => {
        const current = formProgress.get();
        return current?.token === token ? current : undefined;
      };
      const close = (): void => {
        if (!currentProgress()) return;
        formProgress.set(undefined);
        onDone(value);
      };
      // The running submission IS the forked fiber below, so Escape
      // interrupts it instead of detaching from a promise that keeps running.
      const cancel = (): void => {
        if (!currentProgress()) return;
        runtime.runFork(Fiber.interrupt(actionFiber));
        formProgress.set(undefined);
        onDone(value);
      };
      const title = busyTitle?.(value) ?? 'Working';
      const archiveCopyable = (): void => {
        const current = currentProgress();
        if (!current?.copyableMessage || current.copyableMessageArchived) {
          return;
        }
        if (echoOnPersist) onPersist?.();
        appendLocalNotice(current.copyableMessage);
        formProgress.set({
          ...current,
          message: 'Authentication instructions were written to scrollback.',
          copyableMessageArchived: true,
        });
      };
      formProgress.set({
        token,
        status: 'running',
        title,
        archiveCopyable,
        cancel,
        dismiss: close,
      });

      const output: SlashCommandOutput = {
        appendOutcome: (message) => {
          if (!currentProgress()) return;
          if (echoOnPersist) onPersist?.();
          appendLocalNotice(message);
          const current = currentProgress();
          if (current) formProgress.set({ ...current, message });
        },
        setNotice: (message) => {
          if (currentProgress()) setTransientNotice(message);
        },
        writeProgress: (message, options) => {
          const current = currentProgress();
          if (!current) return;
          // Guidance must outlive the next status line, which replaces it here.
          if (options?.persistent) {
            if (echoOnPersist) onPersist?.();
            appendLocalNotice(message);
          }
          formProgress.set({
            ...current,
            message,
            ...(options?.copyable
              ? { copyableMessage: message, copyableMessageArchived: false }
              : {}),
          });
        },
      };

      const actionFiber = runtime.runFork(
        Effect.suspend(() => action(value, context, output)).pipe(
          Effect.matchCauseEffect({
            onSuccess: () =>
              Effect.sync(() => {
                const current = currentProgress();
                if (!current) return;
                if (current.copyableMessage) {
                  formProgress.set({ ...current, status: 'succeeded' });
                } else {
                  close();
                }
              }),
            onFailure: Effect.fn('formSelection.onFailure')(function* (cause) {
              let current = currentProgress();
              if (!current) return;
              if (echoOnPersist) onPersist?.();
              const error = Cause.squash(cause);
              const errorMessage = toErrorMessage(error);
              const copyableMessage = current.copyableMessage;
              yield* reportError(
                copyableMessage
                  ? new Error(`${errorMessage}\n${copyableMessage}`)
                  : error,
              );
              current = currentProgress();
              if (!current) return;
              if (current.copyableMessage) {
                formProgress.set({
                  ...current,
                  status: 'failed',
                  message: errorMessage,
                });
              } else {
                close();
              }
            }),
          }),
        ),
      );
      return;
    }

    if (echoOnPersist) onPersist?.();
    if (completion === 'beforeAction') {
      onDone(value);
    }

    runtime.runFork(
      Effect.suspend(() =>
        action(value, context, transcriptSlashCommandOutput),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.suspend(() => {
            if (!echoOnPersist) onPersist?.();
            return reportError(Cause.squash(cause));
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (completion === 'afterAction') {
              onDone(value);
            }
          }),
        ),
      ),
    );
  };
}
