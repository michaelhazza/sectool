// Gitleaks vulnerable fixture — hardcoded secret for recall test.
// INTENTIONALLY VULNERABLE: hardcoded credentials seeded for gitleaks detection.
// These are NOT real credentials — this file exists only for the benchmark corpus.

// Gitleaks detects this as a generic-api-key (high entropy + variable naming pattern)
export const PASSWORD = 'Sup3rS3cr3tP@ssw0rd!XyZ#2026';

// Gitleaks detects this as a private key header pattern
export const PRIVATE_KEY_HEADER = '-----BEGIN RSA PRIVATE KEY-----';
