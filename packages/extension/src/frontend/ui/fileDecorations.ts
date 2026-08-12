import * as vscode from 'vscode';

import { defaultSession, type SessionEventHub } from '@agent/runtime';
import { appSignals } from '@eventBus/AppSignals';
import { subscribeAddOutputFilesRunFact } from '@frontend/events/runFactSubscriptions';

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
    this.touched.clear();
    this._onDidChange.dispose();
  }
}

export function registerFileDecorations(
  context: vscode.ExtensionContext,
  events: SessionEventHub = defaultSession().events,
): void {
  const provider = new TeXRAFileDecorationProvider();

  const unsubscribeOutputFiles = subscribeAddOutputFilesRunFact(
    events,
    ({ filesByRound }) => {
      // Only mark the primary output location. Lineage entries (original,
      // diffBase, diffFile) are reference points; marking them would badge the
      // source file as "Modified by TeXRA" before the user has actually
      // accepted the workflow output.
      const paths = new Set<string>();
      for (const roundFiles of Object.values(filesByRound)) {
        for (const info of roundFiles) {
          if (info.location.kind === 'workspace') {
            paths.add(info.location.absolutePath);
          }
        }
      }
      provider.markTouched(paths);
    },
  );

  const unsubscribeWritten = appSignals.on(
    'workspaceFilesWritten',
    ({ absolutePaths }) => {
      provider.markTouched(absolutePaths);
    },
  );

  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(provider),
    provider,
    { dispose: unsubscribeOutputFiles },
    { dispose: unsubscribeWritten },
  );
}
