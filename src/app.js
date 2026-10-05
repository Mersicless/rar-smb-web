import path from "node:path";
import express from "express";
import { DOWNLOAD_DIR, PUBLIC_DIR } from "./config/paths.js";
import { errorHandler } from "./middlewares/error-handler.js";
import downloadRoutes from "./routes/download.routes.js";
import fileRoutes from "./routes/file.routes.js";
import jobRoutes from "./routes/job.routes.js";
import transferRoutes from "./routes/transfer.routes.js";
import { assertRealInside, ensureDownloadDirectory, resolveInsideDownloads } from "./services/file.service.js";

await ensureDownloadDirectory();

const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.static(PUBLIC_DIR));
app.use("/api/download", downloadRoutes);
app.use("/api/jobs", jobRoutes);
app.use("/api/files", fileRoutes);
app.use("/api/transfer", transferRoutes);
// Antes de servir un archivo se comprueba a dónde apunta de verdad:
// un enlace simbólico que salga de descargas no se sirve.
app.use("/api/downloads", async (request, response, next) => {
  try {
    const relative = decodeURIComponent(request.path).replace(/^\/+/, "") || ".";
    await assertRealInside(resolveInsideDownloads(relative));
    next();
  } catch {
    response.status(404).end();
  }
});
// Lo descargado no es de confianza: un HTML o SVG abierto dentro de la app podría
// llamar a la API. Se sirve aislado (sandbox, sin adivinar tipos) y, si es una
// página, como descarga en vez de abrirse.
const ACTIVE_CONTENT = /\.(html?|xhtml|xht|shtml|svgz?|xml|xsl|mht(ml)?)$/i;
app.use("/api/downloads", express.static(DOWNLOAD_DIR, {
  dotfiles: "deny",
  index: false,
  setHeaders(response, filePath) {
    response.setHeader("Content-Security-Policy", "sandbox");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (ACTIVE_CONTENT.test(filePath)) {
      response.attachment(path.basename(filePath));
    }
  }
}));
app.use(errorHandler);

export default app;

