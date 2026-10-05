import crypto from "node:crypto";

const jobs = new Map();
const THROTTLE_MS = 500;
// Los trabajos terminados se olvidan pasado un tiempo (antes la lista crecía sin fin).
const JOB_TTL_MS = Number(process.env.JOB_TTL_MS) || 60 * 60 * 1000;
// Canal SSE compartido (/api/jobs/events): un solo EventSource por pestaña para todos
// los trabajos. Con uno por trabajo, 6 trabajos vivos agotan las 6 conexiones HTTP/1.1
// que Chrome abre por servidor y la app deja de responder (ni Cancelar ni la lista).
const globalListeners = new Set();

export function createJob(type, extras = {}) {
  const id = crypto.randomUUID();
  const job = {
    id,
    type,
    status: "queued",
    percent: 0,
    message: "En cola",
    filename: extras.filename || null,
    bytesDownloaded: 0,
    totalBytes: 0,
    speedBps: 0,
    etaSeconds: null,
    partialPath: null,
    abortController: null,
    // Se puede cancelar mientras está en cola o descargando; durante la descompresión no.
    cancellable: type === "download",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    result: null,
    error: null,
    listeners: new Set(),
    _lastNotifyAt: 0,
    _throttleTimer: null
  };
  jobs.set(id, job);
  return job;
}

export function getJob(id) {
  return jobs.get(id);
}

export function listJobs({ activeOnly = false } = {}) {
  const all = [...jobs.values()];
  const filtered = activeOnly
    ? all.filter((job) => job.status === "queued" || job.status === "running")
    : all;
  return filtered
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .map(publicJob);
}

export function publicJob(job) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    percent: job.percent,
    message: job.message,
    filename: job.filename,
    bytesDownloaded: job.bytesDownloaded,
    totalBytes: job.totalBytes,
    speedBps: job.speedBps,
    etaSeconds: job.etaSeconds,
    cancellable: Boolean(job.cancellable),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    result: job.result,
    error: job.error
  };
}

export function addGlobalListener(response) {
  globalListeners.add(response);
  return () => globalListeners.delete(response);
}

function notifyListeners(job) {
  const payload = `data: ${JSON.stringify(publicJob(job))}\n\n`;
  for (const response of job.listeners) {
    response.write(payload);
  }
  for (const response of globalListeners) {
    response.write(payload);
  }
}

function scheduleCleanup(job) {
  if (job._cleanupTimer) return;
  job._cleanupTimer = setTimeout(() => {
    jobs.delete(job.id);
    for (const response of job.listeners) response.end();
    job.listeners.clear();
  }, JOB_TTL_MS);
  job._cleanupTimer.unref?.();
}

function flushJob(job) {
  if (job._throttleTimer) {
    clearTimeout(job._throttleTimer);
    job._throttleTimer = null;
  }
  job._lastNotifyAt = Date.now();
  notifyListeners(job);
}

export function updateJob(job, patch) {
  const previousStatus = job.status;
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });

  const nextStatus = job.status;
  const statusChanged = nextStatus !== previousStatus;
  const isTerminal =
    nextStatus === "done" || nextStatus === "error" || nextStatus === "cancelled";

  // Estado terminal o cambio de estado: avisar ya. El progreso se limita a 500 ms.
  if (isTerminal) {
    job.cancellable = false;
    scheduleCleanup(job);
  }
  if (isTerminal || statusChanged) {
    flushJob(job);
    return;
  }

  const now = Date.now();
  const elapsed = now - (job._lastNotifyAt || 0);
  if (elapsed >= THROTTLE_MS) {
    flushJob(job);
    return;
  }

  if (!job._throttleTimer) {
    job._throttleTimer = setTimeout(() => {
      job._throttleTimer = null;
      flushJob(job);
    }, THROTTLE_MS - elapsed);
  }
}
