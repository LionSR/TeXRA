/**
 * The VS Code host's setup capabilities, provided as the `SetupPlatform`
 * service by `initVscodePlatform`.
 *
 * Every member is a closure over VS Code's own APIs, so the value exists
 * before any activation state does. The command and extension members are
 * `Effect`s: a command VS Code refuses reaches the setup tool as
 * `SetupCommandFailed`, and a refused install as `SetupExtensionInstallFailed`, instead of as `unknown`
 * behind an identity catch. They live here rather than in `extension.ts` for
 * the same reason `runTerminalCommand` does: the host implementation of a
 * port belongs beside the other host implementations, and the composition
 * root only wires it.
 */

// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import {
  SetupCommandFailed,
  SetupExtensionInstallFailed,
  type SetupPlatformShape,
} from '@texra/tools/setup/platform';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import { runTerminalCommand } from './setupTerminalRunner';

/** VS Code's own Marketplace install command. */
const INSTALL_EXTENSION_COMMAND = 'workbench.extensions.installExtension';

export const vscodeSetupPlatform: SetupPlatformShape = {
  commands: {
    invoke: (commandId, ...args) =>
      Effect.tryPromise({
        try: () =>
          Promise.resolve(vscode.commands.executeCommand(commandId, ...args)),
        catch: (cause) =>
          new SetupCommandFailed({
            message: `VS Code could not run "${commandId}": ${toErrorMessage(cause)}`,
            commandId,
            cause,
          }),
      }),
  },
  extensions: {
    // Also what the Lean 4 availability probe reads to see whether the
    // editor host has the extension installed.
    isInstalled: (extensionId) =>
      vscode.extensions.getExtension(extensionId) !== undefined,
    install: (extensionId) =>
      Effect.tryPromise({
        try: async () => {
          await vscode.commands.executeCommand(
            INSTALL_EXTENSION_COMMAND,
            extensionId,
          );
        },
        catch: (cause) =>
          new SetupExtensionInstallFailed({
            message: `VS Code refused to install "${extensionId}": ${toErrorMessage(cause)}`,
            extensionId,
            cause,
          }),
      }),
  },
  terminal: runTerminalCommand,
};
