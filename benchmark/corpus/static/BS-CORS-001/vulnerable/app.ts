import express from 'express';
import cors from 'cors';

const app = express();

// Vulnerable: wildcard CORS origin
app.use(cors({ origin: '*' }));

// Vulnerable: reflected origin — allows any origin
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

// Vulnerable: origin callback reflecting back whatever origin is sent
app.use(
  cors({
    origin: (origin, cb) => cb(null, origin),
  }),
);

export default app;
