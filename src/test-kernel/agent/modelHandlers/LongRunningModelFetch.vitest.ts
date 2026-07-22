// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

const transportMocks = vi.hoisted(() => ({
  undiciFetch: vi.fn(),
}));

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: transportMocks.undiciFetch };
});

// Local imports
import { LongRunningModelTransport } from '@agent/modelHandlers/support/longRunningModelFetch';

// Type imports
import type { Agent } from 'undici';

describe('LongRunningModelTransport', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('converts a native Request before calling package Undici', async () => {
    const close = vi.fn((callback: () => void) => callback());
    const dispatcher = { close } as unknown as Agent;
    const transport = new LongRunningModelTransport(dispatcher);
    const response = new Response(null, { status: 204 });
    transportMocks.undiciFetch.mockResolvedValueOnce(response);
    const request = new Request('https://openrouter.example/v1/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test': 'value' },
      body: JSON.stringify({ prompt: 'hello' }),
    });

    await expect(transport.fetch(request)).resolves.toBe(response);

    const [input, init] = transportMocks.undiciFetch.mock.calls[0] ?? [];
    expect(input).toBe('https://openrouter.example/v1/chat');
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test': 'value' },
      dispatcher,
    });
    expect(new TextDecoder().decode(init?.body as ArrayBuffer)).toBe(
      JSON.stringify({ prompt: 'hello' }),
    );

    transport.dispose();
    expect(close).toHaveBeenCalledOnce();
  });
});
