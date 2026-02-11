// kijiji-account-creator/index.js
// Creates Kijiji accounts using emails from D1
// Uses Playwright for browser automation and IMAP for email verification

const express = require('express');
const { chromium } = require('playwright');
const Imap = require('imap');
const { simpleParser } = require('mailparser');

const app = express();
app.use(express.json());

const AUTH_TOKEN = process.env.RAILWAY_AUTH_TOKEN || 'moltbot-railway-secret';
const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MEMORY_API_URL = process.env.MEMORY_API_URL || 'https://memory-api.ownthefirstpage.workers.dev';
const GMAIL_USER = process.env.GMAIL_USER || 'aperoathens@gmail.com';
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const PORT = process.env.PORT || 3000;

// GTA Cities for location rotation
const GTA_CITIES = [
  { name: 'Toronto', lat: 43.6532, lng: -79.3832 },
  { name: 'Mississauga', lat: 43.5890, lng: -79.6441 },
  { name: 'Brampton', lat: 43.7315, lng: -79.7624 },
  { name: 'Markham', lat: 43.8561, lng: -79.3370 },
  { name: 'Vaughan', lat: 43.8361, lng: -79.4983 },
  { name: 'Richmond Hill', lat: 43.8828, lng: -79.4403 },
  { name: 'Oakville', lat: 43.4675, lng: -79.6877 },
  { name: 'Burlington', lat: 43.3255, lng: -79.7990 },
  { name: 'Pickering', lat: 43.8384, lng: -79.0868 },
  { name: 'Ajax', lat: 43.8509, lng: -79.0204 }
];

// ── AUTH ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === '/health' || req.path === '/inspect') return next();
  const key = req.headers['x-moltbot-key'];
  if (key !== AUTH_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
});

// ── TELEGRAM ──────────────────────────────────────────────────────
async function tgSend(msg) {
  if (!BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'HTML' })
  }).catch(() => {});
}

// ── IMAP EMAIL READER ─────────────────────────────────────────────
function waitForEmail(emailAddress, maxWaitSeconds = 120) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let foundEmail = false;

    const imap = new Imap({
      user: GMAIL_USER,
      password: GMAIL_APP_PASSWORD,
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false }
    });

    const checkInterval = setInterval(() => {
      if (Date.now() - startTime > maxWaitSeconds * 1000) {
        clearInterval(checkInterval);
        imap.end();
        reject(new Error(`Timeout waiting for email to ${emailAddress}`));
      }
    }, 5000);

    imap.once('ready', () => {
      imap.openBox('INBOX', false, (err) => {
        if (err) {
          clearInterval(checkInterval);
          return reject(err);
        }

        // Search for Kijiji verification emails
        const searchCriteria = [
          'UNSEEN',
          ['TO', emailAddress],
          ['FROM', 'kijiji.ca'],
          ['SINCE', new Date(Date.now() - 300000)] // Last 5 minutes
        ];

        const poll = () => {
          if (foundEmail) return;

          imap.search(searchCriteria, (err, results) => {
            if (err) {
              clearInterval(checkInterval);
              imap.end();
              return reject(err);
            }

            if (results && results.length > 0) {
              foundEmail = true;
              clearInterval(checkInterval);

              const fetch = imap.fetch(results[0], { bodies: '' });

              fetch.on('message', (msg) => {
                msg.on('body', (stream) => {
                  simpleParser(stream, (err, parsed) => {
                    if (err) return reject(err);

                    // Extract verification link
                    const html = parsed.html || parsed.textAsHtml || '';
                    const linkMatch = html.match(/https:\/\/(?:www\.)?kijiji\.ca\/[^\s"'<>]+verify[^\s"'<>]*/i);

                    if (linkMatch) {
                      imap.end();
                      resolve(linkMatch[0]);
                    } else {
                      imap.end();
                      reject(new Error('No verification link found in email'));
                    }
                  });
                });
              });

              fetch.once('error', reject);
            } else {
              // Keep polling
              setTimeout(poll, 5000);
            }
          });
        };

        poll();
      });
    });

    imap.once('error', (err) => {
      clearInterval(checkInterval);
      reject(err);
    });

    imap.connect();
  });
}

// ── FETCH ACCOUNTS FROM D1 ────────────────────────────────────────
async function getAvailableAccounts(limit = 10) {
  try {
    const res = await fetch(`${MEMORY_API_URL}/api/kijiji-accounts?status=ready`);
    const data = await res.json();
    return (data.accounts || []).slice(0, limit);
  } catch(e) {
    console.error('Failed to fetch accounts:', e.message);
    return [];
  }
}

// ── UPDATE ACCOUNT STATUS ─────────────────────────────────────────
async function updateAccount(accountId, updates) {
  try {
    await fetch(`${MEMORY_API_URL}/api/kijiji-accounts/${accountId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });
  } catch(e) {
    console.error('Failed to update account:', e.message);
  }
}

// ── CREATE ONE KIJIJI ACCOUNT ─────────────────────────────────────
async function createKijijiAccount(browser, account, accountNum, total) {
  const { id, email, password, username } = account;
  const city = GTA_CITIES[Math.floor(Math.random() * GTA_CITIES.length)];
  
  console.log(`\n[${accountNum}/${total}] Creating Kijiji account for: ${email}`);
  await tgSend(`🔄 [${accountNum}/${total}] Creating: <code>${email}</code>`);

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-CA',
    timezoneId: 'America/Toronto',
    geolocation: { latitude: city.lat, longitude: city.lng },
    permissions: ['geolocation']
  });

  const page = await context.newPage();

  try {
    // Step 1: Go to Kijiji registration
    await page.goto('https://www.kijiji.ca/t-signup.html', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Step 2: Fill registration form
    console.log(`[${accountNum}/${total}] Filling registration form...`);

    // Email
    await page.fill('input[type="email"], input[name="email"], #email', email, { timeout: 10000 });
    await page.waitForTimeout(500);

    // Password
    await page.fill('input[type="password"], input[name="password"], #password', password, { timeout: 10000 });
    await page.waitForTimeout(500);

    // Nickname/username
    const nicknameField = await page.$('input[name="nickname"], input[name="displayName"], #nickname');
    if (nicknameField) {
      await nicknameField.fill(username);
      await page.waitForTimeout(500);
    }

    // Location/City
    const locationField = await page.$('input[name="location"], input[placeholder*="location" i], #location');
    if (locationField) {
      await locationField.fill(city.name);
      await page.waitForTimeout(1000);
      // Try to select from dropdown
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(500);
    }

    // Accept terms
    const checkbox = await page.$('input[type="checkbox"]');
    if (checkbox) {
      await checkbox.check();
      await page.waitForTimeout(300);
    }

    await page.screenshot({ path: `/tmp/kijiji-before-submit-${accountNum}.png` });

    // Step 3: Submit
    console.log(`[${accountNum}/${total}] Submitting...`);
    const submitBtn = await page.$('button[type="submit"], input[type="submit"], button:has-text("Sign Up"), button:has-text("Register")');
    if (submitBtn) {
      await submitBtn.click();
      await page.waitForTimeout(3000);
    }

    await page.screenshot({ path: `/tmp/kijiji-after-submit-${accountNum}.png` });

    // Step 4: Wait for verification email
    console.log(`[${accountNum}/${total}] Waiting for verification email...`);
    await tgSend(`⏳ [${accountNum}/${total}] Waiting for verification email...`);

    const verificationLink = await waitForEmail(email, 120);
    console.log(`[${accountNum}/${total}] Got verification link: ${verificationLink.substring(0, 50)}...`);

    // Step 5: Click verification link
    console.log(`[${accountNum}/${total}] Clicking verification link...`);
    await page.goto(verificationLink, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);

    await page.screenshot({ path: `/tmp/kijiji-verified-${accountNum}.png` });

    const finalUrl = page.url();
    const success = finalUrl.includes('kijiji.ca') && !finalUrl.includes('error');

    await context.close();

    if (success) {
      console.log(`[${accountNum}/${total}] ✅ SUCCESS: ${email}`);
      await updateAccount(id, {
        status: 'verified',
        kijiji_email: email,
        kijiji_password: password,
        kijiji_status: 'active',
        notes: `location:${city.name}`
      });
      await tgSend(`✅ [${accountNum}/${total}] <b>Verified!</b> ${email} (${city.name})`);
      return { success: true, email };
    } else {
      throw new Error('Verification failed - unexpected URL');
    }

  } catch(e) {
    console.error(`[${accountNum}/${total}] ❌ Error: ${e.message}`);
    await page.screenshot({ path: `/tmp/kijiji-error-${accountNum}.png` }).catch(() => {});
    await context.close();
    await updateAccount(id, { status: 'failed', notes: e.message });
    await tgSend(`❌ [${accountNum}/${total}] Failed: ${email}\n${e.message}`);
    return { success: false, email, error: e.message };
  }
}

// ── MAIN BATCH CREATOR ────────────────────────────────────────────
async function createBatch(count = 10) {
  console.log(`\n=== CREATING ${count} KIJIJI ACCOUNTS ===`);
  await tgSend(`🚀 Starting Kijiji account creator...\nCreating ${count} accounts`);

  const accounts = await getAvailableAccounts(count);
  
  if (accounts.length === 0) {
    await tgSend('❌ No accounts available with status "ready"');
    return { success: 0, failed: 0 };
  }

  console.log(`Found ${accounts.length} available accounts`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });

  const results = { success: 0, failed: 0 };

  for (let i = 0; i < accounts.length; i++) {
    const result = await createKijijiAccount(browser, accounts[i], i + 1, accounts.length);
    if (result.success) {
      results.success++;
    } else {
      results.failed++;
    }
    // Random delay between accounts
    const delay = Math.floor(Math.random() * 10000) + 5000;
    console.log(`Waiting ${delay}ms before next account...`);
    await new Promise(r => setTimeout(r, delay));
  }

  await browser.close();

  const summary = `🏁 <b>Kijiji Creator Done!</b>\n\n✅ Created: ${results.success}\n❌ Failed: ${results.failed}`;
  await tgSend(summary);
  console.log('=== BATCH COMPLETE ===');
  return results;
}

// ── ROUTES ────────────────────────────────────────────────────────
app.post('/create', async (req, res) => {
  const count = Math.min(parseInt(req.body?.count) || 10, 50);
  res.json({ success: true, message: `Creating ${count} Kijiji accounts...` });
  createBatch(count).catch(e => {
    console.error('Batch error:', e);
    tgSend(`❌ Kijiji creator crashed: ${e.message}`);
  });
});

// INSPECT ENDPOINT - dumps Kijiji signup page structure
app.get('/inspect', async (req, res) => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  try {
    await page.goto('https://www.kijiji.ca/t-signup.html', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);
    
    const inputs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('input, select, button, textarea')).map(el => ({
        tag: el.tagName,
        type: el.type || '',
        name: el.name || '',
        id: el.id || '',
        placeholder: el.placeholder || '',
        class: el.className || '',
        'data-testid': el.getAttribute('data-testid') || '',
        'aria-label': el.getAttribute('aria-label') || ''
      }));
    });
    
    await browser.close();
    res.json({ url: page.url(), inputs });
  } catch(e) {
    await browser.close();
    res.json({ error: e.message });
  }
});

app.get('/health', (_, res) => res.json({ 
  ok: true, 
  service: 'Kijiji Account Creator', 
  version: '1.0.0'
}));

app.listen(PORT, () => console.log(`Kijiji Account Creator running on port ${PORT}`));
