import app from "./app.js";
import { DOWNLOAD_DIR } from "./config/paths.js";
import { HOST, PORT } from "./config/server.js";

app.listen(PORT, HOST, () => {
  console.log(`RAR SMB Web listo en http://localhost:${PORT}`);
  console.log(`Repositorio de descargas: ${DOWNLOAD_DIR}`);
});

