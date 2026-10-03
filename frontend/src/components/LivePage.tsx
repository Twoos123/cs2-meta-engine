import AppHeader from "./AppHeader";
import AppBackdrop from "./AppBackdrop";

/** Live 2D radar fed by CS2 Game State Integration (placeholder). */
export default function LivePage() {
  return (
    <div className="relative min-h-screen bg-cs2-bg">
      <AppBackdrop />
      <AppHeader />
      <main className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 py-10">
        <span className="section-eyebrow">LIVE</span>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white">Live radar</h1>
      </main>
    </div>
  );
}
