/**
 * Loogle tool for searching Lean/Mathlib theorems by type signature.
 *
 * Uses the Loogle API at https://loogle.lean-lang.org/
 */

import ky from 'ky';
import { AbortError } from 'p-retry';
import { z } from 'zod';

import { getCurrentToolCallContext } from '@agent/followUp/ToolFileInteractionContext';
import * as logger from '@logger/logUtils';
import { ToolResult } from '@shared/schemas';
import {
  isTimeoutError,
  joinAbortSignal,
  retryTransientFetch,
  unwrapAbortError,
} from '@tools/timeouts';
import { defineTool } from '@tools/core/define';
import { errorResult, executed } from '@tools/core/result';
import { ensureArray } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  formatResultCount,
  truncateWithEllipsis,
} from '@utils/text/stringUtils';

const LOOGLE_TIMEOUT_MS = 10_000; // 10 s
const LOOGLE_CHANNEL = 'lean_loogle';
/** Retry transient Loogle failures (timeouts, 5xx, dropped connections). */
const LOOGLE_RETRIES = 2;

// ============================================================================
// Schema
// ============================================================================

const LeanLoogleInputSchema = z.strictObject({
  /** Search query - single string or array for batched searches */
  query: z
    .union([z.string(), z.array(z.string()).min(1).max(10)])
    .describe(
      'Search query (type signature or name pattern). Pass an array of strings to batch multiple searches in one call.',
    ),
  /** Maximum number of results to return per query */
  limit: z
    .int()
    .min(1)
    .max(20)
    .prefault(10)
    .describe('Max results per query (default: 10)'),
});

type LeanLoogleInput = z.infer<typeof LeanLoogleInputSchema>;

// ============================================================================
// Response schemas (Loogle is an external network boundary — validate it)
// ============================================================================

const LoogleHitSchema = z.looseObject({
  name: z.string(),
  type: z.string(),
  // `.prefault()` only substitutes for `undefined`, not explicit `null` — and
  // Loogle, like the sibling `doc` field below, may send either for `module`.
  module: z
    .string()
    .nullish()
    .transform((value) => value ?? ''),
  // Loogle may omit, null, or empty `doc`; formatHit already guards on truthiness.
  doc: z.string().nullish(),
});
type LoogleHit = z.infer<typeof LoogleHitSchema>;

const LoogleSuccessSchema = z.looseObject({
  count: z.number(),
  header: z.string(),
  hits: z.array(LoogleHitSchema),
});

const LoogleErrorSchema = z.looseObject({
  error: z.string(),
  suggestions: z.array(z.string()).nullish(),
});

// Not a discriminatedUnion: success/error bodies share no tagged key. Try the
// error arm first so an `{ error }` body is never mis-read as an empty success.
const LoogleResponseSchema = z.union([LoogleErrorSchema, LoogleSuccessSchema]);
type LoogleResponse = z.infer<typeof LoogleResponseSchema>;

function isErrorResponse(
  response: LoogleResponse,
): response is z.infer<typeof LoogleErrorSchema> {
  return 'error' in response;
}

const MAX_DOC_LENGTH = 200;

/** Format a single Loogle hit for display. */
function formatHit(hit: LoogleHit, index: number): string {
  const lines = [
    `${index}. **${hit.name}**`,
    `   Type: \`${hit.type}\``,
    `   Module: ${hit.module}`,
  ];

  if (hit.doc) {
    lines.push(`   Doc: ${truncateWithEllipsis(hit.doc, MAX_DOC_LENGTH)}`);
  }

  return lines.join('\n');
}

// ============================================================================
// Tool Implementation
// ============================================================================

const LOOGLE_API_URL = 'https://loogle.lean-lang.org/json';

/**
 * Search for Lean/Mathlib theorems and definitions using Loogle.
 */
export class LeanLoogleTool extends defineTool({
  name: 'lean_loogle',
  parallelSafe: true,
  description: `Search for Lean 4 / Mathlib theorems and definitions by type signature or name.

Example queries:
- "Real.sin" - find lemmas mentioning a constant
- "List.map" or "\"differ\"" - search by name substring
- "_ * (_ ^ _)" - find lemmas with subexpression pattern
- "(?a -> ?b) -> List ?a -> List ?b" - find List.map by type signature
- "|- tsum _ = _ * tsum _" - search by main conclusion
- "|- _ < _ → tsum _ < tsum _" - search by hypothesis pattern

Supports batched queries: pass an array of strings to search multiple identifiers in one call.

Returns: name, type signature, module (for imports), and documentation.

Useful for finding the right lemma when you know roughly what type it should have.`,
  schema: LeanLoogleInputSchema,
}) {
  /**
   * Fetch one Loogle query, retrying transient failures (timeouts, 5xx,
   * 429 rate limits, dropped connections) with jittered backoff. Non-429
   * 4xx responses and non-network errors abort immediately.
   */
  private async fetchLoogle(query: string): Promise<LoogleResponse> {
    // Cancellation for the owning agent run — parallel batches must be able
    // to abort in-flight Loogle requests and their retry backoff.
    const cancelSignal = getCurrentToolCallContext()?.signal;
    return retryTransientFetch(
      async () => {
        const raw = await ky
          .get(LOOGLE_API_URL, {
            searchParams: { q: query },
            headers: { 'User-Agent': 'TeXRA-VSCode-Extension' },
            timeout: false,
            signal: joinAbortSignal(LOOGLE_TIMEOUT_MS, cancelSignal),
            retry: 0,
          })
          .json<unknown>();
        // Validate the body at the boundary. A malformed shape is not transient,
        // so abort retries and let executeSingle surface it as a tool error.
        const parsed = LoogleResponseSchema.safeParse(raw);
        if (!parsed.success) {
          throw new AbortError(
            new Error(
              `Unexpected Loogle response shape: ${z.prettifyError(parsed.error)}`,
            ),
          );
        }
        return parsed.data;
      },
      {
        retries: LOOGLE_RETRIES,
        minTimeout: 1000,
        cancelSignal,
        onFailedAttempt: ({ error, retriesLeft }) => {
          logger.debug(
            LOOGLE_CHANNEL,
            `Loogle query "${query}" failed (${retriesLeft} retries left): ${toErrorMessage(error)}`,
          );
        },
      },
    );
  }

  /**
   * Execute a single Loogle query and return a per-query result.
   * `hits` carries the raw matches for batched-query aggregation; it is
   * intentionally kept off `ToolResult`, which only exposes the rendered text.
   */
  private async executeSingle(
    query: string,
    limit: number,
  ): Promise<{ query: string; result: ToolResult; hits: LoogleHit[] }> {
    try {
      const data = await this.fetchLoogle(query);

      if (isErrorResponse(data)) {
        const suggestions = data.suggestions ?? [];
        const suggestionText =
          suggestions.length > 0
            ? `\n\nSuggestions:\n${suggestions.map((s) => `  - ${s}`).join('\n')}`
            : '';
        return {
          query,
          hits: [],
          result: errorResult(`Error: ${data.error}${suggestionText}`, {
            summary: 'No results',
          }),
        };
      }

      const hits = data.hits.slice(0, limit);

      if (hits.length === 0) {
        return {
          query,
          hits: [],
          result: executed(
            `No theorems found matching: ${query}\n\nTry a different type signature or name pattern.`,
            'No results',
          ),
        };
      }

      const formatted = hits
        .map((hit, i) => formatHit(hit, i + 1))
        .join('\n\n');

      return {
        query,
        hits,
        result: executed(formatted, formatResultCount(hits.length, 'result')),
      };
    } catch (error) {
      // Defensive: ensure the checks below (and the surfaced message) see the
      // real error even if a p-retry AbortError wrapper reaches here (p-retry v8
      // already unwraps it to .originalError, so this is normally a no-op).
      const err = unwrapAbortError(error);
      if (isTimeoutError(err)) {
        return {
          query,
          hits: [],
          result: errorResult(
            `Loogle API request timed out after ${LOOGLE_TIMEOUT_MS / 1000}s. ` +
              `The Loogle server may be overloaded. Retry the request. ` +
              `If it persists, try a simpler type signature or search by name instead.`,
            { summary: 'Timeout' },
          ),
        };
      }
      return {
        query,
        hits: [],
        result: errorResult(`Error: ${toErrorMessage(err)}`, {
          summary: 'Loogle search failed',
        }),
      };
    }
  }

  protected async execute(input: LeanLoogleInput): Promise<ToolResult> {
    const { query, limit } = input;
    const queries = ensureArray(query);

    // Single query: return directly (backward-compatible format)
    if (queries.length === 1) {
      const { result } = await this.executeSingle(queries[0], limit);
      return result;
    }

    // Batched queries: run concurrently and combine results
    const results = await Promise.all(
      queries.map((q) => this.executeSingle(q, limit)),
    );

    const sections = results.map(({ query: q, result }) => {
      const resultText =
        result.status === 'error' ? result.error : (result.output ?? '');
      return `## Query: \`${q}\`\n\n${resultText}`;
    });

    const totalHits = results.reduce((sum, r) => sum + r.hits.length, 0);
    const allFailed = results.every(({ result }) => result.status === 'error');
    let summary: string;
    if (totalHits > 0) {
      summary = `${formatResultCount(totalHits, 'result')} across ${queries.length} queries`;
    } else if (allFailed) {
      summary = `All ${queries.length} queries failed`;
    } else {
      summary = `No results across ${queries.length} queries`;
    }

    const output = sections.join('\n\n---\n\n');
    if (allFailed) {
      return errorResult(output, { summary });
    }

    return executed(output, summary);
  }
}
