import jwt from 'jsonwebtoken';

const STATIC_SECRET = 'super-secret-key-do-not-use';

// Vulnerable: algorithm not pinned — omitting algorithm option
function signTokenNoAlgorithm(userId: string): string {
  return jwt.sign({ sub: userId }, process.env['JWT_SECRET'] ?? 'fallback');
}

// Vulnerable: no expiry set
function signTokenNoExpiry(userId: string): string {
  return jwt.sign({ sub: userId }, process.env['JWT_SECRET'] ?? 'fallback', { algorithm: 'HS256' });
}

// Vulnerable: secret is a string literal
function signTokenLiteralSecret(userId: string): string {
  return jwt.sign({ sub: userId }, STATIC_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
}

// Vulnerable: verify without pinning algorithms
function verifyTokenNoAlgorithm(token: string): unknown {
  return jwt.verify(token, process.env['JWT_SECRET'] ?? 'fallback');
}

export { signTokenNoAlgorithm, signTokenNoExpiry, signTokenLiteralSecret, verifyTokenNoAlgorithm };
