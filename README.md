# LayarKaca21 — Full Mirror Proxy

Portable reverse-proxy that fully mirrors a WordPress origin (`http://168.144.38.21`)
and fixes the SEO problems that break Google indexing. Replaces the old
Cloudflare Worker with a plain **Node.js** server you can deploy to **Railway**,
**Render**, **Fly.io**, a **VPS**, or **Docker**. No third-party dependencies.

## Why your mirror kept failing in Search Console

The origin site hardcodes `http://168.144.38.21` into every `canonical`,
`og:url`, JSON-LD (breadcrumb), sitemap and redirect. A plain proxy forwards
those untouched, so Google saw:

| GSC error | Cause | Fixed by |
|-----------|-------|----------|
| Duplicate, Google chose a different canonical | `canonical`/`og:url` pointed to the origin IP | Host rewritten to your domain + `https` forced |
| Page with redirect | Yoast `Location:` headers pointed to the IP | Redirect headers rewritten |
| Not found (404) | Sitemap listed IP URLs | Sitemap host rewritten |
| Breadcrumb structured-data issue | JSON-LD used escaped `http:\/\/IP\/` | Escaped + URL-encoded forms rewritten |
| Structured data cannot be parsed | Ad scripts injected junk near JSON-LD | Ad/tracker scripts removed |

## What it does

- **Full mirror** of HTML, XML, JSON, JS and all assets.
- **Rewrites every origin reference** → your domain: absolute URLs, protocol-relative
  `//host`, JSON-escaped `http:\/\/host`, URL-encoded `http%3A%2F%2Fhost`, bare host,
  plus `Location` / `Link` / `Set-Cookie` headers. Forces `https` canonicals.
- **Single canonical host**: set `CANONICAL_HOST` and every other host (the
  Railway/Render subdomain, the raw IP, `www`) is `301`-redirected to it, so
  Google indexes ONE domain (kills duplicate indexing).
- **Sitemap & robots.txt** are served with your domain automatically — nothing to
  regenerate. `sitemap_index.xml` and all child sitemaps just work.
- **Ad / popunder / tracker removal**: `effectiveratecpm`, `histats`,
  `googletagmanager`, adsbygoogle, propeller/adsterra/exoclick, etc.
- **Video player is protected**: `bysetayico.com` (and anything in
  `PLAYER_DOMAINS`) is never blocked, so playback keeps working.

## Configuration (environment variables)

See [.env.example](.env.example). Most important:

| Var | Default | Notes |
|-----|---------|-------|
| `ORIGIN_URL` | `http://168.144.38.21` | Origin to mirror (no trailing slash) |
| `CANONICAL_HOST` | *(empty)* | **Set this to your real domain** for best SEO |
| `FORCE_HTTPS` | `false` | Auto-detects `https` from `x-forwarded-proto` (set by Railway/Render). Only force `true` if your host serves https but omits that header |
| `REMOVE_ADS` | `true` | Strip ad/tracker scripts |
| `KEEP_ANALYTICS` | `false` | `true` keeps GTM/GA |
| `BRAND_FROM` / `BRAND_TO` | `Rebahin` / `Layarkaca21` | Rebrands the site name in title/og/JSON-LD (whole-word only) |
| `EXTRA_AD_DOMAINS` | *(empty)* | Comma-separated extra domains to block |
| `PLAYER_DOMAINS` | `bysetayico.com` | Never blocked (video player) |
| `PORT` | `8080` | Set automatically by Railway/Render |

## Run locally

```bash
node server.js
# then open http://localhost:8080/
```

## Deploy — Railway

1. Push this repo to GitHub.
2. Railway → **New Project → Deploy from GitHub repo**.
3. Railway auto-detects Node and runs `npm start` (`Procfile` also provided).
4. In **Variables**, set `CANONICAL_HOST` to your custom domain.
5. Add your domain under **Settings → Networking → Custom Domain** and point DNS.

## Deploy — Render

1. Push to GitHub.
2. Render → **New → Blueprint** (uses [render.yaml](render.yaml)), or **New → Web Service**
   with Start Command `node server.js` and Health Check Path `/healthz`.
3. Set `CANONICAL_HOST` in the environment.
4. Add your custom domain in **Settings → Custom Domains**.

## Deploy — VPS (systemd)

```bash
git clone <your-repo> /opt/lk21-mirror && cd /opt/lk21-mirror
# create env
sudo tee /etc/lk21-mirror.env >/dev/null <<'EOF'
ORIGIN_URL=http://168.144.38.21
CANONICAL_HOST=yourdomain.com
PORT=8080
FORCE_HTTPS=true
REMOVE_ADS=true
EOF

sudo tee /etc/systemd/system/lk21-mirror.service >/dev/null <<'EOF'
[Unit]
Description=LK21 Mirror Proxy
After=network.target
[Service]
WorkingDirectory=/opt/lk21-mirror
EnvironmentFile=/etc/lk21-mirror.env
ExecStart=/usr/bin/node server.js
Restart=always
User=www-data
[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload && sudo systemctl enable --now lk21-mirror
```

Then put **Nginx + Let's Encrypt** in front for HTTPS:

```nginx
server {
    server_name yourdomain.com;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

```bash
sudo certbot --nginx -d yourdomain.com
```

## Deploy — Docker

```bash
docker build -t lk21-mirror .
docker run -d -p 8080:8080 \
  -e CANONICAL_HOST=yourdomain.com \
  -e ORIGIN_URL=http://168.144.38.21 \
  lk21-mirror
```

## Post-deploy SEO checklist

1. Add the domain in **Google Search Console** (URL-prefix property on `https://yourdomain.com`).
2. Submit `https://yourdomain.com/sitemap_index.xml`.
3. Use **URL Inspection → Test live URL** on a few movie pages; confirm the
   canonical shows **your** domain and the breadcrumb structured data is valid.
4. Keep `CANONICAL_HOST` set so the Railway/Render subdomain redirects to your
   domain (prevents duplicate indexing).
5. Use **Removals** in GSC if the old IP URLs were ever indexed.