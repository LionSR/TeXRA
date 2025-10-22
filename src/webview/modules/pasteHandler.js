// Third-party imports
import { nanoid } from 'nanoid';

// Local imports - webview
// Image paste handling utilities
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands.js';

// Comprehensive MIME type to extension mapping
export const IMAGE_MIME_TYPES = {
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
  // Progressive and alternative formats
  'image/pjpeg': 'jpg',
  'image/x-png': 'png',
  'image/x-jng': 'jng',
  'image/x-mng': 'mng',
  // Adobe formats
  'image/vnd.adobe.photoshop': 'psd',
  'image/x-photoshop': 'psd',
  'image/x-psd': 'psd',
};

/**
 * Generate a unique filename for a pasted image
 * @param {string} extension - File extension
 * @returns {string} Generated filename
 */
export function generatePastedImageName(extension) {
  const timestamp = Date.now();
  const random = nanoid(6);
  return `pasted_${timestamp}_${random}.${extension}`;
}

/**
 * Get file extension from MIME type
 * @param {string} mimeType - MIME type of the image
 * @returns {string} File extension
 */
export function getExtensionFromMimeType(mimeType) {
  return IMAGE_MIME_TYPES[mimeType] || mimeType.split('/')[1] || 'png';
}

/**
 * Process a single image from clipboard
 * @param {File} file - Image file
 * @param {string} mimeType - MIME type
 * @param {Object} vscode - VS Code API
 * @returns {Promise<string|null>} Filename or null if failed
 */
export async function processClipboardImage(file, mimeType, vscode) {
  return new Promise((resolve) => {
    const ext = getExtensionFromMimeType(mimeType);
    const fileName = generatePastedImageName(ext);
    const reader = new FileReader();

    reader.onload = () => {
      const result = reader.result;
      if (typeof result === 'string') {
        const base64 = result.split(',')[1];
        if (base64) {
          vscode.postMessage({
            command: MAIN_VIEW_COMMANDS.CLIPBOARD_IMAGE,
            base64,
            mediaType: mimeType,
            fileName,
          });
          resolve(fileName);
        } else {
          resolve(null);
        }
      } else {
        resolve(null);
      }
    };

    reader.onerror = () => {
      console.error(`Failed to read file: ${fileName}`);
      vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE,
        text: `Failed to process pasted image: ${fileName}`,
      });
      resolve(null);
    };

    try {
      reader.readAsDataURL(file);
    } catch (err) {
      console.error(`Error reading file: ${err}`);
      resolve(null);
    }
  });
}

/**
 * Handle paste event for images
 * @param {ClipboardEvent} event - Paste event
 * @param {HTMLTextAreaElement} textarea - Target textarea
 * @param {Object} vscode - VS Code API
 * @param {Function} insertTextAtCursor - Function to insert text at cursor
 * @returns {Promise<boolean>} True if images were processed
 */
export async function handleImagePaste(
  event,
  textarea,
  vscode,
  insertTextAtCursor,
) {
  const items = event.clipboardData?.items || [];
  const images = [];

  // Collect all image items
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

  // Prevent default paste behavior
  event.preventDefault();

  // Get any text content from clipboard
  let insertText = event.clipboardData?.getData('text/plain') || '';

  // Process all images
  const fileNames = await Promise.all(
    images.map(({ file, type }) => processClipboardImage(file, type, vscode)),
  );

  // Build the text to insert
  fileNames.forEach((fileName) => {
    if (fileName) {
      // Add spacing if needed
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

  // Insert all text and image references
  if (insertText) {
    insertTextAtCursor(textarea, insertText);
  }

  return true;
}

/**
 * Setup paste event listener for a textarea
 * @param {HTMLTextAreaElement} textarea - Target textarea
 * @param {Object} vscode - VS Code API
 * @param {Function} autoResizeTextarea - Auto resize function
 * @param {Function} saveState - Save state function
 * @param {Function} insertTextAtCursor - Function to insert text at cursor
 */
export function setupPasteListener(
  textarea,
  vscode,
  autoResizeTextarea,
  saveState,
  insertTextAtCursor,
) {
  if (!textarea) return;

  const target = textarea.wrappedElement ?? textarea;
  target.addEventListener('paste', async (e) => {
    const handled = await handleImagePaste(
      e,
      textarea,
      vscode,
      insertTextAtCursor,
    );

    // Auto-resize textarea after paste
    setTimeout(() => {
      autoResizeTextarea(textarea);
      saveState();
    }, 0);
  });
}
