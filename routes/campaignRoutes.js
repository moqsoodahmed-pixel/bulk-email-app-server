import { Router } from 'express';
import multer from 'multer';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import {
  listCompanies,
  accountStatus,
  brevoStatus,
  listStates,
  blastedStates,
  manualMarkBlasted,
  manualUnmarkBlasted,
  previewCount,
  testSend,
  listCampaigns,
  createAndSendCampaign,
  stopCampaign,
  getCampaign,
  deleteCampaign,
} from '../controllers/campaignController.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const ok = ['application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(file.mimetype);
    cb(null, ok);
  },
});

function handleUpload(req, res, next) {
  upload.single('attachment')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}

router.use(requireAuth, requireAdmin);

router.get('/companies',       listCompanies);
router.get('/account-status',  accountStatus);
router.get('/brevo-status',    brevoStatus);
router.get('/states',          listStates);
router.get('/blasted-states',  blastedStates);
router.post('/manual-blast',   manualMarkBlasted);
router.delete('/manual-blast', manualUnmarkBlasted);
router.get('/preview-count',   previewCount);
router.post('/test',           handleUpload, testSend);

router.get('/',                listCampaigns);
router.post('/',               handleUpload, createAndSendCampaign);
router.get('/:id',             getCampaign);
router.post('/:id/stop',       stopCampaign);
router.delete('/:id',          deleteCampaign);

export default router;