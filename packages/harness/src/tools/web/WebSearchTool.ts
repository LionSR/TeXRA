// Third-party imports
import { Effect, Result, Schema } from 'effect';

// Internal imports
import {
  retryTransientFetch,
  scopedOkClient,
  toFetchToolError,
} from '@tools/timeouts';
import { defineTool } from '@tools/core/definition';
import { nullishWithDefault } from '@tools/core/inputSchema';
import { executed } from '@tools/core/result';

const DDG_TIMEOUT_MS = 15_000; // 15 s
const DDG_RETRIES = 2;

const WebSearchInputSchema = Schema.Struct({
  query: Schema.String.annotate({
    description: 'Search query to send to the web search provider.',
  }),
  max_results: nullishWithDefault(
    Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1)).check(
      Schema.isLessThanOrEqualTo(5),
    ),
    3,
    'Maximum number of search results to return, up to 5.',
  ),
});

type WebSearchInput = typeof WebSearchInputSchema.Type;

// ============================================================================
// Response schemas (DuckDuckGo is an external network boundary — validate it)
// ============================================================================

/**
 * `RelatedTopics` entries are self-referential (a topic group nests further
 * `Topics`), so the interface is kept and the recursive schema is typed
 * against it (`Schema.suspend`).
 */
interface DuckDuckGoResult {
  readonly Text?: string | null;
  readonly FirstURL?: string | null;
  readonly Topics?: readonly DuckDuckGoResult[] | null;
}

const DuckDuckGoResultSchema: Schema.Codec<DuckDuckGoResult> = Schema.suspend(
  () =>
    Schema.StructWithRest(
      Schema.Struct({
        Text: Schema.optional(Schema.NullOr(Schema.String)),
        FirstURL: Schema.optional(Schema.NullOr(Schema.String)),
        Topics: Schema.optional(
          Schema.NullOr(Schema.Array(DuckDuckGoResultSchema)),
        ),
      }),
      [Schema.Record(Schema.String, Schema.Unknown)],
    ),
);

const DuckDuckGoInfoboxContentItemSchema = Schema.StructWithRest(
  Schema.Struct({
    label: Schema.optional(Schema.NullOr(Schema.String)),
    value: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

const DuckDuckGoResponseSchema = Schema.StructWithRest(
  Schema.Struct({
    Abstract: Schema.optional(Schema.NullOr(Schema.String)),
    AbstractText: Schema.optional(Schema.NullOr(Schema.String)),
    AbstractURL: Schema.optional(Schema.NullOr(Schema.String)),
    AbstractSource: Schema.optional(Schema.NullOr(Schema.String)),
    RelatedTopics: Schema.optional(
      Schema.NullOr(Schema.Array(DuckDuckGoResultSchema)),
    ),
    Infobox: Schema.optional(
      Schema.NullOr(
        Schema.StructWithRest(
          Schema.Struct({
            content: Schema.optional(
              Schema.NullOr(Schema.Array(DuckDuckGoInfoboxContentItemSchema)),
            ),
          }),
          [Schema.Record(Schema.String, Schema.Unknown)],
        ),
      ),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

type DuckDuckGoResponse = typeof DuckDuckGoResponseSchema.Type;

/** Query the DuckDuckGo Instant Answers API with transient retries. */
const searchDuckDuckGo = Effect.fn('WebSearchTool.searchDuckDuckGo')(
  (query: string) =>
    retryTransientFetch(
      Effect.gen(function* () {
        const client = yield* scopedOkClient;
        const response = yield* client.get('https://api.duckduckgo.com/', {
          urlParams: {
            q: query,
            format: 'json',
            no_redirect: 1,
            no_html: 1,
          },
          acceptJson: true,
        });
        const raw = yield* response.json;
        // Validate the body at the boundary. A malformed shape is not
        // transient, so it is not retried; the classification below surfaces
        // it as a tool error.
        const parsed = Schema.decodeUnknownResult(DuckDuckGoResponseSchema)(
          raw,
        );
        if (!Result.isSuccess(parsed)) {
          return yield* Effect.fail(
            new Error(
              `Unexpected DuckDuckGo response shape: ${parsed.failure.message}`,
            ),
          );
        }
        return parsed.success;
      }),
      {
        retries: DDG_RETRIES,
        minTimeout: 500,
        timeoutMs: DDG_TIMEOUT_MS,
      },
    ).pipe(
      Effect.mapError((error) =>
        toFetchToolError(error, {
          timeout: `Web search timed out after ${DDG_TIMEOUT_MS / 1000}s. Retry the request.`,
          http: (status) =>
            `Web search failed: HTTP ${status} from DuckDuckGo.`,
          network: (message) => `Web search failed: network error: ${message}`,
          fallback: (message) => `Web search failed: ${message}`,
        }),
      ),
    ),
);

const searchWeb = Effect.fn('WebSearchTool.execute')(function* ({
  query,
  max_results,
}: WebSearchInput) {
  const data: DuckDuckGoResponse = yield* searchDuckDuckGo(query);

  const results: string[] = [];

  // Extract abstract/summary if available (direct answers)
  if (data.AbstractText && data.AbstractURL) {
    const source = data.AbstractSource ? ` [${data.AbstractSource}]` : '';
    results.push(`${data.AbstractText}${source} (${data.AbstractURL})`);
  } else if (data.Abstract && data.AbstractURL) {
    results.push(`${data.Abstract} (${data.AbstractURL})`);
  }

  // Extract from RelatedTopics (including nested Topics)
  function extractTopics(
    topics: readonly DuckDuckGoResult[],
    limit: number,
  ): void {
    for (const item of topics) {
      if (results.length >= limit) break;
      if (item.Text && item.FirstURL) {
        results.push(`${item.Text} (${item.FirstURL})`);
      }
      // Handle nested topic groups
      if (item.Topics) {
        extractTopics(item.Topics, limit);
      }
    }
  }

  if (data.RelatedTopics) {
    extractTopics(data.RelatedTopics, max_results);
  }

  // Extract key facts from Infobox if available
  if (data.Infobox?.content && results.length < max_results) {
    const facts = data.Infobox.content
      .filter((c) => c.label && c.value)
      .slice(0, max_results - results.length)
      .map((c) => `${c.label}: ${c.value}`);
    if (facts.length > 0) {
      results.push(`Key facts: ${facts.join('; ')}`);
    }
  }

  if (results.length === 0) {
    return executed(
      'No results found. Note: This search uses DuckDuckGo Instant Answers API which works best for factual/entity queries. For general web searches, try rephrasing the query or use more specific terms.',
      `Searched: "${query}" (no results)`,
    );
  }
  return executed(
    results.slice(0, max_results).join('\n\n'),
    `Searched: "${query}"`,
  );
});

/** The `web_search` tool: searches the web and returns the results. */
export const WebSearchTool = defineTool({
  name: 'web_search',
  replay: 'safe',
  slow: true,
  lane: 'parallel',
  description:
    'Search the web and return top results from the DuckDuckGo Instant Answers API.',
  schema: WebSearchInputSchema,
  // The owning agent run's cancellation enters here as interruption —
  // without it, a cancelled run would wait out searches (and their
  // retries) that only observe the internal timeout.
  execute: searchWeb,
});
