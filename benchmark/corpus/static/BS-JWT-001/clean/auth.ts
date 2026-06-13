import jwt from 'jsonwebtoken';

// Safe: algorithm pinned, expiry set, secret from environment variable
function signToken(userId: string): string {
  const secret = process.env['JWT_SECRET'];
  if (!secret) throw new Error('JWT_SECRET not set');
  return jwt.sign({ sub: userId }, secret, { algorithm: 'HS256', expiresIn: '15m' });
}

// Safe: verify with algorithms array pinned, secret from environment
function verifyToken(token: string): unknown {
  const secret = process.env['JWT_SECRET'];
  if (!secret) throw new Error('JWT_SECRET not set');
  return jwt.verify(token, secret, { algorithms: ['HS256'] });
}

export { signToken, verifyToken };
