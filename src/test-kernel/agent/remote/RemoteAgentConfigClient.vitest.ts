import { strict as assert } from 'node:assert';

import { afterEach, describe, it, vi } from 'vitest';

import { fetchRemoteAgentConfigYaml } from '@agent/remote/remoteAgentConfigClient';
import { SUPABASE_CONFIG } from '@auth/config';

describe('fetchRemoteAgentConfigYaml', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the agent name and returns the parsed YAML config', async () => {
    // ky buffers the request body for retry support, so read it inside the mock
    // (via clone) before that stream is consumed rather than from mock.calls.
    let requestBody: unknown;
    const fetchMock = vi.fn(async (request: Request) => {
      requestBody = await request.clone().json();
      return Response.json({ config: 'settings: {}\nprompts: {}\n' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const config = await fetchRemoteAgentConfigYaml('remoteWriter', 'token');

    assert.equal(config, 'settings: {}\nprompts: {}\n');
    assert.equal(fetchMock.mock.calls.length, 1);
    // ky passes a Request object; inspect properties rather than raw fetch args
    const request = fetchMock.mock.calls[0][0];
    assert.equal(request.url, SUPABASE_CONFIG.edgeFunctionUrl);
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.get('Authorization'), 'Bearer token');
    assert.equal(request.headers.get('Content-Type'), 'application/json');
    assert.deepEqual(requestBody, { agentName: 'remoteWriter' });
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

  it('maps forbidden agents to a permission-specific error text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('forbidden', { status: 403 })),
    );

    await assert.rejects(
      () => fetchRemoteAgentConfigYaml('remoteWriter', 'token'),
      /Your account does not have permission to access this remote agent/,
    );
  });
});
