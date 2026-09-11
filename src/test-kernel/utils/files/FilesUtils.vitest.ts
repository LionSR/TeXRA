// Suites for src/utils/files (baseFS predicates, workspaceFS, mime,
// absoluteFS, relativeFS JSON, pasted images).

import * as assert from 'node:assert';
import * as path from 'node:path';
import * as os from 'node:os';
import { promises as fs } from 'node:fs';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { z } from 'zod';
import { isTexFile } from '@common/files/fileTypeUtils';
import { platform } from '@platform/platform';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { setupPlatform } from '@test/support/setupPlatform';
import { getMimeType } from '@utils/files/mimeUtils';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { pathToLocation } from '@utils/files/fileLocation';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { RelativeFS } from '@utils/files/relativeFS';
import { pastedImageFileName } from '@utils/files/pastedImageUtils';

// ---------------------------------------------------------------------------
// BaseFS stat predicates
// ---------------------------------------------------------------------------

describe('BaseFS stat predicates', () => {
  setupPlatform();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const statPredicates = [
    ['exists', (path: string) => AbsoluteFS.exists(path)],
    ['isFile', (path: string) => AbsoluteFS.isFile(path)],
    ['isSymbolicLink', (path: string) => AbsoluteFS.isSymbolicLink(path)],
  ] as const;

  it.each(statPredicates)(
    'returns false for ENOTDIR from %s',
    async (_name, run) => {
      const error = Object.assign(new Error('parent path is not a directory'), {
        code: 'ENOTDIR',
      });
      vi.spyOn(platform().fs, 'stat').mockRejectedValueOnce(error);

      await expect(run('/file/child')).resolves.toBe(false);
    },
  );

  it.each(statPredicates)(
    'propagates operational stat failures from %s',
    async (_name, run) => {
      const error = Object.assign(new Error('path is unreadable'), {
        code: 'EACCES',
      });
      vi.spyOn(platform().fs, 'stat').mockRejectedValueOnce(error);

      await expect(run('/unreadable')).rejects.toBe(error);
    },
  );
});

// ---------------------------------------------------------------------------
// WorkspaceFS
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// mimeUtils
// ---------------------------------------------------------------------------

describe('getMimeType', () => {
  it('applies audio override for known extensions from file paths', () => {
    assert.strictEqual(getMimeType('/tmp/clip.opus'), 'audio/opus');
    assert.strictEqual(getMimeType('C:\\tmp\\clip.l16'), 'audio/l16');
  });
});

// ---------------------------------------------------------------------------
// fileTypeUtils and workspace path resolution
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// AbsoluteFS.write
// ---------------------------------------------------------------------------

describe('AbsoluteFS.write', () => {
  setupPlatform();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('propagates ELOOP without deleting the path or retrying', async () => {
    const location = pathToLocation('file.tex');
    const expectedPath = WorkspaceFS.toAbsolute('file.tex');
    const cause = new Error('native cause');
    const loopError = new Error('loop detected', {
      cause,
    }) as NodeJS.ErrnoException;
    loopError.code = 'ELOOP';
    loopError.path = expectedPath;

    // Mock the platform fs layer underneath AbsoluteFS.write, not
    // AbsoluteFS.write itself, so this exercises the real BaseFS.write/delete
    // code path rather than asserting on a stub of the method under test.
    const writeFile = vi
      .spyOn(platform().fs, 'writeFile')
      .mockRejectedValue(loopError);
    const deletePath = vi.spyOn(AbsoluteFS, 'delete').mockResolvedValue();

    await assert.rejects(
      () => AbsoluteFS.write(location.absolutePath, 'content'),
      (error: unknown) => error === loopError,
    );

    expect(writeFile).toHaveBeenCalledOnce();
    expect(deletePath).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// RelativeFSJson
// ---------------------------------------------------------------------------

const BASE_DIR = path.join(os.tmpdir(), 'texra-relativefs-json-tests');

class TestRelativeFS extends RelativeFS {
  protected static override getBasePath(): string {
    return BASE_DIR;
  }
}

describe('RelativeFS JSON helpers', () => {
  // RelativeFS goes through the platform filesystem; back it with the real
  // node filesystem since this suite writes to a real temp directory.
  setupPlatform({}, { fs: nodeFilesystem });

  beforeEach(async () => {
    await fs.rm(BASE_DIR, { recursive: true, force: true });
    await fs.mkdir(BASE_DIR, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(BASE_DIR, { recursive: true, force: true });
  });

  it('preserves malformed JSON errors as the readJson cause', async () => {
    await TestRelativeFS.write('broken.json', '{not json');

    await assert.rejects(
      () =>
        TestRelativeFS.readJson('broken.json', z.object({ name: z.string() })),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Failed to parse JSON from broken\.json:/);
        assert.ok(error.cause instanceof SyntaxError);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// PastedImageUtils
// ---------------------------------------------------------------------------

describe('pastedImageFileName', () => {
  it('accepts generated pasted image basenames', () => {
    expect(pastedImageFileName('pasted_1234_abcd.png')).toBe(
      'pasted_1234_abcd.png',
    );
  });

  it.each([
    '../pasted_1234_abcd.png',
    '/tmp/pasted_1234_abcd.png',
    'C:\\tmp\\pasted_1234_abcd.png',
    'avatar.png',
    '',
  ])('rejects paths and non-pasted names from webview input: %s', (name) => {
    expect(() => pastedImageFileName(name)).toThrow(
      'Invalid pasted image filename.',
    );
  });
});
