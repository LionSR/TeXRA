import type { ReactiveController, ReactiveControllerHost } from 'lit';

/** How long a Copy button reads as copied. */
const COPY_RESET_DELAY_MS = 2000;

/**
 * Copy text to the clipboard with LF line endings. False when the browser
 * refuses the write (access denied or unavailable): only that call is
 * caught, so the button shows no success it did not have.
 */
async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text.replaceAll('\r\n', '\n'));
    return true;
  } catch {
    return false;
  }
}

/**
 * The one copy feedback: `copy(text)` writes the clipboard and `copied`
 * reads true for two seconds after a write that succeeded, the host
 * re-rendering on each change. A second copy restarts the two seconds. The
 * host words its own button from `copied`.
 */
export class CopyButtonController implements ReactiveController {
  private _copied = false;
  private resetTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly host: ReactiveControllerHost;
  constructor(host: ReactiveControllerHost) {
    this.host = host;
    this.host.addController(this);
  }

  hostDisconnected(): void {
    clearTimeout(this.resetTimer);
  }

  /** Whether the last copy succeeded less than two seconds ago. */
  get copied(): boolean {
    return this._copied;
  }

  /** Copy `text` (nothing for blank text); true when the clipboard took it. */
  copy = async (text: string): Promise<boolean> => {
    if (!text.trim()) return false;
    clearTimeout(this.resetTimer);
    this.setCopied(false);
    if (!(await copyTextToClipboard(text))) return false;
    this.setCopied(true);
    this.resetTimer = setTimeout(
      () => this.setCopied(false),
      COPY_RESET_DELAY_MS,
    );
    return true;
  };

  private setCopied(copied: boolean): void {
    if (this._copied === copied) return;
    this._copied = copied;
    this.host.requestUpdate();
  }
}
