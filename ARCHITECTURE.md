# MBWorld / edgetrack — Internal Architecture Reference

Live at `edgetrack-seven.vercel.app`. This document exists because the
system has grown a lot of moving parts over time, and most of the
reasoning behind them lives in chat history rather than the repo. If
that history is ever lost, this file is the fallback.

---

## 1. The pages

| File | Purpose | Theme | Who uses it |
|---|---|---|---|
| `public/index.html` | Main app — Dashboard, Trade (sports betting), Settle, Accounts, Casino tab | Warm/cream | Primary user (JG) |
| `public/casino.html` | Standalone casino-only logger | Dark ("MBWorld") | Operator A (JP) |
| `public/casino accounts.html` | Standalone casino-only logger | Dark ("MBEmpire") | Alternate casino page — **note the space in the filename** |
| `public/import.html` | Bulk import from spreadsheet exports | — | Occasional, manual use |

All three casino-capable pages (`index.html`'s Casino tab, `casino.html`,
`casino accounts.html`) now share the **same session schema and the
same save/load endpoints** — see §3. This wasn't always true;
`casino accounts.html` used an older deposit/wager/bonus-based schema
until it was unified to match the other two.

---

## 2. Profile naming — the rename history

Profiles were originally keyed `me` / `wife` / `bp` / `rq` in Upstash.
They were renamed to `jg` / `hg` / `bp` / `rq` (bp/rq unchanged).

**The old keys (`edgetrack_me`, `edgetrack_wife`) still exist in
Upstash and are permanently frozen** — nothing writes to them anymore,
they're kept only as a pre-rename safety-net snapshot. Any tool that
reads them directly (rather than `edgetrack_jg`/`edgetrack_hg`) will
show stale, months-old data. `diagnose.js` deliberately reads both for
comparison; `backup.js` was fixed to stop reading them (see §6).

`edgetrack_main` and `edgetrack_casino` are **older still** — they
predate the profile-split architecture entirely. Also frozen, kept only
as historical reference.

**"Operator" is a separate concept from "profile".** JG/JP are two
people who can each log casino sessions *within* any of the four
profiles — it's a field on the session record (`operator: 'JG'|'JP'`),
not a fifth profile. A session with no `operator` field defaults to
`'JG'` everywhere in the codebase.

---

## 3. API endpoints

| Endpoint | Handles | Used by |
|---|---|---|
| `load.js` / `save.js` | Full sports + casino, combined | Nothing currently — kept as an untouched fallback |
| `load-sports.js` | Sports only (bank/bookies/transactions), casino field stripped | `index.html`'s main load |
| `save-sports.js` | Sports only — **never touches casino data**, but must carry it forward unchanged on every write (see §5) | `index.html`'s main save |
| `load-casino.js` | Casino sessions only, plus legacy-key reconciliation and bookie-name normalization | `index.html` (lazy-load), `casino.html`, `casino accounts.html` |
| `save-casino.js` | Casino sessions only — independently recomputes bookie balance deltas from session diffing | `index.html`'s `saveCasinoOnly()`, `casino.html`, `casino accounts.html` |
| `backup.js` | Manual/scheduled full export | Fixed in this pass to read live `jg`/`hg` keys (was reading frozen `me`/`wife`) |
| `restore.js` | Manual restore from a JSON export | Not wired to any UI — invoke directly if ever needed |
| `diagnose.js` | Read-only comparison of legacy vs live data, by-operator breakdown, daily breakdown | Manual debugging tool |
| `integrity-check.js` | Read-only one-time sanity sweep — duplicate IDs, unnormalized names, untracked balances, malformed records | Manual, run occasionally |
| `migrate.js` | One-time legacy→split-key migration | Dormant — its "already migrated" guard means it won't do anything on the current live keys |
| `audit.js` | Reads `edgetrack_audit`/`edgetrack_casino_audit` | Nothing currently writes to these keys — likely stale/orphaned |

**Why sports and casino are split:** originally everything went through
one unified `load.js`/`save.js`, which meant every page load and every
save transferred the *entire* dataset — including casino, even for a
page that never touched it. This was the main driver of hitting
Vercel's Fast Origin Transfer cap. Splitting into sports-only and
casino-only endpoints, with casino lazy-loaded only when actually
needed, cut this significantly.

---

## 4. Casino session schema

```js
{
  id: <timestamp, also the unique ID>,
  date: 'DD/MM/YYYY',
  casino: 'Bookie Name',      // canonical name — see §7 for normalization
  operator: 'JG' | 'JP',      // defaults to JG if absent
  startBal: <number>,
  endBal: <number>,
  netProfit: <number>,        // = endBal - startBal, stored redundantly
  notes: '',
  _acct: 'jg'|'hg'|'bp'|'rq', // added at read time, not stored
  csUpdatedAt: <timestamp>,   // for merge conflict resolution
}
```

P&L is computed as `endBal - startBal` when both are present and
non-zero; otherwise falls back to `netProfit` (this fallback exists for
old sessions logged under the now-retired offer-based schema —
`wager`/`deposit`/`bonusWin`/`offerType`/`pending` — which
`casino accounts.html` used until it was unified). `netProfit` is
always populated regardless of schema, so the fallback is safe.

---

## 5. Merge safety — timestamps and tombstones

Every save is a **merge**, not a wholesale overwrite — server and
incoming data are unioned by ID. Two mechanisms make this safe:

- **`*UpdatedAt` timestamps** (`bankUpdatedAt`, `balUpdatedAt`,
  `txUpdatedAt`, `csUpdatedAt`) — when the same ID exists on both sides
  with conflicting values, the newer timestamp wins. Without this, a
  stale device saving its old cached copy could silently overwrite a
  fresher edit made elsewhere.
- **Persistent deletion tombstones** (`_deletedTxIds`,
  `_deletedCasinoIds`) — a deletion sent in one save request is
  remembered **permanently** on the server profile object, not just
  honoured for that single request. Without this, a device that never
  learned about a deletion could resurrect the deleted item just by
  saving its own stale local copy later.

**`save-sports.js` has no casino data of its own to merge — it must
explicitly carry forward whatever's already in Upstash for `casino` and
`_deletedCasinoIds`, unchanged, on every write.** This is the single
most important invariant in the split-endpoint design: getting it wrong
means a routine bet settlement silently wipes someone's entire casino
history. Verified working via `integrity-check.js` (zero duplicate or
missing sessions after extensive real-world testing).

---

## 6. Known quirks and historical gotchas

- **`backup.js` was reading frozen `me`/`wife` keys** until fixed in
  this pass — any backup taken before that fix is missing/stale for
  the JG and HG profiles specifically. Current version reads live
  `jg`/`hg` keys and also captures `bankUpdatedAt` +both tombstone
  arrays for a genuinely complete export.
- **File uploads to GitHub have silently truncated mid-file more than
  once** during this project (`casino.html` in particular, cut off
  mid-function). A truncated `<script>` block fails silently in the
  browser — the page just hangs forever on the static "Loading…"
  placeholder, since a JS syntax error anywhere stops the whole script
  from running, including the `init()` call at the bottom. **Always
  verify a deploy with `view-source:` on the live URL and confirm it
  ends with `init();</script></body></html>`** before assuming a fix
  didn't work.
- **Browsers sometimes suspend/resume a page instead of truly
  reloading it** on "close and reopen" — meaning cached JS state
  (like a lazy-loaded flag) can persist even when it looks like a
  fresh start. `index.html` handles this via a `pageshow` listener
  checking `event.persisted`, plus a 2-minute staleness window on
  casino data that refreshes silently in the background.
- **RAG verification dots** were redesigned from a manual "verify
  every 7 days" tap (pure admin, no real signal — every dot went red
  regardless of actual balance correctness if you fell behind) to an
  automatic freshness signal based on `balUpdatedAt`. A bookie with a
  **£0 balance never shows a dot at all** — there's nothing to protect.
  Non-zero: green ≤14 days, amber 15-30, red 30+ or never tracked.
- **Vercel's Fast Origin Transfer is a separate, much smaller
  allowance** (10GB/month on Hobby) from regular page bandwidth
  (100GB). It specifically covers dynamic API responses, not static
  assets — which is why splitting the heavy JSON endpoints (not the
  static HTML) was the actual fix for the usage warning.
- **Downgrading Vercel plans mid-billing-cycle is risky** if usage that
  period already exceeds the lower tier's cap — the usage counter
  doesn't reset on downgrade, so it can trigger an immediate pause.
  Only downgrade at the start of a fresh cycle, once the lower rate is
  confirmed sustainable.

---

## 7. Bookie name normalization

A running list of known duplicate/stale bookie names that get merged
into a canonical form, applied both to bookie balance keys and to the
`casino` field on individual session records:

```js
{
  'hot streak casino': 'Hot Streak',
  'gala': 'Gala Casino',
  'bet st george': 'BetStGeorge',
  'betstgeorge': 'BetStGeorge',
  'grosvenor casinos': 'Grosvenor',
  'planet sports': 'Planet Sport Bet',
}
```

This dict is duplicated across `index.html`, `save.js`,
`save-sports.js`, `load-sports.js`, `load-casino.js`, and
`save-casino.js` — **if a new duplicate bookie name turns up, it needs
adding in all of these**, not just one. `integrity-check.js` will flag
any name that should have been caught but wasn't.

---

## 8. Security note

**No endpoint currently requires authentication.** The PIN in
`index.html` (`checkPin()`) is client-side only — it gates the app's
UI, not the API. Anyone who knows or guesses the URL can hit
`/api/load`, `/api/save`, `/api/diagnose`, etc. directly with no login.
This is a real, live gap and should be the priority fix whenever
security work is picked up — not addressed as of this document.

---

## 9. Maintenance checklist

Before assuming a deploy worked:
1. `view-source:` the live URL, confirm it ends properly (see §6)
2. Hard refresh / private tab to rule out browser caching
3. For a homescreen-installed page specifically: remove and re-add the
   icon rather than just closing and reopening, if a fresh reload alone
   doesn't seem to pick up the change

Periodic health checks (no fixed schedule — run when something feels
off, or occasionally as a check-in):
- `/api/diagnose` — compares legacy vs live data, by-operator and daily
  breakdowns
- `/api/integrity-check` — duplicate IDs, unnormalized names, untracked
  balances, malformed records

Still outstanding (not yet built, as of this document):
- API authentication (see §8)
- Automated scheduled backups (Vercel Cron), and deciding where the
  backup actually lands (Upstash / email / GitHub)
- A rolling "recent performance" view for sports betting, matching what
  exists for casino (My Progress, rolling 14-day bookie breakdown)
- Incremental sync (only transmit what changed) as the long-term
  successor to the current full-dataset-per-save-and-load model, if
  data volume ever grows enough to matter again
