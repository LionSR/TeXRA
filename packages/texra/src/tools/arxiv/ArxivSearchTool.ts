// Third-party imports
import arxivClient, {
  all,
  and,
  author as authorQuery,
  title as titleQuery,
  abstract as abstractQuery,
  category as catQuery,
} from 'arxiv-client';
import { Clock, Duration, Effect, Semaphore } from 'effect';
import { z } from 'zod';

// Local imports
import { withLogChannel } from '@logger/effectLog';
import { ToolError } from '@shared/schemas';
import { requireNonEmptyString } from '@tools/utils';
import { defineTool } from '@tools/core/define';
import { nullishWithDefault } from '@tools/core/inputSchema';
import { executed } from '@tools/core/result';
import { pluralize } from '@utils/text/stringUtils';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { normaliseArxivIdentifier } from './arxivIdentifier';

type Category = Parameters<typeof catQuery>[0];

const CHANNEL = 'arxiv.search';

const MAX_RESULTS = 50;
const DEFAULT_RESULTS = 10;
/** arXiv API rate limit: approximately 1 request per 3 seconds. */
const RATE_LIMIT_DELAY_MS = 3000;
/** Deadline for one arXiv request (the client sets no timeout of its own). */
const TIMEOUT_MS = 30_000;

/**
 * The arXiv rate limit is a property of the remote API, shared by every call
 * in the process, so its state is module-level: `Effect.provide` builds a
 * layer afresh per tool call, which would give each call a limiter of its
 * own and no limit at all. One permit, so waiters take their slot in arrival
 * order, and an interrupted waiter gives its place back.
 */
const arxivGate = Semaphore.makeUnsafe(1);
let nextRequestAt = 0;
const awaitArxivSlot = Semaphore.withPermit(arxivGate)(
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (now < nextRequestAt) {
      yield* Effect.sleep(Duration.millis(nextRequestAt - now));
    }
    nextRequestAt = (yield* Clock.currentTimeMillis) + RATE_LIMIT_DELAY_MS;
  }),
);

/** One hit as the tool emits it (built from already-typed arxiv-client
 *  entries, not a parse boundary). */
interface ArxivSearchResult {
  id: string | null;
  doi: string | null;
  title: string;
  published: Date | null;
  updated: Date | null;
  authors: string[];
  primaryCategory: string | null;
  abstract: string | null;
  arxivUrl: string | null;
}

/** A fresh client: the default export is a shared, stateful builder. */
function createArxivClient(): typeof arxivClient {
  const ClientCtor = arxivClient.constructor as {
    new (): typeof arxivClient;
  };
  return new ClientCtor();
}

const SortBySchema = z.enum(['relevance', 'lastUpdatedDate', 'submittedDate']);
const SortOrderSchema = z.enum(['ascending', 'descending']);
const SearchFieldSchema = z.enum(['all', 'author', 'title', 'abstract']);

const ArxivSearchInputSchema = z.strictObject({
  query: z
    .string()
    .describe('Search query terms, title text, or author names.'),
  field: nullishWithDefault(SearchFieldSchema, 'all').describe(
    'Search field: "author" for author names, "title" for paper titles, "abstract" for abstracts, "all" (default) for all fields',
  ),
  categories: z
    .array(z.string())
    .nullish()
    .describe('Optional arXiv category filters such as "math.NT" or "cs.AI".'),
  maxResults: nullishWithDefault(
    z.int().positive().max(MAX_RESULTS),
    DEFAULT_RESULTS,
  ).describe('Maximum number of papers to return.'),
  start: nullishWithDefault(z.int().min(0), 0).describe(
    'Zero-based result offset for pagination.',
  ),
  sortBy: SortBySchema.nullish().describe('arXiv sort field to use.'),
  sortOrder: SortOrderSchema.nullish().describe('Sort direction for results.'),
});

type ArxivSearchInput = z.infer<typeof ArxivSearchInputSchema>;

const searchArxiv = Effect.fn('ArxivSearchTool.execute')(function* (
  input: ArxivSearchInput,
) {
  const trimmedQuery = requireNonEmptyString(input.query, 'Search query');

  // Select the query function based on the field parameter
  const fieldQueryFns = {
    author: authorQuery,
    title: titleQuery,
    abstract: abstractQuery,
    all,
  } as const;
  const fieldQueryFn = fieldQueryFns[input.field];

  // Build query using arxiv-client query builder
  const terms = Array.from(
    trimmedQuery.matchAll(/"([^"]+)"|\S+/g),
    (match) => match[1] ?? match[0],
  );

  const termQueries = terms.map((term) => fieldQueryFn(term));
  let query = termQueries.length === 1 ? termQueries[0] : and(...termQueries);

  // Add category filters if provided
  const categoryFilters: ReturnType<typeof catQuery>[] = [];
  for (const cat of input.categories ?? []) {
    const trimmed = cat.trim();
    if (!trimmed) continue;
    // catQuery expects a strict Category union ("cs.AI", "math.CO", ...).
    // User input is unconstrained string — cast to the expected type
    // and rely on the library's runtime validation (recovered below).
    const filter = yield* Effect.try({
      try: () => catQuery(trimmed as Category),
      catch: ensureError,
    }).pipe(
      // Skip invalid categories — log so a silently-dropped filter is
      // traceable rather than mysteriously absent from the query.
      Effect.catch((error) =>
        Effect.logWarning(
          `Ignoring invalid arxiv category filter "${trimmed}"`,
        ).pipe(
          withLogChannel(CHANNEL),
          Effect.annotateLogs({ data: error }),
          Effect.as(null),
        ),
      ),
    );
    if (filter != null) categoryFilters.push(filter);
  }

  if (categoryFilters.length > 0) {
    query = and(query, ...categoryFilters);
  }

  let client = createArxivClient()
    .query(query)
    .start(input.start)
    .maxResults(input.maxResults);

  if (input.sortBy) {
    client = client.sortBy(input.sortBy);
  }

  if (input.sortOrder) {
    client = client.sortOrder(input.sortOrder);
  }

  yield* awaitArxivSlot;
  // The client takes no AbortSignal: an interrupted or timed-out request is
  // abandoned and settles in the background, which is safe for a read.
  const entries = yield* Effect.tryPromise({
    try: () => client.execute(),
    catch: (cause) =>
      new ToolError(`Failed to query arXiv API: ${toErrorMessage(cause)}`, {
        cause,
      }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(TIMEOUT_MS),
      orElse: () =>
        Effect.fail(
          new ToolError(
            `Failed to query arXiv API: timed out after ${TIMEOUT_MS} ms`,
          ),
        ),
    }),
  );

  const results: ArxivSearchResult[] = entries.map((entry) => {
    const rawId = entry.id.split('/abs/')[1];
    const id = rawId ? normaliseArxivIdentifier(rawId) : null;
    return {
      id,
      doi: entry.doi?.id ?? null,
      title: entry.title.trim(),
      published: entry.published ?? null,
      updated: entry.updated ?? null,
      authors: entry.authors.map((author) => author.name),
      primaryCategory: entry.primaryCategory ?? null,
      abstract: entry.summary ?? null,
      arxivUrl: id ? `https://arxiv.org/abs/${id}` : null,
    };
  });

  const payload = {
    query: trimmedQuery,
    field: input.field,
    start: input.start,
    count: results.length,
    totalResults: null, // arxiv-client doesn't expose totalResults
    results,
  };

  const fieldLabel = input.field !== 'all' ? ` (${input.field})` : '';
  return executed(
    JSON.stringify(payload, null, 2),
    `Found: ${results.length} ${pluralize(results.length, 'result')} for "${trimmedQuery}"${fieldLabel}`,
  );
});

export const ArxivSearchTool = defineTool({
  name: 'arxiv_search',
  replay: 'safe',
  parallelSafe: true,
  description:
    'Search arXiv for papers and return basic metadata for each hit. Use field="author" for author name searches.',
  schema: ArxivSearchInputSchema,
  execute: searchArxiv,
});
