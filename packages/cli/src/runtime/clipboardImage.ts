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

import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { platform as osPlatform } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { Data, Effect, FileSystem, type Path } from 'effect';

import { isFileNotFoundError } from '@common/errors';
import { withSessionFs } from '@platform/rootedFs';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import { generatePastedImageName } from '@utils/files/pastedImageName';
import {
  type PastedImageSaveFailed,
  savePastedImageBuffer,
} from '@utils/files/pastedImageUtils';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

const execFileAsync = promisify(execFile);
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

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

function isMaxBufferError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
  );
}

function readClipboardPngMac(
  outFile: string,
): Effect.Effect<ClipboardRead, ClipboardImageProbeFailed> {
  // osascript ships with macOS — no external dependency. The first statement
  // fails when the clipboard holds no image, which is the 'none' outcome.
  return Effect.tryPromise(() =>
    execFileAsync('osascript', [
      '-e',
      'set png_data to (the clipboard as «class PNGf»)',
      '-e',
      `set fp to open for access POSIX file "${outFile}" with write permission`,
      '-e',
      'write png_data to fp',
      '-e',
      'close access fp',
    ]),
  ).pipe(
    Effect.match({ onSuccess: () => true, onFailure: () => false }),
    Effect.flatMap((written) =>
      written ? readPngFileWithinLimit(outFile) : Effect.succeed('none'),
    ),
  );
}

function readClipboardPngLinux(): Effect.Effect<ClipboardRead> {
  // Prefer Wayland (wl-paste) then X11 (xclip). Both are optional; if neither
  // is installed we report unsupported rather than "no image".
  const attempts: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['wl-paste', ['--type', 'image/png']],
    ['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']],
  ];
  return Effect.gen(function* () {
    let toolFound = false;
    for (const [cmd, args] of attempts) {
      const outcome = yield* Effect.result(
        Effect.tryPromise({
          try: () =>
            execFileAsync(cmd, [...args], {
              encoding: 'buffer',
              maxBuffer: MAX_IMAGE_BYTES,
            }),
          // `Effect.result` absorbs the rejection into the value channel, and
          // the classifiers below (`isMaxBufferError`, `isFileNotFoundError`)
          // read the raw error's `code`, which a tagged wrapper would strip:
          // `ensureError` hands an `Error` back as itself.
          catch: ensureError,
        }),
      );
      if (outcome._tag === 'Success') {
        toolFound = true;
        const buffer = outcome.success.stdout as unknown as Buffer;
        if (buffer.length > 0) return buffer;
        continue;
      }
      if (isMaxBufferError(outcome.failure)) return 'too-large';
      if (isFileNotFoundError(outcome.failure)) continue; // tool not installed → try next
      toolFound = true; // tool ran but the clipboard had no image
    }
    return toolFound ? 'none' : 'unsupported';
  });
}

function readClipboardPngWindows(
  outFile: string,
): Effect.Effect<ClipboardRead, ClipboardImageProbeFailed> {
  const quotedOutFile = outFile.replaceAll("'", "''");
  const script = `$img = Get-Clipboard -Format Image; if ($img) { Add-Type -AssemblyName System.Drawing; $img.Save('${quotedOutFile}', [System.Drawing.Imaging.ImageFormat]::Png) } else { Write-Output 'NO_IMAGE' }`;
  return Effect.tryPromise(() =>
    execFileAsync('powershell', ['-NoProfile', '-Command', script]),
  ).pipe(
    Effect.match({
      onSuccess: ({ stdout }) => !String(stdout).includes('NO_IMAGE'),
      onFailure: () => false,
    }),
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
  FileSystem.FileSystem | Path.Path
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

    let reader: Effect.Effect<ClipboardRead, ClipboardImageProbeFailed>;
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
