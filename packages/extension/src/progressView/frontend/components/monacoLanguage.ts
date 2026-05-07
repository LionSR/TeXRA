// Local imports - progress view helpers
import {
  languageForPath,
  SPECIAL_BASENAME_LANGUAGES,
} from '@progressView/frontend/languageForPath';

const MONACO_LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  c: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  cts: 'typescript',
  cxx: 'cpp',
  go: 'go',
  h: 'c',
  hpp: 'cpp',
  html: 'html',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsx: 'javascript',
  less: 'less',
  md: 'markdown',
  mdx: 'mdx',
  mjs: 'javascript',
  mts: 'typescript',
  php: 'php',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  scss: 'scss',
  sh: 'shell',
  sql: 'sql',
  ts: 'typescript',
  tsx: 'typescript',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'shell',
};

const PLAINTEXT_LANGUAGE_ID = 'plaintext';

/**
 * Return a Monaco language id for syntax highlighting based on a file path.
 */
export function monacoLanguageForPath(filePath: string): string {
  return languageForPath(filePath, {
    basenameLanguages: SPECIAL_BASENAME_LANGUAGES,
    extensionLanguages: MONACO_LANGUAGE_BY_EXTENSION,
    fallbackLanguage: PLAINTEXT_LANGUAGE_ID,
  });
}
