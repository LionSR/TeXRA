function hasLabelToken(label, tokens) {
  return tokens.some((token) => {
    return new RegExp(`(^|[^a-z0-9])${token}([^a-z0-9]|$)`).test(label);
  });
}

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
    return ['darwin-x64', 'darwin-arm64'];
  }

  if (hasLabelToken(normalizedLabel, ['linux'])) {
    return [
      hasLabelToken(normalizedLabel, ['arm64', 'aarch64'])
        ? 'linux-arm64'
        : 'linux-x64',
    ];
  }

  if (hasLabelToken(normalizedLabel, ['win', 'win32', 'windows'])) {
    return [
      hasLabelToken(normalizedLabel, ['arm64', 'aarch64'])
        ? 'win32-arm64'
        : 'win32-x64',
    ];
  }

  return [];
}
