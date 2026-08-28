export function extractExactQuerySuffix(finalUrl) {
  if (typeof finalUrl !== "string" || finalUrl.length === 0) return null;
  try {
    new URL(finalUrl);
  } catch {
    return null;
  }
  const fragment = finalUrl.indexOf("#");
  const query = finalUrl.indexOf("?");
  if (query < 0 || (fragment >= 0 && query > fragment)) return null;
  const suffix = finalUrl.slice(query + 1, fragment < 0 ? undefined : fragment);
  return suffix.length > 0 ? suffix : null;
}
