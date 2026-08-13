// Third-party imports
import { vi } from 'vitest';

/**
 * Spies on a Node write stream (`process.stdout` / `process.stderr`),
 * forwarding each chunk to `onChunk` and immediately invoking any completion
 * callback so call sites that `await stream.write(...)` resolve instead of
 * hanging.
 */
export function spyOnStreamWrite(
  stream: NodeJS.WriteStream,
  onChunk: (chunk: string) => void = () => {},
): ReturnType<typeof vi.spyOn> {
  return vi
    .spyOn(stream, 'write')
    .mockImplementation((chunk: unknown, ...rest: unknown[]) => {
      onChunk(String(chunk));
      const callback = rest.find((arg) => typeof arg === 'function') as
        ((error?: Error | null) => void) | undefined;
      callback?.(null);
      return true;
    }) as unknown as ReturnType<typeof vi.spyOn>;
}
