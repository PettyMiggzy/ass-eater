export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      for (const ext of ['.js', '.mjs', '/index.js']) {
        try { return await next(specifier + ext, context); } catch {}
      }
    }
    throw err;
  }
}
