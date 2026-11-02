/**
 * Prompt framing (protocol-stack.md, "Framing").
 *
 * RESEARCH PROTOTYPE. Bytes are accumulated across chunks; a response is
 * complete only when the adapter's ">" prompt arrives, never at a chunk
 * boundary. A response that grows past the byte cap without a prompt is an
 * overflow: the framer stops keeping bytes, keeps counting them, and resumes
 * at the next ">" so the next response starts clean.
 */
import { bytesToText } from "../bytes";

export const PROMPT = 0x3e; // ">"
export const DEFAULT_RESPONSE_BYTE_CAP = 4096;

export type FramedResponse = {
  /** The exact bytes before the prompt, as text (one byte per character), up to the cap. */
  text: string;
  /** Non-empty lines: split on CR and/or LF, NUL bytes dropped, surrounding blanks trimmed. */
  lines: string[];
  /** The cap was exceeded: `text` is truncated and the response is unusable. */
  overflowed: boolean;
  /** Bytes received for this response, including any dropped after the cap. */
  byteCount: number;
};

export type FramerEvent = { type: "response"; response: FramedResponse } | { type: "overflow" };

/** Splits response text into lines (framing rule 2). */
export function splitLines(text: string): string[] {
  return text
    .replace(/\0/g, "")
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export class PromptFramer {
  private buffer: number[] = [];
  private overflowed = false;
  private byteCount = 0;

  constructor(readonly byteCap: number = DEFAULT_RESPONSE_BYTE_CAP) {
    if (!Number.isInteger(byteCap) || byteCap < 1) throw new RangeError("byteCap must be a positive integer");
  }

  /** Feeds one chunk; returns the events it completed, in order. */
  push(chunk: Uint8Array): FramerEvent[] {
    const events: FramerEvent[] = [];
    for (const byte of chunk) {
      if (byte === PROMPT) {
        const text = bytesToText(this.buffer);
        events.push({
          type: "response",
          response: { text, lines: splitLines(text), overflowed: this.overflowed, byteCount: this.byteCount },
        });
        this.reset();
        continue;
      }
      this.byteCount++;
      if (this.overflowed) continue;
      this.buffer.push(byte);
      if (this.buffer.length > this.byteCap) {
        this.overflowed = true;
        events.push({ type: "overflow" });
      }
    }
    return events;
  }

  /** Bytes received since the last prompt. */
  get pendingBytes(): number {
    return this.byteCount;
  }

  /** Bytes since the last prompt passed the cap; `pendingText()` is truncated. */
  get overflowing(): boolean {
    return this.overflowed;
  }

  /** The kept text received since the last prompt. */
  pendingText(): string {
    return bytesToText(this.buffer);
  }

  private reset(): void {
    this.buffer = [];
    this.overflowed = false;
    this.byteCount = 0;
  }
}
