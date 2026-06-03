export const TEXRA_CLI_SUPPORTED_NODE_RANGE = '>=22.9.0';

export const TEXRA_CLI_SUPPORTED_NODE_RANGE_DISPLAY = (() => {
  const versions = TEXRA_CLI_SUPPORTED_NODE_RANGE.split(' || ');
  const finalVersion = versions.at(-1);

  return versions.length > 1 && finalVersion != null
    ? `${versions.slice(0, -1).join(', ')}, or ${finalVersion}`
    : TEXRA_CLI_SUPPORTED_NODE_RANGE;
})();
