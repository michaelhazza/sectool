import express from 'express';
import multer from 'multer';

const router = express.Router();

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

// Safe: both fileSize limit and fileFilter configured
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, ALLOWED_MIME_TYPES.has(file.mimetype));
  },
});

router.post('/upload/profile', upload.single('avatar'), async (req, res) => {
  res.json({ uploaded: true });
});

export default router;
