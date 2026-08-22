const SECTION_PATHS = Object.freeze({
  quota: "/admin/quota",
  usage: "/admin/usage",
  clients: "/admin/clients",
  models: "/admin/models",
});

export class AdminApiError extends Error {
  constructor(status, message, requestId) {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
    this.requestId = requestId;
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestIdFrom(body) {
  return isRecord(body) && typeof body.request_id === "string" ? body.request_id : null;
}

function errorMessageFrom(body, status) {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.message === "string") {
    return body.error.message;
  }
  return `Request failed (${status}).`;
}

function messageForFailure(status, body) {
  if (status === 401 || status === 403) {
    return "Access authentication may need renewal.";
  }
  return errorMessageFrom(body, status);
}

export async function requestJson(path, options = {}) {
  if (typeof path !== "string" || !path.startsWith("/admin/")) {
    throw new TypeError("Admin API paths must be absolute /admin/ paths.");
  }

  const { headers: optionHeaders, ...fetchOptions } = options;
  const headers = new Headers(optionHeaders);
  if (!headers.has("accept")) headers.set("accept", "application/json");

  let response;
  try {
    response = await fetch(path, {
      ...fetchOptions,
      credentials: "same-origin",
      headers,
    });
  } catch {
    throw new AdminApiError(0, "The Admin API could not be reached.", null);
  }

  const body = await response.json().catch(() => undefined);
  const requestId = requestIdFrom(body);
  if (!response.ok) {
    throw new AdminApiError(response.status, messageForFailure(response.status, body), requestId);
  }
  if (!isRecord(body)) {
    throw new AdminApiError(response.status, "The Admin API returned an invalid response.", requestId);
  }
  return body;
}

export async function loadDashboard() {
  const entries = Object.entries(SECTION_PATHS);
  const results = await Promise.all(entries.map(async ([section, path]) => {
    try {
      return [section, { status: "fulfilled", value: await requestJson(path) }];
    } catch (reason) {
      return [section, { status: "rejected", reason }];
    }
  }));
  return Object.fromEntries(results);
}

export { SECTION_PATHS };
