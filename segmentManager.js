(() => {
  const SAFE_MODE_THRESHOLDS = {
    OFF: 101,
    LIGHT: 85,
    MEDIUM: 70,
    STRICT: 45
  };

  function thresholdForState(state) {
    const safeMode = String(state?.safeMode || "MEDIUM").toUpperCase();
    const base = SAFE_MODE_THRESHOLDS[safeMode] ?? SAFE_MODE_THRESHOLDS.MEDIUM;
    const custom = Number(state?.confidenceThreshold);
    if (!Number.isFinite(custom)) {
      return base;
    }
    return Math.max(base, Math.max(0, Math.min(100, custom)));
  }

  function effectiveActionForSegment(segment, state, categoryActions) {
    const raw = categoryActions?.[segment.type] || "none";
    let action = raw;

    if (state.audioOnlyMode && action === "blur") {
      action = "mute";
    }

    if (state.adaptiveMode && action === "skip") {
      const duration = Number(segment.end) - Number(segment.start);
      if (duration > 0 && duration < 3) {
        action = "speed";
      }
    }

    return action;
  }

  function segmentsForMarkers(state, allSegments, autoSegments) {
    if (state?.debugMode) {
      return allSegments;
    }
    return autoSegments;
  }

  window.SceneSegmentUtils = {
    thresholdForState,
    effectiveActionForSegment,
    segmentsForMarkers
  };
})();
