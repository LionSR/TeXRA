import * as vscode from 'vscode';

import { bus } from '@eventBus/ProgressEventBus';
import type { OutputFileInfo } from '@shared/schemas';

// Session-scoped: the touched set is not persisted across window reloads so
// the badges clear on restart and track only the current session's activity.
class TeXRAFileDecorationProvider implements vscode.FileDecorationProvider {
  private readonly touched = new Set<string>();
  private readonly _onDidChange = new vscode.EventEmitter<
    vscode.Uri | vscode.Uri[]
  >();
  readonly onDidChangeFileDecorations = this._onDidChange.event;

  markTouched(absolutePaths: Iterable<string>): void {
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

// Mirrors `OutputFilesManager.collectPaths` so an edit workflow's original
// workspace file (stored in `lineage.original`) is decorated, not just the
// agent's staged output which is often under runStorage.
function collectWorkspacePaths(
  target: Set<string>,
  info: OutputFileInfo,
): void {
  const { lineage } = info;
  const locations = [
    info.location,
    lineage?.original,
    lineage?.diffBase,
    lineage?.diffFile,
  ];
  for (const loc of locations) {
    if (loc?.kind === 'workspace') {
      target.add(loc.absolutePath);
    }
  }
}

export function registerFileDecorations(
  context: vscode.ExtensionContext,
): void {
  const provider = new TeXRAFileDecorationProvider();

  const unsubscribe = bus.on('addOutputFiles', ({ filesByRound }) => {
    const paths = new Set<string>();
    for (const roundFiles of Object.values(filesByRound)) {
      for (const info of roundFiles) {
        collectWorkspacePaths(paths, info);
      }
    }
    if (paths.size > 0) {
      provider.markTouched(paths);
    }
  });

  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(provider),
    provider,
    { dispose: unsubscribe },
  );
}
