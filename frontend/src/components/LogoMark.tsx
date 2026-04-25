/**
 * Small concentric-ring logo used in the top nav and footer. Pulled into
 * its own file so LandingPage + AppHeader share a single source of truth.
 */
export default function LogoMark({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden>
      <circle cx="12" cy="12" r="10" stroke="#22d3ee" strokeWidth="1.5" />
      <circle cx="12" cy="12" r="5" stroke="#22d3ee" strokeWidth="1.5" />
      <circle cx="12" cy="12" r="1.5" fill="#22d3ee" />
    </svg>
  );
}
