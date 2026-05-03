export interface DiffSource {
  filePath: string;
}

export interface DiffSession {
  original: DiffSource;
  proposed: DiffSource;
  title: string;
}

export interface DiffOptions {
  preserveFocus?: boolean;
}

export interface DiffViewHost {
  openDiff(
    original: DiffSource,
    proposed: DiffSource,
    title: string,
    options?: DiffOptions,
  ): Promise<DiffSession>;
  closeDiff(session: DiffSession): Promise<void>;
  revealFirstChange(session: DiffSession, line: number): Promise<void>;
  readProposedContent(
    session: DiffSession,
    fallbackContent: string,
  ): Promise<string>;
}
