// Third-party imports
import { nanoid } from 'nanoid';

// Local imports - shared utilities
import { insertTextAtCursor } from '@shared/utils/textarea';
import { postMessage } from '@shared/vscode';
import { PASTED_PREFIX } from '@shared/files/pastedImageConstants';

// Local imports - webview commands
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands';

const IMAGE_MIME_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/tiff': 'tiff',
  'image/tif': 'tiff',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/avif': 'avif',
  'image/pjpeg': 'jpg',
  'image/x-png': 'png',
  'image/x-jng': 'jng',
  'image/x-mng': 'mng',
  'image/vnd.adobe.photoshop': 'psd',
  'image/x-photoshop': 'psd',
  'image/x-psd': 'psd',
};

function generatePastedImageName(extension: string): string {
  const timestamp = Date.now();
  const random = nanoid(6);
  return `${PASTED_PREFIX}${timestamp}_${random}.${extension}`;
}

function getExtensionFromMimeType(mimeType: string): string {
  return IMAGE_MIME_TYPES[mimeType] || mimeType.split('/')[1] || 'png';
}

async function processClipboardImage(
  file: File,
  mimeType: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    const extension = getExtensionFromMimeType(mimeType);
    const fileName = generatePastedImageName(extension);
    const reader = new FileReader();

    reader.onload = () => {
      const result = reader.result;
      if (typeof result === 'string') {
        const base64 = result.split(',')[1];
        if (base64) {
          postMessage(MAIN_VIEW_COMMANDS.CLIPBOARD_IMAGE, {
            base64,
            mediaType: mimeType,
            fileName,
          });
          resolve(fileName);
          return;
        }
      }
      resolve(null);
    };

    reader.onerror = () => {
      console.error(`Failed to read file: ${fileName}`);
      postMessage(MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE, {
        text: `Failed to process pasted image: ${fileName}`,
      });
      resolve(null);
    };

    try {
      reader.readAsDataURL(file);
    } catch (error) {
      console.error(`Error reading file: ${String(error)}`);
      resolve(null);
    }
  });
}

export async function handleImagePaste(
  event: ClipboardEvent,
  target: HTMLElement,
): Promise<boolean> {
  /* eslint-disable unicorn/prefer-spread -- DataTransferItemList lacks iterator typing. */
  const items = event.clipboardData
    ? Array.from(event.clipboardData.items)
    : [];
  /* eslint-enable unicorn/prefer-spread */
  const images: Array<{ file: File; type: string }> = [];

  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) {
        images.push({ file, type: item.type });
      }
    }
  }

  if (images.length === 0) {
    return false;
  }

  event.preventDefault();

  let insertText = event.clipboardData?.getData('text/plain') || '';
  const fileNames = await Promise.all(
    images.map(({ file, type }) => processClipboardImage(file, type)),
  );

  fileNames.forEach((fileName) => {
    if (fileName) {
      if (
        insertText &&
        !insertText.endsWith(' ') &&
        !insertText.endsWith('\n')
      ) {
        insertText += ' ';
      }
      insertText += `[${fileName}]`;
    }
  });

  if (insertText) {
    // insertTextAtCursor handles vscode-textarea resolution internally
    insertTextAtCursor(target, insertText);
  }

  return true;
}
