// Extracts user-visible text from a ~/Library/Messages/chat.db message row.
// Prefers the plain `text` column; falls back to a heuristic decode of
// `attributedBody`, the NeXTStep typedstream blob macOS Ventura+ writes for
// most outgoing messages.

export type ChatDbMessageTextColumns = {
  text: string | null
  attributedBody: Uint8Array | null
}

const NSSTRING_MARKER = Buffer.from('NSString', 'utf8')
const DECODE_SCAN_LIMIT_BYTES = 16_384
// Why: the typedstream blob interleaves the user text with metadata keys like
// "__kIMMessagePartAttributeName" — skip runs that are clearly metadata.
const METADATA_KEY_PREFIXES = ['__k', 'NSAttribute', 'NSColor', 'NSDictionary']

type PrintableRun = { start: number; length: number }

function isPrintableByte(byte: number): boolean {
  // ASCII printable + LF/CR, plus UTF-8 continuation (0x80-0xBF) and leading
  // (0xC2-0xF4) bytes so multi-byte characters stay inside one run.
  return (
    (byte >= 0x20 && byte < 0x7f) ||
    byte === 0x0a ||
    byte === 0x0d ||
    (byte >= 0x80 && byte < 0xc0) ||
    (byte >= 0xc2 && byte <= 0xf4)
  )
}

function collectPrintableRuns(buf: Buffer, from: number): PrintableRun[] {
  const runs: PrintableRun[] = []
  let runStart = -1
  let runLength = 0
  const end = Math.min(buf.length, from + DECODE_SCAN_LIMIT_BYTES)
  for (let index = from; index < end; index++) {
    if (isPrintableByte(buf[index])) {
      if (runStart < 0) {
        runStart = index
      }
      runLength++
    } else if (runLength > 0) {
      runs.push({ start: runStart, length: runLength })
      runStart = -1
      runLength = 0
    }
  }
  if (runLength > 0) {
    runs.push({ start: runStart, length: runLength })
  }
  return runs
}

function decodeAttributedBody(body: Uint8Array): string | null {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body)
  const markerIndex = buf.indexOf(NSSTRING_MARKER)
  if (markerIndex < 0) {
    return null
  }
  // The user text is the first printable run after the NSString marker that
  // is not a known metadata key.
  for (const run of collectPrintableRuns(buf, markerIndex + NSSTRING_MARKER.length)) {
    const text = buf
      .subarray(run.start, run.start + run.length)
      .toString('utf8')
      // eslint-disable-next-line no-control-regex -- stray typedstream length/control bytes ride along in the run
      .replace(/[\x00-\x08\x0B-\x1F\x7F]+/g, '')
      .trim()
    if (!text) {
      continue
    }
    if (METADATA_KEY_PREFIXES.some((prefix) => text.startsWith(prefix))) {
      continue
    }
    return text
  }
  return null
}

export function extractChatDbMessageText(row: ChatDbMessageTextColumns): string | null {
  if (typeof row.text === 'string' && row.text.length > 0) {
    return row.text
  }
  if (row.attributedBody && row.attributedBody.length > 0) {
    return decodeAttributedBody(row.attributedBody)
  }
  return null
}
