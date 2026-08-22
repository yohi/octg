export class AdminContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "AdminContractError";
  }
}

const numberFormatter = new Intl.NumberFormat("en-US");

function element(tagName, className, text) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text instanceof Node) node.append(text);
  else if (text !== undefined) node.textContent = text;
  return node;
}

function record(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AdminContractError(`The Admin API returned an invalid ${label}.`);
  }
  return value;
}

function array(value, label) {
  if (!Array.isArray(value)) {
    throw new AdminContractError(`The Admin API returned an invalid ${label}.`);
  }
  return value;
}

function string(value, label) {
  if (typeof value !== "string") {
    throw new AdminContractError(`The Admin API returned an invalid ${label}.`);
  }
  return value;
}

function number(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AdminContractError(`The Admin API returned an invalid ${label}.`);
  }
  return value;
}

function envelopeMeta(payload) {
  const requestId = string(payload.request_id, "request ID");
  const utcDay = string(payload.utc_day, "UTC day");
  const meta = element("p", "section-meta");
  meta.append(
    element("span", "meta-label", "UTC"),
    document.createTextNode(` ${utcDay} `),
    element("span", "meta-separator", "·"),
    document.createTextNode(" "),
    element("span", "meta-label", "Request"),
    document.createTextNode(` ${requestId}`),
  );
  return meta;
}

function formattedNumber(value) {
  return numberFormatter.format(number(value, "numeric value"));
}

function formattedDate(value, label) {
  const timestamp = string(value, label);
  const time = element("time", "timestamp", timestamp);
  time.dateTime = timestamp;
  return time;
}

function stat(label, value) {
  const item = element("div", "stat-item");
  item.append(element("dt", "stat-label", label), element("dd", "stat-value", value));
  return item;
}

function table(headers, rows, className = "data-table") {
  const wrapper = element("div", "table-wrap");
  const tableNode = element("table", className);
  const head = element("thead");
  const headRow = element("tr");
  headers.forEach((header) => headRow.append(element("th", null, header)));
  head.append(headRow);
  const body = element("tbody");
  rows.forEach((row) => {
    const rowNode = element("tr");
    row.forEach((cell) => {
      const cellNode = element("td");
      if (cell instanceof Node) cellNode.append(cell);
      else cellNode.textContent = String(cell);
      rowNode.append(cellNode);
    });
    body.append(rowNode);
  });
  tableNode.append(head, body);
  wrapper.append(tableNode);
  return wrapper;
}

function clear(container) {
  container.replaceChildren();
}

function statusLabel(value) {
  return value ? "Enabled" : "Disabled";
}

function pill(value, tone = "neutral") {
  return element("span", `pill pill-${tone}`, value);
}

export function renderLoading(container, message = "Loading…") {
  clear(container);
  container.append(element("p", "loading-state", message));
}

export function renderError(container, message, onRetry) {
  clear(container);
  const wrapper = element("div", "error-state");
  wrapper.append(element("strong", null, "Could not load this section."), element("p", null, message));
  if (typeof onRetry === "function") {
    const retry = element("button", "outline", "Try again");
    retry.type = "button";
    retry.addEventListener("click", onRetry);
    wrapper.append(retry);
  }
  container.append(wrapper);
}

export function renderQuota(container, payload) {
  const pools = record(payload.pools, "quota pools");
  const poolCards = ["standard", "mini"].map((key) => {
    const pool = record(pools[key], `${key} quota pool`);
    const title = typeof pool.pool === "string" ? pool.pool : key.toUpperCase();
    const card = element("article", `quota-card quota-${key}`);
    const heading = element("div", "quota-card-heading");
    heading.append(element("span", "pool-index", key === "standard" ? "S" : "M"), element("h3", null, title));
    const stats = element("dl", "stats-grid");
    stats.append(
      stat("Limit", formattedNumber(pool.limit)),
      stat("Used", formattedNumber(pool.used)),
      stat("Remaining", formattedNumber(pool.remaining)),
    );
    const reset = element("p", "quota-reset");
    reset.append(element("span", "meta-label", "Reset at"), document.createTextNode(" "), formattedDate(pool.resetAt, `${title} reset time`));
    card.append(heading, stats, reset);
    return card;
  });
  clear(container);
  const quotaGrid = element("div", "quota-grid");
  quotaGrid.append(...poolCards);
  container.append(envelopeMeta(payload), quotaGrid);
}

export function renderUsage(container, payload) {
  const clients = array(payload.clients, "usage clients").slice().sort((left, right) => String(left.client_id).localeCompare(String(right.client_id)));
  clear(container);
  container.append(envelopeMeta(payload));
  if (clients.length === 0) {
    container.append(element("p", "empty-state", "No usage recorded."));
    return;
  }
  const rows = clients.map((client) => [
    string(client.client_id, "usage client ID"),
    formattedNumber(client.requests),
    formattedNumber(client.tokens),
  ]);
  container.append(table(["Client ID", "Requests", "Tokens"], rows));
}

function clientRow(client, actions) {
  const row = element("tr");
  const nameCell = element("td");
  nameCell.append(element("strong", null, string(client.name, "client name")), element("small", "muted-line", string(client.id, "client ID")));
  const actionCell = element("td", "action-cell");
  if (typeof actions.onEdit === "function") {
    const edit = element("button", "outline compact-button", "Edit");
    edit.type = "button";
    edit.addEventListener("click", () => actions.onEdit(client, row, (currentRow) => currentRow.replaceWith(clientRow(client, actions))));
    actionCell.append(edit);
  } else {
    actionCell.append(element("span", "muted-line", "Read only"));
  }
  row.append(
    nameCell,
    element("td", null, statusLabel(Boolean(client.enabled))),
    element("td", null, string(client.overflow_mode, "overflow mode")),
    element("td", null, string(client.output_limit_mode, "output limit mode")),
    element("td", null, formattedNumber(client.max_paid_usd_day)),
    element("td", null, client.cache_enabled ? pill("On", "positive") : pill("Off")),
    element("td", null, string(client.tools_mode, "tools mode")),
    actionCell,
  );
  return row;
}

export function renderClients(container, payload, actions = {}) {
  const clients = array(payload.clients, "clients");
  clear(container);
  container.append(envelopeMeta(payload));
  if (clients.length === 0) {
    container.append(element("p", "empty-state", "No clients configured."));
    return;
  }
  const tableNode = element("table", "data-table clients-table");
  const head = element("thead");
  const headRow = element("tr");
  ["Client", "Status", "Overflow", "Output", "Paid USD / day", "Cache", "Tools", "Action"].forEach((header) => headRow.append(element("th", null, header)));
  head.append(headRow);
  const body = element("tbody");
  clients.forEach((client) => body.append(clientRow(client, actions)));
  tableNode.append(head, body);
  const wrapper = element("div", "table-wrap");
  wrapper.append(tableNode);
  container.append(wrapper);
}

function modelRow(model, actions) {
  const row = element("tr");
  const modelCell = element("td");
  modelCell.append(element("strong", null, string(model.model, "model name")), element("small", "muted-line", string(model.updated_at, "model update time")));
  const actionCell = element("td", "action-cell");
  if (typeof actions.onEdit === "function") {
    const edit = element("button", "outline compact-button", "Edit");
    edit.type = "button";
    edit.addEventListener("click", () => actions.onEdit(model, row, (currentRow) => currentRow.replaceWith(modelRow(model, actions))));
    actionCell.append(edit);
  } else {
    actionCell.append(element("span", "muted-line", "Read only"));
  }
  row.append(
    modelCell,
    element("td", null, string(model.provider, "model provider")),
    element("td", null, string(model.complimentary_pool, "model pool")),
    element("td", null, statusLabel(Boolean(model.enabled))),
    element("td", null, model.fallback_model === null ? pill("None", "neutral") : string(model.fallback_model, "fallback model")),
    actionCell,
  );
  return row;
}

export function renderModels(container, payload, actions = {}) {
  const models = array(payload.models, "models");
  clear(container);
  container.append(envelopeMeta(payload));
  if (models.length === 0) {
    container.append(element("p", "empty-state", "No models configured."));
    return;
  }
  const tableNode = element("table", "data-table models-table");
  const head = element("thead");
  const headRow = element("tr");
  ["Model", "Provider", "Pool", "Status", "Fallback", "Action"].forEach((header) => headRow.append(element("th", null, header)));
  head.append(headRow);
  const body = element("tbody");
  models.forEach((model) => body.append(modelRow(model, actions)));
  tableNode.append(head, body);
  const wrapper = element("div", "table-wrap");
  wrapper.append(tableNode);
  container.append(wrapper);
}
