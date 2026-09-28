const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { RULES } = require('./biddingRules');

const SAMPLE_AVATARS_DIR = path.join(__dirname, '..', 'public', 'assets', 'avatars');

// Off by default: Google Drive links from the form usually can't be downloaded
// automatically. Photos are added later through the Bulk Photo Upload tool.
const ATTEMPT_PHOTO_DOWNLOAD = process.env.ENABLE_PHOTO_DOWNLOAD === 'true';

// Header matching is forgiving: headers are lower-cased with everything except
// letters/digits removed, then matched by prefix. So "Full Name", "full name " and
// "Preferred Position (You can choose more than one as well)" all still work.
const HEADER_PREFIXES = {
  fullName: ['fullname', 'name'],
  rollNumber: ['rollnumber', 'rollno'],
  email: ['email'],
  category: ['studentcategory', 'category'],
  experience: ['footballexperience', 'experience'],
  positions: ['preferredposition', 'position'],
  photo: ['upload'],
  club: ['favouritefootballclub', 'favouriteclub', 'favoritefootballclub', 'favoriteclub', 'favourite', 'favorite'],
  predecided: ['predecided']
};

function findValue(row, field) {
  const prefixes = HEADER_PREFIXES[field];
  for (const key of Object.keys(row)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (prefixes.some(p => normalized.startsWith(p))) return row[key];
  }
  return '';
}

function sanitizeFileName(name) {
  return name.trim().replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase();
}

function pickRandomSampleAvatar() {
  const files = fs.existsSync(SAMPLE_AVATARS_DIR)
    ? fs.readdirSync(SAMPLE_AVATARS_DIR).filter(f => /\.(svg|png|jpg|jpeg)$/i.test(f))
    : [];
  if (files.length === 0) return null;
  return path.join('assets', 'avatars', files[Math.floor(Math.random() * files.length)]);
}

function driveLinkToDirectDownload(url) {
  const match = url.match(/[-\w]{25,}/);
  return match ? `https://drive.google.com/uc?export=download&id=${match[0]}` : url;
}

async function downloadPhoto(url, safeName) {
  try {
    const res = await fetch(driveLinkToDirectDownload(url), { redirect: 'follow', timeout: 10000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('text/html')) throw new Error('Got an HTML page instead of an image');
    const ext = contentType.includes('png') ? '.png' : contentType.includes('webp') ? '.webp' : '.jpg';
    const dir = path.join(__dirname, '..', 'uploads', 'players');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, safeName + ext), await res.buffer());
    return path.join('uploads', 'players', safeName + ext);
  } catch (err) {
    console.warn(`Photo download failed for ${safeName}: ${err.message}`);
    return null;
  }
}

function normalizeCategory(raw) {
  const v = (raw || '').toString().trim().toLowerCase();
  if (v.startsWith('adv')) return 'Advance';
  if (v.startsWith('inter')) return 'Intermediate';
  return 'Beginner';
}

function isFlagSet(v) {
  return ['1', 'true', 'yes', 'y'].includes(String(v == null ? '' : v).trim().toLowerCase());
}

// "Males" / "Females" (case-insensitive; "female" is checked first because it contains "male")
function classifySheet(sheetName) {
  const n = sheetName.trim().toLowerCase();
  if (n.includes('female')) return 'Female';
  if (n.includes('male')) return 'Male';
  return null;
}

async function rowsToPlayers(rows, gender) {
  const out = [];
  for (const row of rows) {
    const fullName = String(findValue(row, 'fullName') || '').trim();
    if (!fullName) continue; // blank row

    // FIX 1: Read the 'Football Experience' column to determine the Advance/Intermediate/Beginner tier
    const category = normalizeCategory(findValue(row, 'experience'));
    
    // Only males can be "predecided" (captains + the one extra teammate).
    const predecided = gender === 'Male' && isFlagSet(findValue(row, 'predecided'));

    // This block declares and fetches the photoPath
    let photoPath = null;
    const photoUrl = String(findValue(row, 'photo') || '').trim();
    if (ATTEMPT_PHOTO_DOWNLOAD && photoUrl) photoPath = await downloadPhoto(photoUrl, sanitizeFileName(fullName));
    if (!photoPath) photoPath = pickRandomSampleAvatar();

    out.push({
      full_name: fullName,
      roll_number: String(findValue(row, 'rollNumber') || '').trim(),
      email: String(findValue(row, 'email') || '').trim(),
      gender,
      category, // This now correctly holds Advance, Intermediate, or Beginner
      // FIX 2: Store the B.Tech/M.Tech value in the experience string so it displays on the player card
      experience: String(findValue(row, 'experience') || '').trim(),
      preferred_positions: String(findValue(row, 'positions') || '').trim(),
      favourite_club: String(findValue(row, 'club') || '').trim(),
      photo_path: photoPath,
      base_price: RULES.BASE_PRICE[category],
      predecided,
      is_fixed: false,
      // Females and predecided males are never auctioned - they wait to be assigned by the admin.
      status: (gender === 'Female' || predecided) ? 'reserved' : 'pending'
    });
  }
  return out;
}

/**
 * Reads the workbook (sheets "Males" and "Females") and returns
 * { players, warnings }. Does not touch the data store.
 */
async function parsePlayerSheet(filePath) {
  const workbook = XLSX.readFile(filePath);
  const players = [];
  let warnings = [];
  let recognised = 0;

  for (const sheetName of workbook.SheetNames) {
    const gender = classifySheet(sheetName);
    if (!gender) { warnings.push(`Sheet "${sheetName}" was ignored (its name should contain "Males" or "Females").`); continue; }
    recognised++;
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
    players.push(...await rowsToPlayers(rows, gender));
  }

  // Old single-sheet exports: treat the first sheet as the males list.
  if (recognised === 0 && workbook.SheetNames.length) {
    const first = workbook.SheetNames[0];
    warnings = [`No sheet named "Males" or "Females" found - treated "${first}" as the Males sheet.`];
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[first], { defval: '' });
    players.push(...await rowsToPlayers(rows, 'Male'));
  }
  return { players, warnings };
}

module.exports = { parsePlayerSheet, sanitizeFileName };
