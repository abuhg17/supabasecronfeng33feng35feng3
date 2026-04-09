# cronsupabaseabuhg17

This repository syncs Supabase table data into GitHub as JSON on a schedule.

## What it does

- Runs a GitHub Actions workflow every hour
- Supports manual trigger and external trigger as a backup
- Discovers all tables automatically when a service role key is available
- Falls back to a configured table list when only an anon key is available
- Downloads all rows from each accessible table
- Stores the exported files under `data/*.json`
- Writes a manifest file to `data/_manifest.json`
- Commits and pushes changes back to this repository automatically

## Required GitHub Secrets

Add these repository secrets in GitHub:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` for automatic export of all tables
- `SUPABASE_ANON_KEY` if you only want to fetch tables allowed by anon policies
- `SUPABASE_TABLES` with a comma-separated list such as `posts,users,orders` when using only anon key

For your current setup:

- `SUPABASE_URL=https://jqkjoqqellhsrhhzlkvr.supabase.co`

Keep the anon key in GitHub Secrets only. Do not commit it into the repository.
Keep the service role key in GitHub Secrets only. Never commit it into the repository.

## Workflow

The workflow file is:

- `.github/workflows/hourly-sync.yml`

It runs on:

- every hour at minute `22`
- manual trigger from the Actions tab
- external trigger through `repository_dispatch`

## External Trigger Backup

Keep the GitHub schedule enabled, and add an external cron service as a backup.

Recommended approach:

- use `cron-job.org` or another external scheduler
- call the GitHub `repository_dispatch` API once per hour at minute `22` or a few minutes later
- use a GitHub personal access token with access to this repository

Example request:

```bash
curl -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer YOUR_GITHUB_TOKEN" \
  https://api.github.com/repos/abuhg17/cronsupabaseabuhg17/dispatches \
  -d "{\"event_type\":\"external-sync\"}"
```

Suggested external schedule:

- minute `27` of every hour as a backup for the built-in GitHub schedule at minute `22`

## Local Run

You can also run the sync locally with Node.js 20+:

```bash
node scripts/sync-supabase-tables.mjs
```

## Which Secret Setup To Use

If you want all tables automatically:

- add `SUPABASE_SERVICE_ROLE_KEY`

If you do not want to use service role:

- keep `SUPABASE_ANON_KEY`
- add `SUPABASE_TABLES`
