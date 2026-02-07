/**
 * Loogle tool for searching Lean/Mathlib theorems by type signature.
 *
 * Uses the Loogle API at https://loogle.lean-lang.org/
 */

import axios from 'axios';
import { z } from 'zod';

import { toErrorMessage } from '@common/errors';
import { ToolResult } from '@tools/result';
import { LOOGLE_TIMEOUT_MS, buildTimeoutMessage } from '@tools/timeouts';
import { defineTool } from '@tools/core/define';

// ============================================================================
// Schema
// ============================================================================

const LeanLoogleInputSchema = z.strictObject({
  /** Search query - can be a type signature like "Nat → Nat → Nat" or name pattern */
  query: z.string().describe('Search query (type signature or name pattern)'),
  /** Maximum number of results to return */
  limit: z
    .int()
    .min(1)
    .max(20)
    .prefault(10)
    .describe('Max results (default: 10)'),
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

Returns: name, type signature, module (for imports), and documentation.

Useful for finding the right lemma when you know roughly what type it should have.`,
  schema: LeanLoogleInputSchema,
}) {
  protected async execute(input: LeanLoogleInput): Promise<ToolResult> {
    const { query, limit } = input;

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
          summary: 'No results',
          output: `Error: ${data.error}${suggestionText}`,
          isError: true,
        };
      }

      const hits = data.hits.slice(0, limit);

      if (hits.length === 0) {
        return {
          summary: 'No results',
          output: `No theorems found matching: ${query}\n\nTry a different type signature or name pattern.`,
        };
      }

      const formatted = hits
        .map((hit, i) => formatHit(hit, i + 1))
        .join('\n\n');

      return {
        summary: `${hits.length} result${hits.length > 1 ? 's' : ''}`,
        output: formatted,
        results: hits,
      };
    } catch (error) {
      if (axios.isAxiosError(error) && error.code === 'ECONNABORTED') {
        return {
          summary: 'Loogle search timed out',
          output: buildTimeoutMessage('Loogle API request', LOOGLE_TIMEOUT_MS),
          isError: true,
        };
      }
      return {
        summary: 'Loogle search failed',
        output: `Error: ${toErrorMessage(error)}`,
        isError: true,
      };
    }
  }
}
