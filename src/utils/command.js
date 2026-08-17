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
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const message = (stderr || stdout || `${command} salio con codigo ${code}`).trim();
        const error = new Error(message);
        error.code = code;
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

