// Multi-server support for the stream list.
//
// The front site (GitHub Pages) has a servers.json listing every streamer's server, each with its
// own https:// address. A page served by a streaming server itself has no servers.json, so it
// just lists that server ("self"). Viewers always connect straight to the server hosting a stream.

async function fetchWithTimeout(url, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { signal: ctl.signal, cache: "no-store" }); }
  finally { clearTimeout(t); }
}

export class Server {
  constructor({ name, url = "" }) {
    this.name = name;
    this.url = url.replace(/\/+$/, "");
    this.isSelf = !this.url;
  }

  /** Link to watch a stream on this server's own player page. */
  watchUrl(key) {
    return `${this.url}/watch.html?key=${encodeURIComponent(key)}`;
  }

  /** Live streams on this server ([] if it's offline or unreachable). */
  async live() {
    try {
      const res = await fetchWithTimeout(`${this.url}/api/status`, 3000);
      if (!res.ok) return [];
      const data = await res.json();
      if (!Array.isArray(data)) return [];
      return data
        .filter((s) => (s.videoTracks || []).length)
        .map((s) => ({ server: this, key: s.streamKey, viewers: (s.sessions || []).length }));
    } catch {
      return [];
    }
  }
}

/** Loads the server list: servers.json on the front site, otherwise just this server. */
export async function loadConfig() {
  let cfg = {};
  try { cfg = await (await fetchWithTimeout("servers.json", 3000)).json(); } catch {}
  const list = Array.isArray(cfg.servers) && cfg.servers.length ? cfg.servers : [{ name: "This server" }];
  const servers = list.map((s) => new Server(s));
  return { servers, hasSelf: servers.some((s) => s.isSelf) };
}

/** Live streams across all servers, in server order. Unreachable servers are skipped. */
export async function listAllLive(servers) {
  return (await Promise.all(servers.map((s) => s.live()))).flat();
}
