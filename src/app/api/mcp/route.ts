import { AsyncLocalStorage } from 'node:async_hooks';
import { createMcpHandler } from 'mcp-handler';
import { z } from 'zod';
import { getDb } from '@/lib/db';
import { cachedRead } from '@/lib/apiCache';
import { safeErrorCode } from '@/lib/net/redact';
import {
  HISTORY_LEGEND, ToolError, getBriefing, getNight, getProject, isStillShipping, listProjects, watchInput, watchProject,
} from '@/lib/mcp/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120; // watch_project schedules its first shift with after()

// The tool callbacks do not see the HTTP request; the rate limiters need the caller's address.
const requestHeaders = new AsyncLocalStorage<Headers>();

async function run(fn: () => Promise<unknown>) {
  try {
    const out = await fn();
    return { content: [{ type: 'text' as const, text: JSON.stringify(out) }], structuredContent: out as Record<string, unknown> };
  } catch (e) {
    const code = e instanceof ToolError ? e.code : 'internal';
    if (!(e instanceof ToolError)) console.error('mcp tool failed:', safeErrorCode(e));
    return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: code }) }] };
  }
}

/** Caller headers: the request carried by mcp-handler's context first, ALS as fallback, never undefined. */
const headersOf = (ctx: unknown): Headers =>
  (ctx as { http?: { req?: Request } } | undefined)?.http?.req?.headers ?? requestHeaders.getStore() ?? new Headers();

const slug = z.string().min(1).max(80).describe('Project slug, e.g. "revoke-cash"');
const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

const handler = createMcpHandler(
  (server) => {
    server.registerTool('list_projects', {
      title: 'List projects',
      description: 'Every watched project with its latest nightly status, 30-night record and bay. Set history for the last 90 nights as a 90-letter string.',
      inputSchema: z.object({ history: z.boolean().optional().describe(`Include the last 90 nights as a 90-letter string, oldest first, last = today: ${HISTORY_LEGEND}`) }),
      annotations: READ_ONLY,
    }, ({ history }, ctx) => run(() => cachedRead(`list:${history ? 'history' : 'plain'}`, headersOf(ctx), async () => listProjects(await getDb(), { history: !!history }))));

    server.registerTool('get_project', {
      title: 'Get project',
      description: 'One project: details, 30-night record, latest night with reasons and attestation, Vibestarter tranche summary.',
      inputSchema: z.object({ slug }),
      annotations: READ_ONLY,
    }, ({ slug: s }, ctx) => run(() => cachedRead(`project:${s}`, headersOf(ctx), async () => getProject(await getDb(), s))));

    server.registerTool('get_night', {
      title: 'Get night',
      description: 'One project-night (yyyymmdd): status, reasons, summary, evidence hash and EAS attestation uid.',
      inputSchema: z.object({ slug, night: z.number().int().describe('UTC date as yyyymmdd, e.g. 20261105') }),
      annotations: READ_ONLY,
    }, ({ slug: s, night }, ctx) => run(() => cachedRead(`night:${s}:${night}`, headersOf(ctx), async () => getNight(await getDb(), s, night))));

    server.registerTool('is_still_shipping', {
      title: 'Is this team still shipping?',
      description: 'Short answer for one project: latest status, streak, lit nights in the last 30, last ship, and the EAS attestation that backs it.',
      inputSchema: z.object({ slug }),
      annotations: READ_ONLY,
    }, ({ slug: s }, ctx) => run(() => cachedRead(`shipping:${s}`, headersOf(ctx), async () => isStillShipping(await getDb(), s))));

    server.registerTool('get_briefing', {
      title: 'Backer briefing',
      description: 'Morning briefing for a wallet address or .eth name: the watched projects it backs or holds, and what changed.',
      inputSchema: z.object({ address: z.string().min(1).max(200).describe('0x address or ENS name') }),
      annotations: READ_ONLY,
    }, ({ address }, ctx) => run(async () => getBriefing(await getDb(), address, headersOf(ctx))));

    server.registerTool('watch_project', {
      title: 'Watch a project',
      description: 'Ask Lights On to watch a new project. Rate-limited (3 per day per caller, 50 per day overall). The project is unlisted: reachable by slug once its first check succeeds, never in list_projects.',
      inputSchema: watchInput,
      annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: true },
    }, (args, ctx) => run(async () => watchProject(await getDb(), args, { headers: headersOf(ctx) })));
  },
  {
    serverInfo: { name: 'lights-on', version: '1.0.0' },
    instructions: 'Lights On watches whether teams ship. Status comes from rules over verified evidence, never from AI, and every night is attested on Base via EAS. Start with is_still_shipping.',
  },
);

const withHeaders = (req: Request) => requestHeaders.run(req.headers, () => handler(req));

export { withHeaders as GET, withHeaders as POST };
