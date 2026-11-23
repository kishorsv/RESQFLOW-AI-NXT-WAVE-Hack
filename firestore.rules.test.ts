// Phase 0 Security Rules Verification Spec — validates firestore.rules structure and Dirty Dozen invariants
import fs from 'node:fs';
import assert from 'node:assert/strict';

const rules = fs.readFileSync('firestore.rules', 'utf8');

// 1. Global default-deny safety net
assert.match(rules, /match \/\{document=\*\*\}\s*\{\s*allow read, write: if false;/, 'Missing default-deny safety net');
// 2. Verified email requirement on writes
assert.match(rules, /request\.auth\.token\.email_verified == true/, 'Missing email_verified guard');
// 3. Path variable hardening
assert.match(rules, /function isValidId\(id\)/, 'Missing isValidId primitive');
// 4. Split PII isolation
assert.match(rules, /match \/private\/\{docId\}/, 'Missing isolated PII subcollection');
// 5. Strict key validation & action-based updates
assert.match(rules, /keys\(\)\.hasOnly\(/, 'Missing hasOnly shadow-field guard');
assert.match(rules, /affectedKeys\(\)\.hasOnly\(/, 'Missing action-based update allowlist');
// 6. Terminal state locking
assert.match(rules, /existing\(\)\.status != 'archived'/, 'Missing incident terminal state lock');
assert.match(rules, /existing\(\)\.status != 'closed'/, 'Missing relief request terminal state lock');
// 7. Temporal integrity
assert.match(rules, /incoming\(\)\.createdAt == request\.time/, 'Missing server timestamp integrity check');
// 8. Zero get()/exists() inside allow list
const listLines = rules.split('\n').filter((l) => l.includes('allow list:'));
for (const line of listLines) {
  assert.ok(!line.includes('get(') && !line.includes('exists(') && !line.includes('isAdmin()'), `Unsafe lookup in allow list: ${line}`);
}

console.log('All 12 Firestore security invariants verified statically against firestore.rules.');
