/**
 * The settings view's installed-plugin messages: one installed plugin as the
 * Plugins page lists it, and the one action message its buttons send.
 * Installing, enabling (which asks for trust in a host dialog), disabling,
 * updating and removing all run through `@common/plugins`, the same code
 * `texra plugin` runs, over the same install record; `openMcpConfig` opens
 * the user's MCP config file, which the page lists read-only.
 */
// Third-party imports
import { Schema } from 'effect';

import { SkillNameSchema } from '@texra-ai/harness/schemas';
// Local imports - shared contracts
import { SETTINGS_VIEW_COMMANDS } from '@texra/shared/ipc';

/** One installed plugin as the Plugins page lists it. */
export const PluginListItemSchema = Schema.Struct({
  name: SkillNameSchema,
  source: Schema.String,
  commit: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  enabled: Schema.Boolean,
  /** Whether the user trusts it as it is now; enabled and untrusted, it
   *  loads nothing until it is reviewed again. */
  trusted: Schema.Boolean,
  /** Code components TeXRA does not run (LSP servers), which keep it from
   *  being enabled. */
  code: Schema.Array(Schema.String),
  skillCount: Schema.Number,
  commandCount: Schema.Number,
  agentCount: Schema.Number,
  mcpServers: Schema.Array(Schema.String),
  /** Why it cannot be read now, when it cannot. */
  problem: Schema.optional(Schema.String),
});

/** Inbound: one plugin action. `install` asks the host for a source and
 *  `openMcpConfig` opens the MCP config file, neither naming a plugin; every
 *  other action names one. */
export const PluginActionMessageSchema = Schema.Struct({
  command: Schema.Literal(SETTINGS_VIEW_COMMANDS.PLUGIN_ACTION),
  action: Schema.Literals([
    'install',
    'enable',
    'disable',
    'update',
    'remove',
    'openMcpConfig',
  ]),
  name: Schema.optional(SkillNameSchema),
});
export type PluginActionMessage = typeof PluginActionMessageSchema.Type;
