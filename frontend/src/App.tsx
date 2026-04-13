import { Routes, Route } from "react-router-dom";
import Dashboard from "./components/Dashboard";
import DemoPickerPage from "./components/DemoPickerPage";
import ReplayLayout from "./components/ReplayLayout";
import AntiStratPage from "./components/AntiStratPage";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/replay" element={<DemoPickerPage />} />
      <Route path="/replay/:demoFile/*" element={<ReplayLayout />} />
      <Route path="/anti-strat" element={<AntiStratPage />} />
    </Routes>
  );
}
