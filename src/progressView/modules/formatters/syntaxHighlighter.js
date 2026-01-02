/**
 * Syntax highlighting utilities for tool output display.
 * Uses highlight.js for code highlighting with automatic language detection.
 */

import hljs from 'highlight.js';

// Register only commonly used languages for tool output
// Full list would be too heavy for the webview
const REGISTERED_LANGUAGES = [
  'json',
  'yaml',
  'bash',
  'shell',
  'python',
  'javascript',
  'typescript',
  'latex',
  'diff',
  'xml',
  'markdown',
];

/**
 * Detect the likely language of a code string.
 * Uses heuristics before falling back to highlight.js auto-detection.
 * @param {string} code - The code to analyze
 * @returns {string|null} Detected language or null
 */
export const detectLanguage = (code) => {
  if (!code || typeof code !== 'string') {
    return null;
  }

  const trimmed = code.trim();

  // JSON detection - starts with { or [
  if (/^[\[{]/.test(trimmed)) {
    try {
      JSON.parse(trimmed);
      return 'json';
    } catch {
      // Not valid JSON, might still be JSON-like
      if (/^{[\s\S]*}$/.test(trimmed) || /^\[[\s\S]*\]$/.test(trimmed)) {
        return 'json';
      }
    }
  }

  // YAML detection - key: value patterns or starts with ---
  if (/^---\s*$/.test(trimmed.split('\n')[0]) || /^\w+:\s+\S/.test(trimmed)) {
    return 'yaml';
  }

  // Diff detection - starts with diff, @@, +, or -
  if (/^(diff|@@|\+\+\+|---|\+[^+]|-[^-])/.test(trimmed)) {
    return 'diff';
  }

  // Shell/bash detection - common patterns
  if (/^(\$|#!\/bin\/(ba)?sh|npm |yarn |git |cd |ls |cat |echo )/.test(trimmed)) {
    return 'bash';
  }

  // LaTeX detection
  if (/\\(begin|end|documentclass|usepackage|section|chapter)\{/.test(trimmed)) {
    return 'latex';
  }

  // XML/HTML detection
  if (/^<[?!]?\w+/.test(trimmed) && /<\/\w+>/.test(trimmed)) {
    return 'xml';
  }

  // Python detection - common patterns
  if (/^(def |class |import |from |if __name__|print\()/.test(trimmed)) {
    return 'python';
  }

  // JavaScript/TypeScript detection
  if (/^(const |let |var |function |import |export |=>)/.test(trimmed)) {
    return 'javascript';
  }

  // For short content, don't auto-detect (too unreliable)
  if (trimmed.length < 50) {
    return null;
  }

  // Try highlight.js auto-detection for longer content
  try {
    const result = hljs.highlightAuto(trimmed, REGISTERED_LANGUAGES);
    // Only trust auto-detection if relevance is high enough
    if (result.relevance > 5) {
      return result.language || null;
    }
  } catch {
    // Auto-detection failed, return null
  }

  return null;
};

/**
 * Highlight code with syntax coloring.
 * @param {string} code - The code to highlight
 * @param {string|null} [language] - Optional language hint (auto-detects if not provided)
 * @returns {{html: string, language: string|null}} Highlighted HTML and detected language
 */
export const highlightCode = (code, language = null) => {
  if (!code || typeof code !== 'string') {
    return { html: '', language: null };
  }

  const detectedLang = language || detectLanguage(code);

  if (!detectedLang) {
    // No language detected, return plain text (will be HTML-encoded by caller)
    return { html: code, language: null };
  }

  try {
    const result = hljs.highlight(code, {
      language: detectedLang,
      ignoreIllegals: true,
    });
    return { html: result.value, language: detectedLang };
  } catch {
    // Highlighting failed, return plain text
    return { html: code, language: null };
  }
};

/**
 * Check if code should be highlighted based on content type.
 * @param {string} code - The code to check
 * @returns {boolean} True if highlighting is recommended
 */
export const shouldHighlight = (code) => {
  if (!code || typeof code !== 'string') {
    return false;
  }

  // Skip very short content
  if (code.trim().length < 20) {
    return false;
  }

  // Skip if it looks like plain prose (high ratio of spaces and lowercase letters)
  const proseScore =
    (code.match(/[a-z ]/g) || []).length / Math.max(code.length, 1);
  if (proseScore > 0.8) {
    return false;
  }

  return detectLanguage(code) !== null;
};
