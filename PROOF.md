# Onchain proof

All artifacts are on Base mainnet (chain id 8453). Every write comes from one watcher address.

| Artifact | Value | Check |
|---|---|---|
| Watcher (attester) | `0x82e382eA991C5f48bFC565b8CfbcB6d91faD53D6` | https://basescan.org/address/0x82e382eA991C5f48bFC565b8CfbcB6d91faD53D6 |
| Nightly root schema | UID `0xfe6c6dba61a36a6fbdf682e0d8bf3903a289ebb186e172c59aa9c578b673e726` | https://base.easscan.org/schema/view/0xfe6c6dba61a36a6fbdf682e0d8bf3903a289ebb186e172c59aa9c578b673e726 |
| Root schema registration tx | `0xb5b44d91e2417177b220f933ea9e53c95f7bd9b6c82de4126edc5d4feaa8e87b` | https://basescan.org/tx/0xb5b44d91e2417177b220f933ea9e53c95f7bd9b6c82de4126edc5d4feaa8e87b |
| Live-run schema | UID `0x18fe45e82c5c9b1a176794774f023536a12794a76ee877ebfb0d713166e65d8b` | https://base.easscan.org/schema/view/0x18fe45e82c5c9b1a176794774f023536a12794a76ee877ebfb0d713166e65d8b |
| Live-run schema registration tx | `0xe9a2214e894a7d07addf366cc19b9575e5ac8fa265ca12cd30508b446e84129c` | https://basescan.org/tx/0xe9a2214e894a7d07addf366cc19b9575e5ac8fa265ca12cd30508b446e84129c |
| ERC-8004 agent registration tx | `0x694f47389cb7ae9c084310cb5e7a802c8e5421a5b0d4f39352fd48747e04534d` | https://basescan.org/tx/0x694f47389cb7ae9c084310cb5e7a802c8e5421a5b0d4f39352fd48747e04534d |
| Watcher agent id | `1167163` in registry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | `ownerOf` and `tokenURI`, below |
| First nightly root attestation tx | `0x34f4b344304710c9fd75367a6a42d8e58875561b339da1737a1ec29dcdf1e167` (night of `2026-11-06`) | https://basescan.org/tx/0x34f4b344304710c9fd75367a6a42d8e58875561b339da1737a1ec29dcdf1e167 |
| That night's root attestation | UID `0x8ea045042ae9243e0f7f8a674156878861a113fd6378ce927834575a847ab3df` (shared by every project-night of the night) | https://base.easscan.org/attestation/view/0x8ea045042ae9243e0f7f8a674156878861a113fd6378ce927834575a847ab3df |
| That night's manifest | hash `0x786507ff4033a693c453e105c929cd4a1bdc5b81461e3a9114e870d2db4b93c9` | https://lights-on-watch.vercel.app/api/v1/manifest/0x786507ff4033a693c453e105c929cd4a1bdc5b81461e3a9114e870d2db4b93c9 |
| One project-night in it (revoke-cash) | evidence `0xb993799119a667ed4b82d78af5b244b500a4ad6a4bc4c695e84a86f1a2e699d1` | https://lights-on-watch.vercel.app/api/v1/projects/revoke-cash/nights?from=20261106&to=20261106 |
| A live-run attestation | UID `0x4f3f0709742dce694a70d8107b6a4494fe2ccc81a5f63629ef49a978b2116ecb`, tx `0x6c679e2fbe4fa9eeb4f0f1934b2dc5b60488776f4448c28498714c3f29e522b6` | https://base.easscan.org/attestation/view/0x4f3f0709742dce694a70d8107b6a4494fe2ccc81a5f63629ef49a978b2116ecb |

Contracts used: EAS `0x4200000000000000000000000000000000000021` and SchemaRegistry `0x4200000000000000000000000000000000000020` (Base predeploys), ERC-8004 IdentityRegistry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`.

## The schemas

**One transaction per night: a Merkle root of every project's verdict.** The nightly shift attests once, under the root schema:

```
bytes32 root,uint32 night,uint16 count,uint256 agentId,string manifestURI
```

| Field | Meaning |
|---|---|
| `root` | Merkle root over every project-night of the batch |
| `night` | UTC date of the shift as yyyymmdd |
| `count` | how many project-nights the root covers |
| `agentId` | the watcher's ERC-8004 agent id |
| `manifestURI` | `https://lights-on-watch.vercel.app/api/v1/manifest/<hash>`: every leaf, as canonical JSON; keccak256 of it is `<hash>`. An unlisted project (community-added or hidden) appears by `projectKey` only, with `slug: null` |

A leaf is `keccak256(abi.encode(bytes32 projectKey, uint32 night, uint8 kind = 0, uint8 status, uint16 lit30, bytes32 evidenceHash))`, with the fields below. The leaves are sorted ascending; each parent is keccak256 of its two children concatenated in ascending order; a node without a sibling moves up unchanged; one leaf is its own root. Each project-night stores its proof (the sibling hashes from its leaf to the root) and shares the root attestation's UID. Up to 500 project-nights go in one root, so a night with up to 500 watched projects is exactly one transaction (`attestRoot()` in `src/lib/attest/eas.ts`, `buildTree()` in `src/lib/attest/merkle.ts`, `buildNightManifest()` in `src/lib/attest/manifest.ts`).

A live run is attested on its own, under the per-project schema:

```
bytes32 projectKey,uint32 night,uint8 kind,uint8 status,uint16 lit30,bytes32 evidenceHash,uint256 agentId,string evidenceURI
```

Both are exactly these strings, without spaces after the commas. Non-revocable, no resolver. Each UID is deterministic: keccak256 of the schema string, the zero resolver address and `false` (`rootSchemaUid()` and `schemaUid()` in `src/lib/attest/eas.ts`).

| Field | Meaning |
|---|---|
| `projectKey` | keccak256 of the project slug, e.g. `revoke-cash` |
| `night` | UTC date of the shift as yyyymmdd |
| `kind` | 0 = nightly shift, 1 = live run |
| `status` | 1 shipped, 2 building, 3 quiet, 4 down, 5 unavailable |
| `lit30` | shipped or building nights among the last 30 |
| `evidenceHash` | keccak256 of the evidence bundle's canonical JSON |
| `agentId` | the watcher's ERC-8004 agent id |
| `evidenceURI` | `https://lights-on-watch.vercel.app/api/v1/evidence/<evidenceHash>` |

## How to check each artifact

You need nothing but a browser for the links above. For command-line checks, [Foundry](https://getfoundry.sh)'s `cast` and a public RPC are enough:

```bash
RPC=https://base-rpc.publicnode.com
```

**Both schemas are registered and are the ones in the code.**

```bash
for UID in 0xfe6c6dba61a36a6fbdf682e0d8bf3903a289ebb186e172c59aa9c578b673e726 \
           0x18fe45e82c5c9b1a176794774f023536a12794a76ee877ebfb0d713166e65d8b; do
  cast call 0x4200000000000000000000000000000000000020 \
    "getSchema(bytes32)((bytes32,address,bool,string))" $UID --rpc-url $RPC
done
```

Expect each UID back with the zero address, `false`, and its schema string above.

**The watcher holds the agent identity, and it points at our registration file.**

```bash
cast call 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 "ownerOf(uint256)(address)" 1167163 --rpc-url $RPC
cast call 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 "tokenURI(uint256)(string)" 1167163 --rpc-url $RPC
```

Expect `0x82e382eA991C5f48bFC565b8CfbcB6d91faD53D6` and `https://lights-on-watch.vercel.app/.well-known/agent-registration.json`. That file lists the web, MCP and REST endpoints and the same agent id.

**One transaction covers the night's observed projects.** Open the root attestation transaction on basescan: it is sent by the watcher to EAS and emits exactly one `Attested` event, with the root schema UID above. The same night at https://lights-on-watch.vercel.app/night links to this transaction and to the night manifest.

```bash
cast call 0x4200000000000000000000000000000000000021 \
  "getAttestation(bytes32)((bytes32,bytes32,uint64,uint64,uint64,bytes32,address,address,bool,bytes))" \
  0x8ea045042ae9243e0f7f8a674156878861a113fd6378ce927834575a847ab3df --rpc-url $RPC
```

The result is `(uid, schema, time, expirationTime, revocationTime, refUID, recipient, attester, revocable, data)`. Expect `schema` = the root schema UID, `expirationTime` and `revocationTime` = 0, `attester` = the watcher, `revocable` = false. Decode `data` with:

```bash
cast abi-decode "f()(bytes32,uint32,uint16,uint256,string)" <data>    # root, night, count, agentId, manifestURI
curl -s <manifestURI> -o manifest.json
cast keccak "$(cat manifest.json)"     # equals the hash at the end of manifestURI; manifest.json lists `count` leaves
```

**A night matches its published evidence.**

```bash
curl -s https://lights-on-watch.vercel.app/api/v1/evidence/0xb993799119a667ed4b82d78af5b244b500a4ad6a4bc4c695e84a86f1a2e699d1 -o evidence.json
cast keccak "$(cat evidence.json)"     # equals the evidence hash
```

The night's row (`GET /api/v1/projects/revoke-cash/nights`) carries `status`, `attestLit30`, `attestLeaf` and `attestProof`. Its leaf is

```bash
cast keccak "$(cast abi-encode "f(bytes32,uint32,uint8,uint8,uint16,bytes32)" \
  "$(cast keccak revoke-cash)" <night> 0 <status 1-5> <attestLit30> <evidenceHash>)"
```

and hashing it up with each `attestProof` step (keccak256 of the two hashes, the lower one first) gives the attested `root`. Or run all of these checks at once, from the repo:

```bash
pnpm tsx scripts/verify-night.ts --network base \
  --uid 0x8ea045042ae9243e0f7f8a674156878861a113fd6378ce927834575a847ab3df --bundle evidence.json \
  --site https://lights-on-watch.vercel.app --attester 0x82e382eA991C5f48bFC565b8CfbcB6d91faD53D6
```

The script reads the row from `--site`, but trusts none of it: a wrong status, lit30 or proof fails against the root on Base. The same checks run in the browser: open https://lights-on-watch.vercel.app/p/revoke-cash, click the night, press **Verify in this browser**.

**A live run attests on its own.** Press **Run a shift now** on any project page. The run ends with an easscan link; its attestation uses the live-run schema and has `kind` = 1. Decode its `data` with `cast abi-decode "f()(bytes32,uint32,uint8,uint8,uint16,bytes32,uint256,string)" <data>`. Live runs never overwrite a nightly reading.

## What is not onchain

- A project's verdict on its own. Base holds one Merkle root per night; each night's leaf, proof and the night manifest are served by the site and count only when they prove into that root.
- Reconstructed nights (from git history and Wayback) are never attested.
- Notes, briefings and update drafts written by AI are not attested; only the rule-decided status, the lit30 count and the evidence hash are.
- Founder notes are signed by the founder's wallet (SIWE) and stored by the site, not onchain.
