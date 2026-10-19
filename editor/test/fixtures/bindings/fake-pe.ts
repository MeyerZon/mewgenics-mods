// Synthetic PE32+ builder for the bindings tests. Produces a small, valid
// image (DOS stub, COFF + optional header, section table, raw sections and an
// optional .pdata exception directory) from a spec, never from game bytes.
// Later tests derive a "v2" image from a v1 spec (shifted sections, inserted
// functions, changed rel32 operands) to exercise the port ladder.

const SECTION_ALIGN = 0x1000;
const FILE_ALIGN = 0x200;
const HEADERS_SIZE = 0x400;
const PE_OFFSET = 0x40;
const OPT_SIZE = 240; // PE32+ optional header with 16 data directories
const IMAGE_BASE = 0x140000000;

/**
 * @typedef {{ name: string, bytes: Uint8Array|number[], exec?: boolean, write?: boolean }} FakeSectionSpec
 * @typedef {{ section?: string, begin: number, end: number }} FakePdataSpec  begin/end relative to the named section, or absolute RVAs when omitted
 * @typedef {{ timeDateStamp?: number, imageBase?: number, sections: FakeSectionSpec[], pdata?: FakePdataSpec[] }} FakePeSpec
 * @typedef {{ name: string, va: number, vsize: number, raw: number, rawSize: number, chars: number }} FakeSection
 * @typedef {{ buf: Buffer, sections: FakeSection[], rva: (name: string, off: number) => number, off: (name: string, off: number) => number }} FakePe
 */

/** @param {number} n @param {number} a */
const align = (n, a) => Math.ceil(n / a) * a;

/**
 * @param {FakePeSpec} spec
 * @returns {FakePe}
 */
export function buildFakePe(spec) {
  const timeDateStamp = spec.timeDateStamp ?? 0x11111111;
  const imageBase = spec.imageBase ?? IMAGE_BASE;

  /** @type {{ name: string, bytes: Buffer, chars: number }[]} */
  const inputs = spec.sections.map((s) => ({
    name: s.name,
    bytes: Buffer.from(s.bytes),
    chars: ((s.exec ? 0x60000020 : 0x40000040) | (s.write ? 0x80000000 : 0)) >>> 0,
  }));

  /** @type {FakeSection[]} */
  const sections = [];
  let va = SECTION_ALIGN;
  let raw = HEADERS_SIZE;
  /** @param {string} name @param {number} size @param {number} chars */
  const place = (name, size, chars) => {
    const s = { name, va, vsize: size, raw, rawSize: align(size, FILE_ALIGN), chars };
    sections.push(s);
    va = align(va + Math.max(size, 1), SECTION_ALIGN);
    raw += s.rawSize;
    return s;
  };
  for (const s of inputs) place(s.name, s.bytes.length, s.chars);

  /** @param {string} name */
  const byName = (name) => {
    const s = sections.find((x) => x.name === name);
    if (!s) throw new Error(`fake PE: no section ${name}`);
    return s;
  };

  /** @type {Buffer|null} */
  let pdataBytes = null;
  if (spec.pdata && spec.pdata.length) {
    const entries = spec.pdata
      .map((e) => {
        const base = e.section ? byName(e.section).va : 0;
        return { begin: base + e.begin, end: base + e.end };
      })
      .sort((a, b) => a.begin - b.begin);
    const pd = Buffer.alloc(entries.length * 12);
    entries.forEach((e, i) => {
      pd.writeUInt32LE(e.begin, i * 12);
      pd.writeUInt32LE(e.end, i * 12 + 4);
      pd.writeUInt32LE(0, i * 12 + 8);
    });
    pdataBytes = pd;
    place(".pdata", pd.length, 0x40000040);
    inputs.push({ name: ".pdata", bytes: pd, chars: 0x40000040 });
  }

  const last = sections[sections.length - 1];
  const sizeOfImage = last ? align(last.va + Math.max(last.vsize, 1), SECTION_ALIGN) : SECTION_ALIGN;
  const buf = Buffer.alloc(raw);

  // DOS header
  buf.write("MZ", 0, "latin1");
  buf.writeUInt32LE(PE_OFFSET, 0x3c);
  // PE signature + COFF header
  buf.write("PE\0\0", PE_OFFSET, "latin1");
  const coff = PE_OFFSET + 4;
  buf.writeUInt16LE(0x8664, coff); // AMD64
  buf.writeUInt16LE(sections.length, coff + 2);
  buf.writeUInt32LE(timeDateStamp >>> 0, coff + 4);
  buf.writeUInt16LE(OPT_SIZE, coff + 16);
  buf.writeUInt16LE(0x0022, coff + 18); // EXECUTABLE_IMAGE | LARGE_ADDRESS_AWARE
  // optional header (PE32+)
  const opt = coff + 20;
  buf.writeUInt16LE(0x20b, opt);
  buf.writeUInt32LE(sections[0] ? sections[0].va : 0, opt + 16); // AddressOfEntryPoint
  buf.writeBigUInt64LE(BigInt(imageBase), opt + 24);
  buf.writeUInt32LE(SECTION_ALIGN, opt + 32);
  buf.writeUInt32LE(FILE_ALIGN, opt + 36);
  buf.writeUInt16LE(6, opt + 40); // major OS version
  buf.writeUInt16LE(6, opt + 48); // major subsystem version
  buf.writeUInt32LE(sizeOfImage, opt + 56);
  buf.writeUInt32LE(HEADERS_SIZE, opt + 60);
  buf.writeUInt16LE(3, opt + 68); // subsystem: console
  buf.writeUInt32LE(16, opt + 108); // NumberOfRvaAndSizes
  if (pdataBytes) {
    const pd = byName(".pdata");
    buf.writeUInt32LE(pd.va, opt + 112 + 3 * 8);
    buf.writeUInt32LE(pdataBytes.length, opt + 112 + 3 * 8 + 4);
  }
  // section table
  const secTab = opt + OPT_SIZE;
  if (secTab + sections.length * 40 > HEADERS_SIZE) throw new Error("fake PE: too many sections for the header page");
  sections.forEach((s, i) => {
    const o = secTab + i * 40;
    buf.write(s.name.padEnd(8, "\0").slice(0, 8), o, "latin1");
    buf.writeUInt32LE(s.vsize, o + 8);
    buf.writeUInt32LE(s.va, o + 12);
    buf.writeUInt32LE(s.rawSize, o + 16);
    buf.writeUInt32LE(s.raw, o + 20);
    buf.writeUInt32LE(s.chars >>> 0, o + 36);
  });
  // raw section data
  inputs.forEach((s, i) => s.bytes.copy(buf, sections[i].raw));

  return {
    buf,
    sections,
    rva: (name, off) => byName(name).va + off,
    off: (name, off) => byName(name).raw + off,
  };
}
