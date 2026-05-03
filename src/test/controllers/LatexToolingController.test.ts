// Standard library imports
import { strict as assert } from 'assert';

// Local imports - shared constants
import {
  HOMEBREW_INSTALL_COMMAND,
  type Platform,
} from '../../shared/constants/latex';

// Local imports - shared schemas
import { DEFAULT_LATEX_SETTINGS_STATUS } from '../../shared/schemas/settingsViewMessages';

// Local imports - controllers
import {
  LatexToolingController,
  type LatexPathTool,
  type LatexToolingControllerDeps,
} from '../../controllers/settingsView/LatexToolingController';

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
    platform: Platform;
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
    resolvePath: (tool) => paths[tool] ?? null,
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

    assert.deepEqual(status, {
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

    assert.equal(status.texDistributionInstalled, true);
    assert.equal(status.latexindentInstalled, false);
    assert.equal(status.imageProcessingInstalled, false);
  });

  it('falls back to defaults when detection fails', async () => {
    const errors: unknown[] = [];
    const controller = new LatexToolingController({
      checkToolInstalled: async () => {
        throw new Error('probe failed');
      },
      resolvePath: () => null,
      detectPackageManager: () => 'apt',
      getPlatform: () => 'win32',
      isLatexWorkshopInstalled: () => true,
      getRecommendedStatus: () => ({ outDir: true, autoRevealExclude: true }),
      onDetectionError: (error) => errors.push(error),
    });

    assert.deepEqual(await controller.detectStatus(), {
      ...DEFAULT_LATEX_SETTINGS_STATUS,
      platform: 'win32',
    });
    assert.equal(errors.length, 1);
  });

  it('allowlists structured install commands only', () => {
    const controller = createController();

    assert.equal(
      controller.isAllowedInstallCommand(HOMEBREW_INSTALL_COMMAND),
      true,
    );
    assert.equal(controller.isAllowedInstallCommand('rm -rf ~/.texra'), false);
  });
});
