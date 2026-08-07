import { throws } from 'node:assert/strict';

import {
  parseRepositoryClaim,
  validateWorkflowIdentity,
  type GitHubActionsClaims,
} from './auth.ts';

const claims: GitHubActionsClaims = {
  repository: 'owner/repo',
  repositoryId: '123',
  repositoryOwnerId: '456',
  workflowRef: 'owner/repo/.github/workflows/texra.yml@refs/heads/main',
  workflowSha: 'abc123',
};
const repository = { id: 123, ownerId: 456 };

Deno.test('parseRepositoryClaim accepts one owner and repository', () => {
  const parsed = parseRepositoryClaim('owner/repo');
  if (parsed.owner !== 'owner' || parsed.repo !== 'repo') {
    throw new Error('repository claim was not parsed');
  }
});

Deno.test('parseRepositoryClaim rejects malformed paths', () => {
  for (const value of ['repo', 'owner/repo/extra', '../repo', 'owner/..']) {
    throws(() => parseRepositoryClaim(value));
  }
});

Deno.test(
  'validateWorkflowIdentity returns the repository workflow path',
  () => {
    const path = validateWorkflowIdentity(claims, repository);
    if (path !== '.github/workflows/texra.yml') {
      throw new Error(`unexpected workflow path: ${path}`);
    }
  },
);

Deno.test(
  'validateWorkflowIdentity accepts pull-request refs for later content validation',
  () => {
    const path = validateWorkflowIdentity(
      {
        ...claims,
        workflowRef:
          'owner/repo/.github/workflows/texra.yml@refs/pull/123/merge',
      },
      repository,
    );
    if (path !== '.github/workflows/texra.yml') {
      throw new Error(`unexpected workflow path: ${path}`);
    }
  },
);

Deno.test(
  'validateWorkflowIdentity rejects a workflow from another repository',
  () => {
    throws(() =>
      validateWorkflowIdentity(
        {
          ...claims,
          workflowRef:
            'attacker/repo/.github/workflows/texra.yml@refs/heads/main',
        },
        repository,
      ),
    );
  },
);

Deno.test('validateWorkflowIdentity verifies immutable identities', () => {
  throws(() =>
    validateWorkflowIdentity({ ...claims, repositoryId: '999' }, repository),
  );
  throws(() =>
    validateWorkflowIdentity(
      { ...claims, repositoryOwnerId: '999' },
      repository,
    ),
  );
});
