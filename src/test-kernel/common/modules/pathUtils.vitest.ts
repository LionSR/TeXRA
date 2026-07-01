// Standard library imports
import * as assert from 'node:assert';

// Third-party imports
import { describe, it } from 'vitest';

import { getBasename } from '@shared/utils/path';

describe('pathUtils Test Suite', () => {
  describe('getBasename', () => {
    it.each([
      ['/home/user/file.txt', 'file.txt'],
      ['/usr/local/bin/node', 'node'],
      ['/path/to/document.pdf', 'document.pdf'],
      ['C:\\Users\\file.txt', 'file.txt'],
      ['C:\\Program Files\\app.exe', 'app.exe'],
      ['D:\\Documents\\report.docx', 'report.docx'],
      ['C:/Users\\Documents/file.txt', 'file.txt'],
      ['/home\\user/document.pdf', 'document.pdf'],
      ['/path/to/', 'to'],
      ['/path/to/dir/', 'dir'],
      ['C:\\Users\\', 'Users'],
      ['', ''],
      ['/', ''],
      ['//', ''],
      ['file.txt', 'file.txt'],
      ['./file.txt', 'file.txt'],
      ['../file.txt', 'file.txt'],
      ['/path/to/file.tar.gz', 'file.tar.gz'],
      ['archive.backup.zip', 'archive.backup.zip'],
      ['/home/user/.bashrc', '.bashrc'],
      ['/path/to/file with spaces.txt', 'file with spaces.txt'],
      ['/path/to/file-with-dashes.txt', 'file-with-dashes.txt'],
      ['/path/to/file_with_underscores.txt', 'file_with_underscores.txt'],
      ['relative/path/to/file.txt', 'file.txt'],
      ['./relative/file.txt', 'file.txt'],
      ['../parent/file.txt', 'file.txt'],
      ['/home/user/Documents', 'Documents'],
      ['C:\\Program Files', 'Program Files'],
      ['/usr/local/bin', 'bin'],
      // Regression: paths ending with a separator used to return empty.
      ['folder/', 'folder'],
      ['/home/user/folder/', 'folder'],
    ])('getBasename(%j) === %j', (input, expected) => {
      assert.strictEqual(getBasename(input), expected);
    });
  });
});
