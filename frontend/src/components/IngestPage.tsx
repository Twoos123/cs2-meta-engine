import { useNavigate, useSearchParams } from "react-router-dom";
import IngestPanel from "./IngestPanel";
import FaceitIngestPanel from "./FaceitIngestPanel";
import AutoImportPanel from "./AutoImportPanel";
import ExtensionPanel from "./ExtensionPanel";
import AppHeader from "./AppHeader";
import AppBackdrop from "./AppBackdrop";
import IngestStatusBanner from "./IngestStatusBanner";
import { useReveal } from "../hooks/useReveal";

type Tab = "hltv" | "faceit" | "auto" | "extension";

const TABS: { id: Tab; label: string }[] = [
  { id: "hltv", label: "HLTV" },
  { id: "faceit", label: "FACEIT" },
  { id: "auto", label: "Auto-import" },
  { id: "extension", label: "Browser extension" },
];

const isTab = (v: string | null): v is Tab => TABS.some((t) => t.id === v);

export default function IngestPage() {
  const navigate = useNavigate();
  const hero = useReveal<HTMLDivElement>();
  const body = useReveal<HTMLDivElement>();
  // ?tab= deep-links (e.g. the demo picker links to ?tab=auto).
  const [params, setParams] = useSearchParams();
  const tabParam = params.get("tab");
  const tab: Tab = isTab(tabParam) ? tabParam : "hltv";
  const setTab = (t: Tab) => setParams(t === "hltv" ? {} : { tab: t }, { replace: true });

  return (
    <div className="relative h-screen flex flex-col overflow-hidden bg-[#05070d]">
      <AppBackdrop tone="amber" />
      <AppHeader />

      <div className="relative flex-1 min-h-0 overflow-y-auto px-4 md:px-6 pt-8 pb-12" style={{ scrollbarWidth: "thin" }}>
        <div className="max-w-3xl mx-auto space-y-10">
          {/* ── Hero — same scale as other sub-pages (DISCOVER / REWATCH / SCOUT / PROFILE) ── */}
          <div
            ref={hero.ref}
            className={`reveal ${hero.shown ? "in" : ""} text-center`}
          >
            <span className="section-eyebrow" style={{ color: "#fde68a" }}>COLLECT</span>
            <h1 className="page-title mt-3">
              Pull matches into the <span className="accent">pipeline</span>
            </h1>
            <p className="mt-4 text-sm md:text-base text-cs2-muted leading-relaxed max-w-xl mx-auto">
              Import your own CS2 replays automatically, send HLTV matches from
              your browser, or queue FACEIT matches. Every demo is parsed and
              clustered locally — nothing leaves your machine.
            </p>
          </div>

          {/* ── Live pipeline status — always visible, independent of the
              active tab. Renders nothing when no pipeline is running, so
              it doesn't steal space from the forms below. */}
          <IngestStatusBanner />

          {/* ── Source tabs ── */}
          <div
            ref={body.ref}
            className={`reveal reveal-delay-1 ${body.shown ? "in" : ""} space-y-6`}
          >
            <div className="flex flex-wrap gap-1.5 justify-center" role="tablist">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={tab === t.id}
                  className={`hud-tab ${tab === t.id ? "hud-tab-active" : "hud-tab-idle"} flex items-center gap-2`}
                  onClick={() => setTab(t.id)}
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-current opacity-60" />
                  {t.label}
                </button>
              ))}
            </div>

            {tab === "hltv" && <IngestPanel onComplete={() => navigate("/lineups")} />}
            {tab === "faceit" && <FaceitIngestPanel onComplete={() => navigate("/lineups")} />}
            {tab === "auto" && <AutoImportPanel />}
            {tab === "extension" && <ExtensionPanel />}
          </div>
        </div>
      </div>
    </div>
  );
}
