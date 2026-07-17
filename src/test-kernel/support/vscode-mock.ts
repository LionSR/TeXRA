/**
 * Minimal vscode module stub for unit tests running outside VS Code.
 * Only mocks the APIs that production code calls at module load time or
 * in paths exercised by the test suite.
 */

export const window = {
  showErrorMessage: async (..._: unknown[]) => undefined,
  showInformationMessage: async (..._: unknown[]) => undefined,
  showWarningMessage: async (..._: unknown[]) => undefined,
  createOutputChannel: (_name: string) => ({
    appendLine: (_text: string) => {},
    append: (_text: string) => {},
    show: () => {},
    dispose: () => {},
  }),
};

export const workspace = {
  getConfiguration: (_section?: string) => ({
    get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
  }),
  onDidChangeConfiguration: () => ({ dispose: () => {} }),
  createFileSystemWatcher: () => ({
    onDidCreate: () => ({ dispose: () => {} }),
    onDidChange: () => ({ dispose: () => {} }),
    onDidDelete: () => ({ dispose: () => {} }),
    dispose: () => {},
  }),
};

export const commands = {
  executeCommand: async (..._: unknown[]) => undefined,
};

export const Uri = {
  file: (p: string) => ({ fsPath: p, toString: () => p, path: p }),
  parse: (s: string) => ({ fsPath: s, toString: () => s, path: s }),
};

export class RelativePattern {
  constructor(
    public readonly base: unknown,
    public readonly pattern: string,
  ) {}
}

export const FileType = {
  Unknown: 0,
  File: 1,
  Directory: 2,
  SymbolicLink: 64,
};

export class EventEmitter<T> {
  event = (_listener: (e: T) => unknown) => ({ dispose: () => {} });
  fire(_data: T) {}
  dispose() {}
}

export class Disposable {
  static from(..._: { dispose(): unknown }[]): Disposable {
    return new Disposable(() => {});
  }
  constructor(private callOnDispose: () => unknown) {}
  dispose() {
    this.callOnDispose();
  }
}

export const ThemeColor = class {
  constructor(public id: string) {}
};

export const ProgressLocation = {
  Notification: 15,
  Window: 10,
  SourceControl: 1,
};
export const StatusBarAlignment = { Left: 1, Right: 2 };
