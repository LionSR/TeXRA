// The completion, busy-frame and error plumbing every built-in slash form
// runs its selection through.

import { Cause, Effect, Fiber } from 'effect';

import type { ProcessRuntime } from '@platform/processRuntime';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { collapseWhitespace } from '@utils/text/stringUtils';

import { formProgress, setTransientNotice } from '../state/cliState';
import { appendLocalAssistantTranscript } from '../state/transcript';
import {
  type SlashCommandEffect,
  type SlashCommandOutput,
  transcriptSlashCommandOutput,
} from './handlers/slashContext';

export type ErrorHandler = (error: unknown) => void;
type SelectionCompletion = 'afterAction' | 'beforeAction' | 'busy';

/** Build a form selection handler with consistent completion and errors. */
export function formSelectionHandler<T>({
  runtime,
  action,
  onDone,
  onError,
  onPersist,
  echoOnPersist = false,
  completion = 'afterAction',
  busyTitle,
}: {
  readonly runtime: ProcessRuntime;
  readonly action: (value: T, output: SlashCommandOutput) => SlashCommandEffect;
  readonly onDone: (value: T) => void;
  readonly onError?: ErrorHandler;
  readonly onPersist?: () => void;
  readonly echoOnPersist?: boolean;
  readonly completion?: SelectionCompletion;
  readonly busyTitle?: (value: T) => string;
}): (value: T) => void {
  // Every host's error hook writes to its transcript and returns; reporting
  // is a step of the failure path, not a wait inside it.
  const reportError = (error: unknown): Effect.Effect<void> =>
    Effect.sync(() => {
      onError?.(error);
    });
  return (value) => {
    if (completion === 'busy') {
      // The submission token is the single owner of "is this submission still
      // live": resetCliState clears `formProgress`, so a stale token can never
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
        appendLocalAssistantTranscript(current.copyableMessage);
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
          appendLocalAssistantTranscript(message);
          const current = currentProgress();
          if (current) formProgress.set({ ...current, message });
        },
        setNotice: (message) => {
          if (currentProgress()) setTransientNotice(message);
        },
        writeProgress: (message, options) => {
          const current = currentProgress();
          if (!current) return;
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
        Effect.suspend(() => action(value, output)).pipe(
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
            onFailure: (cause) =>
              Effect.gen(function* () {
                let current = currentProgress();
                if (!current) return;
                if (echoOnPersist) onPersist?.();
                const error = Cause.squash(cause);
                const errorMessage = toErrorMessage(error);
                const copyableMessage = current.copyableMessage;
                yield* reportError(
                  copyableMessage
                    ? new Error(
                        `${collapseWhitespace(errorMessage)} · ${collapseWhitespace(
                          copyableMessage,
                        )}`,
                      )
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
      Effect.suspend(() => action(value, transcriptSlashCommandOutput)).pipe(
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
