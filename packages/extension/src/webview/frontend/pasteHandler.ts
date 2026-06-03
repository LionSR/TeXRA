// Local imports - shared utilities
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import { insertTextAtCursor } from '@shared/utils/textarea';
import {
  clipboardImageFiles,
  generatePastedImageName,
  getExtensionFromMimeType,
  readFileAsBase64,
} from '@shared/utils/clipboardImages';

export async function handleImagePaste(
  event: ClipboardEvent,
  target: HTMLElement,
): Promise<boolean> {
  const images = clipboardImageFiles(event);
  if (images.length === 0) {
    return false;
  }

  // Must run synchronously, before any await, to suppress the default paste.
  event.preventDefault();

  let insertText = event.clipboardData?.getData('text/plain') || '';
  for (const { file, type } of images) {
    const fileName = generatePastedImageName(getExtensionFromMimeType(type));
    const base64 = await readFileAsBase64(file);
    if (!base64) {
      postMessage(MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE, {
        text: `Failed to process pasted image: ${fileName}`,
      });
      continue;
    }
    postMessage(MAIN_VIEW_COMMANDS.CLIPBOARD_IMAGE, {
      base64,
      mediaType: type,
      fileName,
    });
    if (insertText && !insertText.endsWith(' ') && !insertText.endsWith('\n')) {
      insertText += ' ';
    }
    insertText += `[${fileName}]`;
  }

  if (insertText) {
    insertTextAtCursor(target, insertText);
  }

  return true;
}
