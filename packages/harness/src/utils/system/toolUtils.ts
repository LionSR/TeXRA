/**
 * The image processor PDF rasterization and image resizing pick, probed by
 * its version command on the extended PATH. Whether another tool is
 * installed, and how to install it, are the app's.
 */

// Third-party imports
import { Context, Effect, Ref } from 'effect';

// Local file imports
import { executeCommand } from './execUtils';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

/** The version command of each image processor: GraphicsMagick has no
 *  `--version` flag. */
const IMAGE_TOOL_COMMANDS = {
  magick: ['magick', '--version'],
  gm: ['gm', 'version'],
} as const;

/** Whether `command` answers: it exits 0, or prints a version (some tools
 *  exit non-zero for their version command). A `--version` probe answers
 *  the same from any directory, so it runs in the process cwd. */
const answers = (command: readonly string[]) =>
  Effect.map(
    executeCommand([...command], {
      cwd: process.cwd(),
      settings: undefined,
      timeout: 5000,
      quiet: true,
    }),
    (result) =>
      result.exitCode === 0 || /\d+\.\d+/.test(result.stdout + result.stderr),
  );

/** The image processor found, kept for the process: every image resize and
 *  PDF conversion asks, and each probe spawns two processes. A miss is not
 *  kept, so a tool installed mid-session is found on the next ask. */
const FoundImageTool = Context.Reference<Ref.Ref<'magick' | 'gm' | undefined>>(
  '@texra-ai/harness/FoundImageTool',
  {
    defaultValue: () => Ref.makeUnsafe<'magick' | 'gm' | undefined>(undefined),
  },
);

/**
 * Which of the two interchangeable image processors is installed, preferring
 * ImageMagick, or `null` when neither is. The single owner of the
 * "magick or gm" alternation that PDF rasterization, image resizing, and the
 * core-dependency check all decide on.
 */
export const detectImageTool = Effect.fn('toolUtils.detectImageTool')(
  function* (): Effect.fn.Return<
    'magick' | 'gm' | null,
    never,
    ChildProcessSpawner
  > {
    const found = yield* FoundImageTool;
    const kept = yield* Ref.get(found);
    if (kept !== undefined) return kept;
    const [hasMagick, hasGm] = yield* Effect.all(
      (['magick', 'gm'] as const).map((tool) =>
        answers(IMAGE_TOOL_COMMANDS[tool]),
      ),
      { concurrency: 'unbounded' },
    );
    const tool = hasMagick ? 'magick' : hasGm ? 'gm' : undefined;
    yield* Ref.set(found, tool);
    return tool ?? null;
  },
);
