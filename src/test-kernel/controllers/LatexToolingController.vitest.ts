import { it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

import {
  detectLatexSettingsStatus,
  isAllowedLatexInstallCommand,
} from '@controllers/settingsView/LatexToolingController';
import { DEFAULT_LATEX_SETTINGS_STATUS } from '@shared/settingsView/settingsViewMessages';
import {
  HOMEBREW_INSTALL_COMMAND,
  normalizePlatform,
} from '@shared/constants/latexToolchain';
import { nodeSpawnerLayer } from '@test/support/childProcessTestLayer';
import { SetupPlatform } from '@tools/setup/platform';

/** The probes the status reads, doubled so no tool is spawned. */
const probes = vi.hoisted(() => ({
  installed: new Set<string>(),
  checkToolInstalled: vi.fn<(tool: string) => boolean>(),
}));

vi.mock('@utils/system/toolUtils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@utils/system/toolUtils')>()),
  checkToolInstalled: (tool: string) =>
    Effect.sync(() => probes.checkToolInstalled(tool)),
  detectPackageManager: () => null,
}));
vi.mock('@utils/system/binaryResolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@utils/system/binaryResolver')>()),
  findToolInCommonPaths: () => Effect.succeed(null),
}));

/** A host with no extension surface; the spawner is mocked out above. */
const layer = Layer.merge(
  nodeSpawnerLayer,
  SetupPlatform.layer({
    host: 'desktop',
    signIn: () => Effect.succeed(false),
  }),
);

describe('LatexToolingController', () => {
  beforeEach(() => {
    probes.installed.clear();
    probes.checkToolInstalled.mockImplementation((tool) =>
      probes.installed.has(tool),
    );
  });

  it.effect(
    'keeps compound dependency flags false until every required tool is present',
    () =>
      Effect.gen(function* () {
        for (const tool of ['pdflatex', 'latexindent', 'gs']) {
          probes.installed.add(tool);
        }
        const status = yield* detectLatexSettingsStatus({
          outDir: false,
          autoRevealExclude: false,
        });

        expect(status.texDistributionInstalled).toBe(true);
        expect(status.latexindentInstalled).toBe(false);
        expect(status.imageProcessingInstalled).toBe(false);
        // No extension surface on this host.
        expect(status.latexWorkshopInstalled).toBe(false);
      }).pipe(Effect.provide(layer)),
  );

  it.effect('falls back to defaults when detection fails', () =>
    Effect.gen(function* () {
      probes.checkToolInstalled.mockImplementation(() => {
        throw new Error('probe failed');
      });

      expect(
        yield* detectLatexSettingsStatus({
          outDir: true,
          autoRevealExclude: true,
        }),
      ).toStrictEqual({
        ...DEFAULT_LATEX_SETTINGS_STATUS,
        platform: normalizePlatform(process.platform),
      });
    }).pipe(Effect.provide(layer)),
  );

  it('allowlists structured install commands only', () => {
    expect(isAllowedLatexInstallCommand(HOMEBREW_INSTALL_COMMAND)).toBe(true);
    expect(isAllowedLatexInstallCommand('rm -rf ~/.texra')).toBe(false);
  });
});
