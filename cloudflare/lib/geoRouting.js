// cloudflare/lib/geoRouting.js
//
// CF continent / colo → region mapping and geo+score-ordered T1 node selection.
// Uses request.cf.continent directly from Cloudflare, avoiding unlisted COLO bugs.

/**
 * Maps CF continent code to target LB region ('NA' | 'EU').
 *
 * @param {string|null} colo
 * @param {string|null} continent - CF continent code (NA, EU, AS, SA, AF, OC)
 * @returns {'NA'|'EU'}
 */
export function getRegion(colo, continent) {
  if (continent === "EU") return "EU";
  if (continent === "NA") return "NA";
  return "NA"; // default fallback for AS, SA, AF, OC
}

/**
 * Returns T1 nodes in geo-preferred + score order.
 * Same-region nodes first, both halves sorted by nodeScore ascending.
 * Failing nodes are pushed to the back within each group.
 *
 * @param {string|null} colo
 * @param {Array} t1Nodes
 * @param {object} health - createHealthState() instance
 * @param {string|null} continent - optional CF continent header
 */
export function geoOrderNodes(colo, t1Nodes, health, continent = null) {
  const req = getRegion(colo, continent);
  const same = t1Nodes.filter((n) => n.lbRegion === req);
  const other = t1Nodes.filter((n) => n.lbRegion !== req);
  const byScore = (a, b) => {
    const fa = health.isFailing(a.id) ? 1 : 0;
    const fb = health.isFailing(b.id) ? 1 : 0;
    if (fa !== fb) return fa - fb;
    return health.nodeScore(a.id) - health.nodeScore(b.id);
  };
  return [...same.sort(byScore), ...other.sort(byScore)];
}
