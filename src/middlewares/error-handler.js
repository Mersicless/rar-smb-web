export function errorHandler(error, request, response, next) {
  if (response.headersSent) {
    next(error);
    return;
  }
  response.status(error.statusCode || 500).json({ error: error.message || "Error interno." });
}

