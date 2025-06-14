import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { executeCommand } from './execUtils';
import { checkToolInstalled } from './toolUtils';

/**
 * Convert input text using pandoc.
 * @param content Text content to convert.
 * @param from Format to convert from (e.g. 'html', 'latex').
 * @param to Format to convert to (default 'markdown').
 * @returns Converted text on success, or original content on failure.
 */
export async function pandocConvert(
  content: string,
  from: 'html' | 'latex' | 'markdown',
  to: 'markdown' | 'html' = 'markdown',
): Promise<string> {
  const installed = await checkToolInstalled('pandoc', false);
  if (!installed) {
    return content;
  }
  const tmpFile = path.join(os.tmpdir(), `pandoc_in_${Date.now()}.txt`);
  await fs.writeFile(tmpFile, content);
  const cmd = `pandoc -f ${from} -t ${to} ${tmpFile}`;
  const result = await executeCommand(cmd, { channel: 'pandocUtils' });
  await fs.unlink(tmpFile).catch(() => {});
  return result.success && result.stdout ? result.stdout : content;
}

/**
 * Guess the format of the given content.
 * @param content Input content string.
 * @returns Detected format string.
 */
export function detectFormat(content: string): 'html' | 'latex' | 'markdown' {
  if (/<\/?[a-z][\s\S]*>/i.test(content)) {
    return 'html';
  }
  if (/\\begin\{|\\section\{/.test(content)) {
    return 'latex';
  }
  return 'markdown';
}
