import { strictEqual } from 'node:assert/strict';

import type { GitHubActionsClaims } from './auth.ts';
import { handleExchangeRequest } from './index.ts';

const claims: GitHubActionsClaims = {
  repository: 'owner/repo',
  repositoryId: '123',
  repositoryOwnerId: '456',
  workflowRef: 'owner/repo/.github/workflows/texra.yml@refs/heads/main',
  workflowSha: 'abc123',
};

function request(token = 'oidc-token'): Request {
  return new Request('https://remote.texra.ai/token', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

function dependencies(
  overrides: Partial<Parameters<typeof handleExchangeRequest>[1]> = {},
): NonNullable<Parameters<typeof handleExchangeRequest>[1]> {
  return {
    appId: '4507914',
    privateKey: 'private-key',
    verifyToken: () => Promise.resolve(claims),
    createAppClient: () =>
      Promise.resolve({
        getRepositoryIdentity: () =>
          Promise.resolve({
            id: 123,
            ownerId: 456,
            defaultBranch: 'main',
          }),
        isWorkflowOnDefaultBranch: () => Promise.resolve(true),
        mintRepositoryToken: () => Promise.resolve('installation-token'),
      }),
    ...overrides,
  };
}

Deno.test(
  'exchange returns a repository-scoped installation token',
  async () => {
    const response = await handleExchangeRequest(request(), dependencies());
    strictEqual(response.status, 200);
    strictEqual((await response.json()).token, 'installation-token');
  },
);

Deno.test('exchange rejects missing bearer credentials', async () => {
  const response = await handleExchangeRequest(
    new Request('https://remote.texra.ai/token', { method: 'POST' }),
    dependencies(),
  );
  strictEqual(response.status, 401);
});

Deno.test('exchange rejects invalid OIDC credentials', async () => {
  const response = await handleExchangeRequest(
    request(),
    dependencies({
      verifyToken: () => Promise.reject(new Error('invalid signature')),
    }),
  );
  strictEqual(response.status, 401);
});

Deno.test(
  'exchange rejects workflow content that differs from the default branch',
  async () => {
    let minted = false;
    const response = await handleExchangeRequest(
      request(),
      dependencies({
        verifyToken: () =>
          Promise.resolve({
            ...claims,
            workflowRef:
              'owner/repo/.github/workflows/texra.yml@refs/pull/123/merge',
          }),
        createAppClient: () =>
          Promise.resolve({
            getRepositoryIdentity: () =>
              Promise.resolve({
                id: 123,
                ownerId: 456,
                defaultBranch: 'main',
              }),
            isWorkflowOnDefaultBranch: () => Promise.resolve(false),
            mintRepositoryToken: () => {
              minted = true;
              return Promise.resolve('must-not-escape');
            },
          }),
      }),
    );
    strictEqual(response.status, 403);
    strictEqual(minted, false);
    strictEqual((await response.json()).code, 'workflow_not_on_default_branch');
  },
);

Deno.test(
  'exchange reports missing App only when installation lookup fails',
  async () => {
    const { GitHubApiError } = await import('./githubApp.ts');
    const response = await handleExchangeRequest(
      request(),
      dependencies({
        createAppClient: () =>
          Promise.reject(new GitHubApiError(404, 'Not Found')),
      }),
    );
    strictEqual(response.status, 403);
    strictEqual(
      (await response.json()).error,
      'TeXRA GitHub App is not installed on this repository',
    );
  },
);
