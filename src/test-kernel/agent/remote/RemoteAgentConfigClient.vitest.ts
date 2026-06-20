import { strict as assert } from 'node:assert';

import { afterEach, describe, it, vi } from 'vitest';

import { fetchRemoteAgentConfigYaml } from '@agent/remote/remoteAgentConfigClient';
import { SUPABASE_CONFIG } from '@auth/config';

describe('fetchRemoteAgentConfigYaml', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the agent name and returns the parsed YAML config', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ config: 'settings: {}\nprompts: {}\n' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const config = await fetchRemoteAgentConfigYaml('remoteWriter', 'token');

    assert.equal(config, 'settings: {}\nprompts: {}\n');
    assert.equal(fetchMock.mock.calls.length, 1);
    assert.deepEqual(fetchMock.mock.calls[0], [
      SUPABASE_CONFIG.edgeFunctionUrl,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ agentName: 'remoteWriter' }),
      },
    ]);
  });

  it('maps missing agents to the existing user-facing error text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404 })),
    );

    await assert.rejects(
      () => fetchRemoteAgentConfigYaml('remoteWriter', 'token'),
      /Agent "remoteWriter" not found or access denied/,
    );
  });
});
