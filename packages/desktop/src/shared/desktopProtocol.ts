export const TEXRA_PROTOCOL = 'texra';
export const TEXRA_PROTOCOL_SCHEME = `${TEXRA_PROTOCOL}:`;

// Deliberately import-free: this module is bundled into the preload script,
// whose nodenext resolution can't follow the workspace path aliases.
export function isDesktopProtocolUrl(rawUrl: string): boolean {
  return (
    URL.canParse(rawUrl) && new URL(rawUrl).protocol === TEXRA_PROTOCOL_SCHEME
  );
}
