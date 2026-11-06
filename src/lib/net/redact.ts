/**
 * Error redaction for anything that can reach a published / hashed evidence bundle.
 * Exception messages (viem in particular) embed request URLs, and BASE_RPC_URL may carry an API key, so adapters
 * must never copy `e.message` into a note or `error` field. Use safeErrorCode instead.
 */

const FIXED = /^(timeout|invalid_json|blocked_url|error|http_\d{3}|rpc_error_-?\d{1,6})$/;

type Errish = { name?: unknown; code?: unknown; status?: unknown; statusCode?: unknown; message?: unknown; cause?: unknown };

/** Short fixed code derived from name/code/status; never echoes the message (only a message that already IS a fixed code passes through). */
export function safeErrorCode(e: unknown): string {
  let cur: unknown = e;
  for (let depth = 0; depth < 4 && cur && typeof cur === 'object'; depth++) {
    const x = cur as Errish;
    const name = typeof x.name === 'string' ? x.name : '';
    if (name === 'BlockedUrl') return 'blocked_url';
    if (/timeout|abort/i.test(name)) return 'timeout';
    if (typeof x.code === 'string' && /^(ETIMEDOUT|ESOCKETTIMEDOUT|UND_ERR_(CONNECT_|HEADERS_|BODY_)?TIMEOUT|ABORT_ERR)$/i.test(x.code)) return 'timeout';
    const status = typeof x.status === 'number' ? x.status : typeof x.statusCode === 'number' ? x.statusCode : null;
    if (status !== null && Number.isInteger(status) && status >= 100 && status <= 599) return `http_${status}`;
    if (typeof x.code === 'number' && Number.isInteger(x.code) && Math.abs(x.code) < 1_000_000) return `rpc_error_${x.code}`;
    if (typeof x.message === 'string' && FIXED.test(x.message)) return x.message;
    cur = x.cause;
  }
  return 'error';
}

/** Belt and braces for free text that must pass through: URLs become <url>, key-like query params are stripped. */
export function redactUrls(s: string): string {
  return s
    .replace(/https?:\/\/[^\s"'<>)]+/gi, '<url>')
    .replace(/([?&;])(?:api[_-]?key|key|token|access[_-]?token|auth|secret)=[^&\s"'<>]*/gi, '$1')
    .replace(/\b(?:api[_-]?key|key|token|access[_-]?token|secret)=[^&\s"'<>]*/gi, '');
}
