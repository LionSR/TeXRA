/**
 * Input schema for the memory tool: one command per branch of a union, and
 * the directory-listing pagination window its descriptions quote.
 */

// Third-party imports
import { Schema } from 'effect';

// Local imports
import { MEMORY_DISPLAY_ROOT } from '@tools/memory/memoryUtils';

// Local file imports
import { nullishWithDefault } from '../core/inputSchema';
import { ViewRangeSchema } from '../formatting';

const MEMORY_PATH_DESCRIPTION = `Path under ${MEMORY_DISPLAY_ROOT} (e.g. ${MEMORY_DISPLAY_ROOT}/notes.md).`;

// The directory-listing pagination window, stated once: the schema defaults,
// the advertised descriptions and the tool description all read these.
/** The entry a listing starts at when the call names no `offset`. */
export const LISTING_DEFAULT_OFFSET = 0;
/** How many entries a listing returns when the call names no `limit`. */
export const LISTING_DEFAULT_LIMIT = 100;
const LISTING_MAX_LIMIT = 200;

const PathFieldSchema = Schema.String.annotate({
  description: MEMORY_PATH_DESCRIPTION,
});

/** The memory tool's input: one struct per command, told apart by `command`. */
export const MemoryToolInputSchema = Schema.Union([
  Schema.Struct({
    command: Schema.Literal('view'),
    path: Schema.optional(Schema.NullOr(Schema.String)).annotate({
      description: `${MEMORY_PATH_DESCRIPTION} Defaults to the ${MEMORY_DISPLAY_ROOT} root directory listing when omitted.`,
    }),
    view_range: Schema.optional(Schema.NullOr(ViewRangeSchema)),
    /** Zero-based offset for paginating directory listings (path points to a directory). */
    offset: nullishWithDefault(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      LISTING_DEFAULT_OFFSET,
      `Zero-based offset into the directory listing. Use with limit for pagination. Default: ${LISTING_DEFAULT_OFFSET}.`,
    ),
    /** Maximum entries to return from a directory listing (path points to a directory). */
    limit: nullishWithDefault(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
        Schema.isLessThanOrEqualTo(LISTING_MAX_LIMIT),
      ),
      LISTING_DEFAULT_LIMIT,
      `Max entries to return from directory listing. Default: ${LISTING_DEFAULT_LIMIT}, max: ${LISTING_MAX_LIMIT}.`,
    ),
  }),
  Schema.Struct({
    command: Schema.Literal('create'),
    path: PathFieldSchema,
    file_text: Schema.String,
  }),
  Schema.Struct({
    command: Schema.Literal('str_replace'),
    path: PathFieldSchema,
    old_str: Schema.String,
    new_str: Schema.String,
  }),
  // The branch carries a cross-field check: one of the two text fields.
  Schema.Struct({
    command: Schema.Literal('insert'),
    path: PathFieldSchema,
    insert_line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    insert_text: Schema.optional(Schema.NullOr(Schema.String)).annotate({
      description: 'Text to insert. Aliased by `new_str` if omitted.',
    }),
    new_str: Schema.optional(Schema.NullOr(Schema.String)),
  }).check(
    Schema.makeFilter(
      (data) =>
        data.insert_text != null ||
        data.new_str != null || {
          path: ['insert_text'],
          issue: 'insert_text is required for command="insert".',
        },
    ),
  ),
  Schema.Struct({
    command: Schema.Literal('delete'),
    path: PathFieldSchema,
  }),
  Schema.Struct({
    command: Schema.Literal('rename'),
    old_path: PathFieldSchema,
    new_path: PathFieldSchema,
  }),
  Schema.Struct({
    command: Schema.Literal('pin'),
    path: PathFieldSchema,
  }),
  Schema.Struct({
    command: Schema.Literal('unpin'),
    path: PathFieldSchema,
  }),
]);

/** One decoded memory tool call. */
export type MemoryToolInput = typeof MemoryToolInputSchema.Type;
