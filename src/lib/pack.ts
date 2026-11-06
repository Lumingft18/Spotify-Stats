// Binary envelope for values sent to the local server: JSON for structure, raw bytes for typed arrays.
// Same code runs in the browser and in Node (server/), so the server can store values it never parses.
//
// Layout: "ASC1" | u32 header length | header JSON {v: value, b: [byteLength…]} | pad to 8 | buffers (each padded to 8)
// Typed arrays inside the value become {"__bin": i, "t": "Float32Array"} in the header.

const MAGIC = [0x41, 0x53, 0x43, 0x31]; // "ASC1"

const CTORS = {
  Uint8Array,
  Int8Array,
  Uint16Array,
  Int16Array,
  Uint32Array,
  Int32Array,
  Float32Array,
  Float64Array,
} as const;
type CtorName = keyof typeof CTORS;

const pad8 = (n: number) => (8 - (n % 8)) % 8;

function ctorName(v: ArrayBufferView): CtorName {
  for (const [name, C] of Object.entries(CTORS)) if (v instanceof C) return name as CtorName;
  throw new Error(`pack: tipo binario non supportato (${v.constructor.name})`);
}

export function pack(value: unknown): Uint8Array {
  const bufs: Uint8Array[] = [];
  const v = JSON.parse(
    JSON.stringify(value === undefined ? null : value, (_k, x) => {
      if (ArrayBuffer.isView(x) && !(x instanceof DataView)) {
        bufs.push(new Uint8Array(x.buffer, x.byteOffset, x.byteLength));
        return { __bin: bufs.length - 1, t: ctorName(x) };
      }
      if (typeof x === 'bigint') return Number(x);
      return x;
    }),
  );
  const head = new TextEncoder().encode(JSON.stringify({ v, b: bufs.map((b) => b.length) }));
  const start = 8 + head.length + pad8(8 + head.length);
  let size = start;
  for (const b of bufs) size += b.length + pad8(b.length);
  const out = new Uint8Array(size);
  out.set(MAGIC, 0);
  new DataView(out.buffer).setUint32(4, head.length, true);
  out.set(head, 8);
  let off = start;
  for (const b of bufs) {
    out.set(b, off);
    off += b.length + pad8(b.length);
  }
  return out;
}

export function isPacked(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && MAGIC.every((m, i) => bytes[i] === m);
}

export function unpack<T = unknown>(bytes: Uint8Array): T {
  if (!isPacked(bytes)) throw new Error('unpack: formato non valido');
  const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  const { v, b } = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + len))) as { v: unknown; b: number[] };
  if (!b.length) return v as T;
  // Copy each buffer out (aligned, detached from the transport buffer).
  const views: Uint8Array[] = [];
  let off = 8 + len + pad8(8 + len);
  for (const n of b) {
    views.push(bytes.slice(off, off + n));
    off += n + pad8(n);
  }
  const revive = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(revive);
    if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      if (typeof o.__bin === 'number' && typeof o.t === 'string' && o.t in CTORS) {
        const u8 = views[o.__bin];
        const C = CTORS[o.t as CtorName];
        return new C(u8.buffer as ArrayBuffer, u8.byteOffset, u8.byteLength / C.BYTES_PER_ELEMENT);
      }
      for (const k of Object.keys(o)) o[k] = revive(o[k]);
    }
    return x;
  };
  return revive(v) as T;
}
