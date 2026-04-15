import { Routes, Route } from "react-router-dom";
import LandingPage from "./components/LandingPage";
import Dashboard from "./components/Dashboard";
import DemoPickerPage from "./components/DemoPickerPage";
import ReplayLayout from "./components/ReplayLayout";
import AntiStratPage from "./components/AntiStratPage";
import IngestPage from "./components/IngestPage";
import PlayerListPage from "./components/PlayerListPage";
import PlayerDetailPage from "./components/PlayerDetailPage";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/ingest" element={<IngestPage />} />
      <Route path="/lineups" element={<Dashboard />} />
      <Route path="/replay" element={<DemoPickerPage />} />
      <Route path="/replay/:demoFile/*" element={<ReplayLayout />} />
      <Route path="/anti-strat" element={<AntiStratPage />} />
      <Route path="/players" element={<PlayerListPage />} />
      <Route path="/players/:steamid" element={<PlayerDetailPage />} />
    </Routes>
  );
}
