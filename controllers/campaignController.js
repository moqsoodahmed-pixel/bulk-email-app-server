import Lead     from '../models/Lead.js';
import Campaign  from '../models/Campaign.js';
import BlastLog  from '../models/BlastLog.js';

// ---------------------------------------------------------------------------
// Stop-signal map
// ---------------------------------------------------------------------------
const stopSignals = new Map();

// ---------------------------------------------------------------------------
// Company config — 2 Brevo keys for Launcherdesk, 1 for Officerestore
// ---------------------------------------------------------------------------
const COMPANY_CONFIG = {
  launcherdesk: {
    label:     'Launcherdesk',
    domain:    'launcherdesk.net',
    fromEmail: () => process.env.LAUNCHERDESK_FROM_EMAIL || 'sneha@launcherdesk.net',
    fromName:  () => process.env.LAUNCHERDESK_FROM_NAME  || 'Sneha',
    address:   'Launcherdesk, Bengaluru, Karnataka 560001, India',
    // 2 Brevo accounts = 600 emails/month
    apiKeys: () => [
      process.env.LD_BREVO_KEY_1,
      process.env.LD_BREVO_KEY_2,
      process.env.LD_BREVO_KEY_3, // add a 3rd Brevo account → 900 emails/month
    ].filter((k) => k && k.length > 10 && !k.includes('YOUR_')),
  },
  officerestore: {
    label:     'Officerestore',
    domain:    'officerestore.in',
    fromEmail: () => process.env.OFFICERESTORE_FROM_EMAIL || 'sneha@officerestore.in',
    fromName:  () => process.env.OFFICERESTORE_FROM_NAME  || 'Sneha',
    address:   'Officerestore, Bengaluru, Karnataka 560001, India',
    // 1 Brevo account = 300 emails/month
    apiKeys: () => [
      process.env.OR_BREVO_KEY_1,
      process.env.OR_BREVO_KEY_2, // 2nd Brevo account → 600 emails/month total
    ].filter((k) => k && k.length > 10 && !k.includes('YOUR_')),
  },
};

function getCfg(key) {
  return COMPANY_CONFIG[key] || COMPANY_CONFIG.launcherdesk;
}

// ---------------------------------------------------------------------------
// Brevo account pool — fetches LIVE quota before sending, rotates automatically
// ---------------------------------------------------------------------------
class BrevoPool {
  constructor(accounts) {
    // accounts = [{ key, index, remaining, exhausted }] — built by BrevoPool.create()
    this.accounts = accounts;
    // Start on first non-exhausted account
    this.current = 0;
    while (this.current < this.accounts.length && this.accounts[this.current].exhausted) {
      this.current++;
    }
  }

  // Factory: fetches live quota for every key so we start with real numbers
  static async create(apiKeys) {
    const accounts = await Promise.all(
      apiKeys.map(async (key, i) => {
        const quota = await fetchQuota(key);
        const remaining = quota ? quota.remaining : 300;
        const exhausted = remaining <= 0;
        console.log(`[pool] Account ${i + 1}: ${remaining} emails remaining (live from Brevo)`);
        return { key, index: i + 1, remaining, exhausted };
      })
    );
    return new BrevoPool(accounts);
  }

  get totalAccounts() { return this.accounts.length; }

  active() {
    while (this.current < this.accounts.length) {
      if (!this.accounts[this.current].exhausted) return this.accounts[this.current];
      this.current++;
    }
    return null; // all exhausted
  }

  // Returns the first account that has quota — used for one-off sends like testSend
  firstAvailable() {
    return this.accounts.find((a) => !a.exhausted && a.remaining > 0) || null;
  }

  markSent() {
    const acc = this.accounts[this.current];
    if (!acc) return;
    acc.remaining = Math.max(0, acc.remaining - 1);
    if (acc.remaining === 0) {
      acc.exhausted = true;
      this.current++;
      const next = this.active();
      if (next) console.log(`[pool] Account ${acc.index} quota done → switching to Account ${next.index}`);
      else       console.log('[pool] All accounts exhausted.');
    }
  }

  markExhausted() {
    const acc = this.accounts[this.current];
    if (!acc) return;
    console.log(`[pool] Account ${acc.index} quota hit by Brevo — switching.`);
    acc.exhausted = true;
    acc.remaining = 0;
    this.current++;
  }

  summary() {
    return this.accounts.map((a) =>
      `Account ${a.index}: ${a.exhausted ? 'exhausted' : a.remaining + ' left'}`
    ).join(' | ');
  }
}

// ---------------------------------------------------------------------------
// Fetch live quota for a Brevo key
// ---------------------------------------------------------------------------
async function fetchQuota(apiKey) {
  try {
    const res  = await fetch('https://api.brevo.com/v3/account', {
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return null;
    const plan = (body.plan || []).find((p) => p.credits != null);
    if (plan) return { total: plan.credits, used: plan.creditsUsed || 0, remaining: plan.credits - (plan.creditsUsed || 0) };
    return null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------
function toText(raw) {
  return raw
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function personalise(tmpl, { name = '', company = '', email = '' }) {
  return tmpl
    .replace(/\{\{name\}\}/gi, name)
    .replace(/\{\{company\}\}/gi, company)
    .replace(/\{\{email\}\}/gi, email);
}

// ---------------------------------------------------------------------------
// Brevo API call
// ---------------------------------------------------------------------------
async function brevoReq(apiKey, path, method = 'GET', payload = null) {
  if (!apiKey) throw new Error('Brevo API key not set.');
  const opts = { method, headers: { 'Content-Type': 'application/json', 'api-key': apiKey } };
  if (payload) opts.body = JSON.stringify(payload);
  const res  = await fetch(`https://api.brevo.com/v3${path}`, opts);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, body };
}

// ---------------------------------------------------------------------------
// Build unsubscribe URL (one-click opt-out stored in DB via lead status update)
// ---------------------------------------------------------------------------
function buildUnsubLink(email, fromEmail) {
  // Simple mailto unsubscribe — no backend needed, universally accepted
  const subject = encodeURIComponent('Unsubscribe');
  const body    = encodeURIComponent(`Please remove ${email} from your mailing list.`);
  return `mailto:${fromEmail}?subject=${subject}&body=${body}`;
}

// ---------------------------------------------------------------------------
// Build CAN-SPAM / Gmail-compliant HTML email
// ---------------------------------------------------------------------------
function buildHtml(plainBody, fromEmail, fromName, recipientEmail, companyAddress) {
  // Escape HTML entities in plain text lines, preserve line breaks
  const lines = plainBody.split('\n');
  const bodyHtml = lines.map((line) => {
    if (line.trim() === '') return '<br>';
    const escaped = line
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<p style="margin:0 0 4px 0">${escaped}</p>`;
  }).join('\n');

  const unsubLink = buildUnsubLink(recipientEmail, fromEmail);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Email</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:20px 0">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:4px;overflow:hidden;max-width:600px">
        <!-- Body -->
        <tr><td style="padding:30px 30px 20px 30px;font-size:14px;line-height:1.8;color:#222222">
          ${bodyHtml}
        </td></tr>
        <!-- CAN-SPAM footer (REQUIRED by law and Gmail policy) -->
        <tr><td style="padding:16px 30px;background:#f9f9f9;border-top:1px solid #eeeeee;font-size:11px;color:#888888;text-align:center">
          <p style="margin:0 0 4px 0">You received this email because your business was recently registered.</p>
          <p style="margin:0 0 4px 0">${companyAddress}</p>
          <p style="margin:0">
            <a href="${unsubLink}" style="color:#888888;text-decoration:underline">Unsubscribe</a>
            &nbsp;|&nbsp;
            <a href="mailto:${fromEmail}" style="color:#888888;text-decoration:underline">Contact us</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

async function sendViaBrevo({ to, toName, subject, htmlBody, fromEmail, fromName, replyTo, attachment, apiKey, companyAddress }) {
  const plain = toText(htmlBody);
  const unsubLine = `\n\n---\nTo unsubscribe reply with "unsubscribe" or email ${fromEmail}\n${companyAddress || ''}`;
  const plainWithFooter = plain + unsubLine;

  // Render as a plain personal email — no containers, no styling, no borders.
  // Looks identical to what a person would type in Gmail. This is the #1 signal for Primary inbox.
  const lines = plain.split('\n');
  const bodyHtml = lines.map((line) => {
    if (line.trim() === '') return '<br>';
    const escaped = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<p style="margin:0 0 8px 0">${escaped}</p>`;
  }).join('\n');
  const unsubUrl = `mailto:${replyTo || fromEmail}?subject=Unsubscribe&body=Please remove me from your list`;
  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:16px;font-family:Arial,sans-serif;font-size:14px;line-height:1.7;color:#000000">
${bodyHtml}
<p style="margin:24px 0 0 0;font-size:11px;color:#999999">
  ${companyAddress || ''} &nbsp;|&nbsp;
  <a href="${unsubUrl}" style="color:#999999">Unsubscribe</a>
</p>
</body>
</html>`;

  const payload = {
    sender:      { name: fromName, email: fromEmail },
    to:          [{ email: to, name: toName || to }],
    subject,
    htmlContent: html,
    textContent: plainWithFooter,
    ...(replyTo ? { replyTo: { email: replyTo, name: fromName } } : {}),
    headers: {
      'List-Unsubscribe':      `<mailto:${replyTo || fromEmail}?subject=unsubscribe>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      'X-Entity-Ref-ID':       `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    },
    // No tags or category — avoids Brevo marking as 'marketing' which triggers Gmail Promotions
  };

  if (attachment && attachment.data && attachment.filename) {
    payload.attachment = [{ name: attachment.filename, content: attachment.data }];
  }

  const { ok, status, body } = await brevoReq(apiKey, '/smtp/email', 'POST', payload);
  if (!ok) {
    const detail = body.message || body.error || JSON.stringify(body);
    throw new Error(`Brevo ${status}: ${detail}`);
  }
  return body;
}

// ---------------------------------------------------------------------------
// Lead filter builder
// ---------------------------------------------------------------------------
function buildFilter(tf = {}) {
  const f = {};
  const s = tf.status || 'active';
  if (s !== 'all') f.status = s;
  if (tf.importBatch) f.importBatch = tf.importBatch;
  if (tf.state) {
    const arr = Array.isArray(tf.state) ? tf.state.filter(Boolean) : [tf.state].filter(Boolean);
    if (arr.length > 0) {
      f.state = { $in: arr.map((x) => new RegExp(`^${x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')) };
    }
  }
  if (tf.search) {
    const re = new RegExp(tf.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    f.$or = [{ email: re }, { name: re }, { company: re }];
  }
  return f;
}

// ---------------------------------------------------------------------------
// GET /api/campaigns/diagnose?company=launcherdesk
// ---------------------------------------------------------------------------
export async function diagnose(req, res) {
  const key = req.query.company || 'launcherdesk';
  const cfg = getCfg(key);
  const keys = cfg.apiKeys();
  const fromEmail = cfg.fromEmail();
  const results = [];

  for (let i = 0; i < keys.length; i++) {
    const apiKey = keys[i];
    const entry = { account: i + 1, apiKeyOk: false, senderVerified: false, quota: null, errors: [] };

    try {
      const { ok, body, status } = await brevoReq(apiKey, '/account');
      if (!ok) {
        entry.errors.push(`API key invalid: ${status} — ${body.message || JSON.stringify(body)}`);
      } else {
        entry.apiKeyOk = true;
        const plan = (body.plan || []).find((p) => p.credits != null);
        if (plan) entry.quota = { total: plan.credits, used: plan.creditsUsed || 0, remaining: plan.credits - (plan.creditsUsed || 0) };
      }
    } catch (e) {
      entry.errors.push(`Account check failed: ${e.message}`);
    }

    if (entry.apiKeyOk) {
      try {
        const { ok, body } = await brevoReq(apiKey, '/senders');
        if (ok) {
          const senders = body.senders || [];
          const match = senders.find((s) => s.email?.toLowerCase() === fromEmail.toLowerCase());
          if (!match) {
            entry.errors.push(`Sender "${fromEmail}" NOT found in Brevo. Add it at: Brevo → Senders & IPs → Senders → Add a New Sender`);
          } else if (!match.active) {
            entry.errors.push(`Sender "${fromEmail}" found but NOT active/verified. Check inbox for Brevo's verification email.`);
          } else {
            entry.senderVerified = true;
          }
        }
      } catch (e) {
        entry.errors.push(`Sender check failed: ${e.message}`);
      }
    }

    results.push(entry);
  }

  const allOk = results.every((r) => r.apiKeyOk && r.senderVerified);
  res.json({
    company: key, label: cfg.label, fromEmail,
    allOk,
    accounts: results,
    summary: allOk ? '✅ All OK' : '❌ Issues found — see errors field.',
  });
}

// ---------------------------------------------------------------------------
// GET /api/campaigns/companies
// ---------------------------------------------------------------------------
export async function listCompanies(req, res) {
  const list = Object.entries(COMPANY_CONFIG).map(([key, cfg]) => ({
    key,
    label:        cfg.label,
    domain:       cfg.domain,
    fromEmail:    cfg.fromEmail(),
    fromName:     cfg.fromName(),
    accountCount: cfg.apiKeys().length,
    maxEmails:    cfg.apiKeys().length * 300,
  }));
  res.json({ companies: list });
}

// ---------------------------------------------------------------------------
// GET /api/campaigns/account-status?company=launcherdesk
// Returns live quota for each account
// ---------------------------------------------------------------------------
export async function accountStatus(req, res) {
  const key = req.query.company || 'launcherdesk';
  const cfg = getCfg(key);
  const keys = cfg.apiKeys();

  if (keys.length === 0) {
    return res.status(400).json({
      error: `No Brevo keys configured for ${cfg.label}. Add LD_BREVO_KEY_1/LD_BREVO_KEY_2 in .env`,
    });
  }

  const accounts = await Promise.all(
    keys.map(async (k, i) => ({
      index: i + 1,
      label: `Account ${i + 1}`,
      quota: await fetchQuota(k),
    }))
  );

  const totalRemaining = accounts.reduce((s, a) => s + (a.quota?.remaining || 0), 0);
  res.json({
    company:       key,
    label:         cfg.label,
    fromEmail:     cfg.fromEmail(),
    accounts,
    totalRemaining,
    totalCapacity: keys.length * 300,
  });
}

// ---------------------------------------------------------------------------
// GET /api/campaigns/brevo-status?company=launcherdesk
// ---------------------------------------------------------------------------
export async function brevoStatus(req, res) {
  const key  = req.query.company || 'launcherdesk';
  const cfg  = getCfg(key);
  const keys = cfg.apiKeys();
  if (keys.length === 0) return res.status(400).json({ error: `No Brevo keys for ${cfg.label}.` });

  try {
    const { ok, body, status } = await brevoReq(keys[0], '/account');
    if (!ok) return res.status(502).json({ error: body.message || `Brevo error ${status}` });

    const fromEmail  = cfg.fromEmail();
    const fromDomain = fromEmail.split('@')[1] || '';

    const { ok: sOk, body: sBody } = await brevoReq(keys[0], '/senders');
    const senders  = sOk ? (sBody.senders || []) : [];
    const verified = senders.some((s) => s.email?.toLowerCase() === fromEmail.toLowerCase() && s.active);

    const { ok: dOk, body: dBody } = await brevoReq(keys[0], '/senders/domains');
    const domains    = dOk ? (dBody.domains || []) : [];
    const domainInfo = domains.find((d) => d.domainName === fromDomain) || null;

    res.json({
      company: key, label: cfg.label, fromEmail, fromDomain,
      senderVerified: verified, domainInfo,
      accountCount:  keys.length,
      totalCapacity: keys.length * 300,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ---------------------------------------------------------------------------
// GET /api/campaigns/states
// ---------------------------------------------------------------------------
export async function listStates(req, res) {
  const results = await Lead.aggregate([
    { $match: { state: { $ne: '' }, status: 'active' } },
    { $group: { _id: '$state', count: { $sum: 1 } } },
    { $match: { _id: { $ne: null } } },
    { $sort: { count: -1 } },
    { $project: { _id: 0, state: '$_id', count: 1 } },
  ]);
  const unclassified = await Lead.countDocuments({ state: '', status: 'active' });
  res.json({ states: results, unclassified, total: results.reduce((s, r) => s + r.count, 0) + unclassified });
}

// ---------------------------------------------------------------------------
// GET /api/campaigns/blasted-states?importBatch=xxx&company=xxx
// ---------------------------------------------------------------------------
export async function blastedStates(req, res) {
  const { importBatch, company } = req.query;
  if (!importBatch) return res.json({ blastedStates: [], manualStates: [], allBlasted: false });

  const done = await Campaign.find({
    'targetFilter.importBatch': importBatch,
    company:                   company || 'launcherdesk',
    status:                    { $in: ['sent', 'stopped'] },
  }).select('targetFilter.state stats name').lean();

  const blasted = new Set();
  const manual  = new Set();

  for (const c of done) {
    const states   = c.targetFilter?.state || [];
    const isManual = (c.name || '').startsWith('[Manual]');
    if (states.length === 0 && c.stats?.sent > 0) {
      return res.json({ blastedStates: [], manualStates: [], allBlasted: true });
    }
    states.forEach((s) => { blasted.add(s); if (isManual) manual.add(s); });
  }

  res.json({ blastedStates: [...blasted], manualStates: [...manual], allBlasted: false });
}

// ---------------------------------------------------------------------------
// POST /api/campaigns/manual-blast
// ---------------------------------------------------------------------------
export async function manualMarkBlasted(req, res) {
  const { importBatch, company: co = 'launcherdesk', state } = req.body;
  if (!importBatch) return res.status(400).json({ error: 'importBatch is required.' });
  if (!state)       return res.status(400).json({ error: 'state is required.' });

  const exists = await Campaign.findOne({
    'targetFilter.importBatch': importBatch,
    'targetFilter.state': state, company: co, status: 'sent',
    name: { $regex: /^\[Manual\]/ },
  });
  if (exists) return res.status(409).json({ error: `${state} already marked.` });

  const c = await Campaign.create({
    name: `[Manual] ${state} — ${new Date().toLocaleDateString('en-IN')}`,
    subject: 'Manual mark', body: 'Manually marked as sent.',
    company: co,
    targetFilter: { status: 'active', search: '', importBatch, state: [state] },
    provider: 'brevo', stats: { total: 0, sent: 0, failed: 0 },
    status: 'sent', sentAt: new Date(),
  });
  res.status(201).json({ message: `${state} marked as sent.`, campaign: c });
}

// ---------------------------------------------------------------------------
// DELETE /api/campaigns/manual-blast
// ---------------------------------------------------------------------------
export async function manualUnmarkBlasted(req, res) {
  const { importBatch, company: co = 'launcherdesk', state } = req.body;
  if (!importBatch) return res.status(400).json({ error: 'importBatch is required.' });
  if (!state)       return res.status(400).json({ error: 'state is required.' });

  const r = await Campaign.deleteOne({
    'targetFilter.importBatch': importBatch,
    'targetFilter.state': state, company: co, status: 'sent',
    name: { $regex: /^\[Manual\]/ },
  });
  if (r.deletedCount === 0) return res.status(404).json({ error: `No manual mark found for ${state}.` });
  res.json({ message: `${state} unmarked.` });
}

// ---------------------------------------------------------------------------
// GET /api/campaigns/preview-count
// ---------------------------------------------------------------------------
export async function previewCount(req, res) {
  const { status = 'active', search = '', importBatch = '' } = req.query;
  const stateArr = req.query.state ? req.query.state.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const filter   = buildFilter({ status, search, importBatch, state: stateArr.length ? stateArr : undefined });
  const count    = await Lead.countDocuments(filter);
  const batches  = await Lead.distinct('importBatch').then((a) => a.filter(Boolean).sort().reverse());
  res.json({ count, batches });
}

// ---------------------------------------------------------------------------
// POST /api/campaigns/test
// ---------------------------------------------------------------------------
export async function testSend(req, res) {
  const { subject, body, fromName, testEmail, company: co = 'launcherdesk' } = req.body;
  if (!subject || !body)   return res.status(400).json({ error: 'subject and body are required.' });
  if (!testEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(testEmail))
    return res.status(400).json({ error: 'Valid testEmail required.' });

  const cfg  = getCfg(co);
  const keys = cfg.apiKeys();
  if (keys.length === 0)
    return res.status(500).json({ error: `No Brevo keys for ${cfg.label}. Add LD_BREVO_KEY_1 etc in .env.` });

  const fromEmail  = cfg.fromEmail();
  const senderName = fromName || cfg.fromName();
  const htmlBody   = personalise(body,    { name: 'Test User', company: 'Example Company', email: testEmail });
  const subj       = personalise(subject, { name: 'Test User', company: 'Example Company', email: testEmail });

  let attachment = null;
  if (req.file) attachment = { filename: req.file.originalname, mimeType: req.file.mimetype, data: req.file.buffer.toString('base64') };

  // Build pool with live quotas so we pick the right account
  const pool = await BrevoPool.create(keys);
  const acc  = pool.firstAvailable();

  if (!acc) {
    return res.status(429).json({
      error: `All ${keys.length} Brevo account${keys.length > 1 ? 's' : ''} for ${cfg.label} have 0 emails remaining this month. Wait for monthly reset or add more API keys.`,
    });
  }

  try {
    const r = await sendViaBrevo({ to: testEmail, toName: 'Test User', subject: subj, htmlBody, fromEmail, fromName: senderName, replyTo: fromEmail, attachment, apiKey: acc.key, companyAddress: cfg.address });
    res.json({
      message:   `Sent from ${fromEmail} (Account ${acc.index} of ${keys.length}, ${acc.remaining} remaining) to ${testEmail}.`,
      messageId: r && r.messageId ? r.messageId : null,
      tips: [
        'Check Primary inbox first.',
        'Check Promotions tab second.',
        'Gmail search: from:' + fromEmail,
        'Check Spam — click Report as not spam if found there.',
        'Allow up to 2 minutes.',
      ],
    });
  } catch (err) {
    console.error('[testSend]', err.message);
    res.status(502).json({ error: err.message });
  }
}

// ---------------------------------------------------------------------------
// GET /api/campaigns
// ---------------------------------------------------------------------------
export async function listCampaigns(req, res) {
  const page  = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 20;
  const skip  = (page - 1) * limit;
  const cf    = req.query.company ? { company: req.query.company } : {};
  const [campaigns, total] = await Promise.all([
    Campaign.find(cf).select('-attachment.data').sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Campaign.countDocuments(cf),
  ]);
  res.json({ campaigns, pagination: { page, total, pages: Math.ceil(total / limit) } });
}

// ---------------------------------------------------------------------------
// POST /api/campaigns
// ---------------------------------------------------------------------------
export async function createAndSendCampaign(req, res) {
  const { name, subject, body, fromName, company: co = 'launcherdesk' } = req.body;
  let tf = {};
  try { if (req.body.targetFilter) tf = JSON.parse(req.body.targetFilter); } catch { /**/ }

  if (!name || !subject || !body) return res.status(400).json({ error: 'name, subject, body required.' });

  const cfg  = getCfg(co);
  const keys = cfg.apiKeys();
  if (keys.length === 0)
    return res.status(500).json({ error: `No Brevo keys for ${cfg.label}. Add LD_BREVO_KEY_1 etc in .env.` });

  const filter = buildFilter(tf);
  const total  = await Lead.countDocuments(filter);
  if (total === 0) return res.status(400).json({ error: 'No leads match the selected filter.' });

  let attachment = { filename: '', mimeType: '', data: '' };
  if (req.file) attachment = { filename: req.file.originalname, mimeType: req.file.mimetype, data: req.file.buffer.toString('base64') };

  const campaign = await Campaign.create({
    name, subject, body,
    fromName:     fromName || cfg.fromName(),
    company:      co,
    targetFilter: { status: tf.status || 'active', search: tf.search || '', importBatch: tf.importBatch || '', state: Array.isArray(tf.state) ? tf.state : [] },
    provider:     'brevo',
    attachment,
    stats:        { total, sent: 0, failed: 0 },
    status:       'sending',
    createdBy:    req.user?.id || null,
  });

  // Create a BlastLog entry — shared across all users
  const blastLog = await BlastLog.create({
    triggeredBy:   {
      userId:    req.user.id,
      userEmail: req.user.email,
      // Show @username first, then name, then email-prefix as last resort
      userName:  req.user.username && req.user.username.trim()
        ? `@${req.user.username.trim()}`
        : req.user.name && req.user.name.trim()
          ? req.user.name.trim()
          : req.user.email.split('@')[0],
    },
    campaignId:    campaign._id,
    campaignName:  campaign.name,
    company:       co,
    subject:       campaign.subject,
    startedAt:     new Date(),
    totalTargeted: total,
    blastStatus:   'running',
  });

  res.status(201).json({
    campaign,
    message: `Campaign started. Sending ${total} emails via ${keys.length} Brevo account${keys.length > 1 ? 's' : ''} (capacity: ${keys.length * 300})…`,
  });

  // Pass keys — pool will be built with live quotas inside sendEmails
  sendEmails(campaign, filter, cfg, keys, cfg.address, blastLog).catch((err) => console.error('[campaign] bg error:', err));
}

// ---------------------------------------------------------------------------
// Background sender — rotates accounts automatically
// ---------------------------------------------------------------------------
async function sendEmails(campaign, filter, cfg, apiKeys, companyAddress, blastLog) {
  const fromEmail  = cfg.fromEmail();
  const fromName   = campaign.fromName || cfg.fromName();
  const attachment = campaign.attachment?.data && campaign.attachment?.filename ? campaign.attachment : null;

  // Build pool with LIVE quota from Brevo — skips exhausted accounts automatically
  const pool = await BrevoPool.create(apiKeys);
  const totalLiveRemaining = pool.accounts.reduce((s, a) => s + a.remaining, 0);
  console.log(`[campaign] "${campaign.name}" — ${pool.totalAccounts} account(s), ${totalLiveRemaining} emails actually available (live from Brevo)`);

  let sent = 0, failed = 0, skipped = 0;
  const failedRecipients = [];        // collected for BlastLog resend
  const successfullySentEmails = [];  // deleted from Lead DB after blast
  const BATCH = 50;
  let skip = 0;
  const id = campaign._id.toString();
  stopSignals.set(id, false);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (stopSignals.get(id)) { console.log(`[campaign] Stopped after ${sent} sent.`); break; }

    const acc = pool.active();
    if (!acc) {
      console.log('[campaign] All accounts exhausted.');
      await Campaign.findByIdAndUpdate(campaign._id, {
        'stats.lastError': `All ${pool.totalAccounts} Brevo account${pool.totalAccounts > 1 ? 's' : ''} have reached their monthly quota (${pool.totalAccounts * 300} emails). Wait for next month or add more accounts.`,
      });
      break;
    }

    const leads = await Lead.find(filter).select('email name firstName company').skip(skip).limit(BATCH).lean();
    if (leads.length === 0) break;
    skip += leads.length;

    for (const lead of leads) {
      if (stopSignals.get(id)) break;

      const activeAcc = pool.active();
      if (!activeAcc) break;

      if (!lead.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) {
        skipped++;
        console.warn(`[campaign] Skipped invalid email: "${lead.email}"`);
        continue;
      }

      try {
        const pName   = lead.name || lead.firstName || lead.email.split('@')[0];
        const company = lead.company || '';
        const html    = personalise(campaign.body,    { name: pName, company, email: lead.email });
        const subj    = personalise(campaign.subject, { name: pName, company, email: lead.email });

        await sendViaBrevo({ to: lead.email, toName: pName, subject: subj, htmlBody: html, fromEmail, fromName, replyTo: fromEmail, attachment, apiKey: activeAcc.key, companyAddress: cfg.address });

        sent++;
        successfullySentEmails.push(lead.email);
        pool.markSent();

        if (sent % 10 === 0) {
          await Campaign.findByIdAndUpdate(campaign._id, {
            'stats.sent':      sent,
            'stats.failed':    failed,
            'stats.lastError': pool.summary(),
          });
        }
        await sleep(1500);
      } catch (err) {
        failed++;
        const reason = err.message || 'Unknown';
        const pName  = lead.name || lead.firstName || lead.email.split('@')[0];
        console.error(`[campaign] Failed → ${lead.email} (Acc ${activeAcc.index}): ${reason}`);

        // Collect for resend section
        failedRecipients.push({
          email:       lead.email,
          name:        pName,
          company:     lead.company || '',
          reason,
          retryStatus: 'pending',
        });

        if (reason.includes('429') || /quota|daily.limit|plan.limit/i.test(reason)) {
          pool.markExhausted();
          if (!pool.active()) break;
        } else if (failed === 1) {
          await Campaign.findByIdAndUpdate(campaign._id, { 'stats.lastError': reason });
        }
      }
    }
  }

  const stopped = stopSignals.get(id) === true;
  stopSignals.delete(id);

  const finalStatus = stopped ? 'stopped' : (sent === 0 ? 'failed' : 'sent');

  await Campaign.findByIdAndUpdate(campaign._id, {
    status:         finalStatus,
    sentAt:         new Date(),
    'stats.sent':   sent,
    'stats.failed': failed,
  });

  // Update BlastLog — store failed recipients temporarily for resend
  if (blastLog) {
    await BlastLog.findByIdAndUpdate(blastLog._id, {
      completedAt:      new Date(),
      totalSent:        sent,
      totalFailed:      failed,
      totalSkipped:     skipped,
      blastStatus:      stopped ? 'stopped' : (sent === 0 ? 'failed' : 'completed'),
      failedRecipients: failedRecipients,
    });
  }

  // ── Delete successfully sent leads immediately ──────────────────────────
  // Per product requirement: leads must NOT be stored after a successful blast.
  // Only failed recipients remain — temporarily in BlastLog for resend,
  // and are cleared from there once resent or dismissed.
  if (sent > 0) {
    const failedEmails = new Set(failedRecipients.map((r) => r.email));
    const sentEmails   = successfullySentEmails.filter((e) => !failedEmails.has(e));
    if (sentEmails.length > 0) {
      const del = await Lead.deleteMany({ email: { $in: sentEmails } });
      console.log(`[campaign] Deleted ${del.deletedCount} successfully-sent leads from DB.`);
    }
  }

  console.log(`[campaign] "${campaign.name}" ${stopped ? 'STOPPED' : 'DONE'} — ${pool.summary()}`);
}

// ---------------------------------------------------------------------------
// Resend failed recipients from a BlastLog — called by logController
// Clears failedRecipients from the log once all succeed.
// ---------------------------------------------------------------------------
export async function resendViaCampaign(blastLog, campaign, pendingRecipients) {
  const co  = campaign.company || 'launcherdesk';
  const cfg = COMPANY_CONFIG[co] || COMPANY_CONFIG.launcherdesk;
  const keys = cfg.apiKeys();
  if (keys.length === 0) {
    console.error('[resend] No Brevo keys for', co);
    return;
  }

  const pool       = await BrevoPool.create(keys);
  const fromEmail  = cfg.fromEmail();
  const fromName   = campaign.fromName || cfg.fromName();
  const attachment = campaign.attachment?.data && campaign.attachment?.filename ? campaign.attachment : null;

  let resentOk = 0, resentFail = 0;

  for (const recipient of pendingRecipients) {
    const acc = pool.firstAvailable();
    if (!acc) { console.log('[resend] All accounts exhausted.'); break; }

    try {
      const pName   = recipient.name || recipient.email.split('@')[0];
      const company = recipient.company || '';
      const html    = personalise(campaign.body,    { name: pName, company, email: recipient.email });
      const subj    = personalise(campaign.subject, { name: pName, company, email: recipient.email });

      await sendViaBrevo({ to: recipient.email, toName: pName, subject: subj, htmlBody: html, fromEmail, fromName, replyTo: fromEmail, attachment, apiKey: acc.key, companyAddress: cfg.address });

      // Mark this recipient as successfully retried
      await BlastLog.updateOne(
        { _id: blastLog._id, 'failedRecipients.email': recipient.email },
        { $set: { 'failedRecipients.$.retryStatus': 'success', 'failedRecipients.$.retriedAt': new Date() } }
      );
      resentOk++;
      await sleep(1500);
    } catch (err) {
      console.error(`[resend] Failed again → ${recipient.email}: ${err.message}`);
      await BlastLog.updateOne(
        { _id: blastLog._id, 'failedRecipients.email': recipient.email },
        { $set: { 'failedRecipients.$.retryStatus': 'failed', 'failedRecipients.$.retriedAt': new Date() } }
      );
      resentFail++;
    }
  }

  console.log(`[resend] Done — ${resentOk} succeeded, ${resentFail} still failed`);

  // If all retried successfully, clear failedRecipients entirely (no permanent storage)
  if (resentFail === 0) {
    await BlastLog.findByIdAndUpdate(blastLog._id, { failedRecipients: [] });
    console.log('[resend] All failures resolved — failedRecipients cleared from log.');
    // Also delete those leads from the DB — they've now been sent successfully
    const emails = pendingRecipients.map((r) => r.email);
    if (emails.length > 0) {
      const del = await Lead.deleteMany({ email: { $in: emails } });
      console.log(`[resend] Deleted ${del.deletedCount} resent leads from DB.`);
    }
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// POST /api/campaigns/:id/stop
// ---------------------------------------------------------------------------
export async function stopCampaign(req, res) {
  const c = await Campaign.findById(req.params.id);
  if (!c) return res.status(404).json({ error: 'Campaign not found.' });
  if (c.status !== 'sending') return res.status(409).json({ error: `Not sending (status: ${c.status}).` });
  stopSignals.set(req.params.id, true);
  await Campaign.findByIdAndUpdate(req.params.id, { status: 'stopped' });
  res.json({ message: 'Stop signal sent.' });
}

// ---------------------------------------------------------------------------
// GET /api/campaigns/:id
// ---------------------------------------------------------------------------
export async function getCampaign(req, res) {
  const c = await Campaign.findById(req.params.id).select('-attachment.data').lean();
  if (!c) return res.status(404).json({ error: 'Campaign not found.' });
  res.json({ campaign: c });
}

// ---------------------------------------------------------------------------
// DELETE /api/campaigns/:id
// ---------------------------------------------------------------------------
export async function deleteCampaign(req, res) {
  const c = await Campaign.findById(req.params.id);
  if (!c) return res.status(404).json({ error: 'Campaign not found.' });
  if (c.status === 'sending') return res.status(409).json({ error: 'Cannot delete a sending campaign.' });
  await c.deleteOne();
  res.json({ message: 'Campaign deleted.' });
}