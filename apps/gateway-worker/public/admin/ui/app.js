import { AdminApiError, loadDashboard, requestJson, SECTION_PATHS } from "./api.js";
import { beginClientEdit, beginModelEdit } from "./editors.js";
import {
  renderClients,
  renderError,
  renderLoading,
  renderModels,
  renderQuota,
  renderUsage,
} from "./render.js";

const SECTION_CONFIG = Object.freeze({
  quota: { path: SECTION_PATHS.quota, render: renderQuota, label: "quota" },
  usage: { path: SECTION_PATHS.usage, render: renderUsage, label: "usage" },
  clients: { path: SECTION_PATHS.clients, render: renderClients, label: "clients" },
  models: { path: SECTION_PATHS.models, render: renderModels, label: "models" },
});

function contentFor(section) {
  return document.querySelector(`[data-section-content="${section}"]`);
}

function setNotification(message, tone = "quiet") {
  const notification = document.querySelector("#notification");
  if (!notification) return;
  notification.className = `notification notification-${tone}`;
  notification.textContent = message;
}

function updateLastUpdated() {
  const timestamp = new Date();
  const target = document.querySelector("#last-updated");
  if (!target) return;
  target.dateTime = timestamp.toISOString();
  target.textContent = timestamp.toISOString().replace("T", " ").replace(".000Z", " UTC");
}

function displayError(error) {
  if (error instanceof AdminApiError && (error.status === 401 || error.status === 403)) {
    return "Access authentication may need renewal.";
  }
  if (error instanceof Error && error.name === "AdminContractError") {
    return error.message;
  }
  if (error instanceof AdminApiError && error.status >= 400 && error.status < 500) {
    return error.message;
  }
  return "The request could not be completed. Try again.";
}

function editorActions(section) {
  if (section === "clients") {
    return {
      onEdit(client, row, restore) {
        row.replaceWith(beginClientEdit(client, async () => {
          await refreshSection(section, { showLoading: false });
        }, restore));
      },
    };
  }
  if (section === "models") {
    return {
      onEdit(model, row, restore) {
        row.replaceWith(beginModelEdit(model, async () => {
          await refreshSection(section, { showLoading: false });
        }, restore));
      },
    };
  }
  return undefined;
}

function renderSection(section, payload) {
  const config = SECTION_CONFIG[section];
  const content = contentFor(section);
  if (!config || !content) return;
  config.render(content, payload, editorActions(section));
  updateLastUpdated();
}

async function refreshSection(section, { showLoading = true } = {}) {
  const content = contentFor(section);
  if (!content || !SECTION_CONFIG[section]) return false;
  if (showLoading) renderLoading(content, `Loading ${SECTION_CONFIG[section].label}…`);
  try {
    renderSection(section, await requestJson(SECTION_CONFIG[section].path));
    setNotification(`${SECTION_CONFIG[section].label} is current.`, "success");
    return true;
  } catch (error) {
    renderError(content, displayError(error), () => {
      void refreshSection(section);
    });
    if (error instanceof AdminApiError && (error.status === 401 || error.status === 403)) {
      setNotification("Access authentication may need renewal before the dashboard can refresh.", "warning");
    } else {
      setNotification("One or more sections need attention.", "warning");
    }
    return false;
  }
}

async function bootstrap() {
  setNotification("Fetching current admin data.");
  const results = await loadDashboard();
  let successful = 0;
  Object.keys(SECTION_CONFIG).forEach((section) => {
    const result = results[section];
    const content = contentFor(section);
    if (!content || !result) return;
    if (result.status === "fulfilled") {
      try {
        renderSection(section, result.value);
        successful += 1;
      } catch (error) {
        renderError(content, displayError(error), () => {
          void refreshSection(section);
        });
      }
    } else {
      renderError(content, displayError(result.reason), () => {
        void refreshSection(section);
      });
    }
  });
  if (successful === Object.keys(SECTION_CONFIG).length) {
    setNotification("All sections are current.", "success");
  } else {
    setNotification("One or more sections need attention.", "warning");
  }
}

function wireRefreshButtons() {
  document.querySelectorAll("[data-refresh-section]").forEach((button) => {
    button.addEventListener("click", () => {
      void refreshSection(button.dataset.refreshSection);
    });
  });
}

function start() {
  wireRefreshButtons();
  void bootstrap();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}
