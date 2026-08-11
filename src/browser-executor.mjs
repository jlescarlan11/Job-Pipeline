import { createHash } from "node:crypto";
import {
  constants as FS_CONSTANTS,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  buildApplicationPack,
  cleanGeneratedMessage,
  evaluateJob,
  validateApplicationPack,
  validateGeneratedMessage
} from "./evaluation.mjs";
import {
  browserJobDigest as contractBrowserJobDigest,
  browserSubmitAuthorizationDigest,
  extractOnlineJobsId,
  normalizeCanonicalUrl,
  normalizeLegacyRecord,
  stateGuard,
  stateGuardMatches,
  submissionIdempotencyKey as contractSubmissionIdempotencyKey,
  validateRecordStoreContract,
  validateUniqueIdentityAcrossStores
} from "./contracts.mjs";
import {
  createSystemClaim,
  selectWinningSystemClaims
} from "./system-claims.mjs";
import {
  BROWSER_EXECUTOR_PROTOCOL_VERSION,
  browserConfirmationWitness,
  browserConfirmationWitnessDigest,
  verifyBrowserConfirmationAttestation
} from "./browser-confirmation-attestation.mjs";

export { BROWSER_EXECUTOR_PROTOCOL_VERSION };
export const BROWSER_AUTOMATION_CONTRACT_VERSION = "browser-contract-v1";
export const AUTONOMOUS_SOURCE_STORE = "Scraped Jobs";

const DUE_STATES = new Set(["queued", "retryable"]);
const ACTIVE_PRE_SUBMIT_STATES = new Set([
  "claimed",
  "evaluating",
  "generating",
  "filling"
]);
const RESULT_COMMIT_STATES = new Set(["evaluating", "generating", "filling"]);
const RECONCILIATION_STATES = new Set(["submit_started", "ambiguous"]);
const MAXIMUM_FORM_FIELDS = 64;
const MAXIMUM_FORM_INVENTORY_BYTES = 32768;
const MAXIMUM_CLICK_LEDGER_BYTES = 16777216;
const CLICK_STORE_MANIFEST_FILE = "manifest.json";
const CLICK_STORE_LEDGER_FILE = "consumed.ndjson";
const CLICK_STORE_LOCK_FILE = ".consume.lock";
const CLICK_STORE_COUNT_WIDTH = 16;
const APPLY_POINTS_BY_RECOMMENDATION = Object.freeze({
  low_allocation: 1,
  normal_allocation: 5,
  high_allocation: 10
});
const SAFE_RESULT_CATEGORIES = new Set([
  "missing_candidate_fact",
  "login_required",
  "challenge",
  "captcha",
  "unexpected_agreement",
  "unsafe_upload",
  "unsupported_external_step",
  "invalid_form",
  "policy_mismatch",
  "unsafe_page_content",
  "posting_unavailable",
  "navigation_failed",
  "transient_browser_failure",
  "submission_uncertain",
  "submission_rejected",
  "confirmation_mismatch",
  "submission_confirmed"
]);
const CONFIRMATION_KINDS = new Set([
  "confirmation_page",
  "application_history"
]);
const SAFE_EVIDENCE_SUMMARIES = Object.freeze(
  Object.fromEntries(
    [...SAFE_RESULT_CATEGORIES].map((category) => [
      category,
      `Browser result: ${category.replaceAll("_", " ")}`
    ])
  )
);
const RESULT_CATEGORIES = Object.freeze({
  retryable: new Set(["navigation_failed", "transient_browser_failure"]),
  blocked: new Set([
    "missing_candidate_fact",
    "login_required",
    "challenge",
    "captcha",
    "unexpected_agreement",
    "unsafe_upload",
    "unsupported_external_step",
    "invalid_form",
    "policy_mismatch",
    "unsafe_page_content",
    "submission_rejected",
    "confirmation_mismatch"
  ]),
  unavailable: new Set(["posting_unavailable"]),
  ambiguous: new Set(["submission_uncertain"]),
  confirmed: new Set(["submission_confirmed"])
});
const CONTEXT_JOB_FIELDS = [
  "source",
  "source_job_id",
  "canonical_job_id",
  "canonical_url",
  "job_title",
  "company",
  "job_description",
  "salary_text",
  "posted_at",
  "source_availability",
  "role_families",
  "matched_keywords"
];
const CLAIM_CONFIRM_FIELDS = [
  "canonical_job_id",
  "record_version",
  "execution_mode",
  "automation_contract_version",
  "browser_state",
  "browser_attempt_id",
  "browser_job_digest",
  "browser_context_digest",
  "processing_stage",
  "processing_token",
  "processing_started_at",
  "state_guard",
  "user_action",
  "notes"
];
const LIVE_JOB_CONTEXT_CONFIRM_FIELDS = [
  "canonical_job_id",
  "record_version",
  "canonical_url",
  "job_title",
  "company",
  "job_description",
  "salary_text",
  "browser_state",
  "browser_attempt_id",
  "browser_job_digest",
  "browser_context_digest",
  "processing_stage",
  "processing_token",
  "processing_started_at",
  "state_guard",
  "user_action",
  "notes"
];
const SUBMIT_INTENT_CONFIRM_FIELDS = [
  "canonical_job_id",
  "record_version",
  "browser_state",
  "browser_attempt_id",
  "browser_job_digest",
  "browser_context_digest",
  "browser_form_fingerprint",
  "submission_idempotency_key",
  "submission_started_at",
  "message_profile_version",
  "message_policy_version",
  "application_pack_version",
  "application_pack_policy_version",
  "processing_stage",
  "processing_token",
  "processing_started_at",
  "state_guard"
];
const SYSTEM_CLAIM_CONFIRM_FIELDS = [
  "claim_key",
  "canonical_job_id",
  "stage",
  "token",
  "created_at",
  "expires_at"
];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])])
    );
  }
  return value ?? "";
}

function digest(value) {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

function parseFormUrl(value, base) {
  let parsed;
  try {
    parsed = base === undefined
      ? new URL(String(value))
      : new URL(String(value), base);
  } catch {
    throw new Error("Form URLs must be valid and credential-free");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Form URLs must be valid and credential-free");
  }
  return parsed;
}

function sha256Text(value) {
  return `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;
}

function requireClickStoreId(value, kind) {
  const expected = new RegExp(`^browser-click-${kind}-v1:[a-f0-9]{64}$`);
  if (!expected.test(String(value || ""))) {
    throw new Error("Submit click receipt store identity is not provisioned");
  }
  return String(value);
}

function requireClickGenerationId(value) {
  if (!/^browser-click-generation-v1:[a-f0-9]{64}$/.test(String(value || ""))) {
    throw new Error("Submit click receipt store generation is not provisioned");
  }
  return String(value);
}

function clickFsIdentity(metadata) {
  return `fs-object-v1:${metadata.dev}:${metadata.ino}:${metadata.uid}`;
}

function requireClickFsIdentity(value) {
  if (!/^fs-object-v1:[0-9]+:[0-9]+:[0-9]+$/.test(String(value || ""))) {
    throw new Error("Submit click receipt filesystem identity is not provisioned");
  }
  return String(value);
}

function requirePrivateClickObject(metadata, kind, expectedIdentity) {
  const currentUid = typeof process.getuid === "function"
    ? String(process.getuid())
    : "";
  const expectedMode = kind === "directory" ? 0o700n : 0o600n;
  const mode = metadata.mode & 0o777n;
  const typeMatches = kind === "directory"
    ? metadata.isDirectory()
    : metadata.isFile();
  if (
    !currentUid ||
    !typeMatches ||
    metadata.isSymbolicLink() ||
    String(metadata.uid) !== currentUid ||
    mode !== expectedMode ||
    (expectedIdentity && clickFsIdentity(metadata) !== expectedIdentity)
  ) {
    throw new Error("invalid private click receipt object");
  }
  return clickFsIdentity(metadata);
}

function clickStoreBindingDigest({
  directory,
  directoryIdentity,
  witnessPath,
  witnessIdentity,
  generationId
}) {
  return sha256Text([
    directory,
    directoryIdentity,
    witnessPath,
    witnessIdentity,
    generationId
  ].join("\n"));
}

function clickLedgerCount(value) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0 || count >= 10 ** CLICK_STORE_COUNT_WIDTH) {
    throw new Error("click receipt ledger count is invalid");
  }
  return String(count).padStart(CLICK_STORE_COUNT_WIDTH, "0");
}

function clickLedgerHead(value) {
  return sha256Text(JSON.stringify(stableValue(value)));
}

function requiredApplyPoints(record) {
  const value = APPLY_POINTS_BY_RECOMMENDATION[
    record?.apply_points_recommendation
  ];
  if (!Number.isInteger(value)) {
    throw new Error("Application is not authorized to spend Apply Points");
  }
  return value;
}

function truthfulApplyByDefault(applicationPolicy) {
  return (
    applicationPolicy?.selection_mode === "truthful_apply_by_default" &&
    applicationPolicy?.apply_points?.save_points_behavior ===
      "use_low_allocation"
  );
}

function autonomousEvaluation(
  job,
  profile,
  rankingPolicy,
  applicationPolicy,
  now
) {
  const evaluation = evaluateJob(job, profile, rankingPolicy, now);
  if (
    truthfulApplyByDefault(applicationPolicy) &&
    !["unavailable", "unscorable"].includes(evaluation.match_decision) &&
    evaluation.apply_points_recommendation === "save_points"
  ) {
    return {
      ...evaluation,
      apply_points_recommendation: "low_allocation"
    };
  }
  return evaluation;
}

function autonomousResolutionKey(evaluation) {
  if (evaluation.match_decision === "unavailable") return "unavailable";
  if (evaluation.match_decision === "unscorable") {
    return "missing_required_candidate_fact";
  }
  if (
    (evaluation.requirement_gap_details ?? []).some(
      (gap) => gap.classification === "hard"
    )
  ) {
    return "deterministically_unsupported";
  }
  if (evaluation.match_decision === "recommended") {
    return "ready_and_answerable";
  }
  return "low_fit";
}

function independentClickWitness(directory, witnessPath) {
  const witnessRelative = relative(directory, witnessPath);
  return witnessRelative === ".." || witnessRelative.startsWith(`..${sep}`);
}

function writeAllSync(descriptor, value, position) {
  const source = Buffer.from(String(value), "utf8");
  let offset = 0;
  while (offset < source.length) {
    const written = writeSync(
      descriptor,
      source,
      offset,
      source.length - offset,
      position === undefined ? null : position + offset
    );
    if (!Number.isInteger(written) || written < 1) {
      throw new Error("click receipt durable write did not complete");
    }
    offset += written;
  }
}

function clickWitnessSource({
  storeId,
  ledgerId,
  generationId,
  entryCount,
  ledgerHead,
  ledgerSha256,
  updatedAt
}) {
  return `${JSON.stringify({
    schema_version: 1,
    store_id: storeId,
    ledger_id: ledgerId,
    generation_id: generationId,
    entry_count: clickLedgerCount(entryCount),
    ledger_head: ledgerHead,
    ledger_sha256: ledgerSha256,
    updated_at: requireTimestamp(updatedAt, "click receipt witness update time")
  })}\n`;
}

export function browserClickReceiptStoreProvisioning({
  directory,
  witness_path,
  store_id,
  ledger_id,
  generation_id,
  created_at
}) {
  const suppliedDirectory = String(directory || "");
  const suppliedWitnessPath = String(witness_path || "");
  if (!isAbsolute(suppliedDirectory) || !isAbsolute(suppliedWitnessPath)) {
    throw new Error("Submit click receipt store path is not safely configured");
  }
  let canonicalDirectory;
  let canonicalWitnessPath;
  let directoryIdentity;
  let witnessIdentity;
  try {
    const directoryStat = lstatSync(resolve(suppliedDirectory), { bigint: true });
    directoryIdentity = requirePrivateClickObject(directoryStat, "directory");
    canonicalDirectory = realpathSync(resolve(suppliedDirectory));
    const witnessStat = lstatSync(resolve(suppliedWitnessPath), { bigint: true });
    witnessIdentity = requirePrivateClickObject(witnessStat, "file");
    if (witnessStat.size !== 0n) throw new Error("witness is not empty");
    canonicalWitnessPath = realpathSync(resolve(suppliedWitnessPath));
    if (!independentClickWitness(canonicalDirectory, canonicalWitnessPath)) {
      throw new Error("witness must be independent");
    }
  } catch {
    throw new Error(
      "Submit click receipt store and independent witness must already exist privately"
    );
  }
  const generationId = requireClickGenerationId(generation_id);
  const directoryBindingDigest = clickStoreBindingDigest({
    directory: canonicalDirectory,
    directoryIdentity,
    witnessPath: canonicalWitnessPath,
    witnessIdentity,
    generationId
  });
  const manifest = {
    schema_version: 1,
    store_id: requireClickStoreId(store_id, "store"),
    ledger_id: requireClickStoreId(ledger_id, "ledger"),
    generation_id: generationId,
    directory_identity: directoryIdentity,
    witness_identity: witnessIdentity,
    directory_binding_digest: directoryBindingDigest,
    created_at: requireTimestamp(created_at, "click receipt store creation time")
  };
  const ledgerHeader = {
    schema_version: 1,
    store_id: manifest.store_id,
    ledger_id: manifest.ledger_id,
    generation_id: generationId
  };
  const manifestSource = `${JSON.stringify(manifest)}\n`;
  const ledgerSource = `${JSON.stringify(ledgerHeader)}\n`;
  const ledgerHead = clickLedgerHead(ledgerHeader);
  return {
    directory: canonicalDirectory,
    witness_path: canonicalWitnessPath,
    directory_identity: directoryIdentity,
    witness_identity: witnessIdentity,
    manifest,
    manifest_source: manifestSource,
    manifest_sha256: sha256Text(manifestSource),
    ledger_source: ledgerSource,
    witness_source: clickWitnessSource({
      storeId: manifest.store_id,
      ledgerId: manifest.ledger_id,
      generationId,
      entryCount: 0,
      ledgerHead,
      ledgerSha256: sha256Text(ledgerSource),
      updatedAt: manifest.created_at
    })
  };
}

function readBoundedClickStoreDescriptor(descriptor, maximumBytes, expectedIdentity) {
  const metadata = fstatSync(descriptor, { bigint: true });
  requirePrivateClickObject(metadata, "file", expectedIdentity);
  if (
    metadata.size < 2n ||
    metadata.size > BigInt(maximumBytes)
  ) {
    throw new Error("invalid click receipt store file");
  }
  return readFileSync(descriptor, "utf8");
}

function consumeSubmitAuthorizationReceipt(
  receiptStore,
  authorizationDigest,
  submissionIdempotencyKey,
  canonicalJobId,
  consumedAt
) {
  requireExactKeys(
    receiptStore,
    [
      "directory",
      "witness_path",
      "store_id",
      "ledger_id",
      "generation_id",
      "manifest_sha256",
      "directory_binding_digest",
      "directory_identity",
      "witness_identity"
    ],
    [],
    "submit click receipt store"
  );
  const storeId = requireClickStoreId(receiptStore.store_id, "store");
  const ledgerId = requireClickStoreId(receiptStore.ledger_id, "ledger");
  const generationId = requireClickGenerationId(receiptStore.generation_id);
  const expectedDirectoryIdentity = requireClickFsIdentity(
    receiptStore.directory_identity
  );
  const expectedWitnessIdentity = requireClickFsIdentity(
    receiptStore.witness_identity
  );
  if (!/^sha256:[a-f0-9]{64}$/.test(String(receiptStore.manifest_sha256 || ""))) {
    throw new Error("Submit click receipt store manifest is not provisioned");
  }
  if (
    !/^sha256:[a-f0-9]{64}$/.test(
      String(receiptStore.directory_binding_digest || "")
    )
  ) {
    throw new Error("Submit click receipt store binding is not provisioned");
  }
  const suppliedDirectory = String(receiptStore.directory || "");
  const suppliedWitnessPath = String(receiptStore.witness_path || "");
  if (
    !isAbsolute(suppliedDirectory) ||
    !isAbsolute(suppliedWitnessPath) ||
    !/^[a-f0-9]{64}$/.test(String(authorizationDigest || "")) ||
    !/^submission-v1:[a-f0-9]{64}$/.test(
      String(submissionIdempotencyKey || "")
    ) ||
    !String(canonicalJobId || "").trim()
  ) {
    throw new Error("Submit click receipt storage is not safely configured");
  }

  let directory;
  let lockDescriptor;
  let receiptDescriptor;
  let ledgerDescriptor;
  let manifestDescriptor;
  let witnessDescriptor;
  let directoryDescriptor;
  let lockOwned = false;
  let exclusiveStage = "lock";
  const noFollow = FS_CONSTANTS.O_NOFOLLOW || 0;
  const closeDescriptor = (descriptor) => {
    if (descriptor === undefined) return;
    try {
      closeSync(descriptor);
    } catch {
      // Existing receipt or lock evidence keeps the authorization fail-closed.
    }
  };
  const releaseLock = () => {
    if (!lockOwned) return;
    unlinkSync(join(directory, CLICK_STORE_LOCK_FILE));
    lockOwned = false;
    directoryDescriptor = openSync(
      directory,
      FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_DIRECTORY || 0) | noFollow
    );
    requirePrivateClickObject(
      fstatSync(directoryDescriptor, { bigint: true }),
      "directory",
      expectedDirectoryIdentity
    );
    fsyncSync(directoryDescriptor);
    closeSync(directoryDescriptor);
    directoryDescriptor = undefined;
  };

  try {
    const directoryStat = lstatSync(resolve(suppliedDirectory), { bigint: true });
    requirePrivateClickObject(
      directoryStat,
      "directory",
      expectedDirectoryIdentity
    );
    directory = realpathSync(resolve(suppliedDirectory));
    const canonicalWitnessPath = realpathSync(resolve(suppliedWitnessPath));
    const witnessStat = lstatSync(resolve(suppliedWitnessPath), { bigint: true });
    requirePrivateClickObject(witnessStat, "file", expectedWitnessIdentity);
    if (!independentClickWitness(directory, canonicalWitnessPath)) {
      throw new Error("click receipt witness is not independent");
    }
    const bindingDigest = clickStoreBindingDigest({
      directory,
      directoryIdentity: expectedDirectoryIdentity,
      witnessPath: canonicalWitnessPath,
      witnessIdentity: expectedWitnessIdentity,
      generationId
    });
    if (bindingDigest !== receiptStore.directory_binding_digest) {
      throw new Error("click receipt binding mismatch");
    }
    lockDescriptor = openSync(
      join(directory, CLICK_STORE_LOCK_FILE),
      FS_CONSTANTS.O_CREAT |
        FS_CONSTANTS.O_EXCL |
        FS_CONSTANTS.O_RDWR |
        noFollow,
      0o600
    );
    lockOwned = true;
    writeAllSync(lockDescriptor, `${storeId}\n`);
    fsyncSync(lockDescriptor);
    closeSync(lockDescriptor);
    lockDescriptor = undefined;
    lockDescriptor = openSync(
      join(directory, CLICK_STORE_LOCK_FILE),
      FS_CONSTANTS.O_RDONLY | noFollow
    );
    if (
      readBoundedClickStoreDescriptor(lockDescriptor, 512) !== `${storeId}\n`
    ) {
      throw new Error("click receipt lock verification failed");
    }
    closeSync(lockDescriptor);
    lockDescriptor = undefined;

    manifestDescriptor = openSync(
      join(directory, CLICK_STORE_MANIFEST_FILE),
      FS_CONSTANTS.O_RDONLY | noFollow
    );
    const manifestSource = readBoundedClickStoreDescriptor(
      manifestDescriptor,
      4096
    );
    closeSync(manifestDescriptor);
    manifestDescriptor = undefined;
    if (sha256Text(manifestSource) !== receiptStore.manifest_sha256) {
      throw new Error("click receipt manifest digest mismatch");
    }
    let manifest;
    try {
      manifest = JSON.parse(manifestSource);
    } catch {
      throw new Error("invalid click receipt manifest");
    }
    requireExactKeys(
      manifest,
      [
        "schema_version",
        "store_id",
        "ledger_id",
        "generation_id",
        "directory_identity",
        "witness_identity",
        "directory_binding_digest",
        "created_at"
      ],
      [],
      "submit click receipt manifest"
    );
    if (
      manifest.schema_version !== 1 ||
      manifest.store_id !== storeId ||
      manifest.ledger_id !== ledgerId ||
      manifest.generation_id !== generationId ||
      manifest.directory_identity !== expectedDirectoryIdentity ||
      manifest.witness_identity !== expectedWitnessIdentity ||
      manifest.directory_binding_digest !== bindingDigest ||
      manifest.directory_binding_digest !==
        receiptStore.directory_binding_digest ||
      !validTimestamp(manifest.created_at)
    ) {
      throw new Error("click receipt manifest identity mismatch");
    }

    ledgerDescriptor = openSync(
      join(directory, CLICK_STORE_LEDGER_FILE),
      FS_CONSTANTS.O_RDWR | FS_CONSTANTS.O_APPEND | noFollow
    );
    const ledgerSource = readBoundedClickStoreDescriptor(
      ledgerDescriptor,
      MAXIMUM_CLICK_LEDGER_BYTES
    );
    if (!ledgerSource.endsWith("\n")) {
      throw new Error("click receipt ledger is incomplete");
    }
    const ledgerLines = ledgerSource.trimEnd().split("\n");
    let ledgerHeader;
    try {
      ledgerHeader = JSON.parse(ledgerLines[0]);
    } catch {
      throw new Error("invalid click receipt ledger header");
    }
    requireExactKeys(
      ledgerHeader,
      ["schema_version", "store_id", "ledger_id", "generation_id"],
      [],
      "submit click receipt ledger header"
    );
    if (
      ledgerHeader.schema_version !== 1 ||
      ledgerHeader.store_id !== storeId ||
      ledgerHeader.ledger_id !== ledgerId ||
      ledgerHeader.generation_id !== generationId
    ) {
      throw new Error("click receipt ledger identity mismatch");
    }
    const seen = new Set();
    const seenSubmissionKeys = new Set();
    const seenJobIdentities = new Set();
    let ledgerHead = clickLedgerHead(ledgerHeader);
    let entryCount = 0;
    for (const source of ledgerLines.slice(1)) {
      let entry;
      try {
        entry = JSON.parse(source);
      } catch {
        throw new Error("invalid click receipt ledger entry");
      }
      requireExactKeys(
        entry,
        [
          "schema_version",
          "store_id",
          "ledger_id",
          "generation_id",
          "sequence",
          "previous_head",
          "authorization_digest",
          "submission_idempotency_key",
          "job_identity_digest",
          "receipt_digest",
          "consumed_at",
          "entry_hash"
        ],
        [],
        "submit click receipt ledger entry"
      );
      if (
        entry.schema_version !== 1 ||
        entry.store_id !== storeId ||
        entry.ledger_id !== ledgerId ||
        entry.generation_id !== generationId ||
        entry.sequence !== clickLedgerCount(entryCount + 1) ||
        entry.previous_head !== ledgerHead ||
        !/^[a-f0-9]{64}$/.test(String(entry.authorization_digest || "")) ||
        !/^submission-v1:[a-f0-9]{64}$/.test(
          String(entry.submission_idempotency_key || "")
        ) ||
        !/^[a-f0-9]{64}$/.test(String(entry.job_identity_digest || "")) ||
        !/^[a-f0-9]{64}$/.test(String(entry.receipt_digest || "")) ||
        !validTimestamp(entry.consumed_at) ||
        seen.has(entry.authorization_digest) ||
        seenSubmissionKeys.has(entry.submission_idempotency_key) ||
        seenJobIdentities.has(entry.job_identity_digest)
      ) {
        throw new Error("click receipt ledger entry is invalid or duplicated");
      }
      const entryCore = { ...entry };
      delete entryCore.entry_hash;
      if (entry.entry_hash !== clickLedgerHead(entryCore)) {
        throw new Error("click receipt ledger chain is invalid");
      }
      seen.add(entry.authorization_digest);
      seenSubmissionKeys.add(entry.submission_idempotency_key);
      seenJobIdentities.add(entry.job_identity_digest);
      ledgerHead = entry.entry_hash;
      entryCount += 1;
    }
    witnessDescriptor = openSync(
      canonicalWitnessPath,
      FS_CONSTANTS.O_RDWR | noFollow
    );
    const witnessSource = readBoundedClickStoreDescriptor(
      witnessDescriptor,
      4096,
      expectedWitnessIdentity
    );
    let witness;
    try {
      witness = JSON.parse(witnessSource);
    } catch {
      throw new Error("invalid click receipt witness");
    }
    requireExactKeys(
      witness,
      [
        "schema_version",
        "store_id",
        "ledger_id",
        "generation_id",
        "entry_count",
        "ledger_head",
        "ledger_sha256",
        "updated_at"
      ],
      [],
      "submit click receipt witness"
    );
    if (
      witness.schema_version !== 1 ||
      witness.store_id !== storeId ||
      witness.ledger_id !== ledgerId ||
      witness.generation_id !== generationId ||
      witness.entry_count !== clickLedgerCount(entryCount) ||
      witness.ledger_head !== ledgerHead ||
      witness.ledger_sha256 !== sha256Text(ledgerSource) ||
      !validTimestamp(witness.updated_at)
    ) {
      throw new Error("click receipt ledger and witness are inconsistent");
    }
    const jobIdentityDigest = digest(String(canonicalJobId));
    if (
      seen.has(authorizationDigest) ||
      seenSubmissionKeys.has(submissionIdempotencyKey) ||
      seenJobIdentities.has(jobIdentityDigest)
    ) {
      throw new Error("Submit click authorization was already consumed");
    }

    const receipt = {
      schema_version: 1,
      store_id: storeId,
      ledger_id: ledgerId,
      generation_id: generationId,
      authorization_digest: authorizationDigest,
      submission_idempotency_key: submissionIdempotencyKey,
      job_identity_digest: jobIdentityDigest,
      consumed_at: requireTimestamp(consumedAt, "submit click consumption time")
    };
    const receiptDigest = digest(receipt);
    exclusiveStage = "receipt";
    const receiptPath = join(directory, `${jobIdentityDigest}.job.json`);
    receiptDescriptor = openSync(
      receiptPath,
      FS_CONSTANTS.O_CREAT |
        FS_CONSTANTS.O_EXCL |
        FS_CONSTANTS.O_WRONLY |
        noFollow,
      0o600
    );
    const receiptSource = `${JSON.stringify(receipt)}\n`;
    writeAllSync(receiptDescriptor, receiptSource);
    fsyncSync(receiptDescriptor);
    closeSync(receiptDescriptor);
    receiptDescriptor = undefined;
    receiptDescriptor = openSync(receiptPath, FS_CONSTANTS.O_RDONLY | noFollow);
    if (
      readBoundedClickStoreDescriptor(receiptDescriptor, 4096) !== receiptSource
    ) {
      throw new Error("click receipt verification failed");
    }
    closeSync(receiptDescriptor);
    receiptDescriptor = undefined;

    directoryDescriptor = openSync(
      directory,
      FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_DIRECTORY || 0) | noFollow
    );
    requirePrivateClickObject(
      fstatSync(directoryDescriptor, { bigint: true }),
      "directory",
      expectedDirectoryIdentity
    );
    fsyncSync(directoryDescriptor);
    closeSync(directoryDescriptor);
    directoryDescriptor = undefined;

    const ledgerEntryCore = {
      schema_version: 1,
      store_id: storeId,
      ledger_id: ledgerId,
      generation_id: generationId,
      sequence: clickLedgerCount(entryCount + 1),
      previous_head: ledgerHead,
      authorization_digest: authorizationDigest,
      submission_idempotency_key: submissionIdempotencyKey,
      job_identity_digest: jobIdentityDigest,
      receipt_digest: receiptDigest,
      consumed_at: receipt.consumed_at
    };
    const ledgerEntry = {
      ...ledgerEntryCore,
      entry_hash: clickLedgerHead(ledgerEntryCore)
    };
    const ledgerEntrySource = `${JSON.stringify(ledgerEntry)}\n`;
    writeAllSync(ledgerDescriptor, ledgerEntrySource);
    fsyncSync(ledgerDescriptor);
    closeSync(ledgerDescriptor);
    ledgerDescriptor = undefined;
    ledgerDescriptor = openSync(
      join(directory, CLICK_STORE_LEDGER_FILE),
      FS_CONSTANTS.O_RDONLY | noFollow
    );
    if (
      readBoundedClickStoreDescriptor(
        ledgerDescriptor,
        MAXIMUM_CLICK_LEDGER_BYTES
      ) !== `${ledgerSource}${ledgerEntrySource}`
    ) {
      throw new Error("click receipt ledger verification failed");
    }
    closeSync(ledgerDescriptor);
    ledgerDescriptor = undefined;

    const nextWitnessSource = clickWitnessSource({
      storeId,
      ledgerId,
      generationId,
      entryCount: entryCount + 1,
      ledgerHead: ledgerEntry.entry_hash,
      ledgerSha256: sha256Text(`${ledgerSource}${ledgerEntrySource}`),
      updatedAt: receipt.consumed_at
    });
    if (Buffer.byteLength(nextWitnessSource) !== Buffer.byteLength(witnessSource)) {
      throw new Error("click receipt witness size changed");
    }
    writeAllSync(witnessDescriptor, nextWitnessSource, 0);
    fsyncSync(witnessDescriptor);
    requirePrivateClickObject(
      fstatSync(witnessDescriptor, { bigint: true }),
      "file",
      expectedWitnessIdentity
    );
    closeSync(witnessDescriptor);
    witnessDescriptor = undefined;
    witnessDescriptor = openSync(
      canonicalWitnessPath,
      FS_CONSTANTS.O_RDONLY | noFollow
    );
    if (
      readBoundedClickStoreDescriptor(
        witnessDescriptor,
        4096,
        expectedWitnessIdentity
      ) !== nextWitnessSource
    ) {
      throw new Error("click receipt witness verification failed");
    }
    closeSync(witnessDescriptor);
    witnessDescriptor = undefined;

    directoryDescriptor = openSync(directory, "r");
    requirePrivateClickObject(
      fstatSync(directoryDescriptor, { bigint: true }),
      "directory",
      expectedDirectoryIdentity
    );
    fsyncSync(directoryDescriptor);
    closeSync(directoryDescriptor);
    directoryDescriptor = undefined;
    releaseLock();
    return receipt;
  } catch (error) {
    closeDescriptor(lockDescriptor);
    closeDescriptor(receiptDescriptor);
    closeDescriptor(ledgerDescriptor);
    closeDescriptor(manifestDescriptor);
    closeDescriptor(witnessDescriptor);
    closeDescriptor(directoryDescriptor);
    if (lockOwned) {
      try {
        releaseLock();
      } catch {
        // A retained lock is fail-closed and requires backed-up reconciliation.
      }
    }
    if (
      error?.message === "Submit click authorization was already consumed" ||
      (error?.code === "EEXIST" && exclusiveStage === "receipt")
    ) {
      throw new Error("Submit click authorization was already consumed");
    }
    if (error?.code === "EEXIST" && exclusiveStage === "lock") {
      throw new Error("Submit click receipt store is busy or requires recovery");
    }
    throw new Error("Submit click receipt store is missing, changed, or unsafe");
  }
}

function requireExactKeys(value, required, optional = [], label = "payload") {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !(key in value));
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `${label} keys are invalid; missing count: ${missing.length}; ` +
        `unsupported count: ${extra.length}`
    );
  }
}

function validTimestamp(value) {
  const textValue = String(value || "");
  const parsed = Date.parse(textValue);
  return (
    textValue.length === 24 &&
    Number.isFinite(parsed) &&
    new Date(parsed).toISOString() === textValue
  );
}

function requireTimestamp(value, label) {
  if (!validTimestamp(value)) throw new Error(`${label} must be an ISO timestamp`);
  return String(value);
}

function requireBrowserRuntime(runtime) {
  if (
    !isPlainObject(runtime) ||
    !Number.isInteger(runtime.claim_lease_ms) ||
    runtime.claim_lease_ms < 1 ||
    !isPlainObject(runtime.retry) ||
    !Number.isInteger(runtime.retry.max_attempts) ||
    runtime.retry.max_attempts < 1 ||
    !Number.isInteger(runtime.retry.backoff_ms) ||
    runtime.retry.backoff_ms < 1
  ) {
    throw new Error("Browser runtime retry and lease policy is invalid");
  }
  return runtime;
}

function boundedSafeText(value, maximum = 240) {
  return String(value || "")
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(
      /\bauthorization\s*[:=]\s*(?:bearer\s+)?\S+/gi,
      "[redacted]"
    )
    .replace(
      /\b(?:authorization|cookie|password|api[-_ ]?key|token|secret|webhook|private[-_ ]?key)\s*[:=]\s*\S+/gi,
      "[redacted]"
    )
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

function assertAutonomous(record) {
  if (record?.execution_mode !== "autonomous_chrome") {
    throw new Error("Browser executor requires explicit autonomous_chrome mode");
  }
  if (
    record?.automation_contract_version !==
    BROWSER_AUTOMATION_CONTRACT_VERSION
  ) {
    throw new Error("Browser executor automation contract is stale or missing");
  }
  if (String(record?.user_action || "").trim()) {
    throw new Error("Autonomous rows cannot carry a manual user action");
  }
}

function requireCurrentGuard(record, label = "record") {
  if (!stateGuardMatches(record)) {
    throw new Error(`${label} state guard is stale`);
  }
}

function nextRecord(record, updates, now) {
  const checkedNow = requireTimestamp(now, "browser record update time");
  const next = {
    ...record,
    ...updates,
    record_version: Number(record.record_version || 0) + 1,
    updated_at: checkedNow
  };
  return { ...next, state_guard: stateGuard(next) };
}

function requireNoValidationErrors(errors, label) {
  if (!Array.isArray(errors) || errors.length === 0) return;
  // Contract, policy, and model validators may include caller-controlled values
  // in their detailed diagnostics. The browser/CLI boundary reports only a
  // bounded category and count so secrets from rows, forms, or messages never
  // reach stderr.
  throw new Error(`${label}; failure count: ${errors.length}`);
}

function requireValidProposedRecord(record, schema) {
  const errors = validateRecordStoreContract(
    record,
    AUTONOMOUS_SOURCE_STORE,
    schema
  );
  requireNoValidationErrors(errors, "Browser executor proposed an invalid record");
  return record;
}

function exactFieldMismatches(expected, actual, fields) {
  return fields.filter(
    (field) =>
      JSON.stringify(stableValue(expected?.[field])) !==
      JSON.stringify(stableValue(actual?.[field]))
  );
}

function requireCurrentConfiguration(record, {
  profile,
  rankingPolicy,
  applicationPolicy,
  packPolicy
}) {
  const mismatches = [];
  if (record.message_profile_version !== profile?.profile_version) {
    mismatches.push("message_profile_version");
  }
  if (record.application_pack_profile_version !== profile?.profile_version) {
    mismatches.push("application_pack_profile_version");
  }
  if (record.message_policy_version !== applicationPolicy?.policy_version) {
    mismatches.push("message_policy_version");
  }
  if (record.application_pack_policy_version !== packPolicy?.policy_version) {
    mismatches.push("application_pack_policy_version");
  }
  if (record.application_pack_version !== packPolicy?.pack_version) {
    mismatches.push("application_pack_version");
  }
  const expectedContextDigest = browserContextDigest({
    record,
    profile,
    rankingPolicy,
    applicationPolicy,
    packPolicy
  });
  if (record.browser_context_digest !== expectedContextDigest) {
    mismatches.push("browser_context_digest");
  }
  if (mismatches.length > 0) {
    throw new Error(`Browser authorization configuration is stale: ${mismatches.join(", ")}`);
  }
}

function requireResultConfiguration(record, configuration) {
  const expectedContextDigest = browserContextDigest({
    record,
    profile: configuration?.profile,
    rankingPolicy: configuration?.rankingPolicy,
    applicationPolicy: configuration?.applicationPolicy,
    packPolicy: configuration?.packPolicy
  });
  if (record.browser_context_digest !== expectedContextDigest) {
    throw new Error("Browser authorization configuration is stale: browser_context_digest");
  }
  if (["generating", "filling", "submit_started", "ambiguous"].includes(
    record.browser_state
  )) {
    requireCurrentConfiguration(record, configuration ?? {});
  }
}

function expectedBrowserClaimKey(record) {
  return [
    "browser_executor",
    String(record?.canonical_job_id || "")
      .trim()
      .normalize("NFKC")
      .toLocaleLowerCase("en-US"),
    "application"
  ].join(":");
}

function requireWinningBrowserClaim(record, persistedClaims, now, runtime) {
  const checkedRuntime = requireBrowserRuntime(runtime);
  requireTimestamp(now, "browser authorization now");
  if (
    record.processing_stage !== "browser_executor" ||
    !String(record.processing_token || "").trim() ||
    !validTimestamp(record.processing_started_at)
  ) {
    throw new Error("Browser authorization requires a persisted live claim");
  }
  const expectedKey = expectedBrowserClaimKey(record);
  const expectedExpiry = new Date(
    Date.parse(record.processing_started_at) + checkedRuntime.claim_lease_ms
  ).toISOString();
  const matching = (Array.isArray(persistedClaims) ? persistedClaims : []).filter(
    (claim) =>
      claim?.claim_key === expectedKey &&
      claim?.token === record.processing_token &&
      String(claim?.token || "").endsWith(`:${expectedKey}`) &&
      claim?.canonical_job_id === record.canonical_job_id &&
      claim?.stage === "browser_executor" &&
      claim?.created_at === record.processing_started_at &&
      claim?.expires_at === expectedExpiry
  );
  if (
    matching.length !== 1 ||
    selectWinningSystemClaims(matching, persistedClaims, now).length !== 1
  ) {
    throw new Error("Browser authorization claim is expired, lost, or not the winner");
  }
}

function hasAnyLiveBrowserClaim(record, persistedClaims, now) {
  const expectedKey = expectedBrowserClaimKey(record);
  const relevant = (Array.isArray(persistedClaims) ? persistedClaims : []).filter(
    (claim) =>
      String(claim?.claim_key || "")
        .trim()
        .normalize("NFKC")
        .toLocaleLowerCase("en-US") === expectedKey
  );
  return selectWinningSystemClaims(relevant, persistedClaims, now).length > 0;
}

function oneIdentity(rows, canonicalJobId, label) {
  const matches = (Array.isArray(rows) ? rows : []).filter(
    (row) => String(row?.canonical_job_id || "") === canonicalJobId
  );
  if (!canonicalJobId || matches.length !== 1) {
    throw new Error(`${label} identity is missing or ambiguous`);
  }
  return matches[0];
}

function requireExactFreshRecord(expected, freshSourceRows, schema, label) {
  const persisted = oneIdentity(
    freshSourceRows,
    expected?.canonical_job_id,
    label
  );
  const mismatches = exactFieldMismatches(expected, persisted, schema?.fields ?? []);
  if (mismatches.length > 0) {
    throw new Error(`${label} persistence mismatch: ${mismatches.join(", ")}`);
  }
  requireCurrentGuard(persisted, label);
  const errors = validateRecordStoreContract(
    persisted,
    AUTONOMOUS_SOURCE_STORE,
    schema
  );
  requireNoValidationErrors(errors, `${label} record is invalid`);
  return persisted;
}

function persistedPack(record, pack) {
  return {
    application_instructions: pack.application_instructions,
    screening_questions: pack.screening_questions,
    requirement_coverage: pack.requirement_coverage,
    application_message_plan: [pack.message_plan],
    selected_proof_refs: pack.selected_proof_refs,
    application_warnings: pack.application_warnings,
    application_pack_status: pack.application_pack_status,
    application_pack_version: pack.application_pack_version,
    application_pack_profile_version: pack.application_pack_profile_version,
    application_pack_policy_version: pack.application_pack_policy_version,
    coverage_contract_version: pack.coverage_contract_version,
    message_plan_version: pack.message_plan.version,
    application_pack_generated_at: pack.application_pack_generated_at
  };
}

function boundedContextJob(record, packPolicy = {}) {
  const configured = Number(packPolicy.maximum_description_characters);
  const maximumDescription = Number.isInteger(configured) && configured > 0
    ? Math.min(configured * 2, 100000)
    : 100000;
  return Object.fromEntries(
    CONTEXT_JOB_FIELDS.map((field) => [
      field,
      field === "job_description"
        ? String(record?.[field] ?? "").slice(0, maximumDescription)
        : record?.[field] ?? ""
    ])
  );
}

function observedText(value, label, maximum, { required = false } = {}) {
  if (typeof value !== "string") {
    throw new Error(`${label} must be text`);
  }
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u200b-\u200d\u2060\ufeff]/gi, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, " ")
    .split("\n")
    .map((line) => line.replace(/[\t\v\f\u00a0 ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if ((required && !normalized) || normalized.length > maximum) {
    throw new Error(`${label} is missing or exceeds its bounded length`);
  }
  return normalized;
}

function comparableObservedText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u200b-\u200d\u2060\ufeff]/gi, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

/**
 * Binds role facts observed in Chrome to the already claimed OnlineJobs job.
 * The page is authoritative only for job facts; it can never supply candidate
 * claims, policy, form controls, or execution instructions.
 */
export function bindObservedJobContext(
  freshRecord,
  observation,
  {
    profile,
    rankingPolicy,
    applicationPolicy,
    packPolicy,
    persistedClaims,
    runtime,
    schema
  },
  now = new Date().toISOString()
) {
  now = requireTimestamp(now, "live job context observation time");
  assertAutonomous(freshRecord);
  requireCurrentGuard(freshRecord, "Live job context source");
  if (freshRecord.browser_state !== "evaluating") {
    throw new Error("Live job context requires a persisted evaluating row");
  }
  requireWinningBrowserClaim(freshRecord, persistedClaims, now, runtime);
  if (freshRecord.browser_job_digest !== browserJobDigest(freshRecord)) {
    throw new Error("Job input changed before live context binding");
  }
  const currentContextDigest = browserContextDigest({
    record: freshRecord,
    profile,
    rankingPolicy,
    applicationPolicy,
    packPolicy
  });
  if (freshRecord.browser_context_digest !== currentContextDigest) {
    throw new Error("Autonomous context changed before live context binding");
  }
  requireExactKeys(
    observation,
    [
      "page_url",
      "source_job_id",
      "job_title",
      "company",
      "job_description",
      "salary_text"
    ],
    [],
    "live job observation"
  );
  const observedPage = normalizeCanonicalUrl(observation.page_url);
  const expectedPage = normalizeCanonicalUrl(freshRecord.canonical_url);
  const sourceJobId = String(observation.source_job_id || "");
  if (
    !sourceJobId ||
    sourceJobId !== String(freshRecord.source_job_id || "") ||
    extractOnlineJobsId(observedPage) !== sourceJobId ||
    observedPage !== expectedPage
  ) {
    throw new Error("Live job observation does not match the claimed job");
  }
  const jobTitle = observedText(
    observation.job_title,
    "Observed job title",
    500,
    { required: true }
  );
  if (
    comparableObservedText(jobTitle) !==
    comparableObservedText(freshRecord.job_title)
  ) {
    throw new Error("Observed job title changed after the browser claim");
  }
  const maximumDescription = Math.min(
    Math.max(Number(packPolicy?.maximum_description_characters) || 0, 40) * 2,
    100000
  );
  const jobDescription = observedText(
    observation.job_description,
    "Observed job description",
    maximumDescription,
    { required: true }
  );
  if (comparableObservedText(jobDescription).length < 40) {
    throw new Error("Observed job description is insufficient for autonomous evaluation");
  }
  const company = observedText(observation.company, "Observed company", 500);
  const salaryText = observedText(
    observation.salary_text,
    "Observed salary",
    1000
  );
  for (const [label, persistedValue, observedValue] of [
    ["company", freshRecord.company, company],
    ["salary", freshRecord.salary_text, salaryText]
  ]) {
    if (
      comparableObservedText(persistedValue) &&
      comparableObservedText(observedValue) &&
      comparableObservedText(persistedValue) !==
        comparableObservedText(observedValue)
    ) {
      throw new Error(`Observed ${label} changed after the browser claim`);
    }
  }
  const enriched = {
    ...freshRecord,
    company: String(freshRecord.company || "").trim() || company,
    job_description: jobDescription,
    salary_text: String(freshRecord.salary_text || "").trim() || salaryText
  };
  enriched.browser_job_digest = browserJobDigest(enriched);
  enriched.browser_context_digest = browserContextDigest({
    record: enriched,
    profile,
    rankingPolicy,
    applicationPolicy,
    packPolicy
  });
  const proposedRecord = nextRecord(
    freshRecord,
    {
      company: enriched.company,
      job_description: enriched.job_description,
      salary_text: enriched.salary_text,
      browser_job_digest: enriched.browser_job_digest,
      browser_context_digest: enriched.browser_context_digest
    },
    now
  );
  requireValidProposedRecord(proposedRecord, schema);
  return {
    protocol_version: BROWSER_EXECUTOR_PROTOCOL_VERSION,
    attempt_id: proposedRecord.browser_attempt_id,
    context_digest: proposedRecord.browser_context_digest,
    job_digest: proposedRecord.browser_job_digest,
    proposed_record: proposedRecord,
    confirm_fields: LIVE_JOB_CONTEXT_CONFIRM_FIELDS,
    job: boundedContextJob(proposedRecord, packPolicy),
    profile,
    ranking_policy: rankingPolicy,
    application_policy: applicationPolicy,
    pack_policy: packPolicy,
    telemetry: {
      event: "live_job_context_bound",
      canonical_job_id: proposedRecord.canonical_job_id,
      attempt_id: proposedRecord.browser_attempt_id,
      job_digest: proposedRecord.browser_job_digest,
      context_digest: proposedRecord.browser_context_digest
    }
  };
}

export function browserJobDigest(record) {
  return contractBrowserJobDigest(record);
}

export function browserContextDigest({
  record,
  profile,
  rankingPolicy,
  applicationPolicy,
  packPolicy
}) {
  return `context-v1:${digest({
    protocol_version: BROWSER_EXECUTOR_PROTOCOL_VERSION,
    automation_contract_version: BROWSER_AUTOMATION_CONTRACT_VERSION,
    job: boundedContextJob(record, packPolicy),
    profile,
    ranking_policy: rankingPolicy,
    application_policy: applicationPolicy,
    pack_policy: packPolicy
  })}`;
}

export function browserFormFingerprint(form, record) {
  requireExactKeys(
    form,
    [
      "origin",
      "page_url",
      "observed_source_job_id",
      "effective_action",
      "effective_method",
      "submit_control",
      "fields",
      "apply_points"
    ],
    ["apply_point_options", "apply_points_balance"],
    "form fingerprint input"
  );
  if (!record || typeof record !== "object") {
    throw new Error("Form fingerprint requires the claimed job record");
  }
  const origin = parseFormUrl(form.origin);
  const page = parseFormUrl(form.page_url, origin);
  const action = parseFormUrl(form.effective_action);
  requireExactKeys(
    form.submit_control,
    ["name", "type", "effective_action", "effective_method", "value_digest"],
    [],
    "submit control"
  );
  const submitAction = parseFormUrl(form.submit_control.effective_action);
  const allowedHosts = new Set(["onlinejobs.ph", "www.onlinejobs.ph"]);
  const sourceJobId = String(record.source_job_id || "");
  const normalizedPage = normalizeCanonicalUrl(page.href);
  const normalizedRecordPage = normalizeCanonicalUrl(record.canonical_url);
  const expectedActionPath = `/jobseekers/job/${sourceJobId}/apply`;
  const supportedActionPath =
    action.pathname === expectedActionPath || action.pathname === "/apply";
  if (
    origin.protocol !== "https:" ||
    !allowedHosts.has(origin.hostname) ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    page.origin !== origin.origin ||
    action.protocol !== origin.protocol ||
    action.hostname !== origin.hostname ||
    action.port !== origin.port ||
    submitAction.href !== action.href ||
    !sourceJobId ||
    String(form.observed_source_job_id) !== sourceJobId ||
    extractOnlineJobsId(normalizedPage) !== sourceJobId ||
    normalizedPage !== normalizedRecordPage ||
    !supportedActionPath ||
    action.search !== "" ||
    action.hash !== ""
  ) {
    throw new Error("Form must match the claimed OnlineJobs.ph job and application action");
  }
  if (
    String(form.effective_method).toUpperCase() !== "POST" ||
    String(form.submit_control.effective_method).toUpperCase() !== "POST"
  ) {
    throw new Error("Application form method must be POST");
  }
  const serializedForm = JSON.stringify(form);
  if (
    Buffer.byteLength(serializedForm, "utf8") > MAXIMUM_FORM_INVENTORY_BYTES ||
    !Array.isArray(form.fields) ||
    form.fields.length < 1 ||
    form.fields.length > MAXIMUM_FORM_FIELDS
  ) {
    throw new Error("Application form must expose a bounded field inventory");
  }
  const fields = form.fields.map((field, index) => {
    requireExactKeys(
      field,
      ["name", "type", "required"],
      ["id", "maximum_length", "options_digest"],
      `form field ${index}`
    );
    const name = String(field.name || "").trim();
    const id = String(field.id || "").trim();
    const type = String(field.type || "").trim().toLowerCase();
    const optionsDigest = String(field.options_digest || "");
    if (typeof field.required !== "boolean") {
      throw new Error(`Form field ${index} required flag must be boolean`);
    }
    const unnamedContactDisplay =
      !name && id === "contact-info-content" && type === "textarea";
    if (
      (!unnamedContactDisplay &&
        (!name || name.length > 120 || !/^[a-z0-9_.\[\]-]+$/i.test(name))) ||
      id.length > 120 ||
      (id && !/^[a-z0-9_.:-]+$/i.test(id))
    ) {
      throw new Error(`Form field ${index} has an invalid name`);
    }
    if (
      ![
        "hidden",
        "text",
        "textarea",
        "select",
        "radio",
        "checkbox",
        "submit"
      ].includes(type)
    ) {
      throw new Error(`Form field ${index} type is unsupported`);
    }
    if (
      (field.maximum_length !== undefined &&
        (!Number.isInteger(field.maximum_length) ||
          field.maximum_length < 0 ||
          field.maximum_length > 100000)) ||
      (optionsDigest && !/^[a-f0-9]{64}$/.test(optionsDigest))
    ) {
      throw new Error(`Form field ${index} has invalid structural bounds`);
    }
    return {
      name,
      id,
      type,
      required: field.required === true,
      maximum_length: Number.isInteger(field.maximum_length)
        ? field.maximum_length
        : "",
      options_digest: optionsDigest
    };
  });
  const namedFields = fields.filter((field) => field.name);
  if (new Set(namedFields.map((field) => field.name)).size !== namedFields.length) {
    throw new Error("Application form contains duplicate field names");
  }
  const messageFields = fields.filter(
    (field) =>
      ["message", "info[message]"].includes(field.name) &&
      field.type === "textarea" &&
      field.required === true
  );
  const subjectFields = fields.filter(
    (field) =>
      ["subject", "info[subject]"].includes(field.name) &&
      field.type === "text" &&
      field.required === true
  );
  const applyPointFields = fields.filter(
    (field) =>
      (field.name === "apply_points" &&
        field.type === "select" &&
        field.required === true &&
        /^[a-f0-9]{64}$/.test(field.options_digest)) ||
      (field.name === "points" &&
        field.type === "text" &&
        field.required === false)
  );
  const contactDisplayFields = fields.filter(
    (field) =>
      !field.name &&
      field.id === "contact-info-content" &&
      field.type === "textarea" &&
      field.required === false
  );
  const submitFields = fields.filter((field) => field.type === "submit");
  const submitControlName = String(form.submit_control.name || "").trim();
  const submitControlType = String(form.submit_control.type || "")
    .trim()
    .toLowerCase();
  const unsupportedInteractive = fields.filter(
    (field) =>
      !["hidden", "submit"].includes(field.type) &&
      !messageFields.includes(field) &&
      !subjectFields.includes(field) &&
      !applyPointFields.includes(field) &&
      !contactDisplayFields.includes(field)
  );
  const applyPointOptions = Array.isArray(form.apply_point_options)
    ? [...form.apply_point_options].sort((left, right) => left - right)
    : [];
  const applyPointsBalance = Number(form.apply_points_balance);
  const liveGenericForm = action.pathname === "/apply";
  const expectedLiveHiddenFields = [
    "back_id",
    "contact_email",
    "csrf-token",
    "email_sent_count_today",
    "info[email]",
    "info[name]",
    "job_id",
    "sent_to_e_id"
  ];
  const liveHiddenFields = fields
    .filter((field) => field.type === "hidden")
    .map((field) => field.name)
    .sort();
  const liveFieldContractMatches =
    !liveGenericForm ||
    (subjectFields.length === 1 &&
      contactDisplayFields.length === 1 &&
      applyPointFields[0]?.name === "points" &&
      submitControlName === "op" &&
      JSON.stringify(liveHiddenFields) ===
        JSON.stringify(expectedLiveHiddenFields));
  const legacyApplyPointsMatch =
    !liveGenericForm &&
    applyPointOptions.length >= 1 &&
    new Set(applyPointOptions).size === applyPointOptions.length &&
    applyPointOptions.every(
      (value) => Number.isInteger(value) && value >= 1 && value <= 100
    ) &&
    applyPointOptions.includes(form.apply_points) &&
    applyPointFields[0]?.options_digest === digest(applyPointOptions);
  const liveApplyPointsMatch =
    liveGenericForm &&
    Number.isInteger(applyPointsBalance) &&
    applyPointsBalance >= form.apply_points &&
    applyPointsBalance <= 10000;
  let expectedApplyPoints;
  try {
    expectedApplyPoints = requiredApplyPoints(record);
  } catch {
    expectedApplyPoints = undefined;
  }
  if (
    messageFields.length !== 1 ||
    applyPointFields.length !== 1 ||
    !liveFieldContractMatches ||
    submitFields.length !== 1 ||
    submitControlType !== "submit" ||
    submitFields[0]?.name !== submitControlName ||
    !/^[a-f0-9]{64}$/.test(String(form.submit_control.value_digest || "")) ||
    unsupportedInteractive.length > 0 ||
    !Number.isInteger(form.apply_points) ||
    !Number.isInteger(expectedApplyPoints) ||
    form.apply_points !== expectedApplyPoints ||
    form.apply_points < 1 ||
    form.apply_points > 100 ||
    (!legacyApplyPointsMatch && !liveApplyPointsMatch)
  ) {
    throw new Error("Application form fields or live Apply Points are unsupported");
  }
  const normalized = {
    origin: origin.origin,
    page_url: normalizedPage,
    source_job_id: sourceJobId,
    effective_action: action.href,
    effective_method: "POST",
    submit_control: {
      name: submitControlName,
      type: submitControlType,
      effective_action: submitAction.href,
      effective_method: "POST",
      value_digest: form.submit_control.value_digest
    },
    fields: fields.sort((left, right) =>
      `${left.name}:${left.id}:${left.type}`.localeCompare(
        `${right.name}:${right.id}:${right.type}`
      )
    ),
    apply_points: form.apply_points,
    apply_point_options: applyPointOptions,
    apply_points_balance: liveGenericForm ? applyPointsBalance : ""
  };
  return `form-v1:${digest(normalized)}`;
}

export function submissionIdempotencyKey(record) {
  const key = contractSubmissionIdempotencyKey(record);
  if (!key) throw new Error("Submission identity is incomplete");
  return key;
}

function separateSubjectApplicationValues(generatedMessage) {
  const lines = String(generatedMessage || "").split(/\r?\n/);
  const firstLine = String(lines.shift() || "").trim();
  const subjectMatch = /^Subject line:\s*(.+)$/i.exec(firstLine);
  while (lines.length > 0 && !String(lines[0]).trim()) lines.shift();
  const message = lines.join("\n").trim();
  const subject = String(subjectMatch?.[1] || "").trim();
  if (
    !subject ||
    subject.length > 255 ||
    !message ||
    message.length > 4000
  ) {
    throw new Error("Generated application cannot be split into subject and message");
  }
  return { subject, message };
}

function formUsesSeparateSubject(form) {
  return (form?.fields ?? []).some((field) =>
    ["subject", "info[subject]"].includes(String(field?.name || ""))
  );
}

function authorizedApplicationValues(record, form, applyPoints) {
  if (!formUsesSeparateSubject(form)) {
    return {
      message: record.generated_message,
      apply_points: String(applyPoints)
    };
  }
  return {
    ...separateSubjectApplicationValues(record.generated_message),
    apply_points: String(applyPoints)
  };
}

export function sanitizeBrowserEvidence(input = {}) {
  requireExactKeys(
    input,
    ["category"],
    ["summary", "observed_at", "reference_digest"],
    "browser evidence"
  );
  if (!SAFE_RESULT_CATEGORIES.has(input.category)) {
    throw new Error("Browser evidence category is unsupported");
  }
  return {
    category: input.category,
    // Browser/model prose is untrusted and may contain a job description,
    // generated message, credential, or DOM text. Persist a fixed summary from
    // the trusted category vocabulary instead of trying to redact arbitrary
    // caller content.
    summary: SAFE_EVIDENCE_SUMMARIES[input.category],
    observed_at: input.observed_at
      ? requireTimestamp(input.observed_at, "browser evidence observed_at")
      : "",
    reference_digest: /^[a-f0-9]{64}$/.test(input.reference_digest || "")
      ? input.reference_digest
      : ""
  };
}

export function normalizeBrowserSheetRecord(
  input,
  schema,
  now = new Date().toISOString()
) {
  const rawExecutionMode = String(input?.execution_mode ?? "").trim();
  const normalized = normalizeLegacyRecord(input, schema, now);
  if (rawExecutionMode !== "autonomous_chrome") return normalized;

  // Storage normalization may parse JSON arrays and numeric cells, but it
  // must never repair or reinterpret browser-authorizing semantic fields.
  // Invalid autonomous status/action values therefore still fail closed.
  normalized.execution_mode = rawExecutionMode;
  normalized.pipeline_status = input?.pipeline_status ?? "";
  normalized.user_action = input?.user_action ?? "";
  normalized.prep_status = input?.prep_status ?? "";
  return normalized;
}

export function selectAutonomousCandidates(
  stores,
  schema,
  {
    now = new Date().toISOString(),
    deadline_ms = Number.POSITIVE_INFINITY,
    minimum_headroom_ms = 0
  } = {}
) {
  now = requireTimestamp(now, "browser selection now");
  if (!isPlainObject(stores)) throw new Error("Business stores must be an object");
  const identityErrors = validateUniqueIdentityAcrossStores(stores, schema, now);
  requireNoValidationErrors(
    identityErrors,
    "Browser selection rejected business stores"
  );
  const nowMs = Date.parse(now);
  if (
    !Number.isInteger(minimum_headroom_ms) ||
    minimum_headroom_ms < 0 ||
    (Number.isFinite(deadline_ms) && deadline_ms - nowMs < minimum_headroom_ms)
  ) {
    return [];
  }
  const rows = stores[AUTONOMOUS_SOURCE_STORE] ?? [];
  if (!Array.isArray(rows)) throw new Error("Scraped Jobs rows must be an array");
  return rows
    .map((record) => normalizeBrowserSheetRecord(record, schema, now))
    .filter((record) => {
      // Legacy/manual compatibility rows are not browser candidates. Their
      // historical field shape must not prevent an unrelated autonomous row
      // from reaching Chrome; global canonical identity checks still include
      // every business-store row above.
      if (record.execution_mode !== "autonomous_chrome") return false;
      if (Object.hasOwn(record, "browser_next_retry_at")) {
        throw new Error(
          "Browser selection rejected unsupported browser_next_retry_at alias"
        );
      }
      const errors = validateRecordStoreContract(
        record,
        AUTONOMOUS_SOURCE_STORE,
        schema
      );
      requireNoValidationErrors(errors, "Browser selection rejected invalid row");
      if (!DUE_STATES.has(String(record.browser_state || ""))) return false;
      const retryAt = Date.parse(record.next_retry_at || "");
      return !Number.isFinite(retryAt) || retryAt <= nowMs;
    })
    .sort((left, right) => {
      const time = Date.parse(left.created_at || "") - Date.parse(right.created_at || "");
      return time || String(left.canonical_job_id).localeCompare(String(right.canonical_job_id));
    });
}

export function selectAutonomousWork(
  stores,
  schema,
  {
    now = new Date().toISOString(),
    deadline_ms = Number.POSITIVE_INFINITY,
    minimum_headroom_ms = 0,
    persisted_claims = [],
    runtime
  } = {}
) {
  const checkedRuntime = requireBrowserRuntime(runtime);
  now = requireTimestamp(now, "browser selection now");
  const nowMs = Date.parse(now);
  const candidates = selectAutonomousCandidates(stores, schema, {
    now,
    deadline_ms,
    minimum_headroom_ms
  })
    .filter((record) => Number(record.attempt_count || 0) < checkedRuntime.retry.max_attempts)
    .map((record) => ({ operation: "claim", record }));
  if (
    Number.isFinite(deadline_ms) &&
    deadline_ms - nowMs < minimum_headroom_ms
  ) {
    return [];
  }
  const rows = (stores[AUTONOMOUS_SOURCE_STORE] ?? []).map((record) =>
    normalizeBrowserSheetRecord(record, schema, now)
  );
  const recovery = rows
    .filter((record) => {
      if (
        record.execution_mode !== "autonomous_chrome" ||
        !ACTIVE_PRE_SUBMIT_STATES.has(String(record.browser_state || ""))
      ) {
        return false;
      }
      const startedAt = Date.parse(record.processing_started_at || "");
      return (
        Number.isFinite(startedAt) &&
        nowMs - startedAt >= checkedRuntime.claim_lease_ms &&
        !hasAnyLiveBrowserClaim(record, persisted_claims, now)
      );
    })
    .map((record) => ({ operation: "recover", record }));
  const reconciliation = rows
    .filter(
      (record) =>
        record.execution_mode === "autonomous_chrome" &&
        RECONCILIATION_STATES.has(String(record.browser_state || ""))
    )
    .map((record) => ({ operation: "reconcile", record }));
  const priority = { reconcile: 0, recover: 1, claim: 2 };
  return [...reconciliation, ...recovery, ...candidates].sort((left, right) => {
    const byPriority = priority[left.operation] - priority[right.operation];
    if (byPriority) return byPriority;
    const time =
      Date.parse(left.record.created_at || "") -
      Date.parse(right.record.created_at || "");
    return time || String(left.record.canonical_job_id).localeCompare(
      String(right.record.canonical_job_id)
    );
  });
}

export function planAutonomousClaim(
  record,
  {
    execution_id,
    now = new Date().toISOString(),
    attempt_id,
    runtime
  }
) {
  const checkedRuntime = requireBrowserRuntime(runtime);
  now = requireTimestamp(now, "browser claim now");
  assertAutonomous(record);
  requireCurrentGuard(record);
  if (!DUE_STATES.has(String(record.browser_state || ""))) {
    throw new Error("Browser claim requires a queued or retryable row");
  }
  if (!String(execution_id || "").trim()) {
    throw new Error("Browser claim requires execution ID");
  }
  if (Object.hasOwn(record, "browser_next_retry_at")) {
    throw new Error("Browser claim rejected unsupported browser_next_retry_at alias");
  }
  if (
    record.browser_state === "retryable" &&
    (!validTimestamp(record.next_retry_at) ||
      Date.parse(record.next_retry_at) > Date.parse(now))
  ) {
    throw new Error("Browser claim retry backoff has not elapsed");
  }
  const priorAttempts = Number(record.attempt_count || 0);
  if (
    !Number.isInteger(priorAttempts) ||
    priorAttempts < 0 ||
    priorAttempts >= checkedRuntime.retry.max_attempts
  ) {
    throw new Error("Browser claim technical retry limit is exhausted");
  }
  const normalizedAttemptId = String(attempt_id || "").trim() ||
    `attempt-v1:${digest({
      execution_id,
      canonical_job_id: record.canonical_job_id,
      now
    })}`;
  if (!/^attempt-v1:[a-f0-9]{64}$/.test(normalizedAttemptId)) {
    throw new Error("Browser attempt ID is invalid");
  }
  const claim = createSystemClaim({
    stage: "browser_executor",
    canonicalJobId: record.canonical_job_id,
    scope: "application",
    executionId: execution_id,
    now,
    leaseMs: checkedRuntime.claim_lease_ms
  });
  const proposedRecord = nextRecord(
    record,
    {
      browser_state: "claimed",
      browser_attempt_id: normalizedAttemptId,
      browser_job_digest: browserJobDigest(record),
      attempt_count: priorAttempts + 1,
      processing_stage: "browser_executor",
      processing_token: claim.token,
      processing_started_at: now,
      browser_block_category: "",
      error_category: "",
      error_summary: ""
    },
    now
  );
  return {
    protocol_version: BROWSER_EXECUTOR_PROTOCOL_VERSION,
    source_store: AUTONOMOUS_SOURCE_STORE,
    expected_source_guard: record.state_guard,
    system_claim: claim,
    proposed_record: proposedRecord,
    confirm_fields: CLAIM_CONFIRM_FIELDS,
    telemetry: {
      event: "claim_planned",
      canonical_job_id: record.canonical_job_id,
      attempt_id: normalizedAttemptId,
      browser_state: "claimed"
    }
  };
}

export function confirmAutonomousClaim(
  plan,
  { persisted_claims, fresh_source_rows, schema, now = new Date().toISOString() },
  configuration
) {
  now = requireTimestamp(now, "browser claim confirmation now");
  requireExactKeys(
    plan,
    [
      "protocol_version",
      "source_store",
      "expected_source_guard",
      "system_claim",
      "proposed_record",
      "confirm_fields",
      "telemetry"
    ],
    [],
    "claim plan"
  );
  if (plan.protocol_version !== BROWSER_EXECUTOR_PROTOCOL_VERSION) {
    throw new Error("Claim plan protocol is stale");
  }
  const exactPersistedClaims = (Array.isArray(persisted_claims)
    ? persisted_claims
    : []
  ).filter(
    (claim) =>
      exactFieldMismatches(
        plan.system_claim,
        claim,
        SYSTEM_CLAIM_CONFIRM_FIELDS
      ).length === 0
  );
  if (exactPersistedClaims.length !== 1) {
    throw new Error("Browser claim persistence is missing, duplicated, or altered");
  }
  const winners = selectWinningSystemClaims(
    [plan.system_claim],
    persisted_claims,
    now
  );
  if (winners.length !== 1) throw new Error("Browser claim did not win contention");
  const persisted = oneIdentity(
    fresh_source_rows,
    plan.proposed_record.canonical_job_id,
    "Browser claim confirmation"
  );
  const mismatches = exactFieldMismatches(
    plan.proposed_record,
    persisted,
    CLAIM_CONFIRM_FIELDS
  );
  if (mismatches.length > 0) {
    throw new Error(`Browser claim persistence mismatch: ${mismatches.join(", ")}`);
  }
  requireCurrentGuard(persisted, "Persisted browser claim");
  const errors = validateRecordStoreContract(persisted, AUTONOMOUS_SOURCE_STORE, schema);
  requireNoValidationErrors(errors, "Persisted browser claim is invalid");
  const contextDigest = browserContextDigest({ record: persisted, ...configuration });
  const evaluating = nextRecord(
    persisted,
    {
      browser_state: "evaluating",
      browser_context_digest: contextDigest
    },
    now
  );
  return {
    protocol_version: BROWSER_EXECUTOR_PROTOCOL_VERSION,
    attempt_id: evaluating.browser_attempt_id,
    context_digest: contextDigest,
    job_digest: evaluating.browser_job_digest,
    proposed_record: evaluating,
    confirm_fields: CLAIM_CONFIRM_FIELDS,
    job: boundedContextJob(evaluating, configuration.packPolicy),
    profile: configuration.profile,
    ranking_policy: configuration.rankingPolicy,
    application_policy: configuration.applicationPolicy,
    pack_policy: configuration.packPolicy
  };
}

export function validateAutonomousDecision(
  freshRecord,
  decision,
  {
    profile,
    rankingPolicy,
    applicationPolicy,
    packPolicy,
    context_digest,
    form
  },
  now = new Date().toISOString()
) {
  now = requireTimestamp(now, "browser decision now");
  assertAutonomous(freshRecord);
  requireCurrentGuard(freshRecord);
  if (freshRecord.browser_state !== "evaluating") {
    throw new Error("Autonomous decision requires a persisted evaluating row");
  }
  requireExactKeys(
    decision,
    ["protocol_version", "attempt_id", "context_digest", "decision", "reason_code"],
    ["message"],
    "ChatGPT decision"
  );
  if (
    decision.protocol_version !== BROWSER_EXECUTOR_PROTOCOL_VERSION ||
    decision.attempt_id !== freshRecord.browser_attempt_id ||
    decision.context_digest !== context_digest ||
    decision.context_digest !== freshRecord.browser_context_digest
  ) {
    throw new Error("ChatGPT decision is not bound to the winning context");
  }
  if (!['apply', 'skip'].includes(decision.decision)) {
    throw new Error("ChatGPT decision must be apply or skip");
  }
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(String(decision.reason_code || ""))) {
    throw new Error("ChatGPT reason_code must use the bounded code vocabulary");
  }
  const expectedContextDigest = browserContextDigest({
    record: freshRecord,
    profile,
    rankingPolicy,
    applicationPolicy,
    packPolicy
  });
  if (context_digest !== expectedContextDigest) {
    throw new Error("Autonomous context changed before decision validation");
  }
  if (freshRecord.browser_job_digest !== browserJobDigest(freshRecord)) {
    throw new Error("Job input changed after the browser claim");
  }
  const evaluation = autonomousEvaluation(
    freshRecord,
    profile,
    rankingPolicy,
    applicationPolicy,
    now
  );
  const resolutionKey = autonomousResolutionKey(evaluation);
  const resolutionAction =
    resolutionKey === "unavailable"
      ? "skip"
      : packPolicy?.autonomous_resolution?.[resolutionKey];
  if (decision.decision === "skip") {
    if (resolutionAction !== "skip") {
      throw new Error("Apply-by-default policy does not authorize this skip");
    }
    const skipped = nextRecord(
      freshRecord,
      {
        ...evaluation,
        autonomous_decision: "skip",
        browser_state: "skipped",
        pipeline_status: "skip",
        decision_reason: `autonomous_${evaluation.match_decision}`,
        processing_stage: "",
        processing_token: "",
        processing_started_at: ""
      },
      now
    );
    return {
      outcome: "skip",
      proposed_record: skipped,
      telemetry: {
        event: "autonomous_skip",
        canonical_job_id: skipped.canonical_job_id,
        attempt_id: skipped.browser_attempt_id,
        reason_code: decision.reason_code
      }
    };
  }
  if (resolutionAction !== "apply") {
    throw new Error("Job facts do not authorize a truthful autonomous application");
  }
  const pack = buildApplicationPack(
    { ...freshRecord, ...evaluation, user_action: "" },
    profile,
    applicationPolicy,
    packPolicy,
    now
  );
  const packErrors = validateApplicationPack(pack, profile, packPolicy);
  if (pack.application_pack_status !== "ready" || packErrors.length > 0) {
    requireNoValidationErrors(
      packErrors.length > 0 ? packErrors : ["not_ready"],
      "Autonomous application pack is not ready"
    );
  }
  const message = cleanGeneratedMessage(decision.message || "");
  const messageValidation = validateGeneratedMessage(message, {
    job: freshRecord,
    profile,
    policy: applicationPolicy,
    pack
  });
  if (!messageValidation.valid) {
    requireNoValidationErrors(
      messageValidation.errors,
      "ChatGPT message is invalid"
    );
  }
  const formFingerprint = browserFormFingerprint(
    form,
    { ...freshRecord, ...evaluation }
  );
  const identityRecord = {
    ...freshRecord,
    ...evaluation,
    ...persistedPack(freshRecord, pack),
    browser_form_fingerprint: formFingerprint,
    generated_message: message,
    message_profile_version: profile.profile_version,
    message_policy_version: applicationPolicy.policy_version
  };
  const idempotencyKey = submissionIdempotencyKey(identityRecord);
  const filling = nextRecord(
    freshRecord,
    {
      ...evaluation,
      ...persistedPack(freshRecord, pack),
      autonomous_decision: "apply",
      browser_state: "generating",
      browser_form_fingerprint: formFingerprint,
      submission_idempotency_key: idempotencyKey,
      pipeline_status: "ready_to_apply",
      generated_message: message,
      message_profile_version: profile.profile_version,
      message_policy_version: applicationPolicy.policy_version,
      message_validation_status: "valid",
      generated_at: now,
      processing_stage: "browser_executor",
      error_category: "",
      error_summary: ""
    },
    now
  );
  return {
    outcome: "generate_validated",
    proposed_record: filling,
    telemetry: {
      event: "draft_validated",
      canonical_job_id: filling.canonical_job_id,
      attempt_id: filling.browser_attempt_id,
      message_digest: digest(message),
      pack_digest: digest(persistedPack(freshRecord, pack)),
      form_fingerprint: formFingerprint,
      submission_idempotency_key: idempotencyKey
    }
  };
}

export function confirmBrowserReady(
  plannedRecord,
  freshSourceRows,
  {
    profile,
    rankingPolicy,
    applicationPolicy,
    packPolicy,
    persistedClaims,
    runtime,
    form
  },
  now = new Date().toISOString()
) {
  now = requireTimestamp(now, "browser fill authorization now");
  const persisted = oneIdentity(
    freshSourceRows,
    plannedRecord?.canonical_job_id,
    "Browser fill authorization"
  );
  const fields = [
    "record_version",
    "browser_state",
    "browser_attempt_id",
    "browser_job_digest",
    "browser_context_digest",
    "generated_message",
    "message_profile_version",
    "message_policy_version",
    "message_validation_status",
    "application_pack_status",
    "application_pack_version",
    "application_pack_policy_version",
    "state_guard",
    "user_action",
    "notes"
  ];
  const mismatches = exactFieldMismatches(plannedRecord, persisted, fields);
  if (mismatches.length > 0) {
    throw new Error(`Browser fill persistence mismatch: ${mismatches.join(", ")}`);
  }
  assertAutonomous(persisted);
  requireCurrentGuard(persisted);
  requireWinningBrowserClaim(persisted, persistedClaims, now, runtime);
  requireCurrentConfiguration(persisted, {
    profile,
    rankingPolicy,
    applicationPolicy,
    packPolicy
  });
  if (!["generating", "filling"].includes(persisted.browser_state)) {
    throw new Error("Browser fill authorization requires generating or filling state");
  }
  const currentEvaluation = autonomousEvaluation(
    persisted,
    profile,
    rankingPolicy,
    applicationPolicy,
    now
  );
  const authorizedApplyPoints = requiredApplyPoints(currentEvaluation);
  if (
    browserFormFingerprint(
      form,
      { ...persisted, ...currentEvaluation }
    ) !== persisted.browser_form_fingerprint
  ) {
    throw new Error("Application form changed before fill authorization");
  }
  const pack = buildApplicationPack(
    { ...persisted, user_action: "" },
    profile,
    applicationPolicy,
    packPolicy,
    persisted.application_pack_generated_at
  );
  if (pack.application_pack_status !== "ready") {
    throw new Error("Persisted autonomous pack is no longer ready");
  }
  const validation = validateGeneratedMessage(persisted.generated_message, {
    job: persisted,
    profile,
    policy: applicationPolicy,
    pack
  });
  if (!validation.valid) {
    requireNoValidationErrors(
      validation.errors,
      "Persisted message failed safety"
    );
  }
  if (persisted.browser_state === "generating") {
    const filling = nextRecord(
      persisted,
      { browser_state: "filling" },
      now
    );
    return {
      protocol_version: BROWSER_EXECUTOR_PROTOCOL_VERSION,
      proposed_record: filling,
      confirm_fields: fields,
      telemetry: {
        event: "filling_planned",
        canonical_job_id: filling.canonical_job_id,
        attempt_id: filling.browser_attempt_id
      }
    };
  }
  const authorizedValues = authorizedApplicationValues(
    persisted,
    form,
    authorizedApplyPoints
  );
  return {
    protocol_version: BROWSER_EXECUTOR_PROTOCOL_VERSION,
    capability: "fill_application_form",
    attempt_id: persisted.browser_attempt_id,
    canonical_job_id: persisted.canonical_job_id,
    job_digest: persisted.browser_job_digest,
    ...(authorizedValues.subject
      ? {
          subject: authorizedValues.subject,
          subject_digest: digest(authorizedValues.subject)
        }
      : {}),
    message: authorizedValues.message,
    message_digest: digest(authorizedValues.message),
    apply_points: authorizedApplyPoints,
    apply_points_digest: digest(String(authorizedApplyPoints))
  };
}

function requireAuthorizedFieldReceipts(record, form, fieldReceipts) {
  if (!Array.isArray(fieldReceipts) || fieldReceipts.length < 1) {
    throw new Error("Submit authorization requires bounded field reread receipts");
  }
  const requiredFields = [
    ...(formUsesSeparateSubject(form) ? ["subject"] : []),
    "message",
    "apply_points"
  ];
  const receipts = new Map();
  for (const [index, receipt] of fieldReceipts.entries()) {
    requireExactKeys(
      receipt,
      ["name", "value_digest"],
      [],
      `field reread receipt ${index}`
    );
    const name = String(receipt.name || "");
    if (
      receipts.has(name) ||
      !requiredFields.includes(name) ||
      !/^[a-f0-9]{64}$/.test(String(receipt.value_digest || ""))
    ) {
      throw new Error("Field reread receipt is duplicate, unexpected, or malformed");
    }
    receipts.set(name, receipt.value_digest);
  }
  const missing = requiredFields.filter((field) => !receipts.has(field));
  if (missing.length > 0) {
    throw new Error(`Required application fields were not reread: ${missing.join(", ")}`);
  }
  const authorizedValues = authorizedApplicationValues(
    record,
    form,
    form.apply_points
  );
  const expectedReceipts = new Map(
    requiredFields.map((field) => [field, digest(authorizedValues[field])])
  );
  for (const field of requiredFields) {
    if (receipts.get(field) !== expectedReceipts.get(field)) {
      throw new Error(`Reread value does not match the authorized ${field} value`);
    }
  }
}

export function planSubmitIntent(
  freshRecord,
  {
    form,
    field_receipts,
    profile,
    rankingPolicy,
    applicationPolicy,
    now = new Date().toISOString()
  }
) {
  now = requireTimestamp(now, "browser submit intent now");
  assertAutonomous(freshRecord);
  requireCurrentGuard(freshRecord);
  if (freshRecord.browser_state !== "filling") {
    throw new Error("Submit intent requires filling state");
  }
  if (freshRecord.browser_job_digest !== browserJobDigest(freshRecord)) {
    throw new Error("Job input changed before submit intent");
  }
  const currentEvaluation = autonomousEvaluation(
    freshRecord,
    profile,
    rankingPolicy,
    applicationPolicy,
    now
  );
  const formFingerprint = browserFormFingerprint(
    form,
    { ...freshRecord, ...currentEvaluation }
  );
  if (formFingerprint !== freshRecord.browser_form_fingerprint) {
    throw new Error("Application form changed after draft validation");
  }
  requireAuthorizedFieldReceipts(freshRecord, form, field_receipts);
  const identitySource = {
    ...freshRecord,
    browser_form_fingerprint: formFingerprint
  };
  const idempotencyKey = submissionIdempotencyKey(identitySource);
  if (idempotencyKey !== freshRecord.submission_idempotency_key) {
    throw new Error("Submission identity changed before submit intent");
  }
  const proposedRecord = nextRecord(
    freshRecord,
    {
      browser_state: "submit_started",
      browser_form_fingerprint: formFingerprint,
      submission_idempotency_key: idempotencyKey,
      submission_started_at: now,
      submission_confirmed_at: "",
      submission_confirmation_kind: "",
      submission_confirmation_reference: "",
      submission_confirmation_digest: "",
      submission_attestation_key_id: "",
      submission_attestation_witness_digest: "",
      submission_attestation_signature: ""
    },
    now
  );
  return {
    protocol_version: BROWSER_EXECUTOR_PROTOCOL_VERSION,
    source_store: AUTONOMOUS_SOURCE_STORE,
    proposed_record: proposedRecord,
    confirm_fields: SUBMIT_INTENT_CONFIRM_FIELDS,
    telemetry: {
      event: "submit_intent_planned",
      canonical_job_id: proposedRecord.canonical_job_id,
      attempt_id: proposedRecord.browser_attempt_id,
      submission_idempotency_key: idempotencyKey,
      form_fingerprint: formFingerprint
    }
  };
}

export function confirmSubmitIntent(
  plan,
  freshSourceRows,
  {
    persistedClaims,
    profile,
    rankingPolicy,
    applicationPolicy,
    packPolicy,
    runtime,
    receiptStore,
    form,
    fieldReceipts,
    now
  }
) {
  now = requireTimestamp(now, "browser submit authorization now");
  if (plan?.protocol_version !== BROWSER_EXECUTOR_PROTOCOL_VERSION) {
    throw new Error("Submit intent plan protocol is stale");
  }
  const persisted = oneIdentity(
    freshSourceRows,
    plan?.proposed_record?.canonical_job_id,
    "Submit intent confirmation"
  );
  const mismatches = exactFieldMismatches(
    plan.proposed_record,
    persisted,
    SUBMIT_INTENT_CONFIRM_FIELDS
  );
  if (mismatches.length > 0) {
    throw new Error(`Submit intent persistence mismatch: ${mismatches.join(", ")}`);
  }
  assertAutonomous(persisted);
  requireCurrentGuard(persisted);
  requireWinningBrowserClaim(persisted, persistedClaims, now, runtime);
  requireCurrentConfiguration(persisted, {
    profile,
    rankingPolicy,
    applicationPolicy,
    packPolicy
  });
  if (
    persisted.browser_state !== "submit_started" ||
    persisted.browser_job_digest !== browserJobDigest(persisted) ||
    persisted.submission_idempotency_key !== submissionIdempotencyKey(persisted)
  ) {
    throw new Error("Persisted submit intent is not click-authorizable");
  }
  if (
    browserFormFingerprint(
      form,
      {
        ...persisted,
        ...autonomousEvaluation(
          persisted,
          profile,
          rankingPolicy,
          applicationPolicy,
          now
        )
      }
    ) !==
    persisted.browser_form_fingerprint
  ) {
    throw new Error("Application form changed immediately before submit click");
  }
  requireAuthorizedFieldReceipts(persisted, form, fieldReceipts);
  const authorizationDigest = browserSubmitAuthorizationDigest(persisted);
  const consumptionReceipt = consumeSubmitAuthorizationReceipt(
    receiptStore,
    authorizationDigest,
    persisted.submission_idempotency_key,
    persisted.canonical_job_id,
    now
  );
  return {
    protocol_version: BROWSER_EXECUTOR_PROTOCOL_VERSION,
    capability: "click_application_submit_once",
    canonical_job_id: persisted.canonical_job_id,
    attempt_id: persisted.browser_attempt_id,
    job_digest: persisted.browser_job_digest,
    form_fingerprint: persisted.browser_form_fingerprint,
    submission_idempotency_key: persisted.submission_idempotency_key,
    submit_started_at: persisted.submission_started_at,
    authorization_digest: authorizationDigest,
    consumption_receipt_digest: digest(consumptionReceipt)
  };
}

function applyBrowserResult(
  freshRecord,
  result,
  now = new Date().toISOString(),
  schema,
  confirmationTrust = {},
  runtime,
  allowedSourceStates
) {
  now = requireTimestamp(now, "browser result now");
  assertAutonomous(freshRecord);
  requireCurrentGuard(freshRecord);
  requireExactKeys(
    result,
    [
      "protocol_version",
      "attempt_id",
      "job_digest",
      "result",
      "evidence"
    ],
    [
      "form_fingerprint",
      "submission_idempotency_key",
      "confirmation_kind",
      "confirmation_reference",
      "observed_source_job_id",
      "observed_canonical_url",
      "authorization_digest",
      "confirmation_attestation"
    ],
    "browser result"
  );
  if (
    result.protocol_version !== BROWSER_EXECUTOR_PROTOCOL_VERSION ||
    result.attempt_id !== freshRecord.browser_attempt_id ||
    result.job_digest !== freshRecord.browser_job_digest
  ) {
    throw new Error("Browser result identity does not match persisted state");
  }
  const requestedState = String(result.result || "");
  const afterSubmit = ["submit_started", "ambiguous"].includes(freshRecord.browser_state);
  const schemaTransitions = schema?.browser_transitions?.[freshRecord.browser_state];
  if (
    !Array.isArray(schemaTransitions) ||
    !schemaTransitions.includes(requestedState) ||
    !allowedSourceStates.has(freshRecord.browser_state) ||
    !RESULT_CATEGORIES[requestedState]
  ) {
    throw new Error("Browser result transition is not allowed from current state");
  }
  const evidence = sanitizeBrowserEvidence(result.evidence);
  if (
    !RESULT_CATEGORIES[requestedState].has(evidence.category) ||
    !evidence.observed_at ||
    Date.parse(evidence.observed_at) > Date.parse(now)
  ) {
    throw new Error("Browser result evidence does not match its lifecycle state");
  }
  if (
    requestedState !== "confirmed" &&
    [
      result.confirmation_kind,
      result.confirmation_reference,
      result.observed_source_job_id,
      result.observed_canonical_url,
      result.confirmation_attestation
    ].some((value) => String(value || "").trim())
  ) {
    throw new Error("Confirmation identity is valid only for a confirmed result");
  }
  let state = requestedState;
  let retryAt = "";
  if (requestedState === "retryable") {
    const checkedRuntime = requireBrowserRuntime(runtime);
    const attempts = Number(freshRecord.attempt_count || 0);
    if (!Number.isInteger(attempts) || attempts < 1) {
      throw new Error("Retryable browser result requires a counted attempt");
    }
    if (attempts >= checkedRuntime.retry.max_attempts) {
      state = "blocked";
    } else {
      retryAt = new Date(
        Date.parse(now) + checkedRuntime.retry.backoff_ms
      ).toISOString();
    }
  }
  const updates = {
    browser_state: state,
    browser_block_category:
      state === "blocked"
        ? evidence.category
        : "",
    error_category: state === "confirmed" ? "" : evidence.category,
    error_summary: state === "confirmed" ? "" : evidence.summary,
    processing_stage: state === "retryable" ? "browser_executor" : "",
    processing_token: "",
    processing_started_at: "",
    next_retry_at: retryAt
  };
  if (afterSubmit) {
    if (
      result.form_fingerprint !== freshRecord.browser_form_fingerprint ||
      result.submission_idempotency_key !==
        freshRecord.submission_idempotency_key ||
      result.authorization_digest !== browserSubmitAuthorizationDigest(freshRecord)
    ) {
      throw new Error("Browser result submission identity mismatch");
    }
  } else {
    updates.browser_form_fingerprint = "";
    updates.submission_idempotency_key = "";
  }
  if (state === "confirmed") {
    if (!CONFIRMATION_KINDS.has(result.confirmation_kind)) {
      throw new Error("Submission confirmation kind is unsupported");
    }
    const reference = String(result.confirmation_reference || "").trim();
    const observedPage = normalizeCanonicalUrl(result.observed_canonical_url);
    const expectedPage = normalizeCanonicalUrl(freshRecord.canonical_url);
    if (
      !/^[a-z0-9][a-z0-9._/-]{0,179}$/i.test(reference) ||
      evidence.reference_digest !== digest(reference) ||
      result.observed_source_job_id !== freshRecord.source_job_id ||
      observedPage !== expectedPage ||
      extractOnlineJobsId(observedPage) !== freshRecord.source_job_id ||
      Date.parse(evidence.observed_at) < Date.parse(freshRecord.submission_started_at)
    ) {
      throw new Error("Submission confirmation requires bounded evidence identity");
    }
    const witness = browserConfirmationWitness(freshRecord, result);
    if (
      !verifyBrowserConfirmationAttestation(
        witness,
        result.confirmation_attestation,
        confirmationTrust
      )
    ) {
      throw new Error(
        "Submission confirmation requires a trusted independent adapter attestation"
      );
    }
    Object.assign(updates, {
      submission_confirmed_at: evidence.observed_at,
      submission_confirmation_kind: result.confirmation_kind,
      submission_confirmation_reference: `confirmation-ref-v1:${digest(reference)}`,
      submission_attestation_key_id: result.confirmation_attestation.key_id,
      submission_attestation_witness_digest:
        browserConfirmationWitnessDigest(witness),
      submission_attestation_signature:
        result.confirmation_attestation.signature,
      submission_confirmation_digest: `confirmation-v1:${digest({
        canonical_job_id: freshRecord.canonical_job_id,
        attempt_id: freshRecord.browser_attempt_id,
        job_digest: freshRecord.browser_job_digest,
        form_fingerprint: freshRecord.browser_form_fingerprint,
        idempotency_key: freshRecord.submission_idempotency_key,
        confirmation_kind: result.confirmation_kind,
        observed_source_job_id: result.observed_source_job_id,
        observed_canonical_url: observedPage,
        confirmation_reference: reference,
        reference_digest: evidence.reference_digest,
        attestation_key_id: result.confirmation_attestation.key_id,
        witness_digest: browserConfirmationWitnessDigest(witness),
        confirmed_at: evidence.observed_at
      })}`,
      pipeline_status: "ready_to_apply"
    });
  }
  return requireValidProposedRecord(
    nextRecord(freshRecord, updates, now),
    schema
  );
}

export function commitBrowserResult(
  expectedRecord,
  result,
  now,
  schema,
  confirmationTrust = {},
  {
    freshSourceRows,
    persistedClaims,
    configuration,
    runtime
  } = {}
) {
  now = requireTimestamp(now, "browser result commit now");
  const persisted = requireExactFreshRecord(
    expectedRecord,
    freshSourceRows,
    schema,
    "Browser result commit"
  );
  requireWinningBrowserClaim(persisted, persistedClaims, now, runtime);
  requireResultConfiguration(persisted, configuration ?? {});
  return applyBrowserResult(
    persisted,
    result,
    now,
    schema,
    confirmationTrust,
    runtime,
    RESULT_COMMIT_STATES
  );
}

export function reconcileBrowserResult(
  expectedRecord,
  result,
  now,
  schema,
  confirmationTrust = {},
  { freshSourceRows, configuration } = {}
) {
  now = requireTimestamp(now, "browser result reconciliation now");
  const persisted = requireExactFreshRecord(
    expectedRecord,
    freshSourceRows,
    schema,
    "Browser result reconciliation"
  );
  requireResultConfiguration(persisted, configuration ?? {});
  return applyBrowserResult(
    persisted,
    result,
    now,
    schema,
    confirmationTrust,
    undefined,
    RECONCILIATION_STATES
  );
}

export function recoverBrowserRecord(
  freshRecord,
  {
    now = new Date().toISOString(),
    evidence,
    freshSourceRows,
    persistedClaims,
    configuration,
    runtime
  },
  schema
) {
  now = requireTimestamp(now, "browser recovery now");
  const checkedRuntime = requireBrowserRuntime(runtime);
  const persisted = requireExactFreshRecord(
    freshRecord,
    freshSourceRows,
    schema,
    "Browser recovery"
  );
  assertAutonomous(persisted);
  requireCurrentGuard(persisted);
  if (["submit_started", "ambiguous", "confirmed"].includes(persisted.browser_state)) {
    throw new Error("Post-submit state requires reconciliation and cannot be retried");
  }
  if (!ACTIVE_PRE_SUBMIT_STATES.has(persisted.browser_state)) {
    throw new Error("Browser record is not recoverable");
  }
  const startedAt = Date.parse(persisted.processing_started_at || "");
  if (
    !Number.isFinite(startedAt) ||
    Date.parse(now) - startedAt < checkedRuntime.claim_lease_ms ||
    hasAnyLiveBrowserClaim(persisted, persistedClaims, now)
  ) {
    throw new Error("Browser recovery requires an expired or lost claim");
  }
  const sanitized = sanitizeBrowserEvidence(evidence);
  if (!RESULT_CATEGORIES.retryable.has(sanitized.category)) {
    throw new Error("Browser recovery requires a retryable evidence category");
  }
  if (!sanitized.observed_at || Date.parse(sanitized.observed_at) > Date.parse(now)) {
    throw new Error("Browser recovery requires a current observed_at timestamp");
  }
  if (!schema?.browser_transitions?.[persisted.browser_state]?.includes("retryable")) {
    throw new Error("Browser recovery transition is not allowed by the schema");
  }
  const attempts = Number(persisted.attempt_count || 0);
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error("Browser recovery requires a counted attempt");
  }
  const retryable = attempts < checkedRuntime.retry.max_attempts;
  const state = retryable ? "retryable" : "blocked";
  const contextDigest = persisted.browser_context_digest || browserContextDigest({
    record: persisted,
    ...(configuration ?? {})
  });
  return requireValidProposedRecord(
    nextRecord(
      persisted,
      {
        browser_state: state,
        browser_context_digest: contextDigest,
        processing_stage: "",
        processing_token: "",
        processing_started_at: "",
        next_retry_at: retryable
          ? new Date(
              Date.parse(now) + checkedRuntime.retry.backoff_ms
            ).toISOString()
          : "",
        browser_form_fingerprint: "",
        submission_idempotency_key: "",
        browser_block_category: retryable ? "" : sanitized.category,
        error_category: sanitized.category,
        error_summary: sanitized.summary
      },
      now
    ),
    schema
  );
}
