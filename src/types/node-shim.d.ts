// Minimal Node.js type shims for environments where @types/node has not been
// installed. They are merged with the real definitions (when available) so
// they will not interfere with a full Node typing setup.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const Buffer: any;

type BufferEncoding =
  | 'ascii'
  | 'utf8'
  | 'utf-8'
  | 'utf16le'
  | 'ucs2'
  | 'ucs-2'
  | 'base64'
  | 'latin1'
  | 'binary'
  | 'hex'
  | string;