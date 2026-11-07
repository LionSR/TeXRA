// The chat's draft: what the input shows, the content behind its chips, and
// the skills activated for the next message, as one immutable value the chat
// holds in a `SubscriptionRef`. A message is this value from the input to the
// session, and a message the session does not take comes back as the same
// value, so nothing is re-parsed on the way back.
//
// Collapsing large pastes and pasted images into compact
// `[Pasted text #N +M lines]` / `[Image #N]` chips keeps the draft readable.
// The full content lives in the draft, keyed by a per-draft id, and is spliced
// back in where the message is sent. Text and image chips share one `#N` id
// space so the counter never collides (mirrors Claude Code).
//
// Only the interactive input makes chips; the headless (`texra run` /
// `--print`) path has no input and never creates a placeholder, so piped
// output stays byte-identical.

import type { SkillActivation } from '../forms/SkillsListForm';

/** Collapse a paste into a chip when it exceeds either bound. */
const PASTE_CHAR_THRESHOLD = 800;
const PASTE_MAX_INLINE_LINES = 2;

interface PastedTextEntry {
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

type DraftAttachment = PastedTextEntry | PastedImageEntry;

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

export interface Draft {
  /** What the input shows, chips included. */
  readonly text: string;
  /** The content behind each chip, by chip id. */
  readonly attachments: ReadonlyMap<number, DraftAttachment>;
  readonly nextId: number;
  /** Skills activated for the next message, by name. */
  readonly skills: readonly SkillActivation[];
}

export const EMPTY_DRAFT: Draft = Object.freeze({
  text: '',
  attachments: new Map(),
  nextId: 1,
  skills: Object.freeze([]),
});

/** The draft with `text` typed. An emptied draft holds no chip, so it drops
 *  them; its skills stay for the next message. */
export function withText(draft: Draft, text: string): Draft {
  if (text === draft.text) return draft;
  return text === ''
    ? { ...EMPTY_DRAFT, skills: draft.skills }
    : { ...draft, text };
}

function withAttachment(
  draft: Draft,
  attachment: (id: number) => DraftAttachment,
): { readonly draft: Draft; readonly id: number } {
  const id = draft.nextId;
  const attachments = new Map(draft.attachments);
  attachments.set(id, attachment(id));
  return { draft: { ...draft, attachments, nextId: id + 1 }, id };
}

/** Keep pasted text; returns the draft and the chip to insert in its text. */
export function withPastedText(
  draft: Draft,
  content: string,
): { readonly draft: Draft; readonly chip: string } {
  const next = withAttachment(draft, () => ({ kind: 'text', content }));
  const numLines = pastedNewlineCount(content);
  return {
    draft: next.draft,
    chip:
      numLines === 0
        ? `[Pasted text #${next.id}]`
        : `[Pasted text #${next.id} +${numLines} lines]`,
  };
}

/** Keep a pasted image; returns the draft and the chip to insert in its text. */
export function withPastedImage(
  draft: Draft,
  image: Omit<PastedImageEntry, 'id' | 'kind'>,
): { readonly draft: Draft; readonly chip: string } {
  const next = withAttachment(draft, (id) => ({ id, kind: 'image', ...image }));
  return { draft: next.draft, chip: `[Image #${next.id}]` };
}

/** The skill activated for the next message, replacing one of its name. */
export function withSkill(draft: Draft, skill: SkillActivation): Draft {
  return {
    ...draft,
    skills: [...draft.skills.filter((s) => s.name !== skill.name), skill],
  };
}

/**
 * The draft text with text chips expanded back to their content
 * (reverse-offset splice so earlier replacements don't shift later match
 * indices, and any chip-like text *inside* pasted content is never
 * re-matched). Image chips are left in place: the image bytes ride along as
 * media files (see {@link resolveImages}).
 */
export function expandText(draft: Draft, input = draft.text): string {
  let out = input;
  for (const match of matchChips(input).toReversed()) {
    const entry = draft.attachments.get(match.id);
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
export function expandTextForHistory(draft: Draft): string {
  let out = draft.text;
  for (const match of matchChips(draft.text).toReversed()) {
    const entry = draft.attachments.get(match.id);
    if (entry?.kind !== 'image') continue;
    out = removeChipRange(out, match.start, match.end);
  }
  return expandText(draft, out);
}

/**
 * Image entries whose chip survives in the text, in chip order. Orphaned
 * chips (deleted from the text) are dropped, matching Claude Code's orphan
 * gate.
 */
export function resolveImages(draft: Draft): PastedImageEntry[] {
  const present = new Set(matchChips(draft.text).map((m) => m.id));
  const images: PastedImageEntry[] = [];
  for (const id of present) {
    const entry = draft.attachments.get(id);
    if (entry?.kind === 'image') images.push(entry);
  }
  return images;
}

/**
 * A message the session did not take, back in the input: its text below
 * whatever was typed since, its chips renumbered into the current draft's id
 * space, and its skills activated again unless one of the same name was
 * activated since.
 */
export function restoreDraft(current: Draft, returned: Draft): Draft {
  let next: Draft = {
    ...current,
    skills: [
      ...current.skills,
      ...returned.skills.filter(
        (skill) => !current.skills.some((s) => s.name === skill.name),
      ),
    ],
  };
  if (returned.text.length === 0) return next;
  const renumbered = new Map<number, number>();
  for (const match of matchChips(returned.text)) {
    const entry = returned.attachments.get(match.id);
    if (entry === undefined || renumbered.has(match.id)) continue;
    const added = withAttachment(next, (id) =>
      entry.kind === 'image' ? { ...entry, id } : entry,
    );
    next = added.draft;
    renumbered.set(match.id, added.id);
  }
  let text = returned.text;
  for (const match of matchChips(returned.text).toReversed()) {
    const id = renumbered.get(match.id);
    if (id === undefined) continue;
    const chip = text
      .slice(match.start, match.end)
      .replace(`#${match.id}`, `#${id}`);
    text = text.slice(0, match.start) + chip + text.slice(match.end);
  }
  return {
    ...next,
    text: current.text.length > 0 ? `${current.text}\n${text}` : text,
  };
}
