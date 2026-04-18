import * as vscode from 'vscode';

import { bus } from '@eventBus/ProgressEventBus';
import type { FileLocation, OutputFileInfo } from '@shared/schemas';

// Surfaces files agents write during this session as a badge in the Explorer,
// similar to how the built-in Git provider decorates modified files. Session-
// scoped only — the set is not persisted across window reloads.
class TeXRAFileDecorationProvider implements vscode.FileDecorationProvider {
  private readonly touched = new Set<string>();
  private readonly _onDidChange = new vscode.EventEmitter<
    vscode.Uri | vscode.Uri[]
  >();
  readonly onDidChangeFileDecorations = this._onDidChange.event;

  markTouched(absolutePaths: readonly string[]): void {
    const newly: vscode.Uri[] = [];
    for (const p of absolutePaths) {
      if (!this.touched.has(p)) {
        this.touched.add(p);
        newly.push(vscode.Uri.file(p));
      }
    }
    if (newly.length > 0) {
      this._onDidChange.fire(newly);
    }
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file' || !this.touched.has(uri.fsPath)) {
      return undefined;
    }
    return {
      badge: 'T',
      tooltip: 'Modified by TeXRA',
      color: new vscode.ThemeColor('textLink.foreground'),
    };
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

function collectWorkspacePaths(files: readonly OutputFileInfo[]): string[] {
  const paths: string[] = [];
  for (const file of files) {
    const loc: FileLocation = file.location;
    if (loc.kind === 'workspace') {
      paths.push(loc.absolutePath);
    }
  }
  return paths;
}

export function registerFileDecorations(
  context: vscode.ExtensionContext,
): void {
  const provider = new TeXRAFileDecorationProvider();

  const unsubscribe = bus.on('addOutputFiles', ({ filesByRound }) => {
    const paths: string[] = [];
    for (const roundFiles of Object.values(filesByRound)) {
      paths.push(...collectWorkspacePaths(roundFiles));
    }
    if (paths.length > 0) {
      provider.markTouched(paths);
    }
  });

  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(provider),
    provider,
    { dispose: unsubscribe },
  );
}
