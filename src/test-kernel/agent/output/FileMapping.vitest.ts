// Third-party imports
import { it } from '@effect/vitest';
import { Effect, FileSystem } from 'effect';
import { describe, expect, vi } from 'vitest';

// Local imports
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { replaceInputCommands } from '@texra/agent/output/fileMapping';
import { createExternalLocation as externalLocation } from '@utils/files/fileLocation';

describe('replaceInputCommands', () => {
  it.effect('rewrites an extensionless LaTeX input to the generated file', () =>
    Effect.gen(function* () {
      const baseMain = externalLocation('/workspace/main.tex');
      const baseSection = externalLocation('/workspace/sections/method.tex');
      const outputMain = externalLocation('/run/main_r1.tex');
      const outputSection = externalLocation('/run/sections/method_r1.tex');
      const write = vi.fn(() => Effect.void);
      // The real filesystem with its read and write replaced, so no real file
      // is touched.
      const fs = yield* FileSystem.FileSystem;

      yield* replaceInputCommands(
        [baseMain, baseSection],
        [outputMain, outputSection],
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readFileString: (target: string) =>
            Effect.succeed(
              target === outputMain.absolutePath
                ? String.raw`\input{sections/method}`
                : 'Section content',
            ),
          writeFileString: write,
        }),
      );

      expect(write).toHaveBeenCalledWith(
        outputMain.absolutePath,
        String.raw`\input{sections/method_r1}`,
      );
    }).pipe(Effect.provide(nodePlatformLayer)),
  );
});
