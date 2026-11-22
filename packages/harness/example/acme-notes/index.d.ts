import type { Schema } from 'effect';
import type { Plugin } from '@texra-ai/worldline/plugins';

export declare const PLUGIN_ID: 'acme-notes';
/** The value of a `note` fact, at version 1. */
export declare const NoteSchema: Schema.Struct<{
  readonly text: Schema.String;
}>;
/** The plugin: the `note_add` tool, the `builtIn:notes` script module, the
 *  `notes` program over it and the `note` fact kind. */
export declare const acmeNotes: Plugin;
