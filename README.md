# JobPipeline

Automated job application pipeline built on n8n. Scrapes OnlineJobs.ph, generates tailored application messages via Groq, and auto-archives processed entries.

## Architecture

Three independent n8n workflows that share a Google Sheets database:

1. **Scraper** — runs every 4 hours, scrapes 14 keyword searches, dedups against existing data, appends new pending rows
2. **Generator** — runs every 15 minutes, processes up to 5 pending rows per run, fetches job descriptions, generates tailored messages via Groq llama-3.3-70b
3. **Archiver** — runs every 45 minutes, moves applied/skipped/error rows from Sheet1 to Archive tab

## Tech Stack

- **Orchestration**: n8n (self-hosted)
- **LLM**: Groq llama-3.3-70b-versatile
- **Database**: Google Sheets (two-tab schema)
- **Source**: OnlineJobs.ph (custom regex-based extraction)
- **Language**: JavaScript (Code nodes)

## Key Design Decisions

- **Regex over HTML parser**: Cheerio is blocked in n8n Code nodes; pure regex with parent-anchor capture guarantees field alignment per card
- **Per-run cap**: Generator processes max 5 jobs per run to manage Groq daily token limit (100k TPD on free tier)
- **Dedup across two sheets**: New scraped jobs are checked against both active Sheet1 AND archived rows before insertion
- **Master prompt with explicit prohibitions**: URL whitelist, project whitelist, banned phrase enforcement, self-check before output — prevents LLM hallucinations of fake projects/URLs/metrics

## Files

- `workflows/scraper.json` — Scraper workflow export
- `workflows/generator.json` — Generator workflow export
- `workflows/archiver.json` — Archiver workflow export
- `docs/architecture.md` — Full system design
- `docs/master-prompt.md` — The AI Agent system message
- `docs/sheet-schema.md` — Google Sheets structure

## Setup

1. Import the three workflow JSONs into your n8n instance
2. Set up credentials: Google Sheets OAuth2, Groq API key
3. Create a Google Sheet with columns: job_title, company, job_url, status, generated_message, created_at, notes
4. Add a second tab "Archive" with the same columns plus archived_at
5. Configure the master prompt in the Generator's AI Agent node with your own resume
6. Publish the workflows

## Notes on Reuse

The master prompt is heavily personalized (my resume, my preferences, banned phrases I find AI-tell). If you want to reuse this, replace the RESUME section and adjust the BANNED LANGUAGE list to your taste.

## What I Learned

- LLM prompts need explicit, auditable constraints to prevent hallucination in production
- API rate limit awareness needs to live in the workflow, not just in error handling
- Dedup logic must consider both active and archived data to prevent re-scraping
- Per-run caps are simpler and more predictable than daily caps

## Status

Active. Currently processing ~5 job applications per day with manual review before sending.