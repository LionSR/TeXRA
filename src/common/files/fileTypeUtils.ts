// Local imports - common
// Local imports
import { getConfig } from '@utils/config';
import * as path from 'path';

export type FileType =
  | 'input'
  | 'reference'
  | 'auxiliary'
  | 'media'
  | 'audio'
  | 'edited';

const INCLUDED_EXTENSION_KEYS: Record<FileType, string> = {
  input: 'texra.files.included.inputExtensions',
  reference: 'texra.files.included.referenceExtensions',
  auxiliary: 'texra.files.included.auxiliaryExtensions',
  media: 'texra.files.included.mediaExtensions',
  audio: 'texra.files.included.audioExtensions',
  edited: 'texra.files.included.editedExtensions',
};

/**
 * Retrieve included extensions for the given file type.
 */
export function getIncludedExtensions(
  type: FileType,
  defaultExtensions: string[] = [],
): string[] {
  return getConfig<string[]>(INCLUDED_EXTENSION_KEYS[type], defaultExtensions);
}

/**
 * Returns true if the file has a .tex extension.
 */
export function isTexFile(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === '.tex';
}
