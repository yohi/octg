const MAX_ERROR_MESSAGE_LENGTH = 512;
const REDACTED_VALUE = "[REDACTED]";
const TRUNCATION_SUFFIX = "…[TRUNCATED]";

const SENSITIVE_ASSIGNMENT = /\b((?:authorization|api[_\s-]?key|token|(?:access|refresh|id)[_\s-]?token|(?:client[_\s-]?)?secret|password|idempotency[_\s-]?key)\b"?)(\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|Bearer\s+[^\s,;&}\]]+|[^\s,;&}\]]+)/gi;
const COOKIE_ASSIGNMENT = /\b(cookie\b"?)(\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n,]*)/gi;
const REQUEST_BODY_ASSIGNMENT = /\b((?:request[_\s-]?body|body)\b"?)(\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[\s\S]*$)/i;

export interface SafeErrorDetails {
  readonly name: string;
  readonly message: string;
}

function truncate(message: string): string {
  if (message.length <= MAX_ERROR_MESSAGE_LENGTH) {
    return message;
  }

  return `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}`;
}

function redactMessage(message: string): string {
  return message
    .replace(REQUEST_BODY_ASSIGNMENT, `$1$2${REDACTED_VALUE}`)
    .replace(COOKIE_ASSIGNMENT, `$1$2${REDACTED_VALUE}`)
    .replace(SENSITIVE_ASSIGNMENT, `$1$2${REDACTED_VALUE}`);
}

export function safeErrorDetails(error: unknown): SafeErrorDetails {
  if (!(error instanceof Error)) {
    return { name: "UnknownError", message: "Non-Error value thrown" };
  }

  return {
    name: truncate(redactMessage(error.name)),
    message: truncate(redactMessage(error.message)),
  };
}
