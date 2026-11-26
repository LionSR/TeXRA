import { Effect, type Scope } from 'effect';
import * as vscode from 'vscode';

import { onAppSignal } from '@texra-ai/worldline/host';
import type { AppSignals } from '@texra-ai/worldline/plugins';

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

/** Badge the files TeXRA wrote, for as long as the caller's scope lasts:
 *  the listener is a fiber of it (activation's, in the extension). */
export const registerFileDecorations: Effect.Effect<
  void,
  never,
  Scope.Scope | AppSignals
> = Effect.gen(function* () {
  const provider = yield* Effect.acquireRelease(
    Effect.sync(() => new TeXRAFileDecorationProvider()),
    (provider) => Effect.sync(() => provider.dispose()),
  );
  yield* Effect.acquireRelease(
    Effect.sync(() => vscode.window.registerFileDecorationProvider(provider)),
    (registration) => Effect.sync(() => registration.dispose()),
  );
  yield* Effect.forkScoped(
    onAppSignal('workspaceFilesWritten', ({ absolutePaths }) => {
      provider.markTouched(absolutePaths);
    }),
    { startImmediately: true },
  );
});
