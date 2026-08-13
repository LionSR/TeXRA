import { describe, expect, it } from 'vitest';

import {
  LatexToolingController,
  type LatexPathTool,
  type LatexToolingControllerDeps,
} from '@controllers/settingsView/LatexToolingController';
import {
  HOMEBREW_INSTALL_COMMAND,
  type OSPlatform,
} from '@shared/constants/latexToolchain';
import { DEFAULT_LATEX_SETTINGS_STATUS } from '@shared/schemas/settingsViewMessages';

const INSTALLED_TOOLS = {
  pdflatex: false,
  latexmk: false,
  latexdiff: false,
  latexindent: false,
  perl: false,
  texcount: false,
  gs: false,
  gm: false,
  magick: false,
};

function createController(
  options?: Partial<{
    installedTools: Partial<Record<keyof typeof INSTALLED_TOOLS, boolean>>;
    paths: Partial<Record<LatexPathTool, string | null>>;
    platform: OSPlatform;
    packageManager: 'brew' | 'apt' | 'scoop' | null;
    extensionInstalled: boolean;
    outDir: boolean;
    autoRevealExclude: boolean;
    onDetectionError: (error: unknown) => void;
  }>,
): LatexToolingController {
  const installedTools = {
    ...INSTALLED_TOOLS,
    ...options?.installedTools,
  };
  const paths = options?.paths ?? {};
  const deps: LatexToolingControllerDeps = {
    checkToolInstalled: async (tool) => installedTools[tool],
    findPath: (tool) => paths[tool] ?? null,
    detectPackageManager: () => options?.packageManager ?? null,
    getPlatform: () => options?.platform ?? 'linux',
    isLatexWorkshopInstalled: () => options?.extensionInstalled ?? false,
    getRecommendedStatus: () => ({
      outDir: options?.outDir ?? false,
      autoRevealExclude: options?.autoRevealExclude ?? false,
    }),
    onDetectionError: options?.onDetectionError,
  };
  return new LatexToolingController(deps);
}

describe('LatexToolingController', () => {
  it('builds status from probes, paths, and host facts', async () => {
    const status = await createController({
      installedTools: {
        latexmk: true,
        latexdiff: true,
        latexindent: true,
        perl: true,
        texcount: true,
        gs: true,
        magick: true,
      },
      paths: {
        latexmk: '/usr/bin/latexmk',
        latexdiff: '/usr/bin/latexdiff',
        latexindent: '/usr/bin/latexindent',
        texcount: '/usr/bin/texcount',
        gs: '/usr/bin/gs',
        magick: '/usr/bin/magick',
      },
      platform: 'darwin',
      packageManager: 'brew',
      extensionInstalled: true,
      outDir: true,
      autoRevealExclude: true,
    }).detectStatus();

    expect(status).toStrictEqual({
      outDir: true,
      autoRevealExclude: true,
      texDistributionInstalled: true,
      latexWorkshopInstalled: true,
      latexdiffInstalled: true,
      latexindentInstalled: true,
      texcountInstalled: true,
      imageProcessingInstalled: true,
      platform: 'darwin',
      pdflatexPath: null,
      latexmkPath: '/usr/bin/latexmk',
      latexdiffPath: '/usr/bin/latexdiff',
      latexindentPath: '/usr/bin/latexindent',
      texcountPath: '/usr/bin/texcount',
      ghostscriptPath: '/usr/bin/gs',
      graphicsmagickPath: '/usr/bin/magick',
      packageManager: 'brew',
    });
  });

  it('keeps compound dependency flags false until every required tool is present', async () => {
    const status = await createController({
      installedTools: {
        pdflatex: true,
        latexindent: true,
        gs: true,
      },
    }).detectStatus();

    expect(status.texDistributionInstalled).toBe(true);
    expect(status.latexindentInstalled).toBe(false);
    expect(status.imageProcessingInstalled).toBe(false);
  });

  it('falls back to defaults when detection fails', async () => {
    const errors: unknown[] = [];
    const controller = new LatexToolingController({
      checkToolInstalled: async () => {
        throw new Error('probe failed');
      },
      findPath: () => null,
      detectPackageManager: () => 'apt',
      getPlatform: () => 'win32',
      isLatexWorkshopInstalled: () => true,
      getRecommendedStatus: () => ({ outDir: true, autoRevealExclude: true }),
      onDetectionError: (error) => errors.push(error),
    });

    expect(await controller.detectStatus()).toStrictEqual({
      ...DEFAULT_LATEX_SETTINGS_STATUS,
      platform: 'win32',
    });
    expect(errors).toHaveLength(1);
  });

  it('allowlists structured install commands only', () => {
    const controller = createController();

    expect(controller.isAllowedInstallCommand(HOMEBREW_INSTALL_COMMAND)).toBe(
      true,
    );
    expect(controller.isAllowedInstallCommand('rm -rf ~/.texra')).toBe(false);
  });
});
