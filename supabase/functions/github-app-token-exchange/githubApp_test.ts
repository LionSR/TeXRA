import { rejects, strictEqual } from 'node:assert/strict';

import { createGitHubAppClient, GitHubApiError } from './githubApp.ts';

const WORKFLOW_PATH = '.github/workflows/texra-code-review.yml';
const WORKFLOW_SHA = 'feature-branch-sha';
const CONTENTS_PATH = `/repos/owner/repo/contents/${WORKFLOW_PATH}`;

/**
 * `@octokit/auth-app` signs its app JWT locally, so a freshly generated PKCS#8
 * key is enough to exercise the client without contacting GitHub.
 */
async function generatePrivateKeyPem(): Promise<string> {
  const { privateKey } = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey('pkcs8', privateKey),
  );
  const base64 = btoa(String.fromCharCode(...pkcs8));
  return [
    '-----BEGIN PRIVATE KEY-----',
    ...(base64.match(/.{1,64}/g) ?? []),
    '-----END PRIVATE KEY-----',
    '',
  ].join('\n');
}

interface StubbedCall {
  url: string;
  method: string;
  body: unknown;
}

type ContentsResponder = (ref: string) => Response;

function jsonOk(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Serve the four endpoints `createGitHubAppClient` touches, delegating the
 * workflow-content lookups to the caller so each test can shape them.
 */
function stubGitHub(contents: ContentsResponder): {
  calls: StubbedCall[];
  restore(): void;
} {
  const originalFetch = globalThis.fetch;
  const calls: StubbedCall[] = [];

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const body =
      typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });

    const { pathname, searchParams } = new URL(url);
    if (pathname === '/repos/owner/repo/installation') {
      return Promise.resolve(jsonOk({ id: 42 }));
    }
    if (pathname === '/app/installations/42/access_tokens') {
      return Promise.resolve(
        jsonOk(
          {
            token: 'installation-token',
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            permissions: body?.permissions ?? {},
            repository_selection: 'selected',
          },
          201,
        ),
      );
    }
    if (pathname === '/repos/owner/repo') {
      return Promise.resolve(
        jsonOk({ id: 123, default_branch: 'main', owner: { id: 456 } }),
      );
    }
    if (pathname === CONTENTS_PATH) {
      return Promise.resolve(contents(searchParams.get('ref') ?? ''));
    }
    return Promise.resolve(new Response('unexpected', { status: 500 }));
  }) as typeof fetch;

  return { calls, restore: () => (globalThis.fetch = originalFetch) };
}

async function withStubbedGitHub<T>(
  contents: ContentsResponder,
  use: (
    client: Awaited<ReturnType<typeof createGitHubAppClient>>,
    calls: StubbedCall[],
  ) => Promise<T>,
): Promise<T> {
  const { calls, restore } = stubGitHub(contents);
  try {
    const client = await createGitHubAppClient({
      appId: '4507914',
      privateKey: await generatePrivateKeyPem(),
      owner: 'owner',
      repo: 'repo',
    });
    return await use(client, calls);
  } finally {
    restore();
  }
}

Deno.test(
  'workflow missing from the default branch is untrusted, not a missing App',
  async () => {
    const trusted = await withStubbedGitHub(
      (ref) =>
        ref === WORKFLOW_SHA
          ? jsonOk({ type: 'file', sha: 'blob-sha' })
          : new Response('Not Found', { status: 404 }),
      (client) => client.isWorkflowOnDefaultBranch(WORKFLOW_PATH, WORKFLOW_SHA),
    );
    strictEqual(trusted, false);
  },
);

Deno.test('workflow matching the default branch blob is trusted', async () => {
  const trusted = await withStubbedGitHub(
    () => jsonOk({ type: 'file', sha: 'blob-sha' }),
    (client) => client.isWorkflowOnDefaultBranch(WORKFLOW_PATH, WORKFLOW_SHA),
  );
  strictEqual(trusted, true);
});

Deno.test(
  'a failed content lookup surfaces instead of reading as untrusted',
  async () => {
    await withStubbedGitHub(
      () => new Response('Server Error', { status: 500 }),
      (client) =>
        rejects(
          () => client.isWorkflowOnDefaultBranch(WORKFLOW_PATH, WORKFLOW_SHA),
          GitHubApiError,
        ),
    );
  },
);

Deno.test('the exchanged token never carries contents write', async () => {
  const permissions = await withStubbedGitHub(
    () => jsonOk({ type: 'file', sha: 'blob-sha' }),
    async (client, calls) => {
      await client.mintRepositoryToken();
      return calls.findLast(
        (call) => call.url.endsWith('/access_tokens') && call.method === 'POST',
      )?.body as { permissions?: Record<string, string> } | undefined;
    },
  );
  strictEqual(permissions?.permissions?.contents, 'read');
  strictEqual(permissions?.permissions?.issues, 'write');
  strictEqual(permissions?.permissions?.pull_requests, 'write');
});
