// Quality options for simulcast streams.
//
// With OBS's simulcast option the streamer sends several versions ("layers") of the video, e.g.
// 1080p / 720p / 360p. Broadcast Box forwards one of them to each viewer and can switch at the
// next keyframe. This picks the layer: the viewer's choice, or "Auto", which steps down when the
// connection or the decoder can't keep up and back up once things have been fine for a while.

const NAMES = { 2: ["High", "Low"], 3: ["High", "Medium", "Low"] };
const nameFor = (rank, n) => (NAMES[n] || [])[rank] || (rank === 0 ? "High" : rank === n - 1 ? "Low" : `Medium ${rank}`);

// Common simulcast layer names, higher = better. Used only when every layer name is recognised.
const NAME_SCORES = [
  { high: 3, hi: 3, mid: 2, medium: 2, med: 2, low: 1, lo: 1 },
  { f: 3, h: 2, q: 1 },            // full / half / quarter (WebRTC convention)
  { h: 3, m: 2, l: 1 },
];
function nameScore(rids) {
  for (const table of NAME_SCORES) {
    if (rids.every((r) => String(r).toLowerCase() in table)) {
      return Object.fromEntries(rids.map((r) => [r, table[String(r).toLowerCase()]]));
    }
  }
  return null;
}

export class Quality {
  /**
   * @param {object} o
   * @param {(rid: string) => Promise<void>} o.switchTo  asks the server for a layer
   * @param {() => any} o.load  saved choice ("auto" or a rank number)
   * @param {(v: any) => void} o.save
   * @param {() => void} o.onUpdate  layer list / choice / current layer changed
   */
  constructor({ switchTo, load, save, onUpdate }) {
    Object.assign(this, { switchTo, save, onUpdate });
    const saved = load();
    this.choice = saved === "auto" || Number.isInteger(saved) ? saved : "auto";
    this.reset();
  }

  /** New connection: forget what the server is sending; keep the choice and Auto's level. */
  reset() {
    this.layers = this.layers || [];   // [{ rid, bitrate }], best first
    this.requested = null;             // rid we last asked for on this connection
    this.autoRank = this.autoRank || 0;
    this.badFor = 0; this.goodFor = 0;
    this.upAfter = this.upAfter || 15; // seconds of good playback before Auto tries a higher layer
    this.lastSwitch = 0; this.lastUp = 0;
  }

  get available() { return this.layers.length > 1; }
  get rank() {
    const r = this.choice === "auto" ? this.autoRank : this.choice;
    return Math.max(0, Math.min(r, this.layers.length - 1));
  }
  label(rank) {
    const l = this.layers[rank];
    const res = l && this.heights?.[l.rid] ? ` · ${this.heights[l.rid]}p` : "";
    // Resolution once we've seen it; until then the server's bitrate figure is the best hint.
    const mbps = !res && l?.bitrate ? ` · ${(l.bitrate / 1e6).toFixed(1)} Mbps` : "";
    return nameFor(rank, this.layers.length) + res + mbps;
  }
  get summary() {
    if (!this.available) return "single";
    return `${nameFor(this.rank, this.layers.length)}${this.choice === "auto" ? " (auto)" : ""}`;
  }

  /** Record the resolution we saw while receiving a layer (the most reliable way to rank it). */
  learn(rid, height) {
    if (!rid || !height || Date.now() - this.lastSwitch < 4000) return;
    this.heights = this.heights || {};
    if (this.heights[rid] !== height) { this.heights[rid] = height; this.onUpdate(); }
  }

  /** Feed the stream's videoTracks from /api/status. */
  setTracks(videoTracks) {
    const layers = (videoTracks || [])
      .filter((t) => t.rid !== undefined)
      .map((t) => ({ rid: t.rid, bitrate: t.bitrate || 0 }));
    // Best first. Re-sorted every time, since right after a stream starts the encoders may still
    // be ramping up. Prefer, in order: resolutions we've seen > well-known layer names > bitrate.
    const h = this.heights || {};
    const byName = nameScore(layers.map((l) => l.rid));
    const score = layers.every((l) => h[l.rid]) ? (l) => h[l.rid]
      : byName ? (l) => byName[l.rid]
      : (l) => l.bitrate;
    this.layers = layers.sort((a, b) => score(b) - score(a) || b.bitrate - a.bitrate);
    this.autoRank = Math.min(this.autoRank, Math.max(0, this.layers.length - 1));
    this.apply();
    this.onUpdate();
  }

  /** Viewer picked an option: "auto" or a rank. */
  choose(choice) {
    this.choice = choice;
    this.save(choice);
    this.badFor = this.goodFor = 0;
    this.apply();
    this.onUpdate();
  }

  apply() {
    if (!this.available) return;
    const rid = this.layers[this.rank].rid;
    if (rid === this.requested) return;
    this.requested = rid;
    this.lastSwitch = Date.now();
    this.switchTo(rid).catch(() => { this.requested = null; });
  }

  /**
   * Once a second while playing (Auto mode only does anything).
   * s: { lossRatio, dropRatio, decodeMs, frameMs }
   */
  tick(s) {
    if (this.choice !== "auto" || !this.available) return;
    const now = Date.now();
    if (now - this.lastSwitch < 4000) return; // let the new layer settle (keyframe, buffers)

    const bad = s.lossRatio > 0.02 || s.dropRatio > 0.1 || (s.frameMs > 0 && s.decodeMs > s.frameMs * 0.8);
    if (bad) { this.badFor++; this.goodFor = 0; } else { this.goodFor++; this.badFor = 0; }

    if (this.badFor >= 3 && this.autoRank < this.layers.length - 1) {
      // Stepping straight back down after trying higher: wait longer before the next try.
      if (this.lastUp && now - this.lastUp < 30000) this.upAfter = Math.min(this.upAfter * 2, 240);
      this.autoRank++;
      this.badFor = 0;
      this.apply();
      this.onUpdate();
    } else if (this.goodFor >= this.upAfter && this.autoRank > 0) {
      this.autoRank--;
      this.goodFor = 0;
      this.lastUp = now;
      this.apply();
      this.onUpdate();
    }
  }
}
