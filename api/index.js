'use strict';
// Vercel serverless entry: all API + public link-page routes are rewritten here (vercel.json).
// Static UI (/, /app.js, /styles.css) is served by Vercel from public/ directly.
module.exports = require('../app/server').handler;
