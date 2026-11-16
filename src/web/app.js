const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

// Identity colours come from CSS custom properties so light/dark steps swap in one place.
const PROVIDERS = {
  claude: { label: "Claude", color: "var(--claude)" },
  codex: { label: "Codex", color: "var(--codex)" },
  opencode: { label: "OpenCode", color: "var(--opencode)" },
};
const PROVIDER_ORDER = ["claude", "codex", "opencode"];

const PREFS_KEY = "usage-dash-prefs";

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

const prefs = loadPrefs();

const state = {
  range: ["1d", "7d", "30d", "all"].includes(prefs.range) ? prefs.range : "7d",
  metric: ["tokens", "fresh", "cost"].includes(prefs.metric) ? prefs.metric : "fresh",
  group: prefs.group === "model" ? "model" : "provider",
  resolution: prefs.resolution && typeof prefs.resolution === "object" ? prefs.resolution : {},
  hidden: prefs.hidden && typeof prefs.hidden === "object" ? prefs.hidden : {},
  zoom: null,
  data: null,
  loading: false,
  adviceLoading: false,
  failureShown: false,
};

function savePrefs() {
  localStorage.setItem(
    PREFS_KEY,
    JSON.stringify({
      range: state.range,
      metric: state.metric,
      group: state.group,
      resolution: state.resolution,
      hidden: state.hidden,
    }),
  );
}

const tips = new Map();

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat("en-US");

/* ---------- formatting ---------- */

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function fmtTokens(value) {
  if (!Number.isFinite(Number(value))) return "—";
  return compact.format(Number(value));
}

function fmtInteger(value) {
  return integer.format(Number(value) || 0);
}

function fmtUsd(value) {
  const number = Number(value) || 0;
  if (number === 0) return "$0";
  if (number < 1) return `$${number.toFixed(2)}`;
  if (number < 100) return `$${number.toFixed(1)}`;
  return `$${integer.format(Math.round(number))}`;
}

function fmtShare(part, whole) {
  if (!whole) return "—";
  const share = (part / whole) * 100;
  if (share > 0 && share < 0.1) return "<0.1%";
  return `${share < 10 ? share.toFixed(1) : Math.round(share)}%`;
}

function providerLabel(id) {
  return PROVIDERS[id]?.label ?? id;
}

function providerColor(id) {
  return PROVIDERS[id]?.color ?? "var(--other)";
}

function duration(ms) {
  const future = ms >= 0;
  const mins = Math.round(Math.abs(ms) / 60_000);
  if (mins < 1) return future ? "under a minute" : "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  if (hours < 24) return rest ? `${hours}h ${rest}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainder = hours % 24;
  return remainder ? `${days}d ${remainder}h` : `${days}d`;
}

function shortDuration(ms) {
  const mins = Math.round(Math.abs(ms) / 60_000);
  if (ms < 0) return "passed";
  if (mins < 60) return `${Math.max(1, mins)}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function tz() {
  return state.data?.timezone ?? "America/New_York";
}

function dateTime(timestamp, options = {}) {
  if (!timestamp) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz(),
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...options,
  }).format(new Date(timestamp));
}

function dayOnly(timestamp) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz(), month: "short", day: "numeric" }).format(
    new Date(timestamp),
  );
}

function timeOnly(timestamp) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz(), hour: "numeric", minute: "2-digit" }).format(
    new Date(timestamp),
  );
}

function hourLabel(hour) {
  const suffix = hour < 12 ? "am" : "pm";
  const value = hour % 12 === 0 ? 12 : hour % 12;
  return `${value}${suffix}`;
}

function projectLabel(path) {
  if (!path || path === "(unknown)") return "(unknown)";
  return path.split("/").filter(Boolean).at(-1) || path;
}

function projectTrail(path) {
  if (!path || path === "(unknown)") return "no folder recorded";
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return "";
  const home = parts[0] === "Users" ? 2 : 0;
  const trail = parts.slice(home, -1).join("/");
  return trail ? `${home ? "~/" : "/"}${trail}` : "";
}

/* ---------- limit state ---------- */

function windowState(window) {
  if (!window || window.percent == null) {
    return {
      cls: "is-none",
      label: window?.confidence === "stale" ? "Awaiting fresh data" : "No reading yet",
    };
  }
  if (window.confidence === "capped") return { cls: "is-critical", label: "Capped" };
  if (window.percent >= 90) return { cls: "is-critical", label: "At the limit" };
  if (window.percent >= 70) return { cls: "is-warning", label: "Getting close" };
  return { cls: "is-good", label: "Comfortable" };
}

const BADGE_ICONS = {
  exact: '<svg viewBox="0 0 12 12"><path d="M2.5 6.2 5 8.6 9.6 3.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  capped: '<svg viewBox="0 0 12 12"><rect x="2.5" y="5.2" width="7" height="5" rx="1.2" fill="currentColor"/><path d="M4 5.2V4a2 2 0 0 1 4 0v1.2" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  estimated: '<svg viewBox="0 0 12 12"><path d="M2 7c1.2-1.6 2.4-1.6 4 0s2.8 1.6 4 0M2 4.6c1.2-1.6 2.4-1.6 4 0s2.8 1.6 4 0" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  stale: '<svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6 3.8V6l1.6 1" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  unknown: '<svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2 1.6"/></svg>',
};

function badgeMarkup(confidence) {
  const label =
    {
      exact: "Exact",
      estimated: "Estimated",
      capped: "Confirmed capped",
      stale: "Stale",
      unknown: "Needs data",
    }[confidence] ?? confidence;
  const title =
    {
      exact: "Reported by the provider itself",
      estimated: "Inferred from your logs and past limit hits",
      capped: "A logged limit message confirms this window is capped",
      stale: "The last reported window has already reset",
      unknown: "Not enough history to estimate yet",
    }[confidence] ?? "";
  return `<span class="badge" title="${escapeHtml(title)}">${BADGE_ICONS[confidence] ?? ""}${escapeHtml(label)}</span>`;
}

function primaryWindow(windows) {
  if (!windows.length) return null;
  const capped = windows.find((window) => window.confidence === "capped");
  if (capped) return capped;
  return [...windows].sort((a, b) => (b.percent ?? -1) - (a.percent ?? -1))[0];
}

/* ---------- data ---------- */

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toast.timeout);
  toast.timeout = setTimeout(() => {
    element.hidden = true;
  }, 7000);
}

async function getDashboard(range = state.range) {
  const params = new URLSearchParams({ range });
  if (state.resolution[range]) params.set("resolution", state.resolution[range]);
  const response = await fetch(`/api/dashboard?${params}`, { cache: "no-store" });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

async function refresh({ manual = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  updateRefreshButton();
  try {
    state.data = await getDashboard();
    state.failureShown = false;
    render();
  } catch (error) {
    updateFreshness();
    if (manual || !state.failureShown) {
      toast(`Could not refresh usage: ${error.message}`);
      state.failureShown = true;
    }
  } finally {
    state.loading = false;
    updateRefreshButton();
  }
}

function updateRefreshButton() {
  const button = $("#refresh-button");
  button.disabled = state.loading;
  button.classList.toggle("is-spinning", state.loading);
}

function renderControls() {
  $$("[data-range]").forEach((button) => button.classList.toggle("is-active", button.dataset.range === state.range));
  $$("[data-metric]").forEach((button) => button.classList.toggle("is-active", button.dataset.metric === state.metric));
}

/** Re-render only the views that depend on the measure. */
function renderMetricViews() {
  tips.clear();
  renderControls();
  renderUsage();
  renderModelMix();
  renderModelTable();
  renderProjects();
  renderHeatmap();
}

function render() {
  tips.clear();
  renderMasthead();
  renderCards();
  renderAdvice();
  renderFigures();
  renderControls();
  renderUsage();
  renderModelMix();
  renderModelTable();
  renderProjects();
  renderHeatmap();
  renderSessions();
  renderLimits();
  updateFreshness();
  updateClocks();
}

const RANGE_TEXT = { "1d": "last 24 hours", "7d": "last 7 days", "30d": "last 30 days", all: "all time" };

function renderMasthead() {
  const data = state.data;
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: data.timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date(data.generatedAt));
  $("#date-line").textContent = `${date} · ${RANGE_TEXT[state.range] ?? ""}`;
  $("#footer-meta").textContent = `127.0.0.1:${data.config.port} · ${data.timezone} · last scan ${dateTime(data.ingestion.finishedAt)}`;
}

/* ---------- cards ---------- */

function ringMarkup(window, stateInfo) {
  const percent = window?.percent;
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const value = percent == null ? 0 : Math.max(0, Math.min(100, percent));
  const filled = (value / 100) * circumference;
  const label = percent == null ? "No percentage available" : `${Math.round(percent)} percent used`;
  const shown = percent == null ? "—" : Math.min(100, Math.round(percent));
  return `<svg class="ring ${stateInfo.cls}" viewBox="0 0 124 124" role="img" aria-label="${label}">
    ${
      percent == null
        ? `<circle class="ring-empty" cx="62" cy="62" r="${radius}" />`
        : `<circle class="ring-track" cx="62" cy="62" r="${radius}" />
           ${value > 0 ? `<circle class="ring-fill" cx="62" cy="62" r="${radius}" transform="rotate(-90 62 62)" stroke-dasharray="${filled.toFixed(2)} ${circumference.toFixed(2)}" />` : ""}`
    }
    <text class="ring-value" x="62" y="${percent == null ? 70 : 66}" text-anchor="middle">${shown}${percent == null ? "" : '<tspan font-size="15" dx="1" dy="-11">%</tspan>'}</text>
    ${percent == null ? "" : `<text class="ring-unit" x="62" y="84" text-anchor="middle">used</text>`}
  </svg>`;
}

function resetMarkup(window) {
  if (!window) {
    return `<div class="reset-big">No limit data</div>`;
  }
  if (!window.resetAt) {
    return `<div class="reset-big">${window.confidence === "stale" ? "Window has reset" : "No reset time"}</div>
      <div class="reset-when">${escapeHtml(window.detail)}</div>`;
  }
  const approximate = window.confidence === "estimated";
  return `<div class="reset-line" data-reset="${window.resetAt}">
      <div class="reset-big reset-count">Resets in ${duration(window.resetAt - Date.now())}</div>
      <div class="reset-when">${approximate ? "≈ " : ""}${escapeHtml(dateTime(window.resetAt, { weekday: "short" }))}</div>
    </div>`;
}

function sparklineMarkup(card) {
  const values = card.sparkline?.length ? card.sparkline : [0];
  const max = Math.max(...values, 1);
  const width = 240;
  const height = 40;
  const points = values.map((value, index) => {
    const x = values.length === 1 ? width / 2 : (index / (values.length - 1)) * width;
    const y = height - 3 - (value / max) * (height - 8);
    return [x, y];
  });
  const line = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" L ");
  const color = providerColor(card.id);
  return `<div class="spark-block">
    <div class="spark-head"><span>Tokens, ${escapeHtml(RANGE_TEXT[state.range] ?? "this range")}</span><strong>${fmtTokens(card.rangeTokens)}</strong></div>
    <svg class="spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Token trend for ${escapeHtml(card.name)}">
      <path d="M 0,${height} L ${line} L ${width},${height} Z" style="fill:${color}" fill-opacity="0.12" />
      <path d="M ${line}" fill="none" style="stroke:${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
    </svg>
  </div>`;
}

function renderCards() {
  $("#quota-grid").innerHTML = state.data.cards
    .map((card) => {
      const windows = card.windows ?? [];
      const primary = primaryWindow(windows);
      const primaryState = windowState(primary);
      const rows = windows
        .map((window) => {
          const info = windowState(window);
          const value = window.percent == null ? 0 : Math.min(100, window.percent);
          const title = `${window.label}: ${window.detail}${window.resetAt ? ` Resets ${dateTime(window.resetAt, { weekday: "short" })}.` : ""}`;
          return `<li class="window-row ${info.cls}" title="${escapeHtml(title)}">
            <span class="window-name">${escapeHtml(window.label)}</span>
            <span class="window-meter"><span style="width:${value}%"></span></span>
            <span class="window-value">${window.percent == null ? "—" : `${Math.round(window.percent)}%`}${window.resetAt ? ` <small>· ${shortDuration(window.resetAt - Date.now())}</small>` : ""}</span>
          </li>`;
        })
        .join("");
      return `<article class="quota-card" data-provider="${card.id}">
        <div class="quota-head">
          <div>
            <div class="quota-name"><span class="provider-dot" style="--key:${providerColor(card.id)}"></span><h2>${escapeHtml(card.name)}</h2></div>
            <span class="quota-sub">${escapeHtml(card.subtitle)}</span>
          </div>
          ${badgeMarkup(primary?.confidence ?? "unknown")}
        </div>
        <div class="gauge-block">
          ${ringMarkup(primary, primaryState)}
          <div class="${primaryState.cls}">
            <div class="state-chip">${escapeHtml(primaryState.label)}</div>
            <div class="gauge-window">${escapeHtml(primary?.label ?? "No window")} window</div>
            ${resetMarkup(primary)}
          </div>
        </div>
        <ul class="window-list">${rows || `<li class="window-row is-none"><span class="window-name">No limit data</span><span></span><span class="window-value">—</span></li>`}</ul>
        ${sparklineMarkup(card)}
        <p class="card-note">${escapeHtml(card.note)}</p>
      </article>`;
    })
    .join("");
}

/* ---------- advice ---------- */

function renderAdvice() {
  const data = state.data;
  const body = $("#advice-body");
  const button = $("#advice-button");
  button.disabled = state.adviceLoading;
  button.textContent = state.adviceLoading ? "Thinking…" : data?.advice ? "Refresh" : "Ask for advice";
  if (state.adviceLoading) {
    body.innerHTML = `<div class="advice-loading"><span class="spinner"></span><span>Reading your recent usage and picking one plan B…</span></div>
      <p class="advice-meta">Usually under a minute. The dashboard stays usable meanwhile.</p>`;
    return;
  }
  if (!data?.advice) {
    body.innerHTML = `<p class="advice-empty">Turn your usage into one specific plan B: what to switch, when, and for which kind of work.</p>
      <p class="advice-meta">One on-demand call to a cheap model. It uses a little OpenCode Go quota and is hidden from your totals.</p>`;
    return;
  }
  const advice = data.advice;
  const recommendations = advice.recommendations?.length
    ? `<ol class="advice-list">${advice.recommendations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol>`
    : "";
  body.innerHTML = `<p class="advice-headline">${escapeHtml(advice.headline)}</p>
    ${recommendations}
    <p class="advice-meta">Generated ${duration(Date.now() - advice.generatedAt)} ago · <code>${escapeHtml(advice.model)}</code>${advice.error ? `<span class="warn">Last refresh failed: ${escapeHtml(advice.error)}</span>` : ""}</p>`;
}

/* ---------- metric helpers ---------- */

const METRIC_TEXT = { tokens: "tokens", fresh: "fresh tokens", cost: "API-equivalent $" };
const RESOLUTION_TEXT = { "15m": "15 min", "1h": "Hourly", "3h": "3 h", "6h": "6 h", "1d": "Daily" };
const DAY_MS = 86_400_000;

function metricOf(item) {
  return Number(item?.[state.metric]) || 0;
}

function fmtMetric(value) {
  return state.metric === "cost" ? fmtUsd(value) : fmtTokens(value);
}

function metricUnit() {
  return state.metric === "cost" ? "" : state.metric === "fresh" ? " fresh" : " tokens";
}

const localFormatters = new Map();
function localParts(timestamp) {
  const zone = tz();
  let formatter = localFormatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hourCycle: "h23",
    });
    localFormatters.set(zone, formatter);
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]),
  );
  return {
    weekday: parts.weekday,
    month: parts.month,
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

function bucketLabel(start, size) {
  const p = localParts(start);
  const date = `${p.weekday}, ${p.month} ${p.day}`;
  if (size >= DAY_MS) return date;
  return `${date} · ${timeOnly(start)}–${timeOnly(start + size)}`;
}

/* ---------- stats ---------- */

function renderFigures() {
  const data = state.data;
  const totals = data.totals;
  $("#figure-tokens").textContent = fmtTokens(totals.tokens);
  $("#figure-events").innerHTML = PROVIDER_ORDER.filter((id) => data.providers[id]?.tokens > 0)
    .map(
      (id) =>
        `<span class="split"><i style="--key:${providerColor(id)}"></i>${providerLabel(id)} ${fmtShare(data.providers[id].tokens, totals.tokens)}</span>`,
    )
    .join("");
  $("#figure-fresh").textContent = fmtTokens(totals.fresh);
  $("#figure-fresh-note").textContent = totals.tokens
    ? `${fmtShare(totals.fresh, totals.tokens)} of all tokens · what drains limits`
    : "what drains limits";
  const sessions = data.sessions.reduce((sum, bin) => sum + bin.count, 0);
  $("#figure-sessions").textContent = fmtInteger(sessions);
  $("#figure-sessions-note").textContent = `${fmtInteger(totals.events)} model calls`;
  const cacheBase = totals.input + totals.cacheRead;
  $("#figure-cache").textContent = cacheBase > 0 ? `${Math.round((totals.cacheRead / cacheBase) * 100)}%` : "—";
  $("#figure-cost").textContent = fmtUsd(totals.cost);
  $("#figure-cost-note").textContent = totals.unpriced
    ? `at list prices · ${fmtInteger(totals.unpriced)} calls unpriced`
    : "at API list prices, not what you pay";
}

/* ---------- usage chart ---------- */

function niceMax(value) {
  if (value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const fraction = value / base;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * base;
}

function roundedTop(x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height));
  return `M ${x} ${y + height} V ${y + r} Q ${x} ${y} ${x + r} ${y} H ${x + width - r} Q ${x + width} ${y} ${x + width} ${y + r} V ${y + height} Z`;
}

const SHADE_MIX = [
  (c) => c,
  (c) => `color-mix(in oklab, ${c} 50%, var(--surface))`,
  (c) => `color-mix(in oklab, ${c} 58%, var(--ink))`,
  (c) => `color-mix(in oklab, ${c} 24%, var(--surface))`,
  (c) => `color-mix(in oklab, ${c} 34%, var(--ink))`,
];

/** Model series take shades of their subscription's hue, so families stay readable. */
function seriesColors(list) {
  const seen = {};
  const colors = {};
  for (const series of list) {
    if (series.provider === "other") {
      colors[series.key] = "var(--other)";
      continue;
    }
    const n = seen[series.provider] ?? 0;
    seen[series.provider] = n + 1;
    const base = providerColor(series.provider);
    colors[series.key] = state.group === "provider" ? base : SHADE_MIX[n % SHADE_MIX.length](base);
  }
  return colors;
}

function seriesLabel(series) {
  return state.group === "provider" ? providerLabel(series.key) : series.label;
}

function hiddenSet() {
  return new Set(state.hidden[state.group] ?? []);
}

/** Visible index window for the chart, honouring a timestamp-based zoom. */
function viewWindow(starts, size) {
  if (!state.zoom || !starts.length) return [0, starts.length - 1];
  let a = starts.findIndex((at) => at + size > state.zoom[0]);
  let b = starts.length - 1;
  while (b > 0 && starts[b] > state.zoom[1]) b--;
  if (a < 0 || b <= a) return [0, starts.length - 1];
  return [a, b];
}

const chart = { geometry: null, drag: null };

function renderUsage() {
  const data = state.data;
  const series = data.series;
  const container = $("#usage-chart");
  const list = (state.group === "provider" ? series.providers : series.models).filter((item) =>
    item[state.metric].some((value) => value > 0),
  );
  const colors = seriesColors(list);
  const hidden = hiddenSet();
  const visible = list.filter((item) => !hidden.has(item.key));
  const starts = series.starts;
  const size = series.bucketMs;
  const [a, b] = viewWindow(starts, size);
  const n = b - a + 1;

  // resolution switch
  $("#resolution-switch").innerHTML = series.resolutions
    .map(
      (res) =>
        `<button type="button" data-resolution="${res}" class="${res === series.resolution ? "is-active" : ""}">${RESOLUTION_TEXT[res] ?? res}</button>`,
    )
    .join("");
  $$("[data-group]").forEach((button) => button.classList.toggle("is-active", button.dataset.group === state.group));

  // legend chips with totals over the visible window
  const sumOf = (item) => item[state.metric].slice(a, b + 1).reduce((sum, value) => sum + value, 0);
  $("#usage-legend").innerHTML = list.length
    ? list
        .map(
          (item) =>
            `<button type="button" class="legend-chip" data-series="${escapeHtml(item.key)}" aria-pressed="${!hidden.has(item.key)}" title="${hidden.has(item.key) ? "Show" : "Hide"} ${escapeHtml(seriesLabel(item))}">
              <span class="legend-dot" style="--key:${colors[item.key]}"></span>${escapeHtml(seriesLabel(item))}${state.group === "model" && item.provider !== "other" ? ` <span class="dim">${escapeHtml(providerLabel(item.provider))}</span>` : ""} <b>${fmtMetric(sumOf(item))}</b>
            </button>`,
        )
        .join("")
    : "";

  $("#zoom-reset").hidden = !state.zoom;
  $("#zoom-hint").textContent = state.zoom
    ? `Zoomed to ${bucketLabel(starts[a], size).split(" · ")[0]} – ${bucketLabel(starts[b], size).split(" · ")[0]}. Double-click or press Esc to zoom out.`
    : "Drag across the chart to zoom in. Click a legend item to hide it.";

  const totals = [];
  for (let i = a; i <= b; i++) totals.push(visible.reduce((sum, item) => sum + item[state.metric][i], 0));
  const maxRaw = Math.max(...totals, 0);
  if (!n || maxRaw <= 0) {
    container.innerHTML = `<div class="chart-empty" style="min-height:360px">No ${METRIC_TEXT[state.metric]} in this period yet.</div>`;
    $("#usage-summary").textContent = "Nothing recorded in this period.";
    chart.geometry = null;
    return;
  }

  // summary sentence
  const total = totals.reduce((sum, value) => sum + value, 0);
  const peakIndex = totals.indexOf(maxRaw);
  const active = totals.filter((value) => value > 0).length;
  const unit = size >= DAY_MS ? "days" : size === 3_600_000 ? "hours" : `${RESOLUTION_TEXT[series.resolution]} slots`;
  $("#usage-summary").innerHTML = `<b>${fmtMetric(total)}</b>${metricUnit()} · peak <b>${fmtMetric(maxRaw)}</b> on ${escapeHtml(bucketLabel(starts[a + peakIndex], size))} · active in ${active} of ${n} ${unit}`;

  const width = Math.max(480, Math.round(container.clientWidth || 1200));
  const height = width < 700 ? 300 : 400;
  const margin = { top: 30, right: 8, bottom: 40, left: 52 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const tickStep = niceMax(maxRaw / 4);
  const tickCount = Math.max(1, Math.ceil(maxRaw / tickStep));
  const max = tickStep * tickCount;
  const step = plotW / n;
  const gap = step > 6 ? Math.min(4, Math.max(1, step * 0.22)) : step > 2.5 ? 1 : 0;
  const barW = Math.max(0.6, step - gap);
  const y = (value) => margin.top + plotH - (value / max) * plotH;
  const xOf = (index) => margin.left + step * (index - a);

  let grid = "";
  for (let tick = 0; tick <= tickCount; tick++) {
    const value = tickStep * tick;
    grid += `${tick ? `<line class="chart-grid" x1="${margin.left}" x2="${width - margin.right}" y1="${y(value)}" y2="${y(value)}" />` : ""}
      <text class="chart-axis" x="${margin.left - 10}" y="${y(value) + 4}" text-anchor="end">${tick ? fmtMetric(value) : "0"}</text>`;
  }

  // x axis: day boundaries (bold) plus time ticks when zoomed in enough
  let days = "";
  let labels = "";
  let lastLabelX = -Infinity;
  const spanMs = n * size;
  const timeEvery = spanMs <= 1.1 * DAY_MS ? 3 : spanMs <= 3.1 * DAY_MS ? 6 : null;
  for (let i = a; i <= b; i++) {
    const p = localParts(starts[i]);
    const x = xOf(i);
    const isMidnight = size >= DAY_MS || (p.hour === 0 && p.minute === 0);
    if (isMidnight && size < DAY_MS && i > a) {
      days += `<line class="chart-day" x1="${x}" x2="${x}" y1="${margin.top}" y2="${margin.top + plotH}" />`;
    }
    let label = null;
    let cls = "";
    if (isMidnight) {
      label = `${p.weekday} ${p.day}`;
      cls = "is-day";
      if (size >= DAY_MS && n > 40) label = `${p.month} ${p.day}`;
    } else if (timeEvery && p.minute === 0 && p.hour % timeEvery === 0) {
      label = hourLabel(p.hour);
    }
    const minGap = cls ? 54 : 40;
    if (label && x - lastLabelX >= minGap) {
      const anchorX = size >= DAY_MS ? x + step / 2 : x;
      labels += `<text class="chart-axis ${cls}" x="${anchorX}" y="${height - 16}" text-anchor="${anchorX - margin.left < 20 ? "start" : "middle"}">${escapeHtml(label)}</text>`;
      lastLabelX = x;
    }
  }

  // stacked bars
  let bars = "";
  for (let i = a; i <= b; i++) {
    const x = xOf(i) + gap / 2;
    const present = visible.filter((item) => item[state.metric][i] > 0);
    let base = 0;
    present.forEach((item, position) => {
      const value = item[state.metric][i];
      const top = y(base + value);
      const bottom = y(base);
      const seam = position > 0 && barW > 3 ? 1.5 : 0;
      const h = bottom - top - seam;
      if (h > 0.15) {
        const fill = colors[item.key];
        bars +=
          position === present.length - 1 && barW >= 5
            ? `<path d="${roundedTop(x, top, barW, h, Math.min(4, barW / 3))}" style="fill:${fill}" />`
            : `<rect x="${x.toFixed(2)}" y="${top.toFixed(2)}" width="${barW.toFixed(2)}" height="${h.toFixed(2)}" style="fill:${fill}" />`;
      }
      base += value;
    });
  }

  // limit-hit markers
  let markers = "";
  const windowStart = starts[a];
  const windowEnd = starts[b] + size;
  const groups = [];
  for (const limit of [...data.limits].sort((p, q) => p.timestamp - q.timestamp)) {
    if (limit.timestamp < windowStart || limit.timestamp >= windowEnd) continue;
    const x = margin.left + ((limit.timestamp - windowStart) / (windowEnd - windowStart)) * plotW;
    const last = groups.at(-1);
    if (last && x - last.x < 12) last.items.push(limit);
    else groups.push({ x, items: [limit] });
  }
  groups.forEach((group, groupIndex) => {
    const x = group.x;
    const tipId = `limit-${groupIndex}`;
    tips.set(
      tipId,
      `<strong>${group.items.length > 1 ? `${group.items.length} limit hits` : `${escapeHtml(providerLabel(group.items[0].provider))} limit hit`}</strong>${group.items
        .map(
          (limit) =>
            `<div class="tip-limit"><i style="--key:${providerColor(limit.provider)}"></i><span><b>${escapeHtml(providerLabel(limit.provider))}</b> · ${escapeHtml(dateTime(limit.timestamp, { weekday: "short" }))}<br><span class="dim">${escapeHtml(limit.message || limit.kind)}</span></span></div>`,
        )
        .join("")}`,
    );
    markers += `<g data-tip="${tipId}">
      <line class="limit-line" x1="${x}" x2="${x}" y1="${margin.top - 2}" y2="${margin.top + plotH}" />
      <path class="limit-flag" d="M ${x - 5} ${margin.top - 12} h 10 v 6 l -5 5 l -5 -5 z" />
      ${group.items.length > 1 ? `<text class="limit-count" x="${x}" y="${margin.top - 15}" text-anchor="middle">${group.items.length}</text>` : ""}
      <rect class="limit-hit" x="${x - 7}" y="${margin.top - 24}" width="14" height="${plotH + 24}" />
    </g>`;
  });

  container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeHtml(METRIC_TEXT[state.metric])} over time, ${state.group === "provider" ? "by subscription" : "by model"}">
    ${grid}
    ${days}
    <rect class="chart-band" id="usage-band" x="0" y="${margin.top}" width="0" height="${plotH}" visibility="hidden" />
    <g pointer-events="none">${bars}</g>
    <line class="chart-base" x1="${margin.left}" x2="${width - margin.right}" y1="${y(0)}" y2="${y(0)}" />
    ${labels}
    <rect class="chart-select" id="usage-select" x="0" y="${margin.top}" width="0" height="${plotH}" visibility="hidden" />
    <rect id="usage-overlay" data-tip-custom x="${margin.left}" y="${margin.top}" width="${plotW}" height="${plotH}" fill="transparent" />
    ${markers}
  </svg>`;

  chart.geometry = { a, b, step, margin, plotW, width, starts, size, visible, colors, totals };
}

function chartIndex(event) {
  const g = chart.geometry;
  const svg = $("#usage-chart svg");
  if (!g || !svg) return null;
  const rect = svg.getBoundingClientRect();
  const local = ((event.clientX - rect.left) / rect.width) * g.width;
  const offset = Math.floor((local - g.margin.left) / g.step);
  return Math.max(0, Math.min(g.b - g.a, offset)) + g.a;
}

function showChartHover(index, event) {
  const g = chart.geometry;
  const band = $("#usage-band");
  band.setAttribute("x", g.margin.left + g.step * (index - g.a));
  band.setAttribute("width", Math.max(1, g.step));
  band.setAttribute("visibility", "visible");
  const rows = g.visible
    .map((item) => ({ item, value: item[state.metric][index] }))
    .filter((row) => row.value > 0)
    .sort((x, y) => y.value - x.value);
  const total = g.totals[index - g.a];
  const start = g.starts[index];
  const hits = state.data.limits.filter((limit) => limit.timestamp >= start && limit.timestamp < start + g.size);
  const shown = rows.slice(0, 8);
  const html = `<strong>${escapeHtml(bucketLabel(start, g.size))}</strong>${
    shown.length
      ? shown
          .map(
            (row) =>
              `<div class="tip-row"><i style="--key:${g.colors[row.item.key]}"></i><span>${escapeHtml(seriesLabel(row.item))}</span><b>${fmtMetric(row.value)}</b></div>`,
          )
          .join("")
      : `<div class="dim">No activity</div>`
  }${rows.length > shown.length ? `<div class="dim">+${rows.length - shown.length} more</div>` : ""}${
    shown.length > 1 ? `<div class="tip-row tip-total"><span></span><span>Total</span><b>${fmtMetric(total)}</b></div>` : ""
  }${hits.map((hit) => `<div class="tip-row tip-total"><i style="--key:var(--critical)"></i><span>${escapeHtml(providerLabel(hit.provider))} limit hit</span><b>${escapeHtml(timeOnly(hit.timestamp))}</b></div>`).join("")}`;
  showTooltip(html, event);
}

function hideChartHover() {
  $("#usage-band")?.setAttribute("visibility", "hidden");
}

function bindChart() {
  const container = $("#usage-chart");
  container.addEventListener("pointerdown", (event) => {
    if (event.target.id !== "usage-overlay" || event.button !== 0) return;
    const index = chartIndex(event);
    if (index == null) return;
    chart.drag = { from: index, to: index };
    container.setPointerCapture(event.pointerId);
  });
  container.addEventListener("pointermove", (event) => {
    if (!chart.geometry) return;
    const onOverlay = event.target.id === "usage-overlay" || chart.drag;
    if (!onOverlay) {
      hideChartHover();
      return;
    }
    const index = chartIndex(event);
    if (index == null) return;
    if (chart.drag) {
      chart.drag.to = index;
      const g = chart.geometry;
      const lo = Math.min(chart.drag.from, index);
      const hi = Math.max(chart.drag.from, index);
      const select = $("#usage-select");
      select.setAttribute("x", g.margin.left + g.step * (lo - g.a));
      select.setAttribute("width", g.step * (hi - lo + 1));
      select.setAttribute("visibility", hi > lo ? "visible" : "hidden");
    }
    showChartHover(index, event);
  });
  const finish = () => {
    if (!chart.drag) return;
    const { from, to } = chart.drag;
    chart.drag = null;
    const g = chart.geometry;
    if (!g || Math.abs(to - from) < 1) {
      $("#usage-select")?.setAttribute("visibility", "hidden");
      return;
    }
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    state.zoom = [g.starts[lo], g.starts[hi]];
    hideTooltip();
    renderUsage();
  };
  container.addEventListener("pointerup", finish);
  container.addEventListener("pointercancel", finish);
  container.addEventListener("pointerleave", () => {
    if (!chart.drag) {
      hideChartHover();
      hideTooltip();
    }
  });
  container.addEventListener("dblclick", resetZoom);
  $("#usage-legend").addEventListener("click", (event) => {
    const chip = event.target.closest("[data-series]");
    if (!chip) return;
    const hidden = hiddenSet();
    const key = chip.dataset.series;
    if (hidden.has(key)) hidden.delete(key);
    else {
      const shown = $$("#usage-legend [data-series]").filter((item) => !hidden.has(item.dataset.series));
      if (shown.length <= 1) return; // keep at least one series visible
      hidden.add(key);
    }
    state.hidden[state.group] = [...hidden];
    savePrefs();
    renderUsage();
  });
  new ResizeObserver(() => {
    if (state.data) {
      renderUsage();
      renderHeatmap();
    }
  }).observe(container);
}

function resetZoom() {
  if (!state.zoom) return;
  state.zoom = null;
  hideTooltip();
  renderUsage();
}

/* ---------- model mix ---------- */

function renderModelMix() {
  const data = state.data;
  const container = $("#model-mix");
  const whole = metricOf(data.totals);
  $("#mix-sub").textContent = `Share of ${METRIC_TEXT[state.metric]}, coloured by subscription`;
  if (!data.models?.length || whole <= 0) {
    container.innerHTML = `<div class="chart-empty">No model activity in this period yet.</div>`;
    return;
  }
  const sorted = [...data.models].sort((x, y) => metricOf(y) - metricOf(x)).filter((model) => metricOf(model) > 0);
  const shown = sorted.slice(0, 7);
  const rows = shown.map((model) => ({
    name: model.model,
    provider: model.provider,
    value: metricOf(model),
    color: providerColor(model.provider),
  }));
  const other = Math.max(0, whole - rows.reduce((sum, row) => sum + row.value, 0));
  if (other > whole * 0.0005) rows.push({ name: "Everything else", provider: null, value: other, color: "var(--other)" });
  const top = Math.max(...rows.map((row) => row.value));
  container.innerHTML = rows
    .map(
      (row) => `<div class="rank-row" title="${escapeHtml(row.name)}: ${fmtMetric(row.value)}${metricUnit()}">
        <span class="rank-name">${escapeHtml(row.name)}${row.provider ? `<small>${escapeHtml(providerLabel(row.provider))}</small>` : ""}</span>
        <span class="rank-value">${fmtShare(row.value, whole)}<small>${fmtMetric(row.value)}</small></span>
        <span class="rank-track"><span style="width:${(row.value / top) * 100}%;--key:${row.color}"></span></span>
      </div>`,
    )
    .join("");
}

/* ---------- model table ---------- */

function composition(model) {
  const reasoning = model.reasoning || 0;
  let input = model.input || 0;
  const cacheRead = model.cacheRead || 0;
  let output = model.output || 0;
  if (model.provider === "codex") input = Math.max(0, input - cacheRead);
  if (model.provider === "claude" || model.provider === "codex") output = Math.max(0, output - reasoning);
  return { input, output, cacheRead, cacheWrite: model.cacheWrite || 0, reasoning };
}

function cell(value) {
  return value > 0 ? fmtTokens(value) : `<span class="dim">—</span>`;
}

function renderModelTable() {
  const data = state.data;
  const body = $("#model-rows");
  if (!data.models?.length) {
    body.innerHTML = `<tr><td colspan="7"><div class="chart-empty">No model activity in this period yet.</div></td></tr>`;
    return;
  }
  body.innerHTML = [...data.models]
    .sort((x, y) => metricOf(y) - metricOf(x))
    .slice(0, 10)
    .map((model) => {
      const parts = composition(model);
      const cacheBase = model.provider === "codex" ? model.input : model.input + model.cacheRead;
      const hit = cacheBase > 0 ? model.cacheRead / cacheBase : null;
      const detail = `Fresh input ${fmtInteger(parts.input)} · output ${fmtInteger(parts.output)} · reasoning ${fmtInteger(parts.reasoning)} · cache write ${fmtInteger(parts.cacheWrite)} · cache read ${fmtInteger(parts.cacheRead)}`;
      return `<tr title="${escapeHtml(detail)}">
        <td><span class="model-cell"><span class="provider-dot" style="--key:${providerColor(model.provider)}"></span><b>${escapeHtml(model.model)}</b><small>${escapeHtml(providerLabel(model.provider))}</small></span></td>
        <td class="num ${state.metric === "tokens" ? "strong" : ""}">${fmtTokens(model.tokens)}</td>
        <td class="num ${state.metric === "fresh" ? "strong" : ""}">${cell(model.fresh)}</td>
        <td class="num">${cell(parts.output + parts.reasoning)}</td>
        <td>${hit == null ? `<span class="dim">—</span>` : `<span class="hit"><span class="hit-track"><span style="width:${hit * 100}%"></span></span><b>${Math.round(hit * 100)}%</b></span>`}</td>
        <td class="num">${fmtInteger(model.events)}</td>
        <td class="num ${state.metric === "cost" ? "strong" : ""}">${model.cost ? fmtUsd(model.cost) : `<span class="dim">free</span>`}</td>
      </tr>`;
    })
    .join("");
}

/* ---------- projects / sessions ---------- */

function renderProjects() {
  const data = state.data;
  const container = $("#project-bars");
  $("#project-sub").textContent = `Where the ${METRIC_TEXT[state.metric]} went`;
  const projects = [...(data.projects ?? [])].sort((x, y) => metricOf(y) - metricOf(x)).filter((p) => metricOf(p) > 0);
  if (!projects.length) {
    container.innerHTML = `<div class="chart-empty">No project activity in this period yet.</div>`;
    return;
  }
  const whole = metricOf(data.totals);
  const max = Math.max(...projects.map(metricOf), 1);
  container.innerHTML = projects
    .slice(0, 8)
    .map(
      (project, index) => `<div class="bar-row" title="${escapeHtml(project.project)}">
        <span class="bar-label">${escapeHtml(projectLabel(project.project))}${projectTrail(project.project) ? `<small>${escapeHtml(projectTrail(project.project))}</small>` : ""}</span>
        <span class="bar-track"><span class="bar-fill ${index === 0 ? "is-top" : ""}" style="width:${(metricOf(project) / max) * 100}%"></span></span>
        <span class="bar-value">${fmtMetric(metricOf(project))}<small>${fmtShare(metricOf(project), whole)}</small></span>
      </div>`,
    )
    .join("");
}

function renderSessions() {
  const data = state.data;
  const container = $("#session-bars");
  const total = data.sessions.reduce((sum, bin) => sum + bin.count, 0);
  const max = Math.max(...data.sessions.map((bin) => bin.count), 0);
  if (max <= 0) {
    container.innerHTML = `<div class="chart-empty">No sessions in this period yet.</div>`;
    return;
  }
  const long = data.sessions
    .filter((bin) => ["1-2h", "2h+"].includes(bin.label))
    .reduce((sum, bin) => sum + bin.count, 0);
  container.innerHTML =
    data.sessions
      .map(
        (bin) => `<div class="bar-row">
        <span class="bar-label">${escapeHtml(bin.label.replace("-", "–"))}</span>
        <span class="bar-track"><span class="bar-fill ${bin.count === max ? "is-top" : ""}" style="width:${(bin.count / max) * 100}%"></span></span>
        <span class="bar-value">${bin.count}<small>${fmtShare(bin.count, total)}</small></span>
      </div>`,
      )
      .join("") +
    `<p class="panel-foot"><b>${long}</b> of ${total} sessions ran over an hour. Long sessions drag big contexts along, which drains a 5-hour window fastest.</p>`;
}

/* ---------- heatmap ---------- */

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function heatColor(ratio) {
  if (ratio <= 0) return "var(--surface-2)";
  const pct = Math.round(14 + 86 * Math.sqrt(ratio));
  return `color-mix(in oklab, var(--heat) ${pct}%, var(--surface))`;
}

function renderHeatmap() {
  const data = state.data;
  const container = $("#heatmap");
  const key = state.metric === "fresh" ? "fresh" : "tokens";
  const grid = data.heatmap?.[key];
  const flat = grid ? grid.flat() : [];
  const max = Math.max(...flat, 0);
  const total = flat.reduce((sum, value) => sum + value, 0);
  $("#heat-scale").innerHTML = `Less ${[0, 0.06, 0.25, 0.55, 1].map((r) => `<i style="background:${heatColor(r)}"></i>`).join("")} More`;
  if (!grid || max <= 0) {
    container.innerHTML = `<div class="chart-empty">No activity in this period yet.</div>`;
    $("#heat-sub").textContent = "Day × hour";
    return;
  }
  let peak = { day: 0, hour: 0, value: -1 };
  grid.forEach((row, day) => row.forEach((value, hour) => {
    if (value > peak.value) peak = { day, hour, value };
  }));
  const night = grid.reduce((sum, row) => sum + row.slice(0, 6).reduce((s, v) => s + v, 0), 0);
  const dayTotals = grid.map((row) => row.reduce((s, v) => s + v, 0));
  const busiestDay = dayTotals.indexOf(Math.max(...dayTotals));
  $("#heat-sub").textContent = `${key === "fresh" ? "Fresh tokens" : "Tokens"}${state.metric === "cost" ? " (API $ not split by hour)" : ""} · busiest slot ${WEEKDAYS[peak.day]} ${hourLabel(peak.hour)}–${hourLabel((peak.hour + 1) % 24)} · busiest day ${WEEKDAYS[busiestDay]} · ${fmtShare(night, total)} between midnight and 6am`;

  const width = Math.max(420, Math.round(container.clientWidth || 800));
  const left = 40;
  const bottom = 22;
  const cellW = (width - left) / 24;
  const cellH = Math.min(34, Math.max(18, cellW * 0.78));
  const height = cellH * 7 + bottom;
  let cells = "";
  grid.forEach((row, day) => {
    cells += `<text class="chart-axis" x="${left - 10}" y="${day * cellH + cellH / 2 + 4}" text-anchor="end">${WEEKDAYS[day]}</text>`;
    row.forEach((value, hour) => {
      const tipId = `heat-${day}-${hour}`;
      tips.set(
        tipId,
        `<strong>${WEEKDAYS[day]} ${hourLabel(hour)}–${hourLabel((hour + 1) % 24)}</strong><div class="tip-row"><span></span><span>${key === "fresh" ? "Fresh tokens" : "Tokens"}</span><b>${fmtTokens(value)}</b></div><div class="tip-row"><span></span><span>Share of period</span><b>${fmtShare(value, total)}</b></div>`,
      );
      cells += `<rect class="heat-cell" data-tip="${tipId}" x="${left + hour * cellW}" y="${day * cellH}" width="${cellW}" height="${cellH}" rx="4" style="fill:${heatColor(value / max)}" />`;
    });
  });
  const labels = [0, 3, 6, 9, 12, 15, 18, 21]
    .map((hour) => `<text class="chart-axis" x="${left + hour * cellW + cellW / 2}" y="${height - 5}" text-anchor="middle">${hourLabel(hour)}</text>`)
    .join("");
  container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Activity by weekday and hour">${cells}${labels}</svg>`;
}

/* ---------- limits ---------- */

const KIND_LABEL = { "5h": "5-hour", weekly: "Weekly", monthly: "Monthly", rolling: "5-hour" };

function renderLimits() {
  const data = state.data;
  const list = $("#limit-list");
  $("#limit-count").textContent = data.limits.length
    ? `${data.limits.length} limit hit${data.limits.length === 1 ? "" : "s"} logged, ${RANGE_TEXT[state.range] ?? "in range"}`
    : `No limit hits logged, ${RANGE_TEXT[state.range] ?? "in range"}`;
  if (!data.limits.length) {
    list.innerHTML = `<li class="limit-empty">Nothing capped in this range. Nice.</li>`;
    return;
  }
  list.innerHTML = data.limits
    .slice(0, 6)
    .map((limit) => {
      const kind = KIND_LABEL[limit.window] ?? KIND_LABEL[limit.kind] ?? (limit.kind || "Limit");
      const reset = limit.resetsAt ? `Reset ${dateTime(limit.resetsAt, { weekday: "short" })}` : "";
      const message = limit.message || `${providerLabel(limit.provider)} ${limit.kind}`;
      return `<li class="limit-item">
        <span class="limit-when"><b>${escapeHtml(dayOnly(limit.timestamp))}</b>${escapeHtml(timeOnly(limit.timestamp))}</span>
        <div class="limit-body">
          <div class="limit-title"><span class="provider-dot" style="--key:${providerColor(limit.provider)}"></span>${escapeHtml(providerLabel(limit.provider))}<span class="limit-kind">${escapeHtml(kind)}</span></div>
          <p class="limit-message" title="${escapeHtml(message)}">${escapeHtml(reset ? `${reset} · ${message}` : message)}</p>
        </div>
      </li>`;
    })
    .join("");
}

/* ---------- live bits ---------- */

function updateFreshness() {
  const element = $("#freshness");
  const copy = $("#freshness-copy");
  if (!state.data) {
    element.className = "freshness";
    copy.textContent = "Connecting";
    return;
  }
  const data = state.data;
  const ingestion = data.ingestion;
  if (ingestion.running) {
    element.className = "freshness is-stale";
    copy.textContent = `Indexing · ${ingestion.label}`;
    element.title = ingestion.errors?.join("\n") ?? "";
    return;
  }
  const age = Date.now() - data.generatedAt;
  const errors = [
    ...(ingestion.errors ?? []),
    ...(!data.go?.ok && data.go?.error ? [`Go API: ${data.go.error}`] : []),
  ];
  const stale = age > 90_000 || errors.length > 0;
  element.className = stale ? "freshness is-stale" : "freshness";
  copy.textContent = errors[0] ?? (age < 60_000 ? "Live · updated just now" : `Updated ${duration(age)} ago`);
  element.title = errors.join("\n");
}

function updateClocks() {
  $$(".reset-line[data-reset]").forEach((element) => {
    const resetAt = Number(element.dataset.reset);
    const label = $(".reset-count", element);
    if (label) {
      label.textContent = resetAt > Date.now() ? `Resets in ${duration(resetAt - Date.now())}` : "Reset passed";
    }
  });
  updateFreshness();
}

/* ---------- tooltip ---------- */

function showTooltip(html, event) {
  const tooltip = $("#tooltip");
  tooltip.innerHTML = html;
  tooltip.classList.add("is-visible");
  const padding = 14;
  const width = tooltip.offsetWidth;
  const height = tooltip.offsetHeight;
  let left = event.clientX + padding;
  let top = event.clientY + padding;
  if (left + width > window.innerWidth - 8) left = event.clientX - width - padding;
  if (top + height > window.innerHeight - 8) top = event.clientY - height - padding;
  tooltip.style.left = `${Math.max(8, left)}px`;
  tooltip.style.top = `${Math.max(8, top)}px`;
}

function hideTooltip() {
  $("#tooltip").classList.remove("is-visible");
}

/* ---------- theme ---------- */

const THEMES = ["system", "light", "dark"];

function applyTheme(theme) {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = theme;
  const button = $("#theme-button");
  const label = `Theme: ${theme === "system" ? "follows system" : theme}`;
  button.setAttribute("aria-label", label);
  button.title = label;
}

/* ---------- actions ---------- */

async function askAdvice() {
  if (state.adviceLoading) return;
  state.adviceLoading = true;
  renderAdvice();
  try {
    const response = await fetch("/api/advice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const body = await response.json();
    if (!response.ok || body.ok === false) toast(body.error || "Advice could not be generated.");
    await refresh();
  } catch (error) {
    toast(`Advice request failed: ${error.message}`);
  } finally {
    state.adviceLoading = false;
    renderAdvice();
  }
}

function bind() {
  $("#refresh-button").addEventListener("click", () => refresh({ manual: true }));
  $("#advice-button").addEventListener("click", askAdvice);
  $("#zoom-reset").addEventListener("click", resetZoom);
  $("#theme-button").addEventListener("click", () => {
    const current = localStorage.getItem("usage-dash-theme") ?? "system";
    const next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
    localStorage.setItem("usage-dash-theme", next);
    applyTheme(next);
  });
  $$("[data-range]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (button.dataset.range === state.range) return;
      state.range = button.dataset.range;
      state.zoom = null;
      savePrefs();
      renderControls();
      await refresh();
    });
  });
  $$("[data-metric]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.metric === state.metric) return;
      state.metric = button.dataset.metric;
      savePrefs();
      if (state.data) renderMetricViews();
    });
  });
  $$("[data-group]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.group === state.group) return;
      state.group = button.dataset.group;
      savePrefs();
      if (state.data) renderUsage();
    });
  });
  $("#resolution-switch").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-resolution]");
    if (!button || button.classList.contains("is-active")) return;
    state.resolution[state.range] = button.dataset.resolution;
    state.zoom = null;
    savePrefs();
    await refresh();
  });
  bindChart();
  document.addEventListener("pointermove", (event) => {
    if (event.target.closest?.("[data-tip-custom]") || chart.drag) return;
    const target = event.target.closest?.("[data-tip]");
    const html = target && tips.get(target.dataset.tip);
    if (html) showTooltip(html, event);
    else hideTooltip();
  });
  document.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Escape") resetZoom();
    if (event.key === "r") refresh({ manual: true });
  });
  // highlight the section currently in view
  const links = new Map($$("[data-nav]").map((link) => [link.dataset.nav, link]));
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          links.forEach((link, id) => link.classList.toggle("is-current", id === entry.target.id));
        }
      }
    },
    { rootMargin: "-40% 0px -55% 0px" },
  );
  links.forEach((_, id) => observer.observe(document.getElementById(id)));
  setInterval(updateClocks, 1000);
  setInterval(() => {
    if (document.visibilityState === "visible" && !state.loading && !chart.drag) refresh();
  }, 60_000);
}

applyTheme(localStorage.getItem("usage-dash-theme") ?? "system");
renderControls();
bind();
refresh({ manual: true });
