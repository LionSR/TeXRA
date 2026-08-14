import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ArxivProcessor,
  resolveArxivPaperDirectoryRelative,
} from '@latex/arxivProcessor';
import { cleanupTempDirs, makeTempDir } from '@test/support/tempDirPlatform';

const tempDirs: string[] = [];
const SOURCE_URL = 'https://arxiv.org/src/2404.12175';

afterEach(async () => {
  vi.unstubAllGlobals();
  await cleanupTempDirs(tempDirs);
});

async function tempSourceBase(): Promise<string> {
  const dir = await makeTempDir('texra-arxiv-', tempDirs);
  return path.join(dir, 'source');
}

function sourceResponse(status = 200): Response {
  return new Response('source contents', {
    status,
    headers: {
      'content-disposition': 'attachment; filename="source"',
      'content-type': 'application/x-gzip',
    },
  });
}

describe('arXiv processor paths', () => {
  it.each<{
    id: string;
    options?: Parameters<typeof resolveArxivPaperDirectoryRelative>[1];
    expected: string;
  }>([
    { id: '2404.12175', expected: 'References/2404.12175' },
    { id: 'math/0501234', expected: 'References/math_0501234' },
    { id: '2404.12175', options: { destination: 'root' }, expected: '.' },
  ])(
    'keeps arxiv destinations id-specific ($id → $expected)',
    ({ id, options, expected }) => {
      expect(resolveArxivPaperDirectoryRelative(id, options)).toBe(expected);
    },
  );
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
    const destBasePath = await tempSourceBase();
    const fetchMock = vi.fn(async () => sourceResponse());
    vi.stubGlobal('fetch', fetchMock);

    const downloadedPath = await ArxivProcessor.downloadFile(
      SOURCE_URL,
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

describe('arXiv source download retry classification', () => {
  it('retries a 429 rate limit instead of aborting immediately', async () => {
    const destBasePath = await tempSourceBase();
    let attempt = 0;
    const fetchMock = vi.fn(async () => {
      attempt += 1;
      return attempt === 1
        ? new Response(null, { status: 429 })
        : sourceResponse();
    });
    vi.stubGlobal('fetch', fetchMock);

    const downloadedPath = await ArxivProcessor.downloadFile(
      SOURCE_URL,
      destBasePath,
      5000,
    );

    expect(attempt).toBe(2);
    expect(downloadedPath).toBe(destBasePath);
  });

  it('does not retry a permanent 400 response', async () => {
    const destBasePath = await tempSourceBase();
    const fetchMock = vi.fn(async () => new Response(null, { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      ArxivProcessor.downloadFile(SOURCE_URL, destBasePath, 5000),
    ).rejects.toThrow('HTTP 400');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
