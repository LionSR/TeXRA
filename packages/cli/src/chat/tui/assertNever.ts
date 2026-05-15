export function assertNever(value: never, message: string): never {
  const detail =
    typeof value === 'string' ? value : JSON.stringify(value, undefined, 2);
  throw new Error(`${message}: ${detail}`);
}
