import { RULES_TEXT } from '@/lib/shift/rules';
import { ROOT_SCHEMA, SCHEMA, rootSchemaUid, schemaUid } from '@/lib/attest/eas';
import { siteUrl } from '@/lib/site';
import { getStudyView } from '@/lib/views/study';

export const dynamic = 'force-dynamic';

export function GET(): Response {
  const site = siteUrl();
  const study = getStudyView();
  const body = `# Lights On

> Lights On is a nightly check on whether teams are still shipping. Every night a watcher looks at each project's public repo, live app and onchain activity, decides a status with fixed rules, and attests it on Base with EAS. AI can explain a night afterwards; it never decides the status.

Site: ${site}

## Why it exists: the study

${study.headline} ${study.contrast}
Basis: ${study.basis}, nights ${study.window30From} to ${study.latestNight}. Quiet means no verified change seen, nothing more.
Full study (Vibeathon 01 finalists, commit graphs vs shipping, method): ${site}/study

## Statuses

shipped, building, quiet, down, unavailable.

## Rules

${RULES_TEXT.map((r, i) => `${i + 1}. ${r}`).join('\n')}

## Ask about a project (read-only, no auth)

- MCP (Streamable HTTP): ${site}/api/mcp
  Tools: list_projects, get_project, get_night, is_still_shipping, get_briefing, watch_project.
  Start with is_still_shipping { "slug": "revoke-cash" }.
- REST (JSON, CORS open, cached 5 minutes), spec at ${site}/api/openapi.json:
  - GET ${site}/api/v1/projects?with=lastNight,history   history = the last 90 nights as a 90-letter string, oldest first: S shipped, B building, Q quiet, D down, U unavailable, . no night
  - GET ${site}/api/v1/projects/{slug}
  - GET ${site}/api/v1/projects/{slug}/nights?from=yyyymmdd&to=yyyymmdd
  - GET ${site}/api/v1/evidence/{hash}   the canonical evidence bundle for a night
  - GET ${site}/api/v1/manifest/{hash}   the night manifest: every project-night of a nightly root attestation
  - GET ${site}/api/v1/briefing/{address}   backer briefing for a wallet or .eth name
  - POST ${site}/api/v1/watch { "liveUrl": "...", "repo": "owner/name", "contract": "0x..." }   rate-limited; after its first check succeeds the project is reachable by slug (unlisted)
- Agent registration (ERC-8004): ${site}/.well-known/agent-registration.json

## Verify a night yourself

1. Read the night: GET ${site}/api/v1/projects/{slug}/nights. Each night has evidenceHash, attestationUid and, once attested, attestProof, attestLit30 and attestRoot.
2. Fetch the evidence: GET ${site}/api/v1/evidence/{evidenceHash}. Hashing the canonical bundle gives evidenceHash.
3. Re-run the published rules (${site}/methodology) over that bundle: you get the same status.
4. One transaction per night: a Merkle root of every project's verdict. Look up attestationUid on Base (EAS 0x4200000000000000000000000000000000000021, for example base.easscan.org/attestation/view/{uid}); it is made by the watcher's registered agent and carries the root. Rebuild the leaf keccak256(abi.encode(bytes32 keccak256(slug), uint32 night, uint8 0, uint8 status 1-5, uint16 attestLit30, bytes32 evidenceHash)) and hash it up with attestProof (each step: keccak256 of the two hashes concatenated in ascending order): you land on the attested root. The manifestURI in the attestation lists every leaf of the night.
5. Live runs are attested one by one under the per-project schema: there the attestation's own fields carry the status, lit30 and evidenceHash.

Nightly root schema (not revocable): ${ROOT_SCHEMA}
Root schema uid: ${rootSchemaUid()}
Per-project schema, live runs (not revocable): ${SCHEMA}
Schema uid: ${schemaUid()}

## Notes

- Night = UTC date yyyymmdd of the shift start; the nightly window is the 24 hours before 05:00 UTC.
- Summaries are short plain text for people; use status and reasons for decisions.
`;
  return new Response(body, {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, s-maxage=300', 'access-control-allow-origin': '*' },
  });
}
