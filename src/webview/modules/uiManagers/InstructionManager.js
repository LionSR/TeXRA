// Local imports - webview
import { setupPasteListener } from '../pasteHandler.js';
import { safeGetElementById } from '@common/domUtils.js';
import {
  autoResizeTextarea as resizeTextarea,
  insertTextAtCursor as insertAtCursor,
} from '@common/textareaUtils.js';

export class InstructionManager {
  constructor(textareaId, vscode, state) {
    this.textareaId = textareaId;
    this.vscode = vscode;
    this.state = state;
  }

  autoResizeTextarea(textarea) {
    resizeTextarea(textarea);
  }

  insertTextAtCursor(textarea, text) {
    insertAtCursor(textarea, text);
  }

  setup() {
    const textarea = safeGetElementById(this.textareaId);
    if (!textarea) {
      console.warn(
        `[InstructionManager] Element with id '${this.textareaId}' not found`,
      );
      return;
    }

    resizeTextarea(textarea);

    textarea.addEventListener('input', () => {
      resizeTextarea(textarea);
      this.state?.save();
    });

    setupPasteListener(
      textarea,
      this.vscode,
      (ta) => resizeTextarea(ta),
      () => this.state?.save(),
      (ta, text) => insertAtCursor(ta, text),
    );
  }
}
