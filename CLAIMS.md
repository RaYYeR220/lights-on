# Claims

Every public claim in the README, tagged by how you can check it.

| Tag | Meaning |
|---|---|
| **REPRODUCIBLE** | Anyone with the repo gets the same result from the code, a test, a script, or a pure function over published data. |
| **VERIFIED-LIVE** | Checkable right now on the live site or on Base mainnet. |
| **MODELED** | An inference or heuristic, not a direct observation. The method and inputs are published so you can judge it. |
| **NOT-CLAIMED** | We do not claim this. Listed so nobody reads it into the product. |

Paths are relative to the repo root. Tests run with `pnpm vitest run` unless noted.

## Headline and study numbers

| # | Claim | Tag | How to reproduce or check |
|---|---|---|---|
| 1 | <!-- num:field.hackathon.quiet30 -->30<!-- /num --> of <!-- num:field.hackathon.withHistory -->33<!-- /num --> watched hackathon builds on Base had no detected commit or deploy activity in the last 30 nights. | REPRODUCIBLE | The count is `field.hackathon.quiet30` / `field.hackathon.withHistory` in `results/study-field.json`, produced by `scripts/study.ts` through `fieldSummary()` in `src/lib/study.ts` (tests: `tests/scripts/study.test.ts`). Re-render: `pnpm tsx scripts/render-readme.ts README.md`. |
| 2 | Those nights reflect what the projects actually did. | MODELED | The nights are reconstructed (basis: <!-- num:headline.basis -->reconstructed history (git + Wayback), not attested<!-- /num -->). Git nights bucket commits by author date; Wayback nights compare deploy fingerprints between archived captures. Method: `/methodology#reconstructed`, code: `scripts/backfill-git.ts`, `scripts/backfill-wayback.ts`, `src/lib/backfill/*`. Recomputing from scratch re-reads git hosts and Wayback, which can drift as new captures appear. |
| 3 | Only projects with a usable 30-night window are counted. | REPRODUCIBLE | `MIN_FULL_NIGHTS_30` (at least 25 nights with a reading) in `src/lib/study.ts`; `unavailable` nights never count as coverage, and partial windows are reported as unknown, not quiet. |
| 4 | <!-- num:field.reference.active30 -->8<!-- /num --> of <!-- num:field.reference.withHistory -->8<!-- /num --> large reference apps showed activity in the same window. | REPRODUCIBLE | `field.reference.*` in `results/study-field.json`; the reference list is `REFERENCE_APPS` in `src/lib/study.ts`. Same basis as #2. |
| 5 | <!-- num:commitVsShip.commitsNoVerifiedShip -->5<!-- /num --> of <!-- num:commitVsShip.withHistory -->46<!-- /num --> projects had commits but no detected deploy; <!-- num:commitVsShip.shipNightsWithoutCodeCommits -->5<!-- /num --> projects had ship nights with no code commit. | REPRODUCIBLE | `results/commit-vs-ship.json` (definitions and project names inside), from `commitVsShip()` in `src/lib/study.ts`. Same basis as #2. |
| 6 | No number in the README is typed by hand. | REPRODUCIBLE | Every number sits in a `<!-- num:<key> -->` span; `scripts/render-readme.ts` fills it from `results/*.json` and fails on unknown keys. The survivor-biased median is refused as a standalone key (`renderNumbers()` in `src/lib/study.ts`). |

## The night shift

| # | Claim | Tag | How to reproduce or check |
|---|---|---|---|
| 7 | The shift runs every night at 05:00 UTC. | VERIFIED-LIVE | Schedule `0 5 * * *` in `vercel.json`; each night appears at `/night` and as a transaction from the watcher address on basescan. |
| 8 | It reads the public repo, the live app and Base. | REPRODUCIBLE | `src/lib/adapters/{repo,github,gitlab,liveapp,chain}.ts`; fixture tests in `tests/adapters/*`. |
| 9 | A source either answers or is marked failed; nothing is guessed. | REPRODUCIBLE | Adapters return `{ ok, facts, error }` and never throw; a thrown adapter still yields a night with `ok: false` (`tests/shift/run.test.ts`). Rules note `source.<name>.failed` (`tests/shift/rules.test.ts`). |
| 10 | The evidence bundle is hashed (keccak256 of canonical JSON) and served byte for byte. | REPRODUCIBLE | `canonicalize()` / `hashEvidence()` in `src/lib/shift/evidence.ts`; `tests/shift/evidence.test.ts`, `tests/api/evidence.test.ts`. Live: `cast keccak "$(curl -s <site>/api/v1/evidence/<hash>)"` prints `<hash>`. |
| 11 | The same bundle always gives the same status. | REPRODUCIBLE | `decideStatus()` in `src/lib/shift/rules.ts` is a pure function of the bundle; table-driven tests in `tests/shift/rules.test.ts`. |
| 12 | Only verified evidence decides; Vibestarter data never counts. | REPRODUCIBLE | `decideStatus()` excludes the `vibestarter` source from the deciding set; `tests/shift/rules.test.ts`. |
| 13 | A deploy fingerprint change means new code reached users. | MODELED | Fingerprint = hash of the hashed asset paths (or, for static pages, of the visible text), compared with the last good reading: `src/lib/adapters/liveapp.ts`, `tests/adapters/liveapp.test.ts` (a page that changes only a nonce or timestamp is not a deploy). |
| 14 | A commit "touched code" rather than docs, styling or config. | MODELED | Path heuristic in `src/lib/adapters/pathHeuristic.ts`; bot authors flagged by name patterns. `tests/adapters/pathHeuristic.test.ts`. |
| 15 | The AI cannot change a status. | REPRODUCIBLE | The status is decided before `explainNight()` runs (`src/lib/shift/run.ts`); the prompt is fenced as untrusted data and its output is schema-checked. `tests/shift/explain.test.ts` ("injection text in commit message does not alter decision"). |
| 16 | If the AI fails, the night says "explanation unavailable". | REPRODUCIBLE | `tests/shift/explain.test.ts` (timeout, prose instead of JSON, wrong shape, budget refused: `aiOk: false`, `summary: null`). |
| 17 | One EAS transaction per night, signed by the watcher: a Merkle root of every project's verdict. Up to 500 projects fit in one root. | VERIFIED-LIVE | Transaction `0x34f4b344304710c9fd75367a6a42d8e58875561b339da1737a1ec29dcdf1e167` on basescan, from `0x82e382eA991C5f48bFC565b8CfbcB6d91faD53D6`, with one `Attested` event under the root schema; its manifest lists every leaf. Code: `attestRoot()` in `src/lib/attest/eas.ts`, `buildTree()` in `src/lib/attest/merkle.ts`, `buildNightManifest()` in `src/lib/attest/manifest.ts`, `ATTEST_BATCH` in `src/lib/shift/finalize.ts`; `tests/shift/finalize.test.ts` ("a shift of <= 500 nights is exactly one transaction"), `tests/attest/merkle.test.ts`; round trip through `finalizeShift` on a Base fork in `tests/fork/attest.fork.test.ts` (`pnpm test:fork`). |
| 18 | The watcher has an ERC-8004 identity and never attests without one. | VERIFIED-LIVE | Agent `1167163` in registry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` (`ownerOf` = watcher). `canAttest()` in `src/lib/shift/deps.ts` refuses agent id 0; `tests/shift/deps.test.ts`. |
| 19 | Reconstructed nights are never attested. | REPRODUCIBLE | The attest queue selects observed rows only (`src/lib/db/queries.ts`); backfill writes refuse observed rows and carry no attestation fields. In the UI such nights read "reconstructed, never attested". |
| 20 | Gas, LLM and live-run caps fail closed; over the gas cap a run reports `attestation: skipped`. | REPRODUCIBLE | `CAPS` in `src/lib/shift/limits.ts`; `tests/shift/limits.test.ts`, `tests/shift/run.test.ts` ("attest skipped → live run done with attestation skipped, not failed"). |
| 21 | Subscribers get a morning briefing by Telegram or web push. | REPRODUCIBLE | `src/lib/notify/*`; `tests/notify/notify.test.ts` (template fallback when AI is unavailable). Live delivery needs the bot `@lights_on_watch_bot` and VAPID keys configured. |
| 22 | "Run a shift now" runs the same pipeline and ends on its own Base attestation. | VERIFIED-LIVE | Press the button on any project page; example attestation `0x4f3f0709742dce694a70d8107b6a4494fe2ccc81a5f63629ef49a978b2116ecb`. Code: `src/app/api/shift/live/route.ts`; `tests/shift/routes.test.ts`. |

## Backers, Vibestarter, founders

| # | Claim | Tag | How to reproduce or check |
|---|---|---|---|
| 23 | A wallet's watched projects are found from Vibestarter contributions and token balances, with no login. | VERIFIED-LIVE | `/b/0x60bc5323c0e0e9144af0b35ce8de119fc743e345` (a Corvo Edge backer). Code: `src/lib/backer.ts`; `tests/backer.test.ts`. |
| 24 | Vibestarter raise pages show the tranche schedule and a challenge-window countdown. | VERIFIED-LIVE | `/p/corvo-edge`. Schedule read from Vibestarter's campaigns API every 10 minutes (`src/lib/views/vibestarterLive.ts`), with the last shift's recorded schedule as fallback (`src/components/project/Tranches.tsx`). The countdown appears only while a requested tranche's window is open. |
| 25 | A founder claim is proven by the Vibestarter founder wallet or a nonce at `/.well-known/lights-on.txt`. | REPRODUCIBLE | SIWE on Base, single-use nonces: `src/lib/claim.ts`; `tests/claim.test.ts`. |
| 26 | A claim never changes a status; notes are shown as reported. | REPRODUCIBLE | `decideStatus()` takes only the evidence bundle; founder notes live in their own table and are rendered in the reported tier (`src/lib/claim.ts`, `src/components/project/NightDrawer.tsx`). |
| 27 | Claimed projects get a badge and a backer-update draft from the last 30 nights. | REPRODUCIBLE | `src/lib/badge.ts`, `src/app/badge/[slug]/route.ts`, `src/lib/draft.ts`; `tests/claim.test.ts`. |
| 28 | `/add` runs the first check right away; community-added projects stay unlisted. | REPRODUCIBLE | `watchProject()` in `src/lib/mcp/tools.ts` (SSRF-guarded fetch, hidden until the first run answers, never in list endpoints); `tests/mcp/tools.test.ts`. |

## Open surfaces and verification

| # | Claim | Tag | How to reproduce or check |
|---|---|---|---|
| 29 | REST + OpenAPI, MCP, `llms.txt` and an ERC-8004 registration file are public. | VERIFIED-LIVE | `/api/openapi.json`, `/api/mcp`, `/llms.txt`, `/.well-known/agent-registration.json`; `tests/mcp/routes.test.ts`. |
| 30 | MCP exposes six tools; all but `watch_project` are read-only. | REPRODUCIBLE | `src/app/api/mcp/route.ts` (tool annotations); `tests/mcp/routes.test.ts` ("tools/list shows the six tools"). |
| 31 | Anyone can verify a night without trusting the site. | REPRODUCIBLE | `verifyNight()` in `src/lib/attest/verify.ts` checks existence, schema, attester allowlist, not revoked, not expired and night; for a nightly root, that the leaf rebuilt from the bundle and the row's status and lit30 proves into the attested root and carries the bundle's hash; for a live run, project and hash field by field. The row's values are inputs, not trusted: a wrong one fails the proof (`tests/attest/verify.test.ts`). Terminal: `scripts/verify-night.ts`. Browser: `src/components/project/verifyInBrowser.ts`. |
| 32 | The schema UIDs are `0xfe6c6dba…e726` (nightly root) and `0x18fe45e8…5d8b` (live runs). | REPRODUCIBLE | `rootSchemaUid()` and `schemaUid()` in `src/lib/attest/eas.ts` = keccak256(schema string, no resolver, non-revocable). Registration: `0xb5b44d91e2417177b220f933ea9e53c95f7bd9b6c82de4126edc5d4feaa8e87b`, `0xe9a2214e894a7d07addf366cc19b9575e5ac8fa265ca12cd30508b446e84129c`. |
| 33 | Live-run and watch limits as stated in the README. | REPRODUCIBLE | `LIVE_LIMITS` in `src/lib/shift/limits.ts`, `WATCH_LIMITS` in `src/lib/mcp/tools.ts`, `BRIEFING_LIMIT` in `src/lib/briefingLimit.ts`; `tests/shift/limits.test.ts`. |

## Not claimed

- We do not claim a project is abandoned, dead or a scam. A quiet night means no verified change was seen, nothing more. Those words are filtered out of AI output and founder notes (`src/lib/shift/explain.ts`, `src/lib/claim.ts`).
- We do not claim a team is inactive when its work is private. Private repos are not read.
- We do not read social signals (X, Discord, Farcaster, announcements). They never count.
- We do not claim a deploy was a meaningful feature. A deploy means new code reached users; the evidence shows what changed.
- We do not put each project's verdict on Base by itself. Base holds one root per night; the leaves, the proofs and the night manifest are published by the site and only count when they prove into that root.
- We do not claim an unlisted project is hidden from the night manifest. Community-added and moderated projects appear there with `slug: null`, but their `projectKey` is `keccak256(slug)`, so anyone who guesses a slug can confirm it. A listed project that is moderated after its night was attested keeps its slug in that night's manifest: the manifest's hash is on Base, so it can't be edited. The evidence route stops serving a moderated project's bundles.
- We do not attest reconstructed history. Only nights the watcher observed go onchain; the study numbers above are on reconstructed history and are labelled so.
- We do not claim complete history for projects without a repo. Missing Wayback captures leave nights unknown, not quiet.
- We do not claim every contract creation is seen. Deployer creations depend on Blockscout answering.
- We do not file Vibestarter challenges or advise on them. We show the schedule and link to Vibestarter.
- We do not post founder updates onchain. Vibestarter `postUpdate` is not wired.
- We do not let AI decide anything. It writes notes, briefing wording and update drafts after the rules decide.
- We do not claim the in-memory rate limits hold across serverless instances. The durable caps are the Postgres ones.
- We do not hold custody, trade, or issue a token.
