import { Effect, Stream, type Scope } from 'effect';
import * as vscode from 'vscode';

import type { SessionHandle } from '@agent/runtime';
import { onAppSignal } from '@eventBus/AppSignals';
import { outputFilesProduced } from '@frontend/events/runFactSubscriptions';

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
 *  both listeners are fibers of it (activation's, in the extension). */
export function registerFileDecorations(
  context: vscode.ExtensionContext,
  session: Pick<SessionHandle, 'events' | 'now'>,
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    const provider = new TeXRAFileDecorationProvider();
    yield* Effect.forkScoped(
      Stream.runForEach(outputFilesProduced(session), ({ filesByRound }) =>
        Effect.sync(() => {
          // Only mark the primary output location. Lineage entries (original,
          // diffBase) are reference points; marking them would badge the
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
        }),
      ),
      { startImmediately: true },
    );
    yield* Effect.forkScoped(
      onAppSignal('workspaceFilesWritten', ({ absolutePaths }) => {
        provider.markTouched(absolutePaths);
      }),
      { startImmediately: true },
    );
    context.subscriptions.push(
      vscode.window.registerFileDecorationProvider(provider),
      provider,
    );
  });
}
