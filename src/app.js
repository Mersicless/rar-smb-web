import express from "express";
import { DOWNLOAD_DIR, PUBLIC_DIR } from "./config/paths.js";
import { errorHandler } from "./middlewares/error-handler.js";
import downloadRoutes from "./routes/download.routes.js";
import fileRoutes from "./routes/file.routes.js";
import jobRoutes from "./routes/job.routes.js";
import transferRoutes from "./routes/transfer.routes.js";
import { ensureDownloadDirectory } from "./services/file.service.js";

await ensureDownloadDirectory();

const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.static(PUBLIC_DIR));
app.use("/api/download", downloadRoutes);
app.use("/api/jobs", jobRoutes);
app.use("/api/files", fileRoutes);
app.use("/api/transfer", transferRoutes);
app.use("/api/downloads", express.static(DOWNLOAD_DIR, {
  dotfiles: "deny",
  index: false
}));
app.use(errorHandler);

export default app;

