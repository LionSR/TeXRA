const MODEL_FREE_PATHS = ['/v1/files', '/files', '/upload', '/v1beta/files'];

function hasPathPrefix(apiPath: string, prefix: string): boolean {
  return apiPath === prefix || apiPath.startsWith(prefix + '/');
}

function isGoogleInteractionsCancelPath(apiPath: string): boolean {
  return /^\/v\d+(?:[a-z]+)?\/interactions\/[^/]+:cancel$/.test(apiPath);
}

export function isRetiredGoogleGenerateContentPath(apiPath: string): boolean {
  return /^\/(?:v\d+(?:[a-z]+)?\/)?models\/[^/]+:(?:generateContent|streamGenerateContent|batchGenerateContent)$/.test(
    apiPath,
  );
}

export function isModelFreeRelayPath(apiPath: string): boolean {
  return (
    MODEL_FREE_PATHS.some((prefix) => hasPathPrefix(apiPath, prefix)) ||
    isGoogleInteractionsCancelPath(apiPath)
  );
}
