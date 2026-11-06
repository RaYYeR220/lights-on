import {
  pgTable, serial, text, integer, boolean, jsonb, timestamp, date, numeric, uniqueIndex, index, primaryKey, check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { EvidenceBundle, Step } from '@/lib/types';
import type { NightManifest } from '@/lib/attest/manifest';

export const SOURCES = ['vibestarter', 'vibeathon01', 'base', 'community'] as const;
export const STATUSES = ['shipped', 'building', 'quiet', 'down', 'unavailable'] as const;
export const SHIFT_KINDS = ['nightly', 'live', 'backfill'] as const;
const CHANNELS = ['telegram', 'webpush'] as const;

export interface ContractRef { chainId: number; address: string; role: string }
export interface TokenRef { chainId: number; address: string; symbol: string }
export interface VibestarterRef { campaignId: string; escrow: string; founderWallet: string }

const tsz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const inList = (col: string, xs: readonly string[]) =>
  sql.raw(`${col} in (${xs.map((x) => `'${x}'`).join(', ')})`);

export const projects = pgTable('projects', {
  id: serial('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  tagline: text('tagline'),
  category: text('category'),
  source: text('source', { enum: SOURCES }).notNull(),
  liveUrl: text('live_url'),
  repoHost: text('repo_host', { enum: ['github', 'gitlab'] }),
  repo: text('repo'),
  defaultBranch: text('default_branch'),
  contracts: jsonb('contracts').$type<ContractRef[]>(),
  token: jsonb('token').$type<TokenRef>(),
  vibestarter: jsonb('vibestarter').$type<VibestarterRef>(),
  claimedBy: text('claimed_by'),
  claimVerifiedAt: tsz('claim_verified_at'),
  addedBy: text('added_by'),
  createdAt: tsz('created_at').notNull().defaultNow(),
  hidden: boolean('hidden').notNull().default(false),
  /** Stable window position in the tower (1 = top left): max+1 at creation, kept across nights (reordered once before launch by scripts/reassign-bays.ts). */
  bay: integer('bay').unique(),
}, () => [check('projects_source_chk', inList('source', SOURCES))]);

export const shifts = pgTable('shifts', {
  id: serial('id').primaryKey(),
  kind: text('kind', { enum: SHIFT_KINDS }).notNull(),
  night: date('night', { mode: 'string' }).notNull(),
  startedAt: tsz('started_at').notNull().defaultNow(),
  finishedAt: tsz('finished_at'),
  planned: integer('planned').notNull().default(0),
  done: integer('done').notNull().default(0),
  /** Every root attestation tx of the shift (one per batch of up to 500 nights), in send order (appended atomically, never duplicated). */
  attestTxs: text('attest_tx').array(),
  gasUsed: numeric('gas_used', { mode: 'string' }),
  status: text('status').notNull().default('running'),
  /** Per-shift caps (LLM tokens, GitHub REST calls); the per-day caps live in `budget`. */
  llmTokens: numeric('llm_tokens', { mode: 'string' }).notNull().default('0'),
  githubCalls: integer('github_calls').notNull().default(0),
  notes: text('notes'),
  /** Stale-pass lease: one finalize pass at a time per shift. */
  leaseUntil: tsz('lease_until'),
}, (t) => [
  check('shifts_kind_chk', inList('kind', SHIFT_KINDS)),
  uniqueIndex('shifts_nightly_night_uq').on(t.kind, t.night).where(sql`${t.kind} = 'nightly'`),
]);

export const nights = pgTable('nights', {
  id: serial('id').primaryKey(),
  projectId: integer('project_id').notNull().references(() => projects.id),
  night: date('night', { mode: 'string' }).notNull(),
  shiftId: integer('shift_id').references(() => shifts.id),
  status: text('status', { enum: STATUSES }).notNull(),
  observed: boolean('observed').notNull().default(true),
  signals: jsonb('signals').$type<Record<string, unknown>>(),
  summary: text('summary'),
  notable: jsonb('notable').$type<unknown[]>(),
  evidenceHash: text('evidence_hash'),
  attestationUid: text('attestation_uid'),
  attestTx: text('attest_tx'),
  /** Nonce of attest_tx (set before signing): a not-found tx is dropped only once a later tx consumed this nonce. */
  attestNonce: integer('attest_nonce'),
  /** Address that signed attest_tx: its nonce is checked against this account, not whatever key is configured now. */
  attestSender: text('attest_sender'),
  /** First persist of attest_tx (before the send): a `dropped` verdict is acted on only once this is 10 min old. */
  attestSentAt: tsz('attest_sent_at'),
  attestClaimedAt: tsz('attest_claimed_at'),
  /** Claim token (random uuid per claim statement): every write to a claimed row must present it. */
  attestClaimId: text('attest_claim_id'),
  /**
   * Nightly rows are attested as one Merkle root per batch (attestation_uid = that ROOT attestation's uid). Written
   * with attest_tx in the same statement, before the send: this row's leaf, its proof (sibling hashes, leaf to root),
   * the root, the lit30 the leaf commits to, and the hash of the batch's night manifest.
   */
  attestLeaf: text('attest_leaf'),
  attestProof: text('attest_proof').array(),
  attestRoot: text('attest_root'),
  attestLit30: integer('attest_lit30'),
  attestManifest: text('attest_manifest'),
  aiModel: text('ai_model'),
  aiOk: boolean('ai_ok').notNull().default(false),
  createdAt: tsz('created_at').notNull().defaultNow(),
}, (t) => [
  uniqueIndex('nights_project_night_observed_uq').on(t.projectId, t.night, t.observed),
  index('nights_night_idx').on(t.night),
  check('nights_status_chk', inList('status', STATUSES)),
]);

/** Canonical manifests of nightly root attestations, content-addressed (hash = keccak256 of the canonical body). */
export const nightManifests = pgTable('night_manifests', {
  hash: text('hash').primaryKey(),
  night: date('night', { mode: 'string' }).notNull(),
  root: text('root').notNull(),
  body: jsonb('body').$type<NightManifest>().notNull(),
  createdAt: tsz('created_at').notNull().defaultNow(),
}, (t) => [index('night_manifests_night_idx').on(t.night)]);

export const liveRuns = pgTable('live_runs', {
  id: serial('id').primaryKey(),
  projectId: integer('project_id').notNull().references(() => projects.id),
  startedAt: tsz('started_at').notNull().defaultNow(),
  steps: jsonb('steps').$type<Step[]>().notNull().default([]),
  status: text('status').notNull().default('running'),
  evidenceHash: text('evidence_hash'),
  attestationUid: text('attestation_uid'),
  tx: text('tx'),
  requesterIpHash: text('requester_ip_hash'),
}, (t) => [index('live_runs_project_idx').on(t.projectId, t.startedAt)]);

export const snapshots = pgTable('snapshots', {
  id: serial('id').primaryKey(),
  projectId: integer('project_id').notNull().references(() => projects.id),
  adapter: text('adapter').notNull(),
  takenAt: tsz('taken_at').notNull().defaultNow(),
  fingerprint: text('fingerprint'),
  data: jsonb('data').$type<unknown>(),
}, (t) => [index('snapshots_project_adapter_idx').on(t.projectId, t.adapter, t.takenAt)]);

export const evidence = pgTable('evidence', {
  hash: text('hash').primaryKey(),
  projectId: integer('project_id').notNull().references(() => projects.id),
  night: date('night', { mode: 'string' }).notNull(),
  bundle: jsonb('bundle').$type<EvidenceBundle>().notNull(),
});

export const trancheEvents = pgTable('tranche_events', {
  projectId: integer('project_id').notNull().references(() => projects.id),
  trancheIndex: integer('tranche_index').notNull(),
  requestedAt: tsz('requested_at'),
  windowEndsAt: tsz('window_ends_at'),
  amountWei: numeric('amount_wei', { mode: 'string' }),
  tx: text('tx'),
  alerted: boolean('alerted').notNull().default(false),
}, (t) => [primaryKey({ columns: [t.projectId, t.trancheIndex] })]);

export const subscriptions = pgTable('subscriptions', {
  id: serial('id').primaryKey(),
  channel: text('channel', { enum: CHANNELS }).notNull(),
  target: text('target').notNull(),
  addresses: text('addresses').array().notNull().default(sql`'{}'::text[]`),
  projectIds: integer('project_ids').array().notNull().default(sql`'{}'::integer[]`),
  createdAt: tsz('created_at').notNull().defaultNow(),
  lastSentAt: tsz('last_sent_at'),
  /** sha256 of the push endpoint (webpush rows): upsert/delete key. */
  endpointHash: text('endpoint_hash'),
  /** Salted requester hash at creation (webpush rate limit). */
  ipHash: text('ip_hash'),
  /** Last on-demand AI briefing (1 per chat per hour). */
  aiBriefAt: tsz('ai_brief_at'),
  /** Webpush reservation not yet confirmed by the push service; senders skip these rows. */
  pending: boolean('pending').notNull().default(false),
}, (t) => [
  check('subscriptions_channel_chk', inList('channel', CHANNELS)),
  uniqueIndex('subscriptions_channel_target_uq').on(t.channel, t.target),
  uniqueIndex('subscriptions_endpoint_hash_uq').on(t.endpointHash),
  index('subscriptions_pending_idx').on(t.lastSentAt, t.id),
]);

export const founderNotes = pgTable('founder_notes', {
  id: serial('id').primaryKey(),
  projectId: integer('project_id').notNull().references(() => projects.id),
  night: date('night', { mode: 'string' }).notNull(),
  note: text('note').notNull(),
  author: text('author').notNull(),
  signature: text('signature').notNull(),
  createdAt: tsz('created_at').notNull().defaultNow(),
});

/** Single-use SIWE nonces for founder claim / notes / draft (only the sha256 is stored). */
export const claimNonces = pgTable('claim_nonces', {
  nonceHash: text('nonce_hash').primaryKey(),
  projectId: integer('project_id').notNull().references(() => projects.id),
  purpose: text('purpose').notNull(),
  /** Lowercase wallet the nonce was issued to; only that wallet may sign with it. */
  address: text('address').notNull().default(''),
  expiresAt: tsz('expires_at').notNull(),
  usedAt: tsz('used_at'),
  createdAt: tsz('created_at').notNull().defaultNow(),
}, (t) => [index('claim_nonces_expires_idx').on(t.expiresAt)]);

export const budget = pgTable('budget', {
  day: date('day', { mode: 'string' }).primaryKey(),
  llmTokens: numeric('llm_tokens', { mode: 'string' }).notNull().default('0'),
  gasWei: numeric('gas_wei', { mode: 'string' }).notNull().default('0'),
  liveRuns: numeric('live_runs', { mode: 'string' }).notNull().default('0'),
  githubCalls: numeric('github_calls', { mode: 'string' }).notNull().default('0'),
});

export type ProjectRow = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type NightRow = typeof nights.$inferSelect;
export type NewNight = typeof nights.$inferInsert;
export type LiveRunRow = typeof liveRuns.$inferSelect;
export type NewLiveRun = typeof liveRuns.$inferInsert;
export type ShiftRow = typeof shifts.$inferSelect;
export type SnapshotRow = typeof snapshots.$inferSelect;
