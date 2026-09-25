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
  PROBED_LATEX_TOOLS,
  SCOOP_INSTALL_COMMAND,
  SUPPORTED_LATEX_COMPILERS,
  type OSPlatform,
  type ProbedLatexTool,
} from '@shared/constants/latexToolchain';
import { toErrorMessage } from '@utils/errors/errorMessage';
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

const CHANNEL = 'LatexToolingController';

/** Perl backs latexindent but is never shown with a path of its own. */
type LatexPathTool = Exclude<ProbedLatexTool, 'perl'>;

type LatexRecommendedStatus = Pick<
  LatexSettingsStatus,
  'outDir' | 'autoRevealExclude'
>;

interface LatexToolingControllerDeps {
  checkToolInstalled(
    tool: ProbedLatexTool,
  ): Effect.Effect<boolean, never, ChildProcessSpawner>;
  findPath(
    tool: LatexPathTool,
  ): Effect.Effect<string | null, never, ChildProcessSpawner>;
  detectPackageManager(): LatexSettingsStatus['packageManager'];
  getPlatform(): OSPlatform;
  isLatexWorkshopInstalled(): boolean;
  getRecommendedStatus(): LatexRecommendedStatus;
  onDetectionError?: (error: unknown) => void;
}

const ALLOWED_INSTALL_COMMANDS: ReadonlySet<string> = new Set([
  HOMEBREW_INSTALL_COMMAND,
  SCOOP_INSTALL_COMMAND,
  ...Object.values(DEPENDENCY_INSTALL_COMMANDS).flatMap((platforms) =>
    Object.values(platforms).flatMap((cmds) => cmds.map((cmd) => cmd.command)),
  ),
]);

/** Builds the LaTeX settings status from tool probes and host-provided facts. */
export class LatexToolingController {
  constructor(private readonly deps: LatexToolingControllerDeps) {}

  isAllowedInstallCommand(command: string): boolean {
    return ALLOWED_INSTALL_COMMANDS.has(command);
  }

  detectStatus(): Effect.Effect<
    LatexSettingsStatus,
    never,
    ChildProcessSpawner
  > {
    return Effect.gen({ self: this }, function* () {
      const installed = yield* this.checkTools();
      const find = this.deps.findPath;
      const paths = yield* Effect.all(
        {
          pdflatexPath: find('pdflatex'),
          latexmkPath: find('latexmk'),
          latexdiffPath: find('latexdiff'),
          latexindentPath: find('latexindent'),
          texcountPath: find('texcount'),
          ghostscriptPath: find('gs'),
          gm: find('gm'),
          magick: find('magick'),
        },
        { concurrency: 'unbounded' },
      );
      const { gm, magick, ...toolPaths } = paths;
      return {
        ...this.deps.getRecommendedStatus(),
        texDistributionInstalled: SUPPORTED_LATEX_COMPILERS.some(
          (compiler) => installed[compiler],
        ),
        latexWorkshopInstalled: this.deps.isLatexWorkshopInstalled(),
        latexdiffInstalled: installed.latexdiff,
        latexindentInstalled: installed.latexindent && installed.perl,
        texcountInstalled: installed.texcount,
        imageProcessingInstalled:
          installed.gs && IMAGE_LATEX_TOOLS.some((tool) => installed[tool]),
        platform: this.deps.getPlatform(),
        ...toolPaths,
        graphicsmagickPath: gm ?? magick,
        packageManager: this.deps.detectPackageManager(),
      } satisfies LatexSettingsStatus;
    }).pipe(
      // `catchCause` answers a defect the same way the `try`/`catch` it
      // replaces answered a throw: every tool then reports as not installed,
      // so the failure must not be indistinguishable from a machine with no
      // TeX. An interrupted detection is not a detection failure, so it
      // propagates instead of painting the view with an all-missing status.
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : Effect.gen({ self: this }, function* () {
              const error = Cause.squash(cause);
              yield* Effect.logWarning(
                `LaTeX tooling detection failed: ${toErrorMessage(error)}`,
              ).pipe(
                Effect.annotateLogs({ data: error }),
                withLogChannel(CHANNEL),
              );
              this.deps.onDetectionError?.(error);
              return {
                ...DEFAULT_LATEX_SETTINGS_STATUS,
                platform: this.deps.getPlatform(),
              } satisfies LatexSettingsStatus;
            }),
      ),
    );
  }

  private checkTools(): Effect.Effect<
    Record<ProbedLatexTool, boolean>,
    never,
    ChildProcessSpawner
  > {
    return Effect.all(
      PROBED_LATEX_TOOLS.map((tool) =>
        Effect.map(
          this.deps.checkToolInstalled(tool),
          (installed) => [tool, installed] as const,
        ),
      ),
      { concurrency: 'unbounded' },
    ).pipe(
      Effect.map(
        (entries) =>
          Object.fromEntries(entries) as Record<ProbedLatexTool, boolean>,
      ),
    );
  }
}
