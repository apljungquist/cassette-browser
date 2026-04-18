import { diffLines, diffChars } from "https://esm.sh/diff@7.0.0";

// --- State ---

let manifest = null;
let fileIndex = null; // { "test/hash": [ {seq, checksum, type} ] }
let fetchCache = new Map();
let currentView = "diff";
let matrixCache = null;

// --- Config & URLs ---

async function loadConfig() {
  const resp = await fetch("config.json");
  return resp.json();
}

function rawBase(config) {
  return `https://raw.githubusercontent.com/${config.cassettesOwner}/${config.cassettesRepo}/refs/heads/${config.cassettesRef}`;
}

function jsdelivrUrl(config) {
  return `https://data.jsdelivr.com/v1/packages/gh/${config.cassettesOwner}/${config.cassettesRepo}@${config.cassettesRef}?structure=flat`;
}

// --- Fetching ---

async function cachedFetch(url) {
  if (fetchCache.has(url)) return fetchCache.get(url);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to load ${url} (${resp.status})`);
  const text = await resp.text();
  fetchCache.set(url, text);
  return text;
}

async function fetchStartupData(config) {
  const [manifestText, listingText] = await Promise.all([
    fetch(`${rawBase(config)}/manifest.json`).then(r => {
      if (!r.ok) throw new Error(`Manifest fetch failed (${r.status})`);
      return r.json();
    }),
    fetch(jsdelivrUrl(config)).then(r => {
      if (!r.ok) throw new Error(`jsDelivr listing failed (${r.status})`);
      return r.json();
    }),
  ]);
  return { manifest: manifestText, listing: listingText };
}

// --- Build file index from jsDelivr listing ---
// Returns Map: "test/hash" -> [ {seq: "000", checksum: "abc", type: "request"|"response"} ]

function buildFileIndex(listing) {
  const index = new Map();
  const re = /^\/([^/]+)\/([^/]+)\/(\d+)-([0-9a-f]+)-(request|response)$/;
  for (const file of listing.files) {
    const m = file.name.match(re);
    if (!m) continue;
    const [, test, hash, seq, checksum, type] = m;
    const key = `${test}/${hash}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push({ seq, checksum, type });
  }
  sortFileIndex(index);
  return index;
}

// Supplement file index with entries from GitHub Trees API for tests
// that are in the manifest but missing from jsDelivr.
async function supplementFileIndex(config, index) {
  const allPresent = Object.keys(manifest.cassettes).every(test =>
    Object.keys(manifest.cassettes[test]).some(hash => index.has(`${test}/${hash}`))
  );
  if (allPresent) return;

  const url = `https://api.github.com/repos/${config.cassettesOwner}/${config.cassettesRepo}/git/trees/${config.cassettesRef}?recursive=1`;
  const resp = await fetch(url);
  if (!resp.ok) return;
  const data = await resp.json();

  const existingKeys = new Set(index.keys());
  const re = /^([^/]+)\/([^/]+)\/(\d+)-([0-9a-f]+)-(request|response)$/;
  for (const item of data.tree) {
    if (item.type !== "blob") continue;
    const m = item.path.match(re);
    if (!m) continue;
    const [, test, hash, seq, checksum, type] = m;
    const key = `${test}/${hash}`;
    if (existingKeys.has(key)) continue;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push({ seq, checksum, type });
  }
  sortFileIndex(index);
}

function sortFileIndex(index) {
  for (const entries of index.values()) {
    entries.sort((a, b) => {
      if (a.seq !== b.seq) return a.seq.localeCompare(b.seq);
      return a.type === "request" ? -1 : 1;
    });
  }
}

// --- Get tracks for a test/hash ---
// Returns [ {seq, requestFile, responseFile} ]

function getTracks(test, hash) {
  const key = `${test}/${hash}`;
  const entries = fileIndex.get(key);
  if (!entries) return [];
  const bySeq = new Map();
  for (const e of entries) {
    if (!bySeq.has(e.seq)) bySeq.set(e.seq, {});
    const track = bySeq.get(e.seq);
    track.seq = e.seq;
    const filename = `${e.seq}-${e.checksum}-${e.type}`;
    if (e.type === "request") track.requestFile = `${test}/${hash}/${filename}`;
    else track.responseFile = `${test}/${hash}/${filename}`;
  }
  return Array.from(bySeq.values()).sort((a, b) => a.seq.localeCompare(b.seq));
}

// --- Fetch track content ---

async function fetchTrackContent(config, track) {
  const base = rawBase(config);
  const [req, res] = await Promise.all([
    track.requestFile ? cachedFetch(`${base}/${track.requestFile}`) : Promise.resolve(""),
    track.responseFile ? cachedFetch(`${base}/${track.responseFile}`) : Promise.resolve(""),
  ]);
  return { request: req, response: res };
}

// --- Dropdown population ---

function populateTestDropdown(select) {
  select.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select a test…";
  select.appendChild(placeholder);

  const tests = Object.keys(manifest.cassettes).sort();
  for (const t of tests) {
    const opt = document.createElement("option");
    opt.value = t;
    opt.textContent = t;
    select.appendChild(opt);
  }
}

function getDeviceStatus(test, deviceKey) {
  // Check if device has a cassette for this test
  const cassettes = manifest.cassettes[test];
  if (cassettes) {
    for (const [hash, devices] of Object.entries(cassettes)) {
      if (devices.includes(deviceKey)) return { status: "available", hash };
    }
  }
  // Check skipped
  const skipped = manifest.skipped[test];
  if (skipped && skipped.includes(deviceKey)) return { status: "skipped", hash: null };
  return { status: "no-data", hash: null };
}

function populateDeviceDropdown(select, currentTest) {
  const previousValue = select.value;
  select.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select a device…";
  select.appendChild(placeholder);

  // Group devices by prod_nbr
  const groups = new Map();
  for (const [key, dev] of Object.entries(manifest.devices)) {
    if (!groups.has(dev.prod_nbr)) groups.set(dev.prod_nbr, []);
    groups.get(dev.prod_nbr).push({ key, prod_nbr: dev.prod_nbr, version: dev.version });
  }

  for (const [prodNbr, devices] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = prodNbr;
    devices.sort((a, b) => a.version.localeCompare(b.version));
    for (const dev of devices) {
      const opt = document.createElement("option");
      opt.value = dev.key;
      const label = `${dev.prod_nbr} ${dev.version}`;
      const info = currentTest ? getDeviceStatus(currentTest, dev.key) : { status: "no-data" };
      if (info.status === "available") {
        opt.textContent = label;
      } else if (info.status === "skipped") {
        opt.textContent = `${label} — skipped`;
        opt.disabled = true;
      } else {
        continue;
      }
      optgroup.appendChild(opt);
    }
    select.appendChild(optgroup);
  }

  // Restore previous selection
  if (previousValue) {
    select.value = previousValue;
  }
}

// --- Hash sync ---

function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  return {
    view: params.get("view") || "diff",
    test: params.get("test") || "",
    left: params.get("left") || "",
    right: params.get("right") || "",
  };
}

function writeHash(test, left, right) {
  const params = new URLSearchParams();
  if (currentView !== "diff") params.set("view", currentView);
  if (test) params.set("test", test);
  if (left) params.set("left", left);
  if (right) params.set("right", right);
  const newHash = params.toString();
  if (location.hash.slice(1) !== newHash) {
    history.pushState(null, "", `#${newHash}`);
  }
}

// --- Diff rendering ---

function renderCharDiff(oldStr, newStr) {
  const parts = diffChars(oldStr, newStr);
  const leftSpans = [];
  const rightSpans = [];
  for (const part of parts) {
    if (part.added) {
      rightSpans.push(`<span class="diff-char-add">${escapeHtml(part.value)}</span>`);
    } else if (part.removed) {
      leftSpans.push(`<span class="diff-char-remove">${escapeHtml(part.value)}</span>`);
    } else {
      leftSpans.push(escapeHtml(part.value));
      rightSpans.push(escapeHtml(part.value));
    }
  }
  return { left: leftSpans.join(""), right: rightSpans.join("") };
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Build content string for a track: request + separator + response, with segment markers
function buildTrackText(content) {
  return content.request + "\n---\n" + content.response;
}

// Render side-by-side diff for one track
function renderSideBySide(leftText, rightText) {
  const changes = diffLines(leftText, rightText);

  const leftLines = [];
  const rightLines = [];

  let i = 0;
  while (i < changes.length) {
    const change = changes[i];
    if (!change.added && !change.removed) {
      // Context lines
      const lines = splitLines(change.value);
      for (const line of lines) {
        leftLines.push({ type: "context", html: escapeHtml(line) });
        rightLines.push({ type: "context", html: escapeHtml(line) });
      }
      i++;
    } else if (change.removed && i + 1 < changes.length && changes[i + 1].added) {
      // Paired remove+add: apply char-level diff within
      const removedLines = splitLines(change.value);
      const addedLines = splitLines(changes[i + 1].value);
      const maxLen = Math.max(removedLines.length, addedLines.length);
      for (let j = 0; j < maxLen; j++) {
        const oldLine = j < removedLines.length ? removedLines[j] : "";
        const newLine = j < addedLines.length ? addedLines[j] : "";
        if (j >= removedLines.length) {
          leftLines.push({ type: "empty", html: "" });
          rightLines.push({ type: "add", html: escapeHtml(newLine) });
        } else if (j >= addedLines.length) {
          leftLines.push({ type: "remove", html: escapeHtml(oldLine) });
          rightLines.push({ type: "empty", html: "" });
        } else {
          const charDiff = renderCharDiff(oldLine, newLine);
          leftLines.push({ type: "remove", html: charDiff.left });
          rightLines.push({ type: "add", html: charDiff.right });
        }
      }
      i += 2;
    } else if (change.removed) {
      const lines = splitLines(change.value);
      for (const line of lines) {
        leftLines.push({ type: "remove", html: escapeHtml(line) });
        rightLines.push({ type: "empty", html: "" });
      }
      i++;
    } else if (change.added) {
      const lines = splitLines(change.value);
      for (const line of lines) {
        leftLines.push({ type: "empty", html: "" });
        rightLines.push({ type: "add", html: escapeHtml(line) });
      }
      i++;
    } else {
      i++;
    }
  }

  return { leftLines, rightLines };
}

// Render unified diff for one track
function renderUnified(leftText, rightText) {
  const changes = diffLines(leftText, rightText);
  const lines = [];

  let i = 0;
  while (i < changes.length) {
    const change = changes[i];
    if (!change.added && !change.removed) {
      for (const line of splitLines(change.value)) {
        lines.push({ type: "context", html: escapeHtml(line) });
      }
      i++;
    } else if (change.removed && i + 1 < changes.length && changes[i + 1].added) {
      const removedLines = splitLines(change.value);
      const addedLines = splitLines(changes[i + 1].value);
      // Show char-level diff within paired lines
      const maxLen = Math.max(removedLines.length, addedLines.length);
      for (let j = 0; j < maxLen; j++) {
        const oldLine = j < removedLines.length ? removedLines[j] : null;
        const newLine = j < addedLines.length ? addedLines[j] : null;
        if (oldLine !== null && newLine !== null) {
          const charDiff = renderCharDiff(oldLine, newLine);
          lines.push({ type: "remove", html: charDiff.left });
          lines.push({ type: "add", html: charDiff.right });
        } else if (oldLine !== null) {
          lines.push({ type: "remove", html: escapeHtml(oldLine) });
        } else {
          lines.push({ type: "add", html: escapeHtml(newLine) });
        }
      }
      i += 2;
    } else if (change.removed) {
      for (const line of splitLines(change.value)) {
        lines.push({ type: "remove", html: escapeHtml(line) });
      }
      i++;
    } else if (change.added) {
      for (const line of splitLines(change.value)) {
        lines.push({ type: "add", html: escapeHtml(line) });
      }
      i++;
    } else {
      i++;
    }
  }

  return lines;
}

function splitLines(text) {
  if (!text) return [];
  // Split but keep final empty string if text ends with newline
  const lines = text.split("\n");
  // Remove trailing empty entry from split
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function lineTypeClass(type) {
  switch (type) {
    case "add": return "diff-line diff-line-add";
    case "remove": return "diff-line diff-line-remove";
    case "empty": return "diff-line diff-line-empty";
    case "context": return "diff-line diff-line-context";
    default: return "diff-line";
  }
}

// Apply segment styling (request/response borders) to rendered lines
function applySegments(linesHtml, trackText) {
  const textLines = splitLines(trackText);
  // Find the separator index
  let sepIdx = -1;
  for (let i = 0; i < textLines.length; i++) {
    if (textLines[i] === "---") { sepIdx = i; break; }
  }
  // Map: lines before sep are request, after are response
  // The linesHtml may have more/fewer lines due to diff padding,
  // so we use the separator position from the text
  return { sepIdx, totalLines: textLines.length };
}

// Wrap lines in segment containers
function wrapInSegments(linesHtml, text) {
  const textLines = splitLines(text);
  let sepIdx = textLines.indexOf("---");
  if (sepIdx === -1) sepIdx = textLines.length;

  const segments = [];

  // Request segment
  const reqLines = linesHtml.slice(0, sepIdx);
  if (reqLines.length > 0) {
    segments.push({ type: "request", lines: reqLines });
  }

  // Skip separator line
  const sepLine = sepIdx < linesHtml.length ? [linesHtml[sepIdx]] : [];

  // Response segment
  const resLines = linesHtml.slice(sepIdx + 1);
  if (resLines.length > 0) {
    segments.push({ type: "response", lines: resLines });
  }

  return segments;
}

function renderSegmentsHtml(segments) {
  let html = "";
  for (const seg of segments) {
    html += `<div class="segment-${seg.type}">`;
    html += `<div class="segment-label">${seg.type}</div>`;
    for (const line of seg.lines) {
      html += line;
    }
    html += `</div>`;
    html += `<hr class="segment-separator">`;
  }
  // Remove trailing separator
  if (html.endsWith(`<hr class="segment-separator">`)) {
    html = html.slice(0, -`<hr class="segment-separator">`.length);
  }
  return html;
}

// --- Main render ---

function renderDiffLineHtml(line) {
  return `<div class="${lineTypeClass(line.type)}">${line.html}</div>`;
}

function renderTrackSideBySide(leftText, rightText, trackLabel) {
  const { leftLines, rightLines } = renderSideBySide(leftText, rightText);

  const leftHtmlLines = leftLines.map(renderDiffLineHtml);
  const rightHtmlLines = rightLines.map(renderDiffLineHtml);

  const leftSegments = wrapInSegments(leftHtmlLines, leftText);
  const rightSegments = wrapInSegments(rightHtmlLines, rightText);

  return `
    <div class="track-section">
      <div class="track-header">${escapeHtml(trackLabel)}</div>
      <div class="diff-columns">
        <div class="diff-col">
          <div class="diff-col-header">Left</div>
          ${renderSegmentsHtml(leftSegments)}
        </div>
        <div class="diff-col">
          <div class="diff-col-header">Right</div>
          ${renderSegmentsHtml(rightSegments)}
        </div>
      </div>
      <div class="diff-unified">
        ${renderUnifiedHtml(leftText, rightText)}
      </div>
    </div>
  `;
}

function renderUnifiedHtml(leftText, rightText) {
  const lines = renderUnified(leftText, rightText);
  // For unified, we don't do segment wrappers — just render with line prefixes
  return lines.map(renderDiffLineHtml).join("");
}

function renderTrackOneSide(text, side, trackLabel) {
  const lines = splitLines(text).map(line => ({
    type: side === "left" ? "remove" : "add",
    html: escapeHtml(line),
  }));
  const htmlLines = lines.map(renderDiffLineHtml);
  const segments = wrapInSegments(htmlLines, text);

  const emptyLabel = "No data";
  const leftContent = side === "left"
    ? renderSegmentsHtml(segments)
    : `<div class="diff-col-empty">${emptyLabel}</div>`;
  const rightContent = side === "right"
    ? renderSegmentsHtml(segments)
    : `<div class="diff-col-empty">${emptyLabel}</div>`;

  return `
    <div class="track-section">
      <div class="track-header">${escapeHtml(trackLabel)}</div>
      <div class="diff-columns">
        <div class="diff-col">
          <div class="diff-col-header">Left</div>
          ${leftContent}
        </div>
        <div class="diff-col">
          <div class="diff-col-header">Right</div>
          ${rightContent}
        </div>
      </div>
      <div class="diff-unified">
        ${lines.map(renderDiffLineHtml).join("")}
      </div>
    </div>
  `;
}

function renderSkippedSide(otherText, skippedSide, trackLabel) {
  const lines = splitLines(otherText).map(line => ({
    type: skippedSide === "left" ? "add" : "remove",
    html: escapeHtml(line),
  }));
  const htmlLines = lines.map(renderDiffLineHtml);
  const segments = wrapInSegments(htmlLines, otherText);

  const skippedContent = `<div class="diff-col-empty">Skipped</div>`;
  const dataContent = renderSegmentsHtml(segments);

  return `
    <div class="track-section">
      <div class="track-header">${escapeHtml(trackLabel)}</div>
      <div class="diff-columns">
        <div class="diff-col">
          <div class="diff-col-header">Left</div>
          ${skippedSide === "left" ? skippedContent : dataContent}
        </div>
        <div class="diff-col">
          <div class="diff-col-header">Right</div>
          ${skippedSide === "right" ? skippedContent : dataContent}
        </div>
      </div>
      <div class="diff-unified">
        ${lines.map(renderDiffLineHtml).join("")}
      </div>
    </div>
  `;
}

function renderIdenticalContent(text, trackLabel) {
  const lines = splitLines(text).map(line => ({
    type: "context",
    html: escapeHtml(line),
  }));
  const htmlLines = lines.map(renderDiffLineHtml);
  const segments = wrapInSegments(htmlLines, text);

  return `
    <div class="track-section">
      <div class="track-header">${escapeHtml(trackLabel)}</div>
      <div class="identical-content">
        ${renderSegmentsHtml(segments)}
      </div>
    </div>
  `;
}

// --- Main update logic ---

const diffPane = document.getElementById("diff-pane");
const testSelect = document.getElementById("test-select");
const leftSelect = document.getElementById("left-select");
const rightSelect = document.getElementById("right-select");

let appConfig = null;

async function updateDiff() {
  const test = testSelect.value;
  const left = leftSelect.value;
  const right = rightSelect.value;

  writeHash(test, left, right);

  // Update device annotations when test changes
  populateDeviceDropdown(leftSelect, test);
  populateDeviceDropdown(rightSelect, test);
  // Restore values after repopulation
  leftSelect.value = left;
  rightSelect.value = right;

  if (!test) {
    diffPane.innerHTML = `<div class="banner banner-info">Select a test to begin.</div>`;
    return;
  }

  if (!left && !right) {
    diffPane.innerHTML = `<div class="banner banner-info">Select devices to compare.</div>`;
    return;
  }

  if (!left || !right) {
    diffPane.innerHTML = `<div class="banner banner-info">Select a second device to compare.</div>`;
    return;
  }

  const leftStatus = getDeviceStatus(test, left);
  const rightStatus = getDeviceStatus(test, right);

  // Both sides have no data or are skipped
  if (leftStatus.status !== "available" && rightStatus.status !== "available") {
    const leftLabel = leftStatus.status === "skipped" ? "skipped" : "no data";
    const rightLabel = rightStatus.status === "skipped" ? "skipped" : "no data";
    diffPane.innerHTML = `<div class="banner banner-warn">No recorded data for this combination (left: ${leftLabel}, right: ${rightLabel}).</div>`;
    return;
  }

  // Identical cassettes
  if (leftStatus.hash && rightStatus.hash && leftStatus.hash === rightStatus.hash) {
    diffPane.innerHTML = `<div class="banner banner-info">Identical cassette — no differences.</div><div id="diff-content">Loading…</div>`;
    try {
      const tracks = getTracks(test, leftStatus.hash);
      const contents = await Promise.all(tracks.map(t => fetchTrackContent(appConfig, t)));
      let html = `<div class="banner banner-info">Identical cassette — no differences.</div>`;
      for (let i = 0; i < tracks.length; i++) {
        const text = buildTrackText(contents[i]);
        html += renderIdenticalContent(text, `Track ${tracks[i].seq}`);
      }
      diffPane.innerHTML = html;
    } catch (err) {
      diffPane.innerHTML = `<div class="banner banner-error">${escapeHtml(err.message)}</div>`;
    }
    return;
  }

  // One side skipped/no-data
  if (leftStatus.status !== "available" || rightStatus.status !== "available") {
    const availableSide = leftStatus.status === "available" ? "left" : "right";
    const skippedSide = availableSide === "left" ? "right" : "left";
    const availableHash = availableSide === "left" ? leftStatus.hash : rightStatus.hash;
    const skippedStatus = availableSide === "left" ? rightStatus.status : leftStatus.status;

    diffPane.innerHTML = `<div>Loading…</div>`;
    try {
      const tracks = getTracks(test, availableHash);
      const contents = await Promise.all(tracks.map(t => fetchTrackContent(appConfig, t)));
      let html = "";
      for (let i = 0; i < tracks.length; i++) {
        const text = buildTrackText(contents[i]);
        if (skippedStatus === "skipped") {
          html += renderSkippedSide(text, skippedSide, `Track ${tracks[i].seq}`);
        } else {
          html += renderTrackOneSide(text, availableSide, `Track ${tracks[i].seq}`);
        }
      }
      diffPane.innerHTML = html;
    } catch (err) {
      diffPane.innerHTML = `<div class="banner banner-error">${escapeHtml(err.message)}</div>`;
    }
    return;
  }

  // Normal diff: both sides have data
  diffPane.innerHTML = `<div>Loading…</div>`;
  try {
    const leftTracks = getTracks(test, leftStatus.hash);
    const rightTracks = getTracks(test, rightStatus.hash);
    const maxTracks = Math.max(leftTracks.length, rightTracks.length);

    const [leftContents, rightContents] = await Promise.all([
      Promise.all(leftTracks.map(t => fetchTrackContent(appConfig, t))),
      Promise.all(rightTracks.map(t => fetchTrackContent(appConfig, t))),
    ]);

    let html = "";
    for (let i = 0; i < maxTracks; i++) {
      const seq = i < leftTracks.length ? leftTracks[i].seq : (i < rightTracks.length ? rightTracks[i].seq : String(i).padStart(3, "0"));
      const label = `Track ${seq}`;

      if (i >= leftTracks.length) {
        const text = buildTrackText(rightContents[i]);
        html += renderTrackOneSide(text, "right", label);
      } else if (i >= rightTracks.length) {
        const text = buildTrackText(leftContents[i]);
        html += renderTrackOneSide(text, "left", label);
      } else {
        const leftText = buildTrackText(leftContents[i]);
        const rightText = buildTrackText(rightContents[i]);
        html += renderTrackSideBySide(leftText, rightText, label);
      }
    }
    diffPane.innerHTML = html;
  } catch (err) {
    diffPane.innerHTML = `<div class="banner banner-error">${escapeHtml(err.message)}</div>`;
  }
}

// --- Compatibility matrix ---

function parseApiListResponse(responseText) {
  const bodyStart = responseText.indexOf("\n\n");
  if (bodyStart === -1) return null;
  try {
    const json = JSON.parse(responseText.slice(bodyStart + 2));
    return json.data?.apiList || null;
  } catch {
    return null;
  }
}

async function buildMatrixData() {
  const testName = Object.keys(manifest.cassettes).find(t => t.includes("get_api_list"));
  if (!testName) return null;

  const cassettes = manifest.cassettes[testName];
  const deviceApis = new Map();

  const fetchPromises = [];
  for (const [hash, deviceKeys] of Object.entries(cassettes)) {
    fetchPromises.push((async () => {
      const tracks = getTracks(testName, hash);
      if (tracks.length === 0) return;
      const content = await fetchTrackContent(appConfig, tracks[0]);
      const apiList = parseApiListResponse(content.response);
      if (!apiList) return;
      for (const deviceKey of deviceKeys) {
        deviceApis.set(deviceKey, apiList);
      }
    })());
  }

  await Promise.all(fetchPromises);
  return deviceApis;
}

function renderMatrix(deviceApis) {
  const allApis = new Set();
  for (const apiList of deviceApis.values()) {
    for (const api of apiList) allApis.add(api.id);
  }
  const sortedApis = [...allApis].sort();

  const sortedDevices = [...deviceApis.keys()].sort((a, b) => {
    const da = manifest.devices[a];
    const db = manifest.devices[b];
    const cmp = da.prod_nbr.localeCompare(db.prod_nbr);
    return cmp !== 0 ? cmp : da.version.localeCompare(db.version);
  });

  const lookup = new Map();
  for (const [deviceKey, apiList] of deviceApis) {
    const map = new Map();
    for (const api of apiList) map.set(api.id, api.version);
    lookup.set(deviceKey, map);
  }

  let html = '<div class="matrix-wrap"><table class="matrix">';
  html += '<thead><tr><th class="matrix-corner"></th>';
  for (const dk of sortedDevices) {
    const d = manifest.devices[dk];
    html += `<th class="matrix-dev"><div class="matrix-dev-inner"><span class="matrix-prod">${escapeHtml(d.prod_nbr)}</span><span class="matrix-ver">${escapeHtml(d.version)}</span></div></th>`;
  }
  html += '</tr></thead><tbody>';

  for (const apiId of sortedApis) {
    const versions = new Set();
    for (const dk of sortedDevices) {
      const v = lookup.get(dk)?.get(apiId);
      if (v) versions.add(v);
    }
    const uniform = versions.size <= 1;

    html += `<tr><td class="matrix-api">${escapeHtml(apiId)}</td>`;
    for (const dk of sortedDevices) {
      const v = lookup.get(dk)?.get(apiId);
      if (v) {
        const cls = uniform ? "matrix-cell matrix-cell-ok" : "matrix-cell matrix-cell-vary";
        html += `<td class="${cls}">${escapeHtml(v)}</td>`;
      } else {
        html += `<td class="matrix-cell matrix-cell-no"></td>`;
      }
    }
    html += '</tr>';
  }

  html += '</tbody></table></div>';
  return html;
}

async function renderMatrixView() {
  diffPane.innerHTML = '<div class="banner banner-info">Loading compatibility matrix\u2026</div>';
  try {
    if (!matrixCache) {
      matrixCache = await buildMatrixData();
    }
    if (!matrixCache || matrixCache.size === 0) {
      diffPane.innerHTML = '<div class="banner banner-warn">No API discovery data found.</div>';
      return;
    }
    diffPane.innerHTML = renderMatrix(matrixCache);
  } catch (err) {
    diffPane.innerHTML = `<div class="banner banner-error">${escapeHtml(err.message)}</div>`;
  }
}

// --- View switching ---

function updateNavAndControls() {
  document.querySelectorAll(".nav-tab").forEach(tab => {
    tab.classList.toggle("active", tab.dataset.view === currentView);
  });
  document.getElementById("controls").style.display = currentView === "diff" ? "" : "none";
}

function switchView(view) {
  if (view === currentView) return;
  currentView = view;
  updateNavAndControls();

  const params = new URLSearchParams(location.hash.slice(1));
  if (view === "diff") {
    params.delete("view");
  } else {
    params.set("view", view);
  }
  const newHash = params.toString();
  if (location.hash.slice(1) !== newHash) {
    history.pushState(null, "", `#${newHash}`);
  }

  if (view === "matrix") {
    renderMatrixView();
  } else {
    updateDiff();
  }
}

// --- Init ---

async function init() {
  try {
    appConfig = await loadConfig();
    const { manifest: m, listing } = await fetchStartupData(appConfig);
    manifest = m;
    fileIndex = buildFileIndex(listing);
    await supplementFileIndex(appConfig, fileIndex);

    populateTestDropdown(testSelect);
    populateDeviceDropdown(leftSelect, "");
    populateDeviceDropdown(rightSelect, "");

    // Nav handlers
    document.querySelectorAll(".nav-tab").forEach(tab => {
      tab.addEventListener("click", (e) => {
        e.preventDefault();
        switchView(tab.dataset.view);
      });
    });

    // Rehydrate from hash
    const hash = readHash();
    currentView = hash.view;

    if (hash.test) {
      testSelect.value = hash.test;
      populateDeviceDropdown(leftSelect, hash.test);
      populateDeviceDropdown(rightSelect, hash.test);
      if (hash.left) leftSelect.value = hash.left;
      if (hash.right) rightSelect.value = hash.right;
    } else if (testSelect.options.length > 1) {
      testSelect.value = testSelect.options[1].value;
    }

    testSelect.addEventListener("change", updateDiff);
    leftSelect.addEventListener("change", updateDiff);
    rightSelect.addEventListener("change", updateDiff);
    window.addEventListener("hashchange", () => {
      const h = readHash();
      if (h.view !== currentView) {
        currentView = h.view;
        updateNavAndControls();
        if (h.view === "matrix") {
          renderMatrixView();
        } else {
          testSelect.value = h.test;
          leftSelect.value = h.left;
          rightSelect.value = h.right;
          updateDiff();
        }
      } else if (currentView === "diff") {
        testSelect.value = h.test;
        leftSelect.value = h.left;
        rightSelect.value = h.right;
        updateDiff();
      }
    });

    // Apply initial view
    updateNavAndControls();
    if (currentView === "matrix") {
      await renderMatrixView();
    } else {
      await updateDiff();
    }
  } catch (err) {
    diffPane.innerHTML = `<div class="banner banner-error">Failed to initialize: ${escapeHtml(err.message)}</div>`;
  }
}

init();
