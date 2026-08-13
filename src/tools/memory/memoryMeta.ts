/**
 * Attribution metadata for memory files via inline frontmatter.
 *
 * Metadata lives inside each file as a small YAML frontmatter block,
 * making the filesystem the single source of truth.  No sidecar file,
 * no locking, no orphan cleanup — delete/rename just works.
 */

import * as yaml from 'yaml';
import { z } from 'zod';

import { parseYamlWith } from '@common/parsing/safeParseYaml';

/**
 * Attribution metadata schema. Source of truth for the {@link MemoryFileMeta}
 * type; also validates the YAML frontmatter parsed back off disk so a
 * hand-edited or malformed block degrades to "no metadata" rather than
 * throwing. `modifiedAt` is required: every TeXRA writer (the retired
 * sidecar and the inline-frontmatter writer) has always emitted it, so a
 * block without it is not TeXRA-produced metadata and stays ordinary
 * content (#9648).
 */
const MemoryFileMetaSchema = z.object({
  /** Agent name that last modified this file. */
  modifiedBy: z.string().min(1),
  /** Execution ID of the run that last modified this file. */
  executionId: z.string().optional(),
  /** ISO 8601 timestamp of last modification. */
  modifiedAt: z.string(),
  /**
   * Whether this memory is pinned as a core long-term insight. A parsed
   * `false` is treated the same as absent everywhere it is read, and
   * {@link buildFrontmatter} only ever writes the flag when truthy.
   * This schema parses YAML frontmatter, not model-facing tool input.
   */
  pinned: z.boolean().optional(),
});

export type MemoryFileMeta = z.infer<typeof MemoryFileMetaSchema>;

const FRONTMATTER_FENCE = '---';

// ── Parsing ────────────────────────────────────────────────────────

/**
 * Split a raw file string into optional attribution metadata and the
 * user-visible content.  Files without (valid) frontmatter return null
 * metadata and the full string as content (backward-compatible).
 */
export function parseFrontmatter(raw: string): {
  meta: MemoryFileMeta | null;
  content: string;
} {
  if (!raw.startsWith(`${FRONTMATTER_FENCE}\n`)) {
    return { meta: null, content: raw };
  }

  const endIdx = raw.indexOf(
    `\n${FRONTMATTER_FENCE}\n`,
    FRONTMATTER_FENCE.length,
  );
  if (endIdx === -1) {
    return { meta: null, content: raw };
  }

  const block = raw.slice(FRONTMATTER_FENCE.length + 1, endIdx);
  const parsed = parseYamlWith(block, MemoryFileMetaSchema);
  if (parsed.isErr()) {
    return { meta: null, content: raw };
  }

  return {
    meta: parsed.value,
    content: raw.slice(endIdx + FRONTMATTER_FENCE.length + 2), // skip "\n---\n"
  };
}

// ── Building ───────────────────────────────────────────────────────

function buildFrontmatter(meta: MemoryFileMeta): string {
  // Build the object explicitly so only set fields are serialized, in a
  // stable key order.
  const fields: Record<string, string | boolean> = {
    modifiedBy: meta.modifiedBy,
  };
  if (meta.executionId) fields.executionId = meta.executionId;
  fields.modifiedAt = meta.modifiedAt;
  if (meta.pinned) fields.pinned = true;

  // yaml.stringify ends with a trailing newline, so the closing fence sits on
  // its own line: "---\n<fields>---".
  return `${FRONTMATTER_FENCE}\n${yaml.stringify(fields)}${FRONTMATTER_FENCE}`;
}

/**
 * Combine attribution metadata with user content into a single file
 * string.  If meta is null the content is returned unchanged.
 */
export function buildFile(
  content: string,
  meta: MemoryFileMeta | null,
): string {
  if (!meta) return content;
  return `${buildFrontmatter(meta)}\n${content}`;
}

/**
 * Create a fresh MemoryFileMeta for the current agent / execution.
 * Returns null when agentName is not available (attribution skipped).
 */
export function createMeta(
  agentName: string | undefined,
  executionId: string | undefined,
  existingMeta?: MemoryFileMeta | null,
): MemoryFileMeta | null {
  if (!agentName) return null;
  return {
    modifiedBy: agentName,
    executionId,
    modifiedAt: new Date().toISOString(),
    pinned: existingMeta?.pinned,
  };
}

// ── Pin/Unpin ──────────────────────────────────────────────────────

/**
 * Create a new MemoryFileMeta with the pinned flag toggled.
 * If no existing meta is provided, creates a default attribution.
 */
export function setPinnedMeta(
  meta: MemoryFileMeta | null,
  pinned: boolean,
): MemoryFileMeta {
  const base = meta ?? {
    modifiedBy: 'user',
    modifiedAt: new Date().toISOString(),
  };
  return {
    ...base,
    pinned: pinned ? true : undefined,
  };
}

// ── Display ────────────────────────────────────────────────────────

/** Format attribution for display: "agentName (executionId)" or just "agentName". */
export function formatAttribution(meta: MemoryFileMeta): string {
  return meta.executionId
    ? `${meta.modifiedBy} (${meta.executionId})`
    : meta.modifiedBy;
}
