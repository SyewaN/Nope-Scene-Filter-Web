const api = typeof browser !== "undefined" ? browser : chrome;

const DEFAULT_ACTIONS = {
  sexual: "skip",
  nudity: "blur"
};

const POLL_INTERVAL_MS = 500;
const SNAPSHOT_INTERVAL_MS = 1000;
let styleInjected = false;
const controllers = new Map();
const observedRoots = new WeakSet();

function injectContentStyles() {
  if (styleInjected) {
    return;
  }
  styleInjected = true;

  const style = document.createElement("style");
  style.id = "scenefilter-content-style";
  style.textContent = `
    .sf-overlay-root { position: absolute; inset: 0; pointer-events: none; z-index: 2147483644; }
    .sf-status-banner {
      position: absolute;
      bottom: 12%;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(17, 17, 27, 0.88);
      color: #f5f5f5;
      border: 1px solid rgba(255, 255, 255, 0.24);
      border-radius: 8px;
      font-size: 13px;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
      padding: 8px 12px;
      opacity: 0;
      animation: sfFadeInOut 1300ms ease forwards;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    }
    @keyframes sfFadeInOut {
      0% { opacity: 0; transform: translateX(-50%) translateY(8px); }
      15% { opacity: 1; transform: translateX(-50%) translateY(0); }
      80% { opacity: 1; }
      100% { opacity: 0; transform: translateX(-50%) translateY(-4px); }
    }
    .sf-marker-layer {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 2147483643;
    }
    .sf-marker {
      position: absolute;
      top: 0;
      bottom: 0;
      min-width: 1px;
      border-radius: 2px;
      opacity: 0.98;
      box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.45);
    }
    .sf-marker-sexual { background: rgba(243, 139, 168, 0.95); }
    .sf-marker-nudity { background: rgba(249, 226, 175, 0.95); }
    .sf-marker-unverified { outline: 1px dashed rgba(255, 255, 255, 0.7); }
    .sf-fallback-track {
      position: absolute;
      left: 10px;
      right: 10px;
      bottom: 16px;
      height: 8px;
      border-radius: 999px;
      background: rgba(22, 28, 40, 0.88);
      border: 1px solid rgba(255, 255, 255, 0.35);
      box-shadow: 0 3px 10px rgba(0, 0, 0, 0.45);
      pointer-events: none;
      z-index: 2147483647;
    }
    .sf-preview-box {
      position: absolute;
      left: 50%;
      bottom: 20%;
      transform: translateX(-50%);
      display: inline-flex;
      flex-direction: column;
      gap: 6px;
      pointer-events: auto;
      background: rgba(24, 24, 37, 0.96);
      color: #cdd6f4;
      border: 1px solid rgba(137, 180, 250, 0.45);
      border-radius: 10px;
      padding: 10px;
      min-width: 220px;
      box-shadow: 0 8px 22px rgba(0, 0, 0, 0.4);
      z-index: 2147483647;
      font: 12px/1.4 ui-sans-serif, system-ui;
    }
    .sf-preview-box strong { font-size: 13px; }
    .sf-preview-buttons { display: flex; gap: 8px; }
    .sf-preview-buttons button {
      pointer-events: auto;
      border: 1px solid rgba(166, 173, 200, 0.6);
      background: rgba(49, 50, 68, 0.95);
      color: #cdd6f4;
      border-radius: 8px;
      padding: 6px 10px;
      font-size: 12px;
      cursor: pointer;
    }
  `;

  document.documentElement.appendChild(style);
}

function isElementVisible(element) {
  if (!element || !(element instanceof Element)) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

class SceneController {
  constructor(video) {
    this.video = video;
    this.interval = null;
    this.markerInterval = null;
    this.markerLayer = null;
    this.fallbackTrack = null;

    this.state = {
      enabled: true,
      adaptiveMode: true,
      audioOnlyMode: false,
      safeMode: "MEDIUM",
      confidenceThreshold: 70,
      debugMode: true,
      previewBeforeSkip: true,
      autoSkipDelaySec: 2,
      categoryActions: { ...DEFAULT_ACTIONS }
    };

    this.selectedMovie = null;
    this.allSegments = [];
    this.autoSegments = [];

    this.originalMuted = null;
    this.originalFilter = null;
    this.originalFilterPriority = "";
    this.originalPlaybackRate = null;
    this.originalWrapperFilter = null;
    this.originalWrapperFilterPriority = "";

    this.muting = false;
    this.blurring = false;
    this.speeding = false;
    this.blacking = false;
    this.manualBlur = false;
    this.blackoutLayer = null;
    this.blurLayer = null;

    this.lastSkipKey = null;
    this.lastSkipTs = 0;
    this.lastSnapshotTs = 0;
    this.lastCountdownSecond = null;
    this.previewOpenForKey = null;
    this.previewBlockedKeys = new Set();

    this.overlay = new window.SceneOverlayManager(video);
    this.detector = new window.SceneHeuristicDetector(video, {
      throttleMs: 1200,
      onSegments: (segments) => this.submitHeuristicSegments(segments)
    });
  }

  async init() {
    await this.refreshState();

    this.interval = window.setInterval(() => {
      this.tick();
    }, POLL_INTERVAL_MS);

    this.markerInterval = window.setInterval(() => {
      this.renderMarkers();
    }, 1600);

    this.video.addEventListener("durationchange", () => this.renderMarkers());
    this.video.addEventListener("loadedmetadata", () => this.renderMarkers());
    this.video.addEventListener("timeupdate", () => this.tick());
    window.addEventListener("keydown", (event) => this.handleShortcut(event));

    this.detector.start().catch(() => {});
    this.renderMarkers();
  }

  destroy() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.markerInterval) {
      clearInterval(this.markerInterval);
      this.markerInterval = null;
    }

    this.detector.stop();
    this.resetAllEffects();
    this.overlay.clearSkipPreview();

    if (this.markerLayer?.isConnected) {
      this.markerLayer.remove();
    }
    if (this.fallbackTrack?.isConnected) {
      this.fallbackTrack.remove();
    }
    if (this.blurLayer?.isConnected) {
      this.blurLayer.remove();
    }
  }

  async refreshState() {
    const response = await api.runtime.sendMessage({ type: "getState" });
    if (!response?.ok) {
      return;
    }

    this.state = {
      ...this.state,
      ...response.state,
      categoryActions: {
        ...DEFAULT_ACTIONS,
        ...(response.state.categoryActions || {})
      }
    };

    this.selectedMovie = response.state.selectedMovie;
    this.allSegments = Array.isArray(response.segments) ? response.segments : [];
    this.autoSegments = Array.isArray(response.autoSegments) ? response.autoSegments : this.allSegments;

    this.renderMarkers();
  }

  getEffectiveAction(segment) {
    if (window.SceneSegmentUtils && typeof window.SceneSegmentUtils.effectiveActionForSegment === "function") {
      return window.SceneSegmentUtils.effectiveActionForSegment(segment, this.state, this.state.categoryActions);
    }

    let action = this.state.categoryActions?.[segment.type] || "none";
    if (this.state.audioOnlyMode && action === "blur") {
      action = "mute";
    }
    if (this.state.adaptiveMode && action === "skip") {
      const duration = Number(segment.end) - Number(segment.start);
      if (duration > 0 && duration < 3) {
        action = "speed";
      }
    }
    return action;
  }

  activeSegmentsAt(time) {
    const sourceSegments =
      this.autoSegments.length > 0 ? this.autoSegments : this.state.safeMode === "OFF" ? [] : this.allSegments;

    return sourceSegments.filter((segment) => {
      if (time < segment.start || time >= segment.end) {
        return false;
      }
      return this.getEffectiveAction(segment) !== "none";
    });
  }

  tick() {
    this.pushPlaybackSnapshot();
    this.handleIncomingCountdown();

    if (!this.state.enabled || this.autoSegments.length === 0) {
      this.resetAllEffects();
      return;
    }

    const t = this.video.currentTime;
    const active = this.activeSegmentsAt(t);
    if (active.length === 0) {
      this.previewOpenForKey = null;
      this.overlay.clearSkipPreview();
      this.resetAllEffects();
      return;
    }

    const skipSegments = active.filter((s) => this.getEffectiveAction(s) === "skip");
    if (skipSegments.length > 0) {
      const first = skipSegments[0];
      const key = `${first.start}-${first.end}-${first.type}`;

      if (this.state.previewBeforeSkip && !this.previewBlockedKeys.has(key)) {
        if (this.previewOpenForKey !== key) {
          this.previewOpenForKey = key;
          const delay = Math.max(0, Number(this.state.autoSkipDelaySec) || 0);

          this.overlay.showSkipPreview(
            delay,
            () => {
              this.skipTo(Math.max(...skipSegments.map((s) => s.end)), first.type, key);
              this.previewOpenForKey = null;
            },
            () => {
              this.previewBlockedKeys.add(key);
              this.previewOpenForKey = null;
            }
          );

          if (delay > 0) {
            setTimeout(() => {
              if (this.previewOpenForKey === key) {
                this.skipTo(Math.max(...skipSegments.map((s) => s.end)), first.type, key);
                this.overlay.clearSkipPreview();
                this.previewOpenForKey = null;
              }
            }, delay * 1000);
          }
        }

        this.applyEffects(false, false, false, false);
        return;
      }

      this.skipTo(Math.max(...skipSegments.map((s) => s.end)), first.type, key);
      this.applyEffects(false, false, false, false);
      return;
    }

    const mute = active.some((s) => this.getEffectiveAction(s) === "mute");
    const blur = this.manualBlur || active.some((s) => this.getEffectiveAction(s) === "blur");
    const speed = active.some((s) => this.getEffectiveAction(s) === "speed");
    const smart = active.some((s) => this.getEffectiveAction(s) === "smart");

    this.applyEffects(mute, blur, speed, smart);
  }

  skipTo(targetEnd, type, key) {
    const now = Date.now();
    if (this.lastSkipKey === key && now - this.lastSkipTs < 900) {
      return;
    }

    const seekTarget = Math.min(targetEnd + 0.05, this.video.duration || targetEnd + 0.05);
    if (typeof this.video.fastSeek === "function") {
      try {
        this.video.fastSeek(seekTarget);
      } catch (_error) {
        this.video.currentTime = seekTarget;
      }
    } else {
      this.video.currentTime = seekTarget;
    }

    this.lastSkipKey = key;
    this.lastSkipTs = now;
    this.overlay.banner(`Scene skipped (${type} content)`);
  }

  handleIncomingCountdown() {
    if (!this.state.enabled || this.autoSegments.length === 0) {
      this.lastCountdownSecond = null;
      return;
    }

    const t = this.video.currentTime;
    let nearest = null;
    for (const segment of this.autoSegments) {
      const action = this.getEffectiveAction(segment);
      if (action === "none") {
        continue;
      }

      const delta = segment.start - t;
      if (delta <= 0 || delta > 3.2) {
        continue;
      }
      if (!nearest || delta < nearest.delta) {
        nearest = { delta, segment };
      }
    }

    if (!nearest) {
      this.lastCountdownSecond = null;
      return;
    }

    const secondsLeft = Math.ceil(nearest.delta);
    const key = `${nearest.segment.start}-${secondsLeft}`;
    if (this.lastCountdownSecond !== key) {
      this.lastCountdownSecond = key;
      this.overlay.incomingCountdown(secondsLeft);
    }
  }

  pushPlaybackSnapshot() {
    const now = Date.now();
    if (now - this.lastSnapshotTs < SNAPSHOT_INTERVAL_MS) {
      return;
    }

    const duration = this.video.duration;
    const currentTime = this.video.currentTime;
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(currentTime)) {
      return;
    }

    this.lastSnapshotTs = now;
    api.runtime
      .sendMessage({
        type: "updatePlaybackSnapshot",
        payload: {
          currentTime,
          duration,
          url: window.location.href,
          title: document.title
        }
      })
      .catch(() => {});
  }

  submitHeuristicSegments(segments) {
    const movieId = this.selectedMovie?.imdbID;
    if (!movieId || !Array.isArray(segments) || segments.length === 0) {
      return;
    }

    api.runtime
      .sendMessage({
        type: "addHeuristicSegments",
        movieId,
        segments
      })
      .catch(() => {});
  }

  applyEffects(shouldMute, shouldBlur, shouldSpeed, shouldBlack) {
    if (shouldMute && !this.muting) {
      this.originalMuted = this.video.muted;
      this.video.muted = true;
      this.muting = true;
    } else if (!shouldMute && this.muting) {
      this.video.muted = this.originalMuted ?? false;
      this.originalMuted = null;
      this.muting = false;
    }

    if (shouldBlur && !this.blurring) {
      this.originalFilter = this.video.style.getPropertyValue("filter");
      this.originalFilterPriority = this.video.style.getPropertyPriority("filter");
      this.video.style.setProperty("filter", "blur(20px)", "important");
      this.video.style.setProperty("transition", "filter 120ms linear", "important");

      const wrapper = this.video.parentElement;
      if (wrapper instanceof HTMLElement) {
        this.originalWrapperFilter = wrapper.style.getPropertyValue("filter");
        this.originalWrapperFilterPriority = wrapper.style.getPropertyPriority("filter");
        wrapper.style.setProperty("filter", "blur(2px)", "important");
      }

      const root = this.overlay.ensureRoot();
      if (root) {
        const layer = document.createElement("div");
        layer.style.position = "absolute";
        layer.style.inset = "0";
        layer.style.pointerEvents = "none";
        layer.style.zIndex = "2147483645";
        layer.style.backdropFilter = "blur(14px)";
        layer.style.webkitBackdropFilter = "blur(14px)";
        // Even where backdrop-filter is unsupported, this dark mask still obscures content.
        layer.style.background = "rgba(22, 28, 40, 0.42)";
        layer.style.opacity = "0";
        layer.style.transition = "opacity 180ms ease";
        root.appendChild(layer);
        requestAnimationFrame(() => {
          layer.style.opacity = "1";
        });
        this.blurLayer = layer;
      }
      this.blurring = true;
    } else if (!shouldBlur && this.blurring) {
      if (this.originalFilter) {
        this.video.style.setProperty("filter", this.originalFilter, this.originalFilterPriority || "");
      } else {
        this.video.style.removeProperty("filter");
      }
      this.originalFilter = null;
      this.originalFilterPriority = "";
      this.video.style.removeProperty("transition");

      const wrapper = this.video.parentElement;
      if (wrapper instanceof HTMLElement) {
        if (this.originalWrapperFilter) {
          wrapper.style.setProperty("filter", this.originalWrapperFilter, this.originalWrapperFilterPriority || "");
        } else {
          wrapper.style.removeProperty("filter");
        }
      }
      this.originalWrapperFilter = null;
      this.originalWrapperFilterPriority = "";

      if (this.blurLayer?.isConnected) {
        const layer = this.blurLayer;
        layer.style.opacity = "0";
        setTimeout(() => {
          if (layer.isConnected) {
            layer.remove();
          }
        }, 220);
      }
      this.blurLayer = null;
      this.blurring = false;
    }

    if (shouldSpeed && !this.speeding) {
      this.originalPlaybackRate = this.video.playbackRate;
      this.video.playbackRate = 3;
      this.speeding = true;
    } else if (!shouldSpeed && this.speeding) {
      this.video.playbackRate = this.originalPlaybackRate || 1;
      this.originalPlaybackRate = null;
      this.speeding = false;
    }

    if (shouldBlack && !this.blacking) {
      const root = this.overlay.ensureRoot();
      if (root) {
        const layer = document.createElement("div");
        layer.style.position = "absolute";
        layer.style.inset = "0";
        layer.style.background = "#000";
        layer.style.opacity = "0";
        layer.style.transition = "opacity 220ms ease";
        layer.style.pointerEvents = "none";
        layer.style.zIndex = "2147483646";
        root.appendChild(layer);
        requestAnimationFrame(() => {
          layer.style.opacity = "1";
        });
        this.blackoutLayer = layer;
      }
      this.blacking = true;
    } else if (!shouldBlack && this.blacking) {
      if (this.blackoutLayer?.isConnected) {
        const layer = this.blackoutLayer;
        layer.style.opacity = "0";
        setTimeout(() => {
          if (layer.isConnected) {
            layer.remove();
          }
        }, 260);
      }
      this.blackoutLayer = null;
      this.blacking = false;
    }
  }

  resetAllEffects() {
    this.applyEffects(false, this.manualBlur, false, false);
  }

  findProgressElement() {
    const candidates = [
      ".ytp-progress-list",
      ".ytp-progress-bar-container",
      "input[type='range'][aria-label*='progress' i]",
      "input[type='range'][class*='progress' i]",
      ".ytp-progress-bar",
      ".vjs-progress-holder",
      ".jw-slider-time",
      ".plyr__progress",
      ".nf-player-progress",
      "[class*='progress'][class*='bar']"
    ];

    let best = null;
    let bestScore = -Infinity;

    for (const selector of candidates) {
      const all = document.querySelectorAll(selector);
      for (const element of all) {
        const isYoutubeProgress = selector.startsWith(".ytp-");
        const rect = element.getBoundingClientRect();
        if (isYoutubeProgress) {
          if (rect.width < 120 || rect.height < 2) {
            continue;
          }
        } else if (!isElementVisible(element)) {
          continue;
        }
        const videoRect = this.video.getBoundingClientRect();

        const widthRatio = rect.width / Math.max(videoRect.width, 1);
        const leftPenalty = Math.abs(rect.left - videoRect.left) / Math.max(videoRect.width, 1);
        const verticalDistance = Math.abs(rect.top - videoRect.bottom);

        const nearVideo = Math.abs(rect.left - videoRect.left) < videoRect.width && verticalDistance < 280;
        if (!nearVideo && !element.contains(this.video) && !this.video.contains(element)) {
          continue;
        }

        const score = widthRatio * 100 - leftPenalty * 20 - verticalDistance * 0.05;
        if (score > bestScore) {
          best = element;
          bestScore = score;
        }
      }
    }

    return best;
  }

  ensureMarkerLayer() {
    const progress = this.findProgressElement();
    const host = progress || this.video.parentElement;
    if (!host) {
      return null;
    }

    const style = window.getComputedStyle(host);
    if (style.position === "static") {
      host.style.position = "relative";
    }

    if (!this.markerLayer || !this.markerLayer.isConnected || this.markerLayer.parentElement !== host) {
      if (this.markerLayer?.isConnected) {
        this.markerLayer.remove();
      }
      const layer = document.createElement("div");
      layer.className = "sf-marker-layer";
      host.appendChild(layer);
      this.markerLayer = layer;
    }

    return this.markerLayer;
  }

  ensureFallbackTrack() {
    const wrapper = this.video.parentElement;
    if (!wrapper) {
      return null;
    }

    const style = window.getComputedStyle(wrapper);
    if (style.position === "static") {
      wrapper.style.position = "relative";
    }

    if (!this.fallbackTrack || !this.fallbackTrack.isConnected) {
      const layer = document.createElement("div");
      layer.className = "sf-marker-layer sf-fallback-track";
      wrapper.appendChild(layer);
      this.fallbackTrack = layer;
    }

    return this.fallbackTrack;
  }

  renderMarkers() {
    const duration = this.video.duration;
    const markerSegments =
      window.SceneSegmentUtils && typeof window.SceneSegmentUtils.segmentsForMarkers === "function"
        ? window.SceneSegmentUtils.segmentsForMarkers(this.state, this.allSegments, this.autoSegments)
        : this.allSegments;

    if (!this.state.enabled || !Number.isFinite(duration) || duration <= 0 || markerSegments.length === 0) {
      if (this.markerLayer) {
        this.markerLayer.innerHTML = "";
      }
      if (this.fallbackTrack) {
        this.fallbackTrack.innerHTML = "";
      }
      return;
    }

    const layer = this.ensureMarkerLayer();
    // Always render fallback markers to guarantee visibility across custom players.
    const fallback = this.ensureFallbackTrack();

    if (!layer && !fallback) {
      return;
    }

    if (layer) {
      layer.innerHTML = "";
    }
    if (fallback) {
      fallback.innerHTML = "";
    }

    for (const segment of markerSegments) {
      const startRatio = Math.max(0, Math.min(1, segment.start / duration));
      const endRatio = Math.max(0, Math.min(1, segment.end / duration));
      const sec = Math.max(1, Math.round(segment.end - segment.start));
      const conf = Number(segment.effective_confidence ?? segment.confidence_score ?? 0);
      const label = `${segment.type[0].toUpperCase() + segment.type.slice(1)} content (${sec}s, conf ${conf})`;

      if (layer) {
        const layerWidth = Math.max(layer.clientWidth, 1);
        const leftPx = startRatio * layerWidth;
        const widthPx = Math.max(1, (endRatio - startRatio) * layerWidth);
        const marker = document.createElement("div");
        marker.className = `sf-marker sf-marker-${segment.type}`;
        if (segment.source_type === "local_ai") {
          marker.classList.add("sf-marker-unverified");
        }
        marker.style.left = `${leftPx}px`;
        marker.style.width = `${widthPx}px`;
        marker.title = label;
        layer.appendChild(marker);
      }

      if (fallback) {
        const layerWidth = Math.max(fallback.clientWidth, 1);
        const leftPx = startRatio * layerWidth;
        const widthPx = Math.max(1, (endRatio - startRatio) * layerWidth);
        const marker = document.createElement("div");
        marker.className = `sf-marker sf-marker-${segment.type}`;
        if (segment.source_type === "local_ai") {
          marker.classList.add("sf-marker-unverified");
        }
        marker.style.left = `${leftPx}px`;
        marker.style.width = `${widthPx}px`;
        marker.title = label;
        fallback.appendChild(marker);
      }
    }

  }

  handleShortcut(event) {
    if (!this.state.enabled || event.defaultPrevented) {
      return;
    }
    const tag = event.target?.tagName?.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || event.target?.isContentEditable) {
      return;
    }

    const key = String(event.key || "").toLowerCase();
    if (key === "s") {
      const active = this.activeSegmentsAt(this.video.currentTime);
      if (active.length > 0) {
        const target = Math.max(...active.map((s) => s.end));
        this.skipTo(target, active[0].type, `shortcut-${active[0].start}`);
      }
    } else if (key === "b") {
      this.manualBlur = !this.manualBlur;
      this.overlay.banner(`Shortcut: blur ${this.manualBlur ? "on" : "off"}`);
      this.applyEffects(this.muting, this.manualBlur || this.blurring, this.speeding, this.blacking);
    } else if (key === "l") {
      const movieId = this.selectedMovie?.imdbID;
      if (!movieId) {
        this.overlay.banner("Shortcut: select movie first");
        return;
      }
      const t = this.video.currentTime;
      api.runtime
        .sendMessage({
          type: "addUserSegment",
          movieId,
          segment: {
            start: t,
            end: t + 8,
            type: "sexual",
            confidence_score: 90,
            source_type: "manual"
          }
        })
        .then((res) => {
          if (res?.ok) {
            this.overlay.banner("Shortcut: local segment added");
            this.refreshState().catch(() => {});
          }
        })
        .catch(() => {});
    }
  }
}

function attachVideo(video) {
  if (!video || controllers.has(video)) {
    return;
  }

  const controller = new SceneController(video);
  controllers.set(video, controller);
  controller.init().catch((error) => {
    console.error("SceneFilter controller init failed", error);
  });
}

function cleanupDetachedVideos() {
  for (const [video, controller] of controllers.entries()) {
    if (!document.contains(video)) {
      controller.destroy();
      controllers.delete(video);
    }
  }
}

function scanNodeForVideos(node) {
  if (!node || !(node instanceof Element)) {
    return;
  }

  if (node.tagName === "VIDEO") {
    attachVideo(node);
  }
  node.querySelectorAll?.("video").forEach(attachVideo);

  if (node.shadowRoot) {
    observeRoot(node.shadowRoot);
    node.shadowRoot.querySelectorAll("video").forEach(attachVideo);
  }

  const descendants = node.querySelectorAll?.("*") || [];
  for (const el of descendants) {
    if (el.shadowRoot) {
      observeRoot(el.shadowRoot);
      el.shadowRoot.querySelectorAll("video").forEach(attachVideo);
    }
  }
}

function observeRoot(root) {
  if (!root || observedRoots.has(root)) {
    return;
  }
  observedRoots.add(root);

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        scanNodeForVideos(node);
      }
    }
    cleanupDetachedVideos();
  });

  observer.observe(root, {
    childList: true,
    subtree: true
  });
}

async function maybeAutoDetectMovieFromPage() {
  if (window !== window.top) {
    return;
  }

  try {
    await api.runtime.sendMessage({
      type: "autoDetectFromPageContext",
      payload: {
        url: window.location.href,
        title: document.title
      }
    });
  } catch (_error) {}
}

function observeVideos() {
  scanNodeForVideos(document.documentElement);
  observeRoot(document.documentElement);
  window.setInterval(cleanupDetachedVideos, 5000);
}

api.storage.onChanged.addListener((_changes, area) => {
  if (area !== "local") {
    return;
  }
  controllers.forEach((controller) => {
    controller.refreshState().catch(() => {});
  });
});

injectContentStyles();
observeVideos();
maybeAutoDetectMovieFromPage();
