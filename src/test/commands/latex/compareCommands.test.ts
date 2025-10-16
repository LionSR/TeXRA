// Standard library imports
import { strict as assert } from 'assert';
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - commands
import {
  compareCommands,
  CompareCommandValidationError,
  validateDiffFiles,
} from '@commands/latex/compareCommands';

// Local imports - utils
import { WorkspaceFS } from '@utils/files';
import * as errorHandlingUtils from '@common/errors/errorHandlingUtils';

describe('compareCommands validation', () => {
  let originalExists: typeof WorkspaceFS.exists;
  let originalFullPath: typeof WorkspaceFS.fullPath;
  let originalRead: typeof WorkspaceFS.read;
  let originalWrite: typeof WorkspaceFS.write;
  let originalShowErrorMessage: typeof vscode.window.showErrorMessage;
  let originalShowInformationMessage: typeof vscode.window.showInformationMessage;
  let originalShowWarningMessage: typeof vscode.window.showWarningMessage;
  let originalShowLoggedErrorMessage: typeof errorHandlingUtils.showLoggedErrorMessage;

  let recordedErrors: { channel: string; prefix: string; message: string }[];
  let windowErrors: string[];

  beforeEach(() => {
    originalExists = WorkspaceFS.exists;
    originalFullPath = WorkspaceFS.fullPath;
    originalRead = WorkspaceFS.read;
    originalWrite = WorkspaceFS.write;
    originalShowErrorMessage = vscode.window.showErrorMessage;
    originalShowInformationMessage = vscode.window.showInformationMessage;
    originalShowWarningMessage = vscode.window.showWarningMessage;
    originalShowLoggedErrorMessage = errorHandlingUtils.showLoggedErrorMessage;

    recordedErrors = [];
    windowErrors = [];

    (WorkspaceFS.fullPath as any) = (relativePath: string) =>
      path.join('/workspace', path.normalize(relativePath));
    (WorkspaceFS.read as any) = async () => {
      throw new Error('read should not be called in this test');
    };
    (WorkspaceFS.write as any) = async () => {
      throw new Error('write should not be called in this test');
    };

    (vscode.window as any).showErrorMessage = (message: string) => {
      windowErrors.push(message);
      return Promise.resolve(message);
    };
    (vscode.window as any).showInformationMessage = () => Promise.resolve();
    (vscode.window as any).showWarningMessage = () => Promise.resolve('Yes');

    (errorHandlingUtils as any).showLoggedErrorMessage = async (
      channel: string,
      prefix: string,
      err: unknown,
    ) => {
      const message = err instanceof Error ? err.message : String(err);
      recordedErrors.push({ channel, prefix, message });
      return `${prefix}: ${message}`;
    };
  });

  afterEach(() => {
    (WorkspaceFS.exists as any) = originalExists;
    (WorkspaceFS.fullPath as any) = originalFullPath;
    (WorkspaceFS.read as any) = originalRead;
    (WorkspaceFS.write as any) = originalWrite;
    (vscode.window as any).showErrorMessage = originalShowErrorMessage;
    (vscode.window as any).showInformationMessage = originalShowInformationMessage;
    (vscode.window as any).showWarningMessage = originalShowWarningMessage;
    (errorHandlingUtils as any).showLoggedErrorMessage =
      originalShowLoggedErrorMessage;
  });

  describe('validateDiffFiles', () => {
    it('resolves base file fallback and returns normalized URIs', async () => {
      (WorkspaceFS.exists as any) = async () => true;

      const result = await validateDiffFiles(
        'input/main.tex',
        '',
        'edited/main.tex',
      );

      assert.strictEqual(result.baseRelativePath, path.normalize('input/main.tex'));
      assert.strictEqual(
        result.editedRelativePath,
        path.normalize('edited/main.tex'),
      );
      assert.strictEqual(
        result.baseUri.fsPath,
        path.join('/workspace', path.normalize('input/main.tex')),
      );
      assert.strictEqual(
        result.editedUri.fsPath,
        path.join('/workspace', path.normalize('edited/main.tex')),
      );
      assert.strictEqual(result.baseFileName, 'main.tex');
      assert.strictEqual(result.editedFileName, 'main.tex');
      assert.strictEqual(recordedErrors.length, 0);
    });

    it('throws when base file is missing', async () => {
      (WorkspaceFS.exists as any) = async (filePath: string) =>
        filePath !== 'input/base.tex';

      await assert.rejects(
        validateDiffFiles('input/base.tex', '', 'edited/main.tex'),
        (err: unknown) => {
          assert.ok(err instanceof CompareCommandValidationError);
          assert.strictEqual(err.code, 'BASE_FILE_NOT_FOUND');
          assert.strictEqual(
            err.message,
            'Base file not found: input/base.tex',
          );
          return true;
        },
      );

      assert.strictEqual(recordedErrors.length, 1);
      assert.deepStrictEqual(recordedErrors[0], {
        channel: 'CompareCommands',
        prefix: 'Unable to prepare files for diff',
        message: 'Base file not found: input/base.tex',
      });
    });

    it('throws when edited file is missing', async () => {
      (WorkspaceFS.exists as any) = async (filePath: string) =>
        filePath === 'input/base.tex';

      await assert.rejects(
        validateDiffFiles('input/base.tex', '', 'edited/main.tex'),
        (err: unknown) => {
          assert.ok(err instanceof CompareCommandValidationError);
          assert.strictEqual(err.code, 'EDITED_FILE_NOT_FOUND');
          assert.strictEqual(
            err.message,
            'Edited file not found: edited/main.tex',
          );
          return true;
        },
      );

      assert.strictEqual(recordedErrors.length, 1);
      assert.deepStrictEqual(recordedErrors[0], {
        channel: 'CompareCommands',
        prefix: 'Unable to prepare files for diff',
        message: 'Edited file not found: edited/main.tex',
      });
    });
  });

  describe('command guard path reuse', () => {
    it('uses shared validation for compare and accept commands', async () => {
      (WorkspaceFS.exists as any) = async (filePath: string) =>
        filePath !== 'input/base.tex';

      await compareCommands.handleCompare(
        'input/base.tex',
        '',
        'edited/main.tex',
      );
      await compareCommands.handleAcceptEdited(
        'input/base.tex',
        '',
        'edited/main.tex',
      );

      assert.strictEqual(recordedErrors.length, 2);
      for (const entry of recordedErrors) {
        assert.deepStrictEqual(entry, {
          channel: 'CompareCommands',
          prefix: 'Unable to prepare files for diff',
          message: 'Base file not found: input/base.tex',
        });
      }
      assert.strictEqual(windowErrors.length, 0);
    });
  });
});
