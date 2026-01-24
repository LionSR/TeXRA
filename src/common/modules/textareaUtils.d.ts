export function insertTextAtCursor(
  target: HTMLElement | HTMLTextAreaElement,
  text: string,
): void;

export function resolveTextareaTarget(
  target: HTMLElement | HTMLTextAreaElement | null | undefined,
): {
  host: HTMLElement | null;
  textarea: HTMLTextAreaElement | null;
};

export function awaitTextareaUpgrade(
  target: HTMLElement | HTMLTextAreaElement | null | undefined,
  callback: (element: HTMLElement | HTMLTextAreaElement) => void,
): void;
