import { Cause, Effect } from 'effect';

// Local imports - shared constants
import { createLog } from '@logger/logUtils';
import {
  DEFAULT_LATEX_SETTINGS_STATUS,
  type LatexSettingsStatus,
} from '@shared/schemas';
import {
  CORE_LATEX_TOOLS,
  DEPENDENCY_INSTALL_COMMANDS,
  HOMEBREW_INSTALL_COMMAND,
  IMAGE_TOOLS,
  SCOOP_INSTALL_COMMAND,
  SUPPORTED_LATEX_COMPILERS,
  type OSPlatform,
} from '@shared/constants/latexToolchain';
import { toErrorMessage } from '@utils/errors/errorMessage';

const log = createLog('LatexToolingController');

// `CORE_LATEX_TOOLS`/`IMAGE_TOOLS` (`@shared/constants/latexToolchain`) are the
// single source of truth for the LaTeX toolchain probe set, shared with
// `probe_environment`/`verify_setup`. Do not re-list tool names here.
const LATEX_PROBE_TOOLS = [...CORE_LATEX_TOOLS, ...IMAGE_TOOLS] as const;

type LatexProbeTool = (typeof LATEX_PROBE_TOOLS)[number];

type LatexPathTool = Exclude<LatexProbeTool, 'perl'>;

type LatexRecommendedStatus = Pick<
  LatexSettingsStatus,
  'outDir' | 'autoRevealExclude'
>;

interface LatexToolingControllerDeps {
  checkToolInstalled(tool: LatexProbeTool): Effect.Effect<boolean>;
  findPath(tool: LatexPathTool): string | null;
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

  detectStatus(): Effect.Effect<LatexSettingsStatus> {
    return Effect.gen({ self: this }, function* () {
      const installed = yield* this.checkTools();
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
          installed.gs && (installed.gm || installed.magick),
        platform: this.deps.getPlatform(),
        pdflatexPath: this.deps.findPath('pdflatex'),
        latexmkPath: this.deps.findPath('latexmk'),
        latexdiffPath: this.deps.findPath('latexdiff'),
        latexindentPath: this.deps.findPath('latexindent'),
        texcountPath: this.deps.findPath('texcount'),
        ghostscriptPath: this.deps.findPath('gs'),
        graphicsmagickPath:
          this.deps.findPath('gm') ?? this.deps.findPath('magick'),
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
          : Effect.sync(() => {
              const error = Cause.squash(cause);
              log.warn(
                `LaTeX tooling detection failed: ${toErrorMessage(error)}`,
                {
                  data: error,
                },
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

  private checkTools(): Effect.Effect<Record<LatexProbeTool, boolean>> {
    return Effect.all(
      LATEX_PROBE_TOOLS.map((tool) =>
        Effect.map(
          this.deps.checkToolInstalled(tool),
          (installed) => [tool, installed] as const,
        ),
      ),
      { concurrency: 'unbounded' },
    ).pipe(
      Effect.map(
        (entries) =>
          Object.fromEntries(entries) as Record<LatexProbeTool, boolean>,
      ),
    );
  }
}
