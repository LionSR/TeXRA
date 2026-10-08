/**
 * The entries of the tool catalog (`@tools/liveTools`): each tool with
 * the identity a step records and a call is checked against, and the digests
 * that identity is made of.
 */
// Third-party imports
import { JsonObjectSchema, type TurnRequest } from '@texra-ai/llm';

// Local imports - agent runtime
import type { RuntimeTool as ITool } from '@agent/runtime/ToolServices';
import { convertToolSchema } from '@agent/core/tools/toolSchema';
import type { ToolDefinition } from '@shared/schemas';
import { withoutSchemaDescriptions } from '@tools/schemaIdentity';
import { sha256 } from '@utils/core/idHash';

type ToolDefinitions = NonNullable<TurnRequest['tools']>;

/** The package's uniform tool definitions for the run's resolved tool list. */
export function toolDefinitionsFor(
  definitions: readonly ToolDefinition[],
): ToolDefinitions {
  return definitions.map((definition) => ({
    name: definition.name,
    description: definition.description ?? '',
    parameters: JsonObjectSchema.parse(
      convertToolSchema(definition) ?? { type: 'object', properties: {} },
    ),
  }));
}

/** One tool in the catalog, with the identity a step records. */
export interface ToolEntry {
  readonly tool: ITool;
  /** The contributing plugin's id. */
  readonly plugin: string;
  /** The plugin's revision, which rows record: `builtin` for a built-in
   *  plugin (each tool's digest covers its schema); for a loaded one a
   *  digest of its spec and of its env values' keyed digest, stable across
   *  restarts, changed by an edit, and unreadable back to a value. */
  readonly revision: string;
  /** The tool's identity: sha256 over its name and input schema, every
   *  description left out. A call runs only while its tool still has it. */
  readonly digest: string;
}

/** What a run's hold found: the configuration problems the read found,
 *  each configured plugin by id with why it offers no tools, if so, and the
 *  tools of those that do, which the run's steps offer beside the rest. */
export interface HeldPlugins {
  readonly warnings: readonly string[];
  readonly loaded: ReadonlyMap<string, string | undefined>;
  readonly entries: ReadonlyMap<string, ToolEntry>;
}

/**
 * A tool's identity digest (its name and input schema only, so a reworded
 * description never invalidates a call the model already made) and the
 * digest of its definition as a request carries it.
 */
export const toolDigests = (
  tool: Pick<ITool, 'definition'>,
): { readonly digest: string; readonly shown: string } => {
  const [definition] = toolDefinitionsFor([tool.definition]);
  return {
    digest: sha256({
      name: definition.name,
      parameters: withoutSchemaDescriptions(definition.parameters),
    }),
    shown: sha256(definition),
  };
};

/** A plugin's tools as catalog entries under one revision. */
export const entriesOf = (
  plugin: string,
  tools: ReadonlyMap<string, ITool>,
  loaded?: { readonly revision: string },
): ReadonlyMap<string, ToolEntry> =>
  new Map(
    [...tools].map(([name, tool]) => [
      name,
      {
        tool,
        plugin,
        revision: 'builtin',
        ...loaded,
        digest: toolDigests(tool).digest,
      },
    ]),
  );

/**
 * One catalog of the owners' entries, in order: each owner's tools all or
 * none, so a name another owner already holds refuses the later owner
 * loudly (its warning) and never overwrites the first.
 */
export function mergeEntries(
  owners: readonly (readonly [string, ReadonlyMap<string, ToolEntry>])[],
): {
  readonly entries: ReadonlyMap<string, ToolEntry>;
  readonly warnings: readonly string[];
} {
  const entries = new Map<string, ToolEntry>();
  const warnings: string[] = [];
  for (const [owner, own] of owners) {
    const [taken] = [...own.keys()].flatMap((name) => {
      const holder = entries.get(name);
      return holder === undefined ? [] : [{ name, holder }];
    });
    if (taken === undefined) for (const entry of own) entries.set(...entry);
    else
      warnings.push(
        `${owner} was not loaded: it contributes "${taken.name}", which ${taken.holder.plugin} already contributes.`,
      );
  }
  return { entries, warnings };
}
