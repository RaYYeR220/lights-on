import { keccak256, toBytes } from 'viem';
import type { EvidenceBundle } from '@/lib/types';

export const RULES_VERSION = 'r1';

// Deterministic JSON: sorted keys at every depth, no whitespace, undefined-valued
// keys dropped, array order kept. Anything JSON cannot represent exactly throws
// instead of silently coercing (NaN/Infinity -> null, bigint -> error, etc.).
export function canonicalize(v: unknown): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(v)) throw new Error(`canonicalize: non-finite number ${v}`);
      return JSON.stringify(v);
    case 'object': {
      if (Array.isArray(v)) {
        return '[' + v.map((item, i) => {
          if (item === undefined) throw new Error(`canonicalize: undefined array item at ${i}`);
          return canonicalize(item);
        }).join(',') + ']';
      }
      const obj = v as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of Object.keys(obj).sort()) {
        const val = obj[key];
        if (val === undefined) continue;
        parts.push(JSON.stringify(key) + ':' + canonicalize(val));
      }
      return '{' + parts.join(',') + '}';
    }
    default:
      throw new Error(`canonicalize: unsupported type ${typeof v}`);
  }
}

export function hashEvidence(b: EvidenceBundle): `0x${string}` {
  return keccak256(toBytes(canonicalize(b)));
}
