import crypto from "node:crypto";

const jobs = new Map();

export function createJob(type) {
  const id = crypto.randomUUID();
  const job = {
    id,
    type,
    status: "queued",
    percent: 0,
    message: "En cola",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    result: null,
    error: null,
    listeners: new Set()
  };
  jobs.set(id, job);
  return job;
}

export function getJob(id) {
  return jobs.get(id);
}

export function publicJob(job) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    percent: job.percent,
    message: job.message,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    result: job.result,
    error: job.error
  };
}

export function updateJob(job, patch) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  const payload = `data: ${JSON.stringify(publicJob(job))}\n\n`;
  for (const response of job.listeners) {
    response.write(payload);
  }
}

