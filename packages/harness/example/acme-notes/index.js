// A native plugin as a package outside the harness ships it: JavaScript over
// the harness's public entries, with its declarations in `index.d.ts`. Node
// strips no types inside node_modules, so the package ships JavaScript.
import { Effect, Schema } from 'effect';
import { definePlugin, defineTool } from '@texra-ai/harness/plugins';

export const PLUGIN_ID = 'acme-notes';

/** The value of a `note` fact, at version 1. */
export const NoteSchema = Schema.Struct({ text: Schema.String });

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
    // `add` for a script that imports the module; the default export is the
    // program below, which keeps each of `args.notes` in turn.
    notes: `export const add = (text) => tools.note_add({ text });
export default async ({ notes }) => {
  const kept = [];
  for (const text of notes) kept.push(await add(text));
  return kept;
};`,
  },
  // The module above, started by name: by a model's `program('notes', …)`
  // from a script. Its run is offered `note_add` alone.
  programs: {
    notes: {
      description:
        'Keep notes on the draft. args: { notes: string[] }, each kept in turn; returns the kept notes.',
      tools: ['note_add'],
    },
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
