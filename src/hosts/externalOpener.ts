export interface ExternalOpener {
  openExternal(url: string): Promise<void>;
  openPath(filePath: string): Promise<void>;
}
