/**
 * The VS Code host's setup capabilities, provided as the `SetupPlatform`
 * service by `initVscodePlatform`.
 *
 * Every member is a closure over VS Code's own APIs, so the value exists
 * before any activation state does. The command member is an `Effect`: a
 * command VS Code refuses reaches the setup tool as the host's `HostFailed`,
 * instead of as `unknown` behind an identity catch. They live here rather
 * than in `extension.ts` for the same reason `runTerminalCommand` does: the
 * host implementation of a port belongs beside the other host
 * implementations, and the composition root only wires it. The editor's
 * extensions are `vscodeEditorIntegration`'s.
 */

// Third-party imports
import { Effect } from 'effect';

// Local imports
import { executeVscodeCommand } from '@frontend/system/commandUtils';
import { HostFailed } from '@texra/hosts/uiHosts';
import type { SetupPlatformShape } from '@texra/tools/setup/platform';

// Local file imports
import { runTerminalCommand } from './setupTerminalRunner';

export const vscodeSetupPlatform: SetupPlatformShape = {
  commands: {
    invoke: (commandId, ...args) =>
      executeVscodeCommand<unknown>(commandId, ...args).pipe(
        Effect.mapError(
          (cause) =>
            new HostFailed({
              member: 'commands.invoke',
              message: `VS Code could not run "${commandId}": ${cause.message}`,
              cause,
            }),
        ),
      ),
  },
  terminal: runTerminalCommand,
};
