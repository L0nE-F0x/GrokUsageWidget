/**
 * fetch-usage.mjs — scrape Weekly SuperGrok usage via Playwright.
 *
 * stdin:  JSON config { userDataDir, usageUrl?, headed?, channel?, timeoutMs?, debugDir? }
 * stdout: UsageSnapshot JSON (one line) on success
 *
 * Navigation strategy:
 *  1. Open grok.com (reuse persistent login)
 *  2. Open profile / account menu → click Usage
 *  3. Also try direct ?_s=usage URL
 *  4. Parse visible text + progress bars + network JSON if present
 *  5. On failure write debug dump (body text + screenshot)
 */

import { chromium } from "playwright";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function fail(message, extra = {}) {
  const payload = { ok: false, error: message, ...extra };
  // Keep sample short for the widget error panel
  if (payload.sample && payload.sample.length > 800) {
    payload.sample = payload.sample.slice(0, 800) + "…";
  }
  console.log(JSON.stringify(payload));
  console.error(message);
  if (extra.debugPath) console.error("Debug dump:", extra.debugPath);
  process.exit(1);
}

function slug(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function clampPct(n) {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}

const KNOWN_CATEGORIES = [
  "Grok Build",
  "Build",
  "Imagine",
  "Chat",
  "API",
  "Voice",
  "DeepSearch",
  "Deep Search",
  "Image Generation",
  "Video",
  "Flux",
  "Agents",
  "Agent",
];

/**
 * Rich text parse: overall %, categories, reset, credits.
 */
function parseUsageText(text) {
  const cleaned = text
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\r/g, "");
  const lines = cleaned
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  let overallPercent = null;

  // Prefer explicit "used" phrasing
  const overallPatterns = [
    /(\d{1,3}(?:\.\d+)?)\s*%\s*used/i,
    /used\s*[:\-]?\s*(\d{1,3}(?:\.\d+)?)\s*%/i,
    /weekly\s+(?:supergrok\s+)?(?:limit|usage|pool)?[^\d%]{0,60}(\d{1,3}(?:\.\d+)?)\s*%/i,
    /supergrok[^\d%]{0,40}(\d{1,3}(?:\.\d+)?)\s*%/i,
    /(\d{1,3}(?:\.\d+)?)\s*%\s*(?:of\s+)?(?:your\s+)?(?:weekly|limit|pool)/i,
    /(?:usage|limit)\s*[:\-]?\s*(\d{1,3}(?:\.\d+)?)\s*%/i,
  ];
  for (const re of overallPatterns) {
    const m = cleaned.match(re);
    if (m) {
      overallPercent = clampPct(parseFloat(m[1]));
      break;
    }
  }

  // Standalone large % near top of usage section (first strong % in text)
  if (overallPercent == null) {
    const firstPct = cleaned.match(/(?:weekly|usage|limit|supergrok)[\s\S]{0,120}?(\d{1,3}(?:\.\d+)?)\s*%/i);
    if (firstPct) overallPercent = clampPct(parseFloat(firstPct[1]));
  }

  const categories = [];
  const seen = new Set();

  for (const name of KNOWN_CATEGORIES) {
    // name then %  OR  % then name (flex)
    const patterns = [
      new RegExp(
        `${name.replace(/ /g, "\\s+")}\\s*[:\\-–—]?\\s*(\\d{1,3}(?:\\.\\d+)?)\\s*%`,
        "i"
      ),
      new RegExp(
        `(\\d{1,3}(?:\\.\\d+)?)\\s*%\\s*${name.replace(/ /g, "\\s+")}`,
        "i"
      ),
    ];
    for (const re of patterns) {
      const m = cleaned.match(re);
      if (!m) continue;
      const pct = clampPct(parseFloat(m[1]));
      let display = name;
      if (name === "Build") display = "Grok Build";
      if (name === "Deep Search") display = "DeepSearch";
      const id = slug(display);
      if (seen.has(id)) break;
      seen.add(id);
      categories.push({
        id,
        name: display,
        used: 0,
        limit: 0,
        percent: pct,
        unit: null,
      });
      break;
    }
  }

  // Adjacent-line patterns: "Chat" on one line, "4%" on next
  if (categories.length < 2) {
    for (let i = 0; i < lines.length - 1; i++) {
      const a = lines[i];
      const b = lines[i + 1];
      const nameMatch = a.match(
        /^(Grok\s+Build|Build|Imagine|Chat|API|Voice|DeepSearch|Deep\s+Search|Video|Flux|Agents?)$/i
      );
      const pctMatch = b.match(/^(\d{1,3}(?:\.\d+)?)\s*%$/);
      if (nameMatch && pctMatch) {
        let display = nameMatch[1];
        if (/^build$/i.test(display)) display = "Grok Build";
        const id = slug(display);
        if (seen.has(id)) continue;
        seen.add(id);
        categories.push({
          id,
          name: display,
          used: 0,
          limit: 0,
          percent: clampPct(parseFloat(pctMatch[1])),
          unit: null,
        });
      }
      // reverse: % then name
      const pctFirst = a.match(/^(\d{1,3}(?:\.\d+)?)\s*%$/);
      const nameSecond = b.match(
        /^(Grok\s+Build|Build|Imagine|Chat|API|Voice|DeepSearch|Deep\s+Search|Video|Flux|Agents?)$/i
      );
      if (pctFirst && nameSecond) {
        let display = nameSecond[1];
        if (/^build$/i.test(display)) display = "Grok Build";
        const id = slug(display);
        if (seen.has(id)) continue;
        seen.add(id);
        categories.push({
          id,
          name: display,
          used: 0,
          limit: 0,
          percent: clampPct(parseFloat(pctFirst[1])),
          unit: null,
        });
      }
    }
  }

  // Generic "Label NN%" lines
  if (categories.length === 0) {
    for (const line of lines) {
      const m = line.match(
        /^([A-Za-z][A-Za-z0-9 /&.+-]{1,40}?)\s+(\d{1,3}(?:\.\d+)?)\s*%$/
      );
      if (!m) continue;
      const name = m[1].trim();
      if (/used|reset|limit|credit|weekly|overall|remaining|available/i.test(name))
        continue;
      const id = slug(name);
      if (seen.has(id)) continue;
      seen.add(id);
      categories.push({
        id,
        name,
        used: 0,
        limit: 0,
        percent: clampPct(parseFloat(m[2])),
        unit: null,
      });
    }
  }

  let resetsDate = "";
  let resetsTime = "";
  let resetsDisplay = "";
  const resetPatterns = [
    /resets?\s+(?:on\s+)?([A-Za-z]+\s+\d{1,2},?\s+\d{4})\s*(?:at\s+)?(\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)?)/i,
    /resets?\s+(?:on\s+)?([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i,
    /reset(?:s|ting)?\s*(?:date|time)?[:\s]+([^\n]{5,60})/i,
    /next\s+reset[:\s]+([^\n]{5,60})/i,
  ];
  for (const re of resetPatterns) {
    const m = cleaned.match(re);
    if (m) {
      resetsDate = (m[1] || "").trim();
      resetsTime = (m[2] || "").trim();
      resetsDisplay = [resetsDate, resetsTime ? `at ${resetsTime}` : ""]
        .filter(Boolean)
        .join(" ");
      break;
    }
  }

  let extraCredits = null;
  let extraCreditsLabel = null;
  const creditPatterns = [
    /extra\s+usage\s+credits?\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d+)?)/i,
    /\$\s*([\d,]+(?:\.\d+)?)\s*(?:in\s+)?extra\s+(?:usage\s+)?credits?/i,
    /credits?\s+(?:balance|remaining)?\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d+)?)/i,
  ];
  for (const re of creditPatterns) {
    const m = cleaned.match(re);
    if (m) {
      extraCredits = parseFloat(m[1].replace(/,/g, ""));
      extraCreditsLabel = m[0].trim();
      break;
    }
  }

  if (
    (overallPercent == null || overallPercent === 0) &&
    categories.length
  ) {
    // Don't invent overall from average of categories — use max as rough signal only if no overall
    const max = Math.max(...categories.map((c) => c.percent));
    // Prefer sum if they look like parts of a whole (~100)
    const sum = categories.reduce((s, c) => s + c.percent, 0);
    overallPercent = clampPct(sum <= 100.5 ? sum : max);
  }

  return {
    overallPercent: overallPercent ?? 0,
    categories,
    resetsDate,
    resetsTime,
    resetsDisplay,
    extraCredits,
    extraCreditsLabel,
  };
}

async function deepScrape(page) {
  return page.evaluate(() => {
    const bodyText = document.body?.innerText || "";
    const html = document.body?.innerHTML?.slice(0, 200_000) || "";

    const bars = [];
    for (const el of document.querySelectorAll(
      '[role="progressbar"], progress, [class*="progress"], [class*="Progress"], [class*="meter"], [class*="Meter"]'
    )) {
      const style = window.getComputedStyle(el);
      const child = el.firstElementChild;
      const childStyle = child ? window.getComputedStyle(child) : null;
      bars.push({
        tag: el.tagName,
        role: el.getAttribute("role"),
        ariaNow: el.getAttribute("aria-valuenow"),
        ariaMax: el.getAttribute("aria-valuemax"),
        ariaLabel: el.getAttribute("aria-label"),
        value: el.getAttribute("value"),
        className: String(el.className || "").slice(0, 120),
        width: style.width,
        childWidth: childStyle?.width || null,
        text: (el.innerText || "").slice(0, 120),
        parentText: (el.closest("div,li,section,article")?.innerText || "").slice(
          0,
          240
        ),
      });
    }

    // Any element whose text is just "NN%"
    const pctNodes = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
      const t = (node.innerText || "").trim();
      if (/^\d{1,3}(?:\.\d+)?\s*%$/.test(t) && t.length < 8) {
        const parent = node.parentElement;
        pctNodes.push({
          text: t,
          parent: (parent?.innerText || "").slice(0, 200),
          grand: (parent?.parentElement?.innerText || "").slice(0, 200),
        });
        if (pctNodes.length > 40) break;
      }
    }

    return {
      bodyText,
      htmlSnippet: html.slice(0, 8000),
      bars,
      pctNodes,
      title: document.title,
      url: location.href,
    };
  });
}

function enrichFromDom(parsed, dom) {
  // aria-valuenow on progress bars
  if (dom.bars?.length) {
    for (const b of dom.bars) {
      let n = parseFloat(String(b.ariaNow ?? "").replace(/[^\d.]/g, ""));
      if (Number.isNaN(n)) {
        const w = String(b.childWidth || b.width || "");
        const wm = w.match(/(\d+(?:\.\d+)?)%/);
        if (wm) n = parseFloat(wm[1]);
      }
      if (Number.isNaN(n) || n < 0 || n > 100) continue;

      const ctx = `${b.ariaLabel || ""} ${b.parentText || ""} ${b.text || ""}`;
      let matchedCat = false;
      for (const name of KNOWN_CATEGORIES) {
        if (new RegExp(name.replace(/ /g, "\\s+"), "i").test(ctx)) {
          const display = name === "Build" ? "Grok Build" : name;
          const id = slug(display);
          if (!parsed.categories.some((c) => c.id === id)) {
            parsed.categories.push({
              id,
              name: display,
              used: 0,
              limit: 0,
              percent: clampPct(n),
              unit: null,
            });
          }
          matchedCat = true;
          break;
        }
      }
      if (
        !matchedCat &&
        (!parsed.overallPercent || parsed.overallPercent === 0) &&
        /weekly|overall|super|limit|usage|pool/i.test(ctx)
      ) {
        parsed.overallPercent = clampPct(n);
      }
    }

    // If still no overall, first bar with a valid %
    if (!parsed.overallPercent || parsed.overallPercent === 0) {
      for (const b of dom.bars) {
        let n = parseFloat(String(b.ariaNow ?? "").replace(/[^\d.]/g, ""));
        if (Number.isNaN(n)) {
          const w = String(b.childWidth || "");
          const wm = w.match(/(\d+(?:\.\d+)?)%/);
          if (wm) n = parseFloat(wm[1]);
        }
        if (!Number.isNaN(n) && n >= 0 && n <= 100) {
          parsed.overallPercent = clampPct(n);
          break;
        }
      }
    }
  }

  // pctNodes with category parents
  if (dom.pctNodes?.length) {
    for (const p of dom.pctNodes) {
      const n = parseFloat(p.text);
      if (Number.isNaN(n)) continue;
      const ctx = `${p.parent}\n${p.grand}`;
      for (const name of KNOWN_CATEGORIES) {
        if (new RegExp(name.replace(/ /g, "\\s+"), "i").test(ctx)) {
          const display = name === "Build" ? "Grok Build" : name;
          const id = slug(display);
          if (!parsed.categories.some((c) => c.id === id)) {
            parsed.categories.push({
              id,
              name: display,
              used: 0,
              limit: 0,
              percent: clampPct(n),
              unit: null,
            });
          }
        }
      }
    }
  }

  return parsed;
}

function looksLoggedOut(text, url) {
  const t = (text || "").toLowerCase();
  if (/accounts\.x\.ai|\/sign-in|\/login/i.test(url || "")) {
    return true;
  }
  // Explicit sign-in CTAs without a real percentage meter
  const hasSignInCta =
    /\bsign\s*in\b|\blog\s*in\b|\bsign\s*up\b|create\s+(an\s+)?account|continue\s+with/i.test(
      t
    );
  const hasPercent = /\d{1,3}(?:\.\d+)?\s*%/.test(t);
  const hasUsageSection =
    /weekly\s+supergrok|%\s*used|extra\s+usage\s+credits|resets?\s+[a-z]+\s+\d/i.test(
      t
    );
  if (hasSignInCta && !hasPercent) return true;
  if (hasSignInCta && !hasUsageSection) return true;
  return false;
}

function tryParseNetworkJson(bodies) {
  for (const raw of bodies) {
    try {
      const data = typeof raw === "string" ? JSON.parse(raw) : raw;
      const parsed = parseFlexibleApi(data);
      if (parsed) return parsed;
    } catch {
      /* not json */
    }
  }
  return null;
}

function parseFlexibleApi(data, depth = 0) {
  if (!data || depth > 6) return null;

  if (Array.isArray(data)) {
    for (const item of data) {
      const r = parseFlexibleApi(item, depth + 1);
      if (r) return r;
    }
    // array of rate limits
    const cats = [];
    for (const item of data) {
      if (!item || typeof item !== "object") continue;
      const name =
        item.name || item.label || item.feature || item.product || item.type;
      const used = num(item.used ?? item.usage ?? item.current ?? item.count);
      const limit = num(item.limit ?? item.quota ?? item.max ?? item.total);
      let percent = num(item.percent ?? item.percentage ?? item.pct);
      if (percent == null && used != null && limit) {
        percent = (used / limit) * 100;
      }
      if (name && percent != null) {
        cats.push({
          id: slug(String(name)),
          name: String(name),
          used: used ?? 0,
          limit: limit ?? 0,
          percent: clampPct(percent),
          unit: item.unit || null,
        });
      }
    }
    if (cats.length) {
      return {
        overallPercent: clampPct(
          cats.reduce((s, c) => s + c.percent, 0) <= 100.5
            ? cats.reduce((s, c) => s + c.percent, 0)
            : Math.max(...cats.map((c) => c.percent))
        ),
        categories: cats,
        resetsDate: "",
        resetsTime: "",
        resetsDisplay: "",
        extraCredits: null,
        extraCreditsLabel: null,
      };
    }
    return null;
  }

  if (typeof data === "object") {
    // Direct match our shape
    if (data.overallPercent != null || data.overall_percent != null) {
      return {
        overallPercent: clampPct(
          num(data.overallPercent ?? data.overall_percent) ?? 0
        ),
        categories: Array.isArray(data.categories) ? data.categories : [],
        resetsDate: data.resetsDate || data.resets_date || "",
        resetsTime: data.resetsTime || data.resets_time || "",
        resetsDisplay: data.resetsDisplay || data.resets_display || "",
        extraCredits: num(data.extraCredits ?? data.extra_credits),
        extraCreditsLabel: data.extraCreditsLabel || null,
      };
    }

    for (const key of [
      "categories",
      "rateLimits",
      "rate_limits",
      "quotas",
      "limits",
      "usage",
      "data",
      "result",
      "products",
    ]) {
      if (data[key]) {
        const r = parseFlexibleApi(data[key], depth + 1);
        if (r) {
          // pull overall from parent if present
          const overall = num(
            data.overallPercent ??
              data.overall_percent ??
              data.percent ??
              data.usagePercent ??
              data.usedPercent
          );
          if (overall != null) r.overallPercent = clampPct(overall);
          const reset =
            data.resetsAt ||
            data.resetAt ||
            data.reset_at ||
            data.nextReset ||
            data.resets_at;
          if (reset && typeof reset === "string") {
            r.resetsDisplay = reset;
            r.resetsDate = reset;
          }
          return r;
        }
      }
    }

    // walk values
    for (const v of Object.values(data)) {
      if (v && typeof v === "object") {
        const r = parseFlexibleApi(v, depth + 1);
        if (r) return r;
      }
    }
  }
  return null;
}

function num(v) {
  if (v == null) return null;
  if (typeof v === "number" && !Number.isNaN(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = parseFloat(v.replace(/,/g, ""));
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

async function dismissOverlays(page) {
  const labels = [
    /accept all cookies/i,
    /accept all/i,
    /got it/i,
    /i agree/i,
    /close/i,
  ];
  for (const re of labels) {
    try {
      const btn = page.getByRole("button", { name: re }).first();
      if (await btn.isVisible({ timeout: 800 })) {
        await btn.click({ timeout: 2000 });
        await page.waitForTimeout(400);
      }
    } catch {
      /* ignore */
    }
  }
}

async function openUsagePanel(page, usageUrl, timeout) {
  // Try several entry points
  const urls = [
    usageUrl,
    "https://grok.com/?_s=usage",
    "https://grok.com/",
  ];

  for (const url of urls) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout });
      await page.waitForTimeout(1500);
      await dismissOverlays(page);
    } catch {
      continue;
    }
  }

  // Click through profile → Usage (common Grok layout)
  const openers = [
    () => page.getByRole("button", { name: /account|profile|user|menu/i }).first(),
    () => page.locator('[data-testid*="user"], [data-testid*="account"], [aria-label*="Account"], [aria-label*="Profile"], [aria-label*="User"]').first(),
    () => page.locator('button:has(img), [role="button"]:has(img)').last(),
  ];

  for (const getEl of openers) {
    try {
      const el = getEl();
      if (await el.isVisible({ timeout: 1500 })) {
        await el.click({ timeout: 3000 });
        await page.waitForTimeout(800);
        break;
      }
    } catch {
      /* try next */
    }
  }

  // Click Usage in any menu / list
  const usageClickers = [
    () => page.getByRole("menuitem", { name: /^usage$/i }).first(),
    () => page.getByRole("link", { name: /^usage$/i }).first(),
    () => page.getByRole("button", { name: /^usage$/i }).first(),
    () => page.getByText(/^usage$/i).first(),
    () => page.getByText(/weekly\s+usage|usage\s+limit|view\s+usage/i).first(),
  ];

  for (const getEl of usageClickers) {
    try {
      const el = getEl();
      if (await el.isVisible({ timeout: 2000 })) {
        await el.click({ timeout: 4000 });
        await page.waitForTimeout(2500);
        break;
      }
    } catch {
      /* try next */
    }
  }

  // Direct nav again after menu interactions
  try {
    await page.goto("https://grok.com/?_s=usage", {
      waitUntil: "networkidle",
      timeout: Math.min(timeout, 45000),
    });
  } catch {
    try {
      await page.goto("https://grok.com/?_s=usage", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
    } catch {
      /* ignore */
    }
  }

  // Wait for something usage-like
  try {
    await page.waitForFunction(
      () => {
        const t = document.body?.innerText || "";
        return (
          /\d+\s*%/.test(t) ||
          /weekly|supergrok|usage/i.test(t) ||
          document.querySelectorAll('[role="progressbar"]').length > 0
        );
      },
      { timeout: 20000 }
    );
  } catch {
    /* continue with whatever we have */
  }

  await page.waitForTimeout(1500);
}

function writeDebug(debugDir, dom, note) {
  try {
    if (!existsSync(debugDir)) mkdirSync(debugDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = join(debugDir, `usage-debug-${stamp}`);
    writeFileSync(
      `${base}.txt`,
      [
        `NOTE: ${note}`,
        `URL: ${dom.url}`,
        `TITLE: ${dom.title}`,
        `BARS: ${JSON.stringify(dom.bars, null, 2)}`,
        `PCT_NODES: ${JSON.stringify(dom.pctNodes, null, 2)}`,
        "----- BODY TEXT -----",
        dom.bodyText,
        "----- HTML SNIPPET -----",
        dom.htmlSnippet,
      ].join("\n\n"),
      "utf8"
    );
    return `${base}.txt`;
  } catch (e) {
    return `debug write failed: ${e.message}`;
  }
}

async function main() {
  const raw = readStdin();
  if (!raw.trim()) fail("No config JSON received on stdin");

  let config;
  try {
    config = JSON.parse(raw);
  } catch (e) {
    fail(`Invalid config JSON: ${e.message}`);
  }

  const userDataDir = config.userDataDir;
  const usageUrl = config.usageUrl || "https://grok.com/?_s=usage";
  const headed = Boolean(config.headed);
  const timeout = config.timeoutMs || 120_000;
  const channel = config.channel || undefined;
  const debugDir =
    config.debugDir ||
    join(userDataDir || ".", "..", "debug");

  if (!userDataDir) fail("userDataDir is required");

  /** @type {import('playwright').BrowserContext} */
  let context;
  const networkBodies = [];

  try {
    const launchOpts = {
      headless: !headed,
      viewport: { width: 1400, height: 960 },
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
      ],
      ignoreDefaultArgs: ["--enable-automation"],
    };
    if (channel) launchOpts.channel = channel;

    context = await chromium.launchPersistentContext(userDataDir, launchOpts);
  } catch (e) {
    fail(
      `Failed to launch browser: ${e.message}. Tip: run npm run playwright:install. If using channel=chrome, fully quit Chrome first.`
    );
  }

  try {
    // Capture JSON-ish API responses that might contain quotas
    context.on("response", async (response) => {
      try {
        const url = response.url();
        const ct = (response.headers()["content-type"] || "").toLowerCase();
        if (!/json|text|javascript/i.test(ct) && !/usage|rate|quota|limit|billing|subscription/i.test(url)) {
          return;
        }
        if (!/grok\.com|x\.ai/i.test(url)) return;
        if (response.status() !== 200) return;
        const text = await response.text();
        if (
          text &&
          text.length < 2_000_000 &&
          (text.includes("%") ||
            /usage|quota|rateLimit|rate_limit|percent/i.test(text))
        ) {
          networkBodies.push(text);
        }
      } catch {
        /* ignore body read errors */
      }
    });

    const page = context.pages()[0] || (await context.newPage());
    page.setDefaultTimeout(timeout);

    await openUsagePanel(page, usageUrl, timeout);

    let dom = await deepScrape(page);

    // Login wait when headed
    if (looksLoggedOut(dom.bodyText, dom.url) && headed) {
      const deadline = Date.now() + 150_000;
      while (Date.now() < deadline) {
        await page.waitForTimeout(3000);
        if (!/grok\.com/i.test(page.url())) {
          try {
            await page.goto(usageUrl, {
              waitUntil: "domcontentloaded",
              timeout: 30000,
            });
          } catch {
            /* keep waiting */
          }
        } else {
          // try open usage again
          try {
            await openUsagePanel(page, usageUrl, 30000);
          } catch {
            /* ignore */
          }
        }
        dom = await deepScrape(page);
        if (!looksLoggedOut(dom.bodyText, dom.url) && /\d+\s*%/.test(dom.bodyText)) {
          break;
        }
      }
    }

    if (looksLoggedOut(dom.bodyText, dom.url)) {
      const path = writeDebug(debugDir, dom, "logged_out");
      try {
        await page.screenshot({
          path: join(debugDir, "usage-debug-latest.png"),
          fullPage: true,
        });
      } catch {
        /* ignore */
      }
      fail(
        "Could not read usage — are you logged in? Turn on Headed browser in Settings, click Refresh, sign in to grok.com, then open Usage (profile menu → Usage).",
        { sample: dom.bodyText.slice(0, 500), debugPath: path }
      );
    }

    // Prefer network JSON if we snagged something useful
    let parsed = tryParseNetworkJson(networkBodies);
    if (!parsed) {
      parsed = parseUsageText(dom.bodyText);
      parsed = enrichFromDom(parsed, dom);
    }

    const hasData =
      (parsed.overallPercent && parsed.overallPercent > 0) ||
      parsed.categories.length > 0;

    if (!hasData) {
      // One more attempt: scroll and wait
      try {
        await page.mouse.wheel(0, 800);
        await page.waitForTimeout(2000);
        dom = await deepScrape(page);
        parsed = parseUsageText(dom.bodyText);
        parsed = enrichFromDom(parsed, dom);
      } catch {
        /* ignore */
      }
    }

    const ok =
      (parsed.overallPercent && parsed.overallPercent > 0) ||
      parsed.categories.length > 0;

    if (!ok) {
      const path = writeDebug(debugDir, dom, "parse_failed");
      try {
        await page.screenshot({
          path: join(debugDir, "usage-debug-latest.png"),
          fullPage: true,
        });
      } catch {
        /* ignore */
      }
      fail(
        "Could not parse usage numbers from the page. Debug dump saved — send usage-debug-*.txt if you need help.",
        {
          sample: (dom.bodyText || "").slice(0, 600),
          debugPath: path,
          url: dom.url,
        }
      );
    }

    const snapshot = {
      overallPercent: parsed.overallPercent || 0,
      categories: parsed.categories,
      resetsDate: parsed.resetsDate || "",
      resetsTime: parsed.resetsTime || "",
      resetsDisplay: parsed.resetsDisplay || "",
      extraCredits: parsed.extraCredits,
      extraCreditsLabel: parsed.extraCreditsLabel,
      fetchedAt: new Date().toISOString(),
      isMock: false,
      source: "playwright",
      note: null,
    };

    process.stdout.write(JSON.stringify(snapshot) + "\n");
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch((e) => fail(e?.message || String(e)));
