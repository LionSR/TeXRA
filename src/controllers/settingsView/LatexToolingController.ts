// Local imports - shared constants
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
  type OSPlatform,
} from '@shared/constants/latexToolchain';

// `CORE_LATEX_TOOLS`/`IMAGE_TOOLS` (`@shared/constants/latexToolchain`) are the
// single source of truth for the LaTeX toolchain probe set, shared with
// `probe_environment`/`verify_setup`. Do not re-list tool names here.
const LATEX_PROBE_TOOLS = [...CORE_LATEX_TOOLS, ...IMAGE_TOOLS] as const;

type LatexProbeTool = (typeof LATEX_PROBE_TOOLS)[number];

export type LatexPathTool = Exclude<LatexProbeTool, 'perl'>;

type LatexRecommendedStatus = Pick<
  LatexSettingsStatus,
  'outDir' | 'autoRevealExclude'
>;

export interface LatexToolingControllerDeps {
  checkToolInstalled(tool: LatexProbeTool): Promise<boolean>;
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

  async detectStatus(): Promise<LatexSettingsStatus> {
    try {
      const installed = await this.checkTools();
      return {
        ...this.deps.getRecommendedStatus(),
        texDistributionInstalled: installed.pdflatex || installed.latexmk,
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
      };
    } catch (error) {
      this.deps.onDetectionError?.(error);
      return {
        ...DEFAULT_LATEX_SETTINGS_STATUS,
        platform: this.deps.getPlatform(),
      };
    }
  }

  private async checkTools(): Promise<Record<LatexProbeTool, boolean>> {
    const entries = await Promise.all(
      LATEX_PROBE_TOOLS.map(
        async (tool) =>
          [tool, await this.deps.checkToolInstalled(tool)] as const,
      ),
    );
    return Object.fromEntries(entries) as Record<LatexProbeTool, boolean>;
  }
}
