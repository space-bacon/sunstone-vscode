import * as fs from "fs";

// Enough of a GGUF header to size a context window from the machine rather than from a size threshold. The KV cache
// is layers * kv_heads * (key_len + value_len) * 2 bytes a token, so what a window costs here is measurable, and the
// window a model gets is whatever is left after its weights.

export interface Gguf { arch: string; layers: number; kvHeads: number; keyLen: number; valLen: number; trained: number }

const HEAD_BYTES = 16 * 1024 * 1024;

/** KV cache bytes per token at f16, 0 when the header did not say enough. */
export function kvBytesPerToken(g: Gguf | undefined): number {
  if (!g || !g.layers || !g.kvHeads || !(g.keyLen + g.valLen)) return 0;
  return g.layers * g.kvHeads * (g.keyLen + g.valLen) * 2;
}

export function readGguf(file: string): Gguf | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(HEAD_BYTES);
    const read = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    if (read < 24 || buf.toString("latin1", 0, 4) !== "GGUF") return undefined;
    let o = 4;
    const u32 = () => { const v = buf.readUInt32LE(o); o += 4; return v; };
    const u64 = () => { const v = Number(buf.readBigUInt64LE(o)); o += 8; return v; };
    const str = () => { const n = u64(); const s = buf.toString("utf8", o, o + n); o += n; return s; };
    const width = (t: number) => (t === 0 || t === 1 || t === 7 ? 1 : t === 2 || t === 3 ? 2 : t === 4 || t === 5 || t === 6 ? 4 : 8);
    const scalar = (t: number): number => {
      if (t === 8) { const s = str(); return Number(s) || 0; }
      const at = o; o += width(t);
      switch (t) {
        case 0: return buf.readUInt8(at);
        case 1: return buf.readInt8(at);
        case 2: return buf.readUInt16LE(at);
        case 3: return buf.readInt16LE(at);
        case 4: return buf.readUInt32LE(at);
        case 5: return buf.readInt32LE(at);
        case 6: return buf.readFloatLE(at);
        case 7: return buf.readUInt8(at);
        case 10: return Number(buf.readBigUInt64LE(at));
        case 11: return Number(buf.readBigInt64LE(at));
        default: return buf.readDoubleLE(at);
      }
    };
    u32(); // version
    u64(); // tensor count
    const pairs = u64();
    const want = /\.(block_count|context_length|embedding_length|attention\.(head_count|head_count_kv|key_length|value_length))$/;
    const got = new Map<string, number>();
    let arch = "";
    for (let i = 0; i < pairs && o < read - 12; i++) {
      const keyLen = u64();
      if (o + keyLen > read) return undefined;
      const key = buf.toString("utf8", o, o + keyLen); o += keyLen;
      const type = u32();
      if (type === 9) {
        // An array value: head_count_kv is per layer on some models, and the largest layer is what must fit.
        const inner = u32(); const n = u64();
        if (want.test(key) && inner !== 8 && inner !== 9) {
          let max = 0;
          for (let k = 0; k < n; k++) max = Math.max(max, scalar(inner));
          got.set(key, max);
        } else if (inner === 8) { for (let k = 0; k < n; k++) str(); }
        else o += n * width(inner);
        continue;
      }
      if (key === "general.architecture" && type === 8) { arch = str(); continue; }
      if (want.test(key)) { got.set(key, scalar(type)); continue; }
      if (type === 8) { str(); continue; }
      o += width(type);
    }
    const at = (name: string) => got.get(`${arch}.${name}`) || 0;
    const heads = at("attention.head_count"), embed = at("embedding_length");
    const fallback = heads ? Math.round(embed / heads) : 0;
    return {
      arch, layers: at("block_count"), kvHeads: at("attention.head_count_kv") || heads,
      keyLen: at("attention.key_length") || fallback, valLen: at("attention.value_length") || at("attention.key_length") || fallback,
      trained: at("context_length"),
    };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}
