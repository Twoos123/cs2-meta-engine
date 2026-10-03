import { lazy, Suspense } from "react";
import { Routes, Route } from "react-router-dom";
import LandingPage from "./components/LandingPage";

// Every page except the landing route is code-split: the replay viewer,
// insights panels and recharts are heavy and most visits only need one page.
const Dashboard = lazy(() => import("./components/Dashboard"));
const DemoPickerPage = lazy(() => import("./components/DemoPickerPage"));
const ReplayLayout = lazy(() => import("./components/ReplayLayout"));
const AntiStratPage = lazy(() => import("./components/AntiStratPage"));
const IngestPage = lazy(() => import("./components/IngestPage"));
const MatchesPage = lazy(() => import("./components/MatchesPage"));
const PlayerListPage = lazy(() => import("./components/PlayerListPage"));
const PlayerDetailPage = lazy(() => import("./components/PlayerDetailPage"));
const LivePage = lazy(() => import("./components/LivePage"));
const NotFoundPage = lazy(() => import("./components/NotFoundPage"));

function PageFallback() {
  return (
    <div className="min-h-screen bg-cs2-bg flex items-center justify-center" role="status">
      <div className="w-6 h-6 rounded-full border-2 border-cs2-accent/30 border-t-cs2-accent animate-spin" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}

export default function App() {
  return (
    <Suspense fallback={<PageFallback />}>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/ingest" element={<IngestPage />} />
        <Route path="/matches" element={<MatchesPage />} />
        <Route path="/lineups" element={<Dashboard />} />
        <Route path="/replay" element={<DemoPickerPage />} />
        <Route path="/replay/:demoFile/*" element={<ReplayLayout />} />
        <Route path="/anti-strat" element={<AntiStratPage />} />
        <Route path="/players" element={<PlayerListPage />} />
        <Route path="/players/:steamid" element={<PlayerDetailPage />} />
        <Route path="/live" element={<LivePage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Suspense>
  );
}
