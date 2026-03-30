# cronsupabaseabuhg17

This repository syncs Supabase table data into GitHub as JSON on a schedule.

## What it does

- Runs a GitHub Actions workflow every hour
- Discovers tables available to the configured Supabase anon key
- Downloads all rows from each accessible table
- Stores the exported files under `data/*.json`
- Writes a manifest file to `data/_manifest.json`
- Commits and pushes changes back to this repository automatically

## Required GitHub Secrets

Add these repository secrets in GitHub:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

For your current setup:

- `SUPABASE_URL=https://jqkjoqqellhsrhhzlkvr.supabase.co`

Keep the anon key in GitHub Secrets only. Do not commit it into the repository.

## Workflow

The workflow file is:

- `.github/workflows/hourly-sync.yml`

It runs on:

- every hour at minute `0`
- manual trigger from the Actions tab

## Local Run

You can also run the sync locally with Node.js 20+:

```bash
node scripts/sync-supabase-tables.mjs
```
