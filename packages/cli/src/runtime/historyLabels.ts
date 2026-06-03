export function formatCliHistoryInputLabel(inputBasename: string): string {
  return inputBasename === '-' ? 'no input' : inputBasename;
}
