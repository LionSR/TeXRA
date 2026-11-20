// Shared async lifecycle for `/` forms: the one write runner, the latest-wins
// read every status view and list form holds, and the list-form layer that
// holds the keys typed before its list listens and lets `Esc` close the panel
// while it has nothing actionable to show.

import type { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers';
import { useInput, useStdin, type Key, type StdinProps } from 'ink';
import { Cause, Effect, Fiber, FiberHandle } from 'effect';
import { useCallback, useEffect, useRef, useState } from 'react';

import { toErrorMessage } from '@texra-ai/harness/schemas';
import {
  isEscapeInput,
  isPlainReturnInput,
  type ReturnKeyInput,
} from '@cli/tui/inputKeys';
import { setTransientNotice } from '@cli/chat/tui/state/cliState';
import { useMountScope } from '@cli/chat/tui/state/useMountScope';
import { useChatProcess } from '@cli/chat/tui/chatProcess';
import type { ProcessServices } from '@texra-ai/harness/host';
import type { ScopeRunner } from '@cli/chat/scopeRunner';

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
  /** Run a write, then {@link AsyncResource.reload}; a failed write becomes a
   *  transient notice and leaves the loaded data as it is. */
  readonly update: (write: Effect.Effect<void, Error, ProcessServices>) => void;
}

interface UseAsyncListFormOptions<T> {
  /** Loads the form's data once on mount, as a program the hook runs. */
  readonly load: () => Effect.Effect<T, Error, ProcessServices>;
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

function shouldCloseAsyncListFormOnInput(args: {
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

/**
 * Hold the keys a form's list would take that arrive before the list listens,
 * and replay them, in order and as Ink read them, once it does.
 *
 * Ink hands a key to the `useInput` listeners subscribed when it arrives, and
 * a listener subscribes in the passive effect of the commit that mounts it.
 * The read that ends `loading` lands outside a key event, so React runs that
 * commit's passive effects in a later task, and a key read in between reaches
 * neither a loading-state buffer (the form is no longer loading) nor the list
 * (not yet subscribed). So the list counts as listening only from this hook's
 * own passive effect on the commit that shows it: React runs a component's
 * passive effects after its children's, so the list has subscribed by then.
 *
 * Each held key is replayed in a task of its own, queued after the one in
 * which React's scheduler runs the passive effects of the commit the previous
 * key caused, so a key acts on what the one before it opened (a `/config`
 * category, the next form), as it would have, typed after the list showed.
 *
 * Esc is not held (the form closes on it while nothing listens), nor is a
 * Ctrl chord: the App's handler already acted on it, and a replay would act
 * twice. A replayed key reaches every listener again; with a form open the
 * App's handler takes only Ctrl chords, and this hook's own handler sees the
 * key as typed on the loaded list.
 */
function useHeldListInput(args: {
  readonly listShown: boolean;
  readonly failed: boolean;
}): {
  readonly listening: () => boolean;
  readonly hold: (input: string, key: Key) => void;
} {
  // The emitter every `useInput` listener subscribes to. Ink's stdin context
  // carries it at runtime (its own `useInput` reads it there); the public
  // type leaves it out, and Ink offers no other way to hand a key to its
  // listeners.
  const stdin: StdinProps & { readonly internal_eventEmitter?: EventEmitter } =
    useStdin();
  const inputEvents = stdin.internal_eventEmitter;
  if (inputEvents === undefined) {
    throw new Error("Ink's stdin context no longer carries its input events.");
  }
  const listening = useRef(false);
  const held = useRef<string[]>([]);
  // The chunk Ink is dispatching: `useInput` hands its handler the parsed
  // key, and a replay needs the bytes. Prepended, so it runs before every
  // `useInput` listener of the same dispatch.
  const dispatching = useRef('');
  useEffect(() => {
    const record = (chunk: string): void => {
      dispatching.current = chunk;
    };
    inputEvents.prependListener('input', record);
    return () => {
      inputEvents.removeListener('input', record);
    };
  }, [inputEvents]);

  useEffect(() => {
    if (!args.listShown) {
      // A failed read shows no list to take what was typed.
      if (args.failed) held.current = [];
      return;
    }
    listening.current = true;
    // The rest of the queue outlives this form if a key closes it: the keys
    // typed after that one belong to whatever it opened.
    const queue = held.current.splice(0);
    const replayNext = (): void => {
      const chunk = queue.shift();
      if (chunk === undefined) return;
      inputEvents.emit('input', chunk);
      setImmediate(replayNext);
    };
    replayNext();
  }, [args.listShown, args.failed, inputEvents]);

  return {
    listening: () => listening.current,
    hold: (input, key) => {
      if (listening.current || args.failed) return;
      if (key.ctrl || isEscapeInput(input, key)) return;
      held.current.push(dispatching.current);
    },
  };
}

/**
 * Run a form's write program on the Ink root's runner. Every form write runs
 * through here: a write belongs to the root, not to the form that starts it,
 * so a setting being saved is saved even when the form closes first, and the
 * root's end interrupts a write still in flight. `Effect.suspend` builds the
 * program inside the fiber, so a synchronous throw lands in `onError` with a
 * failed write.
 */
export function runFormWrite<A>(
  chat: ScopeRunner,
  write: () => Effect.Effect<A, Error, ProcessServices>,
  handlers: {
    readonly onSuccess?: (value: A) => void;
    /** Receives the squashed cause, the value a rejection would carry. */
    readonly onError: (error: unknown) => void;
  },
): void {
  chat.fork(
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
 * error. Every read runs in one `FiberHandle` in the scope the mount owns: a
 * newer read interrupts the one in flight, and unmount interrupts the last,
 * so only the latest read lands and none lands after unmount.
 */
export function useAsyncResource<T, R extends ProcessServices>(options: {
  readonly load: () => Effect.Effect<T, Error, R>;
  /** Invoked alongside the error state whenever a read or a reported error
   *  fails, so the host can log/notify outside the form frame. */
  readonly onError?: (error: unknown) => void;
}): AsyncResource<T, R> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const latest = useRef(options);
  latest.current = options;
  const mount = useMountScope();
  const [reads] = useState(() => mount.sync(FiberHandle.make<void>()));

  const reportError = useCallback((err: unknown) => {
    setError(toErrorMessage(err));
    latest.current.onError?.(err);
  }, []);

  // A caller that sequences a read after its own write waits for that read,
  // whether it lands or a newer one supersedes it.
  const refresh = useCallback(
    (): Effect.Effect<void, never, R> =>
      FiberHandle.run(
        reads,
        Effect.suspend(() => {
          setLoading(true);
          setError(undefined);
          return latest.current.load().pipe(
            Effect.matchCause({
              onSuccess: (result) => {
                setData(result);
                setLoading(false);
              },
              onFailure: (cause) => {
                reportError(Cause.squash(cause));
                setLoading(false);
              },
            }),
          );
        }),
      ).pipe(Effect.flatMap(Fiber.await), Effect.asVoid),
    [reads, reportError],
  );

  const reload = useCallback(() => {
    mount.fork(refresh());
  }, [mount, refresh]);

  useEffect(() => {
    reload();
  }, []);

  return { data, setData, loading, error, refresh, reload, reportError };
}

/**
 * {@link useAsyncResource} for a `/`-form list: `loading` covers only the
 * first read, a key typed before the list listens acts on it once it does
 * (Esc and Ctrl chords excepted), and `Esc` closes the panel while nothing
 * listens, or while it is errored or empty. Status views that must not close
 * their parent use the resource hook directly.
 */
export function useAsyncListForm<T>(
  options: UseAsyncListFormOptions<T>,
): AsyncListFormState<T> {
  const resource = useAsyncResource(options);
  const { data, error } = resource;
  const loading = resource.loading && data === undefined;
  const input = useHeldListInput({
    listShown: data !== undefined,
    failed: data === undefined && error !== undefined,
  });

  const empty =
    data !== undefined && options.isEmpty ? options.isEmpty(data) : false;

  useInput((typed, key) => {
    if (
      shouldCloseAsyncListFormOnInput({
        input: typed,
        key,
        loading: !input.listening(),
        error,
        empty,
        closeEmptyOnEnter: options.closeEmptyOnEnter,
      })
    ) {
      options.onClose();
      return;
    }
    input.hold(typed, key);
  });

  const { chat } = useChatProcess();
  const update = (write: Effect.Effect<void, Error, ProcessServices>): void =>
    runFormWrite(chat, () => write, {
      onSuccess: resource.reload,
      onError: (err) => setTransientNotice(toErrorMessage(err)),
    });

  return {
    ...resource,
    loading,
    update,
  };
}
