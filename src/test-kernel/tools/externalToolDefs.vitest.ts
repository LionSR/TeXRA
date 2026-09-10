// Third-party imports
import { Effect } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports - platform/test support/tools
import { installPlatform } from '@test/support/setupPlatform';
import { findExternalToolDef } from '@tools/externalToolDefs';
import { BinaryResolver } from '@utils/system/binaryResolver';

afterEach(() => {
  vi.restoreAllMocks();
});

function installToolAvailability(isTexraCliEntrypoint: boolean) {
  return installPlatform(
    {},
    {
      toolAvailability: {
        isVscodeExtensionInstalled: () => false,
        isTexraCliEntrypoint: () => isTexraCliEntrypoint,
      },
    },
  );
}

describe('external tool definitions', () => {
  it('detects the current TeXRA CLI process through the host checker', async () => {
    const texraCli = findExternalToolDef('texra-cli');
    if (!texraCli) throw new Error('TeXRA CLI tool definition should exist');
    await installToolAvailability(true);

    try {
      const probeResult = await Effect.runPromise(texraCli.probe!());

      expect(probeResult).toBe(true);
      expect(await Effect.runPromise(texraCli.check(probeResult))).toBe(true);
      expect(await Effect.runPromise(texraCli.statusLabel!(probeResult))).toBe(
        'Detected; integration coming soon',
      );
    } finally {
      await installPlatform();
    }
  });

  it('detects Lean direct mode from the lake binary without running lake', async () => {
    const lean = findExternalToolDef('lean4');
    if (!lean) throw new Error('Lean tool definition should exist');
    const findPath = vi
      .spyOn(BinaryResolver, 'findPath')
      .mockReturnValue('/usr/local/bin/lake');
    await installToolAvailability(false);

    try {
      const probeResult = await Effect.runPromise(lean.probe!());

      expect(findPath).toHaveBeenCalledWith('lake');
      expect(probeResult).toEqual({
        extensionAvailable: false,
        lakeAvailable: true,
      });
      await expect(Effect.runPromise(lean.check(probeResult))).resolves.toBe(
        true,
      );

      findPath.mockReturnValue(null);
      const missingProbeResult = await Effect.runPromise(lean.probe!());

      expect(missingProbeResult).toEqual({
        extensionAvailable: false,
        lakeAvailable: false,
      });
      await expect(
        Effect.runPromise(lean.check(missingProbeResult)),
      ).resolves.toBe(false);
    } finally {
      await installPlatform();
    }
  });
});
