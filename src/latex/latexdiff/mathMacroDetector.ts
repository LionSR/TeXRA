// Standard library imports

// Local imports - utilities
import { WorkspaceFS } from '@utils/files';

/**
 * Collects user-defined macros that are used inside math mode.
 *
 * The function scans the provided LaTeX source file for math segments
 * (inline `$...$`, `\(...\)`, `\[...\]`, and common math environments)
 * and gathers macro names that both appear in these segments and are
 * defined via `\newcommand`, `\renewcommand`, `\providecommand`, `\def`,
 * or `\DeclareMathOperator`. Definitions can be located in the main
 * `.tex` file or the accompanying `.aux` file.
 *
 * The returned list is sorted and de-duplicated.
 */
export async function collectMathMacros(
  texPath: string,
  auxPath?: string,
): Promise<string[]> {
  const definedMacros = new Set<string>();

  const addDefinitions = (content: string): void => {
    const defPatterns = [
      /\\(?:newcommand|renewcommand|providecommand)\s*{\\([A-Za-z@]+)}/g,
      /\\def\\([A-Za-z@]+)\b/g,
      /\\DeclareMathOperator\s*{\\([A-Za-z@]+)}/g,
    ];
    for (const pattern of defPatterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        definedMacros.add(match[1]);
      }
    }
  };

  const texContent = await WorkspaceFS.readFile(texPath);
  addDefinitions(texContent);

  if (auxPath && (await WorkspaceFS.exists(auxPath))) {
    const auxContent = await WorkspaceFS.readFile(auxPath);
    addDefinitions(auxContent);
  }

  const mathSegments: string[] = [];
  const inlinePatterns = [
    /\$(?:[^$\\]|\\.)*?\$/gs,
    /\\\((?:[^\\]|\\.)*?\\\)/gs,
    /\\\[(?:[^\\]|\\.)*?\\\]/gs,
  ];
  for (const pattern of inlinePatterns) {
    mathSegments.push(...(texContent.match(pattern) ?? []));
  }

  const envNames = [
    'equation',
    'align',
    'align\*',
    'gather',
    'multline',
    'flalign',
    'alignat',
  ];
  const envRegex = new RegExp(
    `\\\begin\\{(${envNames.join('|')})\\}([\\s\\S]*?)\\\end\\{\\1\\}`,
    'g',
  );
  let envMatch: RegExpExecArray | null;
  while ((envMatch = envRegex.exec(texContent)) !== null) {
    mathSegments.push(envMatch[2]);
  }

  const usedMacros = new Set<string>();
  const macroRegex = /\\([A-Za-z@]+)/g;
  for (const segment of mathSegments) {
    let match: RegExpExecArray | null;
    while ((match = macroRegex.exec(segment)) !== null) {
      const name = match[1];
      if (definedMacros.has(name)) {
        usedMacros.add(name);
      }
    }
  }

  return Array.from(usedMacros).sort();
}
