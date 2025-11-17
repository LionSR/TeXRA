export * from './OutputHandler';
export * from './IOutputHandler';
export {
  // New clean types
  OutputFile,
  OutputFileInfo,
  FileLineage,
  OutputXmlSummary,
  RoundOutputArtifacts,
  // Legacy (deprecated)
  NamedOutputFile,
} from './types';
export { getOutputFileName } from '@agent/utils/outputFileUtils';
