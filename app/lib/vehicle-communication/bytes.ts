/**
 * Byte/text conversion for the adapter link. One byte is one character
 * (Latin-1), both ways, so raw bytes survive into the recorded text unchanged.
 */

/** Encodes text whose characters are all below U+0100; refuses anything else. */
export function textToBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0xff) throw new RangeError("text is not single-byte");
    bytes[i] = code;
  }
  return bytes;
}

export function bytesToText(bytes: ArrayLike<number>): string {
  let text = "";
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
  return text;
}
