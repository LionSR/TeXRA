export interface AuthServiceLogger {
  info(channel: string, message: string): void;
  error(channel: string, message: string): void;
}

export const NOOP_AUTH_SERVICE_LOGGER: AuthServiceLogger = {
  info(channel, message) {
    void channel;
    void message;
  },
  error(channel, message) {
    void channel;
    void message;
  },
};
