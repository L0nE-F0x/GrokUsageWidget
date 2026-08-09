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

/** Parse a currency amount string like "15", "15.00", "1,234.5". */
function parseMoney(raw) {
  if (raw == null) return null;
  const n = parseFloat(String(raw).replace(/,/g, "").replace(/[^\d.-]/g, ""));
  return Number.isNaN(n) ? null : n;
}

/** Currency amount capture (US$1.76, $1.76, USD 1.76, fullwidth ＄). */
const MONEY_RE =
  /(?:US\s*[\$＄]|USD\s*|U\.?S\.?\s*[\$＄]|[\$＄])\s*([\d,]+(?:\.\d+)?)/i;
const MONEY_RE_TRAILING =
  /([\d,]+(?:\.\d+)?)\s*(?:USD|US\s*[\$＄]|[\$＄])/i;

/**
 * True when a % figure is a sale/promo badge (e.g. "Up to 40% Off"), not usage.
 */
function isPromoPercentContext(text) {
  const t = String(text || "");
  return (
    /\d{1,3}(?:\.\d+)?\s*%\s*off\b/i.test(t) ||
    /\bup\s+to\s+\d{1,3}(?:\.\d+)?\s*%/i.test(t) ||
    /\b(?:save|discount|sale|promo|deal)\b[^.\n]{0,20}\d{1,3}(?:\.\d+)?\s*%/i.test(
      t
    ) ||
    /\d{1,3}(?:\.\d+)?\s*%[^.\n]{0,20}\b(?:off|discount|save|sale)\b/i.test(t)
  );
}

/**
 * Strip promotional "N% Off" / "Up to N%" badges so they cannot be read as usage.
 */
function stripPromoPercents(text) {
  return String(text || "")
    .replace(/\bup\s+to\s+\d{1,3}(?:\.\d+)?\s*%\s*off\b/gi, " ")
    .replace(/\bup\s+to\s+\d{1,3}(?:\.\d+)?\s*%/gi, " ")
    .replace(/\d{1,3}(?:\.\d+)?\s*%\s*off\b/gi, " ")
    .replace(/\bsave\s+\d{1,3}(?:\.\d+)?\s*%/gi, " ");
}

/**
 * Extract Extra Usage Credits balance from page text.
 * Current Grok layout (2026):
 *   Extra Usage Credits
 *   US$1.76
 *   Additional Credits
 *   Buy Credits   [Up to 40% Off]
 */
function parseExtraCredits(flat, cleaned, lines) {
  let extraCredits = null;
  let extraCreditsLabel = null;

  const trySet = (raw) => {
    const val = parseMoney(raw);
    if (val != null && val >= 0 && val < 1_000_000) {
      extraCredits = val;
      extraCreditsLabel = `$${val.toFixed(2)}`;
      return true;
    }
    return false;
  };

  const creditPatterns = [
    // Amount sitting above "Additional Credits" (current grok.com layout)
    new RegExp(
      MONEY_RE.source + "\\s*additional\\s+credits?",
      "i"
    ),
    // Section heading then amount (wide window — tooltips can sit between)
    /extra\s+usage\s+credits?[\s\S]{0,400}?(?:US\s*[\$＄]|USD\s*|U\.?S\.?\s*[\$＄]|[\$＄])\s*([\d,]+(?:\.\d+)?)/i,
    /(?:US\s*[\$＄]|[\$＄])\s*([\d,]+(?:\.\d+)?)\s*(?:in\s+)?extra\s+(?:usage\s+)?credits?/i,
    // Balance line near credits
    /(?:credit\s+)?balance\s*[:\-]?\s*(?:US\s*[\$＄]|USD\s*|[\$＄])\s*([\d,]+(?:\.\d+)?)/i,
    /(?:US\s*[\$＄]|[\$＄])\s*([\d,]+(?:\.\d+)?)\s*(?:credit\s+)?balance/i,
    // Additional credits label then amount
    /additional\s+credits?\s*[:\-]?\s*(?:US\s*[\$＄]|USD\s*|[\$＄])\s*([\d,]+(?:\.\d+)?)/i,
    /credits?\s+(?:balance|remaining|available)?\s*[:\-]?\s*(?:US\s*[\$＄]|USD\s*|[\$＄])\s*([\d,]+(?:\.\d+)?)/i,
  ];

  for (const re of creditPatterns) {
    const m = flat.match(re) || cleaned.match(re);
    if (m && trySet(m[1])) break;
  }

  // Multi-line: scan the Extra Usage Credits block for any money token
  if (extraCredits == null && Array.isArray(lines)) {
    for (let i = 0; i < lines.length; i++) {
      if (!/extra\s+usage\s+credits?/i.test(lines[i])) continue;
      // Walk forward through the credits card
      for (let j = i; j < Math.min(i + 14, lines.length); j++) {
        // Stop if we clearly left the credits card
        if (j > i && /^(auto\s+top-?up|weekly\s+supergrok|data\s+controls)/i.test(lines[j])) {
          break;
        }
        let mm = lines[j].match(MONEY_RE) || lines[j].match(MONEY_RE_TRAILING);
        if (mm && trySet(mm[1])) break;
        // Plain "1.76" immediately before "Additional Credits"
        if (
          j + 1 < lines.length &&
          /additional\s+credits?/i.test(lines[j + 1])
        ) {
          const plain = lines[j].match(/^([\d,]+(?:\.\d{1,2})?)$/);
          if (plain && trySet(plain[1])) break;
        }
      }
      // Zero-balance layout: section + Buy Credits / Additional Credits, no money
      if (
        extraCredits == null &&
        lines
          .slice(i, i + 14)
          .some((l) => /additional\s+credits?|buy\s+credits?|auto\s+top-?up/i.test(l))
      ) {
        const block = lines.slice(i, i + 14).join(" ");
        if (!MONEY_RE.test(block) && !MONEY_RE_TRAILING.test(block)) {
          extraCredits = 0;
          extraCreditsLabel = "$0.00";
        }
      }
      break;
    }
  }

  // Last resort: first money token after "Extra Usage Credits" in flat text
  if (extraCredits == null) {
    const idx = (flat || "").search(/extra\s+usage\s+credits?/i);
    if (idx >= 0) {
      const tail = flat.slice(idx, idx + 500);
      const mm = tail.match(MONEY_RE) || tail.match(MONEY_RE_TRAILING);
      if (mm) trySet(mm[1]);
      else if (/additional\s+credits?|buy\s+credits?/i.test(tail)) {
        // Section present, no amount → $0
        extraCredits = 0;
        extraCreditsLabel = "$0.00";
      }
    }
  }

  return { extraCredits, extraCreditsLabel };
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
 * Returns { ..., overallFound } so 0% is distinguishable from "not found".
 */
function parseUsageText(text) {
  // Collapse all whitespace (including newlines) so "0%\nused" matches "% used"
  const cleaned = text
    .replace(/\u00a0/g, " ")
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n+/g, "\n")
    .trim();
  // Flat string for patterns that span lines (Grok UI often splits "0%" / "used")
  const flat = cleaned.replace(/\n+/g, " ").replace(/ {2,}/g, " ");
  // Promo badges ("Up to 40% Off") must never be read as SuperGrok usage
  const flatUsage = stripPromoPercents(flat);
  const cleanedUsage = stripPromoPercents(cleaned);
  const lines = cleaned
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  let overallPercent = null;
  let overallFound = false;

  // Prefer explicit "used" phrasing (0% is valid - weekly pool unused)
  // Do NOT use loose "usage … N%" — that matches "Extra Usage Credits … 40% Off"
  const overallPatterns = [
    /(\d{1,3}(?:\.\d+)?)\s*%\s*used\b/i,
    /\bused\s*[:\-]?\s*(\d{1,3}(?:\.\d+)?)\s*%/i,
    /weekly\s+supergrok\s+limit[\s\S]{0,80}?(\d{1,3}(?:\.\d+)?)\s*%/i,
    /supergrok\s+limit[\s\S]{0,60}?(\d{1,3}(?:\.\d+)?)\s*%/i,
    /(\d{1,3}(?:\.\d+)?)\s*%\s*(?:of\s+)?(?:your\s+)?(?:weekly|limit|pool)\b/i,
  ];
  for (const re of overallPatterns) {
    const m = flatUsage.match(re) || cleanedUsage.match(re);
    if (!m) continue;
    // Guard: reject if the match itself is promo-flavored
    const around = flatUsage.slice(
      Math.max(0, (m.index ?? 0) - 12),
      (m.index ?? 0) + m[0].length + 12
    );
    if (isPromoPercentContext(around) || isPromoPercentContext(m[0])) continue;
    overallPercent = clampPct(parseFloat(m[1]));
    overallFound = true;
    break;
  }

  // Multi-line: "Weekly SuperGrok Limit" then "NN%" / "NN% used" (skip promo lines)
  if (!overallFound) {
    for (let i = 0; i < lines.length; i++) {
      if (/weekly\s+supergrok|supergrok\s+limit|weekly\s+limit/i.test(lines[i])) {
        for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
          if (isPromoPercentContext(lines[j])) continue;
          // Stop at credits / other sections
          if (
            /extra\s+usage\s+credits?|auto\s+top-?up|buy\s+credits?/i.test(
              lines[j]
            )
          ) {
            break;
          }
          const um = lines[j].match(/^(\d{1,3}(?:\.\d+)?)\s*%\s*used$/i);
          if (um) {
            overallPercent = clampPct(parseFloat(um[1]));
            overallFound = true;
            break;
          }
          const pm = lines[j].match(/^(\d{1,3}(?:\.\d+)?)\s*%$/);
          if (pm) {
            // "0%" then "used" on the next line
            if (j + 1 < lines.length && /^used$/i.test(lines[j + 1])) {
              overallPercent = clampPct(parseFloat(pm[1]));
              overallFound = true;
              break;
            }
            // Bare "NN%" under the weekly limit heading (before Resets)
            if (
              j + 1 < lines.length &&
              /resets?/i.test(lines[j + 1])
            ) {
              overallPercent = clampPct(parseFloat(pm[1]));
              overallFound = true;
              break;
            }
            // Or immediately after heading / "used" nearby in window
            overallPercent = clampPct(parseFloat(pm[1]));
            overallFound = true;
            break;
          }
        }
        break;
      }
    }
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
    const m = flat.match(re) || cleaned.match(re);
    if (m) {
      resetsDate = (m[1] || "").trim();
      resetsTime = (m[2] || "").trim();
      resetsDisplay = [resetsDate, resetsTime ? `at ${resetsTime}` : ""]
        .filter(Boolean)
        .join(" ");
      break;
    }
  }

  const credits = parseExtraCredits(flat, cleaned, lines);
  let extraCredits = credits.extraCredits;
  let extraCreditsLabel = credits.extraCreditsLabel;

  if (!overallFound && categories.length) {
    // Don't invent overall from average of categories - use max as rough signal only if no overall
    const max = Math.max(...categories.map((c) => c.percent));
    // Prefer sum if they look like parts of a whole (~100)
    const sum = categories.reduce((s, c) => s + c.percent, 0);
    overallPercent = clampPct(sum <= 100.5 ? sum : max);
    overallFound = true;
  }

  // Reset date alone is strong evidence we opened the usage panel
  const usageSection =
    overallFound ||
    categories.length > 0 ||
    /weekly\s+supergrok\s+limit/i.test(flat) ||
    Boolean(resetsDisplay);

  return {
    overallPercent: overallPercent ?? 0,
    overallFound,
    usageSection,
    categories,
    resetsDate,
    resetsTime,
    resetsDisplay,
    extraCredits,
    extraCreditsLabel,
  };
}

/** True when we successfully read usage (including legitimate 0%). */
function hasUsageData(parsed) {
  if (!parsed) return false;
  if (parsed.overallFound) return true;
  if (parsed.categories && parsed.categories.length > 0) return true;
  // Usage panel open with reset line even if % missed (still show something)
  if (parsed.usageSection && parsed.resetsDisplay) return true;
  // Back-compat: numeric overall was set without flag (network JSON path)
  if (
    typeof parsed.overallPercent === "number" &&
    !Number.isNaN(parsed.overallPercent) &&
    parsed.overallPercent > 0
  ) {
    return true;
  }
  return false;
}

/**
 * Merge network JSON usage with text/DOM scrape.
 * Network is preferred for categories; text is preferred for overall when it
 * has an explicit "% used" reading (avoids promo % leaking in via APIs/DOM).
 * Credits/resets always fill from whichever side has them.
 */
function mergeParsed(primary, secondary) {
  if (!primary) return secondary;
  if (!secondary) return primary;
  const out = { ...primary };

  // Credits: prefer non-null; if both set and secondary is non-zero while primary is 0, take secondary
  if (secondary.extraCredits != null && !Number.isNaN(secondary.extraCredits)) {
    if (
      out.extraCredits == null ||
      Number.isNaN(out.extraCredits) ||
      (out.extraCredits === 0 && secondary.extraCredits > 0)
    ) {
      out.extraCredits = secondary.extraCredits;
      out.extraCreditsLabel =
        secondary.extraCreditsLabel ||
        `$${Number(secondary.extraCredits).toFixed(2)}`;
    }
  }

  if (!out.resetsDisplay && secondary.resetsDisplay) {
    out.resetsDisplay = secondary.resetsDisplay;
    out.resetsDate = secondary.resetsDate || out.resetsDate || "";
    out.resetsTime = secondary.resetsTime || out.resetsTime || "";
  } else if (!out.resetsDate && secondary.resetsDate) {
    out.resetsDate = secondary.resetsDate;
    out.resetsTime = secondary.resetsTime || out.resetsTime || "";
  }

  if (
    (!out.categories || out.categories.length === 0) &&
    secondary.categories?.length
  ) {
    out.categories = secondary.categories;
  }

  // Overall: prefer secondary (text/DOM) when it found usage and primary looks wrong
  // (e.g. primary only has promo-ish values) or primary never found overall.
  if (secondary.overallFound) {
    if (!out.overallFound) {
      out.overallPercent = secondary.overallPercent;
      out.overallFound = true;
    } else if (
      // Text has a plausible reading that disagrees — trust text "% used" path
      typeof secondary.overallPercent === "number" &&
      typeof out.overallPercent === "number" &&
      secondary.overallPercent !== out.overallPercent &&
      secondary.resetsDisplay
    ) {
      out.overallPercent = secondary.overallPercent;
    }
  }

  out.usageSection = Boolean(
    out.usageSection || secondary.usageSection || hasUsageData(out)
  );
  return out;
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
    // Currency-like leaves (US$0.00, $15, 0.00 USD)
    const moneyNodes = [];
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
      if (
        moneyNodes.length < 40 &&
        t.length > 0 &&
        t.length < 24 &&
        /^(?:US\s*\$|\$)\s*[\d,]+(?:\.\d+)?$|^[\d,]+(?:\.\d{1,2})?\s*(?:USD|US\$)$/i.test(
          t
        )
      ) {
        const parent = node.parentElement;
        moneyNodes.push({
          text: t,
          parent: (parent?.innerText || "").slice(0, 240),
          grand: (parent?.parentElement?.innerText || "").slice(0, 240),
        });
      }
    }

    return {
      bodyText,
      htmlSnippet: html.slice(0, 8000),
      bars,
      pctNodes,
      moneyNodes,
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
      // Never treat promo/discount chrome as usage meters
      if (isPromoPercentContext(ctx) || /buy\s+credits?|top-?up|off\b/i.test(ctx)) {
        continue;
      }
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
        !parsed.overallFound &&
        /weekly\s+supergrok|supergrok\s+limit|%\s*used|\bused\b/i.test(ctx)
      ) {
        parsed.overallPercent = clampPct(n);
        parsed.overallFound = true;
      }
    }

    // If still no overall, first bar under weekly limit context only (not "any bar")
    if (!parsed.overallFound) {
      for (const b of dom.bars) {
        const ctx = `${b.ariaLabel || ""} ${b.parentText || ""} ${b.text || ""}`;
        if (isPromoPercentContext(ctx) || /buy\s+credits?|off\b/i.test(ctx)) {
          continue;
        }
        if (!/weekly|supergrok|limit|%\s*used|\bused\b/i.test(ctx)) continue;
        let n = parseFloat(String(b.ariaNow ?? "").replace(/[^\d.]/g, ""));
        if (Number.isNaN(n)) {
          const w = String(b.childWidth || "");
          const wm = w.match(/(\d+(?:\.\d+)?)%/);
          if (wm) n = parseFloat(wm[1]);
        }
        if (!Number.isNaN(n) && n >= 0 && n <= 100) {
          parsed.overallPercent = clampPct(n);
          parsed.overallFound = true;
          break;
        }
      }
    }
  }

  // pctNodes: "NN%" leaves — match categories or overall "used"
  if (dom.pctNodes?.length) {
    for (const p of dom.pctNodes) {
      const n = parseFloat(p.text);
      if (Number.isNaN(n)) continue;
      const ctx = `${p.parent}\n${p.grand}`;
      // "40%" inside "Up to 40% Off" badge
      if (isPromoPercentContext(ctx) || /buy\s+credits?|\boff\b/i.test(ctx)) {
        continue;
      }
      let matchedCat = false;
      for (const name of KNOWN_CATEGORIES) {
        if (new RegExp(name.replace(/ /g, "\\s+"), "i").test(ctx)) {
          // Don't treat "Buy Credits" region category ghosts
          if (/buy\s+credits?|extra\s+usage\s+credits?/i.test(ctx)) continue;
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
        !parsed.overallFound &&
        // Require real usage wording — bare "usage" also matches "Extra Usage Credits"
        /%\s*used|\bused\b|weekly\s+supergrok|supergrok\s+limit/i.test(ctx)
      ) {
        parsed.overallPercent = clampPct(n);
        parsed.overallFound = true;
      }
    }
  }

  // Money nodes near Extra Usage Credits / Balance / Additional Credits
  if (
    (parsed.extraCredits == null || Number.isNaN(parsed.extraCredits)) &&
    dom.moneyNodes?.length
  ) {
    // Prefer nodes whose context is the credits balance, not purchase buttons
    const ranked = [...dom.moneyNodes].sort((a, b) => {
      const score = (m) => {
        const ctx = `${m.parent || ""}\n${m.grand || ""}`;
        let s = 0;
        if (/additional\s+credits?/i.test(ctx)) s += 5;
        if (/extra\s+usage\s+credits?/i.test(ctx)) s += 4;
        if (/balance/i.test(ctx)) s += 3;
        if (/buy\s+credits?/i.test(ctx)) s -= 2;
        return s;
      };
      return score(b) - score(a);
    });
    for (const m of ranked) {
      const ctx = `${m.parent || ""}\n${m.grand || ""}`;
      if (
        !/extra\s+usage\s+credits?|credit\s+balance|additional\s+credits?/i.test(
          ctx
        )
      ) {
        continue;
      }
      const mm =
        String(m.text).match(MONEY_RE) ||
        String(m.text).match(MONEY_RE_TRAILING) ||
        String(m.text).match(/([\d,]+(?:\.\d+)?)/);
      if (!mm) continue;
      const val = parseMoney(mm[1]);
      if (val != null && val >= 0 && val < 1_000_000) {
        parsed.extraCredits = val;
        parsed.extraCreditsLabel = `$${val.toFixed(2)}`;
        break;
      }
    }
  }

  // Text path again on body (covers cases where network path skipped it)
  if (
    (parsed.extraCredits == null || Number.isNaN(parsed.extraCredits)) &&
    dom.bodyText
  ) {
    const fromText = parseExtraCredits(
      dom.bodyText.replace(/\n+/g, " ").replace(/ {2,}/g, " "),
      dom.bodyText,
      (dom.bodyText || "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
    );
    if (fromText.extraCredits != null) {
      parsed.extraCredits = fromText.extraCredits;
      parsed.extraCreditsLabel = fromText.extraCreditsLabel;
    }
  }

  if (parsed.overallFound || parsed.categories.length > 0) {
    parsed.usageSection = true;
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
    // Credit balance payloads (wallet / prepaid / top-up)
    const creditVal = extractCreditsFromObject(data);
    // Direct match our shape
    if (data.overallPercent != null || data.overall_percent != null) {
      const credits =
        num(data.extraCredits ?? data.extra_credits) ?? creditVal;
      return {
        overallPercent: clampPct(
          num(data.overallPercent ?? data.overall_percent) ?? 0
        ),
        categories: Array.isArray(data.categories) ? data.categories : [],
        resetsDate: data.resetsDate || data.resets_date || "",
        resetsTime: data.resetsTime || data.resets_time || "",
        resetsDisplay: data.resetsDisplay || data.resets_display || "",
        extraCredits: credits,
        extraCreditsLabel:
          data.extraCreditsLabel ||
          (credits != null ? `$${Number(credits).toFixed(2)}` : null),
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
          if (r.extraCredits == null && creditVal != null) {
            r.extraCredits = creditVal;
            r.extraCreditsLabel = `$${Number(creditVal).toFixed(2)}`;
          }
          return r;
        }
      }
    }

    // walk values
    for (const v of Object.values(data)) {
      if (v && typeof v === "object") {
        const r = parseFlexibleApi(v, depth + 1);
        if (r) {
          if (r.extraCredits == null && creditVal != null) {
            r.extraCredits = creditVal;
            r.extraCreditsLabel = `$${Number(creditVal).toFixed(2)}`;
          }
          return r;
        }
      }
    }

    // Do not return credit-only objects as a usage snapshot — they would
    // stomp real overall % with 0. Credits are merged via extractCreditsFromNetwork.
  }
  return null;
}

/** Scan captured network JSON bodies for a credit balance. */
function extractCreditsFromNetwork(bodies) {
  for (const raw of bodies) {
    try {
      const data = typeof raw === "string" ? JSON.parse(raw) : raw;
      const val = findCreditsDeep(data, 0);
      if (val != null) return val;
    } catch {
      /* not json */
    }
  }
  return null;
}

function findCreditsDeep(data, depth) {
  if (!data || depth > 8) return null;
  if (Array.isArray(data)) {
    for (const item of data) {
      const v = findCreditsDeep(item, depth + 1);
      if (v != null) return v;
    }
    return null;
  }
  if (typeof data === "object") {
    const direct = extractCreditsFromObject(data);
    if (direct != null) return direct;
    for (const v of Object.values(data)) {
      if (v && typeof v === "object") {
        const found = findCreditsDeep(v, depth + 1);
        if (found != null) return found;
      }
    }
  }
  return null;
}

/** Pull prepaid / extra credit balance from common API field names. */
function extractCreditsFromObject(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const keys = [
    "extraCredits",
    "extra_credits",
    "extraUsageCredits",
    "extra_usage_credits",
    "creditBalance",
    "credit_balance",
    "creditsBalance",
    "credits_balance",
    "prepaidBalance",
    "prepaid_balance",
    "topupBalance",
    "top_up_balance",
    "topUpBalance",
    "walletBalance",
    "wallet_balance",
    "usageCredits",
    "usage_credits",
  ];
  for (const k of keys) {
    if (k in data) {
      const v = num(data[k]);
      if (v != null && v >= 0) return v;
      // Nested { amount: 15 } / { value: "15.00" }
      if (data[k] && typeof data[k] === "object") {
        const nested = num(
          data[k].amount ?? data[k].value ?? data[k].balance ?? data[k].usd
        );
        if (nested != null && nested >= 0) return nested;
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
            /usage|quota|rateLimit|rate_limit|percent|credit|balance|billing|wallet|top.?up|prepaid/i.test(
              text
            ))
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

    // Prefer network JSON for usage %, but always merge text/DOM for credits + resets
    let textParsed = parseUsageText(dom.bodyText);
    textParsed = enrichFromDom(textParsed, dom);

    let parsed = tryParseNetworkJson(networkBodies);
    if (parsed) {
      // Network path: treat any numeric overall (incl. 0) as found when present
      if (typeof parsed.overallPercent === "number") {
        parsed.overallFound = true;
      }
      parsed.usageSection = hasUsageData(parsed);
      parsed = mergeParsed(parsed, textParsed);
    } else {
      parsed = textParsed;
    }

    // Dedicated network credit scan (wallet/billing APIs without usage %)
    const netCredits = extractCreditsFromNetwork(networkBodies);
    if (
      netCredits != null &&
      (parsed.extraCredits == null || Number.isNaN(parsed.extraCredits))
    ) {
      parsed.extraCredits = netCredits;
      parsed.extraCreditsLabel = `$${Number(netCredits).toFixed(2)}`;
    }

    if (!hasUsageData(parsed)) {
      // One more attempt: scroll and wait
      try {
        await page.mouse.wheel(0, 800);
        await page.waitForTimeout(2000);
        dom = await deepScrape(page);
        textParsed = parseUsageText(dom.bodyText);
        textParsed = enrichFromDom(textParsed, dom);
        if (parsed && hasUsageData(parsed)) {
          parsed = mergeParsed(parsed, textParsed);
        } else {
          parsed = textParsed;
        }
        if (
          (parsed.extraCredits == null || Number.isNaN(parsed.extraCredits)) &&
          netCredits != null
        ) {
          parsed.extraCredits = netCredits;
          parsed.extraCreditsLabel = `$${Number(netCredits).toFixed(2)}`;
        }
      } catch {
        /* ignore */
      }
    }

    if (!hasUsageData(parsed)) {
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
      // Keep 0 - do not coerce with || (0 is a valid weekly usage reading)
      overallPercent:
        typeof parsed.overallPercent === "number" &&
        !Number.isNaN(parsed.overallPercent)
          ? parsed.overallPercent
          : 0,
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
