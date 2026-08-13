const state = {
  cwd: ".",
  parent: null,
  selected: new Set()
};

const elements = {
  downloadForm: document.querySelector("#downloadForm"),
  transferForm: document.querySelector("#transferForm"),
  refreshFiles: document.querySelector("#refreshFiles"),
  goUp: document.querySelector("#goUp"),
  deleteSelected: document.querySelector("#deleteSelected"),
  selectAll: document.querySelector("#selectAll"),
  fileRows: document.querySelector("#fileRows"),
  currentPath: document.querySelector("#currentPath"),
  toast: document.querySelector("#toast"),
  downloadJob: document.querySelector("#downloadJob"),
  downloadStatus: document.querySelector("#downloadStatus"),
  downloadPercent: document.querySelector("#downloadPercent"),
  downloadProgress: document.querySelector("#downloadProgress"),
  downloadMessage: document.querySelector("#downloadMessage"),
  transferJob: document.querySelector("#transferJob"),
  transferStatus: document.querySelector("#transferStatus"),
  transferPercent: document.querySelector("#transferPercent"),
  transferProgress: document.querySelector("#transferProgress"),
  transferMessage: document.querySelector("#transferMessage")
};

elements.downloadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(elements.downloadForm);
  await startDownload({
    url: form.get("url"),
    archivePassword: form.get("archivePassword")
  });
});

elements.transferForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const paths = [...state.selected];
  if (!paths.length) {
    showToast("Selecciona al menos un archivo o carpeta.");
    return;
  }
  const form = new FormData(elements.transferForm);
  await startTransfer({
    paths,
    route: form.get("route"),
    username: form.get("username"),
    password: form.get("password"),
    domain: form.get("domain")
  });
});

elements.refreshFiles.addEventListener("click", () => loadFiles(state.cwd));
elements.goUp.addEventListener("click", () => {
  if (state.parent) loadFiles(state.parent);
});
elements.deleteSelected.addEventListener("click", deleteSelected);
elements.selectAll.addEventListener("change", () => {
  const checked = elements.selectAll.checked;
  document.querySelectorAll("[data-select-path]").forEach((checkbox) => {
    checkbox.checked = checked;
    if (checked) state.selected.add(checkbox.dataset.selectPath);
    else state.selected.delete(checkbox.dataset.selectPath);
  });
});

async function startDownload(payload) {
  setBusy(elements.downloadForm, true);
  try {
    const job = await api("/api/download", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    watchJob(job.id, "download");
  } catch (error) {
    showToast(error.message);
  } finally {
    setBusy(elements.downloadForm, false);
  }
}

async function startTransfer(payload) {
  setBusy(elements.transferForm, true);
  try {
    const job = await api("/api/transfer", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    watchJob(job.id, "transfer");
  } catch (error) {
    showToast(error.message);
  } finally {
    setBusy(elements.transferForm, false);
  }
}

function watchJob(id, kind) {
  const source = new EventSource(`/api/jobs/${id}/events`);
  source.addEventListener("message", async (event) => {
    const job = JSON.parse(event.data);
    renderJob(kind, job);
    if (job.status === "done" || job.status === "error") {
      source.close();
      if (job.status === "done") {
        showToast(job.message);
        await loadFiles(state.cwd);
      } else {
        showToast(job.error || job.message);
      }
    }
  });
  source.addEventListener("error", () => {
    source.close();
    showToast("Se perdio la conexion del estado del trabajo.");
  });
}

function renderJob(kind, job) {
  const prefix = kind === "download" ? "download" : "transfer";
  elements[`${prefix}Job`].hidden = false;
  elements[`${prefix}Status`].textContent = statusLabel(job.status);
  elements[`${prefix}Percent`].textContent = `${Math.round(job.percent || 0)}%`;
  elements[`${prefix}Progress`].value = job.percent || 0;
  elements[`${prefix}Message`].textContent = job.error || job.message || "";
}

async function loadFiles(path = ".") {
  try {
    const data = await api(`/api/files?path=${encodeURIComponent(path)}`);
    state.cwd = data.cwd;
    state.parent = data.parent;
    state.selected.clear();
    elements.currentPath.textContent = data.cwd === "." ? "/" : `/${data.cwd}`;
    elements.goUp.disabled = !data.parent;
    elements.selectAll.checked = false;
    renderFiles(data.items);
  } catch (error) {
    showToast(error.message);
  }
}

function renderFiles(items) {
  if (!items.length) {
    elements.fileRows.innerHTML = '<tr><td colspan="6" class="empty-state">No hay archivos en esta carpeta.</td></tr>';
    return;
  }
  elements.fileRows.innerHTML = "";
  for (const item of items) {
    const row = document.createElement("tr");
    const checkCell = document.createElement("td");
    const nameCell = document.createElement("td");
    const typeCell = document.createElement("td");
    const sizeCell = document.createElement("td");
    const dateCell = document.createElement("td");
    const actionCell = document.createElement("td");

    checkCell.className = "check-cell";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.dataset.selectPath = item.path;
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selected.add(item.path);
      else state.selected.delete(item.path);
      syncSelectAll();
    });
    checkCell.append(checkbox);

    const nameButton = document.createElement("button");
    nameButton.type = "button";
    nameButton.className = "file-name";
    nameButton.dataset.type = item.type;
    nameButton.innerHTML = `<span aria-hidden="true">${item.type === "directory" ? "▣" : "□"}</span><span></span>`;
    nameButton.querySelector("span:last-child").textContent = item.name;
    if (item.type === "directory") {
      nameButton.addEventListener("click", () => loadFiles(item.path));
    } else {
      nameButton.addEventListener("click", () => window.open(`/api/downloads/${encodeURIComponentPath(item.path)}`, "_blank"));
    }
    nameCell.append(nameButton);

    typeCell.textContent = item.type === "directory" ? "Carpeta" : "Archivo";
    sizeCell.textContent = item.type === "directory" ? "-" : formatBytes(item.size);
    dateCell.textContent = new Date(item.modifiedAt).toLocaleString();
    const renameButton = document.createElement("button");
    renameButton.type = "button";
    renameButton.className = "compact-button";
    renameButton.textContent = "Renombrar";
    renameButton.addEventListener("click", () => renameItem(item));
    actionCell.append(renameButton);

    row.append(checkCell, nameCell, typeCell, sizeCell, dateCell, actionCell);
    elements.fileRows.append(row);
  }
}

async function renameItem(item) {
  const newName = prompt("Nuevo nombre:", item.name);
  if (newName === null) return;
  const cleanName = newName.trim();
  if (!cleanName || cleanName === item.name) return;
  try {
    await api("/api/files/rename", {
      method: "PATCH",
      body: JSON.stringify({ path: item.path, newName: cleanName })
    });
    showToast("Nombre actualizado.");
    await loadFiles(state.cwd);
  } catch (error) {
    showToast(error.message);
  }
}

async function deleteSelected() {
  const paths = [...state.selected];
  if (!paths.length) {
    showToast("Selecciona lo que quieres borrar.");
    return;
  }
  const names = paths.length === 1 ? paths[0] : `${paths.length} elementos`;
  if (!confirm(`Borrar ${names}?`)) return;
  try {
    await api("/api/files", {
      method: "DELETE",
      body: JSON.stringify({ paths })
    });
    showToast("Seleccion borrada.");
    await loadFiles(state.cwd);
  } catch (error) {
    showToast(error.message);
  }
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

function setBusy(form, busy) {
  form.querySelectorAll("button, input").forEach((element) => {
    element.disabled = busy;
  });
}

function syncSelectAll() {
  const checkboxes = [...document.querySelectorAll("[data-select-path]")];
  elements.selectAll.checked = checkboxes.length > 0 && checkboxes.every((checkbox) => checkbox.checked);
}

function statusLabel(status) {
  return {
    queued: "En cola",
    running: "En proceso",
    done: "Completado",
    error: "Error"
  }[status] || status;
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function encodeURIComponentPath(value) {
  return String(value).split("/").map(encodeURIComponent).join("/");
}

let toastTimer;
function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    elements.toast.hidden = true;
  }, 5200);
}

loadFiles();
