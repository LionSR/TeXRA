// Third-party imports
import * as assert from 'assert';
import * as path from 'path';

// Local imports - common
import { isTexFile } from '@common/files/fileTypeUtils';

// Local imports - utils
import { getBasename, resolveFilePath } from '@utils/files';

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
      assert.strictEqual(
        getBasename('/path/to/file(with)parens.txt'),
        'file(with)parens.txt',
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
  });

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
      assert.strictEqual(isTexFile('.tex'), true);
      assert.strictEqual(isTexFile('tex'), false);
      assert.strictEqual(isTexFile('file.texture'), false);
    });
  });

  describe('resolveFilePath', () => {
    it('should return absolute paths unchanged', () => {
      const absolutePath = path.resolve('/absolute/path/file.txt');
      assert.strictEqual(resolveFilePath(absolutePath), absolutePath);
    });

    it('should resolve relative paths to workspace', () => {
      const relativePath = 'relative/path/file.txt';
      const resolved = resolveFilePath(relativePath);
      assert.strictEqual(path.isAbsolute(resolved), true);
      assert.strictEqual(resolved.endsWith(relativePath), true);
    });
  });
});
