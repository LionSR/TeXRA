const TEXRA_CLI_SUPPORTED_NODE_RANGE = '>=22.9.0';

export const TEXRA_CLI_SUPPORTED_NODE_RANGE_DISPLAY = formatNodeRangeForDisplay(
  TEXRA_CLI_SUPPORTED_NODE_RANGE,
);

function formatNodeRangeForDisplay(range: string): string {
  const versions = range.split(' || ');
  const finalVersion = versions.at(-1);

  return versions.length > 1 && finalVersion != null
    ? `${versions.slice(0, -1).join(', ')}, or ${finalVersion}`
    : range;
}
