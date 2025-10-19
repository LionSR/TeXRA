// Local imports - webview
import { setupPasteListener } from '../pasteHandler.js';
import { safeGetElementById } from '@common/domUtils.js';
import {
  autoResizeTextarea,
  insertTextAtCursor,
} from '@common/textareaUtils.js';

export class InstructionManager {
  constructor(textareaId, vscode, state) {
    this.textareaId = textareaId;
    this.vscode = vscode;
    this.state = state;
  }

  setup() {
    const textarea = safeGetElementById(this.textareaId);
    if (!textarea) {
      console.warn(
        `[InstructionManager] Element with id '${this.textareaId}' not found`,
      );
      return;
    }

    autoResizeTextarea(textarea);

    textarea.addEventListener('input', () => {
      autoResizeTextarea(textarea);
      this.state?.save();
    });

    setupPasteListener(
      textarea,
      this.vscode,
      (ta) => autoResizeTextarea(ta),
      () => this.state?.save(),
      (ta, text) => insertTextAtCursor(ta, text),
    );
  }
}
