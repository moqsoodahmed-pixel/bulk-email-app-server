import * as XLSX from 'xlsx';
import Lead from '../models/Lead.js';

// ---------------------------------------------------------------------------
// Email normalisation helpers
// ---------------------------------------------------------------------------

/**
 * Strip Gmail-style dots and plus-aliases so john.doe+promo@gmail.com
 * and johndoe@gmail.com are recognised as the same inbox.
 *
 * We only apply Gmail dot-stripping for gmail.com / googlemail.com because
 * other providers do treat dots as significant.
 */
function canonicalEmail(raw) {
  const lower = raw.toLowerCase().trim();
  const [localPart, domain] = lower.split('@');
  if (!domain) return lower;

  // Strip plus-alias on any provider (john+promo@company.com → john@company.com)
  const noAlias = localPart.split('+')[0];

  // Strip dots only for Gmail
  const gmailDomains = ['gmail.com', 'googlemail.com'];
  const cleanLocal = gmailDomains.includes(domain) ? noAlias.replace(/\./g, '') : noAlias;

  return `${cleanLocal}@${domain}`;
}

// ---------------------------------------------------------------------------
// Row normaliser (same logic as Phase 2, centralised here)
// ---------------------------------------------------------------------------

function normaliseRow(raw) {
  const get = (...keys) => {
    for (const k of keys) {
      const found = Object.keys(raw).find(
        (rk) => rk.trim().toLowerCase() === k.toLowerCase()
      );
      if (found && raw[found] !== undefined && raw[found] !== null) {
        return String(raw[found]).trim();
      }
    }
    return '';
  };

  // -------------------------------------------------------------------------
  // MCA CSV exports come in multiple shifted formats depending on source.
  // We scan ALL candidate columns for the first @-containing value as email.
  //
  // FORMAT A (older MCA export — heavily shifted):
  //   'roc'     → director name
  //   'nicCode' → email          ← EMAIL HERE
  //   'nicLabel'→ phone (with backtick prefix)
  //
  // FORMAT B (previous MCA export — moderately shifted):
  //   'email'      → director name
  //   'directorName' → email     ← EMAIL HERE
  //   'directorEmail'→ phone
  //
  // FORMAT C (correctly aligned MCA / standard CSV):
  //   'email'       → email      ← EMAIL HERE
  //   'directorEmail'→ director email (also valid)
  //   'directorName'→ director name
  //   'directorMobile'→ phone
  //
  // FORMAT D (new MCA export — shifted one more column right):
  //   'nicCode'        → director name
  //   'nicLabel'       → email          ← EMAIL HERE
  //   'classOfCompany' → phone (with backtick prefix)
  // -------------------------------------------------------------------------

  const candidateEmailFields = [
    get('nicLabel', 'nic_label'),                                    // FORMAT D
    get('nicCode', 'nic_code'),                                      // FORMAT A
    get('email', 'Email', 'EMAIL', 'email address', 'e-mail'),      // FORMAT B name / FORMAT C email
    get('director_email', 'directorEmail'),                          // FORMAT C director email
    get('directorName', 'director_name', 'director name'),           // FORMAT B email
  ];
  const email = candidateEmailFields.find((v) => v && v.includes('@')) || '';
  if (!email || !email.includes('@')) return null;

  const firstName = get('first name', 'firstname', 'first_name', 'First Name');
  const lastName  = get('last name', 'lastname', 'last_name', 'Last Name');

  // Determine name — each format stores it in a different column.
  // Rule: use the first column value that does NOT look like an email.
  const rawNicCode    = get('nicCode', 'nic_code');
  const rawNicLabel   = get('nicLabel', 'nic_label');
  const rawRoc        = get('roc');
  const rawEmailCol   = get('email', 'Email', 'EMAIL');
  const rawDirName    = get('directorName', 'director_name', 'director name');

  // Detect format by which column holds the email
  const isFormatD     = rawNicLabel && rawNicLabel.includes('@');   // nicLabel = email → nicCode = name
  const isFormatA     = !isFormatD && rawNicCode && rawNicCode.includes('@'); // nicCode = email → roc = name

  const nameFromNicCode    = (isFormatD && rawNicCode && !rawNicCode.includes('@')) ? rawNicCode  : ''; // FORMAT D
  const nameFromRoc        = (isFormatA && rawRoc    && !rawRoc.includes('@'))      ? rawRoc      : ''; // FORMAT A only
  const nameFromEmailCol   = (rawEmailCol && !rawEmailCol.includes('@'))             ? rawEmailCol : ''; // FORMAT B
  const nameFromDirName    = (rawDirName  && !rawDirName.includes('@'))              ? rawDirName  : ''; // FORMAT C

  const name =
    nameFromNicCode ||                                               // FORMAT D
    nameFromRoc ||                                                   // FORMAT A
    nameFromDirName ||                                               // FORMAT C
    nameFromEmailCol ||                                              // FORMAT B
    get('name', 'full name', 'fullname', 'full_name') ||
    [firstName, lastName].filter(Boolean).join(' ');

  // Company — always in the 'name' column in MCA exports
  const company =
    get('company_name', 'company name') ||
    get('company', 'organisation', 'organization', 'Company') ||
    get('name');

  // Phone — each format stores it differently; strip leading backtick artefact.
  const rawDirectorEmail  = get('directorEmail', 'director_email', 'director email');
  const rawDirMobile      = get('directorMobile', 'director_mobile', 'director mobile');
  const rawClassOfCompany = get('classOfCompany', 'class_of_company', 'class of company');

  // nicLabel is only a phone number in FORMAT A (when nicCode held the email).
  // In FORMAT D nicLabel = email; in FORMAT C nicLabel = industry label — never use as phone.
  const phoneFromClassOfCo   = (isFormatD && rawClassOfCompany && !rawClassOfCompany.includes('@')) ? rawClassOfCompany.replace(/^`+/, '').trim() : ''; // FORMAT D
  const phoneFromNicLabel    = (isFormatA && rawNicLabel && !rawNicLabel.includes('@'))               ? rawNicLabel.replace(/^`+/, '').trim()       : ''; // FORMAT A only
  const phoneFromDirEmailCol = (rawDirectorEmail && !rawDirectorEmail.includes('@'))                   ? rawDirectorEmail.replace(/^`+/, '').trim()  : ''; // FORMAT B
  const phoneFromDirMobile   = rawDirMobile ? rawDirMobile.replace(/^`+/, '').trim() : '';                                                                  // FORMAT C

  const phone =
    phoneFromClassOfCo ||
    phoneFromNicLabel ||
    phoneFromDirEmailCol ||
    phoneFromDirMobile ||
    get('phone', 'phone number', 'mobile', 'Phone');

  // Location — MCA sheets use state_of_registered_office; generic sheets use state/city
  const rawState =
    get('state_of_registered_office', 'registered_state', 'state of registered office') ||
    get('state', 'State', 'STATE', 'province', 'Province');

  const city =
    get('city', 'City', 'CITY', 'town', 'Town',
        'district', 'District', 'DISTRICT',
        'registered_office_city', 'city_of_registered_office');

  // Normalise state — trim, title-case, remove trailing punctuation
  const state = rawState
    ? rawState.trim().replace(/[.,;]+$/, '').replace(/\w/g, (c) => c.toUpperCase())
    : '';

  return {
    email: email.toLowerCase().trim(),
    canonical: canonicalEmail(email),
    name,
    firstName,
    lastName,
    company,
    phone,
    state,
    city,
    tags: [],
  };
}

// ---------------------------------------------------------------------------
// POST /api/leads/preview
//
// Parse the file and return a per-row analysis WITHOUT writing to DB.
// Each row gets a `resolution`:
//   "new"        — email not seen before, safe to insert
//   "exact"      — exact email already in DB
//   "canonical"  — different spelling but same canonical inbox (e.g. dots/alias)
//   "withinFile" — duplicate of another row in this very upload
// ---------------------------------------------------------------------------
export async function previewImport(req, res) {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

  let workbook;
  try {
    workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
  } catch {
    return res.status(422).json({ error: 'Could not parse file. Upload a valid .xlsx or .csv.' });
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return res.status(422).json({ error: 'Spreadsheet has no sheets.' });

  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
  if (rows.length === 0) return res.status(422).json({ error: 'Sheet is empty or has no data rows.' });

  const normalised = rows.map(normaliseRow);

  // Build per-row results — track duplicates within the file first
  const seenInFile = new Map(); // canonical → first rowIndex that used it

  const preview = normalised.map((row, idx) => {
    if (!row) {
      return { rowIndex: idx, email: '', resolution: 'invalid', existing: null, incoming: null };
    }

    // Check within-file duplicates
    if (seenInFile.has(row.canonical)) {
      return {
        rowIndex: idx,
        email: row.email,
        resolution: 'withinFile',
        duplicateOfRow: seenInFile.get(row.canonical),
        incoming: row,
        existing: null,
      };
    }
    seenInFile.set(row.canonical, idx);

    return { rowIndex: idx, email: row.email, canonical: row.canonical, incoming: row, resolution: 'pending' };
  });

  // Batch-query DB for exact emails and canonical emails
  const pendingRows = preview.filter((r) => r.resolution === 'pending');
  const exactEmails = pendingRows.map((r) => r.email);
  const canonicalEmails = pendingRows.map((r) => r.canonical);

  // Fetch all leads whose exact email OR canonical email matches anything in the file
  const existingLeads = await Lead.find({
    $or: [
      { email: { $in: exactEmails } },
      { canonical: { $in: canonicalEmails } },
    ],
  })
    .select('email canonical name company phone firstName lastName status')
    .lean();

  const byExact = new Map(existingLeads.map((l) => [l.email, l]));
  const byCanonical = new Map(existingLeads.map((l) => [l.canonical ?? canonicalEmail(l.email), l]));

  // Resolve each pending row
  for (const row of preview) {
    if (row.resolution !== 'pending') continue;

    const exactMatch = byExact.get(row.email);
    if (exactMatch) {
      row.resolution = 'exact';
      row.existing = exactMatch;
      continue;
    }

    const canonMatch = byCanonical.get(row.canonical);
    if (canonMatch) {
      row.resolution = 'canonical';
      row.existing = canonMatch;
      continue;
    }

    row.resolution = 'new';
  }

  // Summary counts
  const summary = preview.reduce(
    (acc, r) => {
      acc[r.resolution] = (acc[r.resolution] || 0) + 1;
      return acc;
    },
    { new: 0, exact: 0, canonical: 0, withinFile: 0, invalid: 0 }
  );

  res.json({ preview, summary, totalRows: rows.length });
}

// ---------------------------------------------------------------------------
// POST /api/leads/import
//
// Now accepts an explicit `actions` map: { [rowIndex]: 'skip' | 'insert' | 'update' }
// sent by the frontend after the user reviews the preview.
// Rows marked 'insert' are inserted fresh; 'update' merges non-empty incoming
// fields onto the existing document; 'skip' are ignored.
// ---------------------------------------------------------------------------
export async function importLeads(req, res) {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

  // actions is a JSON string of { "0": "skip", "3": "update", … }
  let actions = {};
  try {
    if (req.body.actions) actions = JSON.parse(req.body.actions);
  } catch {
    return res.status(400).json({ error: 'Invalid actions payload.' });
  }

  let workbook;
  try {
    workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
  } catch {
    return res.status(422).json({ error: 'Could not parse file.' });
  }

  const sheetName = workbook.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
  const importBatch = new Date().toISOString();

  const normalised = rows.map(normaliseRow);

  const toInsert = [];
  const toUpdate = []; // { filter, update }
  let skipped = 0;

  normalised.forEach((row, idx) => {
    if (!row) { skipped++; return; }

    const action = actions[String(idx)] ?? 'insert'; // default: insert new rows

    if (action === 'skip') { skipped++; return; }

    if (action === 'update') {
      // Build a sparse $set — only overwrite fields that have a value in the file
      const set = { importBatch };
      if (row.name) set.name = row.name;
      if (row.firstName) set.firstName = row.firstName;
      if (row.lastName) set.lastName = row.lastName;
      if (row.company) set.company = row.company;
      if (row.phone) set.phone = row.phone;
      toUpdate.push({ filter: { email: row.email }, update: { $set: set } });
      return;
    }

    // 'insert' — only if email is not already in DB (safety net)
    toInsert.push({ ...row, importBatch });
  });

  // Run updates first, then inserts
  let updatedCount = 0;
  for (const { filter, update } of toUpdate) {
    const result = await Lead.updateOne(filter, update);
    if (result.modifiedCount > 0) updatedCount++;
  }

  let insertedCount = 0;
  if (toInsert.length > 0) {
    // De-dupe within the insert batch (last-write wins within same file)
    const seen = new Map();
    for (const r of toInsert) seen.set(r.canonical, r);
    const deduped = [...seen.values()];

    // Remove any that already exist in DB (race-condition safety)
    const existingEmails = await Lead.find({ email: { $in: deduped.map((r) => r.email) } })
      .select('email')
      .lean();
    const existingSet = new Set(existingEmails.map((l) => l.email));
    const safe = deduped.filter((r) => !existingSet.has(r.email));

    if (safe.length > 0) {
      const result = await Lead.insertMany(safe, { ordered: false });
      insertedCount = result.length;
    }
  }

  res.status(201).json({
    inserted: insertedCount,
    updated: updatedCount,
    skipped,
    total: rows.length,
  });
}

// ---------------------------------------------------------------------------
// GET /api/leads
// ---------------------------------------------------------------------------
export async function getLeads(req, res) {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
  const skip = (page - 1) * limit;
  const search = (req.query.search || '').trim();
  const status = req.query.status || '';

  const filter = {};
  if (status && ['active', 'unsubscribed', 'bounced', 'not_sent'].includes(status)) {
    filter.status = status;
  }
  if (search) {
    const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ email: re }, { name: re }, { company: re }];
  }

  const [leads, total] = await Promise.all([
    Lead.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Lead.countDocuments(filter),
  ]);

  res.json({ leads, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
}

// ---------------------------------------------------------------------------
// DELETE /api/leads/:id
// ---------------------------------------------------------------------------
export async function deleteLead(req, res) {
  const lead = await Lead.findByIdAndDelete(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found.' });
  res.json({ message: 'Lead deleted.' });
}

// ---------------------------------------------------------------------------
// DELETE /api/leads  (bulk)
// ---------------------------------------------------------------------------
export async function bulkDeleteLeads(req, res) {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'Provide an array of ids to delete.' });
  }
  const result = await Lead.deleteMany({ _id: { $in: ids } });
  res.json({ message: `Deleted ${result.deletedCount} lead(s).` });
}