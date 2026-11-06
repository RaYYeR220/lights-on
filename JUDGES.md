# Review in 5 minutes

Everything below runs in a browser with no wallet, account or funds. Site: **https://lights-on-watch.vercel.app**

1. **Open the site.** https://lights-on-watch.vercel.app
   Each window in the building is a watched project, lit by last night's status. The line under the buttons names the night, whether it was attested on Base, and how many projects shipped.
   *Shows:* the landing reads the latest real shift, not a mock.

2. **Open last night's shift.** https://lights-on-watch.vercel.app/night
   Counts by status, every project's reading and note, and the night's attestation transaction.
   *Shows:* one nightly `multiAttest` covers every observed project. The first observed night is `{{TBD:first-observed-night}}`; earlier nights are reconstructed and labelled as such.

3. **Open a project with real history.** https://lights-on-watch.vercel.app/p/revoke-cash
   Status, streak, lit nights in the last 30, and a 90-night strip. Hatched nights were reconstructed from git history and Wayback captures; solid nights were observed by the watcher.
   *Shows:* a status is a function of evidence and published rules, and reconstructed history is kept apart from observed history.

4. **Press "Run a shift now"** on that page.
   The steps stream in: loading the project, reading the repo, checking the live app, reading the chain, applying the rules, writing the explanation, sealing the evidence, attesting on Base. The result links to easscan.
   *Shows:* the full pipeline runs on demand and ends in a Base mainnet attestation. Live runs are limited to 1 per project per 5 minutes and 3 per visitor per 10 minutes; if you hit the limit, try https://lights-on-watch.vercel.app/p/corvo-edge.

5. **Click the latest solid night in the strip, then "Verify in this browser".**
   The drawer shows the evidence by tier (VERIFIED decides, REPORTED is shown only), the evidence hash and the attestation. Verify re-hashes the published bundle and reads the attestation from Base in your browser.
   *Shows:* what is on Base is exactly the published evidence, checked without trusting our server: schema, attester, not revoked, not expired, project, night and hash.

6. **Open a real backer.** https://lights-on-watch.vercel.app/b/0x60bc5323c0e0e9144af0b35ce8de119fc743e345
   A public wallet that backed Corvo Edge on Vibestarter.
   *Shows:* backers are found from onchain Vibestarter contributions and token balances, and get a morning briefing, with no login.

7. **Open a Vibestarter raise.** https://lights-on-watch.vercel.app/p/corvo-edge
   The tranche schedule read from Vibestarter, a challenge-window countdown when a tranche has been requested, and the founder's claim link.
   *Shows:* the delivery record sits next to the tranche schedule; Vibestarter data is labelled reported and never changes a status.

8. **Read the rules.** https://lights-on-watch.vercel.app/methodology
   *Shows:* the page renders `RULES_TEXT` from `src/lib/shift/rules.ts`, the same file that decides every status, plus the honest limits.

9. **Ask the MCP server.** Endpoint: https://lights-on-watch.vercel.app/api/mcp

   ```bash
   npx @modelcontextprotocol/inspector --cli https://lights-on-watch.vercel.app/api/mcp \
     --transport http --method tools/call --tool-name is_still_shipping --tool-arg slug=revoke-cash
   ```

   *Shows:* agents get the same answer as the page, with the attestation UID and schema UID that back it. REST mirror: https://lights-on-watch.vercel.app/api/openapi.json

10. **Check the chain.**
    - Schema: https://base.easscan.org/schema/view/0x18fe45e82c5c9b1a176794774f023536a12794a76ee877ebfb0d713166e65d8b
    - Watcher address: https://basescan.org/address/0x82e382eA991C5f48bFC565b8CfbcB6d91faD53D6
    - First nightly batch: https://basescan.org/tx/{{TBD:first-nightly-multiattest-tx}}
    - One nightly attestation: https://base.easscan.org/attestation/view/{{TBD:sample-nightly-attestation-uid}}
    - One live-run attestation: https://base.easscan.org/attestation/view/{{TBD:live-run-attestation-uid}}
    - Watcher identity: ERC-8004 agent `{{TBD:agent-id}}`, registered in https://basescan.org/tx/{{TBD:agent-registration-tx}}

    *Shows:* every attestation comes from one address that holds a registered agent identity. Details and command-line checks: [PROOF.md](PROOF.md).

## Optional: verify from a terminal

```bash
git clone {{TBD:repo-url}} lights-on && cd lights-on && pnpm install
curl -s https://lights-on-watch.vercel.app/api/v1/evidence/{{TBD:sample-nightly-evidence-hash}} -o evidence.json
pnpm tsx scripts/verify-night.ts --network base \
  --uid {{TBD:sample-nightly-attestation-uid}} --bundle evidence.json \
  --attester 0x82e382eA991C5f48bFC565b8CfbcB6d91faD53D6
```

Read-only. It prints PASS or FAIL per check and exits 0 only on a full match.

What each public claim rests on is in [CLAIMS.md](CLAIMS.md). How the product was built is in [BUILD.md](BUILD.md).
