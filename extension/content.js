// CS2 Meta Engine — adds a "Send to CS2 Meta Engine" button to HLTV match
// pages. Nothing happens until the user clicks it; then the page the user is
// viewing is handed to the extension's background worker.
(() => {
  if (window.__cs2meInjected) return;
  window.__cs2meInjected = true;

  const LABEL = "Send to CS2 Meta Engine";
  const COLORS = {
    idle: { bg: "#0b1220", fg: "#22d3ee", border: "#22d3ee" },
    busy: { bg: "#0b1220", fg: "#fde68a", border: "#fde68a" },
    done: { bg: "#052e1a", fg: "#4ade80", border: "#4ade80" },
    error: { bg: "#2a0a0a", fg: "#f87171", border: "#f87171" },
  };

  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = LABEL;
  btn.title = "Download this match's demo with your browser and import it into CS2 Meta Engine";
  Object.assign(btn.style, {
    font: "600 12px/1.2 system-ui, sans-serif",
    letterSpacing: "0.04em",
    padding: "8px 12px",
    borderRadius: "6px",
    borderWidth: "1px",
    borderStyle: "solid",
    cursor: "pointer",
    maxWidth: "min(360px, calc(100vw - 32px))",
    whiteSpace: "normal",
    textAlign: "left",
    boxShadow: "0 4px 18px rgba(0,0,0,0.35)",
  });

  function setState(state, text) {
    const c = COLORS[state] || COLORS.idle;
    btn.style.background = c.bg;
    btn.style.color = c.fg;
    btn.style.borderColor = c.border;
    btn.textContent = text;
    btn.disabled = state === "busy";
    btn.style.cursor = state === "busy" ? "progress" : "pointer";
  }
  setState("idle", LABEL);

  // Place it next to HLTV's own demo link when there is one; otherwise float it.
  const demoLink = document.querySelector('a[href*="/download/demo/"]');
  if (demoLink && demoLink.parentElement) {
    const wrap = document.createElement("div");
    wrap.style.margin = "8px 0";
    wrap.appendChild(btn);
    demoLink.parentElement.insertAdjacentElement("afterend", wrap);
  } else {
    Object.assign(btn.style, { position: "fixed", right: "16px", bottom: "16px", zIndex: "2147483647" });
    document.body.appendChild(btn);
  }

  let currentMatch = null;
  const m = location.pathname.match(/^\/matches\/(\d+)/);
  if (m) currentMatch = Number(m[1]);

  btn.addEventListener("click", () => {
    setState("busy", "Sending…");
    chrome.runtime
      .sendMessage({
        type: "cs2me-send",
        url: location.href,
        html: document.documentElement.outerHTML,
      })
      .then((res) => {
        if (res && res.state) setState(res.state, res.text || LABEL);
        else setState("error", "No response from the extension.");
      })
      .catch((e) => setState("error", (e && e.message) || "Extension error."));
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== "cs2me-progress") return;
    if (currentMatch != null && msg.matchId !== currentMatch) return;
    setState(msg.state, msg.text);
  });
})();
