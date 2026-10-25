// Third-party imports
import arxivClient, {
  all,
  and,
  author as authorQuery,
  title as titleQuery,
  abstract as abstractQuery,
  category as catQuery,
} from 'arxiv-client';
import {
  categories as arxivCategories,
  type Category,
} from 'arxiv-client/dist/defines/categories.js';
import { Clock, Duration, Effect, Schema, Semaphore } from 'effect';

// Local imports
import { defineTool } from '@texra-ai/harness';
import { toErrorMessage } from '@texra-ai/harness/schemas';
import {
  nullishWithDefault,
  executed,
  ToolError,
} from '@texra-ai/harness/plugins';
import { pluralize } from '@texra-ai/harness/transcript';
import { normaliseArxivIdentifier } from '@latex/arxivIdentifier';

/**
 * The categories a search filters by, from the client's own table (the
 * package entry does not re-export it): `archive.SUBJECT`, or the archive
 * alone where it has no subjects (`quant-ph`, `hep-th`). A name outside it
 * matches no paper, so the search would come back empty rather than fail.
 * The client's type also admits a subdivided archive alone (`math`); that is
 * left out, since papers are filed under its subjects.
 */
const ARXIV_CATEGORIES: ReadonlySet<string> = new Set(
  Object.entries(arxivCategories).flatMap(([archive, subjects]) =>
    subjects.length === 1 && subjects[0] === archive
      ? [archive]
      : subjects.map((subject) => `${archive}.${subject}`),
  ),
);

const isArxivCategory = (value: string): value is Category =>
  ARXIV_CATEGORIES.has(value);

/** The failure reads `Expected <this>, got "<the value>"`. */
const ArxivCategorySchema = Schema.Trim.pipe(
  Schema.refine(isArxivCategory, {
    expected:
      'an arXiv category from https://arxiv.org/category_taxonomy, spelled exactly (case matters), such as "math.NT", "cs.AI", "cond-mat.str-el" or "quant-ph"',
  }),
);

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

const SortBySchema = Schema.Literals([
  'relevance',
  'lastUpdatedDate',
  'submittedDate',
]);
const SortOrderSchema = Schema.Literals(['ascending', 'descending']);
const SearchFieldSchema = Schema.Literals([
  'all',
  'author',
  'title',
  'abstract',
]);

const ArxivSearchInputSchema = Schema.Struct({
  query: Schema.String.annotate({
    description: 'Search query terms, title text, or author names.',
  }),
  field: nullishWithDefault(
    SearchFieldSchema,
    'all',
    'Search field: "author" for author names, "title" for paper titles, "abstract" for abstracts, "all" (default) for all fields',
  ),
  categories: Schema.optional(
    Schema.NullOr(Schema.Array(ArxivCategorySchema)),
  ).annotate({
    description:
      'Optional arXiv category filters, exactly as arXiv spells them, such as "math.NT", "cs.AI" or "quant-ph". A paper matches when it is in all of them.',
  }),
  maxResults: nullishWithDefault(
    Schema.Int.check(Schema.isGreaterThan(0)).check(
      Schema.isLessThanOrEqualTo(MAX_RESULTS),
    ),
    DEFAULT_RESULTS,
    'Maximum number of papers to return.',
  ),
  start: nullishWithDefault(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    0,
    'Zero-based result offset for pagination.',
  ),
  sortBy: Schema.optional(Schema.NullOr(SortBySchema)).annotate({
    description: 'arXiv sort field to use.',
  }),
  sortOrder: Schema.optional(Schema.NullOr(SortOrderSchema)).annotate({
    description: 'Sort direction for results.',
  }),
});

type ArxivSearchInput = typeof ArxivSearchInputSchema.Type;

const searchArxiv = Effect.fn('ArxivSearchTool.execute')(function* (
  input: ArxivSearchInput,
) {
  const trimmedQuery = input.query.trim();
  if (!trimmedQuery) {
    return yield* Effect.fail(new ToolError('Search query cannot be empty.'));
  }

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

  // The schema admitted only categories in the client's table.
  const categoryFilters = (input.categories ?? []).map((cat) => catQuery(cat));

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
  lane: 'parallel',
  description:
    'Search arXiv for papers and return basic metadata for each hit. Use field="author" for author name searches.',
  schema: ArxivSearchInputSchema,
  execute: searchArxiv,
});
