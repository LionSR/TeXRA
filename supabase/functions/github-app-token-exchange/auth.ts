import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

const GITHUB_OIDC_AUDIENCE = 'texra-github-action';
const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const GITHUB_OIDC_JWKS = createRemoteJWKSet(
  new URL(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`),
);

export interface GitHubActionsClaims {
  repository: string;
  repositoryId: string;
  repositoryOwnerId: string;
  workflowRef: string;
  workflowSha: string;
}

function requiredStringClaim(payload: JWTPayload, name: string): string {
  const value = payload[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`GitHub OIDC token is missing the ${name} claim`);
  }
  return value;
}

/** Verify a GitHub Actions OIDC token and return the claims used for authorization. */
export async function verifyGitHubActionsToken(
  token: string,
): Promise<GitHubActionsClaims> {
  const { payload } = await jwtVerify(token, GITHUB_OIDC_JWKS, {
    issuer: GITHUB_OIDC_ISSUER,
    audience: GITHUB_OIDC_AUDIENCE,
    algorithms: ['RS256'],
  });

  return {
    repository: requiredStringClaim(payload, 'repository'),
    repositoryId: requiredStringClaim(payload, 'repository_id'),
    repositoryOwnerId: requiredStringClaim(payload, 'repository_owner_id'),
    workflowRef: requiredStringClaim(payload, 'workflow_ref'),
    workflowSha: requiredStringClaim(payload, 'workflow_sha'),
  };
}

/** Split GitHub's canonical `owner/repository` OIDC claim. */
export function parseRepositoryClaim(repository: string): {
  owner: string;
  repo: string;
} {
  const parts = repository.split('/');
  if (
    parts.length !== 2 ||
    parts.some((part) => part.length === 0 || part === '.' || part === '..')
  ) {
    throw new Error('GitHub OIDC token has an invalid repository claim');
  }
  return { owner: parts[0], repo: parts[1] };
}

/**
 * Verify immutable repository identity and return the initiating workflow path.
 * The caller must compare this workflow's blob with the default-branch blob.
 */
export function validateWorkflowIdentity(
  claims: GitHubActionsClaims,
  repository: {
    id: number;
    ownerId: number;
  },
): string {
  if (claims.repositoryId !== String(repository.id)) {
    throw new Error(
      'GitHub OIDC repository identity does not match GitHub API',
    );
  }
  if (claims.repositoryOwnerId !== String(repository.ownerId)) {
    throw new Error('GitHub OIDC owner identity does not match GitHub API');
  }

  const workflowPrefix = `${claims.repository}/.github/workflows/`;
  if (!claims.workflowRef.startsWith(workflowPrefix)) {
    throw new Error('GitHub OIDC workflow does not belong to the repository');
  }

  const workflowAndRef = claims.workflowRef.slice(claims.repository.length + 1);
  const separator = workflowAndRef.lastIndexOf('@');
  const workflowPath = workflowAndRef.slice(0, separator);
  if (
    separator < 0 ||
    !workflowPath.startsWith('.github/workflows/') ||
    workflowPath.includes('@')
  ) {
    throw new Error('GitHub OIDC token has an invalid workflow_ref claim');
  }
  return workflowPath;
}
