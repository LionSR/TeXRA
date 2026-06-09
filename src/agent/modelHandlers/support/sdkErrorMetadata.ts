// Local imports - common errors
import {
  attachSdkErrorMetadata,
  sdkErrorKindFromStatusCode,
  type SdkErrorKind,
} from '@common/errors/sdkErrorUtils';

export type ErrorConstructor = abstract new (...args: any[]) => Error;

export interface SdkErrorClassMapping {
  ctor: ErrorConstructor;
  kind: SdkErrorKind;
}

export function tagSdkError(
  err: unknown,
  provider: string,
  kind: SdkErrorKind,
  statusCode?: number,
): void {
  attachSdkErrorMetadata(err, {
    provider,
    kind,
    ...(statusCode !== undefined && { statusCode }),
  });
}

export function matchMappedSdkError(
  err: unknown,
  provider: string,
  mappings: readonly SdkErrorClassMapping[],
  apiErrorCtor?: ErrorConstructor,
): void {
  for (const { ctor, kind } of mappings) {
    if (err instanceof ctor) {
      tagSdkError(err, provider, kind);
      return;
    }
  }

  if (apiErrorCtor && err instanceof apiErrorCtor) {
    const statusCode = sdkErrorStatusCode(err);
    tagSdkError(
      err,
      provider,
      sdkErrorKindFromStatusCode(statusCode),
      statusCode,
    );
  }
}

export function sdkErrorStatusCode(err: unknown): number | undefined {
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' && Number.isFinite(status)
    ? status
    : undefined;
}
