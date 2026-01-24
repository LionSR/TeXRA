// Core filesystem abstractions
export { WorkspaceFS } from './workspaceFS';
export { AbsoluteFS } from './absoluteFS';
export { StorageFS, GlobalStorageFS } from './storageFS';
export { RelativeFS } from './relativeFS';

// Heavily-used utilities (re-exported for convenience)
export * from './fileMappingUtils';
export * from './mimeUtils';
export * from './taskRunStorage';
export * from './flexibleFS';
export * from './latexDiffUtils';

// Shared file location schemas/types (re-exported for convenience)
export { AgentFileLocationSchema, FileLocationSchema } from '@shared/schemas';
export type {
  AgentFileLocation,
  ExternalFileLocation,
  FileLocation,
  RunStorageFileLocation,
  WorkspaceFileLocation,
} from '@shared/schemas';

// Note: pastedImageUtils, rulesUtils, and varsUtils are NOT re-exported.
// Import directly from their source modules:
//   import { loadTexraRules } from '@utils/files/rulesUtils';
//   import { setVarFromFile } from '@utils/files/varsUtils';
//   import { isPastedImage, ... } from '@utils/files/pastedImageUtils';
