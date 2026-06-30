import * as vscode from 'vscode';

/**
 * Wraps a vscode QuickInput with an idempotent settle/accept callback.
 *
 * Use this as an escape hatch for inputs that need custom event handlers
 * (e.g. canSelectMany + button toggles). For standard single-item pickers
 * prefer the higher-level `showQuickPick`.
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

/**
 * Show a single-select QuickPick described by a plain config object.
 *
 * Handles picker creation, default active item, the VS Code 1.108+ `prompt`
 * property (silently ignored on older hosts), and wiring up accept/dismiss.
 * Resolves with the chosen item, or `undefined` when dismissed.
 */
export async function showQuickPick<T extends vscode.QuickPickItem>(opts: {
  items: readonly T[];
  title?: string;
  placeholder?: string;
  /** Persistent hint below the input box (VS Code 1.108+; ignored on older hosts). */
  prompt?: string;
  ignoreFocusOut?: boolean;
}): Promise<T | undefined> {
  const qp = vscode.window.createQuickPick<T>();
  if (opts.title !== undefined) qp.title = opts.title;
  if (opts.placeholder !== undefined) qp.placeholder = opts.placeholder;
  if (opts.ignoreFocusOut !== undefined) qp.ignoreFocusOut = opts.ignoreFocusOut;
  qp.items = opts.items;
  const defaultItem = opts.items[0];
  if (defaultItem) qp.activeItems = [defaultItem];
  if (opts.prompt !== undefined && 'prompt' in qp) {
    (qp as vscode.QuickPick<T> & { prompt: string }).prompt = opts.prompt;
  }
  return settleQuickInput(qp, (accept) => {
    qp.onDidAccept(() => {
      accept(qp.activeItems[0] ?? qp.selectedItems[0]);
    });
  });
}
