/**
 * Report actions for the Anti-Strat page: copy a shareable link to the
 * current report (map + team live in the URL) and print / save as PDF.
 * Both buttons and the toast are hidden when printing (`antistrat-noprint`).
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const copyText = async (text: string): Promise<boolean> => {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the legacy path (e.g. non-secure origin) */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
};

export default function ReportActions() {
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const showToast = (msg: string, ok: boolean) => {
    setToast({ msg, ok });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), 2200);
  };

  const onCopy = async () => {
    const ok = await copyText(window.location.href);
    showToast(ok ? "Report link copied" : "Couldn't copy — copy the address bar instead", ok);
  };

  return (
    <>
      <div className="antistrat-noprint flex flex-wrap items-center gap-2">
        <button type="button" onClick={onCopy} className="hud-btn inline-flex items-center gap-1.5">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5" aria-hidden>
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Copy link
        </button>
        <button type="button" onClick={() => window.print()} className="hud-btn inline-flex items-center gap-1.5">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5" aria-hidden>
            <path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M6 14h12v8H6z" strokeLinejoin="round" />
          </svg>
          Print / PDF
        </button>
      </div>
      {/* Portalled: the buttons sit inside a backdrop-filtered .hud-panel,
          which would otherwise become the containing block for `fixed`. */}
      {toast && createPortal(
        <div
          role="status"
          aria-live="polite"
          className="antistrat-noprint fixed z-50 bottom-5 left-1/2 -translate-x-1/2 max-w-[calc(100vw-2rem)] px-4 py-2 rounded-full text-xs font-medium border backdrop-blur-xl shadow-lg"
          style={{
            background: "rgba(10,14,24,0.92)",
            borderColor: toast.ok ? "rgba(74,222,128,0.35)" : "rgba(248,113,113,0.35)",
            color: toast.ok ? "#86efac" : "#fca5a5",
          }}
        >
          {toast.msg}
        </div>,
        document.body,
      )}
    </>
  );
}
