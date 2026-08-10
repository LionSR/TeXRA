// Local imports - common errors
import { detectStatusCode } from '@common/errors/sdkError/errorInspection';
import { attachSdkErrorMetadata } from '@common/errors/sdkError/errorMetadata';
import {
  sdkErrorKindFromStatusCode,
  type SdkErrorKind,
} from '@common/errors/sdkError/sdkErrorKinds';

type ErrorConstructor = abstract new (...args: any[]) => Error;

export interface SdkErrorClassMapping {
  ctor: ErrorConstructor;
  kind: SdkErrorKind;
}

function tagSdkError(
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
    const statusCode = detectStatusCode(err);
    tagSdkError(
      err,
      provider,
      sdkErrorKindFromStatusCode(statusCode),
      statusCode,
    );
  }
}
