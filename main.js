const { app, BrowserWindow, Menu, ipcMain, safeStorage, shell, net, dialog } = require('electron');
const path = require('path'), fs = require('fs');

if (!app.requestSingleInstanceLock()) app.quit();

const cfgFile = () => path.join(app.getPath('userData'), 'canvas.json');
function loadCfg() {
  try {
    const j = JSON.parse(fs.readFileSync(cfgFile(), 'utf8'));
    return { url: j.url, token: safeStorage.decryptString(Buffer.from(j.token, 'base64')) };
  } catch { return null; }
}

// Follows Canvas pagination; never sends the token to a different host.
async function getAll(cfg, p) {
  const origin = new URL(cfg.url).origin;
  let url = cfg.url + '/api/v1' + p, out = [];
  for (let i = 0; i < 30 && url; i++) {
    const r = await net.fetch(url, { headers: { Authorization: 'Bearer ' + cfg.token } });
    if (r.status === 401) throw new Error('Canvas rejected the token. Generate a new one and reconnect.');
    if (!r.ok) throw new Error('Canvas returned error ' + r.status);
    const j = await r.json();
    out = out.concat(Array.isArray(j) ? j : [j]);
    const m = (r.headers.get('link') || '').match(/<([^>]+)>;\s*rel="next"/);
    url = m && new URL(m[1]).origin === origin ? m[1] : null;
  }
  return out;
}

ipcMain.handle('cfg:get', () => {
  const c = loadCfg();
  return { connected: !!c, url: c && c.url };
});

ipcMain.handle('cfg:set', async (_e, rawUrl, token) => {
  try {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is unavailable on this system.');
    let u = String(rawUrl || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    const parsed = new URL(u);
    if (parsed.protocol !== 'https:') throw new Error('Use an https:// Canvas address.');
    const cfg = { url: parsed.origin, token: String(token || '').trim() };
    if (!cfg.token) throw new Error('Paste your access token.');
    await getAll(cfg, '/users/self');
    fs.writeFileSync(cfgFile(), JSON.stringify({ url: cfg.url, token: safeStorage.encryptString(cfg.token).toString('base64') }));
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('cfg:clear', () => { try { fs.unlinkSync(cfgFile()); } catch {} return true; });

ipcMain.handle('canvas:sync', async () => {
  const cfg = loadCfg();
  if (!cfg) throw new Error('Not connected to Canvas.');
  const courses = (await getAll(cfg, '/courses?enrollment_state=active&include[]=total_scores&per_page=100'))
    .filter(c => c.name && !c.access_restricted_by_date);
  const [lists, mods] = await Promise.all([
    Promise.all(courses.map(c =>
      getAll(cfg, `/courses/${c.id}/assignments?include[]=submission&order_by=due_at&per_page=100`).catch(() => []))),
    Promise.all(courses.map(c =>
      getAll(cfg, `/courses/${c.id}/modules?include[]=items&per_page=100`).catch(() => [])))
  ]);
  const done = s => !!(s && (s.submitted_at || ['submitted', 'graded', 'pending_review'].includes(s.workflow_state)));
  return {
    courses: courses.map(c => ({ id: c.id, name: c.name })),
    assignments: lists.flatMap((l, i) => l.map(a => ({
      id: a.id, course: courses[i].id, title: a.name, due: a.due_at, url: a.html_url,
      sub: done(a.submission), description: a.description || '', types: a.submission_types || [],
      unlock: a.unlock_at || null, lock: a.lock_at || null, created: a.created_at || null
    }))),
    modules: courses.map((c, i) => ({
      course: c.id,
      mods: (mods[i] || []).map(m => ({
        id: 'm' + m.id, name: m.name,
        items: (m.items || []).map(it => ({ title: it.title, type: it.type, url: it.html_url || null, purl: it.page_url || null, fid: it.type === 'File' ? it.content_id : null }))
      }))
    }))
  };
});

ipcMain.handle('open:url', (_e, u) => {
  const cfg = loadCfg();
  if (cfg && typeof u === 'string' && u.startsWith(cfg.url + '/')) shell.openExternal(u);
});

ipcMain.handle('canvas:page', async (_e, courseId, slug) => {
  const cfg = loadCfg();
  if (!cfg) return null;
  try {
    const p = (await getAll(cfg, `/courses/${courseId}/pages/${encodeURIComponent(slug)}`))[0];
    return p ? { title: p.title, body: p.body || '' } : null;
  } catch { return null; }
});

/* ---- submission files (copied into the app's data folder, never uploaded) ---- */
const subDir = () => path.join(app.getPath('userData'), 'submissions');
const safeFolder = x => {
  let s = String(x || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 60);
  if (!s) return 'No course';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s)) s = '_' + s;
  return s;
};
const modDir = () => path.join(app.getPath('userData'), 'module-files');
const within = p => {
  if (typeof p !== 'string') return false;
  return [subDir(), modDir()].some(r => path.resolve(p).startsWith(path.resolve(r) + path.sep));
};

ipcMain.handle('canvas:file', async (_e, courseId, fileId) => {
  const cfg = loadCfg();
  if (!cfg) throw new Error('Not connected to Canvas.');
  const meta = (await getAll(cfg, `/courses/${courseId}/files/${fileId}`))[0];
  const url = meta && meta.url;
  if (!url) throw new Error('No download link for this file.');
  const r = await net.fetch(url, { headers: { Authorization: 'Bearer ' + cfg.token } });
  if (!r.ok) throw new Error('Canvas returned error ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  const dir = path.join(modDir(), safeFolder(courseId));
  fs.mkdirSync(dir, { recursive: true });
  const base = safeFolder(meta.display_name || meta.filename || 'file'), ext = path.extname(base);
  let dest = path.join(dir, base), n = 1;
  while (fs.existsSync(dest)) dest = path.join(dir, path.basename(base, ext) + ' (' + n++ + ')' + ext);
  fs.writeFileSync(dest, buf);
  return { name: path.basename(dest), path: dest, size: buf.length };
});

ipcMain.handle('file:pick', async (_e, folder, taskId) => {
  const r = await dialog.showOpenDialog({ title: 'Choose a file for your submission', properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const src = r.filePaths[0];
  const dir = path.join(subDir(), safeFolder(folder) + '_Submissions');
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(src), ext = path.extname(base);
  let dest = path.join(dir, base), n = 1;
  while (fs.existsSync(dest)) dest = path.join(dir, path.basename(base, ext) + ' (' + n++ + ')' + ext);
  fs.copyFileSync(src, dest);
  const st = fs.statSync(dest);
  return { name: path.basename(dest), path: dest, size: st.size, added: Date.now() };
});

ipcMain.handle('file:open', (_e, p) => (within(p) ? shell.openPath(p) : 'Not allowed'));
ipcMain.handle('file:reveal', (_e, p) => { if (within(p)) shell.showItemInFolder(p); });
ipcMain.handle('file:remove', (_e, p) => {
  if (!within(p)) return false;
  try { fs.unlinkSync(p); return true; } catch { return false; }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1220, height: 800, minWidth: 860, minHeight: 560,
    backgroundColor: '#f4f6fb', autoHideMenuBar: true, title: 'Slate',
    icon: path.join(__dirname, 'manvas.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'index.html'));
}
app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('com.personal.slate');
  createWindow();
});
app.on('window-all-closed', () => app.quit());
