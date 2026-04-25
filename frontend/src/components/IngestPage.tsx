import { useState } from "react";
import { useNavigate } from "react-router-dom";
import IngestPanel from "./IngestPanel";
import FaceitIngestPanel from "./FaceitIngestPanel";
import AppHeader from "./AppHeader";
import AppBackdrop from "./AppBackdrop";
import IngestStatusBanner from "./IngestStatusBanner";
import { useReveal } from "../hooks/useReveal";

type Tab = "hltv" | "faceit";

export default function IngestPage() {
  const navigate = useNavigate();
  const hero = useReveal<HTMLDivElement>();
  const body = useReveal<HTMLDivElement>();
  const [tab, setTab] = useState<Tab>("hltv");

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
              Scrape HLTV or queue FACEIT matches. The pipeline parses and
              clusters every demo automatically — nothing leaves your machine.
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
            <div className="flex gap-1.5 justify-center">
              <button
                className={`hud-tab ${tab === "hltv" ? "hud-tab-active" : "hud-tab-idle"} flex items-center gap-2`}
                onClick={() => setTab("hltv")}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-current opacity-60" />
                HLTV
              </button>
              <button
                className={`hud-tab ${tab === "faceit" ? "hud-tab-active" : "hud-tab-idle"} flex items-center gap-2`}
                onClick={() => setTab("faceit")}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-current opacity-60" />
                FACEIT
              </button>
            </div>

            {tab === "hltv" ? (
              <IngestPanel onComplete={() => navigate("/lineups")} />
            ) : (
              <FaceitIngestPanel onComplete={() => navigate("/lineups")} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
