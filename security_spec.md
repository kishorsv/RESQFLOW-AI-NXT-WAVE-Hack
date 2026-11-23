# RESQFLOW AI — Firestore Security Specification (Phase 0 TDD)

## 1. Data Invariants
1. **Default Deny**: Every unmatched path is denied (`allow read, write: if false;`).
2. **Verified Identity & Anti-Spoofing**: All write operations require `request.auth != null && request.auth.token.email_verified == true`. Author/owner IDs (`ownerId`, `userId`, `uid`) must strictly match `request.auth.uid`.
3. **Self-Role Escalation Prevention**: Users creating their own `/users/{userId}` document are restricted to non-privileged default roles (`field_responder` or `citizen_reporter`) unless they are already an authorized admin (`isAdmin()`). Users cannot self-escalate `role` via updates.
4. **PII Isolation (Split Collection)**: Sensitive PII (`email`, `phone`) is stored exclusively in `/users/{userId}/private/{docId}` and restricted strictly to `isOwner(userId) || isAdmin()`.
5. **Path Variable Hardening**: Every single-document operation (`get`, `create`, `update`, `delete`) validates document IDs via `isValidId(id)` (`^[a-zA-Z0-9_\-]+$`, max 128 chars).
6. **Temporal Integrity & Immutability**: `createdAt` must equal `request.time` on create and remain immutable on update. `updatedAt` must equal `request.time` on update. `ownerId` and `id` are immutable after creation.
7. **Terminal State Locking**: Once an incident reaches `archived` or a relief request reaches `closed`, non-admin updates are blocked.
8. **Secure List Queries**: Every `allow list` rule enforces `resource.data.ownerId == request.auth.uid` (or `userId == request.auth.uid` / `isAdmin()`) with zero `get()`/`exists()` inside `allow list`.
9. **Action-Based Updates & Strict Keys**: Every `create` enforces `hasAll` + `hasOnly`; every `update` starts with `isValid[Entity](incoming())` and restricts mutated fields via `affectedKeys().hasOnly(...)`.

## 2. The "Dirty Dozen" Adversarial Payloads (Must All Fail with PERMISSION_DENIED)
1. **Shadow Field Injection on Incident Create**: `{ ..., "isVerifiedByRoot": true }` -> Blocked by `keys().hasOnly(...)`.
2. **Identity Spoofing on Field Note Create**: `{ "ownerId": "victim_uid", ... }` by attacker -> Blocked by `data.ownerId == request.auth.uid`.
3. **Self-Privilege Escalation on Profile Create**: `{ "uid": "attacker", "role": "super_admin", ... }` -> Blocked by default role allowlist.
4. **Role Escalation via Profile Update**: `update({ role: "super_admin" })` -> Blocked by `affectedKeys().hasOnly(['displayName', 'updatedAt'])`.
5. **PII Cross-User Read**: Attacker attempts `get(/users/victim_uid/private/info)` -> Blocked by `isOwner(userId) || isAdmin()`.
6. **ID Poisoning (1.5KB Junk Doc ID)**: `setDoc(doc(db, 'field_notes', 'A'.repeat(1500)), ...)` -> Blocked by `isValidId(noteId)`.
7. **Timestamp Forgery**: `create({ ..., createdAt: Timestamp(2020-01-01) })` -> Blocked by `incoming().createdAt == request.time`.
8. **Immutable Owner Tampering**: `update({ ownerId: "other_uid" })` -> Blocked by `incoming().ownerId == existing().ownerId`.
9. **Terminal State Bypass**: Non-admin updates an `archived` incident -> Blocked by `existing().status != 'archived'`.
10. **Value Poisoning on Update**: Update `title` with a 50KB string or boolean -> Blocked by `isValidIncident(incoming())` wrapping `allow update`.
11. **Unverified Email Spoof**: Token has admin email string but `email_verified: false` -> Blocked by `request.auth.token.email_verified == true`.
12. **Blanket Collection Scraping**: Unfiltered `list` on `/incidents` for other owners' documents -> Blocked by `resource.data.ownerId == request.auth.uid || isAdmin()`.
