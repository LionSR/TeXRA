import { Cause, Effect } from 'effect';

// Local imports - shared constants
import { withLogChannel } from '@logger/effectLog';
import {
  DEFAULT_LATEX_SETTINGS_STATUS,
  type LatexSettingsStatus,
} from '@shared/settingsView/settingsViewMessages';
import {
  DEPENDENCY_INSTALL_COMMANDS,
  HOMEBREW_INSTALL_COMMAND,
  IMAGE_LATEX_TOOLS,
  LATEX_WORKSHOP_EXT_ID,
  normalizePlatform,
  PROBED_LATEX_TOOLS,
  SCOOP_INSTALL_COMMAND,
  SUPPORTED_LATEX_COMPILERS,
  type ProbedLatexTool,
} from '@shared/constants/latexToolchain';
import { SetupPlatform } from '@tools/setup/platform';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { findToolInCommonPaths } from '@utils/system/binaryResolver';
import {
  checkToolInstalled,
  detectPackageManager,
} from '@utils/system/toolUtils';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

const CHANNEL = 'LatexToolingController';

/** The recommended editor settings the host reports as applied. */
export type LatexRecommendedStatus = Pick<
  LatexSettingsStatus,
  'outDir' | 'autoRevealExclude'
>;

const ALLOWED_INSTALL_COMMANDS: ReadonlySet<string> = new Set([
  HOMEBREW_INSTALL_COMMAND,
  SCOOP_INSTALL_COMMAND,
  ...Object.values(DEPENDENCY_INSTALL_COMMANDS).flatMap((platforms) =>
    Object.values(platforms).flatMap((cmds) => cmds.map((cmd) => cmd.command)),
  ),
]);

/** Whether `command` is one of the structured install commands the LaTeX
 *  page offers; no other string from the webview reaches a terminal. */
export function isAllowedLatexInstallCommand(command: string): boolean {
  return ALLOWED_INSTALL_COMMANDS.has(command);
}

/**
 * The LaTeX settings status: the tool probes, the LaTeX Workshop extension
 * as the host's setup platform reports it, and the recommended settings the
 * host reads.
 */
export function detectLatexSettingsStatus(
  recommended: LatexRecommendedStatus,
): Effect.Effect<
  LatexSettingsStatus,
  never,
  ChildProcessSpawner | SetupPlatform
> {
  const platform = normalizePlatform(process.platform);
  return Effect.gen(function* () {
    const installed = Object.fromEntries(
      yield* Effect.all(
        PROBED_LATEX_TOOLS.map((tool) =>
          Effect.map(
            checkToolInstalled(tool, false),
            (isInstalled) => [tool, isInstalled] as const,
          ),
        ),
        { concurrency: 'unbounded' },
      ),
    ) as Record<ProbedLatexTool, boolean>;
    // Perl backs latexindent but is never shown with a path of its own.
    const { gm, magick, ...toolPaths } = yield* Effect.all(
      {
        pdflatexPath: findToolInCommonPaths('pdflatex'),
        latexmkPath: findToolInCommonPaths('latexmk'),
        latexdiffPath: findToolInCommonPaths('latexdiff'),
        latexindentPath: findToolInCommonPaths('latexindent'),
        texcountPath: findToolInCommonPaths('texcount'),
        ghostscriptPath: findToolInCommonPaths('gs'),
        gm: findToolInCommonPaths('gm'),
        magick: findToolInCommonPaths('magick'),
      },
      { concurrency: 'unbounded' },
    );
    const setup = yield* SetupPlatform;
    return {
      ...recommended,
      texDistributionInstalled: SUPPORTED_LATEX_COMPILERS.some(
        (compiler) => installed[compiler],
      ),
      latexWorkshopInstalled:
        setup.extensions?.isInstalled(LATEX_WORKSHOP_EXT_ID) ?? false,
      latexdiffInstalled: installed.latexdiff,
      latexindentInstalled: installed.latexindent && installed.perl,
      texcountInstalled: installed.texcount,
      imageProcessingInstalled:
        installed.gs && IMAGE_LATEX_TOOLS.some((tool) => installed[tool]),
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
