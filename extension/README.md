# CS2 Meta Engine: HLTV demo import extension

HLTV blocks server-side downloads with a Cloudflare challenge, so the app can't fetch
pro demos by itself any more. This extension keeps you in the loop instead:

1. You open a match page on hltv.org as usual.
2. You click **Send to CS2 Meta Engine** (next to the GOTV demo link, or bottom-right).
3. The extension sends that page to your backend, which reads the teams, rosters, maps
   and demo link from it and writes the roster sidecar.
4. Your browser downloads the demo archive the normal way (it shows up in your downloads bar).
5. When the download finishes, the backend imports it as `<match id>_<map>.dem` (one demo per
   map), parses the timeline and updates player stats.

The extension acts only on the page you're viewing, and only when you click. It doesn't
crawl HLTV or make requests in the background. The only download is the one you asked for.

Works in Chrome, Edge and Brave (Manifest V3).

## Install

1. Open `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose this `extension/` folder.
4. Click the extension's icon (or **Details → Extension options**) and check the settings:
   - **Backend URL**: `http://localhost:8000` by default.
   - **Admin token**: only needed if the server sets `ADMIN_TOKEN`. It's sent as `X-Admin-Token`.
5. Click **Test connection**.

If the backend isn't on `localhost` / `127.0.0.1`, clicking **Save** asks Chrome for access
to that host. The extension can't reach it until you allow this.

## Where downloads go

The backend imports the file straight from where the browser saved it. It only accepts files
in your **Downloads** folder (`~/Downloads`) or in a folder watched under
**Collect → Auto-import** in the app. If your browser saves somewhere else, add that folder
there.

If the backend runs on a **different machine** than your browser (for example the
self-hosted server), it can't see your downloads. The button will say so. Upload the
archive on the app's **Demo picker** (`/replay`) instead; `.rar`, `.zip` and
`.dem.gz/.bz2/.zst` are all accepted there.

## RAR support

HLTV ships `.rar` archives. The backend extracts them with 7-Zip or UnRAR when it finds one,
otherwise with Windows' built-in `tar.exe` (RAR4 only). If imports fail with
"Could not extract the RAR archive", install [7-Zip](https://www.7-zip.org/) and restart
the backend.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest: `downloads` + `storage`, host access to hltv.org and localhost |
| `content.js` | Adds the button on `https://www.hltv.org/matches/*` |
| `background.js` | Talks to the backend, starts the download, imports on completion |
| `options.html` / `options.js` | Backend URL + admin token |
| `icons/` | Toolbar icons |
