export function handleAsync(fn) {
  return (request, response, next) => {
    Promise.resolve(fn(request, response, next)).catch(next);
  };
}

