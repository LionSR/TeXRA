export const COPY_RESET_DELAY_MS: number;

export function copyTextToClipboard(text: string): Promise<boolean>;

export function copyWithFeedback(
  button: HTMLElement,
  text: string,
  options?: {
    defaultTitle?: string;
    successTitle?: string;
    successClass?: string;
    resetDelay?: number;
  },
): Promise<boolean>;
