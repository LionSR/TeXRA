// Third-party imports
import { Effect } from 'effect';
import ky from 'ky';
import { z } from 'zod';

// Internal imports
import { getCurrentToolCallContext } from '@agent/followUp/ToolFileInteractionContext';
import { effectRuntime } from '@platform/processRuntime';
import { ToolResult } from '@shared/schemas';
import { retryTransientFetch, toFetchToolError } from '@tools/timeouts';
import { defineTool } from '@tools/core/define';
import { nullishWithDefault } from '@tools/core/inputSchema';
import { executed } from '@tools/core/result';

const DDG_TIMEOUT_MS = 15_000; // 15 s
const DDG_RETRIES = 2;

const WebSearchInputSchema = z.strictObject({
  query: z
    .string()
    .describe('Search query to send to the web search provider.'),
  max_results: nullishWithDefault(z.number().min(1).max(5), 3).describe(
    'Maximum number of search results to return, up to 5.',
  ),
});

type WebSearchInput = z.infer<typeof WebSearchInputSchema>;

// ============================================================================
// Response schemas (DuckDuckGo is an external network boundary — validate it)
// ============================================================================

/**
 * `RelatedTopics` entries are self-referential (a topic group nests further
 * `Topics`), so the interface is kept and the recursive schema is annotated
 * against it (z.lazy) — matching the house pattern in
 * `src/tools/zotero/bbtClient.ts` (`BbtCollectionChainSchema`).
 */
interface DuckDuckGoResult {
  Text?: string | null;
  FirstURL?: string | null;
  Topics?: DuckDuckGoResult[] | null;
}

const DuckDuckGoResultSchema: z.ZodType<DuckDuckGoResult> = z.lazy(() =>
  z.looseObject({
    Text: z.string().nullish(),
    FirstURL: z.string().nullish(),
    Topics: z.array(DuckDuckGoResultSchema).nullish(),
  }),
);

const DuckDuckGoInfoboxContentItemSchema = z.looseObject({
  label: z.string().nullish(),
  value: z.string().nullish(),
});

const DuckDuckGoResponseSchema = z.looseObject({
  Abstract: z.string().nullish(),
  AbstractText: z.string().nullish(),
  AbstractURL: z.string().nullish(),
  AbstractSource: z.string().nullish(),
  RelatedTopics: z.array(DuckDuckGoResultSchema).nullish(),
  Infobox: z
    .looseObject({
      content: z.array(DuckDuckGoInfoboxContentItemSchema).nullish(),
    })
    .nullish(),
});

type DuckDuckGoResponse = z.infer<typeof DuckDuckGoResponseSchema>;

/** Query the DuckDuckGo Instant Answers API with transient retries. */
const searchDuckDuckGo = Effect.fn('WebSearchTool.searchDuckDuckGo')(
  (query: string) =>
    retryTransientFetch(
      Effect.gen(function* () {
        const signal = yield* Effect.abortSignal;
        const response = yield* Effect.tryPromise({
          try: () =>
            ky.get('https://api.duckduckgo.com/', {
              searchParams: {
                q: query,
                format: 'json',
                no_redirect: 1,
                no_html: 1,
              },
              timeout: false,
              signal,
              retry: 0,
            }),
          catch: (cause) => cause,
        });
        const raw = yield* Effect.tryPromise({
          try: () => response.json(),
          catch: (cause) => cause,
        });
        // Validate the body at the boundary. A malformed shape is not
        // transient, so it is not retried; the classification below surfaces
        // it as a tool error.
        const parsed = DuckDuckGoResponseSchema.safeParse(raw);
        if (!parsed.success) {
          return yield* Effect.fail(
            new Error(
              `Unexpected DuckDuckGo response shape: ${z.prettifyError(parsed.error)}`,
            ),
          );
        }
        return parsed.data;
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
  function extractTopics(topics: DuckDuckGoResult[], limit: number): void {
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

export class WebSearchTool extends defineTool({
  name: 'web_search',
  slow: true,
  parallelSafe: true,
  description:
    'Search the web and return top results. Uses the native provider search tool when available; falls back to DuckDuckGo Instant Answers API.',
  schema: WebSearchInputSchema,
}) {
  protected execute(input: WebSearchInput): Promise<ToolResult> {
    // The owning agent run's cancellation enters here as interruption —
    // without it, a cancelled run would wait out searches (and their
    // retries) that only observe the internal timeout.
    return effectRuntime().runPromise(searchWeb(input), {
      signal: getCurrentToolCallContext()?.signal,
    });
  }
}
