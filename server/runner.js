// ZapFunil – servidor 24h.
// Abre o WhatsApp Web com a extensão ZapFunil num Chromium que nunca dorme, mantém tudo vivo
// e se atualiza sozinho a partir do GitHub (pasta server/ do app).
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DIR = process.env.ZF_DIR || '/opt/zapfunil';
const EXT = path.join(DIR, 'ext');
const PROFILE = path.join(DIR, 'profile');
const CONF_FILE = path.join(DIR, 'config.json');
const conf = JSON.parse(fs.readFileSync(CONF_FILE, 'utf8'));
const BASE = (conf.bundleUrl || 'https://gabrielfariason.github.io/zapfunil-app/server/').replace(/\/?$/, '/');
const WA = conf.waUrl || 'https://web.whatsapp.com/';
const log = (...a) => console.log(new Date().toISOString(), '[zapfunil]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, binary) {
  const r = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) throw new Error('GET ' + url + ' → ' + r.status);
  return binary ? Buffer.from(await r.arrayBuffer()) : r.text();
}

// ---------------------------------------------------------------- atualização da extensão
let bundleVersion = null;
async function updateBundle(force) {
  const meta = JSON.parse(await get(BASE + 'bundle.json'));
  const cur = fs.existsSync(path.join(EXT, '.version')) ? fs.readFileSync(path.join(EXT, '.version'), 'utf8') : null;
  if (!force && cur === meta.version) {
    bundleVersion = cur;
    return false;
  }
  const tmp = EXT + '.new';
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const f of meta.files) {
    if (f.includes('..') || path.isAbsolute(f)) throw new Error('arquivo inválido: ' + f);
    const buf = await get(BASE + 'ext/' + f, true);
    fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true });
    fs.writeFileSync(path.join(tmp, f), buf);
  }
  fs.writeFileSync(path.join(tmp, '.version'), meta.version);
  fs.rmSync(EXT + '.old', { recursive: true, force: true });
  if (fs.existsSync(EXT)) fs.renameSync(EXT, EXT + '.old');
  fs.renameSync(tmp, EXT);
  bundleVersion = meta.version;
  log('extensão atualizada para', meta.version);
  return true;
}

// ---------------------------------------------------------------- navegador
let ctx = null;
let sw = null;
let page = null;
async function startBrowser() {
  ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: !!conf.headless, // no servidor roda numa tela virtual (xvfb): o WhatsApp Web recusa navegador "headless"
    executablePath: conf.chromePath || undefined,
    viewport: { width: 1280, height: 900 },
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--no-first-run',
      '--disable-dev-shm-usage',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows'
    ].concat(conf.extraArgs || [])
  });
  if (conf.testRoute) await conf.testRoute(ctx);
  sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 30000 }));
  await sw.evaluate(() => chrome.storage.local.set({ hostKind: 'server', hostName: 'Servidor 24h' }));
  await ensureSession();
  page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(WA, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch((e) => log('abrir WhatsApp:', e.message));
  log('navegador aberto, extensão', bundleVersion);
}
async function stopBrowser() {
  try {
    if (ctx) await ctx.close();
  } catch (e) {}
  ctx = sw = page = null;
}

// Pareamento: troca o código de uso único (gerado pelo Gabriel) por uma sessão própria
async function ensureSession() {
  const has = await sw.evaluate(async () => !!(await chrome.storage.local.get('remoteSession')).remoteSession);
  if (has) return;
  if (!conf.pair) {
    log('⚠️ sem login e sem código de pareamento: gere um código novo no app e coloque em', CONF_FILE);
    return;
  }
  const r = await fetch(conf.url + '/functions/v1/zf-pair', {
    method: 'POST',
    headers: { apikey: conf.anon, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'redeem', code: conf.pair })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    log('⚠️ código de pareamento recusado:', j.error || r.status);
    return;
  }
  await sw.evaluate((s) => ZFRemote.adopt(s), j);
  delete conf.pair;
  fs.writeFileSync(CONF_FILE, JSON.stringify(conf, null, 2));
  log('✅ servidor conectado à conta', j.user && j.user.email);
}

// ---------------------------------------------------------------- vigia
async function healthy() {
  if (!ctx) return false;
  try {
    if (!page || page.isClosed()) page = ctx.pages().find((p) => p.url().startsWith(WA)) || (await ctx.newPage());
    if (!page.url().startsWith(WA)) await page.goto(WA, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.evaluate(() => 1);
    return true;
  } catch (e) {
    log('página travou:', e.message);
    return false;
  }
}

async function main() {
  try {
    await updateBundle(!fs.existsSync(EXT));
  } catch (e) {
    log('não consegui baixar a extensão:', e.message);
    if (!fs.existsSync(EXT)) throw e;
  }
  await startBrowser();
  let lastUpdateCheck = Date.now();
  let lastRestart = Date.now();
  for (;;) {
    await sleep(60000);
    let restart = !(await healthy());
    if (Date.now() - lastUpdateCheck > 10 * 60000) {
      lastUpdateCheck = Date.now();
      try {
        if (await updateBundle(false)) restart = true;
      } catch (e) {
        log('checar atualização:', e.message);
      }
    }
    // reinício preventivo 1x por dia, de madrugada (libera memória do WhatsApp Web)
    const h = new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false });
    if (Number(h) === 4 && Date.now() - lastRestart > 20 * 3600000) restart = true;
    if (restart) {
      log('reiniciando navegador…');
      await stopBrowser();
      await sleep(3000);
      await startBrowser();
      lastRestart = Date.now();
    }
  }
}

if (require.main === module) {
  main().catch((e) => {
    log('erro fatal:', e && e.stack);
    process.exit(1); // o systemd reinicia sozinho
  });
}
module.exports = { main, updateBundle, startBrowser, stopBrowser, healthy, conf, state: () => ({ ctx, sw, page }) };
