/**
 * Shared request handling for the usage-logging edge functions: records API
 * usage for analytics.
 *
 * Receives batched usage entries from the TeXRA clients. Each function
 * supplies an owner resolver (`log-usage`: login JWT, released clients;
 * `log-usage-v2`: anonymous install id) and a store that writes the batch.
 *
 * Response contract:
 * - Complete writes return success with the exact accepted entry count.
 * - Invalid batches are rejected atomically over HTTP 200 with
 *   `success: false`, `accepted: 0`, `retryable: false`, and a stable
 *   `errorCode`; HTTP 200 lets clients predating the retry marker read the
 *   body during rolling deploys. Sanitized validation issues identify the
 *   rejected fields without echoing request values.
 *   Restore HTTP 422 after clients predating #8267 age out under #6981.
 * - Malformed JSON uses the same permanent-rejection body with HTTP 400.
 * - Authentication and operational failures omit the permanent-rejection
 *   marker so clients retain and retry the original batch identifier.
 */

import { handleCors } from './cors.ts';
import { adminClient, SUPABASE_ANON_KEY, SUPABASE_URL } from './edgeClients.ts';
import { jsonResponse } from './responses.ts';
import { UsageBatchSchema, type UsageBatch } from './usageValidation.ts';

const MAX_REPORTED_VALIDATION_ISSUES = 20;

function successResponse(
  req: Request,
  accepted: number,
  message?: string,
): Response {
  return jsonResponse(
    req,
    {
      success: true,
      accepted,
      ...(message ? { message } : {}),
    },
    200,
  );
}

function errorResponse(
  req: Request,
  error: string,
  status: number,
  // Absent details stay absent in the body: JSON.stringify drops undefined values.
  details?: {
    retryable?: boolean;
    errorCode?: string;
    issues?: readonly {
      code: string;
      path: readonly string[];
      message: string;
    }[];
    issueCount?: number;
  },
): Response {
  return jsonResponse(
    req,
    { success: false, accepted: 0, error, ...details },
    status,
  );
}

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !adminClient) {
  console.error('[LOG_USAGE] Missing required environment variables');
}

/**
 * Serve usage logging. `resolveOwner` yields the batch owner (null = 401);
 * `store` writes the batch and returns false when it was already stored (a
 * client retry), and throws on failure.
 */
export function serveLogUsage<Owner>(
  resolveOwner: (req: Request) => Promise<Owner | null>,
  store: (owner: Owner, batch: UsageBatch) => Promise<boolean>,
): void {
  Deno.serve(async (req: Request) => {
    const response = handleCors(req);
    if (response) return response;

    if (req.method !== 'POST') {
      return errorResponse(req, 'Method not allowed', 405);
    }

    // Module-level init only logs, so requests must get an explicit 500 here
    // rather than crashing on a null dereference deeper in the store.
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !adminClient) {
      return errorResponse(req, 'Server configuration error', 500);
    }

    try {
      const owner = await resolveOwner(req);
      if (!owner) {
        return errorResponse(req, 'Missing or invalid credential', 401);
      }

      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return errorResponse(req, 'Invalid JSON body', 400, {
          retryable: false,
          errorCode: 'INVALID_JSON',
        });
      }

      // Validate the complete batch before any write.
      const batchResult = UsageBatchSchema.safeParse(body);
      if (!batchResult.success) {
        // Keep the application-level rejection on HTTP 200 during the rolling
        // client transition. Older clients let ky throw before reading 4xx
        // bodies, which would pin this permanently invalid batch at the head
        // of their retry queue. They already understand success:false on 2xx.
        // This status can return to 422 under the #6981 retirement gate once
        // the minimum supported client includes #8267.
        return errorResponse(req, 'Invalid batch format or entry data', 200, {
          retryable: false,
          errorCode: 'BATCH_REJECTED',
          issueCount: batchResult.error.issues.length,
          issues: batchResult.error.issues
            .slice(0, MAX_REPORTED_VALIDATION_ISSUES)
            .map((issue) => ({
              code: issue.code,
              path: issue.path.map((part) => String(part)),
              message: issue.message,
            })),
        });
      }
      const batch = batchResult.data;

      const stored = await store(owner, batch);
      return successResponse(
        req,
        batch.entries.length,
        stored ? undefined : 'Batch already processed (deduplicated)',
      );
    } catch (error) {
      console.error('[LOG_USAGE] Unexpected error:', error);
      return errorResponse(req, 'Internal server error', 500);
    }
  });
}
