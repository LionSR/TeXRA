// Bracketed-paste detection.
//
// The first draft attached a `data` listener to raw stdin to scan for
// `CSI 200 ~` / `CSI 201 ~`. In practice that listener stays in the same
// stream pipeline ink reads from, and the extra handler made typed
// characters disappear from `<TextInput>` (the data event drained into
// the listener before ink saw it). The bracketed-paste impl re-lands in
// Phase 5 with the palette / @-mention overlays that actually consume
// `currentPaste`; for now we return inert state so the BaseTextInput
// API stays stable.

interface PasteState {
  readonly isPasted: boolean;
  readonly currentPaste: string;
}

const INERT: PasteState = { isPasted: false, currentPaste: '' };

export function usePasteHandler(): PasteState {
  return INERT;
}
