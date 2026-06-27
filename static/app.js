const stateField = document.querySelector("#stateField");
const stateSelect = document.querySelector("#stateSelect");
const regionSelect = document.querySelector("#regionSelect");
const filters = document.querySelector("#filters");
const yearFilters = document.querySelector("#yearFilters");
const chart = document.querySelector("#chart");
const ctx = chart.getContext("2d");
const tooltip = document.querySelector("#tooltip");
const colors = {
  combined: "#0f7b6c",
  female: "#b84d80",
  male: "#2f6fbb",
};
const START_YEAR = 1910;
const END_YEAR = 2025;
const NOTE = "SSA data omits names with fewer than 5 births in a sex/year/region.";
const ASSET_ROOT = location.pathname.includes("/static/") ? ".." : ".";
const STATE_NAMES = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  DC: "District of Columbia",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
};
const NATIONAL_CACHE = new Map();
const STATE_CACHE = new Map();

let activePayload = null;
let activeLayout = null;
let yearUpdateTimer = null;

function numberFormat(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function selectedMode() {
  return new FormData(filters).get("mode") || "combined";
}

function selectedYearRange(form) {
  const start = Number(form.get("startYear"));
  const end = Number(form.get("endYear"));
  if (!Number.isInteger(start) || !Number.isInteger(end)) throw new Error("Please choose a valid year range.");
  if (start < START_YEAR || end > END_YEAR || start > end) {
    throw new Error(`Please choose a year range from ${START_YEAR} to ${END_YEAR}.`);
  }
  return { start, end };
}

function updateRegionControls() {
  const usesState = regionSelect.value === "state";
  stateField.hidden = !usesState;
  filters.classList.toggle("is-state", usesState);
}

async function loadStates() {
  const states = Object.entries(STATE_NAMES)
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.code.localeCompare(b.code));
  stateSelect.replaceChildren(
    ...states.map((state) => {
      const option = document.createElement("option");
      option.value = state.code;
      option.textContent = `${state.name} (${state.code})`;
      if (state.code === "CA") option.selected = true;
      return option;
    }),
  );
}

async function loadPopularity() {
  const form = new FormData(filters);
  const yearRange = selectedYearRange(new FormData(yearFilters));
  const payload = await popularityPayload({
    rawName: form.get("name"),
    region: form.get("region"),
    state: form.get("state") || "",
    mode: selectedMode(),
    yearRange,
  });
  activePayload = payload;
  render(payload);
}

async function popularityPayload({ rawName, region, state, mode, yearRange }) {
  const names = canonicalNames(rawName);
  if (!names.length) throw new Error("Please enter at least one name.");
  if (!["combined", "female", "male", "split"].includes(mode)) throw new Error("Unknown gender mode.");

  const nameKeys = names.map((name) => name.toLowerCase());
  const stateCode = state.toUpperCase();
  const counts = region === "state" ? await stateCounts(stateCode, nameKeys) : await nationalCounts(nameKeys);
  const popularity = names.length > 1
    ? { multipleNames: true }
    : region === "state"
      ? await statePopularity(stateCode, nameKeys[0])
      : await nationalPopularity(nameKeys[0]);
  return {
    name: names.join(", "),
    names,
    isAggregate: names.length > 1,
    source: region === "state" ? `${STATE_NAMES[stateCode] || stateCode} (${stateCode})` : "United States",
    range: yearRange,
    mode,
    lines: linesFor(counts, mode, yearRange),
    summary: summarize(counts, mode, yearRange),
    popularity,
    note: NOTE,
  };
}

function canonicalNames(value) {
  const seen = new Set();
  return String(value || "")
    .split(",")
    .map((part) => canonicalName(part))
    .filter((name) => {
      const key = name.toLowerCase();
      if (!name || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function canonicalName(value) {
  const cleaned = String(value || "").trim();
  return cleaned ? `${cleaned.slice(0, 1).toUpperCase()}${cleaned.slice(1).toLowerCase()}` : "";
}

function emptyYears() {
  const counts = {};
  for (let year = START_YEAR; year <= END_YEAR; year += 1) {
    counts[year] = { F: 0, M: 0 };
  }
  return counts;
}

async function nationalCounts(nameKeys) {
  const counts = emptyYears();
  const keySet = new Set(nameKeys);
  await Promise.all(
    Array.from({ length: END_YEAR - START_YEAR + 1 }, (_, index) => START_YEAR + index).map(async (year) => {
      const text = await fetchText(`names/yob${year}.txt`, NATIONAL_CACHE);
      parseNationalYear(text, year, keySet, counts);
    }),
  );
  return counts;
}

async function stateCounts(state, nameKeys) {
  if (!STATE_NAMES[state]) throw new Error("Please choose a valid state.");
  const counts = emptyYears();
  const keySet = new Set(nameKeys);
  const text = await fetchText(`namesbystate/${state}.TXT`, STATE_CACHE);
  parseStateFile(text, keySet, counts);
  return counts;
}

async function nationalPopularity(nameKey) {
  const bySex = { F: new Map(), M: new Map() };
  await Promise.all(
    Array.from({ length: END_YEAR - START_YEAR + 1 }, (_, index) => START_YEAR + index).map(async (year) => {
      const text = await fetchText(`names/yob${year}.txt`, NATIONAL_CACHE);
      addNationalRowsToPopularity(text, bySex);
    }),
  );
  return popularityFromMaps(bySex, nameKey);
}

async function statePopularity(state, nameKey) {
  if (!STATE_NAMES[state]) throw new Error("Please choose a valid state.");
  const text = await fetchText(`namesbystate/${state}.TXT`, STATE_CACHE);
  const bySex = { F: new Map(), M: new Map() };
  addStateRowsToPopularity(text, bySex);
  return popularityFromMaps(bySex, nameKey);
}

function addNationalRowsToPopularity(text, bySex) {
  text.split(/\r?\n/).forEach((line) => {
    if (!line) return;
    const [name, sex, births] = line.split(",");
    addPopularityBirths(bySex, name, sex, Number(births));
  });
}

function addStateRowsToPopularity(text, bySex) {
  text.split(/\r?\n/).forEach((line) => {
    if (!line) return;
    const [, sex, yearText, name, births] = line.split(",");
    const year = Number(yearText);
    if (year >= START_YEAR && year <= END_YEAR) addPopularityBirths(bySex, name, sex, Number(births));
  });
}

function addPopularityBirths(bySex, name, sex, births) {
  if (!name || !["F", "M"].includes(sex)) return;
  const key = name.toLowerCase();
  bySex[sex].set(key, (bySex[sex].get(key) || 0) + births);
}

function popularityFromMaps(bySex, nameKey) {
  return {
    multipleNames: false,
    female: popularityForSex(bySex.F, nameKey),
    male: popularityForSex(bySex.M, nameKey),
  };
}

function popularityForSex(countsByName, nameKey) {
  const totalNames = countsByName.size;
  const births = countsByName.get(nameKey) || 0;
  if (!births) return { rank: null, totalNames, births: 0 };
  const higherCounts = new Set(
    Array.from(countsByName.values()).filter((value) => value > births),
  );
  return { rank: higherCounts.size + 1, totalNames, births };
}

async function fetchText(path, cache) {
  if (!cache.has(path)) {
    cache.set(
      path,
      fetch(`${ASSET_ROOT}/${path}`).then((response) => {
        if (!response.ok) throw new Error(`Could not load ${path}.`);
        return response.text();
      }),
    );
  }
  return cache.get(path);
}

function parseNationalYear(text, year, nameKeys, counts) {
  text.split(/\r?\n/).forEach((line) => {
    if (!line) return;
    const [name, sex, births] = line.split(",");
    if (nameKeys.has(name.toLowerCase())) counts[year][sex] += Number(births);
  });
}

function parseStateFile(text, nameKeys, counts) {
  text.split(/\r?\n/).forEach((line) => {
    if (!line) return;
    const [, sex, yearText, name, births] = line.split(",");
    const year = Number(yearText);
    if (year >= START_YEAR && year <= END_YEAR && nameKeys.has(name.toLowerCase())) {
      counts[year][sex] += Number(births);
    }
  });
}

function linesFor(counts, mode, yearRange) {
  const points = [];
  for (let year = yearRange.start; year <= yearRange.end; year += 1) {
    points.push({
      year,
      female: counts[year].F,
      male: counts[year].M,
      combined: counts[year].F + counts[year].M,
    });
  }

  if (mode === "female") return [{ label: "Female", key: "female", points }];
  if (mode === "male") return [{ label: "Male", key: "male", points }];
  if (mode === "split") {
    return [
      { label: "Female", key: "female", points },
      { label: "Male", key: "male", points },
    ];
  }
  return [{ label: "Combined", key: "combined", points }];
}

function rowValue(row, mode) {
  if (mode === "female") return row.female;
  if (mode === "male") return row.male;
  return row.combined;
}

function summarize(counts, mode, yearRange) {
  const rows = [];
  for (let year = yearRange.start; year <= yearRange.end; year += 1) {
    const female = counts[year].F;
    const male = counts[year].M;
    rows.push({ year, female, male, combined: female + male });
  }
  const peak = rows.reduce((best, row) => (rowValue(row, mode) > rowValue(best, mode) ? row : best), rows[0]);
  const latest = rows[rows.length - 1];
  const observedYears = rows.filter((row) => rowValue(row, mode) > 0).map((row) => row.year);
  return {
    peak,
    latest,
    observedYears,
    hasData: observedYears.length > 0,
    metric: mode === "combined" || mode === "split" ? "combined" : mode,
    peakValue: rowValue(peak, mode),
    latestValue: rowValue(latest, mode),
    total: rows.reduce((sum, row) => sum + rowValue(row, mode), 0),
    femaleTotal: rows.reduce((sum, row) => sum + row.female, 0),
    maleTotal: rows.reduce((sum, row) => sum + row.male, 0),
  };
}

function render(payload) {
  const titleName = payload.isAggregate ? `${payload.name} combined` : payload.name;
  document.querySelector("#chartTitle").textContent = `${titleName} in ${payload.source}`;
  document.querySelector("#chartSubtitle").textContent = payload.summary.hasData
    ? `${payload.range.start}-${payload.range.end}`
    : `No matching SSA rows from ${payload.range.start}-${payload.range.end}`;
  document.querySelector("#sourceNote").textContent = payload.isAggregate
    ? `${payload.note} Comma-separated names are added together year by year.`
    : payload.note;
  renderPopularity(payload.popularity);
  document.querySelector("#peakYear").textContent = payload.summary.hasData ? `in ${payload.summary.peak.year}` : "-";
  document.querySelector("#peakCount").textContent = numberFormat(payload.summary.peakValue);
  document.querySelector("#totalLabel").textContent = `${payload.range.start}-${payload.range.end} total`;
  document.querySelector("#totalCount").textContent = numberFormat(payload.summary.total);
  document.querySelector("#femaleTotal").textContent = numberFormat(payload.summary.femaleTotal);
  document.querySelector("#maleTotal").textContent = numberFormat(payload.summary.maleTotal);
  renderLegend(payload);
  drawChart(payload);
}

function renderPopularity(popularity) {
  const card = document.querySelector("#popularityCard");
  card.classList.toggle("is-not-applicable", popularity.multipleNames);
  document.querySelector("#popularityDetails").hidden = popularity.multipleNames;
  document.querySelector("#popularityNotApplicable").hidden = !popularity.multipleNames;
  if (popularity.multipleNames) return;
  document.querySelector("#femalePopularity").textContent = popularityText(popularity.female);
  document.querySelector("#malePopularity").textContent = popularityText(popularity.male);
}

function popularityText(entry) {
  if (!entry.births) return "-";
  return `#${numberFormat(entry.rank)} of ${numberFormat(entry.totalNames)}`;
}

function renderLegend(payload) {
  const legend = document.querySelector("#legend");
  legend.replaceChildren(
    ...payload.lines.map((line) => {
      const item = document.createElement("span");
      item.className = "legend-item";
      const swatch = document.createElement("span");
      swatch.className = "legend-swatch";
      swatch.style.background = colors[line.key];
      const label = document.createElement("span");
      label.textContent = line.label;
      item.append(swatch, label);
      return item;
    }),
  );
}

function resizeCanvas() {
  const rect = chart.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  chart.width = Math.max(1, Math.round(rect.width * ratio));
  chart.height = Math.max(1, Math.round(rect.height * ratio));
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function drawChart(payload) {
  resizeCanvas();
  const rect = chart.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;
  const pad = {
    top: 22,
    right: 28,
    bottom: 42,
    left: width < 520 ? 48 : 66,
  };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const years = payload.lines[0].points.map((point) => point.year);
  const values = payload.lines.flatMap((line) => line.points.map((point) => point[line.key]));
  const maxValue = Math.max(10, ...values);
  const yMax = niceCeiling(maxValue);
  const yearStart = payload.range.start;
  const yearEnd = payload.range.end;
  const yearSpan = Math.max(1, yearEnd - yearStart);
  const xFor = (year) => pad.left + ((year - yearStart) / yearSpan) * plotWidth;
  const yFor = (value) => pad.top + plotHeight - (value / yMax) * plotHeight;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#fbfcfb";
  ctx.fillRect(0, 0, width, height);

  drawGrid({ width, height, pad, plotWidth, plotHeight, yMax, yFor, xFor, yearStart, yearEnd });

  payload.lines.forEach((line) => {
    ctx.beginPath();
    line.points.forEach((point, index) => {
      const x = xFor(point.year);
      const y = yFor(point[line.key]);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = colors[line.key];
    ctx.lineWidth = 3;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();
  });

  activeLayout = { pad, plotWidth, plotHeight, yMax, xFor, yFor, years, payload, yearStart, yearEnd };
}

function drawGrid({ width, height, pad, plotWidth, plotHeight, yMax, yFor, xFor, yearStart, yearEnd }) {
  ctx.strokeStyle = "#dfe7e2";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#62706b";
  ctx.font = "12px Inter, system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  const yTicks = 5;
  for (let i = 0; i <= yTicks; i += 1) {
    const value = Math.round((yMax / yTicks) * i);
    const y = yFor(value);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
    ctx.fillText(compactNumber(value), pad.left - 10, y);
  }

  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const xTicks = yearTicks(yearStart, yearEnd, width < 520 ? 4 : 7);
  xTicks.forEach((year) => {
    const x = xFor(year);
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, height - pad.bottom);
    ctx.stroke();
    ctx.fillText(String(year), x, height - pad.bottom + 12);
  });

  ctx.strokeStyle = "#aebbb5";
  ctx.beginPath();
  ctx.moveTo(pad.left, pad.top);
  ctx.lineTo(pad.left, pad.top + plotHeight);
  ctx.lineTo(pad.left + plotWidth, pad.top + plotHeight);
  ctx.stroke();
}

function yearTicks(start, end, maxTicks) {
  const span = end - start;
  if (span <= 0) return [start];
  const step = span > 80 ? 20 : span > 40 ? 10 : span > 20 ? 5 : span > 8 ? 2 : 1;
  const ticks = [start];
  let year = Math.ceil(start / step) * step;
  while (year < end) {
    if (year !== start) ticks.push(year);
    year += step;
  }
  ticks.push(end);

  if (ticks.length <= maxTicks) return ticks;
  const compact = [start];
  const inner = ticks.slice(1, -1);
  const stride = Math.ceil(inner.length / Math.max(1, maxTicks - 2));
  inner.forEach((tick, index) => {
    if (index % stride === 0) compact.push(tick);
  });
  compact.push(end);
  return compact.filter((tick, index, list) => list.indexOf(tick) === index);
}

function niceCeiling(value) {
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const nice = normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return nice * magnitude;
}

function compactNumber(value) {
  if (value >= 1000000) return `${trimDecimal(value / 1000000)}M`;
  if (value >= 1000) return `${trimDecimal(value / 1000)}k`;
  return String(value);
}

function trimDecimal(value) {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(1).replace(".0", "");
}

function nearestYear(clientX) {
  if (!activeLayout) return null;
  const rect = chart.getBoundingClientRect();
  const x = clientX - rect.left;
  const yearSpan = activeLayout.yearEnd - activeLayout.yearStart;
  const year = Math.round(
    activeLayout.yearStart + ((x - activeLayout.pad.left) / activeLayout.plotWidth) * yearSpan,
  );
  return Math.min(activeLayout.yearEnd, Math.max(activeLayout.yearStart, year));
}

function showTooltip(event) {
  if (!activeLayout) return;
  const year = nearestYear(event.clientX);
  const rect = chart.getBoundingClientRect();
  const x = activeLayout.xFor(year);
  const rows = activePayload.lines.map((line) => {
    const point = line.points.find((entry) => entry.year === year);
    return `<div><strong style="color:${colors[line.key]}">${line.label}</strong>: ${numberFormat(point[line.key])}</div>`;
  });
  tooltip.innerHTML = `<div><strong>${year}</strong></div>${rows.join("")}`;
  tooltip.hidden = false;
  tooltip.style.left = `${Math.min(rect.width - 76, Math.max(76, x))}px`;
  tooltip.style.top = `${Math.max(54, event.clientY - rect.top)}px`;
}

function hideTooltip() {
  tooltip.hidden = true;
}

filters.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await loadPopularity();
  } catch (error) {
    document.querySelector("#chartTitle").textContent = error.message;
  }
});

filters.addEventListener("change", (event) => {
  if (event.target === regionSelect) updateRegionControls();
  loadPopularity().catch((error) => {
    document.querySelector("#chartTitle").textContent = error.message;
  });
});

yearFilters.addEventListener("submit", (event) => {
  event.preventDefault();
  loadPopularity().catch((error) => {
    document.querySelector("#chartTitle").textContent = error.message;
  });
});

yearFilters.addEventListener("change", () => {
  loadPopularity().catch((error) => {
    document.querySelector("#chartTitle").textContent = error.message;
  });
});

yearFilters.addEventListener("input", () => {
  window.clearTimeout(yearUpdateTimer);
  yearUpdateTimer = window.setTimeout(() => {
    loadPopularity().catch((error) => {
      document.querySelector("#chartTitle").textContent = error.message;
    });
  }, 400);
});

chart.addEventListener("mousemove", showTooltip);
chart.addEventListener("mouseleave", hideTooltip);
window.addEventListener("resize", () => {
  if (activePayload) drawChart(activePayload);
});

updateRegionControls();
loadStates()
  .then(loadPopularity)
  .catch((error) => {
    document.querySelector("#chartTitle").textContent = error.message;
  });
