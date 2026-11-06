import { createPublicClient, http, keccak256, toBytes, type Address, type Hex } from "viem";
import { base } from "viem/chains";
import { hashEvidence } from "@/lib/shift/evidence";
import { verifyNight, type VerifyChecks } from "@/lib/attest/verify";
import type { AnyPublicClient } from "@/lib/attest/signer";
import type { EvidenceBundle } from "@/lib/types";

export interface VerifyCheck {
  key: string;
  label: string;
  state: "pass" | "fail" | "na";
}
export interface VerifyOutcome {
  checks: VerifyCheck[];
  summary: string | null;
  match: boolean;
}

const DEFAULT_RPC = "https://base-rpc.publicnode.com";

const LABELS: Record<keyof VerifyChecks, string> = {
  exists: "The attestation exists on Base",
  schema: "It uses the Lights On schema",
  attester: "It was made by the watcher's address",
  notRevoked: "It is not revoked",
  notExpired: "It does not expire",
  project: "Its project matches this bundle",
  night: "Its night matches this bundle",
  hash: "Its evidence hash equals the re-hashed bundle",
};

/**
 * The in-browser twin of scripts/verify-night.ts: re-hash the published evidence, then (for attested nights)
 * read the attestation from Base and run the same checks as verifyNight().
 */
export async function verifyInBrowser(p: {
  hash: string | null;
  evidence: string | null;
  uid: string | null;
  observed: boolean;
  watcher: string | null;
  rpcUrl?: string;
}): Promise<VerifyOutcome> {
  const checks: VerifyCheck[] = [];
  let bundle: EvidenceBundle | null = null;
  if (!p.hash || !p.evidence) {
    checks.push({ key: "rehash", label: "The evidence bundle re-hashes to its published hash", state: "fail" });
    return { checks, summary: "No evidence bundle could be loaded for this night.", match: false };
  }
  try {
    bundle = JSON.parse(p.evidence) as EvidenceBundle;
  } catch {
    bundle = null;
  }
  const bodyHash = keccak256(toBytes(p.evidence));
  const rehash = bundle ? hashEvidence(bundle) : null;
  const okHash = bodyHash.toLowerCase() === p.hash.toLowerCase() && rehash?.toLowerCase() === p.hash.toLowerCase();
  checks.push({ key: "rehash", label: "The evidence bundle re-hashes to its published hash", state: okHash ? "pass" : "fail" });

  if (!p.observed) {
    checks.push({ key: "attested", label: "Reconstructed, never attested: there is nothing on Base to check this night against", state: "na" });
    return { checks, summary: null, match: okHash };
  }
  if (!p.uid) {
    checks.push({ key: "attested", label: "Not attested yet: the nightly attestation has not landed for this night", state: "na" });
    return { checks, summary: null, match: false };
  }
  if (!bundle) return { checks, summary: "The bundle is not valid JSON.", match: false };

  const attesters = (p.watcher ?? "").split(",").map((x) => x.trim()).filter((x) => /^0x[0-9a-fA-F]{40}$/.test(x)) as Address[];
  const client = createPublicClient({ chain: base, transport: http(p.rpcUrl || process.env.NEXT_PUBLIC_BASE_RPC_URL || DEFAULT_RPC, { timeout: 15_000 }) });
  const r = await verifyNight(p.uid as Hex, bundle, client as unknown as AnyPublicClient, attesters);
  for (const k of Object.keys(LABELS) as (keyof VerifyChecks)[]) {
    checks.push({ key: k, label: LABELS[k], state: r.checks[k] ? "pass" : "fail" });
  }
  const summary = r.match
    ? "Match: this night's evidence is exactly what was attested on Base."
    : !r.checks.exists
      ? "The attestation could not be read from Base (or does not exist)."
      : attesters.length === 0
        ? "No watcher address is configured on this site, so the attester cannot be checked."
        : "Mismatch: see the failing checks.";
  return { checks, summary, match: r.match && okHash };
}
