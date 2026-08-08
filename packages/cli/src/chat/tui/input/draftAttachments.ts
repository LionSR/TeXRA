// Draft attachment store for the chat InputBar.
//
// Collapsing large pastes and pasted images into compact
// `[Pasted text #N +M lines]` / `[Image #N]` chips keeps the draft readable.
// The full content lives here, keyed by a per-draft id, and is spliced back in
// at submit time. Text and image chips share one `#N` id space so the counter
// never collides (mirrors Claude Code).
//
// This store is InputBar-local (held in a ref) — it never leaks into the
// headless (`texra run` / `--print`) path, which has no InputBar and therefore
// never creates a placeholder. Expansion happens only at the interactive submit
// boundary, so the piped/non-TTY output stays byte-identical.

/** Collapse a paste into a chip when it exceeds either bound. */
const PASTE_CHAR_THRESHOLD = 800;
const PASTE_MAX_INLINE_LINES = 2;

interface PastedTextEntry {
  readonly id: number;
  readonly kind: 'text';
  readonly content: string;
}

export interface PastedImageEntry {
  readonly id: number;
  readonly kind: 'image';
  /** Absolute path to the on-disk image (under the run/chat storage dir). */
  readonly path: string;
  readonly mediaType: string;
  readonly displayName: string;
}

export type DraftAttachment = PastedTextEntry | PastedImageEntry;

/** Count newline sequences, matching the chip's "+M lines" suffix. */
function pastedNewlineCount(text: string): number {
  return (text.match(/\r\n|\r|\n/g) ?? []).length;
}

/** Whether a paste is large enough to collapse into a chip. */
export function shouldCollapsePaste(text: string): boolean {
  return (
    text.length > PASTE_CHAR_THRESHOLD ||
    pastedNewlineCount(text) > PASTE_MAX_INLINE_LINES
  );
}

/**
 * Matches the chips the input collapses pastes/attachments into. The optional
 * `+M lines` is non-capturing — only the id matters for lookup.
 */
const CHIP_RE = /\[(?:Pasted text|Image) #(\d+)(?: \+\d+ lines)?\]/g;

interface ChipMatch {
  readonly id: number;
  readonly start: number;
  readonly end: number;
}

function matchChips(input: string): ChipMatch[] {
  const matches: ChipMatch[] = [];
  for (const m of input.matchAll(CHIP_RE)) {
    if (m.index === undefined) continue;
    matches.push({
      id: Number(m[1]),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return matches;
}

function isInlineWhitespace(char: string | undefined): boolean {
  return char === ' ' || char === '\t';
}

function removeChipRange(input: string, start: number, end: number): string {
  const removeFollowingSpace =
    isInlineWhitespace(input[start - 1]) && isInlineWhitespace(input[end]);
  const removePrecedingSpace =
    isInlineWhitespace(input[start - 1]) &&
    (input[end] === undefined || input[end] === '\n' || input[end] === '\r');
  if (removePrecedingSpace) {
    return input.slice(0, start - 1) + input.slice(end);
  }
  return (
    input.slice(0, start) + input.slice(removeFollowingSpace ? end + 1 : end)
  );
}

export class DraftAttachmentStore {
  private readonly entries = new Map<number, DraftAttachment>();
  private nextId = 1;

  /** Store pasted text; returns the chip to insert in the draft. */
  addPastedText(content: string): string {
    const id = this.nextId++;
    this.entries.set(id, { id, kind: 'text', content });
    const numLines = pastedNewlineCount(content);
    return numLines === 0
      ? `[Pasted text #${id}]`
      : `[Pasted text #${id} +${numLines} lines]`;
  }

  /** Store a pasted image; returns the chip to insert in the draft. */
  addPastedImage(image: Omit<PastedImageEntry, 'id' | 'kind'>): string {
    const id = this.nextId++;
    this.entries.set(id, { id, kind: 'image', ...image });
    return `[Image #${id}]`;
  }

  isEmpty(): boolean {
    return this.entries.size === 0;
  }

  clear(): void {
    this.entries.clear();
    this.nextId = 1;
  }

  /**
   * Expand text chips back to their stored content (reverse-offset splice so
   * earlier replacements don't shift later match indices, and any chip-like
   * text *inside* pasted content is never re-matched). Image chips are left in
   * place — the image bytes ride along as media files (see {@link resolveMedia}).
   */
  expandText(input: string): string {
    let out = input;
    for (const match of matchChips(input).toReversed()) {
      const entry = this.entries.get(match.id);
      if (entry?.kind !== 'text') continue;
      out = out.slice(0, match.start) + entry.content + out.slice(match.end);
    }
    return out;
  }

  /**
   * Text to persist in input history. Pasted text is useful on recall, but
   * image chips are not: once submitted, their media entries are cleared and a
   * recalled `[Image #N]` would be a bare token with no file attached.
   */
  expandTextForHistory(input: string): string {
    let out = input;
    for (const match of matchChips(input).toReversed()) {
      const entry = this.entries.get(match.id);
      if (entry?.kind !== 'image') continue;
      out = removeChipRange(out, match.start, match.end);
    }
    return this.expandText(out);
  }

  /**
   * Absolute paths of image attachments whose `[Image #N]` chip still survives
   * in the submitted draft. Orphaned chips (deleted from the text) are dropped,
   * matching Claude Code's orphan gate.
   */
  resolveMedia(input: string): string[] {
    const present = new Set(matchChips(input).map((m) => m.id));
    const paths: string[] = [];
    for (const id of present) {
      const entry = this.entries.get(id);
      if (entry?.kind === 'image') paths.push(entry.path);
    }
    return paths;
  }
}
