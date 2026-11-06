import { createConfig, http, injected } from "wagmi";
import { base } from "wagmi/chains";

/**
 * Founders only ever sign messages here (no transactions), on Base. Injected wallets only: the Base Account connector's
 * SDK (@base-org/account 2.4 via @wagmi/connectors) pulls in @coinbase/cdp-sdk, which does not resolve in this build.
 */
export const wagmiConfig = createConfig({
  chains: [base],
  connectors: [injected({ shimDisconnect: true })],
  transports: { [base.id]: http(process.env.NEXT_PUBLIC_BASE_RPC_URL || undefined) },
  ssr: true,
});
