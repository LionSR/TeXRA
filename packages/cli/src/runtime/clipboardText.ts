import { spawn } from 'node:child_process';
import { platform as osPlatform } from 'node:os';

export type ClipboardTextWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

interface ClipboardCommand {
  readonly command: string;
  readonly args: readonly string[];
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
): Promise<ClipboardTextWriteResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stderr = '';
    const finish = (result: ClipboardTextWriteResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const child = spawn(candidate.command, [...candidate.args], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    child.stdin.on('error', () => undefined);
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

    child.stdin.end(text);
  });
}

export async function writeClipboardText(
  text: string,
): Promise<ClipboardTextWriteResult> {
  const platform = osPlatform();
  const normalized = normalizeClipboardText(text, platform);
  const candidates = clipboardCommandsForPlatform(platform);
  if (candidates.length === 0) {
    return { ok: false, reason: missingClipboardToolsMessage(platform) };
  }

  let lastFailure = missingClipboardToolsMessage(platform);
  for (const candidate of candidates) {
    const result = await writeWithCommand(candidate, normalized);
    if (result.ok) return result;
    lastFailure = result.reason;
  }
  return { ok: false, reason: lastFailure };
}
