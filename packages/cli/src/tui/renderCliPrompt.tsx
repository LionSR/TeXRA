import { Effect } from 'effect';
import { render } from 'ink';

import { tuiOutputStreamForColor } from './noColorOutput';
import {
  clearTerminalScrollback,
  clearTerminalVisibleScreen,
} from './terminalCleanup';

interface CliPromptOptions {
  /** Real runs Ink mounts onto. They are passed in rather than read here so
   *  the choice of stream stays in the caller, at the CLI boundary. */
  readonly stdout: NodeJS.WriteStream;
  readonly stderr: NodeJS.WriteStream;
  readonly colorEnabled?: boolean;
  /**
   * How the prompt is wiped once Ink unmounts. `visible` keeps the user's
   * primary-buffer scrollback so anything printed afterwards survives;
   * `scrollback` also erases scrollback for prompts that must leave no trace.
   */
  readonly clear?: 'visible' | 'scrollback';
  /**
   * Force Ink's interactive rendering. Callers that reject non-TTY output
   * themselves set this so a real PTY that also has `CI` set still renders,
   * instead of Ink's CI heuristic disabling it.
   */
  readonly interactive?: boolean;
}

/**
 * Mount a one-shot Ink prompt, wait for it to exit, and produce the value it
 * resolved. The prompt resolves by calling `resolve` before `useApp().exit()`;
 * the first resolution wins so a stray later call cannot overwrite the user's
 * choice. The mount is scoped, so an interrupted fiber unmounts and wipes the
 * prompt exactly as a normal exit does.
 */
export function renderCliPrompt<T>(
  element: (resolve: (value: T) => void) => React.JSX.Element,
  options: CliPromptOptions,
): Effect.Effect<T | undefined> {
  return Effect.suspend(() => {
    let resolved: T | undefined;
    // A separate latch, not `??=`: callers cancel by resolving `undefined`, and
    // `??=` would leave that unlatched so a later stray resolve could turn a
    // cancel into a committed choice.
    let hasResolved = false;
    return Effect.acquireUseRelease(
      Effect.sync(() =>
        render(
          element((value) => {
            if (hasResolved) return;
            hasResolved = true;
            resolved = value;
          }),
          {
            interactive: options.interactive,
            stdout: tuiOutputStreamForColor(
              options.stdout,
              options.colorEnabled ?? true,
            ),
            stderr: options.stderr,
            stdin: process.stdin,
          },
        ),
      ),
      (instance) =>
        Effect.promise(() => instance.waitUntilExit()).pipe(
          Effect.map(() => resolved),
        ),
      (instance) =>
        Effect.sync(() => {
          // A no-op once the prompt exited on its own; it matters on the
          // interrupted path, where Ink still owns the terminal.
          instance.unmount();
          if (options.clear === 'scrollback') {
            clearTerminalScrollback();
          } else {
            clearTerminalVisibleScreen();
          }
        }),
    );
  });
}
