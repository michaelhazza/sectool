// BS-XSS-001 clean fixture: user-supplied HTML sanitized before rendering
// All user content is passed through sanitizeHtml before being sent.

import express from 'express';

const router = express.Router();

// Simulated sanitize-html import (the real package would be imported)
function sanitizeHtml(input: string): string {
  return input.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Safe: content is sanitized before being sent
router.post('/api/comments', (req, res) => {
  const raw = req.body.content;
  const content = sanitizeHtml(raw);
  res.send(`<div class="comment">${content}</div>`);
});

// Safe: message is sanitized before being sent
router.get('/api/preview', (req, res) => {
  const raw = req.query.message as string;
  const message = sanitizeHtml(raw);
  res.send(message);
});

export default router;
