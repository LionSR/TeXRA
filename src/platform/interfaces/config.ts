/**
 * Platform configuration provider interface.
 */
export interface ConfigProvider {
  get<T>(key: string, defaultValue?: T): T;
}
