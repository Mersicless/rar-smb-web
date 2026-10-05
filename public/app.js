import { icon, fileKind } from "./icons.js";

const state = {
  cwd: ".",
  parent: null,
  selected: new Set(),
  itemsByPath: new Map(),
};

const elements = {
  downloadForm: document.querySelector("#downloadForm"),
  transferForm: document.querySelector("#transferForm"),
  refreshFiles: document.querySelector("#refreshFiles"),
  goUp: document.querySelector("#goUp"),
  deleteSelected: document.querySelector("#deleteSelected"),
  newFolder: document.querySelector("#newFolder"),
  moveSelected: document.querySelector("#moveSelected"),
  moveDialog: document.querySelector("#moveDialog"),
  moveTitle: document.querySelector("#moveTitle"),
  moveCrumbs: document.querySelector("#moveCrumbs"),
  moveFolders: document.querySelector("#moveFolders"),
  moveConfirm: document.querySelector("#moveConfirm"),
  selectAll: document.querySelector("#selectAll"),
  fileRows: document.querySelector("#fileRows"),
  breadcrumbs: document.querySelector("#breadcrumbs"),
  selectionCount: document.querySelector("#selectionCount"),
  themeToggle: document.querySelector("#themeToggle"),
  toast: document.querySelector("#toast"),
  downloadJobs: document.querySelector("#downloadJobs"),
  deleteDialog: document.querySelector("#deleteDialog"),
  deleteTitle: document.querySelector("#deleteTitle"),
  deleteList: document.querySelector("#deleteList"),
  deleteConfirm: document.querySelector("#deleteConfirm"),
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
    archivePassword: form.get("archivePassword"),
    deleteArchiveAfterExtract: form.get("deleteArchiveAfterExtract") === "1"
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
    domain: form.get("domain"),
    deleteLocalAfterTransfer: form.get("deleteLocalAfterTransfer") === "1"
  });
});

// Decisión del Rey: nada se borra solo; cada formulario tiene su botón "Limpiar campos".
document.querySelectorAll("[data-clear-form]").forEach((button) => {
  button.addEventListener("click", () => {
    const form = document.getElementById(button.dataset.clearForm);
    form?.reset();
    form?.querySelector("input")?.focus();
  });
});

hydrateIcons();
renderThemeToggle();
elements.themeToggle.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("theme", next);
  renderThemeToggle();
});

elements.refreshFiles.addEventListener("click", () => loadFiles(state.cwd));
elements.goUp.addEventListener("click", () => {
  if (state.parent) loadFiles(state.parent);
});
elements.deleteSelected.addEventListener("click", deleteSelected);
elements.deleteConfirm.addEventListener("click", confirmDelete);
elements.newFolder.addEventListener("click", startNewFolder);
elements.moveSelected.addEventListener("click", openMoveDialog);
elements.moveConfirm.addEventListener("click", confirmMove);
elements.selectAll.addEventListener("change", () => {
  const checked = elements.selectAll.checked;
  document.querySelectorAll("[data-select-path]").forEach((checkbox) => {
    checkbox.checked = checked;
    if (checked) state.selected.add(checkbox.dataset.selectPath);
    else state.selected.delete(checkbox.dataset.selectPath);
    checkbox.closest("tr")?.classList.toggle("is-selected", checked);
  });
  renderSelectionCount();
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

// Un solo canal SSE para todos los trabajos (/api/jobs/events). Antes había un
// EventSource por trabajo: con 6 vivos (3 descargando + 3 en cola) se agotaban las 6
// conexiones por servidor del navegador y nada más respondía, ni Cancelar.
const watched = new Map(); // id -> "download" | "transfer"
const finished = new Set(); // ya terminados aquí: un estado viejo que llegue tarde no los revive
let jobStream = null;

function kindOf(job) {
  return job.type === "download" ? "download" : "transfer";
}

function watchJob(id, kind) {
  watched.set(id, kind);
  ensureJobStream();
  // Un trabajo muy rápido puede terminar antes de que llegue la respuesta del POST:
  // su evento final se habría ignorado, así que se pide su estado una vez.
  api(`/api/jobs/${id}`).then(handleJobEvent).catch(() => {});
}

function ensureJobStream() {
  if (jobStream) return;
  jobStream = new EventSource("/api/jobs/events");
  jobStream.addEventListener("message", (event) => handleJobEvent(JSON.parse(event.data)));
  // Al (re)conectar: el servidor manda los activos; los vigilados que terminaron
  // mientras no había conexión se piden uno a uno para no dejar barras colgadas.
  jobStream.addEventListener("open", () => {
    for (const id of watched.keys()) {
      api(`/api/jobs/${id}`).then(handleJobEvent).catch(() => {
        watched.delete(id);
        removeDownloadCard(id);
      });
    }
  });
  // EventSource reintenta solo; solo se avisa si el navegador se rinde.
  jobStream.addEventListener("error", () => {
    if (jobStream.readyState === EventSource.CLOSED) {
      jobStream = null;
      showToast("Se perdió la conexión con el estado de los trabajos. Recarga la página.");
    }
  });
}

async function handleJobEvent(job) {
  const terminal = job.status === "done" || job.status === "error" || job.status === "cancelled";
  if (finished.has(job.id)) return;
  if (!watched.has(job.id)) {
    // Un trabajo terminado que esta pestaña no seguía no se muestra; uno activo
    // (de otra pestaña o anterior a recargar) se empieza a seguir.
    if (terminal) return;
    watched.set(job.id, kindOf(job));
  }
  const kind = watched.get(job.id);
  renderJob(kind, job);
  if (!terminal) return;
  watched.delete(job.id);
  finished.add(job.id);
  if (kind === "download") {
    // Los terminados se quitan de la UI tras un momento.
    setTimeout(() => removeDownloadCard(job.id), job.status === "cancelled" ? 1500 : 4000);
  }
  if (job.status === "done") {
    showToast(job.message);
    await loadFiles(state.cwd);
  } else if (job.status === "error") {
    showToast(job.error || job.message);
  } else if (job.status === "cancelled") {
    showToast(job.message || "Descarga cancelada");
  }
}

function formatSpeed(bps) {
  if (!bps || bps <= 0) return "";
  return `${formatBytes(bps)}/s`;
}

function formatEta(seconds) {
  if (seconds == null || seconds < 0 || !Number.isFinite(seconds)) return "";
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return `${mins}m ${secs}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

function ensureDownloadCard(job) {
  let card = elements.downloadJobs.querySelector(`[data-job-id="${job.id}"]`);
  if (card) return card;
  card = document.createElement("div");
  card.className = "job-card download-job-card";
  card.dataset.jobId = job.id;
  card.innerHTML = `
    <div class="job-line">
      <strong class="job-filename"></strong>
      <span class="job-percent">0%</span>
    </div>
    <div class="job-line job-meta">
      <span class="job-status"></span>
      <span class="job-stats"></span>
    </div>
    <progress class="job-progress" max="100" value="0"></progress>
    <div class="job-line job-footer">
      <p class="job-message"></p>
      <button type="button" class="ghost-button job-cancel" hidden>Cancelar</button>
    </div>
  `;
  const cancelBtn = card.querySelector(".job-cancel");
  cancelBtn.addEventListener("click", async () => {
    cancelBtn.disabled = true;
    try {
      await api(`/api/jobs/${job.id}/cancel`, { method: "POST", body: "{}" });
    } catch (error) {
      showToast(error.message);
      cancelBtn.disabled = false;
    }
  });
  elements.downloadJobs.append(card);
  return card;
}

function removeDownloadCard(id) {
  elements.downloadJobs.querySelector(`[data-job-id="${id}"]`)?.remove();
}

function renderDownloadJob(job) {
  const card = ensureDownloadCard(job);
  const filename = job.filename || "Descarga";
  card.querySelector(".job-filename").textContent = filename;
  card.querySelector(".job-status").textContent = statusLabel(job.status);
  card.querySelector(".job-percent").textContent = `${Math.round(job.percent || 0)}%`;
  card.querySelector(".job-progress").value = job.percent || 0;
  card.querySelector(".job-message").textContent = job.error || job.message || "";
  const parts = [];
  // Velocidad y tiempo restante solo mientras descarga (no en cancelada/terminada).
  const downloading = job.status === "running" && job.cancellable !== false;
  if (downloading && job.speedBps > 0) parts.push(formatSpeed(job.speedBps));
  const eta = downloading ? formatEta(job.etaSeconds) : "";
  if (eta) parts.push(`resta ${eta}`);
  if (job.totalBytes > 0) parts.push(`${formatBytes(job.bytesDownloaded || 0)} / ${formatBytes(job.totalBytes)}`);
  card.querySelector(".job-stats").textContent = parts.join(" · ");
  const cancelBtn = card.querySelector(".job-cancel");
  // Durante la descompresión el servidor ya no deja cancelar (cancellable: false).
  const canCancel = (job.status === "queued" || job.status === "running") && job.cancellable !== false;
  cancelBtn.hidden = !canCancel;
  cancelBtn.disabled = !canCancel;
}

function renderTransferJob(job) {
  elements.transferJob.hidden = false;
  elements.transferStatus.textContent = statusLabel(job.status);
  elements.transferPercent.textContent = `${Math.round(job.percent || 0)}%`;
  elements.transferProgress.value = job.percent || 0;
  elements.transferMessage.textContent = job.error || job.message || "";
}

function renderJob(kind, job) {
  if (kind === "download" || job.type === "download") renderDownloadJob(job);
  else renderTransferJob(job);
}

async function reconnectActiveJobs() {
  // Al recargar, el canal compartido manda primero el estado de los trabajos activos
  // y handleJobEvent los vuelve a dibujar.
  ensureJobStream();
}

async function loadFiles(path = ".") {
  try {
    const data = await api(`/api/files?path=${encodeURIComponent(path)}`);
    state.cwd = data.cwd;
    state.parent = data.parent;
    state.selected.clear();
    state.itemsByPath = new Map(data.items.map((item) => [item.path, item]));
    renderBreadcrumbs(data.cwd);
    renderSelectionCount();
    elements.goUp.disabled = !data.parent;
    elements.selectAll.checked = false;
    renderFiles(data.items);
  } catch (error) {
    showToast(error.message);
  }
}

function renderFiles(items) {
  if (!items.length) {
    elements.fileRows.innerHTML = `<tr><td colspan="6" class="empty-state">${icon("empty")}No hay archivos en esta carpeta.</td></tr>`;
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
      row.classList.toggle("is-selected", checkbox.checked);
      syncSelectAll();
      renderSelectionCount();
    });
    checkCell.append(checkbox);

    const nameButton = document.createElement("button");
    nameButton.type = "button";
    nameButton.className = "file-name";
    nameButton.dataset.type = item.type;
    const kind = fileKind(item);
    nameButton.innerHTML = `<span class="file-icon kind-${kind.kind}">${icon(kind.kind)}</span><span></span>`;
    nameButton.title = item.name;
    nameButton.querySelector("span:last-child").textContent = item.name;
    if (item.type === "symlink") {
      // Los enlaces no se abren: podrían apuntar fuera de descargas.
      nameButton.disabled = true;
      nameButton.title = `${item.name} (enlace simbólico: no se abre por seguridad)`;
    } else if (item.type === "directory") {
      nameButton.addEventListener("click", () => loadFiles(item.path));
    } else {
      nameButton.addEventListener("click", () => window.open(`/api/downloads/${encodeURIComponentPath(item.path)}`, "_blank"));
    }
    nameCell.append(nameButton);

    const badge = document.createElement("span");
    badge.className = `type-badge kind-${kind.kind}`;
    badge.textContent = kind.label;
    typeCell.append(badge);
    sizeCell.className = "muted-cell";
    dateCell.className = "muted-cell";
    sizeCell.textContent = item.type === "directory" ? "—" : formatBytes(item.size);
    dateCell.textContent = formatDate(item.modifiedAt);
    const renameButton = document.createElement("button");
    renameButton.type = "button";
    renameButton.className = "compact-button";
    renameButton.innerHTML = `${icon("rename")}<span>Renombrar</span>`;
    renameButton.addEventListener("click", () => startRename(item, nameCell, nameButton));
    actionCell.append(renameButton);

    row.append(checkCell, nameCell, typeCell, sizeCell, dateCell, actionCell);
    elements.fileRows.append(row);
  }
}

function inlineEditor({ value, selectEnd, onSave, onCancel }) {
  const form = document.createElement("form");
  form.className = "inline-edit";
  const input = document.createElement("input");
  input.type = "text";
  input.value = value;
  input.spellcheck = false;
  input.setAttribute("aria-label", "Nombre");
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "icon-button primary-button";
  save.title = "Guardar";
  save.innerHTML = icon("check");
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "icon-button";
  cancel.title = "Cancelar";
  cancel.innerHTML = icon("close");
  form.append(input, save, cancel);
  let busy = false;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    const name = input.value.trim();
    if (!name) return input.focus();
    busy = true;
    try {
      await onSave(name);
    } catch (error) {
      showToast(error.message);
      busy = false;
      input.focus();
    }
  });
  cancel.addEventListener("click", onCancel);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") onCancel();
  });
  // Quien inserta el editor llama a focusInput() cuando ya está en la página.
  form.focusInput = () => {
    input.focus();
    input.setSelectionRange(0, selectEnd ?? value.length);
  };
  return form;
}

function baseNameLength(name, isFile) {
  if (!isFile) return name.length;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? dot : name.length;
}

function startRename(item, nameCell, nameButton) {
  const restore = () => nameCell.replaceChildren(nameButton);
  const editor = inlineEditor({
    value: item.name,
    selectEnd: baseNameLength(item.name, item.type === "file"),
    onCancel: restore,
    onSave: async (name) => {
      if (name === item.name) return restore();
      await api("/api/files/rename", {
        method: "PATCH",
        body: JSON.stringify({ path: item.path, newName: name })
      });
      showToast("Nombre actualizado.");
      await loadFiles(state.cwd);
    }
  });
  nameCell.replaceChildren(editor);
  editor.focusInput();
}

function startNewFolder() {
  if (elements.fileRows.querySelector(".new-folder-row")) return;
  const row = document.createElement("tr");
  row.className = "new-folder-row";
  const cell = document.createElement("td");
  cell.colSpan = 6;
  const label = document.createElement("span");
  label.className = "file-icon kind-folder";
  label.innerHTML = icon("folder-plus");
  const editor = inlineEditor({
    value: "Nueva carpeta",
    onCancel: () => row.remove(),
    onSave: async (name) => {
      await api("/api/files/folder", {
        method: "POST",
        body: JSON.stringify({ path: state.cwd, name })
      });
      showToast("Carpeta creada.");
      await loadFiles(state.cwd);
    }
  });
  cell.append(label, editor);
  row.append(cell);
  const empty = elements.fileRows.querySelector(".empty-state");
  if (empty) empty.parentElement.remove();
  elements.fileRows.prepend(row);
  editor.focusInput();
}

const moveState = { destination: "." };

function openMoveDialog() {
  const paths = [...state.selected];
  if (!paths.length) {
    showToast("Selecciona lo que quieres mover.");
    return;
  }
  elements.moveTitle.textContent = paths.length === 1
    ? `Mover «${paths[0].split("/").pop()}»`
    : `Mover ${paths.length} elementos`;
  elements.moveDialog.showModal();
  loadMoveFolders(state.cwd);
}

async function loadMoveFolders(path) {
  try {
    const data = await api(`/api/files?path=${encodeURIComponent(path)}`);
    moveState.destination = data.cwd;
    renderMoveCrumbs(data.cwd);
    const selected = state.selected;
    const folders = data.items.filter((item) => item.type === "directory");
    elements.moveFolders.innerHTML = "";
    if (!folders.length) {
      const li = document.createElement("li");
      li.className = "move-empty";
      li.textContent = "Sin subcarpetas.";
      elements.moveFolders.append(li);
    }
    for (const folder of folders) {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.innerHTML = `<span class="file-icon kind-folder">${icon("folder")}</span><span></span>`;
      button.querySelector("span:last-child").textContent = folder.name;
      // No se puede entrar en una carpeta que forma parte de lo que se mueve.
      if (selected.has(folder.path)) {
        button.disabled = true;
        button.title = "Es parte de lo que vas a mover";
      } else {
        button.addEventListener("click", () => loadMoveFolders(folder.path));
      }
      li.append(button);
      elements.moveFolders.append(li);
    }
    const sameFolder = data.cwd === state.cwd;
    elements.moveConfirm.disabled = sameFolder;
    elements.moveConfirm.title = sameFolder ? "Ya está en esta carpeta" : "";
  } catch (error) {
    showToast(error.message);
  }
}

function renderMoveCrumbs(cwd) {
  elements.moveCrumbs.innerHTML = "";
  const parts = cwd === "." ? [] : cwd.split("/");
  const crumbs = [{ name: "Descargas", path: "." }];
  parts.forEach((part, index) => crumbs.push({ name: part, path: parts.slice(0, index + 1).join("/") }));
  crumbs.forEach((crumb, index) => {
    if (index) {
      const sep = document.createElement("span");
      sep.className = "crumb-sep";
      sep.textContent = "/";
      elements.moveCrumbs.append(sep);
    }
    const button = document.createElement("button");
    button.type = "button";
    if (index === 0) button.innerHTML = icon("home");
    button.append(document.createTextNode(crumb.name));
    if (index === crumbs.length - 1) button.setAttribute("aria-current", "page");
    else button.addEventListener("click", () => loadMoveFolders(crumb.path));
    elements.moveCrumbs.append(button);
  });
}

async function confirmMove() {
  const paths = [...state.selected];
  elements.moveConfirm.disabled = true;
  try {
    const result = await api("/api/files/move", {
      method: "POST",
      body: JSON.stringify({ paths, destination: moveState.destination })
    });
    elements.moveDialog.close();
    showToast(`${result.moved} elemento${result.moved === 1 ? "" : "s"} movido${result.moved === 1 ? "" : "s"}.`);
    await loadFiles(state.cwd);
  } catch (error) {
    showToast(error.message);
    elements.moveConfirm.disabled = false;
  }
}

async function deleteSelected() {
  const paths = [...state.selected];
  if (!paths.length) {
    showToast("Selecciona lo que quieres borrar.");
    return;
  }
  elements.deleteTitle.textContent = paths.length === 1
    ? "Borrar 1 elemento"
    : `Borrar ${paths.length} elementos`;
  elements.deleteList.innerHTML = "";
  for (const path of paths) {
    const item = state.itemsByPath.get(path);
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "delete-name";
    name.textContent = item?.name || path.split("/").pop() || path;
    const size = document.createElement("span");
    size.className = "delete-size";
    if (!item) size.textContent = "—";
    else if (item.type === "directory") size.textContent = "Carpeta";
    else size.textContent = formatBytes(item.size);
    li.append(name, size);
    elements.deleteList.append(li);
  }
  elements.deleteConfirm.disabled = false;
  elements.deleteDialog.showModal();
}

async function confirmDelete() {
  const paths = [...state.selected];
  elements.deleteConfirm.disabled = true;
  try {
    await api("/api/files", {
      method: "DELETE",
      body: JSON.stringify({ paths })
    });
    elements.deleteDialog.close();
    showToast("Selección borrada.");
    await loadFiles(state.cwd);
  } catch (error) {
    showToast(error.message);
    elements.deleteConfirm.disabled = false;
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
    error: "Error",
    cancelled: "Cancelada"
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

function hydrateIcons() {
  document.querySelectorAll("[data-icon]").forEach((element) => {
    const label = element.dataset.label ? `<span>${element.dataset.label}</span>` : "";
    element.innerHTML = icon(element.dataset.icon) + label;
  });
}

function renderThemeToggle() {
  const isLight = document.documentElement.dataset.theme === "light";
  elements.themeToggle.innerHTML = icon(isLight ? "moon" : "sun");
  elements.themeToggle.title = isLight ? "Tema oscuro" : "Tema claro";
  elements.themeToggle.setAttribute("aria-label", elements.themeToggle.title);
}

function renderBreadcrumbs(cwd) {
  elements.breadcrumbs.innerHTML = "";
  const parts = cwd === "." ? [] : cwd.split("/");
  const crumbs = [{ label: "Descargas", path: ".", home: true }];
  parts.forEach((part, index) => crumbs.push({ label: part, path: parts.slice(0, index + 1).join("/") }));
  crumbs.forEach((crumb, index) => {
    if (index > 0) {
      const sep = document.createElement("span");
      sep.className = "crumb-sep";
      sep.textContent = "/";
      elements.breadcrumbs.append(sep);
    }
    const button = document.createElement("button");
    button.type = "button";
    if (crumb.home) button.innerHTML = icon("home");
    button.append(document.createTextNode(crumb.label));
    if (index === crumbs.length - 1) button.setAttribute("aria-current", "page");
    else button.addEventListener("click", () => loadFiles(crumb.path));
    elements.breadcrumbs.append(button);
  });
}

function renderSelectionCount() {
  const count = state.selected.size;
  elements.selectionCount.hidden = count === 0;
  elements.selectionCount.textContent = count === 1 ? "1 seleccionado" : `${count} seleccionados`;
}

function formatDate(value) {
  return new Date(value).toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" });
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
reconnectActiveJobs();
