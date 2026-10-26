import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

import { nodeSpawnerLayer } from '@test/support/childProcessTestLayer';
import {
  detectLatexSettingsStatus,
  isAllowedLatexInstallCommand,
} from '@texra/controllers/settingsView/LatexToolingController';
import { HOMEBREW_INSTALL_COMMAND } from '@texra/shared/constants/latexToolchain';

/** The probes the status reads, doubled so no tool is spawned. */
const probes = vi.hoisted(() => ({
  installed: new Set<string>(),
  checkToolInstalled: vi.fn<(tool: string) => boolean>(),
}));

vi.mock('@texra/utils/system/toolChecks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@texra/utils/system/toolChecks')>()),
  checkToolInstalled: (tool: string) =>
    Effect.sync(() => probes.checkToolInstalled(tool)),
  detectPackageManager: () => null,
}));
vi.mock('@utils/system/binaryResolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@utils/system/binaryResolver')>()),
  findCommand: () => Effect.succeed(null),
}));

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
          latexWorkshopInstalled: false,
        });

        expect(status.texDistributionInstalled).toBe(true);
        expect(status.latexindentInstalled).toBe(false);
        expect(status.imageProcessingInstalled).toBe(false);
      }).pipe(Effect.provide(nodeSpawnerLayer)),
  );

  it('allowlists structured install commands only', () => {
    expect(isAllowedLatexInstallCommand(HOMEBREW_INSTALL_COMMAND)).toBe(true);
    expect(isAllowedLatexInstallCommand('rm -rf ~/.texra')).toBe(false);
  });
});
