import * as vscode from 'vscode';

import { bus } from '@eventBus/ProgressEventBus';
import { collectOutputFileLocations } from '@shared/schemas';
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
      // Round-trip through Uri.file so storage and lookup use the same
      // canonical form (Windows drive letters are normalized differently
      // by Uri.file vs. raw fs paths).
      const uri = vscode.Uri.file(p);
      if (!this.touched.has(uri.fsPath)) {
        this.touched.add(uri.fsPath);
        newly.push(uri);
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

// Decorate workspace files reachable from this output info — including the
// original workspace file referenced via `lineage.original` for edit
// workflows whose agent output sits under runStorage.
function collectWorkspacePaths(
  target: Set<string>,
  info: OutputFileInfo,
): void {
  for (const loc of collectOutputFileLocations(info)) {
    if (loc.kind === 'workspace') {
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
