// Standard library imports
import * as assert from 'node:assert';

// Third-party imports
import { describe, it } from 'vitest';

import { getBasename } from '@shared/utils/path';

describe('pathUtils Test Suite', () => {
  describe('getBasename', () => {
    it('should extract basename from Unix paths', () => {
      assert.strictEqual(getBasename('/home/user/file.txt'), 'file.txt');
      assert.strictEqual(getBasename('/usr/local/bin/node'), 'node');
      assert.strictEqual(getBasename('/path/to/document.pdf'), 'document.pdf');
    });

    it('should extract basename from Windows paths', () => {
      assert.strictEqual(getBasename('C:\\Users\\file.txt'), 'file.txt');
      assert.strictEqual(getBasename('C:\\Program Files\\app.exe'), 'app.exe');
      assert.strictEqual(
        getBasename('D:\\Documents\\report.docx'),
        'report.docx',
      );
    });

    it('should handle mixed path separators', () => {
      assert.strictEqual(
        getBasename('C:/Users\\Documents/file.txt'),
        'file.txt',
      );
      assert.strictEqual(
        getBasename('/home\\user/document.pdf'),
        'document.pdf',
      );
    });

    it('should handle paths with trailing slashes', () => {
      assert.strictEqual(getBasename('/path/to/'), 'to');
      assert.strictEqual(getBasename('/path/to/dir/'), 'dir');
      assert.strictEqual(getBasename('C:\\Users\\'), 'Users');
    });

    it('should handle edge cases', () => {
      assert.strictEqual(getBasename(''), '');
      assert.strictEqual(getBasename('/'), '');
      assert.strictEqual(getBasename('//'), '');
      assert.strictEqual(getBasename('file.txt'), 'file.txt');
      assert.strictEqual(getBasename('./file.txt'), 'file.txt');
      assert.strictEqual(getBasename('../file.txt'), 'file.txt');
    });

    it('should handle files with multiple dots', () => {
      assert.strictEqual(getBasename('/path/to/file.tar.gz'), 'file.tar.gz');
      assert.strictEqual(
        getBasename('archive.backup.zip'),
        'archive.backup.zip',
      );
      assert.strictEqual(getBasename('/home/user/.bashrc'), '.bashrc');
    });

    it('should handle special characters in filenames', () => {
      assert.strictEqual(
        getBasename('/path/to/file with spaces.txt'),
        'file with spaces.txt',
      );
      assert.strictEqual(
        getBasename('/path/to/file-with-dashes.txt'),
        'file-with-dashes.txt',
      );
      assert.strictEqual(
        getBasename('/path/to/file_with_underscores.txt'),
        'file_with_underscores.txt',
      );
    });

    it('should handle relative paths', () => {
      assert.strictEqual(getBasename('relative/path/to/file.txt'), 'file.txt');
      assert.strictEqual(getBasename('./relative/file.txt'), 'file.txt');
      assert.strictEqual(getBasename('../parent/file.txt'), 'file.txt');
    });

    it('should handle directory paths without extensions', () => {
      assert.strictEqual(getBasename('/home/user/Documents'), 'Documents');
      assert.strictEqual(getBasename('C:\\Program Files'), 'Program Files');
      assert.strictEqual(getBasename('/usr/local/bin'), 'bin');
    });

    it('should not return empty string for valid directory names', () => {
      // This was the bug reported by cursor - paths ending with separator would return empty
      assert.strictEqual(getBasename('folder/'), 'folder');
      assert.strictEqual(getBasename('/home/user/folder/'), 'folder');
      assert.notStrictEqual(getBasename('folder/'), '');
    });
  });
});
