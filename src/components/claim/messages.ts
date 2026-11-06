/** Plain explanations for the claim API's fixed error codes (src/lib/claimHttp.ts). */
export const CLAIM_ERRORS: Record<string, string> = {
  bad_nonce: "This message expired or was already used (each one is good for 10 minutes, once). Get a new one and sign again.",
  expired: "This message expired (they last 10 minutes). Get a new one and sign again.",
  proof_missing:
    "No proof was found: this wallet is not the campaign's founder wallet on Vibestarter, and the proof line is not at /.well-known/lights-on.txt on the live app yet. Publish the exact line, then sign again.",
  claimed_by_other:
    "Another wallet has already claimed this project. Only the founder wallet recorded on Vibestarter can take over an existing claim.",
  wrong_chain: "The message has to be signed for Base (chain 8453). Switch your wallet to Base and sign again.",
  wrong_domain: "The message was made for a different site address. Reload this page and start again.",
  wrong_uri: "The message was made for a different site address. Reload this page and start again.",
  wrong_statement: "The message text was changed before signing. Get a new one and sign it as it is.",
  bad_message: "The signed message could not be read. Get a new one and sign it as it is.",
  bad_signature: "The signature does not match the connected wallet. Sign with the wallet shown above.",
  not_claimer: "Only the wallet that claimed this project can do this. Claim it first, with that wallet.",
  unknown_project: "This project is not on the watch (or not listed yet).",
  no_such_night: "There is no reading for that night yet, so a note cannot be attached to it.",
  bad_night: "That night is not a valid date.",
  too_long: "Notes are at most 280 characters.",
  empty_note: "The note is empty once links and formatting are removed. Write it as plain text.",
  banned_word: "The note uses a word the site does not publish. Rephrase it.",
  rate_limited: "Too many attempts from this network. Try again in 10 minutes.",
  bad_request: "The request was not complete. Reload the page and try again.",
  internal: "Something failed on our side. Try again in a minute.",
};

export const claimError = (code: string | undefined, status: number) =>
  CLAIM_ERRORS[code ?? ""] ?? `The request failed (HTTP ${status}). Try again.`;
