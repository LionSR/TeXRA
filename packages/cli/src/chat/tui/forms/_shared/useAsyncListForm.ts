// Shared async lifecycle for `/` forms: the one write runner, the sequenced
// read every status view and list form holds, and the list-form layer that
// lets `Esc` close the panel while it has nothing actionable to show.

import { useInput } from 'ink';
import { Cause, Effect } from 'effect';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  isEscapeInput,
  isPlainReturnInput,
  type ReturnKeyInput,
} from '@cli/tui/inputKeys';
import { setTransientNotice } from '@cli/chat/tui/state/cliState';
import type { ProcessRuntime, ProcessServices } from '@platform/processRuntime';
import { toErrorMessage } from '@utils/errors/errorMessage';

interface AsyncResource<T, R = ProcessServices> {
  readonly data: T | undefined;
  readonly setData: (update: (current: T | undefined) => T | undefined) => void;
  /** True while a read is in flight, the first one included. */
  readonly loading: boolean;
  readonly error: string | undefined;
  /** The read as a program: `reload` runs it, and a write that must be seen
   *  afterwards sequences it after itself in one run. Only the latest read
   *  lands, and none lands after unmount. */
  readonly refresh: () => Effect.Effect<void, never, R>;
  /** Re-run the read, keeping the current data on screen until it returns. */
  readonly reload: () => void;
  /** Surface a failure that is not a read failure (e.g. a mutation write)
   *  through the same error state and `onError` hook. */
  readonly reportError: (error: unknown) => void;
}

interface AsyncListFormState<T> extends AsyncResource<T> {
  /**
   * First non-navigation key pressed while the async list was loading. Forms
   * can apply it once their actionable items are mounted, then clear it.
   */
  readonly pendingInput: string | undefined;
  readonly clearPendingInput: () => void;
  /** Run a write, then {@link AsyncResource.reload}; a failed write becomes a
   *  transient notice and leaves the loaded data as it is. */
  readonly update: (write: Effect.Effect<void, Error, ProcessServices>) => void;
}

interface UseAsyncListFormOptions<T> {
  /** Loads the form's data once on mount, as a program the hook runs. */
  readonly load: () => Effect.Effect<T, Error, ProcessServices>;
  /** The runtime the load and every write settle on. */
  readonly runtime: ProcessRuntime;
  /** Close handler invoked when `Esc` is pressed in a non-actionable state. */
  readonly onClose: () => void;
  /**
   * Invoked alongside {@link AsyncListFormState.error} whenever a load or a
   * reported error fails, so the host can log/notify outside the form frame.
   */
  readonly onError?: (error: unknown) => void;
  /**
   * Returns true when loaded `data` has nothing to act on (e.g. an empty
   * list), so `Esc` should also close. Forms whose loaded state is always
   * actionable can omit this.
   */
  readonly isEmpty?: (data: T) => boolean;
  /** Also close an empty picker on Enter when its footer advertises that key. */
  readonly closeEmptyOnEnter?: boolean;
}

export function shouldCloseAsyncListFormOnInput(args: {
  readonly input: string;
  readonly key: Pick<ReturnKeyInput, 'escape' | 'return'>;
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly empty: boolean;
  readonly closeEmptyOnEnter?: boolean;
}): boolean {
  return (
    ((args.loading || args.error !== undefined || args.empty) &&
      isEscapeInput(args.input, args.key)) ||
    (args.empty &&
      args.closeEmptyOnEnter === true &&
      isPlainReturnInput(args.input, args.key))
  );
}

export function shouldBufferAsyncListFormInput(args: {
  readonly input: string;
  readonly key: Pick<ReturnKeyInput, 'ctrl' | 'escape' | 'meta' | 'return'> & {
    readonly downArrow?: boolean;
    readonly leftArrow?: boolean;
    readonly rightArrow?: boolean;
    readonly upArrow?: boolean;
  };
  readonly loading: boolean;
}): boolean {
  return (
    args.loading &&
    args.input.length > 0 &&
    !args.key.ctrl &&
    !args.key.meta &&
    !args.key.downArrow &&
    !args.key.leftArrow &&
    !args.key.rightArrow &&
    !args.key.upArrow &&
    !isEscapeInput(args.input, args.key) &&
    !isPlainReturnInput(args.input, args.key)
  );
}

/**
 * Settle a form's write program on the surface's runtime. Every form write runs
 * through here as a `runFork`, not a fire-and-forget `runPromise`: shutdown
 * interrupts a write still in flight, and the process runtime's fork reporting
 * keeps that interrupts-only exit silent where a dropped promise would reject
 * unhandled. `Effect.suspend` builds the program inside the fiber, so a
 * synchronous throw lands in `onError` with a failed write.
 */
export function runFormWrite<A>(
  runtime: ProcessRuntime,
  write: () => Effect.Effect<A, Error, ProcessServices>,
  handlers: {
    readonly onSuccess?: (value: A) => void;
    /** Receives the squashed cause, the value a rejection would carry. */
    readonly onError: (error: unknown) => void;
  },
): void {
  runtime.runFork(
    Effect.suspend(write).pipe(
      Effect.matchCause({
        onSuccess: (value) => handlers.onSuccess?.(value),
        onFailure: (cause) => handlers.onError(Cause.squash(cause)),
      }),
    ),
  );
}

/**
 * Read `load` once on mount and hold its latest result, loading flag, and
 * error. Reads are sequenced: a stale read, or one that resolves after
 * unmount, never lands.
 */
export function useAsyncResource<T, R extends ProcessServices>(options: {
  readonly load: () => Effect.Effect<T, Error, R>;
  readonly runtime: ProcessRuntime;
  /** Invoked alongside the error state whenever a read or a reported error
   *  fails, so the host can log/notify outside the form frame. */
  readonly onError?: (error: unknown) => void;
}): AsyncResource<T, R> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const latest = useRef(options);
  latest.current = options;
  const sequence = useRef(0);
  const mounted = useRef(false);

  const reportError = useCallback((err: unknown) => {
    setError(toErrorMessage(err));
    latest.current.onError?.(err);
  }, []);

  // `suspend` claims the sequence number when the read starts, not when its
  // program is built: a write that composes this after itself must not
  // reserve the slot before that write lands.
  const refresh = useCallback(
    (): Effect.Effect<void, never, R> =>
      Effect.suspend(() => {
        const request = ++sequence.current;
        const current = (): boolean =>
          mounted.current && request === sequence.current;
        setLoading(true);
        setError(undefined);
        return latest.current.load().pipe(
          Effect.matchCause({
            onSuccess: (result) => {
              if (!current()) return;
              setData(result);
              setLoading(false);
            },
            onFailure: (cause) => {
              if (!current()) return;
              reportError(Cause.squash(cause));
              setLoading(false);
            },
          }),
        );
      }),
    [reportError],
  );

  const { runtime } = options;
  const reload = useCallback(() => {
    runtime.runFork(refresh());
  }, [runtime, refresh]);

  useEffect(() => {
    mounted.current = true;
    reload();
    return () => {
      mounted.current = false;
    };
  }, []);

  return { data, setData, loading, error, refresh, reload, reportError };
}

/**
 * {@link useAsyncResource} for a `/`-form list: `loading` covers only the
 * first read, and `Esc` closes the panel while it is loading, errored, or
 * empty. Status views that must not close their parent use the resource hook
 * directly.
 */
export function useAsyncListForm<T>(
  options: UseAsyncListFormOptions<T>,
): AsyncListFormState<T> {
  const resource = useAsyncResource(options);
  const { data, error } = resource;
  const loading = resource.loading && data === undefined;
  const [pendingInput, setPendingInput] = useState<string | undefined>();
  const clearPendingInput = useCallback(() => setPendingInput(undefined), []);

  const empty =
    data !== undefined && options.isEmpty ? options.isEmpty(data) : false;

  useInput((input, key) => {
    if (
      shouldCloseAsyncListFormOnInput({
        input,
        key,
        loading,
        error,
        empty,
        closeEmptyOnEnter: options.closeEmptyOnEnter,
      })
    ) {
      options.onClose();
      return;
    }
    if (shouldBufferAsyncListFormInput({ input, key, loading })) {
      setPendingInput((current) => current ?? input);
    }
  });

  const update = (write: Effect.Effect<void, Error, ProcessServices>): void =>
    runFormWrite(options.runtime, () => write, {
      onSuccess: resource.reload,
      onError: (err) => setTransientNotice(toErrorMessage(err)),
    });

  return {
    ...resource,
    loading,
    pendingInput,
    clearPendingInput,
    update,
  };
}
