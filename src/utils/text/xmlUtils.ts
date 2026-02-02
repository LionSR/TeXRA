/**
 * XML utilities - barrel export.
 *
 * This module re-exports from focused submodules:
 * - xmlCdata: CDATA section handling
 * - xmlConversion: Format conversion (Pandoc, Turndown) with inlined format detection
 * - xmlExtraction: Content extraction from XML/LaTeX
 *
 * Import directly from the specific module when possible for better tree-shaking.
 */

// Re-export from CDATA module
export {
  removeCDATA,
  addCdataToTags,
  addCdataToTagsMultiple,
} from './xmlCdata';

// Re-export from conversion module
export { OutputFormat, formatContent } from './xmlConversion';

// Re-export from extraction module
export {
  DOCUMENT_NAME_REGEX,
  extractTextFromTag,
  extractMultipleTextFromTag,
  extractContentFromXMLbyTag,
  extractContentFromXMLbyTagMultiple,
  extractScratchpad,
  extractDocument,
  extractDocuments,
  type ExtractionResult,
  type MultipleExtractionResult,
} from './xmlExtraction';
