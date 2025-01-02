export function extractTextFromTags(
  inputContent: string,
  documentTag: string,
): string {
  const regex = new RegExp(`<${documentTag}>(.*?)<\/${documentTag}>`, 's');
  const match = inputContent.match(regex);
  return match ? match[1] : inputContent;
}
