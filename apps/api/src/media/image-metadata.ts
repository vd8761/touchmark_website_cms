/**
 * Image dimensions read from file headers.
 *
 * Deliberately dependency-free. The alternative — sharp or ImageMagick — is a
 * native binary pulled in to read a handful of bytes we can read ourselves, and
 * it is only genuinely needed for the variant generation of §4.6, which belongs
 * on the job queue rather than in the upload request.
 *
 * Only the leading bytes of a file are ever inspected, so this stays constant
 * time regardless of file size.
 */

export interface ImageDimensions {
  width: number;
  height: number;
}

export function readImageDimensions(buffer: Buffer, mimeType: string): ImageDimensions | null {
  try {
    if (mimeType === 'image/png') return readPng(buffer);
    if (mimeType === 'image/jpeg') return readJpeg(buffer);
    if (mimeType === 'image/gif') return readGif(buffer);
    if (mimeType === 'image/webp') return readWebp(buffer);
    return null;
  } catch {
    // A truncated or malformed header is not worth failing an upload over —
    // the asset is still stored, just without dimensions.
    return null;
  }
}

function readPng(buffer: Buffer): ImageDimensions | null {
  // 8-byte signature, then an IHDR chunk whose data begins at offset 16.
  if (buffer.length < 24) return null;
  if (buffer.toString('hex', 0, 8) !== '89504e470d0a1a0a') return null;

  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function readJpeg(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;

  let offset = 2;
  while (offset < buffer.length - 9) {
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }

    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);

    // SOF0–SOF15 carry the frame dimensions. SOF4 (0xC4), SOF8 (0xC8) and
    // SOF12 (0xCC) are not frame headers despite sitting in the range.
    const isFrameHeader =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

    if (isFrameHeader) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }

    offset += 2 + length;
  }

  return null;
}

function readGif(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 10) return null;
  if (buffer.toString('ascii', 0, 3) !== 'GIF') return null;

  // Little-endian, unlike every other format here.
  return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
}

function readWebp(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 30) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') {
    return null;
  }

  const format = buffer.toString('ascii', 12, 16);

  // Lossy: 14-bit dimensions after a 3-byte sync code.
  if (format === 'VP8 ') {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }

  // Lossless: 14-bit dimensions packed across 4 bytes, minus one.
  if (format === 'VP8L') {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }

  // Extended: 24-bit dimensions minus one.
  if (format === 'VP8X') {
    const width = buffer.readUIntLE(24, 3) + 1;
    const height = buffer.readUIntLE(27, 3) + 1;
    return { width, height };
  }

  return null;
}

/**
 * Content sniffing (§18.2: "all uploads MIME-sniffed").
 *
 * A browser will render a file according to what its bytes look like, not what
 * the upload claimed — so an "image/png" that is actually HTML becomes stored
 * XSS. This compares the two and lets the caller reject the mismatch.
 */
const MAGIC: { mime: string; test: (b: Buffer) => boolean }[] = [
  { mime: 'image/png', test: (b) => b.toString('hex', 0, 8) === '89504e470d0a1a0a' },
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', test: (b) => b.toString('ascii', 0, 3) === 'GIF' },
  {
    mime: 'image/webp',
    test: (b) => b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
  },
  { mime: 'application/pdf', test: (b) => b.toString('ascii', 0, 4) === '%PDF' },
  { mime: 'video/mp4', test: (b) => b.toString('ascii', 4, 8) === 'ftyp' },
];

export function sniffMimeType(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;
  return MAGIC.find((entry) => entry.test(buffer))?.mime ?? null;
}

/**
 * True when the bytes look like markup a browser might execute. SVG is the
 * common case: it is a legitimate image format that can carry script, which is
 * why §18.2 calls out "SVG uploads sanitised" separately.
 */
export function looksLikeMarkup(buffer: Buffer): boolean {
  const head = buffer.toString('utf8', 0, Math.min(buffer.length, 1024)).trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<script');
}
