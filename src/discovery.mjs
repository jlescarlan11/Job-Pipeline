import {
  canonicalJobId,
  extractOnlineJobsId,
  normalizeCanonicalUrl,
  normalizeLegacyRecord,
  stateGuard,
  validateUniqueIdentityAcrossStores
} from "./contracts.mjs";
import { validateMinuteIntervalSchedule } from "./schedules.mjs";

const WINDOW_MS = 24 * 60 * 60 * 1000;

function decodeHtml(value = "") {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: "\"",
    "#039": "'",
    "#8211": "–",
    "#8212": "—",
    "#8230": "…"
  };
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, decimal) =>
      String.fromCodePoint(Number.parseInt(decimal, 10))
    )
    .replace(
      /&([a-z]+|#\d+);/gi,
      (entity, name) => named[name.toLowerCase()] ?? entity
    );
}

function textFromHtml(value = "") {
  return decodeHtml(
    String(value)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function parsePostedAt(value) {
  const input = String(value || "").trim();
  if (!input) return "";
  const normalized = input.includes("T")
    ? input
    : `${input.replace(" ", "T")}+08:00`;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
}

export function createDiscoveryWindow(now = new Date().toISOString()) {
  const windowEndMs = Date.parse(now);
  if (!Number.isFinite(windowEndMs)) {
    throw new Error("Discovery window requires a valid execution timestamp");
  }
  return Object.freeze({
    window_start: new Date(windowEndMs - WINDOW_MS).toISOString(),
    window_end: new Date(windowEndMs).toISOString(),
    window_hours: 24
  });
}

export function validateSearchPlan(plan) {
  const errors = [];
  if (plan?.schema_version !== 2) {
    errors.push("search plan schema_version must be 2");
  }
  if (!/^\d{4}-\d{2}-\d{2}\/v\d+$/.test(plan?.plan_version || "")) {
    errors.push("search plan plan_version must use YYYY-MM-DD/vN");
  }
  if (plan?.source !== "onlinejobs.ph") {
    errors.push("search plan source must be onlinejobs.ph");
  }
  if (plan?.window_hours !== 24) {
    errors.push("window_hours must be exactly 24");
  }
  if (plan?.pagination_mode !== "adaptive_source_exhaustion") {
    errors.push("pagination_mode must be adaptive_source_exhaustion");
  }
  for (const field of [
    "schedule_minutes",
    "execution_timeout_seconds",
    "page_size",
    "max_pages_per_keyword",
    "request_interval_ms",
    "request_timeout_ms",
    "claim_lease_ms"
  ]) {
    if (!Number.isInteger(plan?.[field]) || plan[field] < 1) {
      errors.push(`${field} must be a positive integer`);
    }
  }
  if (
    Number.isInteger(plan?.execution_timeout_seconds) &&
    Number.isInteger(plan?.schedule_minutes) &&
    plan.execution_timeout_seconds >= plan.schedule_minutes * 60
  ) {
    errors.push("execution timeout must be shorter than the discovery schedule");
  }
  if (
    Number.isInteger(plan?.request_timeout_ms) &&
    Number.isInteger(plan?.execution_timeout_seconds) &&
    plan.request_timeout_ms >= plan.execution_timeout_seconds * 1000
  ) {
    errors.push("request timeout must be shorter than execution timeout");
  }
  errors.push(...validateMinuteIntervalSchedule(plan, "discovery"));

  if (!Array.isArray(plan?.keywords) || plan.keywords.length === 0) {
    errors.push("at least one keyword is required");
    return errors;
  }
  const ids = new Set();
  const values = new Set();
  for (const entry of plan.keywords) {
    const id = String(entry?.id || "").trim();
    const keyword = String(entry?.keyword || "").trim();
    if (!id || !keyword || typeof entry?.enabled !== "boolean") {
      errors.push("every keyword requires id, keyword, and enabled");
      continue;
    }
    const normalized = keyword.normalize("NFKC").toLocaleLowerCase("en-US");
    if (ids.has(id)) errors.push(`duplicate keyword id: ${id}`);
    if (values.has(normalized)) errors.push(`duplicate keyword: ${keyword}`);
    ids.add(id);
    values.add(normalized);
    if ("evidence_refs" in entry || "role_family" in entry) {
      errors.push(`keyword ${id} must not contain resume or adjacent-role metadata`);
    }
  }
  if (!plan.keywords.some((entry) => entry.enabled)) {
    errors.push("at least one keyword must be enabled");
  }
  return errors;
}

function searchRequest(keyword, pageNumber, plan, window) {
  const offset = (pageNumber - 1) * plan.page_size;
  const path =
    pageNumber === 1
      ? "/jobseekers/jobsearch"
      : `/jobseekers/jobsearch/${offset}`;
  return {
    keyword_id: keyword.id,
    keyword: keyword.keyword,
    page_number: pageNumber,
    request_url:
      `https://www.onlinejobs.ph${path}?jobkeyword=` +
      encodeURIComponent(keyword.keyword),
    window_start: window.window_start,
    window_end: window.window_end
  };
}

export function buildSearchRequests(
  plan,
  window = createDiscoveryWindow()
) {
  return plan.keywords
    .filter((entry) => entry.enabled)
    .map((keyword) => searchRequest(keyword, 1, plan, window));
}

function sourceResultCardCount(page) {
  if (Number.isInteger(page?.result_card_count) && page.result_card_count >= 0) {
    return page.result_card_count;
  }
  return ["jobs", "excluded", "malformed"].reduce(
    (total, field) =>
      total + (Array.isArray(page?.[field]) ? page[field].length : 0),
    0
  );
}

function sourcePageExhausted(page) {
  return Boolean(page?.ok && !page.has_next);
}

export function buildNextSearchRequest(page, plan) {
  if (
    !page?.ok ||
    sourcePageExhausted(page) ||
    !Number.isInteger(page.page_number) ||
    page.page_number < 1 ||
    page.page_number >= plan.max_pages_per_keyword
  ) {
    return null;
  }
  return searchRequest(
    { id: page.keyword_id, keyword: page.keyword },
    page.page_number + 1,
    plan,
    {
      window_start: page.window_start,
      window_end: page.window_end
    }
  );
}

export function advanceSearchPagination(state, page, plan) {
  if (
    state?.window_start &&
    (state.window_start !== page?.window_start ||
      state.window_end !== page?.window_end)
  ) {
    throw new Error("Discovery page changed the immutable execution window");
  }
  const nextRequest = buildNextSearchRequest(page, plan);
  return {
    ...state,
    ...(nextRequest || {}),
    page_results: [
      ...(Array.isArray(state?.page_results) ? state.page_results : []),
      page
    ],
    fetch_next_page: Boolean(nextRequest)
  };
}

export function parseSearchResults(html, request) {
  const jobs = [];
  const excluded = [];
  const malformed = [];
  const windowStartMs = Date.parse(request?.window_start || "");
  const windowEndMs = Date.parse(request?.window_end || "");
  if (
    !Number.isFinite(windowStartMs) ||
    !Number.isFinite(windowEndMs) ||
    windowEndMs - windowStartMs !== WINDOW_MS
  ) {
    throw new Error("Search parsing requires one valid fixed 24-hour window");
  }

  const pageText = String(html || "");
  const cardRegex =
    /<a\s+href=["'](\/jobseekers\/job\/[^"']+)["'][^>]*>\s*<div[^>]*class=["'][^"']*jobpost-cat-box[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<\/a>/gi;
  let resultCardCount = 0;
  let match;
  while ((match = cardRegex.exec(pageText)) !== null) {
    resultCardCount += 1;
    const urlPath = match[1];
    const cardHtml = match[2];
    const titleMatch = cardHtml.match(/<h4[^>]*>([\s\S]*?)<\/h4>/i);
    const dateMatch =
      cardHtml.match(/data-temp=["']([^"']+)["']/i) ||
      cardHtml.match(/<em>\s*Posted on\s+([^<]+)<\/em>/i);
    if (!titleMatch) {
      malformed.push({ url_path: urlPath, reason: "missing_title" });
      continue;
    }
    if (!dateMatch) {
      malformed.push({ url_path: urlPath, reason: "missing_posted_at" });
      continue;
    }

    const title = textFromHtml(
      titleMatch[1].replace(
        /<span[^>]*class=["'][^"']*badge[^"']*["'][^>]*>[\s\S]*?<\/span>/gi,
        ""
      )
    );
    const postedAt = parsePostedAt(dateMatch[1]);
    if (!title) {
      malformed.push({ url_path: urlPath, reason: "empty_title" });
      continue;
    }
    if (!postedAt) {
      malformed.push({ url_path: urlPath, reason: "invalid_posted_at" });
      continue;
    }
    const postedAtMs = Date.parse(postedAt);
    if (postedAtMs < windowStartMs) {
      excluded.push({
        url_path: urlPath,
        posted_at: postedAt,
        reason: "outside_window_old"
      });
      continue;
    }
    if (postedAtMs > windowEndMs) {
      excluded.push({
        url_path: urlPath,
        posted_at: postedAt,
        reason: "future_dated"
      });
      continue;
    }

    const salaryMatch = cardHtml.match(
      /<dd\s+class=["']col["'][^>]*>([\s\S]*?)<\/dd>/i
    );
    const descriptionMatch = cardHtml.match(
      /<div[^>]*class=["'][^"']*\bdesc\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
    );
    const canonicalUrl = normalizeCanonicalUrl(urlPath);
    const job = {
      source: "onlinejobs.ph",
      source_job_id: extractOnlineJobsId(canonicalUrl),
      canonical_url: canonicalUrl,
      job_title: title,
      company: "",
      salary_text: textFromHtml(salaryMatch?.[1] ?? ""),
      search_summary: textFromHtml(descriptionMatch?.[1] ?? ""),
      posted_at: postedAt,
      matched_keywords: [request.keyword],
      source_availability: "active"
    };
    job.canonical_job_id = canonicalJobId(job);
    if (!job.canonical_job_id) {
      malformed.push({ url_path: urlPath, reason: "invalid_identity" });
      continue;
    }
    jobs.push(job);
  }

  const hasNext = /<a[^>]+rel=["']next["'][^>]*>/i.test(pageText);
  const pageNumbers = [
    ...pageText.matchAll(/data-ci-pagination-page=["'](\d+)["']/gi)
  ].map((entry) => Number(entry[1]));
  const reportedLastPage =
    pageNumbers.length > 0 ? Math.max(...pageNumbers) : request.page_number;
  const explicitEmpty =
    /\bno\s+(?:job\s+posts?|jobs?)\s+(?:matched|found|available)\b/i.test(
      textFromHtml(pageText)
    );
  const hasSearchPageEvidence = resultCardCount > 0 || explicitEmpty;
  return {
    ...request,
    ok: hasSearchPageEvidence,
    jobs,
    excluded,
    malformed,
    result_card_count: resultCardCount,
    has_next: hasNext,
    reported_last_page: reportedLastPage,
    ...(hasSearchPageEvidence
      ? {}
      : {
          error_category: "unexpected_search_page",
          error_summary:
            "Search response lacked recognizable result-page evidence."
        })
  };
}

function effectivePagesForKeyword(pages) {
  const sorted = [...pages].sort((left, right) => left.page_number - right.page_number);
  const effective = [];
  for (const page of sorted) {
    effective.push(page);
    if (sourcePageExhausted(page)) break;
  }
  return effective;
}

export function summarizeCoverage(pageResults, plan) {
  const keywords = [];
  for (const keyword of plan.keywords.filter((entry) => entry.enabled)) {
    const pages = effectivePagesForKeyword(
      pageResults.filter((result) => result.keyword_id === keyword.id)
    );
    const successes = pages.filter((page) => page.ok);
    const failures = pages.filter((page) => !page.ok);
    const lastSuccess = successes.at(-1);
    let status = "failed";
    let stopReason = failures.length > 0 ? "request_failure" : "no_page_result";
    if (successes.length > 0 && failures.length > 0) {
      status = "partial";
    } else if (
      successes.length > 0 &&
      sourceResultCardCount(successes[0]) === 0 &&
      sourcePageExhausted(successes[0])
    ) {
      status = "empty";
      stopReason = "no_results";
    } else if (lastSuccess && sourcePageExhausted(lastSuccess)) {
      status = "complete";
      stopReason = "source_exhausted";
    } else if (
      lastSuccess?.page_number >= plan.max_pages_per_keyword
    ) {
      status = "partial";
      stopReason = "page_limit";
    } else if (successes.length > 0) {
      status = "partial";
      stopReason = "incomplete_pages";
    }
    keywords.push({
      keyword_id: keyword.id,
      keyword: keyword.keyword,
      status,
      stop_reason: stopReason,
      pages_succeeded: successes.length,
      pages_failed: failures.length,
      result_cards_seen: successes.reduce(
        (total, page) => total + sourceResultCardCount(page),
        0
      ),
      jobs_found: successes.reduce(
        (total, page) => total + page.jobs.length,
        0
      ),
      malformed_count: successes.reduce(
        (total, page) => total + page.malformed.length,
        0
      ),
      excluded_count: successes.reduce(
        (total, page) => total + page.excluded.length,
        0
      )
    });
  }
  return {
    status: keywords.some(
      (entry) => entry.status === "failed" || entry.status === "partial"
    )
      ? "partial"
      : keywords.every((entry) => entry.status === "empty")
        ? "empty"
        : "complete",
    pages_requested: keywords.reduce(
      (total, entry) => total + entry.pages_succeeded + entry.pages_failed,
      0
    ),
    maximum_page_requests:
      plan.keywords.filter((entry) => entry.enabled).length *
      plan.max_pages_per_keyword,
    keywords
  };
}

function unionValues(...collections) {
  return [
    ...new Set(
      collections
        .flat()
        .filter(Boolean)
        .map((value) => String(value).trim())
    )
  ];
}

function identityKey(value) {
  return String(value || "")
    .trim()
    .normalize("NFKC")
    .toLocaleLowerCase("en-US");
}

export function reconcileDiscovery(
  pageResults,
  reviewRows,
  appliedRows,
  archiveRows,
  schema,
  now = new Date().toISOString()
) {
  const identityErrors = validateUniqueIdentityAcrossStores(
    {
      "Review Queue": reviewRows,
      "Applied Jobs": appliedRows,
      Archive: archiveRows
    },
    schema,
    now
  );
  if (identityErrors.length > 0) {
    throw new Error(`Discovery store identity check failed: ${identityErrors.join("; ")}`);
  }

  const existing = new Map();
  for (const [location, rows] of [
    ["review", reviewRows],
    ["applied", appliedRows],
    ["archive", archiveRows]
  ]) {
    for (const raw of rows) {
      const normalized = normalizeLegacyRecord(raw, schema, now);
      const entry = { location, raw, normalized };
      existing.set(identityKey(normalized.canonical_job_id), entry);
      existing.set(`url:${identityKey(normalized.canonical_url)}`, entry);
    }
  }

  const discovered = new Map();
  let malformedCount = 0;
  const exclusionCounts = {};
  for (const page of pageResults.filter((result) => result.ok)) {
    malformedCount += page.malformed.length;
    for (const excluded of page.excluded) {
      exclusionCounts[excluded.reason] =
        (exclusionCounts[excluded.reason] || 0) + 1;
    }
    for (const job of page.jobs) {
      const key = identityKey(job.canonical_job_id);
      const current = discovered.get(key);
      if (current) {
        current.matched_keywords = unionValues(
          current.matched_keywords,
          job.matched_keywords
        );
      } else {
        discovered.set(key, {
          ...job,
          matched_keywords: [...job.matched_keywords]
        });
      }
    }
  }

  const newJobs = [];
  const reviewUpdates = [];
  let terminalSuppressed = 0;
  for (const job of discovered.values()) {
    const match =
      existing.get(identityKey(job.canonical_job_id)) ||
      existing.get(`url:${identityKey(job.canonical_url)}`);
    if (match?.location === "review") {
      const updated = {
        ...match.normalized,
        row_number: match.raw.row_number,
        source_job_id: job.source_job_id,
        canonical_job_id: job.canonical_job_id,
        canonical_url: job.canonical_url,
        matched_keywords: unionValues(
          match.normalized.matched_keywords,
          job.matched_keywords
        ),
        last_seen_at: now,
        updated_at: now
      };
      reviewUpdates.push(updated);
      continue;
    }
    if (match) {
      terminalSuppressed += 1;
      continue;
    }
    const record = normalizeLegacyRecord(
      {
        ...job,
        pipeline_status: "new",
        user_action: "",
        record_version: 1,
        discovered_at: now,
        last_seen_at: now,
        created_at: now,
        updated_at: now,
        attempt_count: 0,
        alert_attempt_count: 0,
        outcome: ""
      },
      schema,
      now
    );
    record.state_guard = stateGuard(record);
    newJobs.push(record);
  }

  return {
    new_jobs: newJobs,
    review_updates: reviewUpdates,
    discovered_unique: discovered.size,
    terminal_suppressed: terminalSuppressed,
    malformed_count: malformedCount,
    exclusion_counts: exclusionCounts
  };
}
