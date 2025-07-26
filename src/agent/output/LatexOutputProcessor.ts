// Local imports - log
import { AgentLogger } from '@logger/AgentLogger';

// Local imports - utilities
import { runLatexFormatter } from '@latex/texFormatter';
import { LatexDiffManager } from './LatexDiffManager';
import { AgentSetting } from '@agent/core/AgentDataclass';

export class LatexOutputProcessor {
  private diffManager?: LatexDiffManager;

  constructor(
    private readonly agentSetting: AgentSetting,
    private readonly baseFiles: string[],
    private readonly logger: AgentLogger,
    private readonly channel: string,
    private outputFiles?: { [key: number]: string[] },
  ) {
    if (this.outputFiles) {
      this.diffManager = new LatexDiffManager(
        this.agentSetting,
        this.outputFiles,
        this.baseFiles,
        this.logger,
        this.channel,
      );
    }
  }

  public setOutputFilesRef(outputFiles: { [key: number]: string[] }): void {
    this.outputFiles = outputFiles;
    this.diffManager = new LatexDiffManager(
      this.agentSetting,
      outputFiles,
      this.baseFiles,
      this.logger,
      this.channel,
    );
  }

  /** Indents a LaTeX file for better readability */
  public async indentLatexFile(filePath: string): Promise<void> {
    if (!filePath.includes('.tex')) {
      return;
    }
    this.logger.debug(`Formatting ${filePath}`);
    await runLatexFormatter(filePath);
  }

  /** Indents multiple LaTeX files for better readability */
  public async indentLatexFiles(filePaths: string[]): Promise<void> {
    for (const filePath of filePaths) {
      await this.indentLatexFile(filePath);
    }
  }

  /** Runs all latexdiff comparisons for the current round. */
  public async handleLatexdiffofOutput(
    currRound: number,
    groupId?: string,
  ): Promise<void> {
    if (!this.diffManager) {
      this.logger.warn(
        'LatexOutputProcessor not initialized with output files',
      );
      return;
    }
    await this.diffManager.handleLatexdiffofOutput(currRound, groupId);
  }
}
