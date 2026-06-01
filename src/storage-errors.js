function collectErrorText(value, seen = new Set()) {
  if (!value || seen.has(value)) return [];
  if (typeof value === 'string') return [value];
  if (typeof value !== 'object') return [String(value)];

  seen.add(value);

  const parts = [];
  if (value.name) parts.push(value.name);
  if (value.code) parts.push(String(value.code));
  if (value.message) parts.push(value.message);
  if (value.stack) parts.push(value.stack);
  if (value.reason) parts.push(...collectErrorText(value.reason, seen));

  if (value.exception?.values) {
    for (const exception of value.exception.values) {
      parts.push(...collectErrorText(exception, seen));
    }
  }

  return parts;
}

function getErrorText(value) {
  return collectErrorText(value).join(' ');
}

function isLocalStorageUnavailableError(error) {
  const text = getErrorText(error).toLowerCase();
  if (!text) return false;

  return (
    text.includes('file_error_no_space') ||
    text.includes('quotaexceedederror') ||
    text.includes('quota exceeded') ||
    text.includes('no space left') ||
    text.includes('indexeddb.leveldb') ||
    text.includes('writablefileappend') ||
    (text.includes('unknownerror') && text.includes('indexeddb'))
  );
}

function getLocalStorageUnavailableUserMessage() {
  return 'DoneThat could not access local app storage. Free disk space, then restart DoneThat if sign-in or settings do not recover.';
}

module.exports = {
  getErrorText,
  getLocalStorageUnavailableUserMessage,
  isLocalStorageUnavailableError
};
