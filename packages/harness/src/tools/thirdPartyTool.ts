/**
 * What the host imposes on a tool whose code it did not write, an MCP
 * server's (`@tools/mcp/mcpServer`) or a native plugin's
 * (`@tools/nativePlugins`), whatever the tool declares: each call is a
 * command the loop's one guard puts to the session's approval policy
 * ({@link thirdPartyCommand}), and a call still running at
 * {@link THIRD_PARTY_CALL_TIMEOUT} is stopped and answers an error
 * ({@link withinDeadline}).
 */
import { Duration, Effect } from 'effect';

import type { ToolResult } from '@shared/schemas';
import type { ToolGuard } from '@tools/core/ToolTypes';
import { errorResult } from '@tools/core/result';

/** How long a third-party tool's call may run. */
const THIRD_PARTY_CALL_TIMEOUT = Duration.seconds(60);

/**
 * The guard's command for a third-party call, spelled by `text`: no
 * standing grant answers it but the delegated-work one (it is never the
 * shell's), and the prompt names no directory, as the host cannot say
 * where the call acts.
 */
export const thirdPartyCommand = <T>(
  text: (input: T) => string,
): NonNullable<ToolGuard<T>['command']> => ({ text, cwd: 'unknown' });

/** `call` stopped at the third-party deadline, answering that `what` did
 *  not finish. A call that never yields to the event loop is not stopped. */
export const withinDeadline = <E, R>(
  call: Effect.Effect<ToolResult, E, R>,
  what: string,
): Effect.Effect<ToolResult, E, R> =>
  call.pipe(
    Effect.timeoutOrElse({
      duration: THIRD_PARTY_CALL_TIMEOUT,
      orElse: () =>
        Effect.succeed(
          errorResult(
            `${what} did not finish within ${Duration.format(THIRD_PARTY_CALL_TIMEOUT)}.`,
          ),
        ),
    }),
  );
