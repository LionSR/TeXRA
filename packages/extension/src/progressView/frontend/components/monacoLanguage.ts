const MONACO_LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.c': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.cs': 'csharp',
  '.css': 'css',
  '.cts': 'typescript',
  '.cxx': 'cpp',
  '.go': 'go',
  '.h': 'c',
  '.hpp': 'cpp',
  '.html': 'html',
  '.java': 'java',
  '.js': 'javascript',
  '.json': 'json',
  '.jsx': 'javascript',
  '.less': 'less',
  '.md': 'markdown',
  '.mdx': 'mdx',
  '.mjs': 'javascript',
  '.mts': 'typescript',
  '.php': 'php',
  '.py': 'python',
  '.rb': 'ruby',
  '.rs': 'rust',
  '.scss': 'scss',
  '.sh': 'shell',
  '.sql': 'sql',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.xml': 'xml',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.zsh': 'shell',
};

const MONACO_LANGUAGE_BY_BASENAME: Record<string, string> = {
  dockerfile: 'dockerfile',
};

const PLAINTEXT_LANGUAGE_ID = 'plaintext';

/**
 * Return a Monaco language id for syntax highlighting based on a file path.
 */
export function monacoLanguageForPath(filePath: string): string {
  const basename = filePath.split(/[\\/]/).at(-1)?.toLowerCase() ?? '';
  if (!basename) return PLAINTEXT_LANGUAGE_ID;

  const basenameLanguage = MONACO_LANGUAGE_BY_BASENAME[basename];
  if (basenameLanguage) return basenameLanguage;

  const extensionIndex = basename.lastIndexOf('.');
  if (extensionIndex <= 0) return PLAINTEXT_LANGUAGE_ID;

  const extension = basename.slice(extensionIndex);
  return MONACO_LANGUAGE_BY_EXTENSION[extension] ?? PLAINTEXT_LANGUAGE_ID;
}
