// Recaptures the README screenshots from a running local app.
//
//   (backend on :8000 and `npm run dev` on :5173, with your own demos)
//   node scripts/capture-screenshots.mjs [baseUrl]
//
// Desktop shots are 1920x945 (same as before); phone shots are 390x844 @2x
// and are stitched into screenshots/mobile.png by the Python step in the
// README instructions. Shots that depend on data you don't have are skipped.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const BASE = process.argv[2] ?? "http://localhost:5173";
const OUT = resolve(import.meta.dirname, "../../screenshots");
mkdirSync(OUT, { recursive: true });

const REPLAY = "2393245_mirage.dem";       // full 29-round pro demo
const COMPARE = "2393236_dust2.dem";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(page, name, { full = false } = {}) {
  // Refuse near-blank captures (a loading screen has a few words of text).
  const variety = await page.evaluate(() => document.body.innerText.length);
  if (variety < 80) throw new Error(`${name}: page has almost no content yet`);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: full });
  console.log("saved", name);
}

async function scrollToText(page, text) {
  const el = page.getByText(text, { exact: false }).first();
  await el.evaluate((node) => node.scrollIntoView({ block: "start" }));
  await page.evaluate(() => window.scrollBy(0, -110)); // clear the sticky header
  await sleep(600);
}

// Content that only exists once each replay tab has its timeline. Waiting
// for "no loading text" isn't enough: it is also true for the instant
// before the loading screen first renders.
const READY = {
  replay: /Toggle key moments|Moments/i,
  insights: /^patterns$/i,
  economy: /equipment value/i,
  heatmap: /Position Density/i,
  stats: /Player statistics/i,
  compare: /throw vs the pros/i,
};

/** Wait until a replay tab has finished loading its timeline. */
async function replayReady(page, tab = "replay") {
  await page.getByText(READY[tab]).first().waitFor({ state: "visible", timeout: 120000 })
    .catch(() => page.getByRole("button", { name: READY[tab] }).first()
      .waitFor({ state: "visible", timeout: 30000 }));
  await page.waitForFunction(
    () => !/Loading (demo|replay)|Parsing demo|Re-parsing/.test(document.body.innerText),
    null, { timeout: 30000 },
  );
  await sleep(2500);
}

// ONLY=replay,economy node scripts/capture-screenshots.mjs  → just those groups
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;

async function capture(name, fn) {
  if (ONLY && !ONLY.has(name)) return;
  try {
    await fn();
  } catch (err) {
    console.warn(`skipped ${name}: ${err.message.split("\n")[0]}`);
  }
}

const browser = await chromium.launch();

// ── Desktop ────────────────────────────────────────────────────────────────
const desk = await browser.newContext({ viewport: { width: 1920, height: 945 } });
let page = await desk.newPage();
// Fresh page per navigation (a heavy replay can't slow the next shot), and
// "load" + a fixed settle time: avatar lookups can hold requests open for
// seconds, so the network never goes fully idle.
const go = async (path, wait = 1500) => {
  await page.close().catch(() => {});
  page = await desk.newPage();
  await page.goto(BASE + path, { waitUntil: "load", timeout: 60000 });
  await sleep(wait);
};

await capture("landing", async () => { await go("/"); await shot(page, "landing"); });
await capture("lineups", async () => { await go("/lineups", 2500); await shot(page, "lineups"); });
await capture("practice-lists", async () => {
  await go("/lineups", 2500);
  await page.getByRole("button", { name: /Practice/ }).first().click();
  await sleep(1200);
  await shot(page, "practice-lists");
});
await capture("demo-picker", async () => { await go("/replay"); await shot(page, "demo-picker"); });

await capture("replay", async () => {
  await go(`/replay/${REPLAY}?round=14&t=38`, 0);
  await replayReady(page);
  await shot(page, "replay");
  await page.getByRole("button", { name: /moments/i }).first().click();
  await sleep(1000);
  await shot(page, "key-moments");
});
await capture("insights", async () => {
  await go(`/replay/${REPLAY}/insights`, 0);
  await replayReady(page, "insights");
  await shot(page, "insights");
  for (const [label, file] of [["patterns", "insights-patterns"], ["heatmap", "insights-heatmap"]]) {
    await page.getByRole("button", { name: label, exact: true }).first().click();
    await sleep(1500);
    await shot(page, file);
  }
});
for (const [tab, file] of [["economy", "economy"], ["heatmap", "heatmap"], ["stats", "stats"]]) {
  await capture(file, async () => {
    await go(`/replay/${REPLAY}/${tab}`, 0);
    await replayReady(page, tab);
    await shot(page, file);
  });
}
await capture("compare", async () => {
  await go(`/replay/${COMPARE}/compare`, 0);
  await replayReady(page, "compare");
  await sleep(8000); // first open parses the demo's throws
  await shot(page, "compare");
});

await capture("anti-strat", async () => {
  await go("/anti-strat?map=de_mirage&team=Vitality", 9000);
  await shot(page, "anti-strat");
  await scrollToText(page, "Default Setups");
  await shot(page, "anti-strat-setups");
  await scrollToText(page, "Utility Tendencies");
  await shot(page, "anti-strat-2");
  await scrollToText(page, "Player Breakdown");
  await shot(page, "anti-strat-3");
});

await capture("players", async () => { await go("/players", 2500); await shot(page, "players"); });
await capture("player-detail", async () => {
  await go("/players/76561198113666193", 2500); // ZywOo
  await shot(page, "player-detail");
});
await capture("matches", async () => { await go("/matches", 2500); await shot(page, "matches"); });
await capture("ingest", async () => { await go("/ingest?tab=auto", 2000); await shot(page, "ingest-auto-import"); });
await capture("live", async () => { await go("/live", 3000); await shot(page, "live-radar"); });

// ── Phone ──────────────────────────────────────────────────────────────────
const phone = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
for (const [path, file, wait] of [
  ["/lineups", "mobile-lineups", 2500],
  [`/replay/${REPLAY}?round=14&t=38`, "mobile-replay", 5000],
  ["/players", "mobile-players", 2500],
]) {
  await capture(file, async () => {
    const mp = await phone.newPage();
    await mp.goto(BASE + path, { waitUntil: "load", timeout: 60000 });
    if (path.startsWith("/replay/")) await replayReady(mp);
    await sleep(wait);
    await mp.screenshot({ path: `${OUT}/${file}.png` });
    await mp.close();
    console.log("saved", file);
  });
}

await browser.close();
