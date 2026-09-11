# EdgeTrack — Deployment Guide

## Files in this package
- `public/index.html` — the full app
- `public/casino.html`, `public/casino accounts.html` — standalone casino-only pages
- `public/import.html` — bulk spreadsheet import tool
- `public/manifest.json` — PWA manifest (makes it installable)
- `public/sw.js` — service worker (offline support)
- `public/icon-192.png` — app icon
- `public/icon-512.png` — app icon (large)
- `api/` — **the actual backend.** Every save, load, backup, and
  diagnostic tool lives here as a Vercel serverless function. The app
  won't work at all without these deployed alongside `public/` — see
  [ARCHITECTURE.md](./ARCHITECTURE.md) for what each one does.
- `vercel.json` — Vercel routing config

## Deploy to Vercel (10 minutes)

### Step 1 — Set up the database

This app stores all its data in **Upstash** (a hosted Redis-compatible
key-value store) — every file in `api/` reads and writes through it.
Nothing in this app uses Supabase, despite what an earlier version of
this guide said.

1. Go to [upstash.com](https://upstash.com) and create a free account
2. Create a new Redis database (any region close to you is fine)
3. From the database's dashboard, find the **REST API** section and
   copy two values: the **URL** and the **Token**

### Step 2 — Deploy the code

**Option A — Drag and drop (easiest)**
1. Go to vercel.com and sign up / log in
2. Click **Add New → Project**
3. Click **"deploy without a Git repository"** or look for the
   drag-and-drop option
4. Drag the entire `edgetrack` folder onto the page (must include both
   `public/` and `api/`)
5. Vercel will detect the config and deploy automatically
6. You'll get a URL like `edgetrack-xxx.vercel.app`

**Option B — Via GitHub (recommended for updates)**
1. Create a free account at github.com
2. Create a new repository called `edgetrack`
3. Upload all files maintaining the folder structure — `vercel.json`
   at root, everything else under `public/` and `api/` as listed above
4. Go to vercel.com → Add New → Project → Import from GitHub
5. Select your repo → Deploy
6. Future updates: just push to GitHub and Vercel redeploys
   automatically — **but see the note on partial uploads below**

### Step 3 — Connect the database to your deployment

Deploying the code alone isn't enough — Vercel needs the Upstash
credentials from Step 1, or every API call will fail silently.

1. In your Vercel project, go to **Settings → Environment Variables**
2. Add two variables:
   - `KV_REST_API_URL` — the URL you copied from Upstash
   - `KV_REST_API_TOKEN` — the token you copied from Upstash
3. Redeploy (Vercel → Deployments → ⋯ → Redeploy) so the new
   environment variables actually take effect

**A note on uploads:** file uploads to GitHub have occasionally been
truncated mid-file in the past, which causes the page to hang forever
on the loading screen with no visible error. After any deploy, it's
worth doing `view-source:` on the live URL and confirming the file
actually ends properly (for `index.html`, `casino.html`, etc., it
should end with `init();</script></body></html>`) before assuming
something else is wrong.

## Add to home screen (after deploying)

### iPhone (Safari)
1. Open your Vercel URL in Safari
2. Tap the Share button (box with arrow)
3. Scroll down and tap **Add to Home Screen**
4. Tap Add — EdgeTrack now appears as an app icon

### Android (Chrome)
1. Open your Vercel URL in Chrome
2. Tap the three-dot menu
3. Tap **Add to Home screen**
4. Tap Add

## Your data

All data is stored in your own **Upstash** database (set up in Step 1)
and synced through the serverless functions in `api/`. Every device
that opens your app URL reads and writes to that same database, so
changes made on one device appear on others.

For a deeper look at exactly how data flows between pages, why certain
things are split the way they are, and known quirks worth knowing
about, see [ARCHITECTURE.md](./ARCHITECTURE.md).
