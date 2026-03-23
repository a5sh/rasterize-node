// index.js  (repo root)
//
// Entry point for Pterodactyl / generic-container deployments where the startup
// command is fixed as:
//   node /home/container/index.js
//
// Clone the full repo into /home/container/ and this file will delegate to
// the generic node server in ./node/index.js.
//
// Expected layout at /home/container/:
//   index.js          ← this file
//   package.json      ← root package.json (installs @resvg/resvg-js)
//   node/
//     index.js        ← actual server
//     discord.js
//   core/
//     logic.js

import './node/index.js';