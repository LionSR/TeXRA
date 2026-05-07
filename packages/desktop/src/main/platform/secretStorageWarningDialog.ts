import { BrowserWindow, dialog, type MessageBoxOptions } from 'electron';

type BrowserWindowSelector = Pick<
  typeof BrowserWindow,
  'getAllWindows' | 'getFocusedWindow'
>;

export function getSecretStorageWarningParentWindow(
  browserWindow: BrowserWindowSelector = BrowserWindow,
): BrowserWindow | undefined {
  return (
    browserWindow.getFocusedWindow() ??
    browserWindow.getAllWindows().find((window) => !window.isDestroyed())
  );
}

export async function showSecretStorageWarningDialog(
  message: string,
): Promise<void> {
  const options: MessageBoxOptions = { message, type: 'warning' };
  const parentWindow = getSecretStorageWarningParentWindow();
  if (parentWindow == null) {
    await dialog.showMessageBox(options);
    return;
  }

  await dialog.showMessageBox(parentWindow, options);
}
