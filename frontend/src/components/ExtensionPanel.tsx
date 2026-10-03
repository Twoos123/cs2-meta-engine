/**
 * ExtensionPanel — explains the HLTV browser extension (extension/ folder)
 * and how to install it.
 */
const README_URL =
  "https://github.com/Twoos123/cs2-meta-engine/tree/main/extension#readme";

const STEPS: { title: string; body: React.ReactNode }[] = [
  {
    title: "Load it",
    body: (
      <>
        Open <span className="font-mono text-white">chrome://extensions</span> (Edge:{" "}
        <span className="font-mono text-white">edge://extensions</span>), turn on{" "}
        <span className="text-white">Developer mode</span>, click{" "}
        <span className="text-white">Load unpacked</span> and pick the repo's{" "}
        <span className="font-mono text-white">extension/</span> folder.
      </>
    ),
  },
  {
    title: "Point it at the backend",
    body: (
      <>
        Click the extension icon. The backend URL defaults to{" "}
        <span className="font-mono text-white">http://localhost:8000</span>. Add the admin
        token only if the server sets <span className="font-mono text-white">ADMIN_TOKEN</span>.
      </>
    ),
  },
  {
    title: "Send a match",
    body: (
      <>
        Open any match on hltv.org and click{" "}
        <span className="text-cs2-accent">Send to CS2 Meta Engine</span>. Your browser downloads
        the demo; when it finishes, the app imports it as{" "}
        <span className="font-mono text-white">&lt;match id&gt;_&lt;map&gt;.dem</span> with rosters
        and team logos.
      </>
    ),
  },
];

export default function ExtensionPanel() {
  return (
    <div className="hud-panel p-4 sm:p-5 space-y-4">
      <div>
        <p className="text-[10px] text-cs2-accent uppercase tracking-[0.2em]">/ browser extension</p>
        <h2 className="text-sm font-semibold text-white mt-0.5">Import HLTV demos from your browser</h2>
      </div>

      <p className="text-[11px] text-cs2-muted leading-relaxed">
        HLTV blocks server-side downloads, so the app can't fetch pro demos by itself. The
        extension adds a button to HLTV match pages. It acts only on the page you're viewing and
        only when you click; your browser does the download like any other. Works in Chrome,
        Edge and Brave.
      </p>

      <ol className="space-y-3">
        {STEPS.map((s, i) => (
          <li key={s.title} className="flex gap-3">
            <span className="shrink-0 w-6 h-6 rounded-full border border-cs2-accent/60 text-cs2-accent text-[11px] font-mono flex items-center justify-center">
              {i + 1}
            </span>
            <div className="min-w-0">
              <p className="text-[12px] text-white font-semibold">{s.title}</p>
              <p className="text-[11px] text-cs2-muted leading-relaxed break-words">{s.body}</p>
            </div>
          </li>
        ))}
      </ol>

      <div className="hud-panel p-3 bg-[#0b1220] text-[11px] text-cs2-muted leading-relaxed space-y-1">
        <p>
          <span className="text-white">Where downloads go:</span> the backend imports from your
          Downloads folder or any folder watched under Auto-import.
        </p>
        <p>
          <span className="text-white">Backend on another machine?</span> It can't see your
          downloads. Upload the archive on the{" "}
          <a href="/replay" className="text-cs2-accent underline">Demo picker</a> instead;{" "}
          <span className="font-mono">.rar</span> and <span className="font-mono">.zip</span> work there.
        </p>
      </div>

      <a
        href={README_URL}
        target="_blank"
        rel="noreferrer"
        className="hud-btn inline-block text-[11px]"
      >
        Extension README ↗
      </a>
    </div>
  );
}
