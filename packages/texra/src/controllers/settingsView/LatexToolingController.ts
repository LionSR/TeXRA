import { Cause, Effect } from 'effect';

// Local imports - shared constants
import { withLogChannel } from '@texra-ai/harness/host';
import { toErrorMessage } from '@texra-ai/harness/schemas';
import { findCommand } from '@texra/utils/system/binaryResolver';
import {
  DEFAULT_LATEX_SETTINGS_STATUS,
  type LatexSettingsStatus,
} from '@texra/shared/settingsView/settingsViewMessages';
import type { EditorIntegrationShape } from '@texra/hosts/editorIntegration';
import {
  HOMEBREW_INSTALL_COMMAND,
  installAdvice,
  LATEX_DEPENDENCIES,
  LATEX_WORKSHOP_EXT_ID,
  PROBED_LATEX_TOOLS,
  SCOOP_INSTALL_COMMAND,
  type LatexDependency,
} from '@texra/shared/constants/latexToolchain';
import {
  detectPackageManager,
  probeTool,
} from '@texra/utils/system/toolChecks';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';
import { OsPlatformSchema, osPlatformOf } from '@texra/shared/osPlatform';

const CHANNEL = 'LatexToolingController';

const ALLOWED_INSTALL_COMMANDS: ReadonlySet<string> = new Set([
  HOMEBREW_INSTALL_COMMAND,
  SCOOP_INSTALL_COMMAND,
  ...Object.values(LATEX_DEPENDENCIES).flatMap(({ label, installs }) =>
    OsPlatformSchema.literals.flatMap((platform) => {
      const { command } = installAdvice(label, installs, platform);
      return command ? [command.command] : [];
    }),
  ),
]);

/** Whether `command` is one of the structured install commands the LaTeX
 *  page offers; no other string from the webview reaches a terminal. */
export function isAllowedLatexInstallCommand(command: string): boolean {
  return ALLOWED_INSTALL_COMMANDS.has(command);
}

/**
 * The LaTeX settings status: the tool probes, and the side of the host's
 * editor where it has one.
 */
export function detectLatexSettingsStatus(
  host: EditorIntegrationShape | undefined,
): Effect.Effect<LatexSettingsStatus, never, ChildProcessSpawner> {
  const platform = osPlatformOf(process.platform);
  return Effect.gen(function* () {
    const editor = host && {
      latexWorkshopInstalled: host.installed(LATEX_WORKSHOP_EXT_ID),
      recommended: host.recommendedSettings(),
    };
    const probes = yield* Effect.all(
      PROBED_LATEX_TOOLS.map((tool) =>
        Effect.map(probeTool(tool), (isInstalled) => ({ tool, isInstalled })),
      ),
      { concurrency: 'unbounded' },
    );
    const installedTools = new Set(
      probes.flatMap(({ tool, isInstalled }) => (isInstalled ? [tool] : [])),
    );
    // Perl backs latexindent but is never shown with a path of its own.
    const commandPath = (name: string) =>
      Effect.map(findCommand(name), (found) => found?.resolvedPath ?? null);
    const { gm, magick, ...toolPaths } = yield* Effect.all(
      {
        pdflatexPath: commandPath('pdflatex'),
        latexmkPath: commandPath('latexmk'),
        latexdiffPath: commandPath('latexdiff'),
        latexindentPath: commandPath('latexindent'),
        texcountPath: commandPath('texcount'),
        ghostscriptPath: commandPath('gs'),
        gm: commandPath('gm'),
        magick: commandPath('magick'),
      },
      { concurrency: 'unbounded' },
    );
    // cast: the entries are keyed by every dependency, one each.
    const installed = Object.fromEntries(
      Object.entries(LATEX_DEPENDENCIES).map(([id, { needs }]) => [
        id,
        needs.every((group) => group.some((tool) => installedTools.has(tool))),
      ]),
    ) as Record<LatexDependency, boolean>;
    return {
      editor: editor ?? null,
      installed,
      platform,
      ...toolPaths,
      graphicsmagickPath: gm ?? magick,
      packageManager: detectPackageManager(),
    } satisfies LatexSettingsStatus;
  }).pipe(
    // Every tool then reports as not installed, so the failure must not be
    // indistinguishable from a machine with no TeX: it is logged. An
    // interrupted detection is not a detection failure, so it propagates
    // instead of painting the view with an all-missing status.
    Effect.catchCause((cause) => {
      if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
      const error = Cause.squash(cause);
      return Effect.logWarning(
        `LaTeX tooling detection failed: ${toErrorMessage(error)}`,
      ).pipe(
        Effect.annotateLogs({ data: error }),
        withLogChannel(CHANNEL),
        Effect.as({
          ...DEFAULT_LATEX_SETTINGS_STATUS,
          platform,
        } satisfies LatexSettingsStatus),
      );
    }),
  );
}
