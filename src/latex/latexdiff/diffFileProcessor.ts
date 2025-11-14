// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - utilities
import replacementEngine from '@replacement/engine';

// Internal imports
import { flexibleFS } from '@utils/files';

// Local imports - replacement utils

export class DiffFileProcessor {
  constructor(private readonly channel: string) {}

  async processDiffFile(diffFileName: string): Promise<void> {
    try {
      const content = await flexibleFS.read(diffFileName);
      let processedContent = this.processStarEnvironments(content);
      processedContent = this.processLineByLine(processedContent);
      processedContent = replacementEngine.applyAll(processedContent);
      await flexibleFS.write(diffFileName, processedContent);
      await this.processTikzPictureEndings(diffFileName);
    } catch (err) {
      logger.error(
        this.channel,
        `Error processing diff file: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private processStarEnvironments(content: string): string {
    const starEnvironments = [
      'align\\*',
      'equation\\*',
      'gather\\*',
      'multline\\*',
      'flalign\\*',
      'alignat\\*',
    ];

    const envPattern = starEnvironments.join('|');
    const starEnvRegex = new RegExp(
      `\\\\begin\\{(${envPattern})\\}([\\s\\S]*?)\\\\end\\{\\1\\}`,
      'g',
    );

    return content.replace(starEnvRegex, (_match, envName, envContent) => {
      const cleanContent = envContent.replace(/\\label\{[^}]*\}/g, '');
      return `\\begin{${envName}}${cleanContent}\\end{${envName}}`;
    });
  }

  private processLineByLine(content: string): string {
    const lines = content.split('\n');
    let newContent = '';
    let addBlock = false;
    let documentStarted = false;

    const packagesToAddNewline = [
      '\\usepackage{tikz}',
      '\\usepackage{pgfplots}',
      '\\providecommand{\\DIFaddbegin}',
      '\\RequirePackage[normalem]{ulem}',
      '\\usetikzlibrary',
      '\\RequirePackage{color}',
    ];

    for (const line of lines) {
      // Skip TEX root comments
      if (
        line.startsWith('%!TEX root') ||
        line.startsWith('% !TEX root') ||
        line.startsWith('%! TEX root')
      ) {
        continue;
      }

      // Add newlines before specific packages
      if (packagesToAddNewline.some((pkg) => line.includes(pkg))) {
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
        newContent += line + '\n';
      }

      // Add extra newline after color package
      if (line.includes('\\RequirePackage{color}')) {
        newContent += '\n';
      }
    }

    return newContent;
  }

  private async processTikzPictureEndings(filePath: string): Promise<void> {
    const content = await flexibleFS.read(filePath);
    let newContent = content;

    const patterns = [
      [/\\end\{document\}\s*\\chapter/g, '\\chapter'],
      [/\\end\{document\}\s*\\addcontentsline/g, '\\addcontentsline'],
    ];

    for (const [pattern, replacement] of patterns) {
      newContent = newContent.replace(pattern, replacement as string);
    }

    await flexibleFS.write(filePath, newContent);
  }
}
