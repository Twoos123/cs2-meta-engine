// Options page: backend URL + admin token. A non-localhost backend needs a
// host permission, requested here while the user's Save click is active.
const DEFAULTS = { backendUrl: "http://localhost:8000", adminToken: "" };
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

const $ = (id) => document.getElementById(id);

function show(text, ok) {
  const el = $("status");
  el.textContent = text;
  el.className = ok ? "ok" : "err";
}

function parseBackend(raw) {
  const value = (raw || "").trim().replace(/\/+$/, "") || DEFAULTS.backendUrl;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a full URL, e.g. http://localhost:8000");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The backend URL must start with http:// or https://");
  }
  return url;
}

async function load() {
  const cfg = await chrome.storage.local.get(DEFAULTS);
  $("backendUrl").value = cfg.backendUrl;
  $("adminToken").value = cfg.adminToken;
}

async function save() {
  let url;
  try {
    url = parseBackend($("backendUrl").value);
  } catch (e) {
    show(e.message, false);
    return;
  }
  if (!LOCAL_HOSTS.has(url.hostname)) {
    // Must run inside the click handler (user gesture).
    const granted = await chrome.permissions.request({ origins: [`${url.origin}/*`] });
    if (!granted) {
      show(`Access to ${url.origin} was not granted — settings not saved.`, false);
      return;
    }
  }
  const backendUrl = url.origin + url.pathname.replace(/\/+$/, "");
  await chrome.storage.local.set({ backendUrl, adminToken: $("adminToken").value.trim() });
  $("backendUrl").value = backendUrl;
  show("Saved.", true);
}

async function test() {
  let url;
  try {
    url = parseBackend($("backendUrl").value);
  } catch (e) {
    show(e.message, false);
    return;
  }
  const base = url.origin + url.pathname.replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/api/health`);
    const data = await res.json();
    if (res.ok && data.status === "ok") show(`Connected — backend v${data.version}.`, true);
    else show(`Backend answered HTTP ${res.status}.`, false);
  } catch {
    show(`Can't reach ${base}. Is it running, and did you Save to grant access?`, false);
  }
}

$("save").addEventListener("click", save);
$("test").addEventListener("click", test);
load();
