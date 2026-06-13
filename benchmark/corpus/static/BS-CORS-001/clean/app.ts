import express from 'express';
import cors from 'cors';

const app = express();

const ALLOWED_ORIGINS = new Set([
  'https://staging.example.com',
  'https://app.example.com',
]);

// Safe: explicit allowlist of origins
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || ALLOWED_ORIGINS.has(origin)) {
        cb(null, true);
      } else {
        cb(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
  }),
);

export default app;
