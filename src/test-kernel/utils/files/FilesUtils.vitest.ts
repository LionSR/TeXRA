// Suites for src/utils/files (workspaceFS, mime, paths, flexibleFS,
// relativeFS JSON, pasted images).

import * as assert from 'node:assert';
import * as path from 'node:path';
import * as os from 'node:os';
import { promises as fs } from 'node:fs';
import {
  afterAll,
  beforeAll,
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
import { getMimeType } from '@utils/files';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { pathToLocation } from '@utils/files/taskRunStorage';
import { FlexibleFS } from '@utils/files/flexibleFS';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { RelativeFS } from '@utils/files/relativeFS';
import { pastedImageFileName } from '@utils/files/pastedImageUtils';

// ---------------------------------------------------------------------------
// BaseFS stat predicates
// ---------------------------------------------------------------------------

describe('BaseFS stat predicates', () => {
  setupPlatform();

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

  it.each([
    ['exists', () => AbsoluteFS.exists('/unreadable')],
    ['isFile', () => AbsoluteFS.isFile('/unreadable')],
    ['isSymbolicLink', () => AbsoluteFS.isSymbolicLink('/unreadable')],
  ])('propagates operational stat failures from %s', async (_name, run) => {
    const error = Object.assign(new Error('path is unreadable'), {
      code: 'EACCES',
    });
    const stat = vi.spyOn(platform().fs, 'stat').mockRejectedValueOnce(error);

    try {
      await expect(run()).rejects.toBe(error);
    } finally {
      stat.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// WorkspaceFS
// ---------------------------------------------------------------------------

describe('WorkspaceFS Test Suite', () => {
  it('delete should be idempotent - not throw when file does not exist', async () => {
    // Test that deleting a non-existent file doesn't throw
    const nonExistentPath = 'this-file-definitely-does-not-exist-12345.txt';

    // This should not throw an error
    await assert.doesNotReject(
      async () => await WorkspaceFS.delete(nonExistentPath),
      'delete() should not throw when file does not exist',
    );
  });
});

// ---------------------------------------------------------------------------
// mimeUtils
// ---------------------------------------------------------------------------

describe('mimeUtils Test Suite', () => {
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
// pathUtils
// ---------------------------------------------------------------------------

describe('pathUtils Test Suite', () => {
  describe('isTexFile', () => {
    it('should identify TeX files correctly', () => {
      assert.strictEqual(isTexFile('document.tex'), true);
      assert.strictEqual(isTexFile('DOCUMENT.TEX'), true);
      assert.strictEqual(isTexFile('path/to/file.tex'), true);
      assert.strictEqual(isTexFile('file.TeX'), true);
    });

    it('should reject non-TeX files', () => {
      assert.strictEqual(isTexFile('document.txt'), false);
      assert.strictEqual(isTexFile('file.pdf'), false);
      assert.strictEqual(isTexFile('image.png'), false);
      assert.strictEqual(isTexFile('script.js'), false);
      assert.strictEqual(isTexFile('noextension'), false);
    });

    it('should handle edge cases', () => {
      assert.strictEqual(isTexFile(''), false);
      // '.tex' alone is a dotfile: path.extname('.tex') === '', so it has no
      // .tex extension under the current hasExtension-based implementation.
      assert.strictEqual(isTexFile('.tex'), false);
      assert.strictEqual(isTexFile('tex'), false);
      assert.strictEqual(isTexFile('file.texture'), false);
    });
  });

  describe('WorkspaceFS.toAbsolute', () => {
    it('should return absolute paths unchanged', () => {
      const absolutePath = path.resolve('/absolute/path/file.txt');
      assert.strictEqual(WorkspaceFS.toAbsolute(absolutePath), absolutePath);
    });

    it('should resolve relative paths to workspace', () => {
      const relativePath = 'relative/path/file.txt';
      const resolved = WorkspaceFS.toAbsolute(relativePath);
      assert.strictEqual(path.isAbsolute(resolved), true);
      assert.strictEqual(resolved.endsWith(relativePath), true);
    });
  });
});

// ---------------------------------------------------------------------------
// flexibleFS
// ---------------------------------------------------------------------------

describe('FlexibleFS.write', () => {
  it('propagates ELOOP without deleting the path or retrying', async () => {
    const location = pathToLocation('file.tex');
    const expectedPath = WorkspaceFS.toAbsolute('file.tex');
    const cause = new Error('native cause');
    const loopError = new Error('loop detected', {
      cause,
    }) as NodeJS.ErrnoException;
    loopError.code = 'ELOOP';
    loopError.path = expectedPath;

    const write = vi.spyOn(AbsoluteFS, 'write').mockRejectedValue(loopError);
    const deletePath = vi.spyOn(AbsoluteFS, 'delete').mockResolvedValue();

    try {
      await assert.rejects(
        () => FlexibleFS.write(location, 'content'),
        (error: unknown) => {
          assert.strictEqual(error, loopError);
          assert.strictEqual((error as NodeJS.ErrnoException).code, 'ELOOP');
          assert.strictEqual(
            (error as NodeJS.ErrnoException).path,
            expectedPath,
          );
          assert.strictEqual((error as Error).cause, cause);
          return true;
        },
      );

      expect(write).toHaveBeenCalledOnce();
      expect(write).toHaveBeenCalledWith(expectedPath, 'content');
      expect(deletePath).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
      deletePath.mockRestore();
    }
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

  beforeAll(async () => {
    await fs
      .rm(BASE_DIR, { recursive: true, force: true })
      .catch(() => undefined);
    await fs.mkdir(BASE_DIR, { recursive: true });
  });

  beforeEach(async () => {
    // Ensure each test starts with a clean directory
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

  it('writeJson and readJson round trip preserves data', async () => {
    const payload = {
      foo: 'bar',
      nested: { count: 3 },
      list: [1, 2, 3],
    };

    await TestRelativeFS.writeJson('sample.json', payload);
    const result = await TestRelativeFS.readJson<typeof payload>('sample.json');

    assert.deepStrictEqual(result, payload);
  });

  it('validates readJson results with a schema', async () => {
    await TestRelativeFS.writeJson('typed.json', {
      name: 'alpha',
      extra: true,
    });

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

  it('rejects paths and non-pasted names from webview input', () => {
    for (const name of [
      '../pasted_1234_abcd.png',
      '/tmp/pasted_1234_abcd.png',
      'C:\\tmp\\pasted_1234_abcd.png',
      'avatar.png',
      '',
    ]) {
      expect(() => pastedImageFileName(name)).toThrow(
        'Invalid pasted image filename.',
      );
    }
  });
});
