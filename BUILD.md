# How this was built

Lights On was built with AI coding agents. This page says which agents, how they worked, and what people decided.

## Agents and models

- **Main agent:** Claude Code running Claude Opus 5.5. It held the written design and the plan, dispatched the work and integrated the results.
- **Subagent-driven development:** each plan task went to a fresh implementer subagent, which wrote the tests first and then the code. A fresh reviewer subagent, with no shared context with the implementer, then checked the result against the task and the design. Its findings went back as a fix round. A final review covered the whole branch.
- **Security reviews:** automated security reviews ran over the changes, and their findings were fixed in further rounds.
- **Inside the product:** Claude Haiku 5.5 classifies commits and deploys, and Claude Sonnet 5.5 writes night notes, briefing wording and founder update drafts. Both are served through Venice's OpenAI-compatible API (`claude-haiku-5-5` and `claude-sonnet-5-5` in `src/lib/ai/prompts.ts`). They explain; the rules decide.

## Workflow

1. **Written design.** Problem, users, goals, non-goals and anti-goals, architecture, data model, status rules, attestation, security and testing, before any code.
2. **Plan with 22 tasks.** Each task lists its files, interfaces and the tests to write first. Tasks are ordered so the core loop (evidence, rules, attestation, shift) lands first and later items can be dropped without breaking it.
3. **TDD per task.** Failing tests first, then the code that makes them pass.
4. **Task reviews.** A separate reviewer per task, as above. The plan named the risks every review had to check: per-request noise in HTML reading as a deploy, rewritten repo history, hostile URLs (SSRF), concurrent writes on one project-night, and prompt injection through repo and site text. Each has its own test.
5. **Security reviews.** Automated security reviews over the changes.
6. **Fix rounds.** Review and security findings fixed and re-reviewed.
7. **Chain writes on a fork first.** Schema registration, the nightly Merkle-root attestation through the real finalize path, per-project `attest`, agent registration and verification run against a local anvil fork of Base mainnet (`pnpm test:fork`) before anything is sent to mainnet. The same suite measures the gas of one root over 52 project-nights against 52 per-project attestations.

## Counts, read from the repository

| | |
|---|---|
| Commits | {{TBD:commit-count}} (`git rev-list --count HEAD`) |
| Test files | 40: 36 Vitest files (unit and integration; Postgres runs in memory via pglite), 3 Playwright specs, 1 fork suite |
| Test cases | ≈475 Vitest, ≈36 Playwright, ≈7 fork. Counted from `it(` / `test(` call sites, so table-driven `.each` cases expand further at run time |
| Source | ≈14,000 lines of TypeScript in `src/`, ≈7,000 in `tests/` |
| Database migrations | 13, in `drizzle/` |

## Who decided what

**People decided:**

- The concept and its one job: tell a backer each morning whether the builders they backed shipped, with proof.
- The visual design, picked from several UI variants the agents produced.
- Funding the watcher wallet, the production deploy, and registering the schema and the agent identity onchain.
- What gets published, including this page.

**Agents decided, within the design and under review:**

- The architecture: one Next.js app on Vercel, Postgres on Neon, EAS instead of a custom contract, an ERC-8004 identity for the watcher, rules that decide with AI that only explains, an Atom-feed fallback for GitHub, a nightly shift at 05:00 UTC, and 90 nights of reconstructed history labelled as such.
- All code, tests, migrations and scripts, and the first drafts of the copy and these documents.

Commits carry the maintainer's git identity. This page, not per-commit trailers, is where agent involvement is disclosed.

## Guardrails the agents worked under

- **No fabricated evidence.** A failing source is recorded as failed and the night is decided from the rest. Over a cap, a run says `skipped` instead of inventing a value.
- **No bursts against shared APIs.** The nightly shift has a per-night GitHub call budget with an Atom-feed fallback; the history backfill uses `git clone` instead of the API.
- **Transactions are never sent twice.** The signed transaction hash is stored before broadcast, and a batch is settled from the chain before it can be retried. Gas is capped per day.
- **Neutral language.** "Scam", "rug", "dead", "abandoned" and "fraud" are filtered out of AI output and founder notes.
- **Numbers come from data.** Every figure in the README is rendered from `results/*.json` by `scripts/render-readme.ts`; none is typed by hand.
