// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

// Local imports - platform/test support/tools
import { installPlatform } from '@test/support/setupPlatform';
import { findExternalToolDef } from '@tools/externalToolDefs';
import {
  getProcessSettingHost,
  initProcessSettingHost,
} from '@utils/config/platformSettings';
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

/** Run as the given process host, restoring the previous one afterwards. */
const asHost = <A, E, R>(
  host: Parameters<typeof initProcessSettingHost>[0],
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = getProcessSettingHost();
      initProcessSettingHost(host);
      return previous;
    }),
    () => self,
    (previous) => Effect.sync(() => initProcessSettingHost(previous)),
  );

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
        asHost(
          'cli',
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
              requiresExtension: false,
            });
            expect(yield* lean.check(probeResult)).toBe(true);

            findPath.mockReturnValue(null);
            const missingProbeResult = yield* lean.probe!();

            expect(missingProbeResult).toEqual({
              extensionAvailable: false,
              lakeAvailable: false,
              requiresExtension: false,
            });
            expect(yield* lean.check(missingProbeResult)).toBe(false);
          }),
        ),
      ),
  );

  it.effect('requires the lean4 extension in the VS Code build', () =>
    restorePlatform(
      asHost(
        'vscode',
        Effect.gen(function* () {
          const lean = findExternalToolDef('lean4');
          if (!lean) throw new Error('Lean tool definition should exist');
          vi.spyOn(BinaryResolver, 'findPath').mockReturnValue(
            '/usr/local/bin/lake',
          );
          yield* Effect.promise(() => installToolAvailability(false));

          const probeResult = yield* lean.probe!();

          expect(yield* lean.check(probeResult)).toBe(false);
          expect(yield* lean.statusLabel!(probeResult)).toBe('Needs setup');
        }),
      ),
    ),
  );
});
