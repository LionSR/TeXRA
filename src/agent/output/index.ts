export { OutputHandler } from './OutputHandler';
export type { IOutputHandler } from './IOutputHandler';
export { RoundOutputSchema } from './types';
export type {
  OutputFile,
  OutputFileInfo,
  FileLineage,
  OutputXmlSummary,
  RoundOutput,
  RoundFileMapping,
} from './types';
export {
  DiffResultSchema,
  DiffEntrySchema,
  LegacyDiffEntrySchema,
  parseDiffEntry,
} from './DiffResultSchemas';
export type { DiffResult, LegacyDiffEntry } from './DiffResultSchemas';
// Note: Display utils (getFileBasename, getFileDirectory, getDisplayLabel, getDisplayDir)
// are internal to the output module. Use @utils/files/getDisplayPath for external use.
