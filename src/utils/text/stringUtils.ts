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

/**
 * Formats a timestamp as a relative time string (e.g., "2 mins ago").
 * @param timestamp Unix epoch time in milliseconds
 */
export function formatRelativeTime(timestamp?: number): string {
  if (!timestamp) return '';
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes === 1) return '1 min ago';
  if (minutes < 60) return `${minutes} mins ago`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return '1 hr ago';
  if (hours < 24) return `${hours} hrs ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}
