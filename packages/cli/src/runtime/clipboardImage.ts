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
// MediaAttachmentProcessor path as the extension webview, so no model-layer
// code is duplicated.

import { execFile } from 'node:child_process';
import { readFile, rm, stat } from 'node:fs/promises';
import { platform as osPlatform } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { isFileNotFoundError } from '@common/errors';
import { generatePastedImageName } from '@utils/files/pastedImageName';
import { savePastedImageBuffer } from '@utils/files/pastedImageUtils';
import { createTexraTempDir } from '@utils/files/tempDir';

const execFileAsync = promisify(execFile);
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

export type ClipboardAttachResult =
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

async function readPngFileWithinLimit(outFile: string): Promise<ClipboardRead> {
  const { size } = await stat(outFile);
  if (size > MAX_IMAGE_BYTES) return 'too-large';
  return readFile(outFile);
}

function isMaxBufferError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
  );
}

async function readClipboardPngMac(outFile: string): Promise<ClipboardRead> {
  try {
    // osascript ships with macOS — no external dependency. The first statement
    // throws when the clipboard holds no image, which lands us in the catch.
    await execFileAsync('osascript', [
      '-e',
      'set png_data to (the clipboard as «class PNGf»)',
      '-e',
      `set fp to open for access POSIX file "${outFile}" with write permission`,
      '-e',
      'write png_data to fp',
      '-e',
      'close access fp',
    ]);
  } catch {
    return 'none';
  }
  return readPngFileWithinLimit(outFile);
}

async function readClipboardPngLinux(): Promise<ClipboardRead> {
  // Prefer Wayland (wl-paste) then X11 (xclip). Both are optional; if neither
  // is installed we report unsupported rather than "no image".
  const attempts: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['wl-paste', ['--type', 'image/png']],
    ['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']],
  ];
  let toolFound = false;
  for (const [cmd, args] of attempts) {
    try {
      const { stdout } = await execFileAsync(cmd, [...args], {
        encoding: 'buffer',
        maxBuffer: MAX_IMAGE_BYTES,
      });
      toolFound = true;
      const buf = stdout as unknown as Buffer;
      if (buf.length > 0) return buf;
    } catch (err) {
      if (isMaxBufferError(err)) return 'too-large';
      if (isFileNotFoundError(err)) continue; // tool not installed → try next
      toolFound = true; // tool ran but the clipboard had no image
    }
  }
  return toolFound ? 'none' : 'unsupported';
}

async function readClipboardPngWindows(
  outFile: string,
): Promise<ClipboardRead> {
  const quotedOutFile = outFile.replaceAll("'", "''");
  const script = `$img = Get-Clipboard -Format Image; if ($img) { Add-Type -AssemblyName System.Drawing; $img.Save('${quotedOutFile}', [System.Drawing.Imaging.ImageFormat]::Png) } else { Write-Output 'NO_IMAGE' }`;
  try {
    const { stdout } = await execFileAsync('powershell', [
      '-NoProfile',
      '-Command',
      script,
    ]);
    if (String(stdout).includes('NO_IMAGE')) return 'none';
  } catch {
    return 'none';
  }
  return readPngFileWithinLimit(outFile);
}

/**
 * Read an image from the OS clipboard, persist it to the shared `pasted/`
 * storage dir, and return its location. Returns `{ ok: false, reason }` when
 * the clipboard holds no image or the platform/tooling is unsupported — callers
 * surface `reason` and leave the text draft untouched.
 */
export async function attachClipboardImage(): Promise<ClipboardAttachResult> {
  const plat = osPlatform();
  if (plat !== 'darwin' && plat !== 'linux' && plat !== 'win32') {
    return { ok: false, reason: `Image paste is not supported on ${plat}.` };
  }

  const dir = await createTexraTempDir('texra-clip-');
  const tmpFile = join(dir, 'clipboard.png');
  try {
    let read: ClipboardRead;
    switch (plat) {
      case 'darwin':
        read = await readClipboardPngMac(tmpFile);
        break;
      case 'linux':
        read = await readClipboardPngLinux();
        break;
      default:
        read = await readClipboardPngWindows(tmpFile);
        break;
    }

    if (read === 'unsupported') {
      return {
        ok: false,
        reason:
          'Image paste on Linux needs wl-clipboard (Wayland) or xclip (X11).',
      };
    }
    if (read === 'none') {
      return { ok: false, reason: 'No image found on the clipboard.' };
    }
    if (read === 'too-large') {
      return {
        ok: false,
        reason: 'Clipboard image is too large to attach.',
      };
    }

    const fileName = generatePastedImageName('png');
    const path = await savePastedImageBuffer(read, fileName);
    return { ok: true, path, mediaType: 'image/png', displayName: fileName };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
