// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { ToolError } from '@shared/schemas';
import { abandonOnAbort } from '@tools/citation/rateLimiter';

const neverSettles = new Promise<never>(() => {});

describe('abandonOnAbort', () => {
  it('resolves with the operation result when no abort fires', async () => {
    const controller = new AbortController();
    await expect(
      abandonOnAbort(Promise.resolve(42), undefined, 'lookup'),
    ).resolves.toBe(42);
    await expect(
      abandonOnAbort(Promise.resolve(42), controller.signal, 'lookup'),
    ).resolves.toBe(42);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      abandonOnAbort(neverSettles, controller.signal, 'arXiv search'),
    ).rejects.toThrow(new ToolError('Cancelled arXiv search.'));
  });

  it('rejects as soon as the signal aborts mid-flight', async () => {
    const controller = new AbortController();
    const pending = abandonOnAbort(neverSettles, controller.signal, 'lookup');
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
    await new Promise((resolve) => setTimeout(resolve, 10));
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
