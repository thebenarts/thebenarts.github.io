// Multi-server support shared by the browser player and the Discord Activity.
//
// The server this page came from lists its friends' servers in /activity-config.json
// (from config/servers.json). Each server is reached:
//   - in a normal browser: directly at its https:// URL (Broadcast Box allows cross-origin requests)
//   - inside Discord:      through its URL Mapping prefix, e.g. /.proxy/s/anna (Discord blocks
//                          direct requests to other sites)
// Viewers always connect straight to the server that hosts the stream.

export const inDiscord = new URLSearchParams(location.search).has("frame_id");

async function fetchWithTimeout(url, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { signal: ctl.signal, cache: "no-store" }); }
  finally { clearTimeout(t); }
}

export class Server {
  constructor({ name, prefix = "", url = "" }) {
    this.name = name;
    this.prefix = prefix;
    this.url = url;
    this.isSelf = !prefix && !url;
    this.base = null; // resolved HTTP base once a request succeeds
  }

  // Where this server's API might live, in the order we try them.
  candidates() {
    if (this.isSelf) return [""];
    if (inDiscord) return [`/.proxy${this.prefix}`, this.prefix];
    return [this.url];
  }

  /** Live streams on this server ([] if it's offline or unreachable). */
  async live() {
    for (const b of this.base !== null ? [this.base] : this.candidates()) {
      try {
        const res = await fetchWithTimeout(`${b}/api/status`, 3000);
        if (!res.ok) continue;
        const data = await res.json(); // a wrong path returns the HTML app page -> throws
        if (data !== null && !Array.isArray(data)) continue;
        this.base = b;
        return (data || []).filter((s) => (s.videoTracks || []).length).map((s) => ({ server: this, key: s.streamKey, viewers: (s.sessions || []).length }));
      } catch {}
    }
    return [];
  }

  /** WebSocket URL candidates for the relay feed (used by the Discord Activity). */
  wsUrls(key) {
    const path = `/ws/${encodeURIComponent(key)}`;
    const toWs = (base) => {
      if (/^https?:/.test(base)) return base.replace(/^http/, "ws") + path;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      return `${proto}://${location.host}${base}${path}`;
    };
    if (this.isSelf && inDiscord) return [toWs("/.proxy"), toWs("")];
    const bases = this.base !== null ? [this.base] : this.candidates();
    return bases.map(toWs);
  }
}

/**
 * Loads the Discord app ID and the server list.
 * Served by a streaming server's relay: that server comes first with no prefix/url ("self").
 * Served by the static site (GitHub Pages): every server has its own prefix and url, no "self".
 */
export async function loadConfig() {
  let cfg = {};
  // Relative on purpose: the static site may live in a sub-folder (github.io/<repo>/).
  try { cfg = await (await fetchWithTimeout("activity-config.json", 3000)).json(); } catch {}
  const list = Array.isArray(cfg.servers) && cfg.servers.length ? cfg.servers : [{ name: "This server" }];
  const servers = list.map((s) => new Server(s));
  return { clientId: cfg.clientId || "", servers, hasSelf: servers.some((s) => s.isSelf) };
}

/** Live streams across all servers, in server order. Unreachable servers are skipped. */
export async function listAllLive(servers) {
  return (await Promise.all(servers.map((s) => s.live()))).flat();
}
