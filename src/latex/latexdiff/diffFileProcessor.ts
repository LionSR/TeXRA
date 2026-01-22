// Local imports - log
import { toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
import replacementEngine from '@replacement/engine';
import { flexibleFS, type FileLocation } from '@utils/files';

/** LaTeX starred math environments that need label removal during diff processing. */
const STAR_ENVIRONMENTS = [
  'align\\*',
  'equation\\*',
  'gather\\*',
  'multline\\*',
  'flalign\\*',
  'alignat\\*',
];

/** Packages that need extra newlines added before them for readability. */
const PACKAGES_NEEDING_NEWLINE = [
  '\\usepackage{tikz}',
  '\\usepackage{pgfplots}',
  '\\providecommand{\\DIFaddbegin}',
  '\\RequirePackage[normalem]{ulem}',
  '\\usetikzlibrary',
  '\\RequirePackage{color}',
];

/** Patterns to fix broken document endings after latexdiff processing. */
const DOCUMENT_END_FIXES: Array<[RegExp, string]> = [
  [/\\end\{document\}\s*\\chapter/g, '\\chapter'],
  [/\\end\{document\}\s*\\addcontentsline/g, '\\addcontentsline'],
];

export class DiffFileProcessor {
  constructor(private readonly channel: string) {}

  async processDiffFile(diffFileLocation: FileLocation): Promise<void> {
    try {
      const content = await flexibleFS.read(diffFileLocation);
      let processedContent = this.processStarEnvironments(content);
      processedContent = this.processLineByLine(processedContent);
      processedContent = replacementEngine.applyAll(processedContent);
      await flexibleFS.write(diffFileLocation, processedContent);
      await this.processTikzPictureEndings(diffFileLocation);
    } catch (err) {
      logger.error(
        this.channel,
        `Error processing diff file: ${toErrorMessage(err)}`,
      );
    }
  }

  private processStarEnvironments(content: string): string {
    const envPattern = STAR_ENVIRONMENTS.join('|');
    const starEnvRegex = new RegExp(
      `\\\\begin\\{(${envPattern})\\}([\\s\\S]*?)\\\\end\\{\\1\\}`,
      'g',
    );

    return content.replaceAll(starEnvRegex, (_match, envName, envContent) => {
      const cleanContent = envContent.replaceAll(/\\label\{[^}]*\}/g, '');
      return `\\begin{${envName}}${cleanContent}\\end{${envName}}`;
    });
  }

  private processLineByLine(content: string): string {
    const lines = content.split('\n');
    let newContent = '';
    let addBlock = false;
    let documentStarted = false;

    for (const line of lines) {
      // Skip TEX root comments (handles various spacing: %!TEX, % !TEX, %! TEX)
      if (/^%\s?!\s?TEX root/.test(line)) {
        continue;
      }

      // Add newlines before specific packages
      if (PACKAGES_NEEDING_NEWLINE.some((pkg) => line.includes(pkg))) {
        newContent += '\n';
      }

      // Handle document structure
      if (line.includes('\\documentclass') || line.includes('\\input')) {
        addBlock = false;
        documentStarted = true;
      } else if (
        (line.includes('%DIF ADD') ||
          line.includes('Here is') ||
          line.includes('以下是')) &&
        !documentStarted
      ) {
        addBlock = true;
      }

      // Add line if not in add block
      if (!addBlock) {
        newContent += `${line}\n`;
      }

      // Add extra newline after color package
      if (line.includes('\\RequirePackage{color}')) {
        newContent += '\n';
      }
    }

    return newContent;
  }

  private async processTikzPictureEndings(
    fileLocation: FileLocation,
  ): Promise<void> {
    let content = await flexibleFS.read(fileLocation);

    for (const [pattern, replacement] of DOCUMENT_END_FIXES) {
      content = content.replace(pattern, replacement);
    }

    await flexibleFS.write(fileLocation, content);
  }
}
