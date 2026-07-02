'use strict';

/**
 * Full-mirror reverse proxy for WordPress origin (Rebahin / LK21 clone).
 *
 * Replaces the Cloudflare Worker with a portable Node.js server that runs on
 * Railway, Render, Fly.io, a VPS, Docker, or anything that can run Node >= 18.
 *
 * Key features:
 *  - Full transparent mirror of the origin site (HTML, XML, JSON, JS, assets).
 *  - Rewrites EVERY reference to the origin host -> your mirror domain so that
 *    canonical, og:url, JSON-LD, sitemaps, robots.txt and redirects all point
 *    to YOUR domain. This is what fixes Google Search Console:
 *      "Duplicate, Google chose a different canonical", "Page with redirect",
 *      "Not found (404)" and the Breadcrumb / unparsable structured-data errors.
 *  - Removes ad / popunder / tracker scripts (effectiveratecpm, histats, GTM...)
 *    WITHOUT touching the video player iframe (bysetayico.com etc.).
 *  - Optional single-canonical-host enforcement (301) to avoid duplicate
 *    indexing across the Railway/Render subdomain AND your custom domain.
 */

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');

// --------------------------------------------------------------------------
// Configuration (all overridable through environment variables)
// --------------------------------------------------------------------------
const ORIGIN_URL = (process.env.ORIGIN_URL || 'http://168.144.38.21').replace(/\/+$/, '');
const ORIGIN = new URL(ORIGIN_URL);
const ORIGIN_HOST = ORIGIN.host;                 // e.g. "168.144.38.21" (may include :port)
const ORIGIN_HOSTNAME = ORIGIN.hostname;         // e.g. "168.144.38.21"
const ORIGIN_PROTO = ORIGIN.protocol.replace(':', ''); // "http" | "https"
const UPSTREAM = ORIGIN_PROTO === 'https' ? https : http;
const UPSTREAM_PORT = ORIGIN.port || (ORIGIN_PROTO === 'https' ? 443 : 80);

const PORT = parseInt(process.env.PORT || '8080', 10);

// If set, every other host (Railway subdomain, IP, www, ...) is 301-redirected
// here so Google indexes a single canonical domain. Highly recommended for SEO.
const CANONICAL_HOST = (process.env.CANONICAL_HOST || '').trim().toLowerCase();

const FORCE_HTTPS = envBool(process.env.FORCE_HTTPS, false);
const REMOVE_ADS = envBool(process.env.REMOVE_ADS, true);
const KEEP_ANALYTICS = envBool(process.env.KEEP_ANALYTICS, false);

// Ad / tracker / popunder domains to strip from HTML. The video player domain
// is intentionally NOT here, so the player keeps working.
const DEFAULT_AD_DOMAINS = [
  'effectiveratecpm.com',
  'highperformanceformat.com',
  'profitableratecpm.com',
  'histats.com',
  'popads.net',
  'popcash.net',
  'propellerads.com',
  'propu.net',
  'adsterra.com',
  'a.exdynsrv.com',
  'poweredby.jads.co',
  'juicyads.com',
  'exoclick.com',
  'clickadu.com',
  'adnxs.com',
  'onclickalgo.com',
  'pagead2.googlesyndication.com',
  'googlesyndication.com',
];
const ANALYTICS_DOMAINS = ['googletagmanager.com', 'google-analytics.com'];

const AD_DOMAINS = [
  ...DEFAULT_AD_DOMAINS,
  ...(KEEP_ANALYTICS ? [] : ANALYTICS_DOMAINS),
  ...(process.env.EXTRA_AD_DOMAINS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
];

// Never touch these (the actual video player / streaming embeds).
const PLAYER_SAFE_DOMAINS = (process.env.PLAYER_DOMAINS || 'bysetayico.com')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// Content types whose body we rewrite (host replacement / ad stripping).
const TEXT_TYPE_RE = /(text\/html|text\/plain|text\/xml|application\/xml|application\/xhtml|application\/(ld\+)?json|application\/(x-)?javascript|text\/javascript|application\/rss\+xml|application\/atom\+xml|image\/svg\+xml)/i;

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------
function envBool(v, def) {
  if (v === undefined || v === null || v === '') return def;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isPlayerSafe(str) {
  return PLAYER_SAFE_DOMAINS.some((d) => str.includes(d));
}

/**
 * Rewrite every reference to the origin host so it points at the mirror domain.
 * Handles: full URLs (http/https), protocol-relative //host, JSON-escaped
 * (http:\/\/host) and bare host occurrences.
 */
function rewriteHost(body, mirrorBase, mirrorHost) {
  const hostEsc = escapeRe(ORIGIN_HOST);
  const hostnameEsc = escapeRe(ORIGIN_HOSTNAME);
  // mirrorBase is like "https://example.com" (no trailing slash)
  const mirrorBaseEscaped = mirrorBase.replace(/\//g, '\\/'); // for JSON \/ form
  const mirrorBaseUrlEnc = mirrorBase.replace(/:/g, '%3A').replace(/\//g, '%2F'); // for share links

  return body
    // Full absolute URLs, both http and https -> mirror base (forces canonical proto)
    .replace(new RegExp('https?://' + hostEsc, 'gi'), mirrorBase)
    // JSON-LD / escaped-slash URLs:  http:\/\/host  ->  https:\/\/mirror
    .replace(new RegExp('https?:\\\\/\\\\/' + hostEsc, 'gi'), mirrorBaseEscaped)
    // URL-encoded URLs inside share links:  http%3A%2F%2Fhost  ->  https%3A%2F%2Fmirror
    .replace(new RegExp('https?%3A%2F%2F' + hostEsc, 'gi'), mirrorBaseUrlEnc)
    // Protocol-relative //host -> //mirrorHost
    .replace(new RegExp('//' + hostEsc, 'gi'), '//' + mirrorHost)
    // Bare hostname leftovers (meta tags, attributes) -> mirror host
    .replace(new RegExp('(^|[^\\w.])' + hostnameEsc + '(?![\\w.])', 'gi'), '$1' + mirrorHost);
}

/**
 * Remove ad / tracker scripts & blocks from HTML while preserving the player.
 */
function stripAds(html) {
  if (!REMOVE_ADS) return html;

  const hitsAd = (block) =>
    !isPlayerSafe(block) && AD_DOMAINS.some((d) => block.toLowerCase().includes(d));

  return html
    // <script ...>...</script> (external or inline) containing an ad domain
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (m) => (hitsAd(m) ? '' : m))
    // self-closing / src-only scripts already covered above; also drop <ins> ads
    .replace(/<ins\b[^>]*class=["'][^"']*adsbygoogle[^"']*["'][\s\S]*?<\/ins>/gi, '')
    // <noscript>...</noscript> blocks that only exist for trackers/ads
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, (m) => (hitsAd(m) ? '' : m))
    // Stray <iframe> pointing at an ad network (never the player)
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, (m) => (hitsAd(m) ? '' : m))
    // GTM/GA <img> beacons
    .replace(/<img\b[^>]*>/gi, (m) => (hitsAd(m) ? '' : m))
    // <link rel="dns-prefetch|preconnect"> hints to ad domains
    .replace(/<link\b[^>]*>/gi, (m) => (hitsAd(m) ? '' : m))
    // Leftover Histats counter div + its HTML comment (script already removed)
    .replace(/<!--\s*Histats[\s\S]*?-->/gi, '')
    .replace(/<div\s+id=["']histats_counter["'][^>]*>\s*<\/div>/gi, '');
}

/**
 * Rewrite Set-Cookie so cookies bind to the mirror host, not the origin IP.
 */
function rewriteSetCookie(values) {
  if (!values) return values;
  const arr = Array.isArray(values) ? values : [values];
  return arr.map((c) =>
    c
      .replace(new RegExp(';?\\s*Domain=[^;]*', 'gi'), '')
      .replace(new RegExp(escapeRe(ORIGIN_HOSTNAME), 'gi'), '')
  );
}

function decompress(buf, encoding) {
  try {
    if (!encoding) return buf;
    const enc = encoding.toLowerCase();
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf);
    if (enc === 'br') return zlib.brotliDecompressSync(buf);
    if (enc === 'deflate') return zlib.inflateSync(buf);
  } catch (e) {
    // fall through and return the raw buffer
  }
  return buf;
}

// --------------------------------------------------------------------------
// Request handler
// --------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  // Lightweight health check for Railway/Render.
  if (req.url === '/healthz' || req.url === '/_health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }

  // Prefer the public host seen by the browser (x-forwarded-host is set by
  // Codespaces / Railway / Render / any reverse proxy). Fall back to Host.
  const fwdHost = (req.headers['x-forwarded-host'] || '').split(',')[0].trim().toLowerCase();
  const reqHost = fwdHost || (req.headers.host || '').toLowerCase();
  const proto = FORCE_HTTPS
    ? 'https'
    : (req.headers['x-forwarded-proto']
        ? req.headers['x-forwarded-proto'].split(',')[0].trim()
        : (req.socket && req.socket.encrypted ? 'https' : 'http'));

  // Enforce a single canonical host (great for SEO / de-duplication).
  if (CANONICAL_HOST && reqHost && reqHost !== CANONICAL_HOST) {
    res.writeHead(301, {
      Location: `${proto}://${CANONICAL_HOST}${req.url}`,
      'Cache-Control': 'max-age=3600',
    });
    res.end();
    return;
  }

  const mirrorHost = CANONICAL_HOST || reqHost || ORIGIN_HOST;
  const mirrorBase = `${proto}://${mirrorHost}`;

  // Build the upstream headers.
  const headers = { ...req.headers };
  headers.host = ORIGIN_HOST;
  headers['accept-encoding'] = 'identity'; // ask origin for uncompressed body
  headers['x-forwarded-host'] = mirrorHost;
  headers['x-forwarded-proto'] = proto;
  headers['x-forwarded-for'] =
    (req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'] + ', ' : '') +
    (req.socket.remoteAddress || '');
  delete headers['cf-connecting-ip'];
  delete headers['cf-ipcountry'];
  delete headers['cf-ray'];
  delete headers['cf-visitor'];

  const options = {
    protocol: ORIGIN.protocol,
    hostname: ORIGIN_HOSTNAME,
    port: UPSTREAM_PORT,
    method: req.method,
    path: req.url,
    headers,
    timeout: 30000,
  };

  const upstream = UPSTREAM.request(options, (up) => {
    const status = up.statusCode || 502;
    const ct = up.headers['content-type'] || '';
    const isText = TEXT_TYPE_RE.test(ct);

    // Clone & sanitise response headers.
    const outHeaders = { ...up.headers };

    // Rewrite redirect / link headers so they point to the mirror.
    for (const key of ['location', 'content-location', 'link', 'refresh']) {
      if (outHeaders[key]) {
        outHeaders[key] = String(outHeaders[key])
          .replace(new RegExp('https?://' + escapeRe(ORIGIN_HOST), 'gi'), mirrorBase)
          .replace(new RegExp('//' + escapeRe(ORIGIN_HOST), 'gi'), '//' + mirrorHost);
      }
    }
    if (outHeaders['set-cookie']) {
      outHeaders['set-cookie'] = rewriteSetCookie(outHeaders['set-cookie']);
    }

    // Drop hop-by-hop / origin-specific headers.
    delete outHeaders['transfer-encoding'];
    delete outHeaders['content-encoding'];
    delete outHeaders['content-length'];
    delete outHeaders['x-litespeed-cache'];
    delete outHeaders['x-litespeed-cache-control'];
    delete outHeaders['x-litespeed-tag'];
    delete outHeaders.connection;
    delete outHeaders.server;

    if (!isText) {
      // Binary / streaming assets: pass straight through untouched.
      res.writeHead(status, outHeaders);
      up.pipe(res);
      return;
    }

    // Text response: buffer, decompress, rewrite, re-emit.
    const chunks = [];
    up.on('data', (c) => chunks.push(c));
    up.on('end', () => {
      let buf = Buffer.concat(chunks);
      buf = decompress(buf, up.headers['content-encoding']);
      let body = buf.toString('utf8');

      body = rewriteHost(body, mirrorBase, mirrorHost);
      if (/text\/html/i.test(ct)) {
        body = stripAds(body);
      }

      const outBuf = Buffer.from(body, 'utf8');
      outHeaders['content-length'] = Buffer.byteLength(outBuf);
      res.writeHead(status, outHeaders);
      res.end(outBuf);
    });
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('Bad gateway');
    });
  });

  upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
  upstream.on('error', (err) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('Upstream error: ' + err.message);
  });

  // Stream the client request body to the origin (POST/search/etc.).
  req.pipe(upstream);
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(PORT, () => {
  console.log(`[mirror] listening on :${PORT}`);
  console.log(`[mirror] origin        = ${ORIGIN_URL}`);
  console.log(`[mirror] canonicalHost = ${CANONICAL_HOST || '(dynamic from Host header)'}`);
  console.log(`[mirror] forceHttps    = ${FORCE_HTTPS}  removeAds = ${REMOVE_ADS}`);
  console.log(`[mirror] adDomains     = ${AD_DOMAINS.length} entries`);
  console.log(`[mirror] playerSafe    = ${PLAYER_SAFE_DOMAINS.join(', ')}`);
});
