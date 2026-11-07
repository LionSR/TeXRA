import { equal, strictEqual } from 'node:assert/strict';

// The functions read their Supabase keys at load, so the fake project is set
// before the tests import them; `fetch` answers for GoTrue.
const PROJECT_URL = 'https://project.example.test';
Deno.env.set('SUPABASE_URL', PROJECT_URL);
Deno.env.set('SUPABASE_ANON_KEY', 'anon-key');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key');

const INSTALL_ID = 'a584b784-a4f1-4d44-a99f-36767d31e79d';

/** Answer GoTrue's `GET /auth/v1/user` with `answer`; returns the restore. */
function fakeGoTrue(answer: () => Response): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) =>
    Promise.resolve(
      new URL(new Request(input, init).url).pathname === '/auth/v1/user'
        ? answer()
        : new Response('unexpected', { status: 599 }),
    );
  return () => {
    globalThis.fetch = realFetch;
  };
}

Deno.test('a missing or invalid bearer is rejected; the install id is never read', async () => {
  const { resolveJwtOwner } = await import('./usageOwner.ts');
  const restore = fakeGoTrue(() =>
    Response.json({ code: 401, msg: 'invalid JWT' }, { status: 401 }),
  );
  try {
    for (const headers of <Record<string, string>[]>[
      {},
      { Authorization: 'Bearer invalid' },
      { Authorization: 'Bearer invalid', 'X-TeXRA-Install-Id': INSTALL_ID },
      { 'X-TeXRA-Install-Id': INSTALL_ID },
    ]) {
      equal(
        await resolveJwtOwner(
          new Request(`${PROJECT_URL}/log-usage`, { method: 'POST', headers }),
        ),
        null,
      );
    }
  } finally {
    restore();
  }
});

// index.ts serves on import, so `Deno.serve` is captured.
Deno.test('a GoTrue outage answers 503, not a sign-in failure', async () => {
  const restore = fakeGoTrue(() =>
    Response.json({ message: 'upstream unavailable' }, { status: 503 }),
  );
  const realServe = Deno.serve;
  let serve: (req: Request) => Response | Promise<Response> = () => {
    throw new Error('index.ts did not serve');
  };
  // cast: index.ts passes one handler and never reads the server back.
  Deno.serve = ((handler: typeof serve) => {
    serve = handler;
  }) as unknown as typeof Deno.serve;
  try {
    await import('./index.ts');
    const response = await serve(
      new Request(`${PROJECT_URL}/log-usage`, {
        method: 'POST',
        headers: { Authorization: 'Bearer a.user.jwt' },
        body: '{}',
      }),
    );
    strictEqual(response.status, 503);
  } finally {
    Deno.serve = realServe;
    restore();
  }
});
