// Third-party imports

// Third-party imports
import * as assert from 'node:assert';
import * as path from 'node:path';
import { beforeAll, describe, it } from 'vitest';

// Local imports - common

// Local imports - test support
import { createFakePlatform } from '@test/support/FakePlatform';
import { isTexFile } from '@common/files/fileTypeUtils';

// Local imports - utils
import { WorkspaceFS } from '@utils/files';

beforeAll(async () => {
  // WorkspaceFS resolves relative paths against the platform workspace.
  const { initPlatform } = await import('@platform/platform');
  initPlatform(createFakePlatform());
});

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
