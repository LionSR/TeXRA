/**
 * Loogle tool for searching Lean/Mathlib theorems by type signature.
 *
 * Uses the Loogle API at https://loogle.lean-lang.org/
 */

import axios from 'axios';
import { z } from 'zod';

import { toErrorMessage } from '@common/errors';
import { ToolResult } from '@tools/result';
import { defineTool } from '@tools/core/define';

// ============================================================================
// Schema
// ============================================================================

const LeanLoogleInputSchema = z.strictObject({
  /** Search query - can be a type signature like "Nat → Nat → Nat" or name pattern */
  query: z.string().describe('Search query (type signature or name pattern)'),
  /** Maximum number of results to return */
  limit: z.number().int().min(1).max(20).prefault(10).describe('Max results (default: 10)'),
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

interface LoogleErrorResponse {
  error: string;
  suggestions?: string[];
}

type LoogleResponse = LoogleHit[] | LoogleErrorResponse;

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

Loogle lets you find theorems by describing what type they should have.

Example queries:
- "Nat → Nat → Nat" - functions taking two Nats and returning Nat
- "List.map" - search by name
- "_ + _ = _ + _" - commutativity-like theorems
- "Real → Real" with "continuous" - continuous functions on reals
- "∀ n, n + 0 = n" - specific theorem patterns

Returns matching theorems with:
- name: Fully qualified name (e.g., Nat.add_comm)
- type: Type signature
- module: Source module for imports
- doc: Documentation if available

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
        timeout: 10000,
      });

      const data = response.data;

      // Check for error response
      if ('error' in data) {
        const errorResponse = data as LoogleErrorResponse;
        let output = `Error: ${errorResponse.error}`;
        if (errorResponse.suggestions && errorResponse.suggestions.length > 0) {
          output += `\n\nSuggestions:\n${errorResponse.suggestions.map((s) => `  - ${s}`).join('\n')}`;
        }
        return {
          summary: 'No results',
          output,
          isError: true,
        };
      }

      // Handle successful results
      const hits = (data as LoogleHit[]).slice(0, limit);

      if (hits.length === 0) {
        return {
          summary: 'No results',
          output: `No theorems found matching: ${query}\n\nTry a different type signature or name pattern.`,
        };
      }

      const formatted = hits
        .map((hit, i) => {
          let entry = `${i + 1}. **${hit.name}**\n   Type: \`${hit.type}\`\n   Module: ${hit.module}`;
          if (hit.doc) {
            // Truncate long docs
            const doc = hit.doc.length > 200 ? hit.doc.slice(0, 200) + '...' : hit.doc;
            entry += `\n   Doc: ${doc}`;
          }
          return entry;
        })
        .join('\n\n');

      return {
        summary: `${hits.length} result${hits.length > 1 ? 's' : ''}`,
        output: formatted,
        results: hits,
      };
    } catch (error) {
      return {
        summary: 'Loogle search failed',
        output: `Error: ${toErrorMessage(error)}`,
        isError: true,
      };
    }
  }
}
