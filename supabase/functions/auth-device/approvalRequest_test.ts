import { deepStrictEqual, strictEqual } from 'node:assert/strict';

import { parseApprovalDecision } from './approvalRequest.ts';

Deno.test('parseApprovalDecision accepts explicit boolean values', () => {
  strictEqual(
    parseApprovalDecision({ user_code: 'BCDF2345', approve: true }),
    true,
  );
  strictEqual(
    parseApprovalDecision({ user_code: 'BCDF2345', approve: false }),
    false,
  );
});

Deno.test('parseApprovalDecision rejects non-boolean values', () => {
  const malformedBodies = [
    { user_code: 'BCDF2345' },
    { user_code: 'BCDF2345', approve: null },
    { user_code: 'BCDF2345', approve: 'true' },
    { user_code: 'BCDF2345', approve: 1 },
    { user_code: 'BCDF2345', approve: { value: true } },
  ];

  deepStrictEqual(
    malformedBodies.map(parseApprovalDecision),
    malformedBodies.map(() => null),
  );
});

// The poll endpoint over a fake project: every Supabase call goes to `fetch`
// below.
Deno.test('a transient owner lookup failure keeps an approved request for the next poll', async () => {
  const projectUrl = 'https://project.example.test';
  for (const [name, value] of Object.entries({
    SUPABASE_URL: projectUrl,
    SUPABASE_ANON_KEY: 'anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  })) {
    Deno.env.set(name, value);
  }
  const approved = {
    id: 'a584b784-a4f1-4d44-a99f-36767d31e79d',
    status: 'approved',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    last_polled_at: null,
    poll_interval_seconds: 5,
    user_id: '6f1c2a4e-3b5d-4c7e-9f80-1a2b3c4d5e6f',
  };
  const deletes: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    const { pathname } = new URL(request.url);
    if (pathname === '/rest/v1/device_auth_requests') {
      if (request.method === 'DELETE') {
        deletes.push(request.url);
        return Promise.resolve(Response.json([approved]));
      }
      const single = request.headers.get('Accept')?.includes('pgrst.object');
      return Promise.resolve(Response.json(single ? approved : [approved]));
    }
    if (pathname === `/auth/v1/admin/users/${approved.user_id}`) {
      return Promise.resolve(
        Response.json({ message: 'upstream unavailable' }, { status: 503 }),
      );
    }
    return Promise.resolve(new Response('unexpected', { status: 599 }));
  };
  try {
    const { app } = await import('./index.ts');
    const response = await app.fetch(
      new Request('https://project.example.test/auth-device/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_code: 'device-code-secret' }),
      }),
    );
    strictEqual(response.status, 500);
    deepStrictEqual(deletes, []);
  } finally {
    globalThis.fetch = realFetch;
  }
});
