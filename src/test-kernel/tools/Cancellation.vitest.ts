// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { ToolError } from '@shared/schemas/toolResult';
import { abandonOnAbort } from '@tools/citation/rateLimiter';

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('abandonOnAbort', () => {
  it('passes the operation through when no signal is provided', async () => {
    await expect(
      abandonOnAbort(Promise.resolve('ok'), undefined, 'lookup'),
    ).resolves.toBe('ok');
  });

  it('resolves with the operation result when it settles first', async () => {
    const controller = new AbortController();
    await expect(
      abandonOnAbort(Promise.resolve(42), controller.signal, 'lookup'),
    ).resolves.toBe(42);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const never = new Promise<never>(() => {});
    await expect(
      abandonOnAbort(never, controller.signal, 'arXiv search'),
    ).rejects.toThrow(new ToolError('Cancelled arXiv search.'));
  });

  it('rejects as soon as the signal aborts mid-flight', async () => {
    const controller = new AbortController();
    const slow = delay(5_000).then(() => 'too late');
    const pending = abandonOnAbort(slow, controller.signal, 'lookup');
    controller.abort();
    await expect(pending).rejects.toThrow('Cancelled lookup.');
  });

  it('swallows the abandoned operation rejection after abort', async () => {
    const controller = new AbortController();
    let rejectOperation: (error: Error) => void = () => {};
    const operation = new Promise<never>((_, reject) => {
      rejectOperation = reject;
    });
    const pending = abandonOnAbort(operation, controller.signal, 'lookup');
    controller.abort();
    await expect(pending).rejects.toThrow('Cancelled lookup.');
    // The orphaned rejection must not become an unhandled rejection.
    rejectOperation(new Error('late network failure'));
    await delay(10);
  });

  it('propagates the operation error when it rejects before abort', async () => {
    const controller = new AbortController();
    await expect(
      abandonOnAbort(
        Promise.reject(new Error('boom')),
        controller.signal,
        'lookup',
      ),
    ).rejects.toThrow('boom');
  });
});
