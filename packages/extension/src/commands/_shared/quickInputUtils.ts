import * as vscode from 'vscode';

/**
 * Wraps a vscode QuickInput with an idempotent settle/accept callback.
 *
 * Use this as an escape hatch for inputs that need custom event handlers
 * (e.g. canSelectMany + button toggles). For standard single-item pickers
 * prefer `vscode.window.showQuickPick`.
 *
 * The `setup` function is called to attach `onDidAccept` and any other event
 * handlers; the caller does NOT need to register `onDidHide` or call `show()`
 * — this helper handles both. Resolves with `undefined` when dismissed.
 */
export async function settleQuickInput<T>(
  input: vscode.QuickInput,
  setup: (accept: (value: T | undefined) => void) => void,
): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve) => {
    let settled = false;
    const accept = (value: T | undefined): void => {
      if (settled) return;
      settled = true;
      resolve(value);
      input.dispose();
    };
    setup(accept);
    input.onDidHide(() => accept(undefined));
    input.show();
  });
}
