// BS-XSS-001 vulnerable fixture: user-supplied HTML rendered without sanitize-html
// User content from req.body is sent directly in the HTTP response as HTML.

import express from 'express';

const router = express.Router();

// Vulnerable: req.body.content sent directly via res.send() without sanitization
router.post('/api/comments', (req, res) => {
  const content = req.body.content;
  res.send(`<div class="comment">${content}</div>`);
});

// Vulnerable: req.query.message assigned to a local var then sent without sanitization
router.get('/api/preview', (req, res) => {
  const message = req.query.message;
  res.send(message);
});

export default router;
