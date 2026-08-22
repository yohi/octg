import { AdminApiError, requestJson } from "./api.js";

function element(tagName, className, text) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function selectControl(name, value, options) {
  const select = element("select");
  select.name = name;
  options.forEach((optionValue) => {
    const option = element("option", null, optionValue);
    option.value = optionValue;
    option.selected = optionValue === value;
    select.append(option);
  });
  return select;
}

function field(labelText, control) {
  const label = element("label", "edit-field");
  label.append(element("span", "field-label", labelText), control);
  return label;
}

function errorMessage(error) {
  if (error instanceof AdminApiError && (error.status === 401 || error.status === 403)) {
    return "Access authentication may need renewal.";
  }
  if (error instanceof AdminApiError && error.status >= 400 && error.status < 500) {
    return error.message;
  }
  return "Save failed. Check the values and try again.";
}

function createEditorRow(colSpan, title, formBuilder, onCancel) {
  const row = element("tr", "edit-row");
  const cell = element("td");
  cell.colSpan = colSpan;
  const form = element("form", "edit-form");
  form.noValidate = true;
  form.setAttribute("aria-label", title);
  const fields = element("div", "edit-fields");
  const feedback = element("p", "edit-feedback");
  feedback.setAttribute("role", "alert");
  feedback.hidden = true;
  const actions = element("div", "edit-actions");
  const save = element("button", "compact-button", "Save changes");
  save.type = "submit";
  const cancel = element("button", "outline compact-button", "Cancel");
  cancel.type = "button";
  cancel.addEventListener("click", () => onCancel(row));
  actions.append(save, cancel);
  form.append(fields, feedback, actions);
  formBuilder({ fields, feedback, save, cancel, form });
  cell.append(form);
  row.append(cell);
  return row;
}

function showFeedback(feedback, message) {
  feedback.hidden = false;
  feedback.textContent = message;
}

function clearFeedback(feedback) {
  feedback.hidden = true;
  feedback.textContent = "";
}

export function beginClientEdit(client, onSaved, onCancel = () => {}) {
  return createEditorRow(8, `Edit client ${client.id}`, ({ fields, feedback, save, cancel, form }) => {
    const overflowMode = selectControl("overflow_mode", client.overflow_mode, ["REJECT", "PAID_SHARED"]);
    const outputLimitMode = selectControl("output_limit_mode", client.output_limit_mode, ["REJECT", "CLAMP"]);
    const maxPaidUsdDay = element("input");
    maxPaidUsdDay.type = "number";
    maxPaidUsdDay.name = "max_paid_usd_day";
    maxPaidUsdDay.min = "0";
    maxPaidUsdDay.step = "any";
    maxPaidUsdDay.value = String(client.max_paid_usd_day);
    const cacheEnabled = element("input");
    cacheEnabled.type = "checkbox";
    cacheEnabled.name = "cache_enabled";
    cacheEnabled.checked = Boolean(client.cache_enabled);
    const toolsMode = selectControl("tools_mode", client.tools_mode, ["REJECT", "ALLOW"]);
    fields.append(
      field("Overflow mode", overflowMode),
      field("Output limit", outputLimitMode),
      field("Paid USD / day", maxPaidUsdDay),
      field("Cache", cacheEnabled),
      field("Tools", toolsMode),
    );
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      clearFeedback(feedback);
      const payload = {
        overflow_mode: overflowMode.value,
        output_limit_mode: outputLimitMode.value,
        max_paid_usd_day: Number(maxPaidUsdDay.value),
        cache_enabled: cacheEnabled.checked,
        tools_mode: toolsMode.value,
      };
      if (!Number.isFinite(payload.max_paid_usd_day) || payload.max_paid_usd_day < 0) {
        showFeedback(feedback, "Paid USD / day must be a finite number of 0 or more.");
        maxPaidUsdDay.focus();
        return;
      }
      save.disabled = true;
      cancel.disabled = true;
      try {
        await requestJson(`/admin/clients/${encodeURIComponent(client.id)}/policy`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        await onSaved();
      } catch (error) {
        showFeedback(feedback, errorMessage(error));
        save.disabled = false;
        cancel.disabled = false;
      }
    });
  }, onCancel);
}

export function beginModelEdit(model, onSaved, onCancel = () => {}) {
  return createEditorRow(6, `Edit model ${model.model}`, ({ fields, feedback, save, cancel, form }) => {
    const complimentaryPool = selectControl("complimentary_pool", model.complimentary_pool, ["STANDARD", "MINI", "NONE"]);
    const enabled = element("input");
    enabled.type = "checkbox";
    enabled.name = "enabled";
    enabled.checked = Boolean(model.enabled);
    const fallbackModel = element("input");
    fallbackModel.type = "text";
    fallbackModel.name = "fallback_model";
    fallbackModel.value = model.fallback_model === null ? "" : String(model.fallback_model);
    fields.append(
      field("Complimentary pool", complimentaryPool),
      field("Enabled", enabled),
      field("Fallback model", fallbackModel),
    );
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      clearFeedback(feedback);
      const payload = {
        complimentary_pool: complimentaryPool.value,
        enabled: enabled.checked,
        fallback_model: fallbackModel.value.trim() || null,
      };
      save.disabled = true;
      cancel.disabled = true;
      try {
        await requestJson(`/admin/models/${encodeURIComponent(model.model)}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        await onSaved();
      } catch (error) {
        showFeedback(feedback, errorMessage(error));
        save.disabled = false;
        cancel.disabled = false;
      }
    });
  }, onCancel);
}
