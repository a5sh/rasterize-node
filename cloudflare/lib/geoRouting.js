// cloudflare/lib/geoRouting.js
//
// CF colo → region mapping and geo+score-ordered T1 node selection.

export const COLO_REGION = (() => {
  const m = {};
  const zones = {
    NA: [
      "IAD",
      "EWR",
      "MIA",
      "ORD",
      "ATL",
      "BOS",
      "LAX",
      "SFO",
      "SEA",
      "DFW",
      "MSP",
      "PHX",
      "DEN",
      "PDX",
      "LAS",
      "SMF",
      "SLC",
      "OAK",
      "SJC",
      "DTW",
      "PHL",
      "CMH",
      "BUF",
      "CLE",
      "MSY",
      "PIT",
      "RDU",
      "STL",
      "OKC",
      "KCI",
      "OMA",
      "TUL",
      "YYZ",
      "YVR",
    ],
    EU: [
      "LHR",
      "CDG",
      "AMS",
      "DUB",
      "FRA",
      "ZRH",
      "ARN",
      "WAW",
      "FCO",
      "MAD",
      "BCN",
      "MUC",
      "DUS",
      "HAM",
      "BRU",
      "GVA",
      "CPH",
      "OSL",
      "HEL",
      "LIS",
      "VIE",
      "PRG",
      "BUD",
      "OTP",
      "SOF",
      "SKP",
      "BEG",
      "RIX",
      "VNO",
      "TLL",
      "MXP",
      "MAN",
      "EDI",
    ],
  };
  for (const [r, colos] of Object.entries(zones))
    for (const c of colos) m[c] = r;
  return m;
})();

/**
 * Returns T1 nodes in geo-preferred + score order.
 * Same-region nodes first, both halves sorted by nodeScore ascending.
 * Failing nodes are pushed to the back within each group.
 *
 * @param {string|null} colo
 * @param {Array} t1Nodes
 * @param {object} health - createHealthState() instance
 */
export function geoOrderNodes(colo, t1Nodes, health) {
  const req = (colo && COLO_REGION[colo.toUpperCase()]) || "NA";
  const same = t1Nodes.filter((n) => n.lbRegion === req);
  const other = t1Nodes.filter((n) => n.lbRegion !== req);
  const byScore = (a, b) => {
    // Hard-failing nodes always go last within their geo group
    const fa = health.isFailing(a.id) ? 1 : 0;
    const fb = health.isFailing(b.id) ? 1 : 0;
    if (fa !== fb) return fa - fb;
    return health.nodeScore(a.id) - health.nodeScore(b.id);
  };
  return [...same.sort(byScore), ...other.sort(byScore)];
}
