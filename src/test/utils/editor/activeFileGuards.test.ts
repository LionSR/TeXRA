// Standard library imports
import * as assert from 'assert';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - utils
import {
  getActiveEditorWithGuards,
  type ActiveFileGuardResult,
} from '@utils/editor/activeFileGuards';

suite('Active File Guards', () => {
  let originalActiveTextEditor: vscode.TextEditor | undefined;
  let originalWorkspaceFolders:
    | readonly vscode.WorkspaceFolder[]
    | undefined;
  let warningMessages: string[];
  let errorMessages: string[];

  const originalShowWarningMessage = vscode.window.showWarningMessage;
  const originalShowErrorMessage = vscode.window.showErrorMessage;

  beforeEach(() => {
    originalActiveTextEditor = vscode.window.activeTextEditor;
    originalWorkspaceFolders = vscode.workspace.workspaceFolders;
    warningMessages = [];
    errorMessages = [];

    (vscode.window as any).showWarningMessage = (message: string) => {
      warningMessages.push(message);
      return Promise.resolve(undefined);
    };

    (vscode.window as any).showErrorMessage = (message: string) => {
      errorMessages.push(message);
      return Promise.resolve(undefined);
    };

    (vscode.workspace as any).workspaceFolders = [
      { uri: vscode.Uri.file('/workspace/project') },
    ];

    (vscode.window as any).activeTextEditor = undefined;
  });

  afterEach(() => {
    (vscode.window as any).activeTextEditor = originalActiveTextEditor;
    (vscode.workspace as any).workspaceFolders = originalWorkspaceFolders;
    (vscode.window as any).showWarningMessage = originalShowWarningMessage;
    (vscode.window as any).showErrorMessage = originalShowErrorMessage;
  });

  test('returns noEditor when there is no active editor', async () => {
    const result = await getActiveEditorWithGuards({
      allowedExtensions: ['.tex'],
      resourceName: 'LaTeX',
    });

    assert.strictEqual(result.status, 'noEditor');
    assert.strictEqual(warningMessages.length, 1);
    assert.ok(warningMessages[0].includes('No active editor found'));
  });

  test('returns unsupportedExtension when active document does not match', async () => {
    const mockEditor = createEditor('/workspace/project/notes/sample.txt');
    (vscode.window as any).activeTextEditor = mockEditor;

    const result = await getActiveEditorWithGuards({
      allowedExtensions: ['.tex'],
      resourceName: 'LaTeX',
    });

    assert.strictEqual(result.status, 'unsupportedExtension');
    assert.strictEqual(warningMessages.length, 1);
    assert.ok(warningMessages[0].includes('LaTeX'));
  });

  test('saves dirty document when requested and returns editor data', async () => {
    const mockEditor = createEditor('/workspace/project/main.tex', true);
    (vscode.window as any).activeTextEditor = mockEditor;

    const result = await getActiveEditorWithGuards({
      allowedExtensions: ['.tex'],
      resourceName: 'LaTeX',
      saveDocument: true,
    });

    assert.strictEqual(result.status, 'ok');
    const successResult = result as Extract<ActiveFileGuardResult, { status: 'ok' }>;
    assert.strictEqual(successResult.relativePath, 'main.tex');
    assert.strictEqual(mockEditor.document.save.callCount, 1);
    assert.deepStrictEqual(errorMessages, []);
    assert.deepStrictEqual(warningMessages, []);
  });

  function createEditor(
    fileName: string,
    isDirty = false,
  ): vscode.TextEditor & {
    document: {
      fileName: string;
      isDirty: boolean;
      save: (() => Promise<boolean>) & { callCount: number };
    };
  } {
    const saveStub = Object.assign(
      () => {
        saveStub.callCount += 1;
        return Promise.resolve(true);
      },
      { callCount: 0 },
    );

    const document = {
      fileName,
      isDirty,
      save: saveStub,
    } as any;

    return {
      document,
    } as vscode.TextEditor & {
      document: typeof document;
    };
  }
});
