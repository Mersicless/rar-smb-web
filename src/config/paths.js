import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PROJECT_DIR = path.resolve(__dirname, "../..");
export const PUBLIC_DIR = path.join(PROJECT_DIR, "public");
export const DOWNLOAD_DIR = path.resolve(
  process.env.DOWNLOAD_DIR || path.join(PROJECT_DIR, "downloads")
);

