/**
 * Scanner foundation (S2, S3): prompt framing and response classification.
 *
 * Design: docs/research/scanner-engine/protocol-stack.md ("Framing", "Adapter
 * error tokens"). Simulated test matrix rows 1-3 and 5 (framer) and the token
 * table behind rows 6-9 (classifier). Pure: no transport, no timers.
 */
import { describe, expect, it } from "vitest";
import { textToBytes } from "../app/lib/vehicle-communication/bytes";
import { classifyResponse, tokenOutcome } from "../app/lib/vehicle-communication/elm/classify";
import { PromptFramer, splitLines, type FramedResponse, type FramerEvent } from "../app/lib/vehicle-communication/elm/framer";

const REPLY = "7E8 06 41 00 BE 3F A8 13\r7E9 06 41 00 98 18 80 11\r\r>";

/** Deterministic pseudo-random chunk sizes (no Math.random in tests). */
function* lcg(seed: number): Generator<number> {
  let state = seed;
  for (;;) {
    state = (state * 48271) % 2147483647; // MINSTD: exact in double precision
    yield state;
  }
}

function feed(framer: PromptFramer, chunks: string[]): FramerEvent[] {
  return chunks.flatMap((chunk) => framer.push(textToBytes(chunk)));
}

function responses(events: FramerEvent[]): FramedResponse[] {
  return events.flatMap((event) => (event.type === "response" ? [event.response] : []));
}

describe("prompt framer", () => {
  const whole = responses(new PromptFramer().push(textToBytes(REPLY)));

  it("completes a response only at the prompt", () => {
    const framer = new PromptFramer();
    expect(framer.push(textToBytes(REPLY.slice(0, -1)))).toEqual([]);
    expect(framer.pendingBytes).toBe(REPLY.length - 1);
    expect(responses(framer.push(textToBytes(">")))).toEqual(whole);
    expect(whole).toHaveLength(1);
    expect(whole[0].lines).toEqual(["7E8 06 41 00 BE 3F A8 13", "7E9 06 41 00 98 18 80 11"]);
    expect(whole[0].text).toBe(REPLY.slice(0, -1));
    expect(framer.pendingBytes).toBe(0);
  });

  it("row 1: any split into 1-20 byte chunks, prompt in its own chunk, gives the same result", () => {
    const random = lcg(20261026);
    for (let trial = 0; trial < 200; trial++) {
      const body = REPLY.slice(0, -1);
      const chunks: string[] = [];
      for (let i = 0; i < body.length; ) {
        const size = 1 + (random.next().value % 20);
        chunks.push(body.slice(i, i + size));
        i += size;
      }
      chunks.push(">");
      expect(responses(feed(new PromptFramer(), chunks)), chunks.join("|")).toEqual(whole);
    }
    for (let size = 1; size <= 20; size++) {
      const chunks = Array.from({ length: Math.ceil(REPLY.length / size) }, (_, i) => REPLY.slice(i * size, (i + 1) * size));
      expect(responses(feed(new PromptFramer(), chunks))).toEqual(whole);
    }
  });

  it("row 2: two lines and the prompt in one chunk are parsed once; two responses in one chunk are two", () => {
    const framer = new PromptFramer();
    const events = framer.push(textToBytes("OK\r\r>NO DATA\r\r>4"));
    expect(responses(events).map((r) => r.lines)).toEqual([["OK"], ["NO DATA"]]);
    expect(framer.pendingText()).toBe("4");
  });

  it("row 3: CR only, CRLF, stray LF and NUL bytes give the same lines", () => {
    const variants = [
      "7E8 06 41 00 BE 3F A8 13\r7E9 06 41 00 98 18 80 11\r\r>",
      "7E8 06 41 00 BE 3F A8 13\r\n7E9 06 41 00 98 18 80 11\r\n\r\n>",
      "\n7E8 06 41 00 BE 3F A8 13\n\r7E9 06 41 00 98 18 80 11\n>",
      "\u00007E8 06 41 00 BE 3F A8 13\r\u00007E9 06 41 00 98 18 80 11\r\u0000\r>",
    ];
    for (const variant of variants) {
      expect(responses(new PromptFramer().push(textToBytes(variant)))[0].lines, JSON.stringify(variant)).toEqual(whole[0].lines);
    }
    expect(splitLines("  OK  \r\r")).toEqual(["OK"]);
  });

  it("keeps the exact received bytes, including NULs and line endings", () => {
    const raw = "\u0000OK\r\n\r>";
    expect(responses(new PromptFramer().push(textToBytes(raw)))[0].text).toBe("\u0000OK\r\n\r");
  });

  it("row 5: more than the byte cap without a prompt overflows once, then resumes clean at the next prompt", () => {
    const framer = new PromptFramer(16);
    const events = feed(framer, ["0123456789", "0123456789", "0123456789"]);
    expect(events).toEqual([{ type: "overflow" }]);
    expect(framer.pendingBytes).toBe(30);
    const [overflowed] = responses(framer.push(textToBytes("STOPPED\r\r>")));
    expect(overflowed.overflowed).toBe(true);
    expect(overflowed.text.length).toBe(17); // stopped keeping bytes after the cap
    expect(overflowed.byteCount).toBe(39);
    const [next] = responses(framer.push(textToBytes("OK\r\r>")));
    expect(next).toEqual({ text: "OK\r\r", lines: ["OK"], overflowed: false, byteCount: 4 });
  });

  it("refuses a non-positive or fractional byte cap", () => {
    for (const cap of [0, -1, 1.5, Number.NaN]) expect(() => new PromptFramer(cap)).toThrow(RangeError);
  });
});

describe("response classifier", () => {
  const TOKENS: [string, string][] = [
    ["?", "adapter_rejected_command"],
    ["NO DATA", "no_response"],
    ["UNABLE TO CONNECT", "no_vehicle_protocol"],
    ["BUS INIT: ...ERROR", "bus_init_failed"],
    ["BUS INIT:...ERROR", "bus_init_failed"],
    ["CAN ERROR", "bus_error"],
    ["BUS ERROR", "bus_error"],
    ["BUS BUSY", "bus_error"],
    ["FB ERROR", "bus_error"],
    ["DATA ERROR", "data_error"],
    ["7E8 03 43 01 <DATA ERROR", "data_error"],
    ["7E8 03 43 <RX ERROR", "data_error"],
    ["BUFFER FULL", "adapter_overflow"],
    ["STOPPED", "interrupted"],
    ["ERR94", "adapter_internal_error"],
    ["LV RESET", "adapter_power_event"],
    ["ACT ALERT", "adapter_power_event"],
  ];

  it.each(TOKENS)("maps %j to %s and never to data, for every reply kind", (token, outcome) => {
    expect(tokenOutcome(token)).toBe(outcome);
    for (const kind of ["ok_only", "text", "protocol_number", "voltage", "obd"] as const) {
      const result = classifyResponse([token], kind);
      expect(result.outcome, kind).toBe(outcome);
      expect(result).not.toHaveProperty("dataLines");
    }
  });

  it("rows 7-9: a token among data lines still makes the whole reply unusable", () => {
    expect(classifyResponse(["7E8 06 43 02 01 33 01 71", "BUFFER FULL"], "obd")).toMatchObject({ outcome: "adapter_overflow", token: "BUFFER FULL" });
    expect(classifyResponse(["7E8 02 43 00", "NO DATA"], "obd")).toMatchObject({ outcome: "no_response" });
  });

  it("records and removes progress lines", () => {
    expect(classifyResponse(["SEARCHING...", "7E8 06 41 00 BE 3F A8 13"], "obd")).toEqual({
      outcome: "ok",
      dataLines: ["7E8 06 41 00 BE 3F A8 13"],
      infoLines: ["SEARCHING..."],
    });
    expect(classifyResponse(["SEARCHING...", "UNABLE TO CONNECT"], "obd")).toMatchObject({ outcome: "no_vehicle_protocol", infoLines: ["SEARCHING..."] });
    expect(classifyResponse(["BUS INIT: ...OK", "41 00 BE 3F A8 13"], "obd")).toMatchObject({ outcome: "ok", infoLines: ["BUS INIT: ...OK"] });
    expect(classifyResponse(["SEARCHING..."], "obd")).toMatchObject({ outcome: "unexpected_reply" });
  });

  it("a power event wins over every other token, and an identity line is one unless the command prints it", () => {
    expect(classifyResponse(["NO DATA", "LV RESET"], "obd")).toMatchObject({ outcome: "adapter_power_event", token: "LV RESET" });
    for (const kind of ["ok_only", "text", "protocol_number", "voltage", "obd"] as const) {
      expect(classifyResponse(["ELM327 v1.5"], kind), kind).toMatchObject({ outcome: "adapter_power_event", token: "ELM327 v1.5" });
    }
    expect(classifyResponse(["ELM327 v1.5"], "text", true)).toMatchObject({ outcome: "ok", dataLines: ["ELM327 v1.5"] });
    expect(classifyResponse(["LV RESET"], "text", true)).toMatchObject({ outcome: "adapter_power_event" });
  });

  it("accepts only the exact shape each command kind may return", () => {
    const cases: [string[], Parameters<typeof classifyResponse>[1], boolean][] = [
      [["OK"], "ok_only", true],
      [["OK", "OK"], "ok_only", false],
      [["ok"], "ok_only", false],
      [["OK 1"], "ok_only", false],
      [["A6"], "protocol_number", true],
      [["6"], "protocol_number", true],
      [["AD"], "protocol_number", false],
      [["12.6V"], "voltage", true],
      [["12.6"], "voltage", false],
      [["7E8 02 43 00"], "obd", true],
      [["7e8 02 43 00"], "obd", false],
      [["7E8  02"], "obd", false],
      [["41 0C 1A F8", "hello"], "obd", false],
      [["SIMULATED ADAPTER"], "text", true],
      [["bad\u0001"], "text", false],
      [[], "obd", false],
    ];
    for (const [lines, kind, ok] of cases) {
      const result = classifyResponse(lines, kind);
      expect(result.outcome, `${JSON.stringify(lines)} as ${kind}`).toBe(ok ? "ok" : "unexpected_reply");
    }
    expect(classifyResponse(["OK"], "bogus" as never)).toMatchObject({ outcome: "unexpected_reply" });
  });
});
