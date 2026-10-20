// Flash-faithful linkage ABC (ActionScript 3 bytecode) for the optional DoABC tag.
//
// Flash's publisher emits, for every SymbolClass name, an auto-generated class
// `Name extends flash.display.MovieClip` with empty traits plus a script that defines it.
// `buildLinkageAbc` reproduces that output structurally byte-for-byte as OBSERVED in the
// vanilla files (docs/art-preview-plan.md §1.3, abcdump of minecarts.swf):
//   minor 16 / major 46; constant pool: no ints/uints/doubles, strings interned in
//   encounter order starting with an explicit "" (Flash does not reuse the implicit
//   index 0), namespaces PackageNamespace(0x16) / ProtectedNamespace(0x18), QName(0x07)
//   multinames; per class 3 methods (cinit, iinit, script init) with param_count 0,
//   return_type 0, name 0, flags 0; instance flags 0x08 (ClassProtectedNs); one script
//   per class with one Class trait (kind 4, slot 1); bodies:
//     cinit  max_stack 1, locals 1, scope 9..10:  d0 30 47
//     iinit  max_stack 1, locals 1, scope 10..11: d0 30 d0 49 00 47
//     sinit  max_stack 2, locals 1, scope 1..9:   getlocal0 pushscope getscopeobject 0,
//            getlex Object / flash.events:EventDispatcher / DisplayObject / InteractiveObject /
//            DisplayObjectContainer / Sprite / MovieClip (each followed by pushscope),
//            getlex MovieClip, newclass <i>, 7× popscope, initproperty <QName>, returnvoid.
// `parseAbc` is the structural reader used by tests (round-trip + vanilla parse).

export interface AbcNamespace {
  kind: number;
  /** string index */
  name: number;
}
export interface AbcMultiname {
  kind: number;
  ns?: number;
  name?: number;
  nsSet?: number;
  base?: number;
  params?: number[];
}
export interface AbcMethod {
  paramCount: number;
  returnType: number;
  paramTypes: number[];
  name: number;
  flags: number;
}
export interface AbcTrait {
  name: number;
  kind: number;
  attr: number;
  slotId?: number;
  typeName?: number;
  vindex?: number;
  vkind?: number;
  classIndex?: number;
  func?: number;
  dispId?: number;
  method?: number;
  metadata?: number[];
}
export interface AbcInstance {
  name: number;
  superName: number;
  flags: number;
  protectedNs?: number;
  interfaces: number[];
  iinit: number;
  traits: AbcTrait[];
}
export interface AbcBody {
  method: number;
  maxStack: number;
  localCount: number;
  initScopeDepth: number;
  maxScopeDepth: number;
  code: Uint8Array;
  exceptionCount: number;
  traits: AbcTrait[];
}
export interface ParsedAbc {
  minor: number;
  major: number;
  /** index 0 implicit (0) */
  ints: number[];
  uints: number[];
  doubles: number[];
  /** index 0 implicit ("") */
  strings: string[];
  namespaces: Array<AbcNamespace | null>;
  nsSets: Array<number[] | null>;
  multinames: Array<AbcMultiname | null>;
  methods: AbcMethod[];
  metadataCount: number;
  instances: AbcInstance[];
  classes: Array<{ cinit: number; traits: AbcTrait[] }>;
  scripts: Array<{ init: number; traits: AbcTrait[] }>;
  bodies: AbcBody[];
  /** bytes consumed by the parse */
  consumed: number;
}

const NS_PACKAGE = 0x16;
const NS_PROTECTED = 0x18;
const MN_QNAME = 0x07;
const ENC = new TextEncoder();
const DEC = new TextDecoder();

/** Little ABC byte writer (u8 / u16 / u30 / d64 / bytes). */
class AbcWriter {
  out: number[];
  constructor() {
    this.out = [];
  }
  u8(v: number): void {
    this.out.push(v & 0xff);
  }
  u16(v: number): void {
    this.out.push(v & 0xff, (v >>> 8) & 0xff);
  }
  u30(v: number): void {
    let x = v >>> 0;
    do {
      let b = x & 0x7f;
      x >>>= 7;
      if (x) b |= 0x80;
      this.out.push(b);
    } while (x);
  }
  bytes(bytes: Uint8Array | number[]): void {
    for (const b of bytes) this.out.push(b);
  }
  string(s: string): void {
    const b = ENC.encode(s);
    this.u30(b.length);
    this.bytes(b);
  }
  finish(): Uint8Array {
    return Uint8Array.from(this.out);
  }
}

/** Constant pool with Flash's interning order. */
class Pool {
  /** explicit string entries (index 1..) */
  strings: string[];
  namespaces: AbcNamespace[];
  multinames: AbcMultiname[];
  constructor() {
    this.strings = [];
    this.namespaces = [];
    this.multinames = [];
  }
  string(s: string): number {
    const i = this.strings.indexOf(s);
    if (i >= 0) return i + 1;
    this.strings.push(s);
    return this.strings.length;
  }
  namespace(kind: number, name: string): number {
    const nameIdx = this.string(name);
    const i = this.namespaces.findIndex((n) => n.kind === kind && n.name === nameIdx);
    if (i >= 0) return i + 1;
    this.namespaces.push({ kind, name: nameIdx });
    return this.namespaces.length;
  }
  qname(pkg: string, name: string): number {
    const ns = this.namespace(NS_PACKAGE, pkg);
    const nameIdx = this.string(name);
    const i = this.multinames.findIndex((m) => m.kind === MN_QNAME && m.ns === ns && m.name === nameIdx);
    if (i >= 0) return i + 1;
    this.multinames.push({ kind: MN_QNAME, ns, name: nameIdx });
    return this.multinames.length;
  }
}

/** Split "pkg.sub.Name" into package and local name at the last dot ("Name" → ["", "Name"]). */
export function splitClassName(full: string): [string, string] {
  const i = full.lastIndexOf(".");
  return i < 0 ? ["", full] : [full.slice(0, i), full.slice(i + 1)];
}

/**
 * Build the linkage ABC for the given SymbolClass names (each becomes a MovieClip
 * subclass). Names repeat Flash's convention: dots separate the package.
 */
export function buildLinkageAbc(names: string[]): Uint8Array {
  const pool = new Pool();
  const classes: Array<{ qname: number; superName: number; protectedNs: number }> = [];
  for (const full of names) {
    const [pkg, name] = splitClassName(full);
    const qname = pool.qname(pkg, name);
    const superName = pool.qname("flash.display", "MovieClip");
    const protectedNs = pool.namespace(NS_PROTECTED, pkg ? `${pkg}:${name}` : name);
    classes.push({ qname, superName, protectedNs });
  }
  const chain = [
    pool.qname("", "Object"),
    pool.qname("flash.events", "EventDispatcher"),
    pool.qname("flash.display", "DisplayObject"),
    pool.qname("flash.display", "InteractiveObject"),
    pool.qname("flash.display", "DisplayObjectContainer"),
    pool.qname("flash.display", "Sprite"),
    pool.qname("flash.display", "MovieClip"),
  ];

  const w = new AbcWriter();
  w.u16(16);
  w.u16(46);
  // constant pool
  w.u30(0); // ints
  w.u30(0); // uints
  w.u30(0); // doubles
  w.u30(pool.strings.length ? pool.strings.length + 1 : 0);
  for (const s of pool.strings) w.string(s);
  w.u30(pool.namespaces.length ? pool.namespaces.length + 1 : 0);
  for (const ns of pool.namespaces) {
    w.u8(ns.kind);
    w.u30(ns.name);
  }
  w.u30(0); // ns_sets
  w.u30(pool.multinames.length ? pool.multinames.length + 1 : 0);
  for (const mn of pool.multinames) {
    w.u8(mn.kind);
    w.u30(mn.ns ?? 0);
    w.u30(mn.name ?? 0);
  }
  // methods: 3 per class (cinit, iinit, script init)
  w.u30(classes.length * 3);
  for (let i = 0; i < classes.length * 3; i++) {
    w.u30(0); // param_count
    w.u30(0); // return_type
    w.u30(0); // name
    w.u8(0); // flags
  }
  w.u30(0); // metadata
  // instances
  w.u30(classes.length);
  classes.forEach((c, i) => {
    w.u30(c.qname);
    w.u30(c.superName);
    w.u8(0x08); // ClassProtectedNs
    w.u30(c.protectedNs);
    w.u30(0); // interfaces
    w.u30(i * 3 + 1); // iinit
    w.u30(0); // traits
  });
  // classes
  classes.forEach((_, i) => {
    w.u30(i * 3); // cinit
    w.u30(0); // traits
  });
  // scripts
  w.u30(classes.length);
  classes.forEach((c, i) => {
    w.u30(i * 3 + 2); // init
    w.u30(1); // trait count
    w.u30(c.qname);
    w.u8(0x04); // Trait_Class
    w.u30(1); // slot_id
    w.u30(i); // classi
  });
  // bodies
  w.u30(classes.length * 3);
  classes.forEach((c, i) => {
    body(w, i * 3, 1, 1, 9, 10, [0xd0, 0x30, 0x47]);
    body(w, i * 3 + 1, 1, 1, 10, 11, [0xd0, 0x30, 0xd0, 0x49, 0x00, 0x47]);
    const code = new AbcWriter();
    code.bytes([0xd0, 0x30, 0x65, 0x00]);
    for (const mn of chain) {
      code.u8(0x60);
      code.u30(mn);
      code.u8(0x30);
    }
    code.u8(0x60);
    code.u30(chain[chain.length - 1]);
    code.u8(0x58);
    code.u30(i);
    code.bytes([0x1d, 0x1d, 0x1d, 0x1d, 0x1d, 0x1d, 0x1d]);
    code.u8(0x68);
    code.u30(c.qname);
    code.u8(0x47);
    body(w, i * 3 + 2, 2, 1, 1, 9, code.finish());
  });
  return w.finish();
}

function body(w: AbcWriter, method: number, maxStack: number, locals: number, initScope: number, maxScope: number, code: Uint8Array | number[]): void {
  w.u30(method);
  w.u30(maxStack);
  w.u30(locals);
  w.u30(initScope);
  w.u30(maxScope);
  w.u30(code.length);
  w.bytes(code);
  w.u30(0); // exceptions
  w.u30(0); // traits
}

// ---- reader -------------------------------------------------------------------------

/**
 * Structural ABC parse (constant pool, methods, metadata, instances/classes, scripts,
 * bodies). Throws on malformed input. `consumed` lets callers assert the whole blob was read.
 */
export function parseAbc(bytes: Uint8Array): ParsedAbc {
  let q = 0;
  const u8 = (): number => {
    if (q >= bytes.length) throw new Error(`abc: read past end at ${q}`);
    return bytes[q++];
  };
  const u16 = (): number => u8() | (u8() << 8);
  const u30 = (): number => {
    let r = 0;
    let mult = 1;
    for (let i = 0; i < 5; i++) {
      const b = u8();
      r += (b & 0x7f) * mult;
      if (!(b & 0x80)) break;
      mult *= 128;
    }
    return r;
  };
  const s32 = (): number => {
    const v = u30();
    return v >= 0x80000000 ? v - 0x100000000 : v;
  };
  const d64 = (): number => {
    if (q + 8 > bytes.length) throw new Error("abc: truncated double");
    const dv = new DataView(bytes.buffer, bytes.byteOffset + q, 8);
    q += 8;
    return dv.getFloat64(0, true);
  };
  const minor = u16();
  const major = u16();
  const nInt = u30();
  const ints = [0];
  for (let i = 1; i < nInt; i++) ints.push(s32());
  const nUint = u30();
  const uints = [0];
  for (let i = 1; i < nUint; i++) uints.push(u30());
  const nD = u30();
  const doubles = [NaN];
  for (let i = 1; i < nD; i++) doubles.push(d64());
  const nS = u30();
  const strings = [""];
  for (let i = 1; i < nS; i++) {
    const len = u30();
    if (q + len > bytes.length) throw new Error("abc: truncated string");
    strings.push(DEC.decode(bytes.subarray(q, q + len)));
    q += len;
  }
  const nNs = u30();
  const namespaces: Array<AbcNamespace | null> = [null];
  for (let i = 1; i < nNs; i++) namespaces.push({ kind: u8(), name: u30() });
  const nSet = u30();
  const nsSets: Array<number[] | null> = [null];
  for (let i = 1; i < nSet; i++) {
    const c = u30();
    const set: number[] = [];
    for (let j = 0; j < c; j++) set.push(u30());
    nsSets.push(set);
  }
  const nMn = u30();
  const multinames: Array<AbcMultiname | null> = [null];
  for (let i = 1; i < nMn; i++) {
    const kind = u8();
    switch (kind) {
      case 0x07:
      case 0x0d:
        multinames.push({ kind, ns: u30(), name: u30() });
        break;
      case 0x0f:
      case 0x10:
        multinames.push({ kind, name: u30() });
        break;
      case 0x11:
      case 0x12:
        multinames.push({ kind });
        break;
      case 0x09:
      case 0x0e:
        multinames.push({ kind, name: u30(), nsSet: u30() });
        break;
      case 0x1b:
      case 0x1c:
        multinames.push({ kind, nsSet: u30() });
        break;
      case 0x1d: {
        const base = u30();
        const c = u30();
        const params: number[] = [];
        for (let j = 0; j < c; j++) params.push(u30());
        multinames.push({ kind, base, params });
        break;
      }
      default:
        throw new Error(`abc: unknown multiname kind 0x${kind.toString(16)} at ${q - 1}`);
    }
  }
  const nMeth = u30();
  const methods: AbcMethod[] = [];
  for (let i = 0; i < nMeth; i++) {
    const paramCount = u30();
    const returnType = u30();
    const paramTypes: number[] = [];
    for (let j = 0; j < paramCount; j++) paramTypes.push(u30());
    const name = u30();
    const flags = u8();
    if (flags & 0x08) {
      const oc = u30();
      for (let j = 0; j < oc; j++) {
        u30();
        u8();
      }
    }
    if (flags & 0x80) for (let j = 0; j < paramCount; j++) u30();
    methods.push({ paramCount, returnType, paramTypes, name, flags });
  }
  const metadataCount = u30();
  for (let i = 0; i < metadataCount; i++) {
    u30();
    const c = u30();
    for (let j = 0; j < c; j++) {
      u30();
      u30();
    }
  }
  const traits = (): AbcTrait[] => {
    const c = u30();
    const out: AbcTrait[] = [];
    for (let i = 0; i < c; i++) {
      const name = u30();
      const kindByte = u8();
      const t: AbcTrait = { name, kind: kindByte & 0x0f, attr: kindByte >> 4 };
      switch (t.kind) {
        case 0:
        case 6:
          t.slotId = u30();
          t.typeName = u30();
          t.vindex = u30();
          if (t.vindex) t.vkind = u8();
          break;
        case 4:
          t.slotId = u30();
          t.classIndex = u30();
          break;
        case 5:
          t.slotId = u30();
          t.func = u30();
          break;
        default:
          t.dispId = u30();
          t.method = u30();
      }
      if (t.attr & 0x4) {
        const mc = u30();
        t.metadata = [];
        for (let j = 0; j < mc; j++) t.metadata.push(u30());
      }
      out.push(t);
    }
    return out;
  };
  const nCls = u30();
  const instances: AbcInstance[] = [];
  for (let i = 0; i < nCls; i++) {
    const name = u30();
    const superName = u30();
    const flags = u8();
    const inst: AbcInstance = { name, superName, flags, interfaces: [], iinit: 0, traits: [] };
    if (flags & 0x08) inst.protectedNs = u30();
    const ic = u30();
    for (let j = 0; j < ic; j++) inst.interfaces.push(u30());
    inst.iinit = u30();
    inst.traits = traits();
    instances.push(inst);
  }
  const classes: Array<{ cinit: number; traits: AbcTrait[] }> = [];
  for (let i = 0; i < nCls; i++) classes.push({ cinit: u30(), traits: traits() });
  const nScr = u30();
  const scripts: Array<{ init: number; traits: AbcTrait[] }> = [];
  for (let i = 0; i < nScr; i++) scripts.push({ init: u30(), traits: traits() });
  const nBody = u30();
  const bodies: AbcBody[] = [];
  for (let i = 0; i < nBody; i++) {
    const method = u30();
    const maxStack = u30();
    const localCount = u30();
    const initScopeDepth = u30();
    const maxScopeDepth = u30();
    const codeLen = u30();
    if (q + codeLen > bytes.length) throw new Error("abc: truncated method body");
    const code = bytes.slice(q, q + codeLen);
    q += codeLen;
    const exceptionCount = u30();
    for (let j = 0; j < exceptionCount; j++) {
      u30();
      u30();
      u30();
      u30();
      u30();
    }
    bodies.push({ method, maxStack, localCount, initScopeDepth, maxScopeDepth, code, exceptionCount, traits: traits() });
  }
  return { minor, major, ints, uints, doubles, strings, namespaces, nsSets, multinames, methods, metadataCount, instances, classes, scripts, bodies, consumed: q };
}

/** Human-readable "ns:name" for a QName multiname (tests / reports). */
export function multinameToString(abc: ParsedAbc, index: number): string {
  const mn = abc.multinames[index];
  if (!mn || mn.ns === undefined || mn.name === undefined) return `#${index}`;
  const ns = abc.namespaces[mn.ns];
  return `${ns ? abc.strings[ns.name] : "*"}:${abc.strings[mn.name]}`;
}
