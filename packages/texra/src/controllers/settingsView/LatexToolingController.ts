import { Cause, Effect } from 'effect';

// Local imports - shared constants
import { withLogChannel } from '@texra-ai/harness/host';
import { toErrorMessage } from '@texra-ai/harness/schemas';
import { findCommand } from '@texra/utils/system/binaryResolver';
import {
  DEFAULT_LATEX_SETTINGS_STATUS,
  type LatexSettingsStatus,
} from '@texra/shared/settingsView/settingsViewMessages';
import {
  HOMEBREW_INSTALL_COMMAND,
  installAdvice,
  LATEX_DEPENDENCIES,
  normalizePlatform,
  OS_PLATFORMS,
  PROBED_LATEX_TOOLS,
  SCOOP_INSTALL_COMMAND,
  type LatexDependency,
} from '@texra/shared/constants/latexToolchain';
import {
  detectPackageManager,
  probeTool,
} from '@texra/utils/system/toolChecks';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

const CHANNEL = 'LatexToolingController';

/** The editor's side of the LaTeX status, as the host reports it: which
 *  recommended settings are applied, and whether LaTeX Workshop is
 *  installed. */
export type LatexEditorStatus = Pick<
  LatexSettingsStatus,
  'outDir' | 'autoRevealExclude' | 'latexWorkshopInstalled'
>;

const ALLOWED_INSTALL_COMMANDS: ReadonlySet<string> = new Set([
  HOMEBREW_INSTALL_COMMAND,
  SCOOP_INSTALL_COMMAND,
  ...Object.values(LATEX_DEPENDENCIES).flatMap(({ label, installs }) =>
    OS_PLATFORMS.flatMap((platform) => {
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
 * The LaTeX settings status: the tool probes, and the editor's side the
 * host reports.
 */
export function detectLatexSettingsStatus(
  editor: LatexEditorStatus,
): Effect.Effect<LatexSettingsStatus, never, ChildProcessSpawner> {
  const platform = normalizePlatform(process.platform);
  return Effect.gen(function* () {
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
      ...editor,
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
