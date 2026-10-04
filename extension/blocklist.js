// Per-site blocklist. Patterns come from the options page
// (chrome.storage.local) and from enterprise policy (chrome.storage.managed).
//
// A pattern is matched against the URL's hostname + path, case-insensitively,
// ignoring a leading scheme and "www.". "*" matches any run of characters.
// A bare domain ("bank.com") blocks the whole site; a path ("github.com/acme")
// blocks that path and everything under it. Subdomains are always covered.

let patterns = [];

export function compilePattern(source) {
  const s = source.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^www\./, "");
  const slash = s.indexOf("/");
  const host = slash < 0 ? s : s.slice(0, slash);
  let path = slash < 0 ? "/*" : s.slice(slash);
  const glob = (x) => x.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  // Without a trailing "*", a path also covers everything beneath it.
  const pathRe = path.endsWith("*") ? glob(path) : `${glob(path.replace(/\/$/, ""))}(?:/.*)?`;
  const hostRe = host.startsWith("*") ? glob(host) : `(?:[^/]*\\.)?${glob(host)}`;
  return new RegExp(`^${hostRe}${pathRe}$`);
}

export async function loadBlocklist() {
  const [local, managed] = await Promise.all([
    chrome.storage.local.get("blockedUrlPatterns").catch(() => ({})),
    chrome.storage.managed.get("blockedUrlPatterns").catch(() => ({})),
  ]);
  const all = [...(managed.blockedUrlPatterns || []), ...(local.blockedUrlPatterns || [])];
  patterns = all
    .map((s) => String(s).trim())
    .filter(Boolean)
    .map((source) => ({ source, re: compilePattern(source) }));
}

// Returns the matching pattern if url is blocked, else null.
export function blockedBy(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!u.hostname) return null;
  const target = u.hostname.toLowerCase().replace(/^www\./, "") + (u.pathname || "/").toLowerCase();
  const hit = patterns.find((p) => p.re.test(target));
  return hit ? hit.source : null;
}
