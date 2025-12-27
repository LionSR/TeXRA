// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - utilities
import * as dialogUtils from '@frontend/ui/dialogs';
import { WorkspaceFS } from '@utils/files';

describe('dialogs.selectFileFromWorkspace', () => {
  type DialogUtilsMutable = {
    selectFile: typeof dialogUtils.selectFile;
  };

  type WorkspaceFsMutable = {
    getPath: typeof WorkspaceFS.getPath;
    fullPath: typeof WorkspaceFS.fullPath;
  };

  const dialogs = dialogUtils as unknown as DialogUtilsMutable;
  const workspaceFs = WorkspaceFS as unknown as WorkspaceFsMutable;

  const originalSelectFile = dialogs.selectFile;
  const originalGetPath = workspaceFs.getPath;
  const originalFullPath = workspaceFs.fullPath;
  const originalShowErrorMessage = vscode.window.showErrorMessage;

  let errorMessages: string[];
  let selectFileCalls: number;

  beforeEach(() => {
    errorMessages = [];
    selectFileCalls = 0;

    dialogs.selectFile = async () => {
      selectFileCalls += 1;
      return null;
    };

    workspaceFs.getPath = () => '/mock/workspace';
    workspaceFs.fullPath = (relativePath: string) =>
      `/mock/workspace/${relativePath}`;

    (vscode.window as any).showErrorMessage = (message: string) => {
      errorMessages.push(message);
      return Promise.resolve(undefined);
    };
  });

  afterEach(() => {
    dialogs.selectFile = originalSelectFile;
    workspaceFs.getPath = originalGetPath;
    workspaceFs.fullPath = originalFullPath;
    (vscode.window as any).showErrorMessage = originalShowErrorMessage;
  });

  it('returns null when the user cancels the picker', async () => {
    dialogs.selectFile = async () => {
      selectFileCalls += 1;
      return null;
    };

    const result = await dialogUtils.selectFileFromWorkspace({
      openLabel: 'Select file',
      filters: { 'PDF files': ['pdf'] },
    });

    assert.strictEqual(result, null);
    assert.strictEqual(selectFileCalls, 1);
    assert.deepStrictEqual(errorMessages, []);
  });

  it('returns selection with relative and absolute paths when available', async () => {
    dialogs.selectFile = async () => {
      selectFileCalls += 1;
      return 'docs/sample.pdf';
    };

    const result = await dialogUtils.selectFileFromWorkspace({
      openLabel: 'Select file',
      filters: { 'PDF files': ['pdf'] },
    });

    assert.ok(result, 'Expected result to be defined');
    assert.strictEqual(result?.relativePath, 'docs/sample.pdf');
    assert.strictEqual(result?.absolutePath, '/mock/workspace/docs/sample.pdf');
    assert.strictEqual(selectFileCalls, 1);
    assert.deepStrictEqual(errorMessages, []);
  });

  it('returns null and shows an error when no workspace is open', async () => {
    workspaceFs.getPath = () => undefined;

    const result = await dialogUtils.selectFileFromWorkspace({
      openLabel: 'Select file',
      filters: { 'PDF files': ['pdf'] },
    });

    assert.strictEqual(result, null);
    assert.strictEqual(selectFileCalls, 0);
    assert.deepStrictEqual(errorMessages, ['No workspace folder open']);
  });
});
