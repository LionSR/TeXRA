export interface RelayRpcError {
  message?: string;
}

/** Minimal Supabase RPC surface shared by relay enforcement helpers. */
export interface RelayRpcClient {
  // PromiseLike, not Promise: supabase-js rpc() returns a thenable builder.
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: RelayRpcError | null }>;
}
