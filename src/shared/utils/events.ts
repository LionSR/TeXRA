/** Create a bubbling composed custom event with typed detail. */
export function createEvent<T = undefined>(
  type: string,
  ...args: undefined extends T ? [detail?: T] : [detail: T]
): CustomEvent<T> {
  const detail = args[0] as T;
  return new CustomEvent(type, { detail, bubbles: true, composed: true });
}
