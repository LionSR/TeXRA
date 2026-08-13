// Shared data-load lifecycle for `/`-form list forms. Each form fetched its
// list in a cancellable `useEffect`, tracked `loading` / `error`, and let `Esc`
// close the panel while it had nothing actionable to show. That triad was
// copied verbatim across every list form; it lives here once.

import { useInput } from 'ink';
import { useCallback, useState } from 'react';

import {
  isEscapeInput,
  isPlainReturnInput,
  type ReturnKeyInput,
} from '@cli/tui/inputKeys';
import { useCancellableEffect } from '@cli/tui/useCancellableEffect';
import { toErrorMessage } from '@utils/errors/errorMessage';

export interface AsyncListFormState<T> {
  readonly data: T | undefined;
  readonly loading: boolean;
  readonly error: string | undefined;
  /**
   * First non-navigation key pressed while the async list was loading. Forms
   * can apply it once their actionable items are mounted, then clear it.
   */
  readonly pendingInput: string | undefined;
  readonly clearPendingInput: () => void;
  /**
   * Replace the loaded data after mount. Used by forms whose loaded list is
   * mutable in place (e.g. `/tools` re-reading statuses after a toggle).
   */
  readonly setData: (next: T) => void;
  /**
   * Re-run the loader and replace the loaded data, keeping the current data
   * on screen until the next result arrives. Used by forms that must re-fetch
   * after a mutation (e.g. a roster write). Clears the error on success and
   * reports failures through {@link error} plus the options' {@link
   * UseAsyncListFormOptions.onError}.
   */
  readonly reload: () => void;
  /**
   * Surface a failure that is not a load failure (e.g. a mutation write)
   * through the same error channel and {@link UseAsyncListFormOptions.onError}
   * used by load failures.
   */
  readonly reportError: (error: unknown) => void;
}

export interface UseAsyncListFormOptions<T> {
  /** Loads the form's data once on mount. */
  readonly load: () => Promise<T>;
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
 * Run the form's loader on mount, expose `loading` / `error` / `data`, and wire
 * `Esc` to close while the panel is loading, errored, or empty. Matches the
 * hand-rolled effect each form previously carried, including the
 * cancellation guard that drops a resolved promise after unmount.
 */
export function useAsyncListForm<T>(
  options: UseAsyncListFormOptions<T>,
): AsyncListFormState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [pendingInput, setPendingInput] = useState<string | undefined>();
  const clearPendingInput = useCallback(() => setPendingInput(undefined), []);

  const { load, onError } = options;

  const reportError = useCallback(
    (err: unknown) => {
      setError(toErrorMessage(err));
      onError?.(err);
    },
    [onError],
  );

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

  const reload = useCallback(() => {
    setError(undefined);
    void load()
      .then((result) => {
        setData(result);
      })
      .catch(reportError);
  }, [load, reportError]);

  useCancellableEffect(
    (isCancelled) => {
      void load()
        .then((result) => {
          if (isCancelled()) return;
          setData(result);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (isCancelled()) return;
          reportError(err);
          setLoading(false);
        });
    },
    // Load once on mount, matching the original per-form `useEffect(..., [])`.
    [],
  );

  return {
    data,
    loading,
    error,
    pendingInput,
    clearPendingInput,
    setData,
    reload,
    reportError,
  };
}
