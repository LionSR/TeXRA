import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

import { LatexToolingController } from '@controllers/settingsView/LatexToolingController';
import { DEFAULT_LATEX_SETTINGS_STATUS } from '@shared/settingsView/settingsViewMessages';
import {
  HOMEBREW_INSTALL_COMMAND,
  type OSPlatform,
} from '@shared/constants/latexToolchain';
import { nodeSpawnerLayer } from '@test/support/childProcessTestLayer';

/** The controller's deps and probe-tool names are file-local; derive them. */
type LatexToolingControllerDeps = ConstructorParameters<
  typeof LatexToolingController
>[0];
type LatexPathTool = Parameters<LatexToolingControllerDeps['findPath']>[0];

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
    checkToolInstalled: (tool) => Effect.succeed(installedTools[tool]),
    findPath: (tool) => Effect.succeed(paths[tool] ?? null),
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
  it.effect(
    'keeps compound dependency flags false until every required tool is present',
    () =>
      Effect.gen(function* () {
        const status = yield* createController({
          installedTools: {
            pdflatex: true,
            latexindent: true,
            gs: true,
          },
        }).detectStatus();

        expect(status.texDistributionInstalled).toBe(true);
        expect(status.latexindentInstalled).toBe(false);
        expect(status.imageProcessingInstalled).toBe(false);
      }).pipe(Effect.provide(nodeSpawnerLayer)),
  );

  it.effect('falls back to defaults when detection fails', () =>
    Effect.gen(function* () {
      const errors: unknown[] = [];
      const controller = new LatexToolingController({
        checkToolInstalled: () =>
          Effect.sync(() => {
            throw new Error('probe failed');
          }),
        findPath: () => Effect.succeed(null),
        detectPackageManager: () => 'apt',
        getPlatform: () => 'win32',
        isLatexWorkshopInstalled: () => true,
        getRecommendedStatus: () => ({ outDir: true, autoRevealExclude: true }),
        onDetectionError: (error) => errors.push(error),
      });

      expect(yield* controller.detectStatus()).toStrictEqual({
        ...DEFAULT_LATEX_SETTINGS_STATUS,
        platform: 'win32',
      });
      expect(errors).toHaveLength(1);
    }).pipe(Effect.provide(nodeSpawnerLayer)),
  );

  it('allowlists structured install commands only', () => {
    const controller = createController();

    expect(controller.isAllowedInstallCommand(HOMEBREW_INSTALL_COMMAND)).toBe(
      true,
    );
    expect(controller.isAllowedInstallCommand('rm -rf ~/.texra')).toBe(false);
  });
});
