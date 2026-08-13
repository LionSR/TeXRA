/**
 * Read and update TeXRA's `texra.*` configuration during onboarding.
 *
 * Two narrow tools: `read_config` (read-only) and `update_config` (writes,
 * gated by a strict per-key allowlist). Together they let the setup
 * assistant teach the user about a setting, show its current value, and
 * change it transparently — without giving an LLM unfettered write access
 * to arbitrary configuration. Anything outside the allowlist must still be
 * edited through the regular host settings surface.
 */

import { z } from 'zod';

import { ToolError, type ToolResult } from '@shared/schemas';

import { executed } from '@tools/core/result';
import { defineTool } from '../core/define';
import { texraScopedConfig } from './platform';

/**
 * Per-key value validators for `update_config`. Read access (`read_config`)
 * is open across all `texra.*` keys, but writes must clear a strict schema
 * so a hallucinated payload cannot, say, set `texra.git.numberOfCommitsToShow`
 * to `"yes please"` or flip a destructive toggle.
 *
 * Each entry pairs a Zod schema with a one-line summary the tool echoes back
 * to the agent (and surfaces in the description) so the assistant can
 * explain the setting before changing it.
 */
const UPDATABLE_KEYS = {
  'texra.bib.defaultPath': {
    schema: z.string().describe('Workspace path to the default .bib file'),
    summary:
      'Default bibliography file used by tools that scan citations (e.g. extract_bib_entries).',
  },
  'texra.bib.zoteroPort': {
    schema: z
      .int()
      .min(1)
      .max(65535)
      .describe('Local port the Zotero Better BibTeX server listens on'),
    summary:
      'Local port for the Zotero Better BibTeX integration. Default 23119.',
  },
  'texra.audio.soxPath': {
    schema: z.string().describe('Absolute path to the sox binary'),
    summary:
      'Path override for the SoX audio tool (used by the audio transcription agent).',
  },
  'texra.latex.tikzInputDirectory': {
    schema: z
      .string()
      .describe('Workspace-relative directory containing TikZ source files'),
    summary:
      'Where the TikZ extraction/compilation flows look for figure source files.',
  },
  'texra.git.numberOfCommitsToShow': {
    schema: z
      .int()
      .min(1)
      .max(1000)
      .describe('How many recent commits to surface in the Git picker'),
    summary:
      'Depth of the recent-commits dropdown surfaced by the Git integration.',
  },
  'texra.maxImageDimension': {
    schema: z
      .int()
      .min(64)
      .max(8192)
      .describe('Maximum pixel dimension for images sent to vision models'),
    summary:
      'Image dimension cap before downscaling. Lower values save tokens; higher values preserve fidelity.',
  },
} satisfies Record<string, { schema: z.ZodType<unknown>; summary: string }>;

type UpdatableKey = keyof typeof UPDATABLE_KEYS;

const UPDATABLE_KEY_LIST = Object.keys(UPDATABLE_KEYS) as UpdatableKey[];

function describeAllowlist(): string {
  return UPDATABLE_KEY_LIST.map(
    (k) => `- \`${k}\`: ${UPDATABLE_KEYS[k].summary}`,
  ).join('\n');
}

const ReadConfigInputSchema = z.strictObject({
  key: z
    .string()
    .min(1)
    .regex(
      /^texra\./,
      'Only TeXRA configuration keys are readable through this tool. Pass a key starting with "texra.".',
    )
    .describe(
      'Configuration key starting with "texra." (e.g. texra.bib.defaultPath).',
    ),
});

type ReadConfigInput = z.infer<typeof ReadConfigInputSchema>;

export class ReadConfigTool extends defineTool({
  name: 'read_config',
  description: `Read the effective value of a TeXRA configuration key.

Accepts any key starting with \`texra.\`. Returns the current resolved value (workspace value if set, else user, else default). Use this when teaching the user what a setting controls: read first, explain, then propose a change with \`update_config\`.`,
  schema: ReadConfigInputSchema,
}) {
  protected async execute(input: ReadConfigInput): Promise<ToolResult> {
    const value = texraScopedConfig.get(input.key);
    const json = JSON.stringify(value, null, 2) ?? 'undefined';
    return executed(`${input.key}:\n${json}`, `Read ${input.key}`);
  }
}

const UpdateConfigInputSchema = z.strictObject({
  key: z
    .enum(UPDATABLE_KEY_LIST as [UpdatableKey, ...UpdatableKey[]])
    .describe(
      `Configuration key to update. Must be on the setup allowlist:\n${describeAllowlist()}`,
    ),
  value: z
    .unknown()
    .describe(
      "New value. Type depends on the key: see the allowlist for each key's expected schema.",
    ),
  target: z
    .enum(['user', 'workspace'])
    .prefault('user')
    .describe(
      '"user" updates the global setting shared across workspaces; "workspace" scopes the change to the current workspace only.',
    ),
});

type UpdateConfigInput = z.infer<typeof UpdateConfigInputSchema>;

export class UpdateConfigTool extends defineTool({
  name: 'update_config',
  requiresApproval: true,
  description: `Update a TeXRA configuration value (allowlisted keys only).

Use this AFTER calling \`read_config\` and explaining to the user what the setting does and what the new value will mean. Explain every change clearly. Pass \`target: "workspace"\` only when the change is genuinely workspace-specific (e.g. a project-local bib path); default to \`"user"\` for general preferences shared across workspaces.

Allowlisted keys:
${describeAllowlist()}

Anything outside this list must be changed through the host's regular configuration surface.`,
  schema: UpdateConfigInputSchema,
}) {
  protected async execute(input: UpdateConfigInput): Promise<ToolResult> {
    const entry = UPDATABLE_KEYS[input.key];
    const parsed = entry.schema.safeParse(input.value);
    if (!parsed.success) {
      throw new ToolError(
        `Value rejected for ${input.key}: ${z.prettifyError(parsed.error)}. ${entry.summary}`,
      );
    }

    const previous = texraScopedConfig.get(input.key);
    await texraScopedConfig.update(input.key, parsed.data, input.target);

    const before = JSON.stringify(previous);
    const after = JSON.stringify(parsed.data);
    return executed(
      `Updated ${input.key} (${input.target} scope): ${before ?? 'undefined'} → ${after}.`,
      `Updated ${input.key} (${input.target})`,
    );
  }
}
