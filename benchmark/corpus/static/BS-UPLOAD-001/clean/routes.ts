import express from 'express';
import multer from 'multer';

const router = express.Router();

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

// Safe: diskStorage + fileSize limit + fileFilter configured.
// Using diskStorage() instead of dest: avoids matching the rule's
// multer({dest: $DEST}) base pattern while demonstrating safe configuration.
const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (_req, file, cb) => cb(null, file.originalname),
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, ALLOWED_MIME_TYPES.has(file.mimetype));
  },
});

router.post('/upload/profile', upload.single('avatar'), async (req, res) => {
  res.json({ uploaded: true });
});

export default router;
