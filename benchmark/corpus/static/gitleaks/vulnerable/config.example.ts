// Gitleaks vulnerable fixture — hardcoded secrets for recall test.
// INTENTIONALLY VULNERABLE: these are seeded test values, not real credentials.
// This file exists only for the benchmark corpus; the values are fictitious.

// Gitleaks detects hardcoded private key headers (high-confidence rule)
export const privateKey = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAzRTBenchmarkFixtureTestOnlyNotARealKeyXXXXXXXXXXXX
XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
-----END RSA PRIVATE KEY-----`;

// Gitleaks also detects high-entropy strings in password variable assignments
export const dbPassword = 'xK9#mP2$vQ7!nL4@hR1^wF6&jT3*bN8';
