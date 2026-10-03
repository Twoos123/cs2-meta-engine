import { useLocation, useNavigate } from "react-router-dom";
import AppHeader from "./AppHeader";
import AppBackdrop from "./AppBackdrop";

/** Catch-all route — anything React Router doesn't recognise lands here
 *  instead of rendering an empty page. */
export default function NotFoundPage() {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  return (
    <div className="relative min-h-screen bg-cs2-bg">
      <AppBackdrop />
      <AppHeader />
      <main className="relative z-10 max-w-xl mx-auto px-4 sm:px-6 py-24 text-center">
        <span className="section-eyebrow">404</span>
        <h1 className="mt-3 text-3xl sm:text-4xl font-semibold tracking-tight text-white">
          Page not found
        </h1>
        <p className="mt-3 text-sm text-cs2-muted break-all">
          Nothing lives at <span className="font-mono text-white/80">{pathname}</span>.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <button className="hud-btn hud-btn-primary" onClick={() => navigate("/")}>
            Go home
          </button>
          <button className="hud-btn" onClick={() => navigate(-1)}>
            Back
          </button>
        </div>
      </main>
    </div>
  );
}
