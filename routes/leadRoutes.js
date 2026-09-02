import { Router } from 'express';
import multer from 'multer';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import {
  previewImport,
  importLeads,
  getLeads,
  deleteLead,
  bulkDeleteLeads,
} from '../controllers/leadController.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'text/csv',
      'text/plain',
      'application/csv',
      'application/octet-stream',
    ];
    if (allowed.includes(file.mimetype) || file.originalname.match(/\.(xlsx|xls|csv)$/i)) {
      cb(null, true);
    } else {
      cb(new Error('Only .xlsx, .xls, and .csv files are accepted.'));
    }
  },
});

router.use(requireAuth, requireAdmin);

// Phase 3: preview before committing
router.post('/preview', upload.single('file'), previewImport);

router.post('/import', upload.single('file'), importLeads);
router.get('/', getLeads);
router.delete('/bulk', bulkDeleteLeads);
router.delete('/:id', deleteLead);

export default router;
