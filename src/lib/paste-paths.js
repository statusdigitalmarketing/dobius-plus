// Helpers shared by the terminal command bar and the Chat composer for turning
// pasted or dropped files into prompt text.

/** Escape a file path for safe shell usage (wraps in single quotes). */
export function shellEscape(filePath) {
  return "'" + filePath.replace(/'/g, "'\\''") + "'";
}

/** Convert ArrayBuffer to base64 without blowing the call stack on large images. */
export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
