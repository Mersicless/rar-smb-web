export function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    const error = new Error(`${label} es obligatorio.`);
    error.statusCode = 400;
    throw error;
  }
  return value.trim();
}

export function optionalText(value) {
  return typeof value === "string" ? value.trim() : "";
}

