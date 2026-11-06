import { siteUrl } from '@/lib/site';
import { STATUSES } from '@/lib/db/schema';

export const dynamic = 'force-dynamic';

const status = { type: 'string', enum: [...STATUSES] };
const nullableStatus = { type: ['string', 'null'], enum: [...STATUSES, null] };
const yyyymmdd = { type: 'integer', minimum: 20200101, maximum: 20991231, description: 'UTC date as yyyymmdd' };

const record = {
  type: 'object',
  required: ['streak', 'lit30', 'lastShip'],
  properties: {
    streak: { type: 'integer', description: 'Consecutive shipped or building nights ending at the latest night' },
    lit30: { type: 'integer', description: 'Shipped or building nights among the last 30' },
    lastShip: { ...yyyymmdd, type: ['integer', 'null'], description: 'Latest night with status shipped (yyyymmdd), or null' },
  },
};

const night = {
  type: 'object',
  required: ['night', 'observed', 'status', 'reasons', 'summary', 'evidenceHash', 'evidenceUri', 'attestationUid', 'attestTx'],
  properties: {
    night: yyyymmdd,
    observed: { type: 'boolean', description: 'false = reconstructed afterwards from history' },
    status,
    reasons: { type: 'array', items: { type: 'string' }, description: 'Stable machine strings, e.g. liveapp.new_deploy' },
    summary: { type: ['string', 'null'] },
    evidenceHash: { type: ['string', 'null'] },
    evidenceUri: { type: ['string', 'null'], format: 'uri' },
    attestationUid: { type: ['string', 'null'], description: 'EAS attestation uid on Base' },
    attestTx: { type: ['string', 'null'] },
  },
};

const errorCodes = (...codes: string[]) => ({
  description: 'Error',
  content: { 'application/json': { schema: { type: 'object', required: ['error'], properties: { error: { type: 'string', enum: codes } } } } },
});

const slugParam = { name: 'slug', in: 'path', required: true, schema: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,79}$' } };
const cache = { 'Cache-Control': { schema: { type: 'string' }, description: 'public, s-maxage=300' } };
const json = (schema: unknown) => ({ 'application/json': { schema } });

export function GET(): Response {
  const site = siteUrl();
  const spec = {
    openapi: '3.1.0',
    info: {
      title: 'Lights On API',
      version: '1.0.0',
      description:
        'Is this team still shipping? Nightly project status decided by published rules over verified evidence and attested on Base with EAS. Read endpoints need no auth, answer JSON, send open CORS and are cached for 5 minutes. The same data is available over MCP at /api/mcp.',
    },
    servers: [{ url: site }],
    paths: {
      '/api/v1/projects': {
        get: {
          operationId: 'listProjects',
          summary: 'All listed projects with latest status and record (community-added watches are unlisted)',
          parameters: [{
            name: 'with', in: 'query', required: false, style: 'form', explode: false,
            schema: { type: 'array', items: { type: 'string', enum: ['lastNight', 'history'] } },
            description: 'lastNight fields are always included. history adds 90 daily statuses (oldest first, last = today, null = no night).',
          }],
          responses: {
            200: {
              description: 'Projects (hidden ones excluded)', headers: cache,
              content: json({
                type: 'object',
                required: ['generatedAt', 'projects'],
                properties: {
                  generatedAt: { type: 'string', format: 'date-time' },
                  projects: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['slug', 'name', 'tagline', 'source', 'bay', 'status', 'confirmedAt', 'summary', 'record'],
                      properties: {
                        slug: { type: 'string' }, name: { type: 'string' }, tagline: { type: ['string', 'null'] },
                        source: { type: 'string', enum: ['vibestarter', 'vibeathon01', 'base', 'community'] },
                        bay: { type: ['integer', 'null'], description: 'Stable window position, never reassigned' },
                        status: { ...nullableStatus, description: 'Latest observed night, else latest reconstructed (see statusSource)' },
                        statusSource: { type: 'string', enum: ['reconstructed'], description: 'Present only when status is not from an observed night' },
                        confirmedAt: { type: ['string', 'null'], format: 'date-time', description: 'When the latest observed night was recorded' },
                        summary: { type: ['string', 'null'] },
                        record,
                        history: { type: 'array', minItems: 90, maxItems: 90, items: nullableStatus },
                      },
                    },
                  },
                },
              }),
            },
            500: errorCodes('internal'),
          },
        },
      },
      '/api/v1/projects/{slug}': {
        get: {
          operationId: 'getProject',
          summary: 'One project: details, record, latest night, Vibestarter tranche summary',
          parameters: [slugParam],
          responses: {
            200: {
              description: 'Project', headers: cache,
              content: json({
                type: 'object',
                properties: {
                  slug: { type: 'string' }, name: { type: 'string' }, tagline: { type: ['string', 'null'] },
                  category: { type: ['string', 'null'] }, source: { type: 'string' }, bay: { type: ['integer', 'null'] },
                  liveUrl: { type: ['string', 'null'] }, repoHost: { type: ['string', 'null'] }, repo: { type: ['string', 'null'] },
                  contracts: { type: 'array', items: { type: 'object' } }, claimed: { type: 'boolean' },
                  communityAdded: { const: true, description: 'Present for projects added via /watch: unlisted, served by slug only' },
                  status: nullableStatus, statusSource: { type: 'string', enum: ['reconstructed'] }, record,
                  latestNight: { oneOf: [night, { type: 'null' }], description: 'Observed night preferred' },
                  vibestarter: {
                    type: ['object', 'null'],
                    properties: {
                      campaignId: { type: 'string' }, escrow: { type: 'string' },
                      tranches: { type: 'array', items: { type: 'object' } }, openWindow: { type: ['object', 'null'] },
                    },
                  },
                },
              }),
            },
            404: errorCodes('not_found'),
          },
        },
      },
      '/api/v1/projects/{slug}/nights': {
        get: {
          operationId: 'getProjectNights',
          summary: 'Nights of one project (observed and reconstructed rows)',
          parameters: [
            slugParam,
            { name: 'from', in: 'query', required: false, schema: yyyymmdd, description: 'Default: 89 days before `to`' },
            { name: 'to', in: 'query', required: false, schema: yyyymmdd, description: 'Default: today (UTC). At most 366 days are returned.' },
          ],
          responses: {
            200: {
              description: 'Nights, oldest first', headers: cache,
              content: json({
                type: 'object',
                properties: { slug: { type: 'string' }, from: yyyymmdd, to: yyyymmdd, nights: { type: 'array', items: night } },
              }),
            },
            400: errorCodes('bad_request'),
            404: errorCodes('not_found'),
          },
        },
      },
      '/api/v1/evidence/{hash}': {
        get: {
          operationId: 'getEvidence',
          summary: 'The canonical evidence bundle behind a night',
          description: 'The exact JSON whose hash is the attested evidenceHash. Re-run the published rules over it to reproduce the status.',
          parameters: [{ name: 'hash', in: 'path', required: true, schema: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' } }],
          responses: {
            200: {
              description: 'Evidence bundle (v1)',
              content: json({
                type: 'object',
                required: ['v', 'rulesVersion', 'project', 'night', 'kind', 'window', 'sources'],
                properties: {
                  v: { const: 1 }, rulesVersion: { type: 'string' }, project: { type: 'string' }, night: yyyymmdd,
                  kind: { type: 'string', enum: ['nightly', 'live'] },
                  window: { type: 'object', properties: { start: { type: 'string', format: 'date-time' }, end: { type: 'string', format: 'date-time' } } },
                  sources: {
                    type: 'object',
                    description: 'Adapter results per source (repo, liveapp, chain, vibestarter); null when a source does not apply.',
                    additionalProperties: { type: ['object', 'null'] },
                  },
                },
              }),
            },
            404: errorCodes('not_found'),
          },
        },
      },
      '/api/v1/briefing/{address}': {
        get: {
          operationId: 'getBriefing',
          summary: 'Morning briefing for a wallet address or .eth name',
          parameters: [{ name: 'address', in: 'path', required: true, schema: { type: 'string' }, description: '0x address or ENS name' }],
          responses: {
            200: {
              description: 'Projects the wallet backs or holds and a short briefing', headers: cache,
              content: json({
                type: 'object',
                properties: {
                  address: { type: 'string' }, displayName: { type: 'string' }, degraded: { type: 'boolean' },
                  projects: { type: 'array', items: { type: 'object' } },
                  briefing: { type: 'object', properties: { text: { type: 'string' }, aiOk: { type: 'boolean' } } },
                },
              }),
            },
            308: { description: 'Redirect to the checksummed address' },
            400: errorCodes('invalid_address', 'ens_unavailable'),
            404: errorCodes('ens_not_found'),
            429: errorCodes('rate_limited'),
          },
        },
      },
      '/api/v1/watch': {
        post: {
          operationId: 'watchProject',
          summary: 'Ask Lights On to watch a new project',
          description:
            'Rate-limited: 3 per day per caller, 50 per day overall. The URL must answer. The project is created hidden; after its first check succeeds it is reachable by slug (unlisted: never in /api/v1/projects). If the check fails it stays hidden, and watching the same URL again re-queues it.',
          requestBody: {
            required: true,
            content: json({
              type: 'object',
              required: ['liveUrl'],
              properties: {
                liveUrl: { type: 'string', format: 'uri', description: 'Public http(s) URL' },
                repo: { type: 'string', description: 'owner/name, or a github.com / gitlab.com URL' },
                contract: { type: 'string', description: 'Base contract address (0x...)' },
              },
            }),
          },
          responses: {
            202: {
              description: 'Accepted (status exists = this URL is already watched)',
              content: json({
                type: 'object', required: ['status'],
                properties: { slug: { type: 'string', description: 'Omitted when a hidden project with this URL is re-queued' }, status: { type: 'string', enum: ['queued', 'exists'] } },
              }),
            },
            400: errorCodes('bad_request', 'invalid_url', 'invalid_repo', 'invalid_contract', 'blocked_url', 'unreachable'),
            429: errorCodes('rate_limited'),
            503: errorCodes('misconfigured'),
          },
        },
      },
    },
  };
  return new Response(JSON.stringify(spec, null, 2), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, s-maxage=300', 'access-control-allow-origin': '*' },
  });
}
