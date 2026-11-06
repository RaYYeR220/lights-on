import { siteUrl } from '@/lib/site';

export const dynamic = 'force-dynamic';

const REGISTRY = 'eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';

/** ERC-8004 agent registration file (agentURI target). `agentId` is omitted until the watcher is registered. */
export function GET(): Response {
  const site = siteUrl();
  const raw = process.env.WATCHER_AGENT_ID;
  const agentId = raw && /^\d{1,15}$/.test(raw) && Number(raw) > 0 ? Number(raw) : undefined;
  const body = {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: 'Lights On Watcher',
    description:
      'Checks every night whether watched teams are still shipping (repo, live app, onchain activity), decides a status with published rules, and attests it on Base with EAS. AI explains; it never decides.',
    image: `${site}/icon.png`,
    services: [
      { name: 'web', endpoint: site },
      { name: 'MCP', endpoint: `${site}/api/mcp`, version: '2025-06-18' },
      { name: 'REST', endpoint: `${site}/api/openapi.json` },
    ],
    registrations: [{ ...(agentId !== undefined ? { agentId } : {}), agentRegistry: REGISTRY }],
    supportedTrust: ['reputation'],
  };
  return new Response(JSON.stringify(body, null, 2), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, s-maxage=300', 'access-control-allow-origin': '*' },
  });
}
