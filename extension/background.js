// CS2 Meta Engine — HLTV demo import (service worker).
//
// Flow, started only by the user clicking the button on an HLTV match page:
//   1. POST the page the user is viewing to <backend>/api/import/hltv-page
//   2. chrome.downloads.download() each demo link the backend found
//      (a normal browser download, with the user's own session)
//   3. when a download completes, POST its path to /api/import/hltv-download
//   4. report progress back to the tab's button
//
// No other requests to HLTV are made. Download bookkeeping lives in
// chrome.storage.session so it survives the service worker being suspended.

const DEFAULTS = { backendUrl: "http://localhost:8000", adminToken: "" };
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

async function getConfig() {
  const cfg = await chrome.storage.local.get(DEFAULTS);
  const backendUrl = String(cfg.backendUrl || DEFAULTS.backendUrl).replace(/\/+$/, "");
  return { backendUrl, adminToken: String(cfg.adminToken || "") };
}

async function ensureBackendPermission(backendUrl) {
  let url;
  try {
    url = new URL(backendUrl);
  } catch {
    throw new Error("Backend URL is invalid — fix it in the extension options.");
  }
  if (LOCAL_HOSTS.has(url.hostname)) return;
  const ok = await chrome.permissions.contains({ origins: [`${url.origin}/*`] });
  if (!ok) {
    throw new Error("No access to the backend yet — open the extension options and click Save.");
  }
}

async function callBackend(path, body) {
  const { backendUrl, adminToken } = await getConfig();
  await ensureBackendPermission(backendUrl);
  const headers = { "Content-Type": "application/json" };
  if (adminToken) headers["X-Admin-Token"] = adminToken;
  let res;
  try {
    res = await fetch(`${backendUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(`Can't reach the backend at ${backendUrl} — is it running?`);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    let detail = data && typeof data.detail === "string" ? data.detail : `HTTP ${res.status}`;
    if (res.status === 401) detail = "Admin token required — set it in the extension options.";
    throw new Error(detail);
  }
  return data;
}

// Calling an extension API every ~20 s keeps the worker alive while a long
// request (archive extraction) is in flight.
async function withKeepAlive(promise) {
  const timer = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  try {
    return await promise;
  } finally {
    clearInterval(timer);
  }
}

function notifyTab(tabId, matchId, state, text) {
  if (tabId == null) return;
  chrome.tabs
    .sendMessage(tabId, { type: "cs2me-progress", matchId, state, text })
    .catch(() => {
      // tab closed or navigated away — nothing to update
    });
}

const matchKey = (matchId) => `match:${matchId}`;
const downloadKey = (downloadId) => `dl:${downloadId}`;

async function getMatchJob(matchId) {
  const key = matchKey(matchId);
  return (await chrome.storage.session.get(key))[key] || null;
}

async function saveMatchJob(job) {
  await chrome.storage.session.set({ [matchKey(job.matchId)]: job });
}

function summarize(job) {
  if (job.errors.length && job.finished === job.total) {
    return { state: "error", text: job.errors[job.errors.length - 1] };
  }
  if (job.finished < job.total) {
    const started = job.total > 1 ? ` ${job.finished + 1}/${job.total}` : "";
    return { state: "busy", text: `Downloading${started}…` };
  }
  const n = job.demos.length;
  return { state: "done", text: `Imported ✓ ${n} demo${n === 1 ? "" : "s"}` };
}

async function finishDownload(downloadId, error) {
  const dKey = downloadKey(downloadId);
  const entry = (await chrome.storage.session.get(dKey))[dKey];
  if (!entry) return; // not one of ours, or already handled
  await chrome.storage.session.remove(dKey);

  const { matchId, tabId } = entry;
  let job = (await getMatchJob(matchId)) || {
    matchId, tabId, total: 1, finished: 0, demos: [], errors: [],
  };

  if (error) {
    job.errors.push(error);
  } else {
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (!item || !item.filename) {
      job.errors.push("Download finished but its file path is unknown.");
    } else {
      notifyTab(tabId, matchId, "busy", "Importing…");
      try {
        const res = await withKeepAlive(
          callBackend("/api/import/hltv-download", {
            match_id: matchId,
            file_path: item.filename,
          }),
        );
        for (const d of res.demos || []) if (!job.demos.includes(d)) job.demos.push(d);
      } catch (e) {
        job.errors.push(e.message || String(e));
      }
    }
  }
  job.finished += 1;
  await saveMatchJob(job);
  const s = summarize(job);
  notifyTab(tabId, matchId, s.state, s.text);
}

// One completion at a time, so two downloads of the same match finishing
// together can't overwrite each other's progress.
let completionChain = Promise.resolve();
function onDownloadDone(downloadId, error) {
  completionChain = completionChain
    .then(() => finishDownload(downloadId, error))
    .catch((e) => console.error("cs2me: finishing download failed", e));
}

chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state?.current === "complete") {
    onDownloadDone(delta.id, null);
  } else if (delta.state?.current === "interrupted") {
    const reason = delta.error?.current || "interrupted";
    onDownloadDone(delta.id, `Download failed (${reason}).`);
  }
});

async function sendMatch(url, html, tabId) {
  const page = await callBackend("/api/import/hltv-page", { url, html });
  const matchId = page.match_id;
  const urls = Array.isArray(page.demo_urls) ? page.demo_urls : [];
  if (!urls.length) {
    return { state: "error", text: "No demo link on this page yet." };
  }
  await saveMatchJob({ matchId, tabId, total: urls.length, finished: 0, demos: [], errors: [] });

  for (const demoUrl of urls) {
    // The backend only returns hltv.org links; double-check before downloading.
    let host = "";
    try {
      host = new URL(demoUrl).hostname;
    } catch {
      host = "";
    }
    if (!(host === "hltv.org" || host.endsWith(".hltv.org"))) continue;
    const downloadId = await chrome.downloads.download({ url: demoUrl, conflictAction: "uniquify" });
    await chrome.storage.session.set({ [downloadKey(downloadId)]: { matchId, tabId } });
    // Tiny files can finish before the bookkeeping above was written.
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (item && item.state === "complete") onDownloadDone(downloadId, null);
  }
  const teams = (page.teams || []).map((t) => t.name).filter(Boolean).join(" vs ");
  return {
    state: "busy",
    text: `Downloading${urls.length > 1 ? ` 1/${urls.length}` : ""}…${teams ? ` (${teams})` : ""}`,
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "cs2me-send") return false;
  // Only the content script on an HLTV match page may trigger a send.
  const tabUrl = sender.tab?.url || "";
  if (!tabUrl.startsWith("https://www.hltv.org/matches/")) {
    sendResponse({ state: "error", text: "Only HLTV match pages can send demos." });
    return false;
  }
  const tabId = sender.tab?.id ?? null;
  withKeepAlive(sendMatch(String(msg.url || ""), String(msg.html || ""), tabId))
    .then(sendResponse)
    .catch((e) => sendResponse({ state: "error", text: e.message || String(e) }));
  return true; // async response
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
