export type DebouncedFunction<T extends (...args: any[]) => void> = ((
  ...args: Parameters<T>
) => void) & {
  cancel: () => void;
};

export function debounce<T extends (...args: any[]) => void>(
  fn: T,
  delayMs: number,
): DebouncedFunction<T> {
  let timer: number | null = null;

  const debounced = (...args: Parameters<T>): void => {
    if (timer !== null) {
      window.clearTimeout(timer);
    }
    timer = window.setTimeout(() => fn(...args), delayMs);
  };

  debounced.cancel = (): void => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };

  return debounced;
}
