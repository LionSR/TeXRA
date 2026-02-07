/**
 * Loogle tool for searching Lean/Mathlib theorems by type signature.
 *
 * Uses the Loogle API at https://loogle.lean-lang.org/
 */

import axios from 'axios';
import { z } from 'zod';

import { toErrorMessage } from '@common/errors';
import { ToolResult } from '@tools/result';
import { isTimeoutErrorCode, buildTimeoutMessage } from '@tools/timeouts';
import { defineTool } from '@tools/core/define';

const LOOGLE_TIMEOUT_MS = 10_000; // 10 s

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

export type LeanLoogleInput = z.infer<typeof LeanLoogleInputSchema>;

// ============================================================================
// Types
// ============================================================================

interface LoogleHit {
  name: string;
  type: string;
  module: string;
  doc: string;
}

interface LoogleSuccessResponse {
  count: number;
  header: string;
  hits: LoogleHit[];
}

interface LoogleErrorResponse {
  error: string;
  suggestions?: string[];
}

type LoogleResponse = LoogleSuccessResponse | LoogleErrorResponse;

function isErrorResponse(
  response: LoogleResponse,
): response is LoogleErrorResponse {
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
    const truncatedDoc =
      hit.doc.length > MAX_DOC_LENGTH
        ? hit.doc.slice(0, MAX_DOC_LENGTH) + '...'
        : hit.doc;
    lines.push(`   Doc: ${truncatedDoc}`);
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
  description: `Search for Lean 4 / Mathlib theorems and definitions by type signature or name.

Example queries:
- "Real.sin" - find lemmas mentioning a constant
- "List.map" or "\"differ\"" - search by name substring
- "_ * (_ ^ _)" - find lemmas with subexpression pattern
- "(?a -> ?b) -> List ?a -> List ?b" - find List.map by type signature
- "|- tsum _ = _ * tsum _" - search by main conclusion
- "|- _ < _ → tsum _ < tsum _" - search by hypothesis pattern

Supports batched queries: pass an array of strings to search multiple identifiers in one call.
Example: query: ["Matrix.mul_assoc", "Matrix.transpose_mul", "List.map_append"]

Returns: name, type signature, module (for imports), and documentation.

Useful for finding the right lemma when you know roughly what type it should have.`,
  schema: LeanLoogleInputSchema,
}) {
  /**
   * Execute a single Loogle query and return a per-query result.
   */
  private async executeSingle(
    query: string,
    limit: number,
  ): Promise<{ query: string; result: ToolResult }> {
    try {
      const response = await axios.get<LoogleResponse>(LOOGLE_API_URL, {
        params: { q: query },
        headers: {
          'User-Agent': 'TeXRA-VSCode-Extension',
        },
        timeout: LOOGLE_TIMEOUT_MS,
      });

      const data = response.data;

      if (isErrorResponse(data)) {
        const suggestions = data.suggestions ?? [];
        const suggestionText =
          suggestions.length > 0
            ? `\n\nSuggestions:\n${suggestions.map((s) => `  - ${s}`).join('\n')}`
            : '';
        return {
          query,
          result: {
            summary: 'No results',
            output: `Error: ${data.error}${suggestionText}`,
            isError: true,
          },
        };
      }

      const hits = data.hits.slice(0, limit);

      if (hits.length === 0) {
        return {
          query,
          result: {
            summary: 'No results',
            output: `No theorems found matching: ${query}\n\nTry a different type signature or name pattern.`,
          },
        };
      }

      const formatted = hits
        .map((hit, i) => formatHit(hit, i + 1))
        .join('\n\n');

      return {
        query,
        result: {
          summary: `${hits.length} result${hits.length > 1 ? 's' : ''}`,
          output: formatted,
          results: hits,
        },
      };
    } catch (error) {
      if (axios.isAxiosError(error) && isTimeoutErrorCode(error.code)) {
        return {
          query,
          result: {
            summary: 'Timeout',
            output: buildTimeoutMessage(
              'Loogle API request',
              LOOGLE_TIMEOUT_MS,
            ),
            isError: true,
          },
        };
      }
      return {
        query,
        result: {
          summary: 'Loogle search failed',
          output: `Error: ${toErrorMessage(error)}`,
          isError: true,
        },
      };
    }
  }

  protected async execute(input: LeanLoogleInput): Promise<ToolResult> {
    const { query, limit } = input;
    const queries = Array.isArray(query) ? query : [query];

    // Single query: return directly (backward-compatible format)
    if (queries.length === 1) {
      const { result } = await this.executeSingle(queries[0], limit);
      return result;
    }

    // Batched queries: run concurrently and combine results
    const results = await Promise.all(
      queries.map((q) => this.executeSingle(q, limit)),
    );

    const allResults: LoogleHit[] = [];
    const sections: string[] = [];
    let errorCount = 0;

    for (const { query: q, result } of results) {
      sections.push(`## Query: \`${q}\`\n\n${result.output}`);
      if (result.isError) {
        errorCount++;
      }
      if (result.results) {
        allResults.push(...(result.results as LoogleHit[]));
      }
    }

    const totalHits = allResults.length;
    const summary =
      totalHits > 0
        ? `${totalHits} result${totalHits > 1 ? 's' : ''} across ${queries.length} queries`
        : errorCount === queries.length
          ? `All ${queries.length} queries failed`
          : `No results across ${queries.length} queries`;

    return {
      summary,
      output: sections.join('\n\n---\n\n'),
      results: allResults.length > 0 ? allResults : undefined,
      isError: errorCount === queries.length ? true : undefined,
    };
  }
}
