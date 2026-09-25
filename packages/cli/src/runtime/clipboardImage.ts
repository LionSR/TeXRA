// Clipboard image adapter for the chat TUI.
//
// Terminals do not forward binary clipboard data through bracketed paste, so
// image attachment is an explicit action (ctrl+v) that probes the OS clipboard
// out-of-band, mirroring Claude Code's approach with built-in tooling only (no
// extra installs on macOS/Windows):
//   - macOS:   osascript `«class PNGf»` → temp PNG
//   - Linux:   wl-paste (Wayland) / xclip (X11) image/png
//   - Windows: PowerShell Get-Clipboard -Format Image → PNG
// The saved file flows through the same shared `pasted/` storage dir +
// `run/mediaInput` path as the extension webview, so no model-layer code is
// duplicated.
//
// The probe is a program, not a promise: the input bar that offers ctrl+v
// runs it on the process runtime it already holds, so nothing here runs an
// Effect of its own and the clipboard tools stay one wrapped foreign edge.

import { readFile, stat } from 'node:fs/promises';
import { platform as osPlatform } from 'node:os';
import { dirname, join } from 'node:path';

import { Data, Effect, FileSystem, type Path, Stream } from 'effect';
import * as ChildProcess from 'effect/unstable/process/ChildProcess';

import { withSessionFs } from '@platform/rootedFs';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import { generatePastedImageName } from '@utils/files/pastedImageName';
import {
  type PastedImageSaveFailed,
  savePastedImageBuffer,
} from '@utils/files/pastedImageUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { executeCommand } from '@utils/system/execUtils';
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';
import type { PlatformError } from 'effect/PlatformError';

const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

/** A clipboard tool's stdout passed {@link MAX_IMAGE_BYTES}. */
class ClipboardImageTooLarge extends Data.TaggedError(
  'ClipboardImageTooLarge',
) {}

/**
 * The clipboard probe failed at a foreign edge (an OS clipboard tool, a
 * temp-dir creation, or a temp-file read): the untagged value that edge
 * threw, wrapped here so the channel stays typed. `message` is the cause's
 * own message, which is what the input bar's error hook prints.
 */
export class ClipboardImageProbeFailed extends Data.TaggedError(
  'ClipboardImageProbeFailed',
)<{
  readonly message: string;
  readonly cause: unknown;
}> {}

const probeFailed = (cause: unknown): ClipboardImageProbeFailed =>
  new ClipboardImageProbeFailed({ message: toErrorMessage(cause), cause });

type ClipboardAttachResult =
  | {
      readonly ok: true;
      /** Absolute path to the saved image under the shared `pasted/` dir. */
      readonly path: string;
      readonly mediaType: string;
      readonly displayName: string;
    }
  | { readonly ok: false; readonly reason: string };

/** Per-platform read result: PNG bytes, no image present, or unsupported. */
type ClipboardRead = Buffer | 'none' | 'unsupported' | 'too-large';

/** The PNG a platform reader wrote, or the size refusal. A failure here is
 *  the probe's failure, not "no image": it reaches the caller's error hook. */
function readPngFileWithinLimit(
  outFile: string,
): Effect.Effect<ClipboardRead, ClipboardImageProbeFailed> {
  return Effect.tryPromise({
    try: async (): Promise<ClipboardRead> => {
      const { size } = await stat(outFile);
      if (size > MAX_IMAGE_BYTES) return 'too-large';
      return readFile(outFile);
    },
    catch: probeFailed,
  });
}

/** Whether a platform reader ran to success and left no 'NO_IMAGE' mark. */
function readerWrote(
  command: readonly [string, ...string[]],
  outDir: string,
): Effect.Effect<boolean, never, ChildProcessSpawner> {
  return Effect.map(
    executeCommand([...command], {
      cwd: outDir,
      settings: undefined,
      quiet: true,
    }),
    (result) => result.success && !result.stdout.includes('NO_IMAGE'),
  );
}

function readClipboardPngMac(
  outFile: string,
): Effect.Effect<
  ClipboardRead,
  ClipboardImageProbeFailed,
  ChildProcessSpawner
> {
  // osascript ships with macOS — no external dependency. The first statement
  // fails when the clipboard holds no image, which is the 'none' outcome.
  return readerWrote(
    [
      'osascript',
      '-e',
      'set png_data to (the clipboard as «class PNGf»)',
      '-e',
      `set fp to open for access POSIX file "${outFile}" with write permission`,
      '-e',
      'write png_data to fp',
      '-e',
      'close access fp',
    ],
    dirname(outFile),
  ).pipe(
    Effect.flatMap((written) =>
      written ? readPngFileWithinLimit(outFile) : Effect.succeed('none'),
    ),
  );
}

/** One Linux clipboard tool's PNG bytes, stopped past the size limit. The
 *  scope's release kills a tool stopped early. */
const readToolBytes = (cmd: string, args: readonly string[]) =>
  Effect.gen(function* () {
    const handle = yield* ChildProcess.make(cmd, args, {
      stdin: 'ignore',
      stderr: 'ignore',
      detached: false,
      forceKillAfter: '5 seconds',
    });
    const chunks = yield* handle.stdout.pipe(
      Stream.runFoldEffect(
        () => ({ chunks: [] as Uint8Array[], size: 0 }),
        (acc, chunk) => {
          const size = acc.size + chunk.length;
          if (size > MAX_IMAGE_BYTES) {
            return Effect.fail(new ClipboardImageTooLarge());
          }
          acc.chunks.push(chunk);
          return Effect.succeed({ chunks: acc.chunks, size });
        },
      ),
    );
    const code = yield* handle.exitCode;
    return code === 0 ? Buffer.concat(chunks.chunks) : Buffer.alloc(0);
  }).pipe(Effect.scoped);

function readClipboardPngLinux(): Effect.Effect<
  ClipboardRead,
  never,
  ChildProcessSpawner
> {
  // Prefer Wayland (wl-paste) then X11 (xclip). Both are optional; if neither
  // is installed we report unsupported rather than "no image".
  const attempts: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['wl-paste', ['--type', 'image/png']],
    ['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']],
  ];
  return Effect.gen(function* () {
    let toolFound = false;
    for (const [cmd, args] of attempts) {
      const outcome = yield* Effect.result(readToolBytes(cmd, args));
      if (outcome._tag === 'Success') {
        toolFound = true;
        if (outcome.success.length > 0) return outcome.success;
        continue;
      }
      const failure: ClipboardImageTooLarge | PlatformError = outcome.failure;
      if (failure._tag === 'ClipboardImageTooLarge') return 'too-large';
      if (failure.reason._tag === 'NotFound') continue; // tool not installed → try next
      toolFound = true; // tool ran but the clipboard had no image
    }
    return toolFound ? 'none' : 'unsupported';
  });
}

function readClipboardPngWindows(
  outFile: string,
): Effect.Effect<
  ClipboardRead,
  ClipboardImageProbeFailed,
  ChildProcessSpawner
> {
  const quotedOutFile = outFile.replaceAll("'", "''");
  const script = `$img = Get-Clipboard -Format Image; if ($img) { Add-Type -AssemblyName System.Drawing; $img.Save('${quotedOutFile}', [System.Drawing.Imaging.ImageFormat]::Png) } else { Write-Output 'NO_IMAGE' }`;
  return readerWrote(
    ['powershell', '-NoProfile', '-Command', script],
    dirname(outFile),
  ).pipe(
    Effect.flatMap((saved) =>
      saved ? readPngFileWithinLimit(outFile) : Effect.succeed('none'),
    ),
  );
}

/**
 * Read an image from the OS clipboard, persist it under `roots`' own `pasted/`
 * directory, and return its location. Yields `{ ok: false, reason }` when the
 * clipboard holds no image or the platform/tooling is unsupported — callers
 * surface `reason` and leave the text draft untouched. The directory the
 * platform readers write into is a scoped resource, removed on every exit:
 * success, failure and interruption alike.
 */
export function attachClipboardImage(
  roots: Pick<WorkspaceRoots, 'workspace' | 'storage'>,
): Effect.Effect<
  ClipboardAttachResult,
  ClipboardImageProbeFailed | PastedImageSaveFailed,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner
> {
  /** Nothing attached: the caller surfaces `reason` and keeps the draft. */
  const notAttached = (reason: string): ClipboardAttachResult => ({
    ok: false,
    reason,
  });
  return Effect.gen(function* () {
    const plat = osPlatform();
    if (plat !== 'darwin' && plat !== 'linux' && plat !== 'win32') {
      return notAttached(`Image paste is not supported on ${plat}.`);
    }

    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs
      .makeTempDirectoryScoped({ prefix: 'texra-clip-' })
      .pipe(Effect.mapError(probeFailed));
    const tmpFile = join(dir, 'clipboard.png');

    let reader: Effect.Effect<
      ClipboardRead,
      ClipboardImageProbeFailed,
      ChildProcessSpawner
    >;
    switch (plat) {
      case 'darwin':
        reader = readClipboardPngMac(tmpFile);
        break;
      case 'linux':
        reader = readClipboardPngLinux();
        break;
      default:
        reader = readClipboardPngWindows(tmpFile);
        break;
    }
    const read = yield* reader;

    if (read === 'unsupported') {
      return notAttached(
        'Image paste on Linux needs wl-clipboard (Wayland) or xclip (X11).',
      );
    }
    if (read === 'none') return notAttached('No image found on the clipboard.');
    if (read === 'too-large') {
      return notAttached('Clipboard image is too large to attach.');
    }

    const fileName = generatePastedImageName('png');
    const path = yield* withSessionFs(
      roots,
      savePastedImageBuffer(read, fileName),
    );
    return {
      ok: true as const,
      path,
      mediaType: 'image/png',
      displayName: fileName,
    };
  }).pipe(Effect.scoped);
}
