// A native plugin as a package outside the harness ships it: JavaScript over
// the harness's public entries, its declarations in `index.d.ts`, and its
// agent file under `agents/`. Node strips no types inside node_modules, so
// the package ships JavaScript.
import { fileURLToPath } from 'node:url';

import { Effect, Schema } from 'effect';
import { defineTool } from '@texra-ai/harness';
import { definePlugin } from '@texra-ai/harness/plugins';

export const PLUGIN_ID = 'acme-notes';

/** The value of a `note` fact, at version 1. */
export const NoteSchema = Schema.Struct({ text: Schema.String });

/** The agent files this package ships, for `nodePlatform({ agentsDir })`. */
export const agentsDir = fileURLToPath(new URL('./agents/', import.meta.url));

const noteAdd = defineTool({
  name: 'note_add',
  description: 'Keep a note about the draft.',
  replay: 'safe',
  schema: Schema.Struct({ text: Schema.String }),
  // What a script's call resolves to: the result's `value`, kept in step
  // with it by hand.
  scriptReturns: '{ text: string }',
  execute: ({ text }) =>
    Effect.succeed({
      status: 'executed',
      output: `noted: ${text}`,
      value: { text },
      // The run's latest note: a fact of this plugin's own kind.
      facts: [{ plugin: PLUGIN_ID, kind: 'note', version: 1, value: { text } }],
    }),
});

export const acmeNotes = definePlugin({
  id: PLUGIN_ID,
  tools: [noteAdd],
  scriptModules: {
    notes: 'export const add = (text) => tools.note_add({ text });',
  },
  factKinds: [
    {
      plugin: PLUGIN_ID,
      kind: 'note',
      version: 1,
      schema: NoteSchema,
      fork: 'copy',
    },
  ],
});
