import { execFile } from 'node:child_process';
import { platform as osPlatform } from 'node:os';
import { basename } from 'node:path';
import { promisify } from 'node:util';

import clipboard from 'clipboardy';
import { Cause, Effect, Exit } from 'effect';

import { effectRuntime } from '@platform/processRuntime';
import { toErrorMessage } from '@utils/errors/errorMessage';

const execFileAsync = promisify(execFile);

type ClipboardTextWriteResult =
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
  // Linux `ps -o comm=` reports the kernel task name, which TASK_COMM_LEN
  // truncates to 15 characters — `termux-clipboard-set` surfaces as this.
  'termux-clipboar',
]);

const reapPosixCopyHelpers = Effect.gen(function* () {
  const { stdout } = yield* Effect.tryPromise({
    try: () =>
      execFileAsync('ps', ['-Ao', 'pid=,ppid=,comm='], {
        timeout: HELPER_REAP_TIMEOUT_MS,
      }),
    catch: (cause) => cause as Error,
  });
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    if (Number(match[2]) !== process.pid) continue;
    if (!POSIX_COPY_HELPERS.has(basename(match[3].trim()))) continue;
    // The helper may exit between listing and killing.
    yield* Effect.ignore(
      Effect.try({
        try: () => process.kill(Number(match[1]), 'SIGKILL'),
        catch: (cause) => cause as Error,
      }),
    );
  }
});

const reapWindowsCopyHelpers = Effect.tryPromise({
  try: () => {
    // clipboardy copies via `powershell.exe -EncodedCommand …` (powershell-utils)
    // or its bundled `clipboard_<arch>.exe` fallback; both are direct children.
    // This reap script is itself a direct-child powershell.exe, so it must not
    // match its own filter: `$_.ProcessId -ne $PID` excludes it, and splitting
    // the '-EncodedCommand' literal keeps this script's command line (and a
    // concurrent reap's) from containing the very substring it greps for.
    const script =
      `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${process.pid}' | ` +
      `Where-Object { $_.ProcessId -ne $PID -and ` +
      `($_.Name -like 'clipboard_*.exe' -or ` +
      `($_.Name -eq 'powershell.exe' -and $_.CommandLine -match ('-Encoded' + 'Command'))) } | ` +
      `ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
    return execFileAsync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: HELPER_REAP_TIMEOUT_MS, windowsHide: true },
    );
  },
  catch: (cause) => cause as Error,
});

// Killing a wedged helper makes clipboardy retry with its bundled fallback
// binary (Windows `clipboard_<arch>.exe`, Linux bundled `xsel`) — a new direct
// child spawned after the first sweep's process snapshot. A healthy fallback
// finishes within milliseconds (landing the still-current text before the user
// can copy anything else); one delayed second sweep catches a fallback that
// wedges exactly like the helper it replaced.
const FALLBACK_REAP_DELAY_MS = 300;

function reapWedgedCopyHelpers(platform: NodeJS.Platform): Effect.Effect<void> {
  return Effect.gen(function* () {
    for (let sweep = 0; sweep < 2; sweep += 1) {
      if (sweep > 0) {
        yield* Effect.sleep(FALLBACK_REAP_DELAY_MS);
      }
      // Best effort: a reap failure must not mask the timeout result.
      yield* Effect.ignore(
        platform === 'win32' ? reapWindowsCopyHelpers : reapPosixCopyHelpers,
      );
    }
  });
}

function normalizeClipboardText(
  text: string,
  platform: NodeJS.Platform,
): string {
  const lf = text.replaceAll(/\r\n?/g, '\n');
  return platform === 'win32' ? lf.replaceAll('\n', '\r\n') : lf;
}

export function writeClipboardText(
  text: string,
  options: ClipboardTextWriteOptions = {},
): Promise<ClipboardTextWriteResult> {
  const platform = options.platform ?? osPlatform();
  const normalized = normalizeClipboardText(text, platform);
  // Timeout and ordinary Fail settle inside the effect. Runtime dispose
  // interrupts the fiber while it is still interruptible, which skips
  // cause-matching on the fiber; fold that Exit at `runPromiseExit` so the
  // TUI's `void copyQuestion()` caller gets `{ ok: false }` instead of a
  // rejection. Clipboardy has no cancellation hook, so interrupt reaps on
  // the default runtime — the process runtime is already disposing.
  return effectRuntime()
    .runPromiseExit(
      Effect.tryPromise({
        try: () => clipboard.write(normalized),
        catch: (cause) => cause,
      }).pipe(
        Effect.timeout(CLIPBOARD_WRITE_TIMEOUT_MS),
        Effect.matchEffect({
          onFailure: (error) =>
            Cause.isTimeoutError(error)
              ? Effect.as(reapWedgedCopyHelpers(platform), {
                  ok: false as const,
                  reason: `Clipboard write timed out after ${CLIPBOARD_WRITE_TIMEOUT_MS}ms`,
                })
              : Effect.succeed({
                  ok: false as const,
                  reason: toErrorMessage(error),
                }),
          onSuccess: () => Effect.succeed({ ok: true as const }),
        }),
      ),
    )
    .then(async (exit) => {
      if (Exit.isSuccess(exit)) return exit.value;
      if (Cause.hasInterrupts(exit.cause)) {
        await Effect.runPromise(
          Effect.uninterruptible(reapWedgedCopyHelpers(platform)),
        );
        return {
          ok: false as const,
          reason: 'Clipboard write interrupted',
        };
      }
      throw Cause.squash(exit.cause);
    });
}
