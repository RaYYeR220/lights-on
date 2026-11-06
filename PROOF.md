# Onchain proof

All artifacts are on Base mainnet (chain id 8453). Every write comes from one watcher address.

| Artifact | Value | Check |
|---|---|---|
| Watcher (attester) | `0x82e382eA991C5f48bFC565b8CfbcB6d91faD53D6` | https://basescan.org/address/0x82e382eA991C5f48bFC565b8CfbcB6d91faD53D6 |
| EAS schema | UID `0x18fe45e82c5c9b1a176794774f023536a12794a76ee877ebfb0d713166e65d8b` | https://base.easscan.org/schema/view/0x18fe45e82c5c9b1a176794774f023536a12794a76ee877ebfb0d713166e65d8b |
| Schema registration tx | `{{TBD:schema-registration-tx}}` | https://basescan.org/tx/{{TBD:schema-registration-tx}} |
| ERC-8004 agent registration tx | `{{TBD:agent-registration-tx}}` | https://basescan.org/tx/{{TBD:agent-registration-tx}} |
| Watcher agent id | `{{TBD:agent-id}}` in registry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | `ownerOf` and `tokenURI`, below |
| First nightly `multiAttest` tx | `{{TBD:first-nightly-multiattest-tx}}` (night of `{{TBD:first-observed-night}}`) | https://basescan.org/tx/{{TBD:first-nightly-multiattest-tx}} |
| A nightly attestation (revoke-cash, `{{TBD:first-observed-night}}`) | UID `{{TBD:sample-nightly-attestation-uid}}`, evidence `{{TBD:sample-nightly-evidence-hash}}` | https://base.easscan.org/attestation/view/{{TBD:sample-nightly-attestation-uid}} |
| A live-run attestation | UID `{{TBD:live-run-attestation-uid}}`, tx `{{TBD:live-run-tx}}` | https://base.easscan.org/attestation/view/{{TBD:live-run-attestation-uid}} |

Contracts used: EAS `0x4200000000000000000000000000000000000021` and SchemaRegistry `0x4200000000000000000000000000000000000020` (Base predeploys), ERC-8004 IdentityRegistry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`.

## The schema

```
bytes32 projectKey,uint32 night,uint8 kind,uint8 status,uint16 lit30,bytes32 evidenceHash,uint256 agentId,string evidenceURI
```

Exactly this string, without spaces after the commas. Non-revocable, no resolver. The UID is deterministic: keccak256 of the schema string, the zero resolver address and `false` (`schemaUid()` in `src/lib/attest/eas.ts`).

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

**The schema is registered and is the one in the code.**

```bash
cast call 0x4200000000000000000000000000000000000020 \
  "getSchema(bytes32)((bytes32,address,bool,string))" \
  0x18fe45e82c5c9b1a176794774f023536a12794a76ee877ebfb0d713166e65d8b --rpc-url $RPC
```

Expect the same UID, the zero address, `false`, and the schema string above.

**The watcher holds the agent identity, and it points at our registration file.**

```bash
cast call 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 "ownerOf(uint256)(address)" {{TBD:agent-id}} --rpc-url $RPC
cast call 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 "tokenURI(uint256)(string)" {{TBD:agent-id}} --rpc-url $RPC
```

Expect `0x82e382eA991C5f48bFC565b8CfbcB6d91faD53D6` and `https://lights-on-watch.vercel.app/.well-known/agent-registration.json`. That file lists the web, MCP and REST endpoints and the same agent id.

**A nightly batch covers the night's observed projects.** Open the `multiAttest` transaction on basescan: it is sent by the watcher to EAS and emits one `Attested` event per project, each with the schema UID above. The same night at https://lights-on-watch.vercel.app/night links to this transaction.

**An attestation matches its published evidence.**

```bash
curl -s https://lights-on-watch.vercel.app/api/v1/evidence/{{TBD:sample-nightly-evidence-hash}} -o evidence.json
cast keccak "$(cat evidence.json)"     # equals the evidence hash

cast call 0x4200000000000000000000000000000000000021 \
  "getAttestation(bytes32)((bytes32,bytes32,uint64,uint64,uint64,bytes32,address,address,bool,bytes))" \
  {{TBD:sample-nightly-attestation-uid}} --rpc-url $RPC
```

The result is `(uid, schema, time, expirationTime, revocationTime, refUID, recipient, attester, revocable, data)`. Expect `schema` = the schema UID above, `expirationTime` and `revocationTime` = 0, `attester` = the watcher, `revocable` = false. Decode `data` with:

```bash
cast abi-decode "f()(bytes32,uint32,uint8,uint8,uint16,bytes32,uint256,string)" <data>
```

Or run all of these checks at once, from the repo:

```bash
pnpm tsx scripts/verify-night.ts --network base \
  --uid {{TBD:sample-nightly-attestation-uid}} --bundle evidence.json \
  --attester 0x82e382eA991C5f48bFC565b8CfbcB6d91faD53D6
```

The same checks run in the browser: open https://lights-on-watch.vercel.app/p/revoke-cash, click the night, press **Verify in this browser**.

**A live run attests on its own.** Press **Run a shift now** on any project page. The run ends with an easscan link; its attestation has `kind` = 1. Live runs never overwrite a nightly reading.

## What is not onchain

- Reconstructed nights (from git history and Wayback) are never attested.
- Notes, briefings and update drafts written by AI are not attested; only the rule-decided status, the lit30 count and the evidence hash are.
- Founder notes are signed by the founder's wallet (SIWE) and stored by the site, not onchain.
