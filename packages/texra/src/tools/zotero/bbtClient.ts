/**
 * Client for the local Zotero server used by every Zotero tool.
 *
 * Two endpoints share one host and port: the Better BibTeX JSON-RPC API at
 * http://localhost:23119/better-bibtex/json-rpc (search, export, collections)
 * and the Zotero Connector API at http://localhost:23119/connector/* (adding
 * items). Both live here so the base URL and the "Zotero is not reachable"
 * guidance have one definition.
 *
 * See: https://retorque.re/zotero-better-bibtex/exporting/json-rpc/
 * See: https://www.zotero.org/support/dev/client_coding/connector_http_server
 */

// Third-party imports
import { Cause, Effect, Predicate, Result, Schema, SchemaGetter } from 'effect';
import { HttpBody, HttpClientError } from 'effect/http';
import { StatusCodes } from 'http-status-codes';

// Local imports
import { ToolContext } from '@texra-ai/harness/plugins';
import {
  isTransportReason,
  scopedClient,
  scopedOkClient,
  withRequestTimeout,
  ToolError,
  Settings,
} from '@texra-ai/harness/plugins';
import { ZOTERO_PORT_SETTING } from '@texra/shared/settingsView/texraSettings';

const ZOTERO_BBT_TIMEOUT_MS = 10_000; // 10 s
const ZOTERO_PING_TIMEOUT_MS = 2_000; // 2 s
const ZOTERO_CONNECTOR_TIMEOUT_MS = 30_000; // 30 s

/** The port the calling tool's project configures: one port for both the
 *  Connector API and the Better BibTeX JSON-RPC (different paths). The
 *  transports below read it from the calling tool's project; the
 *  availability probe from its inputs. */
const zoteroPort = Effect.flatMap(ToolContext, (call) =>
  Settings.get(call.env.roots, ZOTERO_PORT_SETTING),
);

/** The URL of `pathname` on the local Zotero at `port`. */
export function zoteroUrl(port: number, pathname: string): string {
  return `http://127.0.0.1:${port}${pathname}`;
}

function zoteroUnreachableError(port: number): ToolError {
  return new ToolError(
    `Zotero is not reachable on port ${port}. ` +
      `Ask the user to start Zotero or verify the port (setting: texra.bib.zoteroPort).`,
  );
}

// ============================================================================
// Response schemas — Better BibTeX is an external network boundary, so its
// JSON-RPC envelope and result shapes are the single source of truth here (the
// types are derived from the schemas) and validated once in callBetterBibTeX.
// The result schemas assert only the fields consumers read; a struct ignores
// any extra fields the API adds (it tolerates them rather than rejecting).
// Optional fields are `Schema.optional(Schema.NullOr(...))` because the
// CSL-JSON BBT emits may send an explicit null as well as omit a field —
// `Schema.optional` alone would reject null. Consumers already guard every
// such field with truthiness / optional chaining.
// ============================================================================

/** JSON-RPC error object. */
const JsonRpcErrorSchema = Schema.Struct({
  code: Schema.Number,
  message: Schema.String,
});

/**
 * CSL JSON name/creator format.
 * See: https://citeproc-js.readthedocs.io/en/latest/csl-json/markup.html
 *
 * From BBT source: Zotero.Utilities.Item.itemToCSLJSON(item)
 */
const CslCreatorSchema = Schema.Struct({
  /** Family name (surname) in CSL format */
  family: Schema.optional(Schema.NullOr(Schema.String)),
  /** Given name (first name) in CSL format */
  given: Schema.optional(Schema.NullOr(Schema.String)),
  // Zotero native format (may appear in some responses)
  lastName: Schema.optional(Schema.NullOr(Schema.String)),
  firstName: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
});

/** CSL JSON date format. */
const CslDateSchema = Schema.Struct({
  /** Date parts as [[year, month?, day?]] */
  'date-parts': Schema.optional(
    Schema.NullOr(Schema.Array(Schema.Array(Schema.Number))),
  ),
});

/** Zotero collection metadata returned by `user.groups(true)`. */
const BbtCollectionSchema = Schema.Struct({
  key: Schema.String,
  name: Schema.String,
  parentCollection: Schema.optional(
    Schema.NullOr(Schema.Union([Schema.String, Schema.Literal(false)])),
  ),
});
export type BbtCollection = typeof BbtCollectionSchema.Type;

/** Library (group) entry returned by `user.groups`. */
export const BbtLibrarySchema = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  collections: Schema.optional(
    Schema.NullOr(Schema.Array(BbtCollectionSchema)),
  ),
});

/**
 * Collection with nested parent chain, returned by `item.collections(citekeys, true)`.
 * When `includeParents` is true, `parentCollection` is recursively expanded
 * into a full object instead of a key string.
 *
 * The type is self-referential, so the interface is kept and the recursive
 * schema is annotated against it (`Schema.suspend`).
 */
export interface BbtCollectionChain {
  key: string;
  name: string;
  parentCollection?: BbtCollectionChain | false;
}
export const BbtCollectionChainSchema: Schema.Codec<BbtCollectionChain> =
  Schema.suspend(() =>
    Schema.Struct({
      key: Schema.String,
      name: Schema.String,
      parentCollection: Schema.optional(
        Schema.Union([BbtCollectionChainSchema, Schema.Literal(false)]),
      ),
    }),
  );

/** A creator's display name, from whichever name fields the reply set. */
const creatorName = (creator: typeof CslCreatorSchema.Type): string => {
  if (creator.family)
    return creator.given
      ? `${creator.family}, ${creator.given}`
      : creator.family;
  if (creator.lastName)
    return creator.firstName
      ? `${creator.lastName}, ${creator.firstName}`
      : creator.lastName;
  return creator.name ?? '';
};

/**
 * An item Better BibTeX's item.search returned, parsed once into the one
 * shape the search tool reads.
 *
 * The reply is CSL JSON (from Zotero.Utilities.Item.itemToCSLJSON) plus the
 * BBT-specific `citekey`, narrowed to the fields the search tool reads per the
 * boundary rule above; Zotero-native fields (`creators`, `itemType`, `date`,
 * `lastName`/`firstName`) may appear instead, so which field answers is
 * decided here and nowhere downstream. Reference:
 * https://github.com/retorquere/zotero-better-bibtex/blob/master/content/json-rpc.ts
 */
export const BbtSearchResultItemSchema = Schema.Struct({
  /** Citation key from Better BibTeX KeyManager */
  citekey: Schema.String,
  /** CSL item type (article-journal, book, chapter, etc.) */
  type: Schema.optional(Schema.NullOr(Schema.String)),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(Schema.Array(CslCreatorSchema))),
  /** Publication/issue date */
  issued: Schema.optional(Schema.NullOr(CslDateSchema)),
  itemType: Schema.optional(Schema.NullOr(Schema.String)),
  creators: Schema.optional(Schema.NullOr(Schema.Array(CslCreatorSchema))),
  date: Schema.optional(Schema.NullOr(Schema.String)),
}).pipe(
  Schema.decodeTo(
    Schema.Struct({
      citekey: Schema.String,
      title: Schema.NullOr(Schema.String),
      creators: Schema.Array(Schema.String),
      year: Schema.NullOr(Schema.String),
      type: Schema.NullOr(Schema.String),
    }),
    {
      decode: SchemaGetter.transform((item) => {
        const year = item.issued?.['date-parts']?.[0]?.[0];
        return {
          citekey: item.citekey,
          title: item.title || null,
          creators: (item.author || item.creators || [])
            .map(creatorName)
            .filter(Boolean),
          year: year === undefined ? item.date || null : String(year),
          type: item.type || item.itemType || null,
        };
      }),
      // A reply from Zotero is read one way; nothing encodes an item back.
      encode: SchemaGetter.forbidden(() => 'decode-only'),
    },
  ),
);
export type BbtSearchResultItem = typeof BbtSearchResultItemSchema.Type;

/**
 * The `ToolError` for a request to the local Zotero server (either endpoint)
 * that produced no usable response: the deadline, a refused connection or
 * any other transport failure.
 */
function zoteroRequestFailure(
  error: Error,
  port: number,
  timeout: number,
): ToolError {
  if (Cause.isTimeoutError(error)) {
    return new ToolError(
      `Zotero request timed out after ${timeout / 1000}s. ` +
        `Retry the request. If it persists, ask the user to check that Zotero is responsive.`,
    );
  }
  // No response from a localhost endpoint is always a connection failure, so
  // the guidance is the reachability one checkZoteroRunning gives.
  if (
    HttpClientError.isHttpClientError(error) &&
    isTransportReason(error.reason)
  ) {
    return zoteroUnreachableError(port);
  }
  return new ToolError(`Zotero request failed: ${error.message}`);
}

/** Better BibTeX answers 404 on its path when the plugin is not installed. */
function isNotFound(error: Error): boolean {
  return (
    HttpClientError.isHttpClientError(error) &&
    error.reason._tag === 'StatusCodeError' &&
    error.reason.response.status === StatusCodes.NOT_FOUND
  );
}

/**
 * Call the Better BibTeX JSON-RPC endpoint.
 *
 * @param method - JSON-RPC method name (e.g., 'item.search', 'item.export')
 * @param params - Method parameters
 * @param resultSchema - schema for the method's `result`, validated at the boundary
 * @param timeout - Request timeout in milliseconds
 * @returns The validated result; fails with a ToolError if Zotero is not
 *   running, BBT is not installed, or the response is malformed
 */
export const callBetterBibTeX = Effect.fn('bbtClient.callBetterBibTeX')(
  function* <T>(
    method: string,
    params: unknown[],
    resultSchema: Schema.Codec<T, unknown>,
    timeout: number = ZOTERO_BBT_TIMEOUT_MS,
  ) {
    const port = yield* zoteroPort;
    const url = zoteroUrl(port, '/better-bibtex/json-rpc');

    const raw = yield* withRequestTimeout(
      timeout,
      Effect.gen(function* () {
        const client = yield* scopedOkClient;
        const response = yield* client.post(url, {
          body: HttpBody.jsonUnsafe({ jsonrpc: '2.0', method, params, id: 1 }),
          acceptJson: true,
        });
        return yield* response.json;
      }),
    ).pipe(
      Effect.mapError((error) =>
        isNotFound(error)
          ? new ToolError(
              'Better BibTeX plugin is not installed in Zotero. ' +
                'Ask the user to install it from https://retorque.re/zotero-better-bibtex/',
            )
          : zoteroRequestFailure(error, port, timeout),
      ),
    );

    const responseSchema = Schema.Struct({
      jsonrpc: Schema.String,
      id: Schema.optional(Schema.NullOr(Schema.Number)),
      result: Schema.optional(resultSchema),
      error: Schema.optional(JsonRpcErrorSchema),
    });
    const parsed = Schema.decodeUnknownResult(responseSchema)(raw);
    if (!Result.isSuccess(parsed)) {
      return yield* Effect.fail(
        new ToolError(
          `Better BibTeX returned an unexpected response for ${method}: ${parsed.failure.message}`,
        ),
      );
    }
    if (parsed.success.error) {
      return yield* Effect.fail(
        new ToolError(
          `Better BibTeX API error: ${parsed.success.error.message}`,
        ),
      );
    }
    if (parsed.success.result === undefined) {
      return yield* Effect.fail(
        new ToolError(
          `Better BibTeX returned an empty response for ${method}.`,
        ),
      );
    }
    return parsed.success.result;
  },
);

// ============================================================================
// Zotero Connector API — the endpoints `zotero_add` writes through. Requires
// Zotero desktop to be running; no authentication (purely local).
// ============================================================================

/**
 * Check that Zotero is running by pinging the connector. Fails with a
 * user-friendly ToolError if it is not reachable within the ping deadline.
 */
export const checkZoteroRunning = Effect.fn('bbtClient.checkZoteroRunning')(
  function* () {
    const port = yield* zoteroPort;
    yield* withRequestTimeout(
      ZOTERO_PING_TIMEOUT_MS,
      Effect.flatMap(scopedOkClient, (client) =>
        client.get(zoteroUrl(port, '/connector/ping')),
      ),
    ).pipe(Effect.mapError(() => zoteroUnreachableError(port)));
  },
);

/**
 * Call a Zotero Connector endpoint. Fails with a `ToolError` for a non-OK
 * status (the body's `error` when it names one) and for a request that got
 * no response; `zotero_add` reports either per item.
 *
 * The request is **uninterruptible**: `saveItems`/`saveSnapshot` write to the
 * user's library, so aborting one mid-flight would leave Zotero having
 * possibly stored the item with no way to tell whether it landed. Cancelling
 * the run instead lets this one write finish under its existing deadline.
 *
 * The interrupt is deferred, not absorbed. When the region ends it is
 * delivered as the continuation of the write's completion, and the
 * `Effect.result` in `addItem` captures failures only, so this item's
 * outcome is discarded and `addItems`' `Effect.forEach` stops before the
 * next item. The guarantee is
 * that cancellation alone does not abandon this write — not that its
 * remote outcome is durably known or its result is reported.
 *
 * The deadline is separate and unaffected by the region: `Effect.timeoutOrElse`
 * races the request in a fiber that `raceAllFirst` forks interruptible
 * regardless of the enclosing region (`forkUnsafe(..., uninterruptible: false)`
 * in effect rc.112), so `ZOTERO_CONNECTOR_TIMEOUT_MS` still bounds a wedged
 * Zotero. That cuts both ways: a *timeout* still aborts the write mid-flight,
 * so the torn write this guards against remains possible on the deadline path.
 * That is the deliberate trade — an unbounded write against a wedged Zotero is
 * the worse failure.
 */
export const callZoteroConnector = Effect.fn('bbtClient.callZoteroConnector')(
  function* (endpoint: string, body: object) {
    const port = yield* zoteroPort;
    return yield* withRequestTimeout(
      ZOTERO_CONNECTOR_TIMEOUT_MS,
      Effect.gen(function* () {
        // The request scope stays open through the body read, after the
        // header request has already finished.
        const client = yield* scopedClient;
        const response = yield* client.post(
          zoteroUrl(port, `/connector/${endpoint}`),
          { body: HttpBody.jsonUnsafe(body), acceptJson: true },
        );
        if (
          response.status === StatusCodes.OK ||
          response.status === StatusCodes.CREATED
        ) {
          return undefined;
        }
        // Try to extract a machine-readable error message from the response
        // body; it is read under the same deadline as the headers. Keep this
        // body-only recovery separate so request failures retain their own
        // reachability/timeout classification.
        const data = yield* response.json.pipe(
          // Body is not JSON or is empty; use the generic status message.
          Effect.catch(() => Effect.succeed(undefined)),
        );
        const error = Predicate.hasProperty(data, 'error')
          ? data.error
          : undefined;
        return error
          ? String(error)
          : `Unexpected response status: ${response.status}`;
      }),
    ).pipe(
      Effect.uninterruptible,
      Effect.mapError((error) =>
        zoteroRequestFailure(error, port, ZOTERO_CONNECTOR_TIMEOUT_MS),
      ),
      // Zotero answered, and refused the item.
      Effect.flatMap((rejected) =>
        rejected === undefined
          ? Effect.void
          : Effect.fail(new ToolError(rejected)),
      ),
    );
  },
);
