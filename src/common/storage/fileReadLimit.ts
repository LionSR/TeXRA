/** An optional consumer limit stopped a file read before decoding its payload. */
export class FileReadLimitError extends Error {
  constructor(readonly limit: 'bytes' | 'rows') {
    super(`File exceeds the requested ${limit} read limit.`);
    this.name = 'FileReadLimitError';
  }
}
