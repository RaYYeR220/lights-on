import { createPublicClient, http, keccak256, toBytes, type Address, type Hex } from "viem";
import { base } from "viem/chains";
import { hashEvidence } from "@/lib/shift/evidence";
import { verifyNight, type RootChecks, type SingleChecks } from "@/lib/attest/verify";
import type { AnyPublicClient } from "@/lib/attest/signer";
import type { EvidenceBundle, Status } from "@/lib/types";

export interface VerifyCheck {
  key: string;
  label: string;
  state: "pass" | "fail" | "na";
}
export interface VerifyOutcome {
  checks: VerifyCheck[];
  summary: string | null;
  match: boolean;
  /** Nightly root mode: "Merkle proof · N steps → root 0x… attested in tx 0x…". */
  proofLine?: string | null;
}

const DEFAULT_RPC = "https://base-rpc.publicnode.com";

const COMMON = {
  exists: "The attestation exists on Base",
  attester: "It was made by the watcher's address",
  notRevoked: "It is not revoked",
  notExpired: "It does not expire",
  night: "Its night matches this bundle",
} as const;

const SINGLE_LABELS: Record<keyof SingleChecks, string> = {
  exists: COMMON.exists,
  schema: "It uses the Lights On schema",
  attester: COMMON.attester,
  notRevoked: COMMON.notRevoked,
  notExpired: COMMON.notExpired,
  project: "Its project matches this bundle",
  night: COMMON.night,
  hash: "Its evidence hash equals the re-hashed bundle",
};

const ROOT_LABELS: Record<keyof RootChecks, string> = {
  exists: COMMON.exists,
  schema: "It uses the Lights On nightly root schema",
  attester: COMMON.attester,
  notRevoked: COMMON.notRevoked,
  notExpired: COMMON.notExpired,
  night: COMMON.night,
  proof: "This night's leaf (project, night, status, lit30, evidence hash) proves into the attested Merkle root",
  hash: "The evidence hash inside the proven leaf equals the re-hashed bundle",
};

const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

/**
 * The in-browser twin of scripts/verify-night.ts: re-hash the published evidence, then (for attested nights) read the
 * attestation from Base and run the same checks as verifyNight(). A nightly night is one leaf of that night's Merkle
 * root: its status, lit30 and proof come from the page data and only pass if they prove into the root on Base.
 */
export async function verifyInBrowser(p: {
  hash: string | null;
  evidence: string | null;
  uid: string | null;
  observed: boolean;
  watcher: string | null;
  /** Nightly root fields of the row (page data). */
  status?: Status | null;
  lit30?: number | null;
  proof?: string[] | null;
  tx?: string | null;
  rpcUrl?: string;
  /** Test seam: a read client instead of the RPC url. */
  client?: AnyPublicClient;
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
  const client = p.client ?? (createPublicClient({
    chain: base, transport: http(p.rpcUrl || process.env.NEXT_PUBLIC_BASE_RPC_URL || DEFAULT_RPC, { timeout: 15_000 }),
  }) as unknown as AnyPublicClient);
  const row = p.status && Array.isArray(p.proof) && typeof p.lit30 === "number"
    ? { status: p.status, lit30: p.lit30, proof: p.proof, evidenceHash: p.hash }
    : undefined;
  const r = await verifyNight(p.uid as Hex, bundle, client, attesters, row ? { row } : {});
  const labels: Record<string, string> = r.mode === "root" ? ROOT_LABELS : SINGLE_LABELS;
  const values = r.checks as unknown as Record<string, boolean>;
  for (const k of Object.keys(labels)) checks.push({ key: k, label: labels[k], state: values[k] ? "pass" : "fail" });

  const proofLine = r.mode === "root" && r.root && r.checks.proof
    ? `Merkle proof · ${r.proofSteps ?? 0} step${r.proofSteps === 1 ? "" : "s"} → root ${short(r.root)}${p.tx ? ` attested in tx ${short(p.tx)}` : ""}`
    : null;
  const summary = r.match
    ? r.mode === "root"
      ? `Match: this night's evidence is one of the ${r.count ?? "?"} project-nights in the root attested on Base.`
      : "Match: this night's evidence is exactly what was attested on Base."
    : !r.checks.exists
      ? "The attestation could not be read from Base (or does not exist)."
      : attesters.length === 0
        ? "No watcher address is configured on this site, so the attester cannot be checked."
        : r.mode === "root" && !row
          ? "This night has no Merkle proof on record, so it cannot be checked against the root."
          : "Mismatch: see the failing checks.";
  return { checks, summary, match: r.match && okHash, proofLine };
}
