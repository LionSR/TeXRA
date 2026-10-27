// Third-party imports
import { it } from '@effect/vitest';
import { Effect, FileSystem } from 'effect';
import { describe, expect, vi } from 'vitest';

// Local imports
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { replaceInputCommands } from '@texra/agent/output/fileMapping';
import {
  createExternalLocation as externalLocation,
  createWorkspaceLocation,
} from '@utils/files/fileLocation';

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
        [
          { source: 'main.tex', location: outputMain },
          { source: 'sections/method.tex', location: outputSection },
        ],
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
  it.effect(
    'keeps each \\input on its own base when two bases share a file name',
    () =>
      Effect.gen(function* () {
        const bases = ['paper.tex', 'a/main.tex', 'b/main.tex'].map((file) =>
          createWorkspaceLocation(`/w/${file}`, file),
        );
        // Outputs sit at the model-reported source path under the round dir.
        const outputs = ['paper.tex', 'a/main.tex', 'b/main.tex'].map(
          (source) => ({
            source,
            location: externalLocation(`/r/r1/${source}`),
          }),
        );
        const original = String.raw`\input{a/main} \input{b/main}`;
        const files = new Map<string, string>(
          outputs.map(({ location }) => [location.absolutePath, original]),
        );
        const fs = yield* FileSystem.FileSystem;

        yield* replaceInputCommands(bases, outputs).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readFileString: (target: string) =>
              Effect.succeed(files.get(target) ?? ''),
            writeFileString: (target: string, content: string) =>
              Effect.sync(() => {
                files.set(target, content);
              }),
          }),
        );

        expect(files.get('/r/r1/paper.tex')).toBe(original);
      }).pipe(Effect.provide(nodePlatformLayer)),
  );
});
