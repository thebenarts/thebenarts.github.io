// Low-latency player for the relay's WebSocket stream (used inside Discord, where WebRTC is blocked).
// Video: H.264 Annex B access units -> WebCodecs VideoDecoder -> canvas, drawn the moment they decode.
// Audio: Opus packets -> WebCodecs AudioDecoder -> Web Audio, scheduled a few ms ahead.
import { PROBE } from "./webrtc.js";

const KIND_KEY = 1, KIND_DELTA = 2, KIND_AUDIO = 3;
const AUDIO_LEAD = 0.04;   // seconds of audio we schedule ahead (absorbs network jitter)
const AUDIO_MAX = 0.25;    // if we get further ahead than this, skip forward to stay live

export function wsSupported() {
  return "VideoDecoder" in window && "AudioDecoder" in window;
}

// avc1.PPCCLL codec string from the SPS NAL in an Annex B access unit.
function codecFromAU(au) {
  for (let i = 0; i + 6 < au.length; i++) {
    if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1 && (au[i + 3] & 0x1f) === 7) {
      const h = (b) => b.toString(16).padStart(2, "0");
      return `avc1.${h(au[i + 4])}${h(au[i + 5])}${h(au[i + 6])}`;
    }
  }
  return null;
}

export class WsPlayer {
  constructor(canvas, { onStatus = () => {}, onFirstFrame = () => {} } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onStatus = onStatus;
    this.onFirstFrame = onFirstFrame;
    this.audioCtx = null;
    this.gain = null;
    this.volume = 1;
    this.muted = true;
    this.reset();
  }

  reset() {
    this.vdec = null;
    this.adec = null;
    this.codec = null;
    this.needKey = true;
    this.nextAudioTime = 0;
    this.gotFrame = false;
    this.stats = { frames: 0, bytes: 0, dropped: 0, w: 0, h: 0, lastFrames: 0, lastBytes: 0, fps: 0, kbps: 0 };
  }

  // `urls` may be a list of candidate URLs: if one fails before delivering anything we try
  // the next (Discord's proxy path rules differ between clients), then stick with what worked.
  connect(urls, index = 0) {
    this.close();
    this.urls = Array.isArray(urls) ? urls : [urls];
    this.closed = false;
    const url = this.urls[index % this.urls.length];
    let gotData = false;
    const ws = (this.ws = new WebSocket(url));
    ws.binaryType = "arraybuffer";
    ws.onmessage = (e) => {
      if (!gotData) { gotData = true; this.urls = [url]; }
      typeof e.data === "string" ? this.onText(e.data) : this.onBinary(e.data);
    };
    ws.onclose = () => {
      if (this.closed) return;
      const next = gotData ? 0 : index + 1;
      if (gotData || next >= this.urls.length) this.onStatus("reconnecting");
      this.retry = setTimeout(() => this.connect(this.urls, next), gotData || next >= this.urls.length ? 1500 : 0);
    };
    this.statsTimer = setInterval(() => this.tickStats(), 1000);
  }

  close() {
    this.closed = true;
    clearTimeout(this.retry);
    clearInterval(this.statsTimer);
    if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null; }
    try { this.vdec?.close(); } catch {}
    try { this.adec?.close(); } catch {}
    this.reset();
  }

  onText(text) {
    try {
      const msg = JSON.parse(text);
      if (msg.type === "status") {
        if (msg.state !== "live") { this.needKey = true; this.gotFrame = false; }
        this.onStatus(msg.state);
      }
    } catch {}
  }

  onBinary(buf) {
    const view = new DataView(buf);
    const kind = view.getUint8(0);
    const ts = Number(view.getBigUint64(1));
    const data = new Uint8Array(buf, 9);
    this.stats.bytes += buf.byteLength;
    if (kind === KIND_AUDIO) this.onAudio(data, ts);
    else this.onVideo(data, ts, kind === KIND_KEY);
  }

  // ---------------- video ----------------
  onVideo(data, ts, key) {
    if (key) {
      const codec = codecFromAU(data);
      if (codec && (codec !== this.codec || !this.vdec || this.vdec.state === "closed")) this.setupVideo(codec);
    }
    if (!this.vdec || this.vdec.state !== "configured") return;
    // Decoder genuinely falling behind (slow machine): skip to the next keyframe to stay live.
    // The threshold is high on purpose: on join the relay sends a catch-up burst (frames since
    // the last keyframe) that the decoder chews through in a few ms - that must not be skipped.
    if (this.vdec.decodeQueueSize > 90 && !key) { this.needKey = true; this.stats.dropped++; return; }
    if (this.needKey) {
      if (!key) { this.stats.dropped++; return; }
      this.needKey = false;
    }
    try {
      this.vdec.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: ts, data }));
    } catch (e) {
      this.needKey = true;
    }
  }

  setupVideo(codec) {
    try { this.vdec?.close(); } catch {}
    this.codec = codec;
    this.needKey = true;
    this.vdec = new VideoDecoder({
      output: (frame) => this.drawFrame(frame),
      error: () => { this.needKey = true; this.codec = null; }, // rebuilt on next keyframe
    });
    // No `description` => decoder expects Annex B with in-band SPS/PPS, which is what the relay sends.
    this.vdec.configure({ codec, optimizeForLatency: true, hardwareAcceleration: "no-preference" });
  }

  drawFrame(frame) {
    const w = frame.displayWidth, h = frame.displayHeight;
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.ctx.drawImage(frame, 0, 0, w, h);
    frame.close();
    this.stats.frames++; this.stats.w = w; this.stats.h = h;
    this.readProbe();
    if (!this.gotFrame) { this.gotFrame = true; this.onFirstFrame(); }
  }

  // ---------------- audio ----------------
  // Must be called from a click/tap (browsers require a user gesture to start sound).
  async enableAudio() {
    if (!this.audioCtx) {
      this.audioCtx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
      this.gain = this.audioCtx.createGain();
      this.gain.connect(this.audioCtx.destination);
    }
    await this.audioCtx.resume();
    this.muted = false;
    this.applyVolume();
  }
  setMuted(m) { this.muted = m; this.applyVolume(); }
  setVolume(v) { this.volume = v; this.applyVolume(); }
  applyVolume() { if (this.gain) this.gain.gain.value = this.muted ? 0 : this.volume; }

  onAudio(data, ts) {
    if (!this.audioCtx || this.audioCtx.state !== "running") return; // not unmuted yet: don't build a backlog
    if (!this.adec || this.adec.state === "closed") {
      this.adec = new AudioDecoder({
        output: (ad) => this.playAudio(ad),
        error: () => { this.adec = null; },
      });
      this.adec.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 2 });
    }
    try { this.adec.decode(new EncodedAudioChunk({ type: "key", timestamp: ts, data })); } catch {}
  }

  playAudio(ad) {
    const ctx = this.audioCtx;
    const buf = ctx.createBuffer(ad.numberOfChannels, ad.numberOfFrames, ad.sampleRate);
    for (let ch = 0; ch < ad.numberOfChannels; ch++) {
      const plane = new Float32Array(ad.numberOfFrames);
      ad.copyTo(plane, { planeIndex: ch, format: "f32-planar" });
      buf.copyToChannel(plane, ch);
    }
    ad.close();
    const now = ctx.currentTime;
    // Ran dry (network hiccup) or drifted too far ahead: re-anchor just ahead of "now".
    if (this.nextAudioTime < now || this.nextAudioTime > now + AUDIO_MAX) this.nextAudioTime = now + AUDIO_LEAD;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    src.start(this.nextAudioTime);
    this.nextAudioTime += buf.duration;
  }

  // ---------------- stats ----------------
  tickStats() {
    const s = this.stats;
    s.fps = s.frames - s.lastFrames; s.lastFrames = s.frames;
    s.kbps = ((s.bytes - s.lastBytes) * 8) / 1000; s.lastBytes = s.bytes;
  }

  statsText() {
    const s = this.stats;
    const lead = this.audioCtx ? Math.max(0, Math.round((this.nextAudioTime - this.audioCtx.currentTime) * 1000)) : null;
    const lines = [
      `video     ${s.w}x${s.h} @ ${s.fps} fps  ${this.codec ?? "?"}`,
      `bitrate   ${(s.kbps / 1000).toFixed(2)} Mbps  (WebSocket)`,
      `decoder   queue ${this.vdec?.decodeQueueSize ?? 0}   skipped ${s.dropped} frames`,
      `audio     ${lead === null ? "muted (click to unmute)" : `${lead} ms buffered`}`,
    ];
    if (this.probeSamples?.length) {
      const sorted = [...this.probeSamples].sort((a, b) => a - b);
      lines.push(`latency   ${sorted[Math.floor(sorted.length / 2)]} ms glass-to-glass (test probe)`);
    }
    return lines.join("\n");
  }

  // Reads the test publisher's timestamp strip back from the canvas (see drawProbe in webrtc.js).
  readProbe() {
    if (!this.probeEnabled || !this.canvas.width) return;
    const scale = this.canvas.width / PROBE.width;
    const y = Math.floor((PROBE.height / 2) * scale);
    const px = this.ctx.getImageData(0, y, Math.ceil(PROBE.blocks * PROBE.block * scale), 1).data;
    const bit = (i) => (px[Math.floor((i * PROBE.block + PROBE.block / 2) * scale) * 4 + 1] > 128 ? 1 : 0);
    if (bit(0) !== 1 || bit(1) !== 0) return;
    let v = 0;
    for (let i = 2; i < PROBE.blocks; i++) v = v * 2 + bit(i);
    let d = (Date.now() % 4294967296) - v;
    if (d < 0) d += 4294967296;
    if (d > 60000) return;
    (this.probeSamples ??= []).push(d);
    if (this.probeSamples.length > 60) this.probeSamples.shift();
  }
}
