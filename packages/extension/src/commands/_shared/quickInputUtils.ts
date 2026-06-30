import * as vscode from 'vscode';

/**
 * Wraps a vscode QuickInput with an idempotent settle/accept callback.
 *
 * The `setup` function is called to attach `onDidAccept` and any other
 * event handlers; the caller does NOT need to register `onDidHide` or call
 * `show()` — this helper handles both. The returned promise resolves with
 * `undefined` when the input is dismissed without a selection.
 *
 * Usage:
 *   const qp = vscode.window.createQuickPick<MyItem>();
 *   qp.title = '…'; qp.items = items;
 *   const pick = await settleQuickInput(qp, (accept) => {
 *     qp.onDidAccept(() => accept(qp.activeItems[0]));
 *   });
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
