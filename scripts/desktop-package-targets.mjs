export function expectedCodexPlatformKeysFromLabel(label) {
  const normalizedLabel = label.replaceAll('\\', '/').toLowerCase();
  if (normalizedLabel.includes('.app/contents/resources/app')) {
    if (
      normalizedLabel.includes('mac-arm64') ||
      normalizedLabel.includes('darwin-arm64')
    ) {
      return ['darwin-arm64'];
    }
    if (
      normalizedLabel.includes('mac-x64') ||
      normalizedLabel.includes('darwin-x64')
    ) {
      return ['darwin-x64'];
    }
    if (normalizedLabel.includes('universal')) {
      return ['darwin-x64', 'darwin-arm64'];
    }
    return ['darwin-x64', 'darwin-arm64'];
  }

  if (normalizedLabel.includes('linux')) {
    return [
      normalizedLabel.includes('arm64') || normalizedLabel.includes('aarch64')
        ? 'linux-arm64'
        : 'linux-x64',
    ];
  }

  if (normalizedLabel.includes('win')) {
    return [
      normalizedLabel.includes('arm64') || normalizedLabel.includes('aarch64')
        ? 'win32-arm64'
        : 'win32-x64',
    ];
  }

  return [];
}
