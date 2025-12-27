/**
 * XML utilities - barrel export for backward compatibility.
 *
 * This module re-exports from focused submodules:
 * - xmlCdata: CDATA section handling
 * - xmlFormatDetection: Format detection (HTML, LaTeX, Markdown)
 * - xmlConversion: Format conversion (Pandoc, Turndown)
 * - xmlExtraction: Content extraction from XML/LaTeX
 *
 * New code should import directly from the specific module when possible.
 */

// Import for default export object
import {
  removeCDATA,
  addCdataToTags,
  addCdataToTagsMultiple,
} from './xmlCdata';
import { formatContent } from './xmlConversion';
import {
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
} from './xmlExtraction';

// Re-export from CDATA module
export { removeCDATA, addCdataToTags, addCdataToTagsMultiple } from './xmlCdata';

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

// Default export for backward compatibility
export const xmlUtils = {
  removeCDATA,
  addCdataToTags,
  addCdataToTagsMultiple,
  extractTextFromTag,
  extractLatexFromMarkdown,
  extractLatexBetweenDocumentClass,
  extractMultipleTextFromTag,
  filterTagsFromText,
  extractContentFromXMLbyTag,
  extractContentFromXMLbyTagMultiple,
  formatContent,
  extractScratchpad,
  extractDocument,
  extractDocuments,
};

export default xmlUtils;
