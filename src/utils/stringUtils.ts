export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export function uncapitalize(str: string): string {
  return str.charAt(0).toLowerCase() + str.slice(1);
}

export function objectToLogString(obj: any, maxLength: number = 1000): string {
  try {
    const json = JSON.stringify(obj);
    return json.length > maxLength
      ? `${json.substring(0, maxLength)}... (${json.length} chars)`
      : json;
  } catch {
    return String(obj);
  }
}
