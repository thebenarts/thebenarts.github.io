// Discord Activity entry point. Also runs in a normal browser (handy for testing).
// Lists live streams from this server and all friends' servers (see servers.js), and plays
// the chosen one over the relay's WebSocket feed (Discord blocks WebRTC inside Activities).
import { WsPlayer, wsSupported } from "./wsplayer.js";
import { inDiscord, loadConfig, listAllLive } from "./servers.js";

const $ = (id) => document.getElementById(id);
const stage = $("stage");

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const config = loadConfig();

// ---------------- Discord handshake ----------------
async function initDiscord() {
  if (!inDiscord) return;
  try {
    const { clientId } = await config;
    const { DiscordSDK } = await import("./vendor/discord-sdk.js");
    const sdk = new DiscordSDK(clientId);
    await sdk.ready(); // tells Discord the Activity loaded; no login/permissions needed just to watch
  } catch (e) {
    console.error("Discord SDK init failed", e);
  }
}

// ---------------- Lobby ----------------
let lobbyTimer = 0;
async function refreshLobby() {
  const { servers } = await config;
  const live = await listAllLive(servers);
  const multi = servers.length > 1;
  $("streams").replaceChildren(...live.map(({ server, key }) => {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = "#";
    a.onclick = (e) => { e.preventDefault(); watch(server, key); };
    const dot = document.createElement("span"); dot.className = "dot";
    const name = document.createElement("span"); name.className = "name"; name.textContent = key;
    a.append(dot, name);
    if (multi) {
      const where = document.createElement("span"); where.className = "muted"; where.textContent = `on ${server.name}`;
      a.append(where);
    }
    li.append(a);
    return li;
  }));
  $("empty").hidden = live.length > 0;
}
function showLobby() {
  player.close();
  stage.hidden = true;
  $("lobby").hidden = false;
  refreshLobby();
  clearInterval(lobbyTimer);
  lobbyTimer = setInterval(refreshLobby, 4000);
}

// ---------------- Player ----------------
const player = new WsPlayer($("canvas"), {
  onStatus: (state) => {
    $("live").hidden = state !== "live";
    if (state === "waiting") setStatus(`Waiting for ${current} to go live…`);
    else if (state === "reconnecting") setStatus("Connection lost, reconnecting…");
    else if (state === "live" && !player.gotFrame) setStatus("Starting…");
  },
  onFirstFrame: () => setStatus(""),
});
let current = "";

function setStatus(text) {
  $("status").hidden = !text;
  $("statusText").textContent = text;
}

function watch(server, key) {
  current = key;
  clearInterval(lobbyTimer);
  $("lobby").hidden = true;
  stage.hidden = false;
  $("title").textContent = server.isSelf ? key : `${key} · ${server.name}`;
  setStatus("Connecting…");
  player.connect(server.wsUrls(key));
  player.probeEnabled = !$("stats").hidden;
  syncAudioUi();
}

// ---------------- Controls ----------------
function syncAudioUi() {
  const off = player.muted || !player.audioCtx;
  $("muteBtn").textContent = off ? "🔇" : "🔊";
  // Show the banner until sound is running, unless the viewer deliberately muted.
  $("unmute").hidden = player.audioCtx?.state === "running" || store.get("muted", false);
}
async function unmute() {
  await player.enableAudio();
  store.set("muted", false);
  syncAudioUi();
}
$("unmute").onclick = unmute;
$("muteBtn").onclick = async () => {
  if (!player.audioCtx || player.muted) await unmute();
  else { player.setMuted(true); store.set("muted", true); syncAudioUi(); }
};
$("volume").value = store.get("volume", 1);
player.setVolume(+$("volume").value);
$("volume").oninput = (e) => { player.setVolume(+e.target.value); store.set("volume", +e.target.value); };
$("statsBtn").onclick = () => {
  $("stats").hidden = !$("stats").hidden;
  player.probeEnabled = !$("stats").hidden;
};
$("fsBtn").onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else stage.requestFullscreen?.().catch(() => {});
};
$("back").onclick = showLobby;
document.addEventListener("keydown", (e) => {
  if (stage.hidden) return;
  const k = e.key.toLowerCase();
  if (k === "f") $("fsBtn").click();
  else if (k === "m") $("muteBtn").click();
  else if (k === "s") $("statsBtn").click();
});
setInterval(() => { if (!$("stats").hidden) $("stats").textContent = player.statsText(); }, 1000);

let idleTimer = 0;
function wake() {
  stage.classList.remove("idle");
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => stage.classList.add("idle"), 2500);
}
stage.addEventListener("mousemove", wake);
stage.addEventListener("touchstart", wake, { passive: true });

// ---------------- Start ----------------
// The static site's front page (index.html) is this Activity page, because Discord loads "/".
// Browsers visiting it directly get the WebRTC player instead, which is the better fit there.
if (!inDiscord && /\/(index\.html)?$/.test(location.pathname)) {
  location.replace("watch.html" + location.search);
} else if (!wsSupported()) {
  $("unsupported").hidden = false;
  $("empty").hidden = true;
} else {
  initDiscord(); // handshake runs alongside; the player never waits on it
  const key = new URLSearchParams(location.search).get("key");
  if (key) config.then(({ servers }) => watch(servers[0], key)); // ?key= means a stream on this server
  else showLobby();
}
