// cloudflare/lib/embedBrand.js
//
// Shared Discord embed branding for the fleet dashboard and alert embeds.
//
// Assets are the frontend repo's public/ files (frontend/public/* → served
// from posterium.xyz via Cloudflare Static Assets), so favicon/logo/icon
// changes in the frontend automatically flow into the embeds here:
//   - assets/icons.js is worker-only (SVG sprite for posters) — not used here
//   - posterium.svg     → brand logo (avoid: Discord's embed proxy prefers
//                         raster images; not all clients render SVG securely)
//   - og-image.png      → 1366×438 banner (too wide for embed thumbnails)
//   - android-chrome-512x512.png → square app icon → avatar + thumbnail

export const BRAND = {
  siteUrl: "https://posterium.xyz",
  appIcon: "https://posterium.xyz/android-chrome-512x512.png",
  ogImage: "https://posterium.xyz/og-image.png",
  logo: "https://posterium.xyz/posterium.svg",
};

// Webhooks only support NON-INTERACTIVE components: link-style buttons
// (style 5). Interactive buttons (styles 1-4) need an interaction endpoint
// webhooks don't have, so everything here is a plain URL button.
export const DASHBOARD_BUTTONS = [
  { label: "Fleet Analytics", url: "https://posterium.xyz/admin/analytics" },
  { label: "Rasterizer Test", url: "https://posterium.xyz/admin/test" },
  { label: "Posterium", url: "https://posterium.xyz" },
];

/**
 * Build a single Action Row of link buttons (max 5 per row).
 * @param {{label: string, url: string}[]} [buttons]
 */
export function actionRowLinkButtons(buttons = DASHBOARD_BUTTONS) {
  return [
    {
      type: 1, // ACTION_ROW
      components: buttons.slice(0, 5).map((b) => ({
        type: 2, // BUTTON
        style: 5, // LINK — no custom_id, no interaction response needed
        label: b.label,
        url: b.url,
      })),
    },
  ];
}