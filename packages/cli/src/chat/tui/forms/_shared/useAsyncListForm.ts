// Shared data-load lifecycle for `/`-form list forms. Each form fetched its
// list in a cancellable `useEffect`, tracked `loading` / `error`, and let `Esc`
// close the panel while it had nothing actionable to show. That triad was
// copied verbatim across every list form; it lives here once.

import { useInput } from 'ink';
import { useEffect, useState } from 'react';

import {
  isEscapeInput,
  type ReturnKeyInput,
} from '@cli/chat/tui/input/inputKeys';

export interface AsyncListFormState<T> {
  readonly data: T | undefined;
  readonly loading: boolean;
  readonly error: string | undefined;
  /**
   * Replace the loaded data after mount. Used by forms whose loaded list is
   * mutable in place (e.g. `/tools` re-reading statuses after a toggle).
   */
  readonly setData: (next: T) => void;
}

export interface UseAsyncListFormOptions<T> {
  /** Loads the form's data once on mount. */
  readonly load: () => Promise<T>;
  /** Close handler invoked when `Esc` is pressed in a non-actionable state. */
  readonly onClose: () => void;
  /**
   * Returns true when loaded `data` has nothing to act on (e.g. an empty
   * list), so `Esc` should also close. Forms whose loaded state is always
   * actionable can omit this.
   */
  readonly isEmpty?: (data: T) => boolean;
}

export function shouldCloseAsyncListFormOnInput(args: {
  readonly input: string;
  readonly key: Pick<ReturnKeyInput, 'escape'>;
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly empty: boolean;
}): boolean {
  return (
    (args.loading || args.error !== undefined || args.empty) &&
    isEscapeInput(args.input, args.key)
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

  const empty =
    data !== undefined && options.isEmpty ? options.isEmpty(data) : false;

  useInput((_input, key) => {
    if (
      shouldCloseAsyncListFormOnInput({
        input: _input,
        key,
        loading,
        error,
        empty,
      })
    ) {
      options.onClose();
    }
  });

  const { load } = options;
  useEffect(() => {
    let cancelled = false;
    void load()
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Load once on mount, matching the original per-form `useEffect(..., [])`.
  }, []);

  return { data, loading, error, setData };
}
