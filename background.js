const api = typeof browser !== "undefined" ? browser : chrome;

const PUBLIC_OMDB_KEY = "thewdb";
const USER_SEGMENTS_KEY = "userSegmentsByMovieId";
const AI_SEGMENTS_KEY = "localAiSegmentsByMovieId";
const LOCAL_DB_SCHEMA = "nsfw.localdb.v2";

const COMMUNITY_SEGMENT_SOURCES = [
  {
    name: "community-raw",
    url: "https://raw.githubusercontent.com/SceneFilterCommunity/scenefilter-db/main/segments.json"
  },
  {
    name: "community-jsdelivr",
    url: "https://cdn.jsdelivr.net/gh/SceneFilterCommunity/scenefilter-db@main/segments.json"
  }
];

const SAFE_MODE_THRESHOLDS = {
  OFF: 101,
  LIGHT: 85,
  MEDIUM: 70,
  STRICT: 45
};

const DEFAULT_STATE = {
  enabled: true,
  autoDetect: true,
  language: "tr",
  adaptiveMode: true,
  audioOnlyMode: false,
  safeMode: "MEDIUM",
  confidenceThreshold: 70,
  debugMode: true,
  previewBeforeSkip: true,
  autoSkipDelaySec: 2,
  communitySyncEnabled: false,
  metadataLookupEnabled: false,
  categoryActions: {
    sexual: "skip",
    nudity: "blur"
  },
  selectedMovie: null
};

let localDbCache = null;
let remoteDbCache = null;
let localDbLoadedAt = 0;
let remoteDbLoadedAt = 0;
let segmentDbSource = "none";
const playbackSnapshotsByTab = new Map();
const metadataCache = new Map();

async function ensureDefaults() {
  const existing = await api.storage.local.get([...Object.keys(DEFAULT_STATE), USER_SEGMENTS_KEY, AI_SEGMENTS_KEY]);
  const updates = {};

  for (const key of Object.keys(DEFAULT_STATE)) {
    if (typeof existing[key] === "undefined") {
      updates[key] = DEFAULT_STATE[key];
    }
  }
  if (typeof existing[USER_SEGMENTS_KEY] === "undefined") {
    updates[USER_SEGMENTS_KEY] = {};
  }
  if (typeof existing[AI_SEGMENTS_KEY] === "undefined") {
    updates[AI_SEGMENTS_KEY] = {};
  }

  if (Object.keys(updates).length > 0) {
    await api.storage.local.set(updates);
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${url} failed (${response.status})`);
  }
  return await response.json();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeState(state) {
  const safeModeRaw = String(state.safeMode || DEFAULT_STATE.safeMode).toUpperCase();
  const safeMode = SAFE_MODE_THRESHOLDS[safeModeRaw] != null ? safeModeRaw : DEFAULT_STATE.safeMode;

  return {
    enabled: typeof state.enabled === "boolean" ? state.enabled : DEFAULT_STATE.enabled,
    autoDetect: typeof state.autoDetect === "boolean" ? state.autoDetect : DEFAULT_STATE.autoDetect,
    language: ["tr", "en"].includes(String(state.language || "").toLowerCase())
      ? String(state.language).toLowerCase()
      : DEFAULT_STATE.language,
    adaptiveMode: typeof state.adaptiveMode === "boolean" ? state.adaptiveMode : DEFAULT_STATE.adaptiveMode,
    audioOnlyMode: typeof state.audioOnlyMode === "boolean" ? state.audioOnlyMode : DEFAULT_STATE.audioOnlyMode,
    safeMode,
    confidenceThreshold: clamp(Number(state.confidenceThreshold) || DEFAULT_STATE.confidenceThreshold, 0, 100),
    debugMode: typeof state.debugMode === "boolean" ? state.debugMode : DEFAULT_STATE.debugMode,
    previewBeforeSkip: typeof state.previewBeforeSkip === "boolean" ? state.previewBeforeSkip : DEFAULT_STATE.previewBeforeSkip,
    autoSkipDelaySec: clamp(Number(state.autoSkipDelaySec) || DEFAULT_STATE.autoSkipDelaySec, 0, 10),
    communitySyncEnabled:
      typeof state.communitySyncEnabled === "boolean" ? state.communitySyncEnabled : DEFAULT_STATE.communitySyncEnabled,
    metadataLookupEnabled:
      typeof state.metadataLookupEnabled === "boolean" ? state.metadataLookupEnabled : DEFAULT_STATE.metadataLookupEnabled,
    categoryActions: {
      sexual: state.categoryActions?.sexual || DEFAULT_STATE.categoryActions.sexual,
      nudity: state.categoryActions?.nudity || DEFAULT_STATE.categoryActions.nudity
    },
    selectedMovie: state.selectedMovie || null
  };
}

function normalizeSegment(input, defaults = {}) {
  const start = Number(input?.start);
  const end = Number(input?.end);
  const type = String(input?.type || "").toLowerCase();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null;
  }
  if (!["sexual", "nudity"].includes(type)) {
    return null;
  }

  const sourceType = String(input?.source_type || defaults.source_type || "manual").toLowerCase();
  const source = String(input?.source || defaults.source || sourceType || "manual");
  const confidenceBase = Number(input?.confidence_score);

  const confidence_score = clamp(
    Number.isFinite(confidenceBase)
      ? confidenceBase
      : sourceType === "community"
        ? 80
        : sourceType === "local_ai"
          ? 45
          : 95,
    0,
    100
  );

  return {
    start: Math.round(start * 1000) / 1000,
    end: Math.round(end * 1000) / 1000,
    type,
    source,
    source_type: sourceType,
    confidence_score,
    confirmations: clamp(Number(input?.confirmations) || 0, 0, 1000),
    votes_up: clamp(Number(input?.votes_up) || 0, 0, 100000),
    votes_down: clamp(Number(input?.votes_down) || 0, 0, 100000),
    reports: clamp(Number(input?.reports) || 0, 0, 100000),
    reliability_weight: clamp(Number(input?.reliability_weight) || 1, 0, 5),
    unverified: Boolean(input?.unverified) || sourceType === "local_ai"
  };
}

function parseSegments(rawSegments, defaults) {
  return (Array.isArray(rawSegments) ? rawSegments : [])
    .map((s) => normalizeSegment(s, defaults))
    .filter(Boolean);
}

function segmentKey(s) {
  return `${s.type}|${s.start.toFixed(3)}|${s.end.toFixed(3)}|${s.source_type}`;
}

function segmentsEqual(a, b) {
  return a.type === b.type && Math.abs(a.start - b.start) < 0.01 && Math.abs(a.end - b.end) < 0.01;
}

function segmentsConflict(a, b) {
  if (a.type !== b.type) {
    return false;
  }
  return a.start < b.end && b.start < a.end;
}

function computeEffectiveConfidence(segment) {
  let score = Number(segment.confidence_score) || 0;

  if (segment.source_type === "community") {
    score += Math.min(segment.confirmations * 3, 15);
    score += Math.min((segment.votes_up - segment.votes_down) * 2, 20);
    score -= Math.min(segment.reports * 12, 60);
    if (segment.confirmations < 2) {
      score -= 12;
    }
    if (segment.votes_up + segment.votes_down < 2) {
      score -= 8;
    }
  }

  if (segment.source_type === "local_ai") {
    score -= 5;
  }

  if (segment.reports >= 3) {
    score = 0;
  }

  return clamp(Math.round(score), 0, 100);
}

function shouldIgnoreByTrust(segment) {
  if (segment.reports >= 3) {
    return true;
  }
  if (segment.source_type === "community" && segment.votes_down > segment.votes_up + 2) {
    return true;
  }
  return false;
}

function applyTrustMetrics(segments) {
  return segments
    .map((s) => {
      const effective_confidence = computeEffectiveConfidence(s);
      const ignored_by_trust = shouldIgnoreByTrust(s);
      return {
        ...s,
        effective_confidence,
        ignored_by_trust,
        segment_id: segmentKey(s)
      };
    })
    .filter((s) => !s.ignored_by_trust);
}

function getThresholdByState(state) {
  if (state.safeMode === "OFF") {
    return 101;
  }
  const modeThreshold = SAFE_MODE_THRESHOLDS[state.safeMode] ?? SAFE_MODE_THRESHOLDS.MEDIUM;
  const userThreshold = clamp(Number(state.confidenceThreshold) || modeThreshold, 0, 100);
  return Math.max(modeThreshold, userThreshold);
}

function filterAutoApplySegments(segments, state) {
  if (state.safeMode === "OFF") {
    return [];
  }
  const threshold = getThresholdByState(state);
  return segments.filter((s) => s.effective_confidence >= threshold);
}

function normalizeRecords(parsed) {
  const records = Array.isArray(parsed) ? parsed : [];
  return records
    .filter((entry) => typeof entry?.id === "string")
    .map((entry) => ({
      id: entry.id,
      segments: Array.isArray(entry.segments) ? entry.segments : []
    }));
}

async function loadLocalBundledDb() {
  const cacheIsFresh = localDbCache && Date.now() - localDbLoadedAt < 5 * 60 * 1000;
  if (cacheIsFresh) {
    segmentDbSource = "local-bundled";
    return localDbCache;
  }

  const localUrl = api.runtime.getURL("segments.json");
  const localData = await fetchJson(localUrl);
  const records = normalizeRecords(localData);
  localDbCache = new Map(records.map((entry) => [entry.id, entry]));
  localDbLoadedAt = Date.now();
  segmentDbSource = "local-bundled";
  return localDbCache;
}

async function loadCommunityDb() {
  const cacheIsFresh = remoteDbCache && Date.now() - remoteDbLoadedAt < 5 * 60 * 1000;
  if (cacheIsFresh) {
    return remoteDbCache;
  }

  for (const source of COMMUNITY_SEGMENT_SOURCES) {
    try {
      const parsed = await fetchJson(source.url);
      const records = normalizeRecords(parsed);
      if (records.length > 0) {
        remoteDbCache = new Map(records.map((entry) => [entry.id, entry]));
        remoteDbLoadedAt = Date.now();
        segmentDbSource = source.name;
        return remoteDbCache;
      }
    } catch (error) {
      console.warn(`SceneFilter: ${source.name} unavailable`, error?.message || error);
    }
  }

  return null;
}

async function getRemoteSegmentsByMovieId(movieId, communitySyncEnabled) {
  if (!movieId) {
    return [];
  }

  if (communitySyncEnabled) {
    const db = await loadCommunityDb();
    const match = db?.get(movieId);
    if (match?.segments?.length) {
      return parseSegments(match.segments, { source_type: "community", source: segmentDbSource });
    }
  }

  const fallback = await loadLocalBundledDb();
  const match = fallback.get(movieId);
  return parseSegments(match?.segments || [], { source_type: "community", source: segmentDbSource });
}

function sanitizeSegmentMap(rawMap, defaults = {}) {
  const map = typeof rawMap === "object" && rawMap ? rawMap : {};
  const output = {};
  for (const [movieId, rawSegments] of Object.entries(map)) {
    if (typeof movieId !== "string" || movieId.trim() === "") {
      continue;
    }
    const normalized = parseSegments(rawSegments, defaults).sort((a, b) => a.start - b.start || a.end - b.end);
    if (normalized.length > 0) {
      output[movieId] = normalized;
    }
  }
  return output;
}

async function getUserSegmentMap() {
  const raw = await api.storage.local.get(USER_SEGMENTS_KEY);
  return sanitizeSegmentMap(raw[USER_SEGMENTS_KEY], { source_type: "manual", source: "local-user" });
}

async function getAiSegmentMap() {
  const raw = await api.storage.local.get(AI_SEGMENTS_KEY);
  return sanitizeSegmentMap(raw[AI_SEGMENTS_KEY], { source_type: "local_ai", source: "local-ai", unverified: true });
}

async function getMergedSegmentsByMovieId(movieId, state) {
  if (!movieId) {
    return [];
  }

  const remoteSegments = await getRemoteSegmentsByMovieId(movieId, state.communitySyncEnabled);
  const userMap = await getUserSegmentMap();
  const aiMap = await getAiSegmentMap();

  const userSegments = userMap[movieId] || [];
  const aiSegments = aiMap[movieId] || [];

  const all = [...remoteSegments, ...userSegments, ...aiSegments];
  const dedup = new Map();
  for (const segment of all) {
    const key = segmentKey(segment);
    if (!dedup.has(key)) {
      dedup.set(key, segment);
    }
  }

  return applyTrustMetrics(Array.from(dedup.values())).sort((a, b) => a.start - b.start || a.end - b.end);
}

async function getMetadataTag(movieId, enabled) {
  if (!movieId || !enabled) {
    return { potential_sensitive: false, source: "disabled" };
  }

  const cached = metadataCache.get(movieId);
  if (cached && Date.now() - cached.loadedAt < 24 * 60 * 60 * 1000) {
    return cached.value;
  }

  const url = `https://www.imdb.com/title/${movieId}/parentalguide`;
  let value = { potential_sensitive: false, source: "imdb-parentalguide", hint: "unavailable" };
  try {
    const response = await fetch(url, { cache: "no-store", headers: { "accept-language": "en-US,en;q=0.9" } });
    if (response.ok) {
      const html = (await response.text()).toLowerCase();
      const count =
        (html.match(/nudity|sex|sexual|topless|breast|intercourse|erotic|genital/g) || []).length;
      value = {
        potential_sensitive: count >= 5,
        source: "imdb-parentalguide",
        hint: count >= 5 ? "keywords_detected" : "low_keyword_count"
      };
    }
  } catch (_error) {
    value = { potential_sensitive: false, source: "imdb-parentalguide", hint: "fetch_failed" };
  }

  metadataCache.set(movieId, { loadedAt: Date.now(), value });
  return value;
}

async function getStatePayload() {
  const raw = await api.storage.local.get([...Object.keys(DEFAULT_STATE), USER_SEGMENTS_KEY, AI_SEGMENTS_KEY]);
  const state = normalizeState(raw);
  const movieId = state.selectedMovie?.imdbID || null;
  const segments = await getMergedSegmentsByMovieId(movieId, state);
  const autoSegments = filterAutoApplySegments(segments, state);
  const metadata = await getMetadataTag(movieId, state.metadataLookupEnabled);

  return {
    ok: true,
    state,
    segments,
    autoSegments,
    source: segmentDbSource,
    metadata,
    threshold: getThresholdByState(state)
  };
}

function mergeSegmentsForMovie(existing, incoming, strategy) {
  const base = [...existing];
  let added = 0;
  let replaced = 0;
  let skipped = 0;

  for (const seg of incoming) {
    const dup = base.some((item) => segmentsEqual(item, seg));
    if (dup) {
      skipped += 1;
      continue;
    }

    const conflictIndexes = [];
    for (let i = 0; i < base.length; i += 1) {
      if (segmentsConflict(base[i], seg)) {
        conflictIndexes.push(i);
      }
    }

    if (strategy === "prefer-existing" && conflictIndexes.length > 0) {
      skipped += 1;
      continue;
    }

    if (strategy === "prefer-imported" && conflictIndexes.length > 0) {
      for (let i = conflictIndexes.length - 1; i >= 0; i -= 1) {
        base.splice(conflictIndexes[i], 1);
        replaced += 1;
      }
    }

    base.push(seg);
    added += 1;
  }

  base.sort((a, b) => a.start - b.start || a.end - b.end);
  return { segments: base, added, replaced, skipped };
}

async function addUserSegment(movieId, segment) {
  if (!movieId) {
    return { ok: false, error: "No movie selected." };
  }

  const normalized = normalizeSegment(segment, { source_type: "manual", source: "local-user" });
  if (!normalized) {
    return { ok: false, error: "Invalid segment range or type." };
  }

  const map = await getUserSegmentMap();
  const current = map[movieId] || [];
  const duplicate = current.some((s) => segmentsEqual(s, normalized));
  if (duplicate) {
    return { ok: false, error: "This segment already exists." };
  }

  map[movieId] = [...current, normalized].sort((a, b) => a.start - b.start || a.end - b.end);
  await api.storage.local.set({ [USER_SEGMENTS_KEY]: map });

  const state = normalizeState(await api.storage.local.get(Object.keys(DEFAULT_STATE)));
  const segments = await getMergedSegmentsByMovieId(movieId, state);
  return { ok: true, segments, autoSegments: filterAutoApplySegments(segments, state), source: segmentDbSource };
}

async function removeUserSegment(movieId, userIndex) {
  if (!movieId) {
    return { ok: false, error: "No movie selected." };
  }

  const idx = Number(userIndex);
  if (!Number.isInteger(idx) || idx < 0) {
    return { ok: false, error: "Invalid segment index." };
  }

  const map = await getUserSegmentMap();
  const current = map[movieId] || [];
  if (idx >= current.length) {
    return { ok: false, error: "Segment index out of range." };
  }

  current.splice(idx, 1);
  map[movieId] = current;
  await api.storage.local.set({ [USER_SEGMENTS_KEY]: map });

  const state = normalizeState(await api.storage.local.get(Object.keys(DEFAULT_STATE)));
  const segments = await getMergedSegmentsByMovieId(movieId, state);
  return { ok: true, segments, autoSegments: filterAutoApplySegments(segments, state), source: segmentDbSource };
}

async function addHeuristicSegments(movieId, segments) {
  if (!movieId) {
    return { ok: false, error: "No movie selected." };
  }

  const incoming = parseSegments(segments, { source_type: "local_ai", source: "local-ai", unverified: true });
  if (incoming.length === 0) {
    return { ok: true };
  }

  const map = await getAiSegmentMap();
  const current = map[movieId] || [];
  const merged = mergeSegmentsForMovie(current, incoming, "prefer-existing").segments;

  // Keep detector output bounded for performance.
  map[movieId] = merged.slice(-300);
  await api.storage.local.set({ [AI_SEGMENTS_KEY]: map });
  return { ok: true };
}

async function exportLocalDbPayload() {
  const userMap = await getUserSegmentMap();
  const aiMap = await getAiSegmentMap();
  return {
    ok: true,
    payload: {
      schema: LOCAL_DB_SCHEMA,
      exportedAt: new Date().toISOString(),
      userSegmentsByMovieId: userMap,
      localAiSegmentsByMovieId: aiMap
    }
  };
}

async function importLocalDbPayload(payload, strategy = "prefer-existing") {
  const mergeStrategy = ["prefer-existing", "prefer-imported", "keep-both"].includes(strategy)
    ? strategy
    : "prefer-existing";

  const importedUser = sanitizeSegmentMap(payload?.userSegmentsByMovieId, {
    source_type: "manual",
    source: "local-user"
  });
  const importedAi = sanitizeSegmentMap(payload?.localAiSegmentsByMovieId, {
    source_type: "local_ai",
    source: "local-ai",
    unverified: true
  });

  const currentUser = await getUserSegmentMap();
  const currentAi = await getAiSegmentMap();
  const allMovieIds = Array.from(
    new Set([...Object.keys(currentUser), ...Object.keys(importedUser), ...Object.keys(currentAi), ...Object.keys(importedAi)])
  );

  let added = 0;
  let replaced = 0;
  let skipped = 0;
  for (const movieId of allMovieIds) {
    const u = mergeSegmentsForMovie(currentUser[movieId] || [], importedUser[movieId] || [], mergeStrategy);
    const a = mergeSegmentsForMovie(currentAi[movieId] || [], importedAi[movieId] || [], mergeStrategy);
    currentUser[movieId] = u.segments;
    currentAi[movieId] = a.segments;
    added += u.added + a.added;
    replaced += u.replaced + a.replaced;
    skipped += u.skipped + a.skipped;
  }

  await api.storage.local.set({
    [USER_SEGMENTS_KEY]: currentUser,
    [AI_SEGMENTS_KEY]: currentAi
  });

  return {
    ok: true,
    summary: {
      strategy: mergeStrategy,
      movies: allMovieIds.length,
      added,
      replaced,
      skipped
    }
  };
}

async function getLocalSegmentsForMovie(movieId) {
  if (!movieId) {
    return { ok: false, error: "No movie id." };
  }

  const userMap = await getUserSegmentMap();
  const aiMap = await getAiSegmentMap();
  return {
    ok: true,
    movieId,
    segments: [...(userMap[movieId] || []), ...(aiMap[movieId] || [])]
  };
}

async function searchMovies(query) {
  const url = `https://www.omdbapi.com/?apikey=${encodeURIComponent(PUBLIC_OMDB_KEY)}&s=${encodeURIComponent(query)}&type=movie`;
  const response = await fetch(url, { cache: "no-store" });

  if (!response.ok) {
    return { ok: false, error: `Movie search failed (${response.status}).` };
  }

  const data = await response.json();
  if (data.Response === "False") {
    return { ok: false, error: data.Error || "No results." };
  }

  return {
    ok: true,
    results: (data.Search || []).map((item) => ({
      imdbID: item.imdbID,
      title: item.Title,
      year: item.Year,
      poster: item.Poster
    }))
  };
}

function normalizeMovieText(value) {
  return (value || "")
    .toLowerCase()
    .replace(/[\[\]().,:;!?'"`~@#$%^&*_+=/\\|-]/g, " ")
    .replace(/\b(izle|full|hd|turkce|dublaj|altyazi|film|watch|online|stream)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractQueryFromUrl(url) {
  try {
    const parsed = new URL(url || "");
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length === 0) {
      return "";
    }
    const last = parts[parts.length - 1];
    return normalizeMovieText(last.replace(/-\d+$/, "").replace(/_/g, " ").replace(/-/g, " "));
  } catch (_error) {
    return "";
  }
}

function scoreMovieMatch(query, movie) {
  const q = normalizeMovieText(query);
  const t = normalizeMovieText(movie?.title || "");
  if (!q || !t) {
    return 0;
  }
  if (t === q) {
    return 100;
  }
  if (t.includes(q) || q.includes(t)) {
    return 85;
  }
  const qWords = q.split(" ").filter(Boolean);
  const tWords = new Set(t.split(" ").filter(Boolean));
  let overlap = 0;
  for (const word of qWords) {
    if (tWords.has(word)) {
      overlap += 1;
    }
  }
  return Math.round((qWords.length ? overlap / qWords.length : 0) * 70);
}

async function detectMovieByCandidates(candidates) {
  let best = null;
  for (const candidate of candidates) {
    const searchResult = await searchMovies(candidate);
    if (!searchResult.ok || !Array.isArray(searchResult.results)) {
      continue;
    }

    for (const movie of searchResult.results) {
      const score = scoreMovieMatch(candidate, movie);
      if (!best || score > best.score) {
        best = { movie, score, candidate };
      }
    }
  }

  if (!best || best.score < 45) {
    return { ok: false, error: "Automatic movie detection failed." };
  }

  const selectedMovie = {
    imdbID: best.movie.imdbID,
    title: best.movie.title,
    year: best.movie.year
  };
  await api.storage.local.set({ selectedMovie });

  const state = normalizeState(await api.storage.local.get(Object.keys(DEFAULT_STATE)));
  const segments = await getMergedSegmentsByMovieId(selectedMovie.imdbID, state);
  return {
    ok: true,
    detected: true,
    detectionQuery: best.candidate,
    score: best.score,
    movie: selectedMovie,
    segments,
    autoSegments: filterAutoApplySegments(segments, state),
    source: segmentDbSource
  };
}

async function detectMovieFromActiveTab() {
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  if (!tab) {
    return { ok: false, error: "No active tab found." };
  }

  const title = normalizeMovieText((tab.title || "").split("|")[0].split("-")[0]);
  const fromUrl = extractQueryFromUrl(tab.url || "");
  const candidates = Array.from(new Set([title, fromUrl].filter((item) => item.length >= 3))).slice(0, 3);
  if (candidates.length === 0) {
    return { ok: false, error: "Could not infer movie title from this page." };
  }

  return await detectMovieByCandidates(candidates);
}

async function detectMovieFromPageContext(payload = {}) {
  const state = normalizeState(await api.storage.local.get(Object.keys(DEFAULT_STATE)));
  if (!state.autoDetect) {
    return { ok: false, error: "Auto-detect disabled." };
  }

  if (state.selectedMovie && !payload.force) {
    const segments = await getMergedSegmentsByMovieId(state.selectedMovie.imdbID, state);
    return {
      ok: true,
      skipped: true,
      movie: state.selectedMovie,
      segments,
      autoSegments: filterAutoApplySegments(segments, state),
      source: segmentDbSource
    };
  }

  const fromTitle = normalizeMovieText((payload.title || "").split("|")[0]);
  const fromUrl = extractQueryFromUrl(payload.url || "");
  const candidates = Array.from(new Set([fromTitle, fromUrl].filter((item) => item.length >= 3))).slice(0, 3);
  if (candidates.length === 0) {
    return { ok: false, error: "Could not infer movie title from page context." };
  }

  return await detectMovieByCandidates(candidates);
}

async function updatePlaybackSnapshot(sender, payload) {
  const tabId = sender?.tab?.id;
  if (!tabId) {
    return { ok: false, error: "No tab context." };
  }

  const currentTime = Number(payload?.currentTime);
  const duration = Number(payload?.duration);
  if (!Number.isFinite(currentTime) || !Number.isFinite(duration) || duration <= 0) {
    return { ok: false, error: "Invalid playback snapshot." };
  }

  playbackSnapshotsByTab.set(tabId, {
    currentTime,
    duration,
    url: payload?.url || sender?.url || "",
    title: payload?.title || "",
    updatedAt: Date.now()
  });
  return { ok: true };
}

async function getPlaybackSnapshotActiveTab() {
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  if (!tab?.id) {
    return { ok: false, error: "No active tab." };
  }

  const snapshot = playbackSnapshotsByTab.get(tab.id);
  if (!snapshot) {
    return { ok: false, error: "No active video snapshot yet. Start video playback first." };
  }

  if (Date.now() - snapshot.updatedAt > 15000) {
    return { ok: false, error: "Video snapshot is stale. Play video and try again." };
  }

  return { ok: true, snapshot };
}

api.runtime.onInstalled.addListener(() => {
  ensureDefaults().catch((error) => {
    console.error("SceneFilter init failed", error);
  });
});

api.tabs.onRemoved.addListener((tabId) => {
  playbackSnapshotsByTab.delete(tabId);
});

api.runtime.onMessage.addListener(async (message, sender) => {
  try {
    switch (message?.type) {
      case "getState":
        await ensureDefaults();
        return await getStatePayload();

      case "saveSettings": {
        const incoming = message.payload || {};
        const current = normalizeState(await api.storage.local.get(Object.keys(DEFAULT_STATE)));
        const next = {
          ...current,
          enabled: typeof incoming.enabled === "boolean" ? incoming.enabled : current.enabled,
          autoDetect: typeof incoming.autoDetect === "boolean" ? incoming.autoDetect : current.autoDetect,
          language: ["tr", "en"].includes(String(incoming.language || "").toLowerCase())
            ? String(incoming.language).toLowerCase()
            : current.language,
          adaptiveMode: typeof incoming.adaptiveMode === "boolean" ? incoming.adaptiveMode : current.adaptiveMode,
          audioOnlyMode: typeof incoming.audioOnlyMode === "boolean" ? incoming.audioOnlyMode : current.audioOnlyMode,
          safeMode: String(incoming.safeMode || current.safeMode).toUpperCase(),
          confidenceThreshold:
            incoming.confidenceThreshold != null
              ? clamp(Number(incoming.confidenceThreshold) || current.confidenceThreshold, 0, 100)
              : current.confidenceThreshold,
          debugMode: typeof incoming.debugMode === "boolean" ? incoming.debugMode : current.debugMode,
          previewBeforeSkip:
            typeof incoming.previewBeforeSkip === "boolean" ? incoming.previewBeforeSkip : current.previewBeforeSkip,
          autoSkipDelaySec:
            incoming.autoSkipDelaySec != null
              ? clamp(Number(incoming.autoSkipDelaySec) || current.autoSkipDelaySec, 0, 10)
              : current.autoSkipDelaySec,
          communitySyncEnabled:
            typeof incoming.communitySyncEnabled === "boolean"
              ? incoming.communitySyncEnabled
              : current.communitySyncEnabled,
          metadataLookupEnabled:
            typeof incoming.metadataLookupEnabled === "boolean"
              ? incoming.metadataLookupEnabled
              : current.metadataLookupEnabled,
          categoryActions: {
            sexual: incoming.categoryActions?.sexual || current.categoryActions.sexual,
            nudity: incoming.categoryActions?.nudity || current.categoryActions.nudity
          }
        };

        if (!SAFE_MODE_THRESHOLDS[next.safeMode]) {
          next.safeMode = current.safeMode;
        }

        await api.storage.local.set(next);
        return { ok: true };
      }

      case "selectMovie": {
        const movie = message.movie || null;
        await api.storage.local.set({ selectedMovie: movie });
        const state = normalizeState(await api.storage.local.get(Object.keys(DEFAULT_STATE)));
        const segments = await getMergedSegmentsByMovieId(movie?.imdbID || null, state);
        return { ok: true, segments, autoSegments: filterAutoApplySegments(segments, state), source: segmentDbSource };
      }

      case "searchMovies": {
        const query = (message.query || "").trim();
        if (!query) {
          return { ok: false, error: "Enter a movie title." };
        }
        return await searchMovies(query);
      }

      case "refreshCommunityDb":
        remoteDbCache = null;
        remoteDbLoadedAt = 0;
        return { ok: true };

      case "detectMovieFromActiveTab":
        return await detectMovieFromActiveTab();

      case "autoDetectFromPageContext":
        return await detectMovieFromPageContext(message.payload || {});

      case "addUserSegment":
        return await addUserSegment(message.movieId, message.segment);

      case "removeUserSegment":
        return await removeUserSegment(message.movieId, message.userIndex);

      case "addHeuristicSegments":
        return await addHeuristicSegments(message.movieId, message.segments);

      case "updatePlaybackSnapshot":
        return await updatePlaybackSnapshot(sender, message.payload || {});

      case "getPlaybackSnapshotActiveTab":
        return await getPlaybackSnapshotActiveTab();

      case "exportLocalDb":
        return await exportLocalDbPayload();

      case "importLocalDb":
        return await importLocalDbPayload(message.payload, message.strategy);

      case "getLocalSegmentsForMovie":
        return await getLocalSegmentsForMovie(message.movieId);

      default:
        return { ok: false, error: "Unknown request." };
    }
  } catch (error) {
    console.error("SceneFilter background error", error);
    return { ok: false, error: error?.message || "Unexpected error" };
  }
});
