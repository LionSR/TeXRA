export const TEXRA_PROTOCOL = 'texra';
export const TEXRA_PROTOCOL_SCHEME = `${TEXRA_PROTOCOL}:`;

export function isDesktopProtocolUrl(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).protocol === TEXRA_PROTOCOL_SCHEME;
  } catch {
    return false;
  }
}
