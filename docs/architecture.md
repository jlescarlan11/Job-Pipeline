# Architecture

JobPipeline consists of three independent n8n workflows sharing a Google Sheets database. Each workflow runs on its own schedule and operates independently — if one fails, the others continue.

## Data Flow
OnlineJobs.ph

↓

[Scraper workflow]

↓

Google Sheets: Sheet1 (status=pending)

↓

[Generator workflow]

↓

Google Sheets: Sheet1 (status=ready, with generated_message)

↓

[Manual review — Lester applies or skips]

↓

Google Sheets: Sheet1 (status=applied or skipped)

↓

[Archiver workflow]

↓

Google Sheets: Archive

## Workflow 1: Scraper

**Schedule:** Every 4 hours

**Purpose:** Discover new job postings on OnlineJobs.ph and add them to the active queue.

**Steps:**
1. Schedule trigger fires
2. Edit Fields node defines 14 keyword variants (react developer, n8n developer, ai engineer, etc.)
3. Split Out converts the keyword array into 14 individual items
4. HTTP Request fetches each OnlineJobs.ph search results page (batched at 1 request per 2 seconds)
5. Code node extracts job cards using regex (URL + card content captured together to guarantee field alignment)
6. IF node filters out senior/lead/architect roles via regex
7. Aggregate collapses all scraped jobs into one item
8. Read current Sheet1 rows + Aggregate them
9. Read current Archive rows (with Always Output Data enabled for empty case)
10. Code node dedups scraped URLs against both Sheet1 and Archive
11. Append remaining unique jobs to Sheet1 with status=pending

**Key design decision: regex over HTML parser**

Cheerio is blocked in n8n Code nodes due to module restrictions. The first attempt used n8n's built-in HTML Extract with 4 parallel CSS selectors, which produced misaligned title/URL pairs because OnlineJobs.ph cards have varying DOM structures. The fix: one regex captures the entire <a href=URL>...<div class=jobpost-cat-box>...</div></a> block, then sub-regexes extract title/date/salary from within that single captured card. Each card produces exactly one item with all fields aligned.

## Workflow 2: Generator

**Schedule:** Every 15 minutes

**Purpose:** Generate tailored application messages for pending jobs, capped at 5 per run.

**Steps:**
1. Schedule trigger fires
2. Read all rows from Sheet1
3. Apply Run Cap Code node: filter to pending rows, sort by row_number, slice to first 5
4. Mark as Processing updates those rows to status=processing
5. IF node checks if job_description is empty
6. (True branch) Send directly to AI Agent
7. (False branch) HTTP Request fetches the OnlineJobs.ph job page → HTML Extract pulls #job-description → passes to AI Agent
8. AI Agent uses Groq llama-3.3-70b with master prompt to generate tailored message
9. Update row in sheet with status=ready and generated_message
10. Error branches from HTTP Request, HTML Extract, and AI Agent all route to Mark as Error (sets status=error with short notes string)

**Key design decision: per-run cap over daily cap**

Original design tried to maintain a daily cap by counting ready rows in Sheet1, but this got entangled with archiver timing and review pace. Simpler approach: cap each run to 5 generations. Combined with the 15-minute schedule and Groq's 100k TPD limit on free tier, this naturally produces ~30-40 generations per day before token exhaustion — well within manageable review volume.

## Workflow 3: Archiver

**Schedule:** Every 45 minutes

**Purpose:** Move applied/skipped/error rows out of the active Sheet1 into the Archive tab.

**Steps:**
1. Schedule trigger fires
2. Read all rows from Sheet1
3. Filter Archivable Rows Code node: filter to status in [applied, skipped, error], sort by row_number DESCENDING, add archived_at timestamp
4. Append filtered rows to Archive tab
5. Delete corresponding rows from Sheet1 (using row_number)

**Key design decision: sort DESCENDING before delete**

Google Sheets row indices shift after each delete operation. Deleting row 3 first would cause row 5 to become row 4, breaking subsequent deletes. Sorting DESC means we delete from the bottom up, so earlier row indices remain valid throughout the batch.

## Shared Schema

**Sheet1 columns:** job_title, company, job_url, job_description, status, generated_message, created_at, notes

**Archive columns:** same as Sheet1 plus archived_at

**Status values (data validation dropdown on column E):**
- pending — scraped, awaiting generation
- processing — currently being generated
- ready — generated message ready for review
- applied — Lester sent the application
- skipped — Lester decided not to apply
- error — generation failed (timeout, dead URL, rate limit)

## Rate Limit Strategy

- **OnlineJobs.ph:** HTTP Request batching set to 1 request per 2 seconds during scraping. Per-page fetch in generator uses 30-second timeout with 3 retries at 5-second intervals.
- **Groq API:** Free tier limits are 12,000 TPM and 100,000 TPD on llama-3.3-70b-versatile. Per-run cap of 5 in generator keeps usage predictable.
- **Google Sheets API:** Per-minute read quota historically caused failures when downstream nodes ran once per input item. Mitigated via Aggregate nodes that collapse N items to 1 before Sheets reads.
