// Not routed through executeCommand: this needs an injectable spawn seam
// (`spawnCommand`) with per-candidate kill-on-timeout while falling through
// multiple clipboard tools, which executeCommand's single-command timeout
// model doesn't expose as a test seam.
import { spawn } from 'node:child_process';
import { platform as osPlatform } from 'node:os';
import { toErrorMessage } from '@utils/errors/errorMessage';
import type { ChildProcess } from 'node:child_process';

export type ClipboardTextWriteResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

const DEFAULT_CLIPBOARD_WRITE_TIMEOUT_MS = 5_000;

interface ClipboardCommand {
  readonly command: string;
  readonly args: readonly string[];
}

type SpawnCommand = typeof spawn;

interface ClipboardTextWriteOptions {
  readonly platform?: NodeJS.Platform;
  readonly spawnCommand?: SpawnCommand;
  readonly timeoutMs?: number;
}

function normalizeClipboardText(text: string, platform = osPlatform()): string {
  const lf = text.replaceAll(/\r\n?/g, '\n');
  return platform === 'win32' ? lf.replaceAll('\n', '\r\n') : lf;
}

function clipboardCommandsForPlatform(
  platform = osPlatform(),
): readonly ClipboardCommand[] {
  switch (platform) {
    case 'darwin':
      return [{ command: 'pbcopy', args: [] }];
    case 'linux':
      return [
        { command: 'wl-copy', args: [] },
        { command: 'xclip', args: ['-selection', 'clipboard'] },
        { command: 'xsel', args: ['--clipboard', '--input'] },
      ];
    case 'win32':
      return [
        {
          command: 'powershell.exe',
          args: [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); Set-Clipboard -Value ([Console]::In.ReadToEnd())',
          ],
        },
      ];
    default:
      return [];
  }
}

function missingClipboardToolsMessage(platform = osPlatform()): string {
  if (platform === 'linux') {
    return 'Text clipboard copy needs wl-clipboard, xclip, or xsel.';
  }
  return `Text clipboard copy is not supported on ${platform}.`;
}

function writeWithCommand(
  candidate: ClipboardCommand,
  text: string,
  {
    spawnCommand = spawn,
    timeoutMs = DEFAULT_CLIPBOARD_WRITE_TIMEOUT_MS,
  }: Pick<ClipboardTextWriteOptions, 'spawnCommand' | 'timeoutMs'> = {},
): Promise<ClipboardTextWriteResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stderr = '';
    const deadlineMs = Math.max(1, Math.floor(timeoutMs));

    let child: ChildProcess;
    try {
      child = spawnCommand(candidate.command, [...candidate.args], {
        stdio: ['pipe', 'ignore', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolve({
        ok: false,
        reason: toErrorMessage(error),
      });
      return;
    }

    const stdin = child.stdin;
    if (!stdin) {
      resolve({
        ok: false,
        reason: `${candidate.command} did not open stdin`,
      });
      return;
    }

    const timeout = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Best effort only; the result still needs to unblock the UI.
      }
      finish({
        ok: false,
        reason: `${candidate.command} timed out after ${deadlineMs}ms`,
      });
    }, deadlineMs);
    const finish = (result: ClipboardTextWriteResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    stdin.on('error', () => undefined);
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      const reason =
        error.code === 'ENOENT'
          ? `${candidate.command} not found`
          : error.message;
      finish({ ok: false, reason });
    });
    child.on('close', (code) => {
      if (code === 0) {
        finish({ ok: true });
        return;
      }
      finish({
        ok: false,
        reason:
          stderr.trim() || `${candidate.command} exited with code ${code}`,
      });
    });

    stdin.end(text, 'utf8');
  });
}

export async function writeClipboardText(
  text: string,
  options: ClipboardTextWriteOptions = {},
): Promise<ClipboardTextWriteResult> {
  const platform = options.platform ?? osPlatform();
  const normalized = normalizeClipboardText(text, platform);
  const candidates = clipboardCommandsForPlatform(platform);
  if (candidates.length === 0) {
    return { ok: false, reason: missingClipboardToolsMessage(platform) };
  }

  let lastFailure = missingClipboardToolsMessage(platform);
  for (const candidate of candidates) {
    const result = await writeWithCommand(candidate, normalized, options);
    if (result.ok) return result;
    lastFailure = result.reason;
  }
  return { ok: false, reason: lastFailure };
}
