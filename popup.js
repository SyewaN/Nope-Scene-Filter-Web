const api = typeof browser !== "undefined" ? browser : chrome;

const DEFAULT_ACTIONS = {
  sexual: "skip",
  nudity: "blur"
};
const COMMUNITY_REPO_URL = "https://github.com/SceneFilterCommunity/scenefilter-db";
const I18N = {
  tr: {
    enabled: "Etkin",
    movie_select: "Film Sec",
    detect_page: "Sayfadan Algila",
    search: "Ara",
    filter_modes: "Filtre Modlari",
    sexual: "Cinsellik",
    nudity: "Nudity",
    segments: "Segmentler",
    manual_marking: "Manuel Isaretleme",
    mark_start: "Baslangic Isaretle",
    mark_end: "Bitis Isaretle",
    add_local: "Locale Ekle",
    local_db: "Local DB"
  },
  en: {
    enabled: "Enabled",
    movie_select: "Select Movie",
    detect_page: "Detect Page",
    search: "Search",
    filter_modes: "Filter Modes",
    sexual: "Sexual",
    nudity: "Nudity",
    segments: "Segments",
    manual_marking: "Manual Marking",
    mark_start: "Mark Start",
    mark_end: "Mark End",
    add_local: "Add Local",
    local_db: "Local DB"
  }
};

let currentMovie = null;
let currentLanguage = "tr";

function t(key) {
  return I18N[currentLanguage]?.[key] || I18N.en[key] || key;
}

function applyLanguage(lang) {
  currentLanguage = ["tr", "en"].includes(lang) ? lang : "en";
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    el.textContent = t(key);
  });
}

function formatSecond(second) {
  const total = Math.max(0, Math.floor(Number(second) || 0));
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function statusMessage(text, isError = false) {
  const status = document.getElementById("status");
  status.textContent = text;
  status.classList.toggle("error", isError);

  window.clearTimeout(status._timer);
  status._timer = window.setTimeout(() => {
    status.textContent = "";
    status.classList.remove("error");
  }, 3500);
}

function sourceLabel(sourceType) {
  if (sourceType === "manual") {
    return "MANUAL";
  }
  if (sourceType === "community") {
    return "COMMUNITY";
  }
  if (sourceType === "local_ai") {
    return "AI";
  }
  return "UNKNOWN";
}

async function removeLocalSegment(userIndex) {
  if (!currentMovie?.imdbID) {
    statusMessage("No selected movie.", true);
    return;
  }

  const response = await api.runtime.sendMessage({
    type: "removeUserSegment",
    movieId: currentMovie.imdbID,
    userIndex
  });

  if (!response?.ok) {
    statusMessage(response?.error || "Failed to remove local segment", true);
    return;
  }

  renderSegments(response.segments || [], response.source || "unknown", response.autoSegments || []);
  statusMessage("Local segment removed");
}

function renderSegments(segments, source = "unknown", autoSegments = []) {
  const list = document.getElementById("segmentList");
  const meta = document.getElementById("segmentMeta");
  list.innerHTML = "";

  const sourceText =
    source && source.startsWith("community")
      ? `Community DB (${source})`
      : source === "local-bundled"
        ? "Local bundled DB"
        : source || "Unknown source";

  const autoIds = new Set((autoSegments || []).map((s) => s.segment_id));
  const localOnly = (segments || []).filter((s) => s.source === "local-user");

  if (!localOnly || localOnly.length === 0) {
    const total = Array.isArray(segments) ? segments.length : 0;
    meta.textContent = `No local segments yet (${sourceText}, total ${total})`;
    const li = document.createElement("li");
    li.className = "result-empty";
    li.textContent = "No local segments. Add with Mark Start / Mark End.";
    list.appendChild(li);
    return;
  }

  meta.textContent = `Local segments: ${localOnly.length} (${sourceText})`;

  for (const segment of localOnly) {
    const li = document.createElement("li");
    li.className = "segment-item";

    const type = (segment.type || "unknown").toUpperCase();
    const text = document.createElement("span");
    const confidence = Number(segment.effective_confidence ?? segment.confidence_score ?? 0);
    const applyTag = autoIds.has(segment.segment_id) ? "auto" : "off";
    text.textContent = `${type} - ${formatSecond(segment.start)} to ${formatSecond(segment.end)} | conf ${confidence} | ${applyTag}`;

    const badge = document.createElement("span");
    badge.className = `segment-badge ${segment.source_type === "manual" ? "local" : "remote"}`;
    badge.textContent = sourceLabel(segment.source_type);

    li.appendChild(text);
    li.appendChild(badge);

    if (segment.source_type === "local_ai") {
      const uv = document.createElement("span");
      uv.className = "segment-badge remote";
      uv.textContent = "UNVERIFIED";
      li.appendChild(uv);
    }

    if (segment.source === "local-user" && Number.isInteger(segment.userIndex)) {
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "mini danger";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", async () => {
        await removeLocalSegment(segment.userIndex);
      });
      li.appendChild(removeBtn);
    }

    list.appendChild(li);
  }
}

function renderResults(items) {
  const results = document.getElementById("results");
  results.innerHTML = "";

  if (!items || items.length === 0) {
    const li = document.createElement("li");
    li.className = "result-empty";
    li.textContent = "No movies found";
    results.appendChild(li);
    return;
  }

  for (const item of items) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "result-button";
    button.textContent = `${item.title} (${item.year})`;

    button.addEventListener("click", async () => {
      await selectMovie(item.imdbID, item.title, item.year);
      results.innerHTML = "";
    });

    li.appendChild(button);
    results.appendChild(li);
  }
}

async function selectMovie(imdbID, title, year) {
  const response = await api.runtime.sendMessage({
    type: "selectMovie",
    movie: { imdbID, title, year }
  });

  if (!response?.ok) {
    statusMessage(response?.error || "Failed to select movie", true);
    return false;
  }

  currentMovie = { imdbID, title, year };
  document.getElementById("selectedMovie").textContent = `Selected: ${title} (${year}) - ${imdbID}`;
  renderSegments(response.segments || [], response.source || "unknown", response.autoSegments || []);
  statusMessage(`Movie selected (${response.segments?.length || 0} segments loaded)`);
  return true;
}

async function detectMovieFromCurrentPage(showStatus = true) {
  const detectInfo = document.getElementById("detectInfo");
  detectInfo.textContent = "Detecting movie from active tab...";

  const response = await api.runtime.sendMessage({ type: "detectMovieFromActiveTab" });
  if (!response?.ok || !response.movie) {
    detectInfo.textContent = "Auto-detect failed. Select manually below.";
    if (showStatus) {
      statusMessage(response?.error || "Auto-detect failed", true);
    }
    return false;
  }

  const movie = response.movie;
  currentMovie = movie;
  document.getElementById("selectedMovie").textContent = `Selected: ${movie.title} (${movie.year}) - ${movie.imdbID}`;
  renderSegments(response.segments || [], response.source || "unknown", response.autoSegments || []);
  detectInfo.textContent = `Detected from page: "${response.detectionQuery}" (score ${response.score})`;
  if (showStatus) {
    statusMessage(`Auto-detected: ${movie.title}`);
  }
  return true;
}

async function getPlaybackNow() {
  const response = await api.runtime.sendMessage({ type: "getPlaybackSnapshotActiveTab" });
  if (!response?.ok || !response.snapshot) {
    statusMessage(response?.error || "No video playback snapshot.", true);
    return null;
  }
  return response.snapshot;
}

async function saveSettings() {
  const payload = {
    enabled: document.getElementById("enabledToggle").checked,
    language: document.getElementById("languageSelect").value,
    adaptiveMode: document.getElementById("adaptiveModeToggle").checked,
    audioOnlyMode: document.getElementById("audioOnlyModeToggle").checked,
    safeMode: document.getElementById("safeModeSelect").value,
    confidenceThreshold: Number(document.getElementById("confidenceThresholdInput").value),
    previewBeforeSkip: document.getElementById("previewToggle").checked,
    autoSkipDelaySec: Number(document.getElementById("autoSkipDelayInput").value),
    debugMode: document.getElementById("debugModeToggle").checked,
    communitySyncEnabled: document.getElementById("communitySyncToggle").checked,
    metadataLookupEnabled: document.getElementById("metadataLookupToggle").checked,
    categoryActions: {
      sexual: document.getElementById("actionSexual").value,
      nudity: document.getElementById("actionNudity").value
    }
  };

  const response = await api.runtime.sendMessage({ type: "saveSettings", payload });
  if (!response?.ok) {
    statusMessage(response?.error || "Failed to save settings", true);
    return;
  }

  statusMessage("Settings saved");
}

async function addLocalSegmentFromForm() {
  if (!currentMovie?.imdbID) {
    statusMessage("Select movie first.", true);
    return;
  }

  const start = Number(document.getElementById("segmentStart").value);
  const end = Number(document.getElementById("segmentEnd").value);
  const type = document.getElementById("contribType").value;

  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    statusMessage("Enter valid start/end seconds.", true);
    return;
  }
  if (end <= start) {
    statusMessage("End must be greater than start.", true);
    return;
  }

  const response = await api.runtime.sendMessage({
    type: "addUserSegment",
    movieId: currentMovie.imdbID,
    segment: { start, end, type, confidence_score: 95, source_type: "manual" }
  });

  if (!response?.ok) {
    statusMessage(response?.error || "Failed to add local segment", true);
    return;
  }

  renderSegments(response.segments || [], response.source || "unknown", response.autoSegments || []);
  statusMessage("Local segment added and active");
}

function downloadJson(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function exportLocalDb() {
  const response = await api.runtime.sendMessage({ type: "exportLocalDb" });
  if (!response?.ok || !response.payload) {
    statusMessage(response?.error || "Export failed", true);
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  downloadJson(`nsfw-local-segments-${stamp}.json`, response.payload);
  statusMessage("Local DB exported");
}

async function importLocalDbFromFile(file) {
  if (!file) {
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch (_error) {
    statusMessage("Invalid JSON file", true);
    return;
  }

  const strategy = document.getElementById("mergeStrategySelect").value;
  const response = await api.runtime.sendMessage({
    type: "importLocalDb",
    payload: parsed,
    strategy
  });

  if (!response?.ok) {
    statusMessage(response?.error || "Import failed", true);
    return;
  }

  await loadState();
  const s = response.summary || {};
  statusMessage(`Import done: +${s.added || 0}, replaced ${s.replaced || 0}, skipped ${s.skipped || 0}`);
}

async function copyMovieJsonForPr() {
  if (!currentMovie?.imdbID) {
    statusMessage("Select movie first.", true);
    return;
  }

  const response = await api.runtime.sendMessage({
    type: "getLocalSegmentsForMovie",
    movieId: currentMovie.imdbID
  });
  if (!response?.ok) {
    statusMessage(response?.error || "Cannot read local segments", true);
    return;
  }

  const payload = {
    id: currentMovie.imdbID,
    segments: response.segments || []
  };

  try {
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    statusMessage("Movie JSON copied for PR");
  } catch (_error) {
    statusMessage("Clipboard failed. Try again.", true);
  }
}

async function loadState() {
  const response = await api.runtime.sendMessage({ type: "getState" });
  if (!response?.ok) {
    statusMessage(response?.error || "Failed to load state", true);
    return;
  }

  const state = response.state;
  currentMovie = state.selectedMovie || null;
  currentLanguage = state.language || "tr";

  document.getElementById("enabledToggle").checked = !!state.enabled;
  document.getElementById("languageSelect").value = currentLanguage;
  applyLanguage(currentLanguage);
  document.getElementById("adaptiveModeToggle").checked = !!state.adaptiveMode;
  document.getElementById("audioOnlyModeToggle").checked = !!state.audioOnlyMode;
  document.getElementById("safeModeSelect").value = state.safeMode || "MEDIUM";
  document.getElementById("confidenceThresholdInput").value = state.confidenceThreshold ?? 70;
  document.getElementById("previewToggle").checked = !!state.previewBeforeSkip;
  document.getElementById("autoSkipDelayInput").value = state.autoSkipDelaySec ?? 2;
  document.getElementById("debugModeToggle").checked = !!state.debugMode;
  document.getElementById("communitySyncToggle").checked = !!state.communitySyncEnabled;
  document.getElementById("metadataLookupToggle").checked = !!state.metadataLookupEnabled;

  document.getElementById("actionSexual").value = state.categoryActions?.sexual || DEFAULT_ACTIONS.sexual;
  document.getElementById("actionNudity").value = state.categoryActions?.nudity || DEFAULT_ACTIONS.nudity;

  if (currentMovie) {
    document.getElementById("selectedMovie").textContent = `Selected: ${currentMovie.title} (${currentMovie.year}) - ${currentMovie.imdbID}`;
  }

  renderSegments(response.segments || [], response.source || "unknown", response.autoSegments || []);
  const detectInfo = document.getElementById("detectInfo");
  detectInfo.textContent = response.metadata?.potential_sensitive
    ? "IMDb metadata: potentially sensitive"
    : "Auto-detect uses page URL and title.";

  if (!currentMovie) {
    await detectMovieFromCurrentPage(false);
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  await loadState();

  [
    "enabledToggle",
    "adaptiveModeToggle",
    "audioOnlyModeToggle",
    "safeModeSelect",
    "confidenceThresholdInput",
    "previewToggle",
    "autoSkipDelayInput",
    "debugModeToggle",
    "communitySyncToggle",
    "metadataLookupToggle",
    "actionSexual",
    "actionNudity"
  ].forEach((id) => {
    document.getElementById(id).addEventListener("change", saveSettings);
  });

  document.getElementById("languageSelect").addEventListener("change", async (event) => {
    applyLanguage(event.target.value);
    await saveSettings();
  });

  document.getElementById("searchForm").addEventListener("submit", async (event) => {
    event.preventDefault();

    const query = document.getElementById("searchInput").value.trim();
    if (!query) {
      statusMessage("Enter a movie title", true);
      return;
    }

    const results = document.getElementById("results");
    results.innerHTML = "<li class='result-empty'>Searching...</li>";

    const response = await api.runtime.sendMessage({ type: "searchMovies", query });
    if (!response?.ok) {
      renderResults([]);
      statusMessage(response?.error || "Search failed", true);
      return;
    }

    renderResults(response.results || []);
  });

  document.getElementById("detectButton").addEventListener("click", async () => {
    await detectMovieFromCurrentPage(true);
  });

  document.getElementById("setStartNow").addEventListener("click", async () => {
    const snapshot = await getPlaybackNow();
    if (!snapshot) {
      return;
    }
    document.getElementById("segmentStart").value = snapshot.currentTime.toFixed(1);
    statusMessage(`Start marked: ${formatSecond(snapshot.currentTime)}`);
  });

  document.getElementById("setEndNow").addEventListener("click", async () => {
    const snapshot = await getPlaybackNow();
    if (!snapshot) {
      return;
    }
    document.getElementById("segmentEnd").value = snapshot.currentTime.toFixed(1);
    statusMessage(`End marked: ${formatSecond(snapshot.currentTime)}`);
  });

  document.getElementById("addSegmentButton").addEventListener("click", async () => {
    await addLocalSegmentFromForm();
  });

  document.getElementById("exportLocalDbButton").addEventListener("click", async () => {
    await exportLocalDb();
  });

  document.getElementById("importLocalDbButton").addEventListener("click", () => {
    document.getElementById("importLocalDbFile").click();
  });

  document.getElementById("importLocalDbFile").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    await importLocalDbFromFile(file);
    event.target.value = "";
  });

  document.getElementById("openRepoButton").addEventListener("click", async () => {
    await api.tabs.create({ url: COMMUNITY_REPO_URL });
  });

  document.getElementById("copyMovieJsonButton").addEventListener("click", async () => {
    await copyMovieJsonForPr();
  });
});
