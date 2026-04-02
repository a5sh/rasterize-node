// core/fauxBold.js
//
// Shared faux-bold synthesis for rasterizers that lack a genuine bold font
// variant (edge-node, vercel-node, netlify-node all ship NotoSans Regular only).
//
// ROOT CAUSE ANALYSIS
// ───────────────────
// • wsrv.nl (librsvg) – uses system fonts with real Bold variants → renders
//   "bold" correctly as a heavier glyph. This is the visual reference.
// • spaceify / render-node – install fonts-liberation2 / fonts-noto-core
//   (includes Bold) → also correct, no faux bold needed.
// • edge-node (resvg-wasm), vercel-node, netlify-node – ship only
//   NotoSans-Regular.ttf. Bold weight is silently ignored, text appears thin.
//
// SOLUTION
// ────────
// Add a very light SVG stroke (paint-order: stroke fill) so the fill is drawn
// ON TOP of the stroke. This widens the apparent glyph path without bleeding
// into adjacent characters.
//
// STROKE-WIDTH CALIBRATION
// ────────────────────────
// 0.08em  — old value; makes edge text ~2× heavier than wsrv reference.
// 0.035em — calibrated to match librsvg bold visual weight at typical sizes.
//
// For nodes that DO have real bold fonts, do NOT call applyFauxBold().
// The helper is intentionally split so each entry-point can opt in/out.

const BOLD_RE = /font-weight=["']?(bold|bolder|[6-9]00)["']?/i;
const FILL_RE = /fill=["']([^"']+)["']/i;

/**
 * Apply faux-bold stroke synthesis to every <text> element whose
 * font-weight is bold / bolder / 600-900.
 *
 * Safe to call on SVGs that already contain stroke attributes –
 * those elements are left untouched.
 *
 * @param {string} svgText   Raw SVG markup
 * @param {string} [sw]      CSS stroke-width (default: '0.035em')
 * @returns {string} Modified SVG markup
 */
export function applyFauxBold(svgText, sw = '0.035em') {
  // Match opening <text ...> tag plus everything up to </text>
  // Flags: g = all occurrences, i = case-insensitive, s = dotAll (multiline bodies)
  return svgText.replace(
    /(<text(?:\s[^>]*)?)>([\s\S]*?)<\/text>/gi,
    (match, openTag, body) => {
      if (!BOLD_RE.test(openTag))       return match; // not bold
      if (/stroke=/i.test(openTag))     return match; // already has stroke

      const fillMatch = openTag.match(FILL_RE);
      const strokeColor = fillMatch ? fillMatch[1] : 'currentColor';

      const enhanced =
        `${openTag} stroke="${strokeColor}" stroke-width="${sw}"` +
        ` stroke-linejoin="round" paint-order="stroke fill"`;

      return `${enhanced}>${body}</text>`;
    },
  );
}

/**
 * Convenience: apply faux-bold AND return immediately if the renderer
 * already has real bold fonts (opt-out path).
 *
 * @param {string}  svgText
 * @param {boolean} hasBoldFonts  Pass true for spaceify/render nodes
 * @returns {string}
 */
export function conditionalFauxBold(svgText, hasBoldFonts) {
  return hasBoldFonts ? svgText : applyFauxBold(svgText);
}