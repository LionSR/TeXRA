// Bracketed-paste detection per
// docs/prd/cli-tui-ink/10-architecture.md (Input component).
//
// Reads `CSI 200 ~` / `CSI 201 ~` from raw stdin and exposes an
// `isPasted` flag plus a `currentPaste` buffer. Consumers (BaseTextInput,
// attachment paste) read these to decide whether `Enter` is "submit" or
// "newline".

import { useEffect, useState } from 'react';
import { useStdin } from 'ink';

interface PasteState {
  readonly isPasted: boolean;
  readonly currentPaste: string;
}

const INITIAL: PasteState = { isPasted: false, currentPaste: '' };

const PASTE_START = '[200~';
const PASTE_END = '[201~';

/**
 * Track bracketed-paste boundaries. Returns the current paste state plus a
 * `handleInput` helper consumers can call with raw chunks (when ink's
 * `useInput` path isn't sufficient).
 */
export function usePasteHandler(): PasteState {
  const { stdin, isRawModeSupported, setRawMode } = useStdin();
  const [state, setState] = useState<PasteState>(INITIAL);

  useEffect(() => {
    if (!stdin || !isRawModeSupported) return;
    setRawMode(true);

    let inPaste = false;
    let pasteBuffer = '';

    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let cursor = 0;
      while (cursor < text.length) {
        if (!inPaste) {
          const start = text.indexOf(PASTE_START, cursor);
          if (start === -1) return;
          inPaste = true;
          cursor = start + PASTE_START.length;
          pasteBuffer = '';
          continue;
        }
        const end = text.indexOf(PASTE_END, cursor);
        if (end === -1) {
          pasteBuffer += text.slice(cursor);
          setState({ isPasted: true, currentPaste: pasteBuffer });
          return;
        }
        pasteBuffer += text.slice(cursor, end);
        inPaste = false;
        cursor = end + PASTE_END.length;
        const finalPaste = pasteBuffer;
        pasteBuffer = '';
        setState({ isPasted: true, currentPaste: finalPaste });
        // Snap back to non-paste mode for the next render so Enter goes
        // back to "submit" after the paste fully lands.
        queueMicrotask(() => setState(INITIAL));
      }
    };

    stdin.on('data', onData);
    return () => {
      stdin.off('data', onData);
    };
  }, [stdin, isRawModeSupported, setRawMode]);

  return state;
}
