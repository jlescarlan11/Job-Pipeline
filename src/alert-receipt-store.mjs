import {
  ALERT_RECEIPT_PERSISTED_FIELDS,
  alertReceiptDataTableSchema,
  alertReceiptId,
  alertReceiptPersistenceRow,
  normalizeAlertReceipt,
  transitionAlertReceipt,
  validateAlertReceipt,
  validateAlertReceiptPolicy
} from "./alert-receipts.mjs";

function assertBackend(backend) {
  for (const method of [
    "getAllById",
    "createIfAbsent",
    "compareAndSwap",
    "listByStatus"
  ]) {
    if (typeof backend?.[method] !== "function") {
      throw new Error(`Alert receipt backend is missing ${method}`);
    }
  }
}

function assertValidStoredReceipt(receipt, policy, prefix) {
  const errors = validateAlertReceipt(receipt, policy);
  if (errors.length > 0) {
    throw new Error(`${prefix}: ${errors.join("; ")}`);
  }
}

function assertSamePersistedReceipt(expected, actual, prefix) {
  for (const field of ALERT_RECEIPT_PERSISTED_FIELDS) {
    if (actual[field] !== expected[field]) {
      throw new Error(`${prefix}: persisted ${field} does not match the requested value`);
    }
  }
}

export function createAlertReceiptPersistenceAdapter(backend, policy) {
  assertBackend(backend);
  const policyErrors = validateAlertReceiptPolicy(policy);
  if (policyErrors.length > 0) {
    throw new Error(`Invalid alert receipt policy: ${policyErrors.join("; ")}`);
  }
  const get = async (receiptId) => {
    const id = alertReceiptId(receiptId, policy);
    const rows = await backend.getAllById(id);
    if (!Array.isArray(rows)) {
      throw new Error("Receipt backend identity query must return an array");
    }
    if (rows.length > 1) {
      throw new Error("Receipt backend returned duplicate current receipts");
    }
    if (rows.length === 0) return null;
    const receipt = normalizeAlertReceipt(rows[0], policy);
    assertValidStoredReceipt(receipt, policy, "Receipt backend returned invalid data");
    return receipt;
  };
  return {
    get,

    async create(receiptInput) {
      const receipt = normalizeAlertReceipt(receiptInput, policy);
      assertValidStoredReceipt(receipt, policy, "Refusing to create invalid receipt");
      const current = await get(receipt.receipt_id);
      if (current) {
        if (
          current.idempotency_key !== receipt.idempotency_key ||
          current.canonical_job_id !== receipt.canonical_job_id
        ) {
          throw new Error("Receipt identity already belongs to another delivery");
        }
        return { receipt: current, created: false };
      }
      const inserted = await backend.createIfAbsent(
        alertReceiptPersistenceRow(receipt, policy)
      );
      if (inserted !== true && inserted !== false) {
        throw new Error("Receipt create-if-absent must return a boolean result");
      }
      if (inserted === false) {
        const winner = await get(receipt.receipt_id);
        if (!winner) {
          throw new Error("Receipt insert lost without a persisted winner");
        }
        if (
          winner.idempotency_key !== receipt.idempotency_key ||
          winner.canonical_job_id !== receipt.canonical_job_id
        ) {
          throw new Error("Concurrent receipt creation produced an identity conflict");
        }
        return { receipt: winner, created: false };
      }
      const persisted = await get(receipt.receipt_id);
      if (!persisted) {
        throw new Error("Receipt insert was not durably readable");
      }
      assertSamePersistedReceipt(
        receipt,
        persisted,
        "Receipt insert verification failed"
      );
      return { receipt: persisted, created: true };
    },

    async transition(receiptId, change) {
      const current = await get(receiptId);
      if (!current) throw new Error("Alert receipt does not exist");
      const next = transitionAlertReceipt(current, change, policy);
      const updated = await backend.compareAndSwap(
        current.receipt_id,
        change.expectedVersion,
        alertReceiptPersistenceRow(next, policy)
      );
      if (updated !== true) {
        throw new Error("Alert receipt compare-and-swap rejected stale transition");
      }
      const persisted = await get(current.receipt_id);
      if (!persisted) {
        throw new Error("Alert receipt transition was not durably readable");
      }
      assertSamePersistedReceipt(
        next,
        persisted,
        "Receipt transition verification failed"
      );
      return persisted;
    },

    async listDelivered() {
      const rows = await backend.listByStatus("delivered");
      if (!Array.isArray(rows)) {
        throw new Error("Receipt backend delivered query must return an array");
      }
      const receipts = rows.map((row) => normalizeAlertReceipt(row, policy));
      const identities = new Set();
      for (const receipt of receipts) {
        assertValidStoredReceipt(
          receipt,
          policy,
          "Receipt backend returned invalid delivered data"
        );
        if (receipt.status !== "delivered") {
          throw new Error("Receipt backend delivered query returned another status");
        }
        if (identities.has(receipt.receipt_id)) {
          throw new Error("Receipt backend returned duplicate current receipts");
        }
        identities.add(receipt.receipt_id);
        const current = await get(receipt.receipt_id);
        if (!current || current.status !== "delivered") {
          throw new Error("Receipt backend delivered query returned stale data");
        }
        assertSamePersistedReceipt(
          receipt,
          current,
          "Receipt delivered query verification failed"
        );
      }
      return receipts;
    }
  };
}

export function n8nReceiptDataTableMutation(receiptInput, expectedVersion, policy) {
  const receipt = alertReceiptPersistenceRow(receiptInput, policy);
  const updating = Number.isInteger(expectedVersion);
  return {
    table_environment_variable: policy.store.environment_variable,
    operation: updating ? "update" : "upsert",
    match: {
      receipt_id: receipt.receipt_id,
      ...(updating
        ? { receipt_version: expectedVersion }
        : {})
    },
    values: receipt,
    require_atomic_create_if_absent: !updating,
    require_exactly_one_match: updating,
    postcondition: {
      receipt_id: receipt.receipt_id,
      exact_row_count: 1,
      receipt_version: receipt.receipt_version
    }
  };
}

export function alertReceiptDataTableProvisioningPlan(policy) {
  const errors = validateAlertReceiptPolicy(policy);
  if (errors.length > 0) {
    throw new Error(`Invalid alert receipt policy: ${errors.join("; ")}`);
  }
  return {
    store_kind: "n8n_data_table",
    table_name: policy.store.table_name,
    table_environment_variable: policy.store.environment_variable,
    create_only_when_missing: true,
    require_exact_existing_schema: true,
    business_sheet_schema_mutation: false,
    columns: alertReceiptDataTableSchema(),
    write_contract: {
      create: "atomic_upsert_by_receipt_id",
      transition: "compare_and_swap_by_receipt_id_and_receipt_version",
      reread_after_every_write: true,
      reject_duplicate_identity_rows: true
    },
    retention: { ...policy.retention }
  };
}

export function validateAlertReceiptRows(rows, policy) {
  const errors = validateAlertReceiptPolicy(policy);
  if (errors.length > 0) return errors;
  if (!Array.isArray(rows)) {
    return ["alert receipt Data Table rows must be an array"];
  }
  const identities = new Set();
  const allowedFields = new Set([
    ...ALERT_RECEIPT_PERSISTED_FIELDS,
    "id",
    "createdAt",
    "updatedAt"
  ]);
  rows.forEach((row, index) => {
    for (const field of Object.keys(row || {})) {
      if (!allowedFields.has(field)) {
        errors.push(`row ${index + 1}: unexpected persisted field ${field}`);
      }
    }
    const receipt = normalizeAlertReceipt(row, policy);
    for (const error of validateAlertReceipt(receipt, policy)) {
      errors.push(`row ${index + 1}: ${error}`);
    }
    if (receipt.receipt_id) {
      if (identities.has(receipt.receipt_id)) {
        errors.push(`row ${index + 1}: duplicate current receipt identity`);
      }
      identities.add(receipt.receipt_id);
    }
  });
  return [...new Set(errors)];
}

export function validateAlertReceiptDataTableSnapshot(snapshot, policy) {
  const errors = validateAlertReceiptPolicy(policy);
  if (errors.length > 0) return errors;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return [...errors, "alert receipt Data Table snapshot must be an object"];
  }
  const tableId = String(snapshot.id || snapshot.table_id || "").trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(tableId)) {
    errors.push("alert receipt Data Table ID is missing or invalid");
  }
  if (String(snapshot.name || "").trim() !== policy.store.table_name) {
    errors.push("alert receipt Data Table name does not match policy");
  }
  const expectedColumns = alertReceiptDataTableSchema();
  const columns = Array.isArray(snapshot.columns) ? snapshot.columns : [];
  if (columns.length !== expectedColumns.length) {
    errors.push("alert receipt Data Table column count does not match policy");
  }
  for (const [index, expected] of expectedColumns.entries()) {
    const actual = columns[index];
    if (actual?.name !== expected.name || actual?.type !== expected.type) {
      errors.push(
        `alert receipt Data Table column ${index + 1} must be ${expected.name}:${expected.type}`
      );
    }
  }
  if (!Array.isArray(snapshot.rows)) {
    errors.push("alert receipt Data Table snapshot must include all rows");
  } else {
    errors.push(...validateAlertReceiptRows(snapshot.rows, policy));
  }
  return [...new Set(errors)];
}
