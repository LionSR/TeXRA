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

  it('returns ordinary predicate results for present and missing paths', async () => {
    await AbsoluteFS.write('/present.txt', 'content');

    await expect(AbsoluteFS.exists('/present.txt')).resolves.toBe(true);
    await expect(AbsoluteFS.isFile('/present.txt')).resolves.toBe(true);
    await expect(AbsoluteFS.isSymbolicLink('/present.txt')).resolves.toBe(
      false,
    );
    await expect(AbsoluteFS.exists('/missing.txt')).resolves.toBe(false);
    await expect(AbsoluteFS.isFile('/missing.txt')).resolves.toBe(false);
    await expect(AbsoluteFS.isSymbolicLink('/missing.txt')).resolves.toBe(
      false,
    );
  });

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

describe('WorkspaceFS.delete', () => {
  it('is idempotent when the file does not exist', async () => {
    await assert.doesNotReject(
      async () =>
        await WorkspaceFS.delete('this-file-does-not-exist-12345.txt'),
      'delete() should not throw when file does not exist',
    );
  });
});

// ---------------------------------------------------------------------------
// mimeUtils
// ---------------------------------------------------------------------------

describe('getMimeType', () => {
  it('applies audio override for known extensions from file paths', () => {
    assert.strictEqual(getMimeType('/tmp/clip.opus'), 'audio/opus');
    assert.strictEqual(getMimeType('C:\\tmp\\clip.l16'), 'audio/l16');
  });

  it('applies audio override for bare extension values', () => {
    assert.strictEqual(getMimeType('opus'), 'audio/opus');
    assert.strictEqual(getMimeType('.mulaw'), 'audio/mulaw');
  });

  it('does not apply audio override to extensionless file paths', () => {
    assert.strictEqual(getMimeType('/tmp/opus'), null);
    assert.strictEqual(getMimeType('C:\\tmp\\mulaw'), null);
  });
});

// ---------------------------------------------------------------------------
// fileTypeUtils and workspace path resolution
// ---------------------------------------------------------------------------

describe('isTexFile', () => {
  it('identifies TeX files regardless of extension case', () => {
    assert.strictEqual(isTexFile('document.tex'), true);
    assert.strictEqual(isTexFile('DOCUMENT.TEX'), true);
    assert.strictEqual(isTexFile('path/to/file.tex'), true);
    assert.strictEqual(isTexFile('file.TeX'), true);
  });

  it('rejects non-TeX files', () => {
    assert.strictEqual(isTexFile('document.txt'), false);
    assert.strictEqual(isTexFile('file.pdf'), false);
    assert.strictEqual(isTexFile('image.png'), false);
    assert.strictEqual(isTexFile('script.js'), false);
    assert.strictEqual(isTexFile('noextension'), false);
  });

  it('rejects names without a .tex extension of their own', () => {
    assert.strictEqual(isTexFile(''), false);
    // '.tex' alone is a dotfile: path.extname('.tex') === '', so it has no
    // .tex extension under the hasExtension-based implementation.
    assert.strictEqual(isTexFile('.tex'), false);
    assert.strictEqual(isTexFile('tex'), false);
    assert.strictEqual(isTexFile('file.texture'), false);
  });
});

describe('WorkspaceFS.toAbsolute', () => {
  it('returns absolute paths unchanged', () => {
    const absolutePath = path.resolve('/absolute/path/file.txt');
    assert.strictEqual(WorkspaceFS.toAbsolute(absolutePath), absolutePath);
  });

  it('resolves relative paths against the workspace', () => {
    const resolved = WorkspaceFS.toAbsolute('relative/path/file.txt');
    assert.strictEqual(path.isAbsolute(resolved), true);
    assert.strictEqual(
      resolved.endsWith(path.join('relative', 'path', 'file.txt')),
      true,
    );
  });
});

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
      (error: unknown) => {
        assert.strictEqual(error, loopError);
        assert.strictEqual((error as NodeJS.ErrnoException).code, 'ELOOP');
        assert.strictEqual((error as NodeJS.ErrnoException).path, expectedPath);
        assert.strictEqual((error as Error).cause, cause);
        return true;
      },
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
    await fs
      .rm(BASE_DIR, { recursive: true, force: true })
      .catch(() => undefined);
    await fs.mkdir(BASE_DIR, { recursive: true });
  });

  afterAll(async () => {
    await fs
      .rm(BASE_DIR, { recursive: true, force: true })
      .catch(() => undefined);
  });

  it('readJson round trip preserves written JSON data', async () => {
    const payload = {
      foo: 'bar',
      nested: { count: 3 },
      list: [1, 2, 3],
    };

    await TestRelativeFS.write('sample.json', JSON.stringify(payload));
    const result = await TestRelativeFS.readJson<typeof payload>('sample.json');

    assert.deepStrictEqual(result, payload);
  });

  it('validates readJson results with a schema', async () => {
    await TestRelativeFS.write(
      'typed.json',
      JSON.stringify({ name: 'alpha', extra: true }),
    );

    const result = await TestRelativeFS.readJson(
      'typed.json',
      z.object({ name: z.string() }),
    );

    assert.deepStrictEqual(result, { name: 'alpha' });
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
