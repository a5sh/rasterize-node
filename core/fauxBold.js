// core/fauxBold.js
//
// Faux-bold synthesis for rasterizers that ship NotoSans-Regular only.
// Applied on ALL nodes so output is identical regardless of hosting platform.
//
// WHAT WAS BROKEN
// ───────────────
// 1. Only matched font-weight as a bare XML attribute:  font-weight="bold"
//    Missed inline style:                               style="font-weight: bold; ..."
// 2. Only matched the <text> opening tag.
//    Missed bold on <tspan> children:                   <text><tspan font-weight="bold">…
//
// STROKE CALIBRATION
// ──────────────────
// 0.035em  matches librsvg/wsrv.nl visual weight at poster-badge sizes.
// All nodes use this value — do not change per-platform.

// ── Attribute helpers ─────────────────────────────────────────────────────────

/** Extract the value of a named CSS property from a style="…" attribute. */
function styleValue(tag, prop) {
  const styleAttr = tag.match(/\bstyle=["']([^"']*)["']/i);
  if (!styleAttr) return null;
  // Match   ;font-weight: bold   or   font-weight:bold   at start of style
  const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i');
  const m  = styleAttr[1].match(re);
  return m ? m[1].trim() : null;
}

const BOLD_WEIGHT_RE = /^(bold|bolder|[6-9]\d\d)$/i;

/** True when the element has a bold font-weight (attribute OR style). */
function isBold(tag) {
  // Standalone attribute:  font-weight="700"
  const attr = tag.match(/\bfont-weight=["']?([^"'\s>]+)["']?/i);
  if (attr && BOLD_WEIGHT_RE.test(attr[1])) return true;

  // Inside style="…":  style="font-weight: bold"
  const sv = styleValue(tag, 'font-weight');
  if (sv && BOLD_WEIGHT_RE.test(sv)) return true;

  return false;
}

/** True when the element already carries an explicit stroke (skip it). */
function hasStroke(tag) {
  // Bare stroke attribute that is not "none"
  const strokeAttr = tag.match(/\bstroke=["']([^"']*)["']/i);
  if (strokeAttr && strokeAttr[1] !== 'none') return true;

  // stroke inside style
  const sv = styleValue(tag, 'stroke');
  if (sv && sv !== 'none') return true;

  return false;
}

/** Resolve the stroke colour from fill (keeps the synthesised stroke invisible). */
function strokeColor(tag) {
  const fillAttr = tag.match(/\bfill=["']([^"']+)["']/i);
  if (fillAttr) return fillAttr[1];

  const sv = styleValue(tag, 'fill');
  if (sv) return sv;

  return 'currentColor';
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Add a calibrated SVG stroke to every bold <text> or <tspan> element
 * so that Regular-only fonts appear visually bold (matching wsrv.nl/librsvg).
 *
 * Safe to call multiple times — elements that already have a stroke are
 * left untouched.
 *
 * @param {string} svgText   Raw SVG markup
 * @param {string} [sw]      CSS stroke-width  (default: '0.035em')
 * @returns {string}
 */
export function applyFauxBold(svgText, sw = '0.035em') {
  // WHY TWO PASSES
  // ──────────────
  // A single combined regex /(<(?:text|tspan)…)>…<\/(?:text|tspan)>/g is
  // non-greedy, so when it anchors on an outer <text> it finds the first
  // closing </tspan> as its end — consuming the inner tspan before it ever
  // gets its own match.
  //
  // Fix: run tspan first (processes inner elements while they're still
  // standalone matches), then text (outer element now sees the already-
  // modified tspan body, and hasStroke() will correctly skip it).

  function enhance(openTag, body, closeTag) {
    if (!isBold(openTag))   return `${openTag}>${body}</${closeTag}>`;
    if (hasStroke(openTag)) return `${openTag}>${body}</${closeTag}>`;
    const col      = strokeColor(openTag);
    const enhanced = `${openTag} stroke="${col}" stroke-width="${sw}"` +
                     ` stroke-linejoin="round" paint-order="stroke fill"`;
    return `${enhanced}>${body}</${closeTag}>`;
  }

  // Pass 1 — <tspan> elements (innermost first)
  const pass1 = svgText.replace(
    /(<tspan(?:\s[^>]*)?)>([\s\S]*?)<\/tspan>/gi,
    (_, openTag, body) => enhance(openTag, body, 'tspan'),
  );

  // Pass 2 — <text> elements (body now contains already-processed tspans)
  return pass1.replace(
    /(<text(?:\s[^>]*)?)>([\s\S]*?)<\/text>/gi,
    (_, openTag, body) => enhance(openTag, body, 'text'),
  );
}

/**
 * Convenience wrapper — skips synthesis when the renderer has real bold fonts.
 * Pass hasBoldFonts=true only if you are CERTAIN bold TTF variants are loaded.
 * For consistency across the fleet, always pass false (or just call applyFauxBold).
 */
export function conditionalFauxBold(svgText, hasBoldFonts) {
  return hasBoldFonts ? svgText : applyFauxBold(svgText);
}