// WAV and Ogg container checks for mod audio files, plus a PCM16 tone writer for test fixtures.
//
// The reader mirrors the game's `WAVResource::decode` (RVA 0x9a6dd0, `.analysis/decompiled/WAVResource_decode_0x9a6dd0.c`):
// the first 4 bytes must be "RIFF" (else the fatal assert "<path> is not a wav file" — the game stops), then it skips
// 8 more bytes ("<size>WAVE", never checked) and walks chunks `<id:4><size:u32>` from offset 12 until it has seen both
// "fmt " and "data": "fmt " fills format tag, channels, sample rate, byte rate, block align, bits per sample (16 bytes,
// the rest of a longer fmt chunk is skipped); "data" keeps a pointer into the file buffer and its size (the samples are
// never copied); any other chunk is skipped by its size. A file shorter than 4 bytes trips ByteStream::read's
// "out of bounds" assert. Nothing here is the game's code; it only predicts what that function will accept.

export interface WavInfo {
  formatTag: number;
  channels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
  dataOffset: number;
  dataBytes: number;
  /** dataBytes / blockAlign (0 when blockAlign is 0) */
  frames: number;
  /** frames / sampleRate in seconds (0 when the rate is 0) */
  seconds: number;
}

export type WavCheck = { ok: true; info: WavInfo } | { ok: false; error: string };

/** Parse a WAV header the way WAVResource::decode does. Never throws. */
export function readWav(buf: Uint8Array): WavCheck {
  if (buf.length < 4) return { ok: false, error: `${buf.length} bytes: the game's ByteStream::read asserts "out of bounds" on a file shorter than 4 bytes` };
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = String.fromCharCode(buf[0]!, buf[1]!, buf[2]!, buf[3]!);
  if (tag !== "RIFF") return { ok: false, error: `starts with ${JSON.stringify(tag)}, not "RIFF": the game asserts "<path> is not a wav file" and stops` };
  let pos = 12;
  let fmt: Omit<WavInfo, "dataOffset" | "dataBytes" | "frames" | "seconds"> | null = null;
  let data: { off: number; size: number } | null = null;
  while (!(fmt && data)) {
    if (pos + 8 > buf.length) {
      return { ok: false, error: `chunk walk ran past the end at byte ${pos} without ${fmt ? "" : '"fmt "'}${!fmt && !data ? " and " : ""}${data ? "" : '"data"'}: the game's ByteStream::read asserts "out of bounds"` };
    }
    const id = String.fromCharCode(buf[pos]!, buf[pos + 1]!, buf[pos + 2]!, buf[pos + 3]!);
    const size = dv.getUint32(pos + 4, true);
    pos += 8;
    if (id === "fmt ") {
      if (pos + 16 > buf.length) return { ok: false, error: `"fmt " chunk truncated at byte ${pos}` };
      fmt = {
        formatTag: dv.getUint16(pos, true),
        channels: dv.getUint16(pos + 2, true),
        sampleRate: dv.getUint32(pos + 4, true),
        byteRate: dv.getUint32(pos + 8, true),
        blockAlign: dv.getUint16(pos + 12, true),
        bitsPerSample: dv.getUint16(pos + 14, true),
      };
      pos += 16 + Math.max(0, size - 16);
    } else if (id === "data") {
      data = { off: pos, size };
      pos += size;
    } else {
      pos += size;
    }
  }
  const dataBytes = Math.min(data.size, Math.max(0, buf.length - data.off));
  const frames = fmt.blockAlign ? Math.floor(dataBytes / fmt.blockAlign) : 0;
  return { ok: true, info: { ...fmt, dataOffset: data.off, dataBytes, frames, seconds: fmt.sampleRate ? frames / fmt.sampleRate : 0 } };
}

/** True when the bytes start with the Ogg capture pattern "OggS" (the music / ambience / cutscene streams). */
export function isOgg(buf: Uint8Array): boolean {
  return buf.length >= 4 && buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53;
}

export interface ToneSpec {
  /** Hz; 0 = silence */
  freq: number;
  seconds: number;
  sampleRate?: number;
  channels?: number;
  /** 0..1 */
  amplitude?: number;
}

/** A PCM16 sine tone as a canonical 44-byte-header WAV (RIFF / WAVE / "fmt " 16 / "data"). */
export function makeToneWav(spec: ToneSpec): Uint8Array {
  const rate = spec.sampleRate ?? 44100;
  const ch = spec.channels ?? 1;
  const amp = spec.amplitude ?? 0.3;
  const frames = Math.round(spec.seconds * rate);
  const dataBytes = frames * ch * 2;
  const buf = new Uint8Array(44 + dataBytes);
  const dv = new DataView(buf.buffer);
  const ascii = (off: number, s: string): void => { for (let i = 0; i < s.length; i++) buf[off + i] = s.charCodeAt(i); };
  ascii(0, "RIFF");
  dv.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, ch, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * ch * 2, true);
  dv.setUint16(32, ch * 2, true);
  dv.setUint16(34, 16, true);
  ascii(36, "data");
  dv.setUint32(40, dataBytes, true);
  for (let i = 0; i < frames; i++) {
    // 5 ms linear fade in/out so the tone does not click
    const fade = Math.min(1, i / (rate * 0.005), (frames - 1 - i) / (rate * 0.005));
    const s = spec.freq > 0 ? Math.round(Math.sin((2 * Math.PI * spec.freq * i) / rate) * amp * fade * 32767) : 0;
    for (let c = 0; c < ch; c++) dv.setInt16(44 + (i * ch + c) * 2, s, true);
  }
  return buf;
}
