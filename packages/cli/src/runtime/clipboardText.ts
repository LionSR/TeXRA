import { execFile } from 'node:child_process';
import { platform as osPlatform } from 'node:os';
import { basename } from 'node:path';
import { promisify } from 'node:util';

import clipboard from 'clipboardy';
import pTimeout, { TimeoutError } from 'p-timeout';

import { toErrorMessage } from '@utils/errors/errorMessage';

const execFileAsync = promisify(execFile);

export type ClipboardTextWriteResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

const CLIPBOARD_WRITE_TIMEOUT_MS = 5_000;
const HELPER_REAP_TIMEOUT_MS = 2_000;

interface ClipboardTextWriteOptions {
  readonly platform?: NodeJS.Platform;
}

// clipboardy (5.3.1) exposes no cancellation hook — `write(text)` takes no
// signal — so a timed-out await abandons the promise while the platform helper
// clipboardy spawned lives on (#8219). On timeout we reap wedged helpers
// out-of-band instead: kill direct children of this process whose executable
// is one of clipboardy's copy commands. The parent-pid bound keeps this from
// touching processes we didn't spawn — e.g. a daemonized `wl-copy` from an
// earlier successful copy has been reparented away and must stay alive to
// keep serving the clipboard.
const POSIX_COPY_HELPERS: ReadonlySet<string> = new Set([
  'pbcopy', // macOS
  'wl-copy', // Linux (Wayland)
  'xsel', // Linux (X11), including clipboardy's bundled fallback binary
  'clip.exe', // WSL
  'termux-clipboard-set', // Android (Termux)
]);

async function reapPosixCopyHelpers(): Promise<void> {
  const { stdout } = await execFileAsync('ps', ['-Ao', 'pid=,ppid=,comm='], {
    timeout: HELPER_REAP_TIMEOUT_MS,
  });
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    if (Number(match[2]) !== process.pid) continue;
    if (!POSIX_COPY_HELPERS.has(basename(match[3].trim()))) continue;
    try {
      process.kill(Number(match[1]), 'SIGKILL');
    } catch {
      // The helper exited between listing and killing.
    }
  }
}

async function reapWindowsCopyHelpers(): Promise<void> {
  // clipboardy copies via `powershell.exe -EncodedCommand …` (powershell-utils)
  // or its bundled `clipboard_<arch>.exe` fallback; both are direct children.
  const script =
    `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${process.pid}' | ` +
    `Where-Object { $_.Name -like 'clipboard_*.exe' -or ` +
    `($_.Name -eq 'powershell.exe' -and $_.CommandLine -match '-EncodedCommand') } | ` +
    `ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
  await execFileAsync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: HELPER_REAP_TIMEOUT_MS, windowsHide: true },
  );
}

async function reapWedgedCopyHelpers(
  platform: NodeJS.Platform,
): Promise<void> {
  try {
    await (platform === 'win32'
      ? reapWindowsCopyHelpers()
      : reapPosixCopyHelpers());
  } catch {
    // Best effort: a reap failure must not mask the timeout result.
  }
}

function normalizeClipboardText(
  text: string,
  platform: NodeJS.Platform,
): string {
  const lf = text.replaceAll(/\r\n?/g, '\n');
  return platform === 'win32' ? lf.replaceAll('\n', '\r\n') : lf;
}

export async function writeClipboardText(
  text: string,
  options: ClipboardTextWriteOptions = {},
): Promise<ClipboardTextWriteResult> {
  const platform = options.platform ?? osPlatform();
  const normalized = normalizeClipboardText(text, platform);
  try {
    await pTimeout(clipboard.write(normalized), {
      milliseconds: CLIPBOARD_WRITE_TIMEOUT_MS,
      message: `Clipboard write timed out after ${CLIPBOARD_WRITE_TIMEOUT_MS}ms`,
    });
    return { ok: true };
  } catch (error) {
    if (error instanceof TimeoutError) {
      // Reap before reporting failure so a wedged helper cannot land a stale
      // write on the clipboard after the UI has already shown 'failed'.
      await reapWedgedCopyHelpers(platform);
    }
    return { ok: false, reason: toErrorMessage(error) };
  }
}
