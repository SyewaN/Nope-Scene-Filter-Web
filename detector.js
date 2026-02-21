(() => {
  class SceneHeuristicDetector {
    constructor(video, options = {}) {
      this.video = video;
      this.onSegments = typeof options.onSegments === "function" ? options.onSegments : () => {};
      this.throttleMs = options.throttleMs || 1200;
      this.enabled = true;

      this.timer = null;
      this.audioCtx = null;
      this.analyser = null;
      this.audioData = null;
      this.audioAvg = 0;
      this.audioSamples = 0;

      this.canvas = null;
      this.ctx = null;
      this.prevFrameSignature = null;
      this.visualBlocked = false;

      this.lastSubtitleHit = 0;
      this.emitted = [];
      this.lastTime = null;
      this.blockUntil = 0;
      this.recentSignals = [];
    }

    async start() {
      this.setupAudio();
      this.setupCanvasSampler();
      this.bindInteractionGuards();
      this.timer = window.setInterval(() => this.tick(), this.throttleMs);
    }

    stop() {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      if (this.audioCtx) {
        try {
          this.audioCtx.close();
        } catch (_error) {}
      }
      this.audioCtx = null;
      this.analyser = null;
      this.audioData = null;
      this.recentSignals = [];
    }

    bindInteractionGuards() {
      const blockShort = () => {
        this.blockUntil = Date.now() + 1800;
      };
      this.video.addEventListener("seeking", blockShort);
      this.video.addEventListener("seeked", blockShort);
      this.video.addEventListener("dblclick", blockShort);
      this.video.addEventListener("ratechange", blockShort);
      document.addEventListener("dblclick", blockShort, true);
    }

    setupAudio() {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) {
          return;
        }

        this.audioCtx = new Ctx();
        const source = this.audioCtx.createMediaElementSource(this.video);
        this.analyser = this.audioCtx.createAnalyser();
        this.analyser.fftSize = 1024;
        source.connect(this.analyser);
        this.analyser.connect(this.audioCtx.destination);
        this.audioData = new Uint8Array(this.analyser.frequencyBinCount);
      } catch (_error) {
        this.analyser = null;
        this.audioData = null;
      }
    }

    setupCanvasSampler() {
      this.canvas = document.createElement("canvas");
      this.canvas.width = 64;
      this.canvas.height = 36;
      this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    }

    emit(segment) {
      const s = {
        start: Math.max(0, Number(segment.start) || 0),
        end: Math.max(0, Number(segment.end) || 0),
        type: segment.type,
        source_type: "local_ai",
        source: "local-ai",
        confidence_score: clamp(Number(segment.confidence_score) || 45, 10, 80),
        unverified: true
      };
      if (!s.type || s.end <= s.start) {
        return;
      }

      const exists = this.emitted.some(
        (e) => e.type === s.type && Math.abs(e.start - s.start) < 2 && Math.abs(e.end - s.end) < 2
      );
      if (exists) {
        return;
      }

      this.emitted.push(s);
      if (this.emitted.length > 300) {
        this.emitted.shift();
      }

      this.onSegments([s]);
    }

    queueSignal(kind, t, payload = {}) {
      this.recentSignals.push({
        kind,
        t,
        at: Date.now(),
        payload
      });
      const cutoff = Date.now() - 5000;
      this.recentSignals = this.recentSignals.filter((s) => s.at >= cutoff);
    }

    maybeEmitFromSignals(t) {
      const near = this.recentSignals.filter((s) => Math.abs(s.t - t) <= 2.2);
      const hasSubtitle = near.some((s) => s.kind === "subtitle");
      const hasAudio = near.some((s) => s.kind === "audio");
      const hasVisual = near.some((s) => s.kind === "visual");

      if (hasSubtitle) {
        const type = near.find((s) => s.kind === "subtitle")?.payload?.type || "sexual";
        this.emit({
          start: t - 0.4,
          end: t + 4.2,
          type,
          confidence_score: 64
        });
        return;
      }

      if (hasAudio && hasVisual) {
        this.emit({
          start: t - 0.3,
          end: t + 2.4,
          type: "sexual",
          confidence_score: 48
        });
      }
    }

    tick() {
      if (!this.enabled) {
        return;
      }
      if (Date.now() < this.blockUntil) {
        return;
      }
      const t = this.video.currentTime;
      if (!Number.isFinite(t) || this.video.paused) {
        return;
      }
      if (this.lastTime != null) {
        const dt = Math.abs(t - this.lastTime);
        if (dt > 2.2) {
          // user seek / jump; avoid false detections
          this.blockUntil = Date.now() + 2200;
          this.lastTime = t;
          return;
        }
      }
      this.lastTime = t;

      this.detectAudioSpike(t);
      this.detectSubtitleKeywords(t);
      this.detectVisualCut(t);
      this.maybeEmitFromSignals(t);
    }

    detectAudioSpike(t) {
      if (!this.analyser || !this.audioData) {
        return;
      }

      this.analyser.getByteFrequencyData(this.audioData);
      let sum = 0;
      for (let i = 0; i < this.audioData.length; i += 1) {
        sum += this.audioData[i];
      }
      const level = sum / this.audioData.length;
      this.audioAvg = this.audioAvg * 0.92 + level * 0.08;
      this.audioSamples += 1;

      if (this.audioSamples < 8) {
        return;
      }

      if (level > this.audioAvg * 1.55 && level > 55) {
        this.queueSignal("audio", t, { level });
      }
    }

    detectSubtitleKeywords(t) {
      const tracks = this.video.textTracks;
      if (!tracks || tracks.length === 0) {
        return;
      }

      const keywordSexual = /(sex|sexual|kiss|bed|naked|erotic|intercourse)/i;
      const keywordNudity = /(nudity|nude|topless|breast|genital|strip)/i;

      for (let i = 0; i < tracks.length; i += 1) {
        const track = tracks[i];
        if (!track || track.mode === "disabled") {
          continue;
        }

        const cues = track.activeCues;
        if (!cues) {
          continue;
        }

        for (let j = 0; j < cues.length; j += 1) {
          const text = String(cues[j].text || "");
          if (!text) {
            continue;
          }

          if (Date.now() - this.lastSubtitleHit < 1200) {
            continue;
          }

          if (keywordNudity.test(text)) {
            this.lastSubtitleHit = Date.now();
            this.queueSignal("subtitle", t, { type: "nudity" });
          } else if (keywordSexual.test(text)) {
            this.lastSubtitleHit = Date.now();
            this.queueSignal("subtitle", t, { type: "sexual" });
          }
        }
      }
    }

    detectVisualCut(t) {
      if (!this.ctx || this.visualBlocked || this.video.readyState < 2) {
        return;
      }

      try {
        this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
        const data = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height).data;

        let signature = 0;
        for (let i = 0; i < data.length; i += 24) {
          signature += data[i] + data[i + 1] + data[i + 2];
        }

        if (this.prevFrameSignature != null) {
          const diff = Math.abs(signature - this.prevFrameSignature) / Math.max(this.prevFrameSignature, 1);
          if (diff > 0.32) {
            this.queueSignal("visual", t, { diff });
          }
        }

        this.prevFrameSignature = signature;
      } catch (_error) {
        this.visualBlocked = true;
      }
    }
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  window.SceneHeuristicDetector = SceneHeuristicDetector;
})();
