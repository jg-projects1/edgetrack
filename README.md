# EdgeTrack — Deployment Guide

## Files in this package
- `public/index.html` — the full app
- `public/manifest.json` — PWA manifest (makes it installable)
- `public/sw.js` — service worker (offline support)
- `public/icon-192.png` — app icon
- `public/icon-512.png` — app icon (large)
- `vercel.json` — Vercel routing config

## Deploy to Vercel (5 minutes)

### Option A — Drag and drop (easiest)
1. Go to vercel.com and sign up / log in
2. Click **Add New → Project**
3. Click **"deploy without a Git repository"** or look for the drag-and-drop option
4. Drag the entire `edgetrack` folder onto the page
5. Vercel will detect the config and deploy automatically
6. You'll get a URL like `edgetrack-xxx.vercel.app`

### Option B — Via GitHub (recommended for updates)
1. Create a free account at github.com
2. Create a new repository called `edgetrack`
3. Upload all files maintaining the folder structure:
   - `vercel.json` at root
   - `public/index.html`
   - `public/manifest.json`
   - `public/sw.js`
   - `public/icon-192.png`
   - `public/icon-512.png`
4. Go to vercel.com → Add New → Project → Import from GitHub
5. Select your repo → Deploy
6. Future updates: just push to GitHub and Vercel redeploys automatically

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
All data syncs to your Supabase database automatically.
Every device that opens your app URL will share the same data in real time.
