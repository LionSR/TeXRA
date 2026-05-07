export interface ClipboardHost {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
}
