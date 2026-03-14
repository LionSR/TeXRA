/**
 * Attribution metadata for memory files via inline frontmatter.
 *
 * Metadata lives inside each file as a small YAML frontmatter block,
 * making the filesystem the single source of truth.  No sidecar file,
 * no locking, no orphan cleanup — delete/rename just works.
 */

export interface MemoryFileMeta {
  /** Agent name that last modified this file. */
  modifiedBy: string;
  /** Execution ID of the run that last modified this file. */
  executionId?: string;
  /** ISO 8601 timestamp of last modification. */
  modifiedAt: string;
  /** Whether this memory is pinned as a core long-term insight. */
  pinned?: boolean;
}

const FRONTMATTER_FENCE = '---';

// ── Parsing ────────────────────────────────────────────────────────

/**
 * Split a raw file string into optional attribution metadata and the
 * user-visible content.  Files without frontmatter return null metadata
 * and the full string as content (backward-compatible).
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
  const fields: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) {
      fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }
  }

  if (!fields.modifiedBy) {
    return { meta: null, content: raw };
  }

  return {
    meta: {
      modifiedBy: fields.modifiedBy,
      executionId: fields.executionId || undefined,
      modifiedAt: fields.modifiedAt || new Date().toISOString(),
      pinned: fields.pinned === 'true' ? true : undefined,
    },
    content: raw.slice(endIdx + FRONTMATTER_FENCE.length + 2), // skip "\n---\n"
  };
}

// ── Building ───────────────────────────────────────────────────────

function buildFrontmatter(meta: MemoryFileMeta): string {
  const lines = [FRONTMATTER_FENCE, `modifiedBy: ${meta.modifiedBy}`];
  if (meta.executionId) {
    lines.push(`executionId: ${meta.executionId}`);
  }
  lines.push(`modifiedAt: ${meta.modifiedAt}`);
  if (meta.pinned) {
    lines.push('pinned: true');
  }
  lines.push(FRONTMATTER_FENCE);
  return lines.join('\n');
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
): MemoryFileMeta | null {
  if (!agentName) return null;
  return {
    modifiedBy: agentName,
    executionId,
    modifiedAt: new Date().toISOString(),
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
