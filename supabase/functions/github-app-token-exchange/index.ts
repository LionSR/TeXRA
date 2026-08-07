/**
 * Exchange a GitHub Actions OIDC token for a short-lived TeXRA GitHub App
 * installation token scoped to the calling repository.
 *
 * Deploy with `--no-verify-jwt`: this endpoint verifies GitHub's OIDC token,
 * not a Supabase user JWT.
 */
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/responses.ts';
import {
  parseRepositoryClaim,
  validateWorkflowIdentity,
  verifyGitHubActionsToken,
  type GitHubActionsClaims,
} from './auth.ts';
import {
  createGitHubAppClient,
  GitHubApiError,
  type GitHubAppClient,
} from './githubApp.ts';

/**
 * Callers treat this code as "skip the run", not "fail": it means the workflow
 * requesting the token differs from the copy on the default branch, which is
 * the normal state of a pull request that edits its own workflow file.
 */
const UNTRUSTED_WORKFLOW_CODE = 'workflow_not_on_default_branch';

interface ExchangeDependencies {
  verifyToken(token: string): Promise<GitHubActionsClaims>;
  createAppClient(input: {
    appId: string;
    privateKey: string;
    owner: string;
    repo: string;
  }): Promise<GitHubAppClient>;
  appId: string | undefined;
  privateKey: string | undefined;
}

function productionDependencies(): ExchangeDependencies {
  return {
    verifyToken: verifyGitHubActionsToken,
    createAppClient: createGitHubAppClient,
    appId: Deno.env.get('GITHUB_APP_ID'),
    privateKey: Deno.env.get('GITHUB_APP_PRIVATE_KEY'),
  };
}

function bearerToken(req: Request): string | null {
  const header = req.headers.get('Authorization');
  return header?.startsWith('Bearer ') ? header.slice(7) : null;
}

export async function handleExchangeRequest(
  req: Request,
  dependencies: ExchangeDependencies = productionDependencies(),
): Promise<Response> {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  if (req.method !== 'POST') {
    return errorResponse(req, 'Method not allowed', 405);
  }
  if (!dependencies.appId || !dependencies.privateKey) {
    console.error(
      '[github-app-token-exchange] GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY is missing',
    );
    return errorResponse(req, 'Server configuration error', 500);
  }

  const token = bearerToken(req);
  if (!token) {
    return errorResponse(req, 'GitHub Actions OIDC token is required', 401);
  }

  let claims: GitHubActionsClaims;
  try {
    claims = await dependencies.verifyToken(token);
  } catch (error) {
    console.warn(
      '[github-app-token-exchange] OIDC verification rejected:',
      error instanceof Error ? error.message : String(error),
    );
    return errorResponse(req, 'Invalid GitHub Actions OIDC token', 401);
  }

  try {
    const { owner, repo } = parseRepositoryClaim(claims.repository);
    const appClient = await dependencies.createAppClient({
      appId: dependencies.appId,
      privateKey: dependencies.privateKey,
      owner,
      repo,
    });
    const repository = await appClient.getRepositoryIdentity();
    const workflowPath = validateWorkflowIdentity(claims, repository);
    const trustedWorkflow = await appClient.isWorkflowOnDefaultBranch(
      workflowPath,
      claims.workflowSha,
    );
    if (!trustedWorkflow) {
      return jsonResponse(
        req,
        {
          error: 'TeXRA workflow must match the repository default branch',
          code: UNTRUSTED_WORKFLOW_CODE,
        },
        403,
      );
    }
    const installationToken = await appClient.mintRepositoryToken();
    return jsonResponse(req, { token: installationToken }, 200);
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) {
      return errorResponse(
        req,
        'TeXRA GitHub App is not installed on this repository',
        403,
      );
    }
    if (
      error instanceof Error &&
      (error.message.startsWith('GitHub OIDC') ||
        error.message.startsWith('TeXRA workflow'))
    ) {
      return errorResponse(req, error.message, 403);
    }
    console.error(
      '[github-app-token-exchange] token mint failed:',
      error instanceof Error ? error.message : String(error),
    );
    return errorResponse(req, 'GitHub App token exchange failed', 502);
  }
}

if (import.meta.main) {
  Deno.serve((req) => handleExchangeRequest(req));
}
