/** Numbered section header used by every Anti-Strat report section. */
export default function SectionHeader({ num, title, sub }: { num: string; title: string; sub?: string }) {
  return (
    <div className="antistrat-section-header flex items-center gap-3 mb-3">
      <div className="w-7 h-7 rounded-md bg-cs2-accent/10 border border-cs2-accent/30 flex items-center justify-center shrink-0">
        <span className="text-cs2-accent font-mono font-bold text-[11px]">{num}</span>
      </div>
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-white">{title}</h3>
        {sub && <p className="text-[10px] text-cs2-muted">{sub}</p>}
      </div>
    </div>
  );
}
