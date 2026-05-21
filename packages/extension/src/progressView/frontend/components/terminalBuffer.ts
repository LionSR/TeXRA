/** Terminal text buffer: ANSI normalization + incremental DOM patching. */

import stripAnsi from 'strip-ansi';

const ESCAPE_CHARACTER = String.fromCharCode(27);
// Null byte used as a sentinel for ANSI erase-line sequences inside processTerminalText.
// Real null bytes in the input are stripped first so the sentinel is unambiguous.
const ERASE_SENTINEL = '\x00';
const ANSI_ERASE_LINE_PATTERN = new RegExp(`${ESCAPE_CHARACTER}\\[\\d*K`, 'g');

const MAX_TAIL = 65536;

/** Strip ANSI codes and simulate \r overwrite within each newline-delimited line. */
export function processTerminalText(text: string): string {
  // Strip any real null bytes so \x00 is unambiguous as our internal sentinel.
  // Then replace ANSI erase-line escapes (\x1b[K, \x1b[0K, \x1b[2K, …) with it
  // before stripping all ANSI so the overwrite loop can honour them: an erase clears
  // the line from that column onward instead of preserving the stale tail characters.

  const preprocessed = text
    .split(ERASE_SENTINEL)
    .join('')
    .replaceAll(ANSI_ERASE_LINE_PATTERN, ERASE_SENTINEL);
  return stripAnsi(preprocessed)
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((line) => {
      const segs = line.split('\r');
      // On a fresh line (no preceding \r), \x1b[K has nothing to clear; text after
      // the erase point is still written at the cursor, so just strip the markers.
      let current = segs[0]!.split(ERASE_SENTINEL).join('');

      for (let i = 1; i < segs.length; i++) {
        const seg = segs[i]!;
        const eraseAt = seg.indexOf(ERASE_SENTINEL);
        if (eraseAt >= 0) {
          // \r overlays the prefix up to the erase point; \x1b[K clears from there to EOL.
          const pre = seg.slice(0, eraseAt);
          const post = seg
            .slice(eraseAt + 1)
            .split(ERASE_SENTINEL)
            .join('');
          current = pre + post;
        } else {
          // \r moves cursor to column 0 without clearing; shorter writes preserve the tail
          current =
            seg.length < current.length ? seg + current.slice(seg.length) : seg;
        }
      }
      return current.split(ERASE_SENTINEL).join('');
    })
    .join('\n');
}

/**
 * Holds the raw partial-line buffer and processed committed lines for
 * terminal-mode rendering, plus the incremental DOM patching state.
 */
export class TerminalBuffer {
  /** Raw partial-line buffer: unprocessed bytes after the last '\n', capped at 64 KiB */
  private rawTail = '';
  /** Processed complete lines for terminal mode (up to and including the last '\n') */
  private committedLines = '';

  /** Text node currently attached to the committed <pre>. */
  private committedTextNode: Text | null = null;
  /** Number of committed terminal characters already written to the DOM. */
  private renderedLength = 0;
  /** True after a cache rebuild, when incremental append is invalid. */
  private needsReset = true;

  get tail(): string {
    return this.rawTail;
  }

  get committed(): string {
    return this.committedLines;
  }

  /** Reset the DOM-patching state (called when leaving terminal mode). */
  resetDomState(): void {
    this.committedTextNode = null;
    this.renderedLength = 0;
    this.needsReset = true;
  }

  /** Discard buffers and re-process the full text. */
  rebuild(fullText: string): void {
    this.rawTail = '';
    this.committedLines = '';
    this.needsReset = true;
    this.append(fullText);
  }

  /** Append a raw chunk, processing complete lines into committedLines. */
  append(newRaw: string): void {
    const combined = this.rawTail + newRaw;
    const lastNl = combined.lastIndexOf('\n');
    if (lastNl >= 0) {
      this.committedLines += processTerminalText(combined.slice(0, lastNl + 1));
      this.rawTail = combined.slice(lastNl + 1);
    } else {
      // No newline: keep raw bytes so split ANSI sequences and cross-chunk \r
      // overwrites are handled correctly at render time. Cap unconditionally:
      // if the tail ends with \r (potential CRLF split) the cap still preserves
      // that trailing \r, so the next arriving \n is correctly joined into \r\n.
      this.rawTail =
        combined.length > MAX_TAIL
          ? combined.slice(combined.length - MAX_TAIL)
          : combined;
    }
  }

  /** Imperatively sync committedLines into the supplied <pre> element. */
  sync(pre: HTMLPreElement): void {
    const next = this.committedLines;
    const hasAttachedNode = this.committedTextNode?.parentNode === pre;
    const shouldReset =
      this.needsReset || !hasAttachedNode || next.length < this.renderedLength;

    if (shouldReset) {
      pre.textContent = '';
      this.committedTextNode =
        next.length > 0 ? document.createTextNode(next) : null;
      if (this.committedTextNode) {
        pre.append(this.committedTextNode);
      }
      this.renderedLength = next.length;
      this.needsReset = false;
      return;
    }

    if (next.length > this.renderedLength) {
      if (!this.committedTextNode) {
        this.committedTextNode = document.createTextNode('');
        pre.append(this.committedTextNode);
      }
      this.committedTextNode.appendData(next.slice(this.renderedLength));
      this.renderedLength = next.length;
    }

    this.needsReset = false;
  }
}
