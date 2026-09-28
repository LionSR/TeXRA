/**
 * The entries of the live tool catalog (`@tools/liveTools`): each tool with
 * the identity a step records and a call is checked against, and the digests
 * that identity is made of.
 */
// Node imports
import { createHash } from 'node:crypto';

// Third-party imports
import stableStringify from 'safe-stable-stringify';

// Local imports - agent runtime
import type { RuntimeTool as ITool } from '@agent/runtime/ToolServices';
import { toolDefinitionsFor } from '@agent/runtime/run/tools';
import type { Generation } from '@tools/liveRegistry';
import type { Continuation } from '@tools/toolTable';
import { withoutSchemaDescriptions } from '@tools/schemaIdentity';

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
  /** The loaded server process it dispatches through, by hold key; never
   *  recorded. A pinned generation holds each such process. */
  readonly server?: string;
  /** The tool's identity: sha256 over its name and input schema, every
   *  description left out. A call runs only while its tool still has it. */
  readonly digest: string;
}

export type ToolGeneration = Generation<string, ToolEntry>;

/** A continuation in the catalog, with the plugin that contributes it. */
export interface ContinuationEntry {
  readonly plugin: string;
  readonly continuation: Continuation;
}

/** What a hold found: the configuration problems the read found, and each
 *  configured plugin by id with why it offers no tools, if so. */
export interface HeldPlugins {
  readonly warnings: readonly string[];
  readonly loaded: ReadonlyMap<string, string | undefined>;
}

export const sha256 = (value: unknown): string =>
  createHash('sha256')
    .update(stableStringify(value) ?? '')
    .digest('hex');

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
      name: definition!.name,
      parameters: withoutSchemaDescriptions(definition!.parameters),
    }),
    shown: sha256(definition),
  };
};

/** A plugin's tools as catalog entries under one revision. */
export const entriesOf = (
  plugin: string,
  tools: ReadonlyMap<string, ITool>,
  loaded?: { readonly revision: string; readonly server: string },
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
