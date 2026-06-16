export function formatTauriUri(uri: string): string {
  if (!uri) return "";
  if (/Windows/i.test(navigator.userAgent)) {
    return uri.replace("fundus://", "http://fundus.localhost/");
  }
  // Linux + macOS: rewrite to fundus://localhost/<rest> so WebKit's URL parser
  // sees an authority, not a path, and the protocol handler fires.
  return uri.replace("fundus://", "fundus://localhost/");
}
