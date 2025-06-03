// Local imports
import { getConfig } from './configUtils';

export type FileType =
  | 'input'
  | 'reference'
  | 'auxiliary'
  | 'media'
  | 'audio'
  | 'edited';

const INCLUDED_EXTENSION_KEYS: Record<FileType, string> = {
  input: 'files.included.inputExtensions',
  reference: 'files.included.referenceExtensions',
  auxiliary: 'files.included.auxiliaryExtensions',
  media: 'files.included.mediaExtensions',
  audio: 'files.included.audioExtensions',
  edited: 'files.included.editedExtensions',
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
