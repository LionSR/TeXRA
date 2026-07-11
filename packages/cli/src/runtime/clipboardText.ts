import { platform as osPlatform } from 'node:os';

import clipboard from 'clipboardy';

import { toErrorMessage } from '@utils/errors/errorMessage';

export type ClipboardTextWriteResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

interface ClipboardTextWriteOptions {
  readonly platform?: NodeJS.Platform;
}

function normalizeClipboardText(text: string, platform = osPlatform()): string {
  const lf = text.replaceAll(/\r\n?/g, '\n');
  return platform === 'win32' ? lf.replaceAll('\n', '\r\n') : lf;
}

export async function writeClipboardText(
  text: string,
  options: ClipboardTextWriteOptions = {},
): Promise<ClipboardTextWriteResult> {
  const normalized = normalizeClipboardText(
    text,
    options.platform ?? osPlatform(),
  );
  try {
    await clipboard.write(normalized);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: toErrorMessage(error) };
  }
}
