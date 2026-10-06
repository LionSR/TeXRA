import { Effect } from 'effect';
import type { ProcessServices } from '@texra-ai/harness';
import type { z } from 'zod';

export type DesktopCommandMessage = { command: string } & Record<
  string,
  unknown
>;

/** The program one inbound command runs. The window's one router runs it and
 *  reports whatever it fails with. */
export type DesktopCommandRoute = (
  message: DesktopCommandMessage,
) => Effect.Effect<void, Error, ProcessServices>;

/** The commands one surface owns, by name. A command with no entry here has
 *  no owner, and the router says so. */
export type DesktopCommandRoutes = Readonly<
  Record<string, DesktopCommandRoute>
>;

/** A route whose message must match `schema`. One that does not is renderer
 *  drift: logged, and no program runs. */
export function parsedRoute<S extends z.ZodType>(
  schema: S,
  handle: (message: z.output<S>) => Effect.Effect<void, Error, ProcessServices>,
): DesktopCommandRoute {
  return (message) => {
    const parsed = schema.safeParse(message);
    return parsed.success
      ? handle(parsed.data)
      : Effect.sync(() =>
          console.warn(
            `Dropped a malformed ${message.command} message: ${parsed.error.message}`,
          ),
        );
  };
}

export interface DesktopRenderer {
  postToRenderer(message: unknown): void;
}

export interface DesktopOverlayPostOptions {
  /**
   * Posts the overlay message to the renderer. Return `false` (or throw) when
   * the renderer is not reachable — the IPC bridge isn't wired yet at startup,
   * or the BrowserWindow has been destroyed. When undefined the overlay is
   * skipped entirely, which keeps tests and unattended invocations working.
   */
  postToRenderer?(message: unknown): boolean | void;
}

/**
 * Show one message in an in-app renderer overlay (the Review diff workbench,
 * the PDF viewer), reporting whether it was shown. A `false` result opts the
 * caller into its external-application fallback so the user never gets a
 * silent failure (caught by Copilot review on PR #3815).
 */
export function tryShowInRenderer(
  options: DesktopOverlayPostOptions & { source: string; fallback: string },
  message: unknown,
): boolean {
  if (!options.postToRenderer) return false;
  try {
    return options.postToRenderer(message) !== false;
  } catch (error) {
    console.error(
      `[desktop] ${options.source}: postToRenderer failed; falling back to ${options.fallback}`,
      error,
    );
    return false;
  }
}

export function isDesktopCommandMessage(
  message: unknown,
): message is DesktopCommandMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    'command' in message &&
    typeof message.command === 'string'
  );
}
