export const HOME_DIRECTORY_KEYS: readonly string[];

export function isolatedHomeEnv(home: string): Record<string, string>;

export function testLaunchEnv(home: string): Record<string, string>;

export function isolateProcessHome(): string;
