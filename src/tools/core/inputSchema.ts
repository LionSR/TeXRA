/**
 * Shapes and field spellings shared by tool input schemas.
 */

// Third-party imports
import { z } from 'zod';

/**
 * An optional tool-input field whose absence resolves to `fallback` before
 * `execute` ever sees it.
 *
 * The wrapping is `.nullish()`, deliberately not `.optional()` and not
 * `.prefault()`. OpenAI-compatible providers (DeepSeek, Kimi, …) represent an
 * omitted optional field as an explicit `null` in structured output, so the
 * field must be nullable as well as optional; `.prefault()` substitutes only
 * for `undefined` and would hand `null` straight through. The `?? fallback`
 * covers both, which is why the resulting field's output type is not nullable
 * and use sites need no `== null` check of their own.
 */
export function nullishWithDefault<Schema extends z.ZodType>(
  schema: Schema,
  fallback: z.output<Schema>,
) {
  return schema.nullish().transform((value) => value ?? fallback);
}

/**
 * One branch of a `command`-discriminated tool input schema: the branch's
 * field shape, or an already-built object when the branch needs a cross-field
 * `.refine()` that only `commandUnion`'s caller can express.
 *
 * The type cannot police looseness on its own. zod's object `Config` is
 * covariant and `$strict` ({ out: {} }) is structurally assignable to
 * `$loose` ({ out: Record<string, unknown> }), so a `strictObject` satisfies
 * any loose-looking bound. `commandUnion` re-opens every pre-built branch
 * with `.loose()` instead of trusting it, which is why this accepts any
 * object config.
 */
type CommandBranch =
  z.ZodRawShape | z.ZodObject<z.ZodRawShape, z.core.$ZodObjectConfig>;

type CommandBranchSchema<Branch> =
  Branch extends z.ZodObject<
    infer Shape extends z.ZodRawShape,
    z.core.$ZodObjectConfig
  >
    ? z.ZodObject<Shape, z.core.$loose>
    : Branch extends z.ZodRawShape
      ? z.ZodObject<Branch, z.core.$loose>
      : never;

/**
 * A tool input schema discriminated on `command`, one object branch per
 * command.
 *
 * Branches are `looseObject` (not `strictObject`): provider conversion
 * flattens the union into one advertised object and OpenAI-compatible
 * providers null-fill the properties belonging to the other commands. A
 * `strictObject` branch would advertise `additionalProperties: false` and
 * break that, so a pre-built branch is re-opened with `.loose()` rather than
 * assumed loose; `.loose()` carries the branch's checks, so a `.refine()`
 * survives it. See AGENTS.md "Tool input schemas".
 */
export function commandUnion<
  Branches extends readonly [CommandBranch, ...CommandBranch[]],
>(branches: Branches) {
  return z.discriminatedUnion(
    'command',
    branches.map((branch) =>
      branch instanceof z.ZodObject ? branch.loose() : z.looseObject(branch),
    ) as { -readonly [K in keyof Branches]: CommandBranchSchema<Branches[K]> },
  );
}
