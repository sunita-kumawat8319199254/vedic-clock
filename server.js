// server.js — Vedic Clock Scraper API
// Endpoint: GET /api/vedic-time  -> { time, location, source, fetched_at }

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const puppeteer = require("puppeteer");

const PORT = process.env.PORT || 3000;
const VST_URL = "https://www.vedicstandardtime.com/";
const ALLOW_ORIGINS = (process.env.ALLOW_ORIGINS || "").split(",").filter(Boolean);

// Scrape throttling & refresh
const MIN_REFRESH_MS = 5_000;      // कम से कम 5s में एक बार
const FULL_REFRESH_MS = 5 * 60_000; // हर 5 मिनट में force reload

let browser = null, page = null;
let lastFetch = 0;
let cache = null; // { time, location, source, fetched_at }

async function ensureBrowser() {
  if (browser) return;
  browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari"
  );
  await page.goto(VST_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
}

async function readClock() {
  await ensureBrowser();
  const now = Date.now();

  // throttle
  if (cache && (now - lastFetch < MIN_REFRESH_MS)) return cache;

  // periodic full refresh
  if (now - lastFetch > FULL_REFRESH_MS) {
    try {
      await page.goto(VST_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    } catch {}
  }

  const result = await page.evaluate(() => {
    // Find first HH:MM:SS text on the page
    function findHHMMSS() {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const t = (walker.currentNode.textContent || "").trim();
        if (/^\d{2}:\d{2}:\d{2}$/.test(t)) return t;
      }
      return null;
    }
    const timeText = findHHMMSS();

    // Try to pick a "City, STATE" style line for location (best effort)
    let location = null;
    const lines = (document.body.innerText || "")
      .split("\n")
      .map(s => s.trim())
      .filter(Boolean);
    for (const line of lines) {
      if (/^[A-Za-z .()-]+,\s*[A-Z ]{3,}$/.test(line) && line.length <= 60) {
        location = line;
        break;
      }
    }
    return { timeText, location };
  });

  if (!result || !result.timeText) {
    throw new Error("Could not read HH:MM:SS from the source page.");
  }

  cache = {
    time: result.timeText,
    location: result.location || null,
    source: "vedicstandardtime.com",
    fetched_at: new Date().toISOString()
  };
  lastFetch = now;
  return cache;
}

const app = express();
app.use(helmet());
app.use(express.json());

// CORS
if (ALLOW_ORIGINS.length) {
  app.use(cors({ origin: ALLOW_ORIGINS }));
} else {
  // Dev: allow all
  app.use(cors());
}

app.get("/", (_req, res) => res.send("Vedic Clock Scraper API OK. Use GET /api/vedic-time"));

app.get("/api/vedic-time", async (_req, res) => {
  try {
    const data = await readClock();
    res.json(data);
  } catch (e) {
    res.status(503).json({ error: "upstream_unavailable", detail: e.message });
  }
});

// Graceful shutdown
process.on("SIGTERM", async () => { try { await browser?.close(); } finally { process.exit(0); } });
process.on("SIGINT", async () => { try { await browser?.close(); } finally { process.exit(0); } });

app.listen(PORT, () => console.log(`API on http://0.0.0.0:${PORT}`));
