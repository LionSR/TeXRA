import { createAppAuth } from '@octokit/auth-app';

const GITHUB_API = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';

interface InstallationResponse {
  id: number;
}

interface RepositoryResponse {
  id: number;
  default_branch: string;
  owner: { id: number };
}

interface ContentResponse {
  type: string;
  sha: string;
}

export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    statusText: string,
  ) {
    super(`GitHub API request failed (${status} ${statusText})`);
  }
}

function githubHeaders(token: string): HeadersInit {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    'User-Agent': 'texra-github-app-token-exchange',
  };
}

async function githubJson<T>(path: string, token: string): Promise<T> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    headers: githubHeaders(token),
  });
  if (!response.ok) {
    throw new GitHubApiError(response.status, response.statusText);
  }
  return (await response.json()) as T;
}

interface GitHubRepositoryIdentity {
  id: number;
  ownerId: number;
  defaultBranch: string;
}

export interface GitHubAppClient {
  getRepositoryIdentity(): Promise<GitHubRepositoryIdentity>;
  isWorkflowOnDefaultBranch(
    path: string,
    workflowSha: string,
  ): Promise<boolean>;
  mintRepositoryToken(): Promise<string>;
}

/**
 * Bind GitHub App authentication to one repository named by the verified OIDC
 * claim. The first installation token is retained server-side and used only to
 * verify immutable repository identity and the default branch.
 */
export async function createGitHubAppClient(input: {
  appId: string;
  privateKey: string;
  owner: string;
  repo: string;
}): Promise<GitHubAppClient> {
  const auth = createAppAuth({
    appId: input.appId,
    privateKey: input.privateKey.replaceAll('\\n', '\n'),
  });
  const appAuthentication = await auth({ type: 'app' });
  const encodedOwner = encodeURIComponent(input.owner);
  const encodedRepo = encodeURIComponent(input.repo);
  const installation = await githubJson<InstallationResponse>(
    `/repos/${encodedOwner}/${encodedRepo}/installation`,
    appAuthentication.token,
  );

  const verificationAuthentication = await auth({
    type: 'installation',
    installationId: installation.id,
  });
  const repository = await githubJson<RepositoryResponse>(
    `/repos/${encodedOwner}/${encodedRepo}`,
    verificationAuthentication.token,
  );
  const repositoryPath = `/repos/${encodedOwner}/${encodedRepo}`;

  return {
    getRepositoryIdentity: () =>
      Promise.resolve({
        id: repository.id,
        ownerId: repository.owner.id,
        defaultBranch: repository.default_branch,
      }),
    isWorkflowOnDefaultBranch: async (path, workflowSha) => {
      const encodedPath = path
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
      try {
        const workflow = await githubJson<ContentResponse>(
          `${repositoryPath}/contents/${encodedPath}?ref=${encodeURIComponent(workflowSha)}`,
          verificationAuthentication.token,
        );
        const defaultWorkflow = await githubJson<ContentResponse>(
          `${repositoryPath}/contents/${encodedPath}?ref=${encodeURIComponent(repository.default_branch)}`,
          verificationAuthentication.token,
        );
        return (
          workflow.type === 'file' &&
          defaultWorkflow.type === 'file' &&
          workflow.sha === defaultWorkflow.sha
        );
      } catch (error) {
        // Missing workflow on either ref means the blob is not trusted yet
        // (new file on a PR, deleted on default, etc.) — same skip as a
        // SHA mismatch. Do not treat this as "App not installed".
        if (error instanceof GitHubApiError && error.status === 404) {
          return false;
        }
        throw error;
      }
    },
    mintRepositoryToken: async () => {
      const authentication = await auth({
        type: 'installation',
        installationId: installation.id,
        repositoryIds: [repository.id],
        permissions: {
          // Review posting and thread mutation only need these; contents
          // write is intentionally not granted on the exchanged token.
          contents: 'read',
          issues: 'write',
          pull_requests: 'write',
        },
      });
      return authentication.token;
    },
  };
}
