import { useState } from "react";
import { useNavigate } from "react-router-dom";
import IngestPanel from "./IngestPanel";
import FaceitIngestPanel from "./FaceitIngestPanel";

type Tab = "hltv" | "faceit";

export default function IngestPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("hltv");

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-[#05070d]">
      <nav className="shrink-0 flex items-center gap-3 px-4 py-8 border-b border-cs2-border/50 bg-[#0a0e18]">
        <button onClick={() => navigate(-1)} className="hud-btn text-sm py-1.5 px-4 min-w-[72px]" title="Back">←</button>
        <h1 className="text-sm font-semibold text-white uppercase tracking-[0.12em]">Ingest</h1>
      </nav>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-8" style={{ scrollbarWidth: "thin" }}>
        <div className="max-w-2xl mx-auto space-y-4">
          <div className="flex gap-1.5">
            <button
              className={`hud-tab ${tab === "hltv" ? "hud-tab-active" : "hud-tab-idle"}`}
              onClick={() => setTab("hltv")}
            >
              HLTV
            </button>
            <button
              className={`hud-tab ${tab === "faceit" ? "hud-tab-active" : "hud-tab-idle"}`}
              onClick={() => setTab("faceit")}
            >
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
  );
}
