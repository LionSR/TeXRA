/**
 * What more than one plugin's availability check and card share: the
 * SDK-and-binary probe and the install-command picker.
 */

// Third-party imports
import { Effect, type FileSystem } from 'effect';

// Local imports
import { causeChain, isModuleNotFoundError } from '@texra-ai/harness/host';
import { runsInWsl } from '@texra-ai/harness/node';
import { toErrorMessage } from '@texra-ai/harness/schemas';
import { ToolProbeFailed } from '@texra-ai/harness/plugins';
import { hasPackageManager } from '@texra/utils/system/toolChecks';
import {
  SYSTEM_PACKAGE_MANAGERS,
  type SystemPackageManager,
} from '@texra/shared/constants/latexToolchain';

import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

/** Appended to install hints when running under WSL, where side matters. */
function wslInstallHint(): string {
  return runsInWsl() ? ' (run this inside WSL, not on the Windows side)' : '';
}

/** Resolved status of an SDK-backed CLI integration for the dashboard. */
type SdkBinaryStatus =
  | { ok: false; message: string }
  | { ok: true; binaryPath: string };

/**
 * Human-readable probe shared by the SDK-backed CLI integrations: import
 * the SDK, then resolve the native binary (appending
 * {@link wslInstallHint} when it is absent). A missing package reads as the
 * importer's own install guidance, found on the cause chain's error code
 * rather than in the message text. Callers own only the final "ready" line.
 */
export const probeSdkBinaryStatus = Effect.fn('probeSdkBinaryStatus')(
  function* (config: {
    importSdk: () => Effect.Effect<unknown, Error>;
    findBinary: () => Effect.Effect<
      string | undefined,
      Error,
      ChildProcessSpawner | FileSystem.FileSystem
    >;
    importFailedLabel: string;
    binaryNotFoundMessage: string;
    classifyImportError?: (msg: string) => string | undefined;
  }): Effect.fn.Return<
    SdkBinaryStatus,
    ToolProbeFailed,
    ChildProcessSpawner | FileSystem.FileSystem
  > {
    // Only the import is classified into a message; a binary-resolution
    // failure stays on the error channel.
    const importFailure = yield* Effect.suspend(config.importSdk).pipe(
      Effect.match({
        onSuccess: () => undefined,
        onFailure: (cause) => {
          const message = toErrorMessage(cause);
          if (causeChain(cause).some(isModuleNotFoundError)) return message;
          return (
            config.classifyImportError?.(message) ??
            `${config.importFailedLabel}: ${message}`
          );
        },
      }),
    );
    if (importFailure !== undefined) {
      return { ok: false as const, message: importFailure };
    }

    const binaryPath = yield* config
      .findBinary()
      .pipe(
        Effect.mapError(
          (cause) =>
            new ToolProbeFailed({ message: toErrorMessage(cause), cause }),
        ),
      );
    if (!binaryPath) {
      return {
        ok: false as const,
        message: config.binaryNotFoundMessage + wslInstallHint(),
      };
    }
    return { ok: true as const, binaryPath };
  },
);

/**
 * Pick the install command to offer for a CLI on this machine.
 *
 * `npm install -g` assumes Node is on PATH, which desktop-app users who
 * installed TeXRA from a .dmg or .exe often do not have. When the system
 * package manager also ships the CLI, offer that command instead.
 *
 * `win32` takes precedence over any package manager: a global npm install
 * leaves only shell shims on Windows, which TeXRA cannot spawn (see
 * vendorPackages.ts), so a CLI with a Windows installer uses it.
 *
 * Only managers this command map names are probed, so a Linux box with both
 * apt and Linuxbrew still gets the brew command rather than npm.
 *
 * Definitions call this from an `installCommand` getter so the probe stays
 * lazy — `hasPackageManager()` probes once per manager and caches, so reading
 * the property repeatedly costs nothing after the first access.
 */
export function preferredInstallCommand(
  commands: Partial<Record<SystemPackageManager | 'win32', string>> & {
    default: string;
  },
): string {
  if (commands.win32 != null && process.platform === 'win32')
    return commands.win32;
  for (const manager of SYSTEM_PACKAGE_MANAGERS) {
    const command = commands[manager];
    if (command != null && hasPackageManager(manager)) return command;
  }
  return commands.default;
}
