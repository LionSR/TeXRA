declare module 'diff' {
  export function diffLines(oldStr: string, newStr: string): Array<{ added?: boolean; removed?: boolean; value: string; count?: number }>;
}
