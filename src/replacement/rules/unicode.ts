// Local imports - replacement
import { NonRegexReplacementCategory } from '@replacement/types';

export const UNICODE_REPLACEMENTS: NonRegexReplacementCategory = {
  name: 'unicode',
  description:
    'Fixes for common non-math Unicode characters to LaTeX equivalents or for general cleanup (e.g., removing zero-width spaces). Math-specific Unicode is handled by a separate function within math environments.',
  isRegex: false,
  patterns: {
    // ===== Dash and hyphen replacements (globally safe) =====
    '–': '-', // en dash (U+2013) to ASCII hyphen (U+002D)
    '‑': '-', // non-breaking hyphen (U+2011) to ASCII hyphen (U+002D)
    '—': '-', // em dash (U+2014) to ASCII hyphen (U+002D)
    '‐': '-', // HYPHEN (U+2010) to ASCII hyphen (U+002D)
    // Note: Unicode MINUS SIGN U+2212 ('−') is handled by replaceMathUnicode

    // ===== Quote character replacements (globally safe) =====
    '\u2019': "'", // right single quote (U+2019) to ASCII apostrophe
    '\u2018': "'", // left single quote (U+2018) to ASCII apostrophe
    '\u201D': '"', // right double quote (U+201D) to ASCII double quote
    '\u201C': '"', // left double quote (U+201C) to ASCII double quote
    ʼ: "'", // MODIFIER LETTER APOSTROPHE (U+02BC)
    ʾ: "'", // MODIFIER LETTER RIGHT HALF RING (U+02BE) - sometimes misused as quote
    '՚': "'", // ARMENIAN APOSTROPHE (U+055A) - sometimes misused as quote

    // ===== Spacing and Ellipsis =====
    '\u00A0': '~', // Non-breaking space (U+00A0)
    '\u2026': '...', // Horizontal Ellipsis (U+2026) '…' to three periods
    '\u2000': ' ', // EN QUAD (U+2000)
    '\u2001': ' ', // EM QUAD (U+2001)
    '\u2002': ' ', // EN SPACE (U+2002)
    '\u2003': ' ', // EM SPACE (U+2003)
    '\u2004': ' ', // THREE-PER-EM SPACE (U+2004)
    '\u2005': ' ', // FOUR-PER-EM SPACE (U+2005)
    '\u2006': ' ', // SIX-PER-EM SPACE (U+2006)
    '\u2007': ' ', // FIGURE SPACE (U+2007)
    '\u2008': ' ', // PUNCTUATION SPACE (U+2008)
    '\u2009': ' ', // THIN SPACE (U+2009)
    '\u200A': ' ', // HAIR SPACE (U+200A)
    // '\u2028': '\n', // LINE SEPARATOR (U+2028) - User commented out
    // '\u2029': '\n', // PARAGRAPH SEPARATOR (U+2029) - User commented out

    // ===== Suspicious or Invisible Unicode Characters (to be removed) =====
    '\u00AD': '', // Soft Hyphen (U+00AD)
    '\u180E': '', // Mongolian Vowel Separator (U+180E)
    '\u200B': '', // Zero Width Space (U+200B)
    '\u200C': '', // Zero Width Non-Joiner (U+200C)
    '\u200D': '', // Zero Width Joiner (U+200D)
    '\u200E': '', // Left-to-Right Mark (U+200E)
    '\u200F': '', // Right-to-Left Mark (U+200F)
    '\u202A': '', // Left-to-Right Embedding (U+202A)
    '\u202B': '', // Right-to-Left Embedding (U+202B)
    '\u202C': '', // Pop Directional Formatting (U+202C)
    '\u202D': '', // Left-to-Right Override (U+202D)
    '\u202E': '', // Right-to-Left Override (U+202E)
    '\u2060': '', // Word Joiner (U+2060)
    '\u2066': '', // Left-to-Right Isolate (U+2066)
    '\u2067': '', // Right-to-Left Isolate (U+2067)
    '\u2068': '', // First Strong Isolate (U+2068)
    '\u2069': '', // Pop Directional Isolate (U+2069)
    '\uFEFF': '', // Zero Width No-Break Space (BOM) (U+FEFF)

    // ===== Common Symbols to ASCII or simple representation =====
    '\u2022': '*', // BULLET (U+2022) '•' to asterisk
    // '\u00B9': '1', // SUPERSCRIPT ONE (U+00B9) '¹' to '1'
    // '\u00B2': '2', // SUPERSCRIPT TWO (U+00B2) '²' to '2'
    '\u00BD': '1/2', // VULGAR FRACTION ONE HALF (U+00BD) '½' to '1/2'
    '\u2713': '\\checkmark', // CHECK MARK (U+2713) '✓' to \checkmark
    // '™': '\\texttrademark{}', - User commented out
    // '®': '\\textregistered{}', - User commented out
    // '©': '\\textcopyright{}', - User commented out

    // ===== Accented Latin Characters to LaTeX Commands =====
    '\u00E1': "\\'a", // LATIN SMALL LETTER A WITH ACUTE (U+00E1) 'á'
    '\u00E9': "\\'e", // LATIN SMALL LETTER E WITH ACUTE (U+00E9) 'é'
    '\u00ED': "\\'i", // LATIN SMALL LETTER I WITH ACUTE (U+00ED) 'í' (from general knowledge, not in list)
    '\u00F3': "\\'o", // LATIN SMALL LETTER O WITH ACUTE (U+00F3) 'ó'
    '\u00FA': "\\'u", // LATIN SMALL LETTER U WITH ACUTE (U+00FA) 'ú' (from general knowledge, not in list)
    '\u00E0': '\\`a', // LATIN SMALL LETTER A WITH GRAVE (U+00E0) 'à' (from general knowledge, not in list)
    '\u00E8': '\\`e', // LATIN SMALL LETTER E WITH GRAVE (U+00E8) 'è' (from general knowledge, not in list)
    '\u00EC': '\\`i', // LATIN SMALL LETTER I WITH GRAVE (U+00EC) 'ì' (from general knowledge, not in list)
    '\u00F2': '\\`o', // LATIN SMALL LETTER O WITH GRAVE (U+00F2) 'ò' (from general knowledge, not in list)
    '\u00F9': '\\`u', // LATIN SMALL LETTER U WITH GRAVE (U+00F9) 'ù' (from general knowledge, not in list)
    '\u00E2': '\\^a', // LATIN SMALL LETTER A WITH CIRCUMFLEX (U+00E2) 'â' (from general knowledge, not in list)
    '\u00EA': '\\^e', // LATIN SMALL LETTER E WITH CIRCUMFLEX (U+00EA) 'ê' (from general knowledge, not in list)
    '\u00EE': '\\^i', // LATIN SMALL LETTER I WITH CIRCUMFLEX (U+00EE) 'î' (from general knowledge, not in list)
    '\u00F4': '\\^o', // LATIN SMALL LETTER O WITH CIRCUMFLEX (U+00F4) 'ô'
    '\u00FB': '\\^u', // LATIN SMALL LETTER U WITH CIRCUMFLEX (U+00FB) 'û' (from general knowledge, not in list)
    '\u00E4': '\\"a', // LATIN SMALL LETTER A WITH DIAERESIS (U+00E4) 'ä' (from general knowledge, not in list)
    '\u00EB': '\\"e', // LATIN SMALL LETTER E WITH DIAERESIS (U+00EB) 'ë' (from general knowledge, not in list)
    '\u00EF': '\\"i', // LATIN SMALL LETTER I WITH DIAERESIS (U+00EF) 'ï' (from general knowledge, not in list)
    // '\u00F6': '\\"o', // LATIN SMALL LETTER O WITH DIAERESIS (U+00F6) 'ö'
    '\u00FC': '\\"u', // LATIN SMALL LETTER U WITH DIAERESIS (U+00FC) 'ü' (from general knowledge, not in list)
    '\u00E3': '\\~a', // LATIN SMALL LETTER A WITH TILDE (U+00E3) 'ã'
    '\u00F1': '\\~n', // LATIN SMALL LETTER N WITH TILDE (U+00F1) 'ñ' (from general knowledge, not in list)
    '\u00F5': '\\~o', // LATIN SMALL LETTER O WITH TILDE (U+00F5) 'õ' (from general knowledge, not in list)
    '\u00C1': "\\'A", // LATIN CAPITAL LETTER A WITH ACUTE (U+00C1) 'Á' (from general knowledge, not in list)
    '\u00C9': "\\'E", // LATIN CAPITAL LETTER E WITH ACUTE (U+00C9) 'É' (from general knowledge, not in list)
    '\u00D3': "\\'O", // LATIN CAPITAL LETTER O WITH ACUTE (U+00D3) 'Ó' (from general knowledge, not in list)
    '\u00D4': '\\^O', // LATIN CAPITAL LETTER O WITH CIRCUMFLEX (U+00D4) 'Ô' (from general knowledge, not in list)
    '\u00D6': '\\"O', // LATIN CAPITAL LETTER O WITH DIAERESIS (U+00D6) 'Ö' (from general knowledge, not in list)
    '\u00C3': '\\~A', // LATIN CAPITAL LETTER A WITH TILDE (U+00C3) 'Ã' (from general knowledge, not in list)
    '\u014C': '\\=O', // LATIN CAPITAL LETTER O WITH MACRON (U+014C) 'Ō' (from general knowledge, not in list)
    '\u014D': '\\=o', // LATIN SMALL LETTER O WITH MACRON (U+014D) 'ō'
    '\u00C7': '\\c C', // LATIN CAPITAL LETTER C WITH CEDILLA (U+00C7) 'Ç' (from general knowledge, not in list)
    '\u00E7': '\\c c', // LATIN SMALL LETTER C WITH CEDILLA (U+00E7) 'ç' (from general knowledge, not in list)

    // ===== Homoglyph Normalization (Context dependent, use with care) =====
    '\u043E': 'o', // CYRILLIC SMALL LETTER O (U+043E) 'о' to Latin 'o'
    '\u0435': 'e', // CYRILLIC SMALL LETTER IE (U+0435) 'е' to Latin 'e'
    '\u0430': 'a', // CYRILLIC SMALL LETTER A (U+0430) 'а' to Latin 'a' (from general knowledge, not in list)
    // Add more Cyrillic or other homoglyphs here if needed

    // Other math symbols like arrows (→), degree (°), μ (general), ±, ×, ÷
    // are handled by replaceMathUnicode within math environments.

    // ===== Greek letter replacements (moved by user) =====
    // Fix micro unit symbols with proper math mode
    '$ μs': '$ $\\mu$s', // micro (μ U+03BC) to \mu
    '$ μm': '$ $\\mu$m',
    '$ μA': '$ $\\mu$A',
    '$ μV': '$ $\\mu$V',
    '$ μW': '$ $\\mu$W',
    '$ μT': '$ $\\mu$T',
    '$ μH': '$ $\\mu$H',
    '$ μF': '$ $\\mu$F',
  },
};
