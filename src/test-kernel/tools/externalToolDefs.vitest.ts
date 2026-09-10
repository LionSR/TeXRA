// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

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

/** Restore the default platform the way each test's `finally` did. */
const restorePlatform = <A, E, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  self.pipe(Effect.ensuring(Effect.promise(() => installPlatform())));

describe('external tool definitions', () => {
  it.effect(
    'detects the current TeXRA CLI process through the host checker',
    () =>
      restorePlatform(
        Effect.gen(function* () {
          const texraCli = findExternalToolDef('texra-cli');
          if (!texraCli)
            throw new Error('TeXRA CLI tool definition should exist');
          yield* Effect.promise(() => installToolAvailability(true));

          const probeResult = yield* texraCli.probe!();

          expect(probeResult).toBe(true);
          expect(yield* texraCli.check(probeResult)).toBe(true);
          expect(yield* texraCli.statusLabel!(probeResult)).toBe(
            'Detected; integration coming soon',
          );
        }),
      ),
  );

  it.effect(
    'detects Lean direct mode from the lake binary without running lake',
    () =>
      restorePlatform(
        Effect.gen(function* () {
          const lean = findExternalToolDef('lean4');
          if (!lean) throw new Error('Lean tool definition should exist');
          const findPath = vi
            .spyOn(BinaryResolver, 'findPath')
            .mockReturnValue('/usr/local/bin/lake');
          yield* Effect.promise(() => installToolAvailability(false));

          const probeResult = yield* lean.probe!();

          expect(findPath).toHaveBeenCalledWith('lake');
          expect(probeResult).toEqual({
            extensionAvailable: false,
            lakeAvailable: true,
          });
          expect(yield* lean.check(probeResult)).toBe(true);

          findPath.mockReturnValue(null);
          const missingProbeResult = yield* lean.probe!();

          expect(missingProbeResult).toEqual({
            extensionAvailable: false,
            lakeAvailable: false,
          });
          expect(yield* lean.check(missingProbeResult)).toBe(false);
        }),
      ),
  );
});
