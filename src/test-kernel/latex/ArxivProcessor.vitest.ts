import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ArxivProcessor,
  resolveArxivPaperDirectoryRelative,
} from '@latex/arxivProcessor';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
  tempDirs.length = 0;
});

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'texra-arxiv-'));
  tempDirs.push(dir);
  return dir;
}

describe('arXiv processor paths', () => {
  it('keeps custom arxiv destinations id-specific', () => {
    expect(
      resolveArxivPaperDirectoryRelative('2404.12175', {
        into: 'papers',
      }),
    ).toBe('papers/2404.12175');
    expect(
      resolveArxivPaperDirectoryRelative('math/0501234', {
        into: 'papers/',
      }),
    ).toBe('papers/math_0501234');
    expect(resolveArxivPaperDirectoryRelative('2404.12175')).toBe(
      'References/2404.12175',
    );
  });
});

describe('arXiv processor logger channel', () => {
  it('defaults the log channel to "arxivProcessor" (stable across the #7347 PascalCase rename)', () => {
    // `channel` is private, but it is the exact value passed to
    // logger.info(this.channel, ...) and rendered as the `[channel]` prefix on
    // every log line this class emits. #7347 renamed the exported singleton to
    // PascalCase and accidentally changed this string too; the channel value
    // must stay lowercase so log filters keep matching `[arxivProcessor]`.
    const channel = (ArxivProcessor as unknown as { channel: string }).channel;
    expect(channel).toBe('arxivProcessor');
  });
});

describe('arXiv source download filenames', () => {
  it('does not infer a missing header filename when it matches the base path', async () => {
    const dir = await makeTempDir();
    const destBasePath = path.join(dir, 'source');
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response('source contents', {
          status: 200,
          headers: {
            'content-disposition': 'attachment; filename="source"',
            'content-type': 'application/x-gzip',
          },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const downloadedPath = await ArxivProcessor.downloadFile(
      'https://arxiv.org/src/2404.12175',
      destBasePath,
      5000,
    );

    expect(downloadedPath).toBe(destBasePath);
    await expect(fs.readFile(destBasePath, 'utf8')).resolves.toBe(
      'source contents',
    );
    await expect(fs.access(`${destBasePath}.gz`)).rejects.toThrow();
  });
});
