import {
  canonicalJobId,
  extractOnlineJobsId,
  normalizeCanonicalUrl,
  normalizeLegacyRecord,
  stateGuard
} from "./contracts.mjs";

const SENIORITY_PATTERN =
  /\b(?:senior|sr\.?|lead|principal|staff|architect|head of|director|tech lead|engineering lead)\b|(?:5|6|7|8|9|10)\+?\s*(?:years?|yrs?)/i;

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
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&([a-z]+|#\d+);/gi, (entity, name) => named[name.toLowerCase()] ?? entity);
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
  if (!value) return "";
  const normalized = value.includes("T") ? value : `${value.trim().replace(" ", "T")}+08:00`;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
}

function evidenceExists(reference, profile) {
  if (reference === "summary") return Boolean(profile.summary);
  if (reference.startsWith("experience:")) {
    const id = reference.slice("experience:".length);
    return profile.experience?.some((experience) => experience.id === id);
  }
  if (reference.startsWith("projects:")) {
    const id = reference.slice("projects:".length);
    return profile.projects?.some((project) => project.id === id);
  }
  const skillMatch = reference.match(/^skills\.([^:]+):(.+)$/);
  if (skillMatch) {
    return profile.skills?.[skillMatch[1]]?.includes(skillMatch[2]) ?? false;
  }
  return false;
}

export function validateSearchPlan(plan, profile) {
  const errors = [];
  if (plan?.schema_version !== 1) errors.push("search plan schema_version must be 1");
  if (!/^\d{4}-\d{2}-\d{2}\/v\d+$/.test(plan?.plan_version || "")) {
    errors.push("search plan plan_version must use YYYY-MM-DD/vN");
  }
  if (plan?.candidate_profile_version !== profile?.profile_version) {
    errors.push("search plan candidate_profile_version must match the candidate profile");
  }
  if (plan?.pagination_mode !== "adaptive_source_exhaustion") {
    errors.push(
      "pagination_mode must be adaptive_source_exhaustion"
    );
  }
  for (const field of [
    "schedule_hours",
    "execution_timeout_seconds",
    "lookback_days",
    "page_size",
    "max_pages_per_query",
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
    Number.isInteger(plan?.schedule_hours) &&
    plan.execution_timeout_seconds >= plan.schedule_hours * 60 * 60
  ) {
    errors.push("execution timeout must be shorter than the discovery schedule");
  }
  if (
    Number.isInteger(plan?.request_timeout_ms) &&
    Number.isInteger(plan?.execution_timeout_seconds) &&
    plan.request_timeout_ms >= plan.execution_timeout_seconds * 1000
  ) {
    errors.push("request timeout must be shorter than the execution timeout");
  }
  if (!Array.isArray(plan?.queries) || plan.queries.length === 0) {
    errors.push("at least one search query is required");
    return errors;
  }

  const ids = new Set();
  const queryTexts = new Set();
  for (const query of plan.queries) {
    if (!query.id || !query.role_family || !query.query) {
      errors.push("every search query requires id, role_family, and query");
      continue;
    }
    if (ids.has(query.id)) errors.push(`duplicate search query id: ${query.id}`);
    ids.add(query.id);
    const normalizedText = query.query.trim().toLowerCase();
    if (queryTexts.has(normalizedText)) errors.push(`duplicate search query text: ${query.query}`);
    queryTexts.add(normalizedText);
    if (!Array.isArray(query.evidence_refs) || query.evidence_refs.length === 0) {
      errors.push(`search query ${query.id} requires evidence_refs`);
    }
    for (const reference of query.evidence_refs ?? []) {
      if (!evidenceExists(reference, profile)) {
        errors.push(`search query ${query.id} has unsupported evidence reference: ${reference}`);
      }
    }
  }
  return errors;
}

export function buildSearchRequests(plan) {
  return plan.queries
    .filter((entry) => entry.enabled)
    .map((query) => searchRequest(query, 1, plan));
}

function searchRequest(query, pageNumber, plan) {
  const offset = (pageNumber - 1) * plan.page_size;
  const path =
    pageNumber === 1
      ? "/jobseekers/jobsearch"
      : `/jobseekers/jobsearch/${offset}`;
  return {
    query_id: query.id,
    query: query.query,
    role_family: query.role_family,
    evidence_refs: query.evidence_refs,
    page_number: pageNumber,
    request_url:
      `https://www.onlinejobs.ph${path}?jobkeyword=` +
      encodeURIComponent(query.query)
  };
}

function sourceResultCardCount(page) {
  if (
    Number.isInteger(page?.result_card_count) &&
    page.result_card_count >= 0
  ) {
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
    page.page_number >= plan.max_pages_per_query
  ) {
    return null;
  }
  return searchRequest(page, page.page_number + 1, plan);
}

export function advanceSearchPagination(state, page, plan) {
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

export function parseSearchResults(
  html,
  request,
  {
    now = new Date().toISOString(),
    lookbackDays = 7
  } = {}
) {
  const jobs = [];
  const excluded = [];
  const malformed = [];
  const pageText = String(html || "");
  const cardRegex =
    /<a\s+href=["'](\/jobseekers\/job\/[^"']+)["'][^>]*>\s*<div[^>]*class=["'][^"']*jobpost-cat-box[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<\/a>/gi;
  const cutoff = Date.parse(now) - lookbackDays * 24 * 60 * 60 * 1000;

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
    if (!titleMatch || !dateMatch) {
      malformed.push({ url_path: urlPath, reason: !titleMatch ? "missing_title" : "missing_posted_at" });
      continue;
    }

    const title = textFromHtml(
      titleMatch[1].replace(/<span[^>]*class=["'][^"']*badge[^"']*["'][^>]*>[\s\S]*?<\/span>/gi, "")
    );
    const postedAt = parsePostedAt(dateMatch[1]);
    if (!title || !postedAt) {
      malformed.push({ url_path: urlPath, reason: !title ? "empty_title" : "invalid_posted_at" });
      continue;
    }
    if (Date.parse(postedAt) < cutoff) continue;

    const salaryMatch = cardHtml.match(/<dd\s+class=["']col["'][^>]*>([\s\S]*?)<\/dd>/i);
    const descriptionMatch = cardHtml.match(/<div[^>]*class=["'][^"']*\bdesc\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    const canonicalUrl = normalizeCanonicalUrl(urlPath);
    const summary = textFromHtml(descriptionMatch?.[1] ?? "");
    const job = {
      source: "onlinejobs.ph",
      source_job_id: extractOnlineJobsId(canonicalUrl),
      canonical_url: canonicalUrl,
      job_title: title,
      company: "",
      salary_text: textFromHtml(salaryMatch?.[1] ?? ""),
      posted_at: postedAt,
      search_summary: summary,
      search_queries: [request.query],
      role_families: [request.role_family],
      source_availability: "active"
    };
    job.canonical_job_id = canonicalJobId(job);
    if (!job.canonical_job_id) {
      malformed.push({ url_path: urlPath, reason: "invalid_identity" });
      continue;
    }
    if (SENIORITY_PATTERN.test(`${title} ${summary} ${canonicalUrl}`)) {
      excluded.push({ ...job, exclusion_reason: "seniority" });
      continue;
    }
    jobs.push(job);
  }

  const hasNext = /<a[^>]+rel=["']next["'][^>]*>/i.test(pageText);
  const pageNumbers = [...pageText.matchAll(/data-ci-pagination-page=["'](\d+)["']/gi)].map((entry) =>
    Number(entry[1])
  );
  const reportedLastPage = pageNumbers.length > 0 ? Math.max(...pageNumbers) : request.page_number;
  return {
    ...request,
    ok: true,
    jobs,
    excluded,
    malformed,
    result_card_count: resultCardCount,
    has_next: hasNext,
    reported_last_page: reportedLastPage
  };
}

function effectivePagesForQuery(pages) {
  const sorted = [...pages].sort((a, b) => a.page_number - b.page_number);
  const effective = [];
  for (const page of sorted) {
    effective.push(page);
    if (sourcePageExhausted(page)) break;
  }
  return effective;
}

export function summarizeCoverage(pageResults, plan) {
  const queries = [];
  for (const query of plan.queries.filter((entry) => entry.enabled)) {
    const pages = effectivePagesForQuery(
      pageResults.filter((result) => result.query_id === query.id)
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
    } else if (lastSuccess?.page_number >= plan.max_pages_per_query) {
      status = "partial";
      stopReason = "page_limit";
    } else if (successes.length > 0) {
      status = "partial";
      stopReason = "incomplete_pages";
    }

    queries.push({
      query_id: query.id,
      query: query.query,
      role_family: query.role_family,
      status,
      stop_reason: stopReason,
      pages_succeeded: successes.length,
      pages_failed: failures.length,
      result_cards_seen: successes.reduce(
        (total, page) => total + sourceResultCardCount(page),
        0
      ),
      jobs_found: successes.reduce((total, page) => total + page.jobs.length, 0),
      malformed_count: successes.reduce((total, page) => total + page.malformed.length, 0),
      excluded_count: successes.reduce((total, page) => total + page.excluded.length, 0)
    });
  }
  return {
    status: queries.some((query) => query.status === "failed" || query.status === "partial")
      ? "partial"
      : queries.every((query) => query.status === "empty")
        ? "empty"
        : "complete",
    pages_requested: queries.reduce(
      (total, query) =>
        total + query.pages_succeeded + query.pages_failed,
      0
    ),
    maximum_page_requests:
      plan.queries.filter((query) => query.enabled).length *
      plan.max_pages_per_query,
    queries
  };
}

function unionValues(...collections) {
  return [...new Set(collections.flat().filter(Boolean))];
}

function cloneDiscoveryJob(job) {
  return {
    ...job,
    search_queries: [...(job.search_queries ?? [])],
    role_families: [...(job.role_families ?? [])]
  };
}

export function reconcileDiscovery(
  pageResults,
  activeRows,
  archiveRows,
  schema,
  now = new Date().toISOString()
) {
  const existing = new Map();
  for (const [location, rows] of [
    ["active", activeRows],
    ["archive", archiveRows]
  ]) {
    for (const raw of rows) {
      const normalized = normalizeLegacyRecord(raw, schema, now);
      if (normalized.canonical_job_id) {
        existing.set(normalized.canonical_job_id, { location, raw, normalized });
      }
      if (normalized.canonical_url) {
        existing.set(`url:${normalized.canonical_url}`, { location, raw, normalized });
      }
    }
  }

  const discovered = new Map();
  let malformedCount = 0;
  let excludedCount = 0;
  for (const page of pageResults.filter((result) => result.ok)) {
    malformedCount += page.malformed.length;
    excludedCount += page.excluded.length;
    for (const job of page.jobs) {
      const current = discovered.get(job.canonical_job_id);
      if (current) {
        current.search_queries = unionValues(current.search_queries, job.search_queries);
        current.role_families = unionValues(current.role_families, job.role_families);
      } else {
        discovered.set(job.canonical_job_id, cloneDiscoveryJob(job));
      }
    }
  }

  const newJobs = [];
  const existingUpdates = [];
  for (const job of discovered.values()) {
    const match =
      existing.get(job.canonical_job_id) ||
      existing.get(`url:${job.canonical_url}`);
    if (match) {
      const updated = {
        ...match.normalized,
        row_number: match.raw.row_number,
        canonical_job_id: job.canonical_job_id,
        source_job_id: job.source_job_id,
        canonical_url: job.canonical_url,
        search_queries: unionValues(match.normalized.search_queries, job.search_queries),
        role_families: unionValues(match.normalized.role_families, job.role_families),
        last_seen_at: now,
        updated_at: now
      };
      updated.state_guard = stateGuard(updated);
      existingUpdates.push({ location: match.location, record: updated });
      continue;
    }
    const record = {
      ...job,
      pipeline_status: "discovered",
      discovered_at: now,
      last_seen_at: now,
      created_at: now,
      updated_at: now,
      attempt_count: 0,
      application_decision: "",
      outcome: "",
      manual_action: ""
    };
    record.state_guard = stateGuard(record);
    newJobs.push(record);
  }

  return {
    new_jobs: newJobs,
    existing_updates: existingUpdates,
    discovered_unique: discovered.size,
    malformed_count: malformedCount,
    excluded_count: excludedCount
  };
}
