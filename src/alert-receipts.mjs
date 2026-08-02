import {
  stateGuard,
  validateRecordStoreContract
} from "./contracts.mjs";

export const ALERT_RECEIPT_PERSISTED_FIELDS = [
  "schema_version",
  "receipt_id",
  "idempotency_key",
  "canonical_job_id",
  "status",
  "provider_classification",
  "provider_status",
  "provider_reference",
  "error_category",
  "error_summary",
  "execution_id",
  "attempt_count",
  "receipt_version",
  "created_at",
  "updated_at",
  "attempt_started_at",
  "delivered_at",
  "reconciled_at",
  "next_retry_at",
  "terminal_at"
];

const NUMBER_FIELDS = new Set([
  "schema_version",
  "provider_status",
  "attempt_count",
  "receipt_version"
]);

const TIMESTAMP_FIELDS = [
  "created_at",
  "updated_at",
  "attempt_started_at",
  "delivered_at",
  "reconciled_at",
  "next_retry_at",
  "terminal_at"
];

const REQUIRED_STATUSES = [
  "pending",
  "sending",
  "delivered",
  "reconciled",
  "retryable_rejection",
  "terminal_rejection",
  "terminal_ambiguity"
];

const REQUIRED_PROVIDER_CLASSIFICATIONS = [
  "not_attempted",
  "accepted",
  "retryable_rejection",
  "definite_rejection",
  "ambiguous"
];

const RECEIPT_ERROR_SUMMARIES = {
  provider_retryable: "Provider rejected the delivery attempt temporarily",
  provider_rejected: "Provider rejected the delivery attempt",
  ambiguous_delivery: "Provider delivery outcome is ambiguous"
};

function sanitizeAlertReceiptValue(value, maximum = 240) {
  return String(value || "")
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\bauthorization\s*[:=]\s*(?:bearer\s+)?\S+/gi, "authorization=[redacted]")
    .replace(/\bbearer\s+\S+/gi, "bearer [redacted]")
    .replace(/(?:api[-_ ]?key|token|secret|webhook)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/\b(?:xox[baprs]-[A-Za-z0-9-]+|gh[pousr]_[A-Za-z0-9]+|sk-[A-Za-z0-9_-]{8,})\b/gi, "[credential]")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200d\u2060\ufeff]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

function validAlertReceiptTimestamp(value, maximum) {
  return (
    typeof value === "string" &&
    value.length <= maximum &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function alertReceiptIdentityKey(value) {
  return String(value || "")
    .trim()
    .normalize("NFKC")
    .toLocaleLowerCase("en-US");
}

function sanitizeProviderReference(value, maximum) {
  const candidate = sanitizeAlertReceiptValue(value || "accepted", maximum);
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(candidate)
    ? candidate
    : "accepted";
}

function exactStringSetErrors(values, required, label) {
  if (!Array.isArray(values)) return [`${label} must be an array`];
  const unique = new Set(values);
  if (
    unique.size !== values.length ||
    unique.size !== required.length ||
    required.some((value) => !unique.has(value))
  ) {
    return [`${label} must contain each supported value exactly once`];
  }
  return [];
}

export function validateAlertReceiptPolicy(policy) {
  const errors = [];
  if (policy?.schema_version !== 1) {
    errors.push("alert receipt policy schema_version must be 1");
  }
  if (policy?.store?.kind !== "n8n_data_table") {
    errors.push("alert receipt store must be an n8n Data Table");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,127}$/.test(policy?.store?.table_name || "")) {
    errors.push("alert receipt Data Table name is missing or invalid");
  }
  if (!/^[A-Z][A-Z0-9_]+$/.test(policy?.store?.environment_variable || "")) {
    errors.push("alert receipt Data Table environment variable is invalid");
  }
  errors.push(
    ...exactStringSetErrors(
      policy?.statuses,
      REQUIRED_STATUSES,
      "alert receipt statuses"
    ),
    ...exactStringSetErrors(
      policy?.provider_classifications,
      REQUIRED_PROVIDER_CLASSIFICATIONS,
      "alert receipt provider classifications"
    )
  );
  if (!/^\d{4}-\d{2}-\d{2}\/v\d+$/.test(policy?.policy_version || "")) {
    errors.push("alert receipt policy_version is invalid");
  }
  if (
    !Number.isInteger(policy?.maximum_attempts) ||
    policy.maximum_attempts < 1 ||
    policy.maximum_attempts > 10
  ) {
    errors.push("alert receipt maximum_attempts must be between 1 and 10");
  }
  if (
    Number.isInteger(policy?.bounds?.receipt_id) &&
    Number.isInteger(policy?.bounds?.idempotency_key) &&
    policy.bounds.receipt_id < policy.bounds.idempotency_key
  ) {
    errors.push("receipt_id bound must fit the complete idempotency key");
  }
  if (
    Number.isInteger(policy?.bounds?.timestamp) &&
    policy.bounds.timestamp < 24
  ) {
    errors.push("timestamp bound is too small for an ISO timestamp");
  }
  for (const field of [
    "receipt_id",
    "idempotency_key",
    "canonical_job_id",
    "execution_id",
    "provider_reference",
    "error_category",
    "error_summary",
    "timestamp"
  ]) {
    if (!Number.isInteger(policy?.bounds?.[field]) || policy.bounds[field] < 1) {
      errors.push(`alert receipt bound ${field} must be a positive integer`);
    }
  }
  if (policy?.retention?.prune_delivered_before_reconciliation !== false) {
    errors.push("delivered receipts must not be pruned before reconciliation");
  }
  if (policy?.retention?.backup_required !== true) {
    errors.push("alert receipt store backup must be required");
  }
  return errors;
}

export function validateAlertReceiptCompatibility(policy, alertPolicy) {
  const errors = [];
  if (
    policy?.maximum_attempts !== alertPolicy?.retry?.max_attempts
  ) {
    errors.push("alert receipt and Slack retry caps must match");
  }
  if (
    policy?.store?.environment_variable ===
    alertPolicy?.environment?.provider_webhook_url
  ) {
    errors.push("alert receipt and Slack webhook bindings must be separate");
  }
  return errors;
}

export function alertReceiptId(idempotencyKey, policy) {
  const key = String(idempotencyKey || "").trim();
  const maximum = policy?.bounds?.idempotency_key;
  if (!Number.isInteger(maximum) || !key || key.length > maximum) {
    throw new Error("Alert receipt requires a bounded idempotency key");
  }
  return key;
}

export function normalizeAlertReceipt(input, policy) {
  const receipt = {};
  for (const field of ALERT_RECEIPT_PERSISTED_FIELDS) {
    const value = input?.[field];
    if (NUMBER_FIELDS.has(field)) {
      receipt[field] = value === "" || value === undefined || value === null
        ? 0
        : Number(value);
    } else {
      receipt[field] = String(value ?? "").trim();
    }
  }
  receipt.schema_version = Number(receipt.schema_version || policy?.schema_version || 0);
  return receipt;
}

export function validateAlertReceipt(receipt, policy) {
  const policyErrors = validateAlertReceiptPolicy(policy);
  if (policyErrors.length > 0) return policyErrors;
  const errors = [];
  const bounds = policy.bounds;
  if (receipt?.schema_version !== policy.schema_version) {
    errors.push("receipt schema_version is invalid");
  }
  for (const [field, maximum] of [
    ["receipt_id", bounds.receipt_id],
    ["idempotency_key", bounds.idempotency_key],
    ["canonical_job_id", bounds.canonical_job_id],
    ["execution_id", bounds.execution_id]
  ]) {
    const value = String(receipt?.[field] || "");
    if (
      !value ||
      value.length > maximum ||
      value.normalize("NFKC") !== value ||
      sanitizeAlertReceiptValue(value, maximum) !== value
    ) {
      errors.push(`${field} is missing, oversized, or unsafe`);
    }
  }
  let expectedReceiptId = null;
  try {
    expectedReceiptId = alertReceiptId(receipt?.idempotency_key, policy);
  } catch {
    // The bounded-field validation above owns the detailed identity error.
  }
  if (
    receipt?.receipt_id !== receipt?.idempotency_key ||
    receipt?.receipt_id !== expectedReceiptId
  ) {
    errors.push("receipt identity must equal the alert idempotency key");
  }
  if (!policy.statuses.includes(receipt?.status)) {
    errors.push("receipt status is invalid");
  }
  if (!policy.provider_classifications.includes(receipt?.provider_classification)) {
    errors.push("receipt provider classification is invalid");
  }
  if (
    !Number.isInteger(receipt?.attempt_count) ||
    receipt.attempt_count < 1 ||
    receipt.attempt_count > policy.maximum_attempts
  ) {
    errors.push("receipt attempt_count is invalid");
  }
  if (
    !Number.isSafeInteger(receipt?.receipt_version) ||
    receipt.receipt_version < 1
  ) {
    errors.push("receipt receipt_version is invalid");
  }
  if (
    !Number.isInteger(receipt?.provider_status) ||
    receipt.provider_status < 0 ||
    receipt.provider_status > 599
  ) {
    errors.push("receipt provider_status is invalid");
  }
  for (const field of TIMESTAMP_FIELDS) {
    if (
      receipt?.[field] &&
      !validAlertReceiptTimestamp(receipt[field], bounds.timestamp)
    ) {
      errors.push(`${field} is invalid`);
    }
  }
  if (!receipt?.created_at || !receipt?.updated_at) {
    errors.push("receipt created_at and updated_at are required");
  } else if (Date.parse(receipt.updated_at) < Date.parse(receipt.created_at)) {
    errors.push("receipt updated_at cannot precede created_at");
  }
  const createdMs = Date.parse(receipt?.created_at || "");
  const updatedMs = Date.parse(receipt?.updated_at || "");
  for (const field of [
    "attempt_started_at",
    "delivered_at",
    "reconciled_at",
    "terminal_at"
  ]) {
    const valueMs = Date.parse(receipt?.[field] || "");
    if (
      receipt?.[field] &&
      Number.isFinite(createdMs) &&
      Number.isFinite(updatedMs) &&
      (valueMs < createdMs || valueMs > updatedMs)
    ) {
      errors.push(`${field} must be within the receipt lifetime`);
    }
  }
  if (
    receipt?.delivered_at &&
    receipt?.attempt_started_at &&
    Date.parse(receipt.delivered_at) < Date.parse(receipt.attempt_started_at)
  ) {
    errors.push("receipt delivered_at cannot precede attempt_started_at");
  }
  if (
    receipt?.reconciled_at &&
    receipt?.delivered_at &&
    Date.parse(receipt.reconciled_at) < Date.parse(receipt.delivered_at)
  ) {
    errors.push("receipt reconciled_at cannot precede delivered_at");
  }
  if (
    receipt?.terminal_at &&
    receipt?.attempt_started_at &&
    Date.parse(receipt.terminal_at) < Date.parse(receipt.attempt_started_at)
  ) {
    errors.push("receipt terminal_at cannot precede attempt_started_at");
  }
  if (
    receipt?.next_retry_at &&
    Number.isFinite(updatedMs) &&
    Date.parse(receipt.next_retry_at) <= updatedMs
  ) {
    errors.push("receipt next_retry_at must follow updated_at");
  }
  const reference = String(receipt?.provider_reference || "");
  const category = String(receipt?.error_category || "");
  const summary = String(receipt?.error_summary || "");
  if (
    reference.length > bounds.provider_reference ||
    sanitizeAlertReceiptValue(reference, bounds.provider_reference) !== reference ||
    (reference && !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(reference))
  ) {
    errors.push("receipt provider_reference is oversized or unsafe");
  }
  if (
    category.length > bounds.error_category ||
    sanitizeAlertReceiptValue(category, bounds.error_category) !== category ||
    (category && !Object.hasOwn(RECEIPT_ERROR_SUMMARIES, category))
  ) {
    errors.push("receipt error_category is oversized or unsafe");
  }
  if (
    summary.length > bounds.error_summary ||
    sanitizeAlertReceiptValue(summary, bounds.error_summary) !== summary ||
    (summary && summary !== RECEIPT_ERROR_SUMMARIES[category])
  ) {
    errors.push("receipt error_summary is oversized or unsafe");
  }

  if (["pending", "sending"].includes(receipt?.status)) {
    if (receipt.provider_classification !== "not_attempted") {
      errors.push("unsent receipt cannot contain a provider outcome");
    }
    if (receipt.provider_status || reference || category || summary) {
      errors.push("unsent receipt contains provider result metadata");
    }
  }
  if (receipt?.status === "pending") {
    if (
      receipt?.attempt_started_at ||
      receipt?.delivered_at ||
      receipt?.reconciled_at ||
      receipt?.next_retry_at ||
      receipt?.terminal_at
    ) {
      errors.push("pending receipt cannot contain attempt or outcome timestamps");
    }
  }
  if (receipt?.status === "sending") {
    if (!receipt?.attempt_started_at) {
      errors.push("sending receipt requires attempt_started_at");
    }
    if (
      receipt?.delivered_at ||
      receipt?.reconciled_at ||
      receipt?.next_retry_at ||
      receipt?.terminal_at
    ) {
      errors.push("sending receipt cannot contain provider outcome timestamps");
    }
  }
  if (["delivered", "reconciled"].includes(receipt?.status)) {
    if (
      receipt.provider_classification !== "accepted" ||
      receipt.provider_status < 200 ||
      receipt.provider_status >= 300 ||
      !receipt.attempt_started_at ||
      !receipt.delivered_at ||
      category ||
      summary
    ) {
      errors.push("delivered receipt requires a confirmed bounded provider success");
    }
  }
  if (receipt?.status === "delivered") {
    if (receipt?.reconciled_at || receipt?.next_retry_at || receipt?.terminal_at) {
      errors.push("delivered receipt cannot contain later outcome timestamps");
    }
  }
  if (receipt?.status === "reconciled") {
    if (!receipt?.reconciled_at) {
      errors.push("reconciled receipt requires reconciled_at");
    }
    if (receipt?.next_retry_at || receipt?.terminal_at) {
      errors.push("reconciled receipt cannot contain retry or terminal timestamps");
    }
  }
  if (receipt?.status === "retryable_rejection") {
    if (
      receipt.provider_classification !== "retryable_rejection" ||
      !receipt.attempt_started_at ||
      !receipt.next_retry_at ||
      receipt.attempt_count >= policy.maximum_attempts ||
      !category ||
      receipt.delivered_at ||
      receipt.reconciled_at ||
      receipt.terminal_at
    ) {
      errors.push("retryable receipt outcome is invalid or exceeds its cap");
    }
  }
  if (receipt?.status === "terminal_rejection") {
    if (
      !["retryable_rejection", "definite_rejection"].includes(
        receipt.provider_classification
      ) ||
      !receipt.attempt_started_at ||
      !receipt.terminal_at ||
      !category ||
      receipt.next_retry_at ||
      receipt.delivered_at ||
      receipt.reconciled_at
    ) {
      errors.push("terminal rejection receipt is invalid");
    }
  }
  if (receipt?.status === "terminal_ambiguity") {
    if (
      receipt.provider_classification !== "ambiguous" ||
      !receipt.attempt_started_at ||
      !receipt.terminal_at ||
      !category ||
      receipt.next_retry_at ||
      receipt.delivered_at ||
      receipt.reconciled_at
    ) {
      errors.push("terminal ambiguous receipt is invalid");
    }
  }
  return [...new Set(errors)];
}

function assertValidReceipt(receipt, policy, prefix) {
  const errors = validateAlertReceipt(receipt, policy);
  if (errors.length > 0) {
    throw new Error(`${prefix}: ${errors.join("; ")}`);
  }
}

export function createPendingAlertReceipt(
  {
    idempotencyKey,
    canonicalJobId,
    executionId,
    attemptCount = 1,
    now = new Date().toISOString()
  },
  policy
) {
  const receipt = normalizeAlertReceipt(
    {
      schema_version: policy.schema_version,
      receipt_id: alertReceiptId(idempotencyKey, policy),
      idempotency_key: idempotencyKey,
      canonical_job_id: canonicalJobId,
      status: "pending",
      provider_classification: "not_attempted",
      execution_id: executionId,
      attempt_count: attemptCount,
      receipt_version: 1,
      created_at: now,
      updated_at: now
    },
    policy
  );
  assertValidReceipt(receipt, policy, "Invalid pending alert receipt");
  return receipt;
}

const ALLOWED_TRANSITIONS = new Map([
  ["pending", new Set(["sending"])],
  [
    "sending",
    new Set([
      "delivered",
      "retryable_rejection",
      "terminal_rejection",
      "terminal_ambiguity"
    ])
  ],
  ["retryable_rejection", new Set(["pending"])],
  ["delivered", new Set(["reconciled"])]
]);

export function transitionAlertReceipt(
  currentInput,
  {
    expectedVersion,
    status,
    executionId,
    providerStatus,
    providerClassification,
    providerReference,
    errorCategory,
    nextRetryAt,
    now = new Date().toISOString()
  },
  policy
) {
  const current = normalizeAlertReceipt(currentInput, policy);
  assertValidReceipt(current, policy, "Cannot transition invalid alert receipt");
  if (current.receipt_version !== expectedVersion) {
    throw new Error("Alert receipt transition rejected stale receipt_version");
  }
  if (current.status === status) {
    throw new Error("Alert receipt transition rejected duplicate status");
  }
  if (!ALLOWED_TRANSITIONS.get(current.status)?.has(status)) {
    throw new Error(`Alert receipt transition rejected ${current.status} -> ${status}`);
  }
  if (!validAlertReceiptTimestamp(now, policy.bounds.timestamp)) {
    throw new Error("Alert receipt transition requires a valid timestamp");
  }
  if (Date.parse(now) < Date.parse(current.updated_at)) {
    throw new Error("Alert receipt transition timestamp is stale");
  }
  const receipt = { ...current, status, updated_at: now };
  receipt.receipt_version += 1;

  if (status === "pending") {
    if (current.status !== "retryable_rejection") {
      throw new Error("Only a retryable rejection can start another receipt attempt");
    }
    if (current.attempt_count >= policy.maximum_attempts) {
      throw new Error("Alert receipt retry exceeds maximum_attempts");
    }
    if (current.next_retry_at && Date.parse(now) < Date.parse(current.next_retry_at)) {
      throw new Error("Alert receipt retry is not due");
    }
    receipt.attempt_count += 1;
    const nextExecutionId = String(executionId || "").trim();
    if (
      !nextExecutionId ||
      nextExecutionId.length > policy.bounds.execution_id ||
      sanitizeAlertReceiptValue(nextExecutionId, policy.bounds.execution_id) !==
        nextExecutionId
    ) {
      throw new Error("Alert receipt retry requires a bounded safe execution ID");
    }
    receipt.execution_id = nextExecutionId;
    receipt.provider_classification = "not_attempted";
    receipt.provider_status = 0;
    receipt.provider_reference = "";
    receipt.error_category = "";
    receipt.error_summary = "";
    receipt.attempt_started_at = "";
    receipt.next_retry_at = "";
    receipt.terminal_at = "";
  } else if (status === "sending") {
    receipt.attempt_started_at = now;
  } else if (status === "delivered") {
    receipt.provider_classification = "accepted";
    receipt.provider_status = Number(providerStatus || 0);
    receipt.provider_reference = sanitizeProviderReference(
      providerReference,
      policy.bounds.provider_reference
    );
    receipt.error_category = "";
    receipt.error_summary = "";
    receipt.delivered_at = now;
    receipt.next_retry_at = "";
  } else if (status === "retryable_rejection") {
    if (current.attempt_count >= policy.maximum_attempts) {
      throw new Error("Alert receipt retryable outcome exceeds maximum_attempts");
    }
    receipt.provider_classification = "retryable_rejection";
    receipt.provider_status = Number(providerStatus || 0);
    receipt.provider_reference = "";
    receipt.error_category = sanitizeAlertReceiptValue(
      errorCategory || "provider_retryable",
      policy.bounds.error_category
    );
    receipt.error_summary = RECEIPT_ERROR_SUMMARIES.provider_retryable;
    receipt.next_retry_at = String(nextRetryAt || "");
  } else if (status === "terminal_rejection") {
    if (
      !["retryable_rejection", "definite_rejection"].includes(
        providerClassification
      )
    ) {
      throw new Error("Terminal rejection requires a definite provider classification");
    }
    receipt.provider_classification = providerClassification;
    receipt.provider_status = Number(providerStatus || 0);
    receipt.provider_reference = "";
    receipt.error_category = sanitizeAlertReceiptValue(
      errorCategory || "provider_rejected",
      policy.bounds.error_category
    );
    receipt.error_summary = RECEIPT_ERROR_SUMMARIES[receipt.error_category] ||
      RECEIPT_ERROR_SUMMARIES.provider_rejected;
    receipt.next_retry_at = "";
    receipt.terminal_at = now;
  } else if (status === "terminal_ambiguity") {
    receipt.provider_classification = "ambiguous";
    receipt.provider_status = Number(providerStatus || 0);
    receipt.provider_reference = "";
    receipt.error_category = sanitizeAlertReceiptValue(
      errorCategory || "ambiguous_delivery",
      policy.bounds.error_category
    );
    receipt.error_summary = RECEIPT_ERROR_SUMMARIES.ambiguous_delivery;
    receipt.next_retry_at = "";
    receipt.terminal_at = now;
  } else if (status === "reconciled") {
    receipt.reconciled_at = now;
  }

  assertValidReceipt(receipt, policy, "Invalid alert receipt transition");
  return receipt;
}

export function classifyAlertReceiptProviderResult(result) {
  const rawStatus = Number(
    result?.statusCode ||
      result?.status ||
      result?.error?.statusCode ||
      result?.error?.status ||
      0
  );
  const status = Number.isInteger(rawStatus) && rawStatus >= 0 && rawStatus <= 599
    ? rawStatus
    : 0;
  if ((status >= 200 && status < 300) || (result?.ok === true && status === 0)) {
    return { classification: "accepted", provider_status: status || 200 };
  }
  if (status === 429 || status >= 500) {
    return {
      classification: "retryable_rejection",
      provider_status: status,
      error_category: "provider_retryable",
      error_summary: RECEIPT_ERROR_SUMMARIES.provider_retryable
    };
  }
  if (status >= 300) {
    return {
      classification: "definite_rejection",
      provider_status: status,
      error_category: "provider_rejected",
      error_summary: RECEIPT_ERROR_SUMMARIES.provider_rejected
    };
  }
  return {
    classification: "ambiguous",
    provider_status: status,
    error_category: "ambiguous_delivery",
    error_summary: RECEIPT_ERROR_SUMMARIES.ambiguous_delivery
  };
}

export function applyProviderResultToAlertReceipt(
  current,
  result,
  { expectedVersion, retryAt, now = new Date().toISOString() },
  policy
) {
  const outcome = classifyAlertReceiptProviderResult(result);
  const status = outcome.classification === "accepted"
    ? "delivered"
    : outcome.classification === "ambiguous"
      ? "terminal_ambiguity"
      : outcome.classification === "retryable_rejection" &&
          current.attempt_count < policy.maximum_attempts
        ? "retryable_rejection"
        : "terminal_rejection";
  return transitionAlertReceipt(
    current,
    {
      expectedVersion,
      status,
      providerStatus: outcome.provider_status,
      providerClassification: outcome.classification,
      providerReference: result?.reference || result?.ts || "accepted",
      errorCategory: outcome.error_category,
      nextRetryAt: status === "retryable_rejection" ? retryAt : "",
      now
    },
    policy
  );
}

export function alertReceiptPersistenceRow(receiptInput, policy) {
  const receipt = normalizeAlertReceipt(receiptInput, policy);
  assertValidReceipt(receipt, policy, "Refusing to persist invalid alert receipt");
  return Object.fromEntries(
    ALERT_RECEIPT_PERSISTED_FIELDS.map((field) => [field, receipt[field]])
  );
}

export function alertReceiptDataTableSchema() {
  return ALERT_RECEIPT_PERSISTED_FIELDS.map((field) => ({
    name: field,
    type: NUMBER_FIELDS.has(field) ? "number" : "string"
  }));
}

export function planAlertReceiptBusinessReconciliation(
  receiptInput,
  stores,
  schema,
  policy,
  now = new Date().toISOString()
) {
  const receipt = normalizeAlertReceipt(receiptInput, policy);
  assertValidReceipt(receipt, policy, "Cannot reconcile invalid alert receipt");
  if (receipt.status === "reconciled") {
    return {
      classification: "already_reconciled",
      provider_send: false,
      business_update: null,
      receipt_update: null
    };
  }
  const supported = new Set([
    "delivered",
    "retryable_rejection",
    "terminal_rejection",
    "terminal_ambiguity"
  ]);
  if (!supported.has(receipt.status)) {
    return {
      classification: "provider_outcome_not_available",
      provider_send: false,
      business_update: null,
      receipt_update: null
    };
  }

  const targetStores = ["To Apply", "Applied Jobs", "Archive"];
  const matches = [];
  const expectedIdentity = alertReceiptIdentityKey(receipt.canonical_job_id);
  for (const store of targetStores) {
    if (!Array.isArray(stores?.[store])) {
      throw new Error(`Receipt reconciliation requires ${store} rows`);
    }
    for (const record of stores[store]) {
      if (alertReceiptIdentityKey(record?.canonical_job_id) === expectedIdentity) {
        matches.push({ store, record });
      }
    }
  }
  if (matches.length > 1) {
    throw new Error("Receipt reconciliation rejected ambiguous canonical ownership");
  }
  if (matches.length === 0) {
    return {
      classification: "owner_not_found",
      provider_send: false,
      business_update: null,
      receipt_update: null
    };
  }
  const { store, record } = matches[0];
  const contractErrors = validateRecordStoreContract(record, store, schema);
  if (contractErrors.length > 0) {
    throw new Error(
      `Receipt reconciliation rejected invalid ${store} record: ${contractErrors.join("; ")}`
    );
  }
  if (record.alert_idempotency_key !== receipt.idempotency_key) {
    throw new Error("Receipt reconciliation rejected a stale idempotency key");
  }
  if (record.state_guard !== stateGuard(record)) {
    throw new Error("Receipt reconciliation rejected a stale state guard");
  }

  const desired = receipt.status === "delivered"
    ? {
        alert_status: "sent",
        alert_sent_at: receipt.delivered_at,
        alert_provider_reference: receipt.provider_reference,
        alert_error_category: "",
        alert_error_summary: "",
        alert_next_retry_at: ""
      }
    : receipt.status === "retryable_rejection"
      ? {
          alert_status: "retryable_failure",
          alert_sent_at: "",
          alert_provider_reference: "",
          alert_error_category: receipt.error_category,
          alert_error_summary: receipt.error_summary,
          alert_next_retry_at: receipt.next_retry_at
        }
      : {
          alert_status: "terminal_failure",
          alert_sent_at: "",
          alert_provider_reference: "",
          alert_error_category: receipt.error_category,
          alert_error_summary: receipt.error_summary,
          alert_next_retry_at: ""
        };
  const common = {
    alert_idempotency_key: receipt.idempotency_key,
    alert_claim_token: "",
    alert_attempt_count: receipt.attempt_count,
    alert_last_attempt_at: receipt.attempt_started_at
  };
  const expectedFields = { ...common, ...desired };
  const alreadyPersisted = Object.entries(expectedFields).every(
    ([field, value]) => String(record[field] ?? "") === String(value ?? "")
  );
  let businessUpdate = null;
  if (!alreadyPersisted) {
    businessUpdate = {
      ...record,
      ...expectedFields,
      record_version: Number(record.record_version || 0) + 1,
      updated_at: now
    };
    businessUpdate.state_guard = stateGuard(businessUpdate);
    const updateErrors = validateRecordStoreContract(
      businessUpdate,
      store,
      schema
    );
    if (updateErrors.length > 0) {
      throw new Error(
        `Receipt reconciliation produced an invalid ${store} update: ${updateErrors.join("; ")}`
      );
    }
  }
  return {
    classification: businessUpdate
      ? "reconcile_business_record"
      : receipt.status === "delivered"
        ? "mark_receipt_reconciled"
        : "business_record_already_reconciled",
    provider_send: false,
    owner_store: store,
    business_update: businessUpdate,
    receipt_update:
      receipt.status === "delivered"
        ? transitionAlertReceipt(
            receipt,
            {
              expectedVersion: receipt.receipt_version,
              status: "reconciled",
              now
            },
            policy
          )
        : null
  };
}

export function planDeliveredReceiptReconciliation(
  receiptInput,
  stores,
  schema,
  policy,
  now = new Date().toISOString()
) {
  if (!receiptInput) {
    return {
      classification: "legacy_no_receipt",
      provider_send: false,
      business_update: null,
      receipt_update: null
    };
  }
  const receipt = normalizeAlertReceipt(receiptInput, policy);
  assertValidReceipt(receipt, policy, "Cannot reconcile invalid alert receipt");
  if (receipt.status === "reconciled") {
    return {
      classification: "already_reconciled",
      provider_send: false,
      business_update: null,
      receipt_update: null
    };
  }
  if (receipt.status !== "delivered") {
    return {
      classification: "not_delivered",
      provider_send: false,
      business_update: null,
      receipt_update: null
    };
  }
  return planAlertReceiptBusinessReconciliation(
    receipt,
    stores,
    schema,
    policy,
    now
  );
}
