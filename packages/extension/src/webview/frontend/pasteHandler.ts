// Local imports - shared utilities
import { postMessage } from '@shared/hostBridge';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import { insertTextAtCursor } from '@shared/utils/textarea';
import {
  clipboardImageFiles,
  getExtensionFromMimeType,
  readFileAsBase64,
} from '@shared/utils/clipboardImages';
import { generatePastedImageName } from '@utils/files/pastedImageName';

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
  // Chromium webviews move clipboard data into protected mode after the first
  // async yield, so read plain text before the file reads below.
  const pastedText = event.clipboardData?.getData('text/plain') || '';

  const pastedImageText = await Promise.all(
    images.map(async ({ file, type }) => {
      const fileName = generatePastedImageName(getExtensionFromMimeType(type));
      const base64 = await readFileAsBase64(file);
      if (!base64) {
        postMessage(MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE, {
          text: `Could not attach the pasted image ${fileName}. Try adding it as a media file.`,
        });
        return '';
      }
      postMessage(MAIN_VIEW_COMMANDS.CLIPBOARD_IMAGE, {
        base64,
        mediaType: type,
        fileName,
      });
      return `[${fileName}]`;
    }),
  );

  const imageChips = pastedImageText.filter(Boolean).join(' ');
  let insertText = pastedText;
  if (imageChips) {
    if (insertText && !insertText.endsWith(' ') && !insertText.endsWith('\n')) {
      insertText += ' ';
    }
    insertText += imageChips;
  }

  if (insertText) {
    insertTextAtCursor(target, insertText);
  }

  return true;
}
