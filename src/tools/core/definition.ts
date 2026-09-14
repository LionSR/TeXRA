// Type imports
import type { ToolHost } from '@agent/core/tools/ToolTypes';
import type { ToolDefinition, ToolResult } from '@shared/schemas';

// Local file imports
import { BaseTool } from './base';

// Third-party type imports
import type { Effect } from 'effect';
import type { ZodType } from 'zod';

const EXECUTION_FLAGS = ['parallelSafe', 'requiresApproval', 'slow'] as const;

type ExecutionFlag = (typeof EXECUTION_FLAGS)[number];
type DefineToolFlags = { [K in ExecutionFlag]?: boolean };
type DefinedToolFlags = {
  readonly [K in ExecutionFlag]: boolean | undefined;
};
/**
 * Written as an anonymous object type, not an `interface`: `defineTool` now
 * returns the tool class rather than being subclassed, so this shape lands
 * in the emitted type of every tool the SDK writes a `.d.ts` for. A named
 * interface would have to be exported to be referenced there (TS4058); an
 * anonymous type is inlined and needs no name.
 */
type DefinedToolHosts = {
  readonly unavailableHosts: readonly ToolHost[] | undefined;
};

/**
 * The abstract class `defineTool` hands back when the definition carries no
 * `execute`: a `BaseTool<T>` with the declared execution flags, constructible
 * only through a subclass that implements `execute`.
 *
 * Spelling this out is what keeps `defineTool`'s return type *nameable*.
 * Without it the return type is an anonymous class expression, and every
 * `class X extends defineTool(...)` becomes undeclarable — TypeScript emits
 * `TS4094: Property 'execute' of exported anonymous class type may not be
 * private or protected` for each one, because a `.d.ts` has no syntax for a
 * protected member on an anonymous class type. Naming the type sidesteps that
 * without widening `BaseTool.execute` to public.
 */
export type DefinedToolClass<T, R = never> = abstract new () => BaseTool<T, R> &
  DefinedToolFlags &
  DefinedToolHosts;

/**
 * The concrete counterpart, returned when the definition supplies `execute`:
 * directly `new`-able, so a tool whose body only forwards to a module-level
 * function needs no subclass at all.
 */
export type ConcreteToolClass<T, R = never> = new () => BaseTool<T, R> &
  DefinedToolFlags &
  DefinedToolHosts;

/** The run body a tool definition may carry inline. */
export type ToolExecute<T, R> = (
  input: T,
) => Effect.Effect<ToolResult, unknown, R>;

export type DefineToolOptions<T, R = never> = {
  name: string;
  /** Static description string or function for lazy evaluation */
  description: string | (() => string);
  schema: ZodType<T, unknown>;
  /** Roster namespace a delegation tool's description is annotated from. */
  availabilityCategory?: ToolDefinition['availabilityCategory'];
  /** Product hosts this tool definition statically excludes itself from. */
  unavailableHosts?: readonly ToolHost[];
  /**
   * The tool's run body. Supply it when the body needs nothing from the
   * instance; omit it to get an abstract class and implement `execute` in a
   * subclass (the shape tools that read `this` still need).
   */
  execute?: ToolExecute<T, R>;
} & DefineToolFlags;

/**
 * Define a tool with type-safe schema and either a static or dynamic description.
 *
 * Use a function for description when the content depends on data that's loaded
 * asynchronously (e.g., agent registry) - the function is called lazily when
 * the tool definition is accessed.
 */
export function defineTool<T, R = never>(
  def: DefineToolOptions<T, R> & { execute: ToolExecute<T, R> },
): ConcreteToolClass<T, R>;
export function defineTool<T, R = never>(
  def: DefineToolOptions<T, R>,
): DefinedToolClass<T, R>;
export function defineTool<T, R = never>(
  def: DefineToolOptions<T, R>,
): DefinedToolClass<T, R> {
  const getDescription = (): string =>
    typeof def.description === 'function' ? def.description() : def.description;

  abstract class GeneratedTool extends BaseTool<T, R> {
    // The return annotation checks these fields against EXECUTION_FLAGS.
    readonly parallelSafe = def.parallelSafe;
    readonly requiresApproval = def.requiresApproval;
    readonly slow = def.slow;
    readonly unavailableHosts = def.unavailableHosts;

    constructor() {
      super(
        {
          name: def.name,
          description: getDescription(),
          // The Zod schema is the tool's only parameter representation; the
          // provider converters derive JSON Schema from it per request.
          zodSchema: def.schema,
          ...(def.availabilityCategory && {
            availabilityCategory: def.availabilityCategory,
          }),
        },
        def.schema,
      );
    }
  }

  const run = def.execute;
  if (!run) return GeneratedTool;

  return class DefinedTool extends GeneratedTool {
    protected execute(input: T): Effect.Effect<ToolResult, unknown, R> {
      return run(input);
    }
  };
}
