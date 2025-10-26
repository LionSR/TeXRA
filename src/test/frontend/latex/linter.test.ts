// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - filesystem
import { WorkspaceFS } from '@utils/files';

// Local imports - latex
import { getLinterMessages } from '@frontend/latex/linter';

describe('latex linter diagnostics', () => {
  type MutableWorkspaceFs = {
    fullPath: typeof WorkspaceFS.fullPath;
  };

  type MutableCommands = {
    executeCommand: typeof vscode.commands.executeCommand;
  };

  type MutableLanguages = {
    getDiagnostics: typeof vscode.languages.getDiagnostics;
    onDidChangeDiagnostics: typeof vscode.languages.onDidChangeDiagnostics;
    createDiagnosticCollection: typeof vscode.languages.createDiagnosticCollection;
  };

  type MutableWorkspace = {
    openTextDocument: typeof vscode.workspace.openTextDocument;
  };

  type MutableWindow = {
    showTextDocument: typeof vscode.window.showTextDocument;
  };

  const workspaceFs = WorkspaceFS as unknown as MutableWorkspaceFs;
  const commands = vscode.commands as unknown as MutableCommands;
  const languages = vscode.languages as unknown as MutableLanguages;
  const workspace = vscode.workspace as unknown as MutableWorkspace;
  const window = vscode.window as unknown as MutableWindow & {
    visibleTextEditors: vscode.TextEditor[];
  };

  const originalFullPath = workspaceFs.fullPath;
  const originalExecuteCommand = commands.executeCommand;
  const originalGetDiagnostics = languages.getDiagnostics;
  const originalOnDidChangeDiagnostics = languages.onDidChangeDiagnostics;
  const originalCreateDiagnosticCollection =
    languages.createDiagnosticCollection;
  const originalOpenTextDocument = workspace.openTextDocument;
  const originalShowTextDocument = window.showTextDocument;
  const originalVisibleEditorsDescriptor = Object.getOwnPropertyDescriptor(
    vscode.window,
    'visibleTextEditors',
  );

  let diagnosticsByUri: Map<string, vscode.Diagnostic[]>;
  let recordedCommands: { command: string; args: unknown[] }[];
  let activeListener:
    | ((event: vscode.DiagnosticChangeEvent) => void)
    | undefined;
  let visibleEditors: vscode.TextEditor[];

  beforeEach(() => {
    diagnosticsByUri = new Map();
    recordedCommands = [];
    activeListener = undefined;
    visibleEditors = [];

    workspaceFs.fullPath = (relativePath: string) =>
      `/mock/workspace/${relativePath}`;

    commands.executeCommand = ((command: string, ...args: unknown[]) => {
      recordedCommands.push({ command, args });
      return Promise.resolve(undefined);
    }) as typeof commands.executeCommand;

    languages.getDiagnostics = ((uri?: vscode.Uri) => {
      if (!uri) {
        return Array.from(diagnosticsByUri.entries()).map(
          ([uriPath, diagnostics]) =>
            [vscode.Uri.file(uriPath), diagnostics] as [
              vscode.Uri,
              vscode.Diagnostic[],
            ],
        );
      }
      return diagnosticsByUri.get(uri.fsPath) ?? [];
    }) as typeof languages.getDiagnostics;

    languages.onDidChangeDiagnostics = (listener) => {
      activeListener = listener;
      return new vscode.Disposable(() => {
        activeListener = undefined;
      });
    };

    languages.createDiagnosticCollection = () => {
      const collection = {
        name: 'test-diagnostics',
        set: (
          uri:
            | vscode.Uri
            | Iterable<[vscode.Uri, readonly vscode.Diagnostic[]]>
            | readonly [vscode.Uri, readonly vscode.Diagnostic[] | undefined][],
          diagnostics?: readonly vscode.Diagnostic[] | undefined,
        ) => {
          const entries: Iterable<
            [vscode.Uri, readonly vscode.Diagnostic[] | undefined]
          > =
            uri instanceof vscode.Uri
              ? ([
                  [uri, diagnostics] as [
                    vscode.Uri,
                    readonly vscode.Diagnostic[] | undefined,
                  ],
                ] as const)
              : (uri as Iterable<
                  [vscode.Uri, readonly vscode.Diagnostic[] | undefined]
                >);

          const uris: vscode.Uri[] = [];

          for (const [entryUri, entryDiagnostics] of entries) {
            if (entryDiagnostics && entryDiagnostics.length > 0) {
              diagnosticsByUri.set(entryUri.fsPath, [...entryDiagnostics]);
            } else {
              diagnosticsByUri.delete(entryUri.fsPath);
            }
            uris.push(entryUri);
          }

          if (uris.length > 0 && activeListener) {
            activeListener({ uris });
          }
        },
        clear: () => {
          diagnosticsByUri.clear();
        },
        delete: (uri: vscode.Uri) => {
          diagnosticsByUri.delete(uri.fsPath);
        },
        dispose: () => {
          diagnosticsByUri.clear();
        },
        forEach: (
          callback: (
            uri: vscode.Uri,
            diagnostics: readonly vscode.Diagnostic[],
            collection: vscode.DiagnosticCollection,
          ) => unknown,
          thisArg?: unknown,
        ) => {
          for (const [uriPath, diagnostics] of diagnosticsByUri.entries()) {
            callback.call(
              thisArg,
              vscode.Uri.file(uriPath),
              diagnostics,
              collection as vscode.DiagnosticCollection,
            );
          }
        },
        get: (uri: vscode.Uri) => diagnosticsByUri.get(uri.fsPath),
        has: (uri: vscode.Uri) => diagnosticsByUri.has(uri.fsPath),
        [Symbol.iterator]: function* () {
          for (const [uriPath, diagnostics] of diagnosticsByUri.entries()) {
            yield [vscode.Uri.file(uriPath), diagnostics] as [
              vscode.Uri,
              vscode.Diagnostic[],
            ];
          }
        },
      } satisfies Partial<vscode.DiagnosticCollection> & { name: string };

      return collection as unknown as vscode.DiagnosticCollection;
    };

    workspace.openTextDocument = async () => {
      throw new Error('openTextDocument should not be called in this test');
    };

    window.showTextDocument = async () => {
      throw new Error('showTextDocument should not be called in this test');
    };

    Object.defineProperty(vscode.window, 'visibleTextEditors', {
      configurable: true,
      get: () => visibleEditors,
    });
  });

  afterEach(() => {
    workspaceFs.fullPath = originalFullPath;
    commands.executeCommand = originalExecuteCommand;
    languages.getDiagnostics = originalGetDiagnostics;
    languages.onDidChangeDiagnostics = originalOnDidChangeDiagnostics;
    languages.createDiagnosticCollection = originalCreateDiagnosticCollection;
    workspace.openTextDocument = originalOpenTextDocument;
    window.showTextDocument = originalShowTextDocument;
    diagnosticsByUri.clear();
    recordedCommands = [];
    activeListener = undefined;

    if (originalVisibleEditorsDescriptor) {
      Object.defineProperty(
        vscode.window,
        'visibleTextEditors',
        originalVisibleEditorsDescriptor,
      );
    } else {
      delete (
        vscode.window as unknown as { visibleTextEditors?: vscode.TextEditor[] }
      ).visibleTextEditors;
    }
  });

  it('waits for diagnostics change events before returning results', async () => {
    const relativePath = 'main.tex';
    const targetUri = vscode.Uri.file(`/mock/workspace/${relativePath}`);

    const mockDocument = {
      uri: targetUri,
      isDirty: false,
      save: async () => undefined,
    } as unknown as vscode.TextDocument;

    const mockEditor = {
      document: mockDocument,
    } as unknown as vscode.TextEditor;

    visibleEditors.push(mockEditor);

    const collection = vscode.languages.createDiagnosticCollection('test');
    diagnosticsByUri.set(targetUri.fsPath, []);

    const diagnosticsPromise = getLinterMessages(relativePath);

    const raceResult = await Promise.race([
      diagnosticsPromise.then(() => 'resolved'),
      new Promise<'pending'>((resolve) =>
        setTimeout(() => resolve('pending'), 25),
      ),
    ]);

    assert.strictEqual(
      raceResult,
      'pending',
      'Expected getLinterMessages to wait for diagnostics updates',
    );

    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(new vscode.Position(1, 0), new vscode.Position(1, 5)),
      'Example diagnostic',
      vscode.DiagnosticSeverity.Error,
    );

    collection.set(targetUri, [diagnostic]);

    const diagnostics = await diagnosticsPromise;

    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].message, 'Example diagnostic');
    assert.deepStrictEqual(recordedCommands, [
      { command: 'latex-workshop.build', args: [targetUri] },
    ]);
    assert.strictEqual(
      activeListener,
      undefined,
      'Expected diagnostics listener to be disposed after resolving',
    );

    collection.dispose();
  });
});
