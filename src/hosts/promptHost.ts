export type PromptMessageItem<T extends string = string> =
  | T
  | {
      label: T;
      isCloseAffordance?: boolean;
    };

export interface PromptMessageOptions<T extends string = string> {
  detail?: string;
  modal?: boolean;
  items?: readonly PromptMessageItem<T>[];
}

export interface PromptConfirmOptions {
  detail?: string;
  modal?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
}

export interface PromptInputOptions {
  title?: string;
  prompt?: string;
  placeHolder?: string;
  value?: string;
  password?: boolean;
  ignoreFocusOut?: boolean;
  validateInput?: (
    value: string,
  ) => string | undefined | null | Promise<string | undefined | null>;
}

export interface PromptHost {
  info<T extends string = string>(
    message: string,
    options?: PromptMessageOptions<T>,
  ): Promise<T | undefined>;
  warning<T extends string = string>(
    message: string,
    options?: PromptMessageOptions<T>,
  ): Promise<T | undefined>;
  error<T extends string = string>(
    message: string,
    options?: PromptMessageOptions<T>,
  ): Promise<T | undefined>;
  confirm(message: string, options?: PromptConfirmOptions): Promise<boolean>;
  input(options: PromptInputOptions): Promise<string | undefined>;
}
