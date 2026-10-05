import fssync from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: options.input ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const onAbort = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (typeof options.onStdout === "function") options.onStdout(text, stdout);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (typeof options.onStderr === "function") options.onStderr(text, stderr);
    });
    child.on("error", (error) => {
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      options.signal?.removeEventListener("abort", onAbort);
      if (options.signal?.aborted) {
        const error = new Error("Transferencia cancelada");
        error.cancelled = true;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const message = (stderr || stdout || `${command} salió con código ${code}`).trim();
        const error = new Error(message);
        error.code = code;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
    if (options.input) {
      child.stdin.end(options.input);
    }
  });
}

export function commandExists(command) {
  const pathDirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  return pathDirs.some((directory) => {
    const commandPath = path.join(directory, command);
    try {
      fssync.accessSync(commandPath, fssync.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

export function firstAvailableCommand(commands) {
  return commands.find((command) => commandExists(command)) || null;
}
