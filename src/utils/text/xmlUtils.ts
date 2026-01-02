/**
 * XML utilities - barrel export.
 *
 * This module re-exports from focused submodules:
 * - xmlCdata: CDATA section handling
 * - xmlFormatDetection: Format detection (HTML, LaTeX, Markdown)
 * - xmlConversion: Format conversion (Pandoc, Turndown)
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

// Re-export from format detection module
export {
  OutputFormat,
  detectInputFormat,
  containsHtml,
  containsLatex,
} from './xmlFormatDetection';

// Re-export from conversion module
export {
  convertLatexToMarkdown,
  convertHtmlToMarkdown,
  convertWithPandoc,
  formatContent,
} from './xmlConversion';

// Re-export from extraction module
export {
  DOCUMENT_NAME_REGEX,
  extractTextFromTag,
  extractLatexFromMarkdown,
  extractLatexBetweenDocumentClass,
  extractMultipleTextFromTag,
  filterTagsFromText,
  extractContentFromXMLbyTag,
  extractContentFromXMLbyTagMultiple,
  extractScratchpad,
  extractDocument,
  extractDocuments,
  type ExtractionResult,
  type MultipleExtractionResult,
} from './xmlExtraction';
