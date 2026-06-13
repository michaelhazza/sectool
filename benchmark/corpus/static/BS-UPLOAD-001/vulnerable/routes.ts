import express from 'express';
import multer from 'multer';

const router = express.Router();

// Vulnerable: no fileSize limit and no fileFilter
const uploadNoLimits = multer({ dest: 'uploads/' });

// Vulnerable: has dest but no limits or fileFilter
router.post('/upload/profile', uploadNoLimits.single('avatar'), async (req, res) => {
  res.json({ uploaded: true });
});

// Vulnerable: limits present but no fileFilter
const uploadNoTypeFilter = multer({
  dest: 'uploads/',
  limits: { fileSize: 10 * 1024 * 1024 },
});

router.post('/upload/document', uploadNoTypeFilter.single('file'), async (req, res) => {
  res.json({ uploaded: true });
});

export default router;
