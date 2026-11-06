/** Fixed error code + HTTP status; the only error type tool handlers throw on purpose. */
export class ToolError extends Error {
  constructor(public code: string, public status: number, public retryAfterSec?: number) {
    super(code);
    this.name = 'ToolError';
  }
}
