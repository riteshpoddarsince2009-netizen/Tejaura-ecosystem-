# TEJAURA Append-Only Audit Logger

Records structured, validated `AuditEvent` entries (`contracts/schemas/audit-event.schema.json`) for policy decisions, approval requests, approval decisions, and security/storage failures.

---

## Storage Implementations

- `JsonlAuditStorage` — Appends single-line JSON records using `O_APPEND` (`flag: 'a'`, file mode `0600`, directory mode `0700`) without overwriting prior lines.
- `InMemoryAuditStorage` — Dependency-injected in-memory storage for deterministic unit testing.

---

## Security Controls & Limitations

1. **Directory Confinement:** `JsonlAuditStorage` rejects path traversal (`..`), symlinks, non-`.jsonl` filenames, and any directory inside public web paths (`public`, `dist`, `build`, `src`, `static`, `www`, or directories containing `index.html`).
2. **Secret Redaction:** `sanitizeAuditMetadata` strips secret-like property names (e.g., `password`, `api_key`, `bearer_token`, `private_key`, `authorization`, `jwt`) and masks raw token formats before schema validation and disk writes.
3. **Fail-Closed Policy Integration:** `evaluatePolicyWithAudit` denies authorization (`AUDIT_STORAGE_FAILURE`) whenever audit persistence fails.
4. **Honest Limitation (Not Cryptographically Tamper-Proof):** Local append-only JSONL prevents accidental application-level overwrites, but it is **not** cryptographically tamper-proof. A privileged local OS user or compromised host process with filesystem access can modify or delete local log files.
