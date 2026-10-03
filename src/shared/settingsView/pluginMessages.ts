/**
 * The settings view's installed-plugin messages: one installed plugin as the
 * Plugins page lists it, and the one action message its buttons send.
 * Installing, enabling (which asks for trust in a host dialog), disabling,
 * updating and removing all run through `@common/plugins`, the same code
 * `texra plugin` runs, over the same install record; `openMcpConfig` opens
 * the user's MCP config file, which the page lists read-only.
 */
// Third-party imports
import { z } from 'zod';

// Local imports - shared contracts
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { SkillNameSchema } from '@shared/schemas';

/** One installed plugin as the Plugins page lists it. */
export const PluginListItemSchema = z.object({
  name: SkillNameSchema,
  source: z.string(),
  commit: z.string().optional(),
  version: z.string().optional(),
  enabled: z.boolean(),
  /** Whether the user trusts it as it is now; enabled and untrusted, it
   *  loads nothing until it is reviewed again. */
  trusted: z.boolean(),
  /** Code components TeXRA does not run (LSP servers), which keep it from
   *  being enabled. */
  code: z.array(z.string()),
  skillCount: z.number(),
  commandCount: z.number(),
  agentCount: z.number(),
  mcpServers: z.array(z.string()),
  /** Why it cannot be read now, when it cannot. */
  problem: z.string().optional(),
});

/** Inbound: one plugin action. `install` asks the host for a source and
 *  `openMcpConfig` opens the MCP config file, neither naming a plugin; every
 *  other action names one. */
export const PluginActionMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.PLUGIN_ACTION),
  action: z.enum([
    'install',
    'enable',
    'disable',
    'update',
    'remove',
    'openMcpConfig',
  ]),
  name: SkillNameSchema.optional(),
});
export type PluginActionMessage = z.infer<typeof PluginActionMessageSchema>;
