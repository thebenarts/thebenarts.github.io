// WHIP / WHEP helpers shared by the viewer and the test publisher.

export function serverBase() {
  const q = new URLSearchParams(location.search).get("server");
  return (q || location.origin).replace(/\/+$/, "");
}

// Waits for ICE gathering so we can send one complete offer (no trickle needed).
// The server is a public host, so host/srflx candidates arrive almost immediately.
function iceGathered(pc, timeoutMs = 1500) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); pc.removeEventListener("icegatheringstatechange", check); resolve(); };
    const check = () => { if (pc.iceGatheringState === "complete") done(); };
    const t = setTimeout(done, timeoutMs);
    pc.addEventListener("icegatheringstatechange", check);
  });
}

async function negotiate(pc, url, bearer) {
  await pc.setLocalDescription(await pc.createOffer());
  await iceGathered(pc);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/sdp", Authorization: `Bearer ${bearer}` },
    body: pc.localDescription.sdp,
  });
  const body = await res.text();
  if (!res.ok) {
    const err = new Error(body.trim() || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  await pc.setRemoteDescription({ type: "answer", sdp: body });
}

// Asks the browser to play frames as soon as they are decodable instead of
// building a jitter buffer. This is the main knob for sub-second playback.
export function minimizeLatency(receiver) {
  try { receiver.jitterBufferTarget = 0; } catch {}
  try { receiver.playoutDelayHint = 0; } catch {}
}

/** Subscribe to a stream. Returns the RTCPeerConnection; tracks arrive via onTrack. */
export async function watch({ streamKey, onTrack }) {
  const pc = new RTCPeerConnection();
  pc.addTransceiver("video", { direction: "recvonly" });
  pc.addTransceiver("audio", { direction: "recvonly" });
  pc.ontrack = (e) => {
    minimizeLatency(e.receiver);
    onTrack(e);
  };
  try {
    await negotiate(pc, `${serverBase()}/api/whep`, streamKey);
  } catch (e) {
    pc.close();
    throw e;
  }
  return pc;
}

/** Publish a MediaStream (used by the browser test publisher). */
export async function publish({ stream, token, maxBitrate = 6_000_000 }) {
  const pc = new RTCPeerConnection();
  for (const track of stream.getTracks()) {
    const sendEncodings = track.kind === "video" ? [{ maxBitrate, maxFramerate: 60 }] : undefined;
    const tr = pc.addTransceiver(track, { direction: "sendonly", streams: [stream], sendEncodings });
    if (track.kind === "video" && RTCRtpSender.getCapabilities) {
      // Prefer H.264 to match what OBS sends, so the test reflects real playback.
      const codecs = RTCRtpSender.getCapabilities("video").codecs;
      const h264 = codecs.filter((c) => c.mimeType === "video/H264");
      if (h264.length) tr.setCodecPreferences([...h264, ...codecs.filter((c) => c.mimeType !== "video/H264")]);
    }
  }
  try {
    await negotiate(pc, `${serverBase()}/api/whip`, token);
  } catch (e) {
    pc.close();
    throw e;
  }
  return pc;
}

export async function listLiveStreams() {
  const res = await fetch(`${serverBase()}/api/status`);
  if (!res.ok) return [];
  const all = (await res.json()) || [];
  return all.filter((s) => (s.videoTracks || []).length || (s.audioTracks || []).length);
}

// ---- Latency probe -------------------------------------------------------
// The test publisher paints Date.now() as a row of black/white blocks along the
// top edge. The viewer reads it back from each decoded frame. When both run on
// the same machine (or NTP-synced machines) this is true glass-to-glass latency.
export const PROBE = { width: 1280, blocks: 34, block: 20, height: 16 };

export function drawProbe(ctx, nowMs) {
  const v = nowMs % 4294967296;
  const bits = [1, 0]; // start marker: white, black
  for (let i = 31; i >= 0; i--) bits.push(Math.floor(v / 2 ** i) % 2);
  bits.forEach((b, i) => {
    ctx.fillStyle = b ? "#fff" : "#000";
    ctx.fillRect(i * PROBE.block, 0, PROBE.block, PROBE.height);
  });
}

export function makeProbeReader() {
  const canvas = document.createElement("canvas");
  canvas.width = PROBE.width;
  canvas.height = PROBE.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  return (video) => {
    if (!video.videoWidth) return null;
    const scale = video.videoWidth / PROBE.width;
    ctx.drawImage(video, 0, 0, video.videoWidth, PROBE.height * scale, 0, 0, PROBE.width, PROBE.height);
    const px = ctx.getImageData(0, PROBE.height / 2, PROBE.blocks * PROBE.block, 1).data;
    const bit = (i) => (px[(i * PROBE.block + PROBE.block / 2) * 4 + 1] > 128 ? 1 : 0);
    if (bit(0) !== 1 || bit(1) !== 0) return null;
    let v = 0;
    for (let i = 2; i < PROBE.blocks; i++) v = v * 2 + bit(i);
    let d = (Date.now() % 4294967296) - v;
    if (d < 0) d += 4294967296;
    return d < 60000 ? d : null; // ignore garbage reads
  };
}
