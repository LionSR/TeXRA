export function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export function uncapitalize(str) {
  return str.charAt(0).toLowerCase() + str.slice(1);
}

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/**
 * Formats a timestamp as a relative time string (e.g., "2 mins ago").
 * @param {number} timestamp - Unix epoch time in milliseconds
 * @returns {string} Human-readable relative time
 */
export function formatRelativeTime(timestamp) {
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

export function formatUpdatedDate(value) {
  if (!value) {
    return 'Updated: unknown';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Updated: unknown';
  }
  return `Updated ${DATE_TIME_FORMATTER.format(date)}`;
}

export function formatLineCount(count) {
  if (count === 1) {
    return '1 line';
  }
  return `${count} lines`;
}

export function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}
