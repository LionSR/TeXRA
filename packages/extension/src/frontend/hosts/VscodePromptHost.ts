// Third-party imports
import * as vscode from 'vscode';

// Local imports
import type {
  PromptConfirmOptions,
  PromptHost,
  PromptInputOptions,
  PromptMessageItem,
  PromptMessageOptions,
} from '@hosts/uiHosts';

export class VscodePromptHost implements PromptHost {
  async info<T extends string = string>(
    message: string,
    options: PromptMessageOptions<T> = {},
  ): Promise<T | undefined> {
    return this.showMessage(
      message,
      options,
      vscode.window.showInformationMessage,
    );
  }

  async warning<T extends string = string>(
    message: string,
    options: PromptMessageOptions<T> = {},
  ): Promise<T | undefined> {
    return this.showMessage(message, options, vscode.window.showWarningMessage);
  }

  async error<T extends string = string>(
    message: string,
    options: PromptMessageOptions<T> = {},
  ): Promise<T | undefined> {
    return this.showMessage(message, options, vscode.window.showErrorMessage);
  }

  async confirm(
    message: string,
    options: PromptConfirmOptions,
  ): Promise<boolean> {
    const confirmLabel = options.confirmLabel;
    const cancelLabel = options.cancelLabel ?? 'Cancel';
    const selected = await vscode.window.showWarningMessage(
      message,
      {
        detail: options.detail,
        modal: options.modal ?? true,
      },
      { title: confirmLabel },
      { title: cancelLabel, isCloseAffordance: true },
    );
    return selected?.title === confirmLabel;
  }

  async input(options: PromptInputOptions): Promise<string | undefined> {
    return vscode.window.showInputBox(options);
  }

  private async showMessage<T extends string>(
    message: string,
    options: PromptMessageOptions<T>,
    show: (
      message: string,
      options: vscode.MessageOptions,
      ...items: vscode.MessageItem[]
    ) => Thenable<vscode.MessageItem | undefined>,
  ): Promise<T | undefined> {
    const selected = await show(
      message,
      {
        detail: options.detail,
        modal: options.modal,
      },
      ...this.toVscodeItems(options.items),
    );
    return selected?.title as T | undefined;
  }

  private toVscodeItems<T extends string>(
    items: readonly PromptMessageItem<T>[] = [],
  ): vscode.MessageItem[] {
    return items.map((item) => {
      if (typeof item === 'string') {
        return { title: item };
      }
      return {
        title: item.label,
        isCloseAffordance: item.isCloseAffordance,
      };
    });
  }
}
