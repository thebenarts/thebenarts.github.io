import { watch, makeProbeReader } from "./webrtc.js";
import { loadConfig, listAllLive } from "./servers.js";

const config = loadConfig();

const $ = (id) => document.getElementById(id);
const video = $("video");
const stage = $("stage");

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// ---------------- Routing ----------------
// ?key=<stream> watches a stream on this server; ?server=<https url>&key=<stream> one on a
// friend's server (webrtc.js's serverBase() reads ?server).
function currentKey() { return new URLSearchParams(location.search).get("key") || ""; }
function urlFor(key, serverUrl = "") {
  const p = new URLSearchParams(location.search);
  key ? p.set("key", key) : p.delete("key");
  key && serverUrl ? p.set("server", serverUrl) : p.delete("server");
  const s = p.toString();
  return location.pathname + (s ? `?${s}` : "");
}
function go(key, serverUrl = "") { history.pushState(null, "", urlFor(key, serverUrl)); route(); }
window.addEventListener("popstate", route);

function route() {
  const key = currentKey();
  $("lobby").hidden = !!key;
  stage.hidden = !key;
  if (key) { stopLobby(); startPlayer(key); } else { stopPlayer(); startLobby(); }
}

// ---------------- Lobby ----------------
let lobbyTimer = 0;
async function refreshLobby() {
  const { servers } = await config;
  const live = await listAllLive(servers);
  const multi = servers.length > 1;
  const ul = $("streams");
  ul.replaceChildren(...live.map(({ server, key, viewers: n }) => {
    const li = document.createElement("li");
    const a = document.createElement("a");
    if (server.isSelf) {
      a.href = urlFor(key);
      a.onclick = (e) => { e.preventDefault(); go(key); };
    } else {
      a.href = server.watchUrl(key); // open the stream on its host's own https:// page
    }
    const dot = document.createElement("span"); dot.className = "dot";
    const name = document.createElement("span"); name.className = "name"; name.textContent = key;
    const viewers = document.createElement("span"); viewers.className = "muted";
    viewers.textContent = multi ? `on ${server.name} · ${n} watching` : `${n} watching`;
    a.append(dot, name, viewers);
    li.append(a);
    return li;
  }));
  $("empty").hidden = live.length > 0;
}
function startLobby() { refreshLobby(); lobbyTimer = setInterval(refreshLobby, 4000); }
function stopLobby() { clearInterval(lobbyTimer); }
$("join").onsubmit = (e) => { e.preventDefault(); const k = $("joinKey").value.trim(); if (k) go(k); };
// "Type a stream name" means a stream on this page's own server; the static site has none.
config.then(({ hasSelf }) => { $("join").hidden = !hasSelf; });

// ---------------- Player ----------------
let pc = null;
let generation = 0;     // bumps on every (re)connect so stale attempts bail out
let retryTimer = 0;
let statsTimer = 0;

function setStatus(text, spinning = true) {
  $("status").hidden = !text;
  $("statusText").textContent = text || "";
  $("status").querySelector(".spinner").hidden = !spinning;
}

function stopPlayer() {
  generation++;
  clearTimeout(retryTimer);
  clearInterval(statsTimer);
  if (pc) { pc.close(); pc = null; }
  video.srcObject = null;
  $("live").hidden = true;
}

async function startPlayer(key) {
  stopPlayer();
  const gen = generation;
  $("title").textContent = key;
  document.title = `${key} · Friendly Streamer`;
  setStatus("Connecting…");

  const stream = new MediaStream();
  try {
    pc = await watch({ streamKey: key, onTrack: (e) => stream.addTrack(e.track) });
  } catch (e) {
    if (gen !== generation) return;
    setStatus(`Waiting for ${key} to go live…`);
    retryTimer = setTimeout(() => startPlayer(key), 3000);
    return;
  }
  if (gen !== generation) { pc.close(); return; }

  video.srcObject = stream;
  applyVolume();
  tryPlay();

  pc.onconnectionstatechange = () => {
    if (gen !== generation) return;
    if (["failed", "disconnected", "closed"].includes(pc.connectionState)) reconnect(key, "Connection lost, reconnecting…");
  };
  startStats(key, gen);
}

function reconnect(key, msg) {
  setStatus(msg);
  $("live").hidden = true;
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => startPlayer(key), 1500);
}

video.addEventListener("playing", () => { setStatus(""); $("live").hidden = false; });

// Browsers block autoplay with sound until the user has interacted with the page.
async function tryPlay() {
  video.muted = store.get("muted", false);
  try { await video.play(); }
  catch {
    video.muted = true;
    try { await video.play(); } catch {}
  }
  $("unmute").hidden = !video.muted || store.get("muted", false);
  syncMuteIcon();
}
$("unmute").onclick = () => { setMuted(false); };

// ---------------- Controls ----------------
function applyVolume() { video.volume = store.get("volume", 1); $("volume").value = video.volume; }
function syncMuteIcon() { $("muteBtn").textContent = video.muted || video.volume === 0 ? "🔇" : "🔊"; }
function setMuted(m) {
  video.muted = m;
  store.set("muted", m);
  $("unmute").hidden = true;
  if (!m) video.play().catch(() => {});
  syncMuteIcon();
}
$("muteBtn").onclick = () => setMuted(!video.muted);
$("volume").oninput = (e) => {
  video.volume = +e.target.value;
  store.set("volume", video.volume);
  if (video.muted && video.volume > 0) setMuted(false);
  syncMuteIcon();
};
$("fsBtn").onclick = toggleFullscreen;
$("statsBtn").onclick = () => { $("stats").hidden = !$("stats").hidden; store.set("stats", !$("stats").hidden); };
$("back").onclick = () => go("");
video.ondblclick = toggleFullscreen;
$("stats").hidden = !store.get("stats", false);

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else stage.requestFullscreen?.().catch(() => {});
}

document.addEventListener("keydown", (e) => {
  if (stage.hidden || e.target.tagName === "INPUT") return;
  const k = e.key.toLowerCase();
  if (k === "f") toggleFullscreen();
  else if (k === "m") setMuted(!video.muted);
  else if (k === "s") $("statsBtn").click();
});

// Hide cursor + controls after 2.5s of no mouse movement.
let idleTimer = 0;
function wake() {
  stage.classList.remove("idle");
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => stage.classList.add("idle"), 2500);
}
stage.addEventListener("mousemove", wake);
stage.addEventListener("touchstart", wake, { passive: true });
wake();

// ---------------- Stats + stall detection ----------------
const probe = makeProbeReader();
const probeSamples = [];
if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) {
  const onFrame = () => {
    if (!$("stats").hidden) {
      const d = probe(video);
      if (d !== null) { probeSamples.push(d); if (probeSamples.length > 60) probeSamples.shift(); }
    }
    video.requestVideoFrameCallback(onFrame);
  };
  video.requestVideoFrameCallback(onFrame);
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

function startStats(key, gen) {
  let prev = null;
  let stalledFor = 0;
  statsTimer = setInterval(async () => {
    if (gen !== generation || !pc) return;
    const report = await pc.getStats();
    let v = null, a = null, pair = null;
    const byId = new Map();
    report.forEach((s) => {
      byId.set(s.id, s);
      if (s.type === "inbound-rtp" && s.kind === "video") v = s;
      if (s.type === "inbound-rtp" && s.kind === "audio") a = s;
      if (s.type === "candidate-pair" && s.nominated && s.state === "succeeded") pair = s;
    });
    if (!v) return;

    const now = v.timestamp;
    let kbps = 0, jb = 0;
    if (prev) {
      const dt = (now - prev.timestamp) / 1000;
      kbps = ((v.bytesReceived - prev.bytesReceived) * 8) / dt / 1000;
      const dCount = v.jitterBufferEmittedCount - prev.jitterBufferEmittedCount;
      jb = dCount > 0 ? ((v.jitterBufferDelay - prev.jitterBufferDelay) / dCount) * 1000 : 0;

      // Publisher stopped or froze: no new frames for 4s -> reconnect (lands on "waiting").
      stalledFor = v.framesDecoded === prev.framesDecoded ? stalledFor + dt : 0;
      if (stalledFor > 4) { reconnect(key, `${key} paused or ended, reconnecting…`); return; }
    }
    prev = v;

    if ($("stats").hidden) return;
    const codec = byId.get(v.codecId)?.mimeType?.split("/")[1] ?? "?";
    const aCodec = a ? byId.get(a.codecId)?.mimeType?.split("/")[1] ?? "?" : "none";
    const rtt = pair?.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : "?";
    const lines = [
      `video     ${v.frameWidth ?? "?"}x${v.frameHeight ?? "?"} @ ${Math.round(v.framesPerSecond ?? 0)} fps  ${codec}`,
      `bitrate   ${(kbps / 1000).toFixed(2)} Mbps`,
      `buffer    ${Math.round(jb)} ms (jitter buffer)`,
      `rtt       ${rtt} ms`,
      `lost      ${v.packetsLost ?? 0} pkts   dropped ${v.framesDropped ?? 0} frames`,
      `audio     ${aCodec}`,
    ];
    if (probeSamples.length) lines.push(`latency   ${median(probeSamples)} ms glass-to-glass (test probe)`);
    $("stats").textContent = lines.join("\n");
  }, 1000);
}

route();
