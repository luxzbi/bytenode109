'use strict';
require('dotenv').config();

const express      = require('express');
const path         = require('path');
const bcrypt       = require('bcryptjs');
const jwt          = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const cors         = require('cors');
const multer       = require('multer');
const admin        = require('firebase-admin');

/* ── Firebase 초기화 ── */
const serviceAccount = require('./firebase-key.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const app  = express();
const PORT = process.env.PORT || 4000;
const PUB  = path.join(__dirname, 'public');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) { console.error('JWT_SECRET 없음'); process.exit(1); }
const ADMIN_PW = process.env.ADMIN_PW;
if (!ADMIN_PW) { console.error('ADMIN_PW 없음'); process.exit(1); }

/* ── 관리자 계정 초기화 ── */
async function initAdmin() {
  const snap = await db.collection('users').where('username', '==', 'studioztec').limit(1).get();
  const hashed = await bcrypt.hash(ADMIN_PW, 12);
  if (snap.empty) {
    const id = uuid();
    await db.collection('users').doc(id).set({
      username: 'studioztec', displayName: '관리자', pw: hashed,
      isAdmin: true, bio: '', avatar: '', banned: false,
      bannedReason: '', createdAt: Date.now()
    });
    console.log('관리자 계정 생성 완료');
  } else {
    await snap.docs[0].ref.update({ pw: hashed });
    console.log('관리자 비번 업데이트 완료');
  }
}
initAdmin().catch(e => console.error('관리자 초기화 실패', e));

/* ── 미들웨어 ── */
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net", "cdnjs.cloudflare.com", "ajax.googleapis.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net"],
      imgSrc: ["'self'", "data:", "blob:", "*.public.blob.vercel-storage.com"],
      mediaSrc: ["'self'", "blob:", "*.public.blob.vercel-storage.com"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      workerSrc: ["blob:"]
    }
  }
}));

const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : [];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) cb(null, true);
    else cb(new Error('CORS: origin not allowed'));
  }
}));
app.use((req, res, next) => {
  if (req.path === '/api/posts' && req.method === 'POST') express.json({ limit: '2mb' })(req, res, next);
  else express.json({ limit: '512kb' })(req, res, next);
});
app.use(express.static(PUB));

const limiter     = rateLimit({ windowMs: 5*60*1000, max: 300 });
const authLimiter = rateLimit({ windowMs: 15*60*1000, max: 20, message: { error: '너무 많은 시도입니다. 15분 후 다시 시도하세요.' } });
app.use('/api/', limiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

/* ── multer + Vercel Blob ── */
const ALLOWED_MIME = /^(image\/(jpeg|png|gif|webp|avif)|video\/(mp4|webm|ogg)|model\/(gltf-binary|gltf\+json))$/;
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => ALLOWED_MIME.test(file.mimetype) ? cb(null, true) : cb(new Error('허용되지 않는 파일 형식입니다.')),
  limits: { fileSize: 50 * 1024 * 1024 }
});
async function uploadToBlob(file) {
  const { put } = require('@vercel/blob');
  const extMap = { 'image/jpeg':'.jpg','image/png':'.png','image/gif':'.gif','image/webp':'.webp','image/avif':'.avif','video/mp4':'.mp4','video/webm':'.webm','video/ogg':'.ogv','model/gltf-binary':'.glb','model/gltf+json':'.gltf' };
  const ext = extMap[file.mimetype] || '.bin';
  const blob = await put(uuid() + ext, file.buffer, { access: 'public' });
  return blob.url;
}

/* ── JWT 미들웨어 ── */
function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: '인증이 필요합니다.' });
  try { req.user = jwt.verify(h.slice(7), JWT_SECRET); next(); }
  catch { res.status(401).json({ error: '만료되었거나 잘못된 토큰입니다.' }); }
}
async function adminOnly(req, res, next) {
  try {
    const doc = await db.collection('users').doc(req.user.id).get();
    if (!doc.exists || !doc.data().isAdmin) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
    next();
  } catch { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
}
function mapUser(id, d) {
  if (!d) return null;
  return { id, _id: id, username: d.username, displayName: d.displayName||'', pw: d.pw, isAdmin: d.isAdmin||false, bio: d.bio||'', avatar: d.avatar||'', banned: d.banned||false, bannedReason: d.bannedReason||'', createdAt: d.createdAt };
}

/* ══ AUTH ══ */

app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, displayName, password } = req.body;
    if (!username||!displayName||!password) return res.status(400).json({ error: '모든 필드를 입력하세요.' });
    if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) return res.status(400).json({ error: '아이디는 영문·숫자·_만 3~30자로 입력하세요.' });
    if (displayName.length < 1 || displayName.length > 30) return res.status(400).json({ error: '닉네임은 1~30자여야 합니다.' });
    if (password.length < 6 || password.length > 128) return res.status(400).json({ error: '비밀번호는 6~128자여야 합니다.' });
    const existing = await db.collection('users').where('username', '==', username).limit(1).get();
    if (!existing.empty) return res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });
    const hashed = await bcrypt.hash(password, 12);
    const id = uuid();
    await db.collection('users').doc(id).set({ username, displayName, pw: hashed, isAdmin: false, bio: '', avatar: '', banned: false, bannedReason: '', createdAt: Date.now() });
    const token = jwt.sign({ id, username, displayName, isAdmin: false }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id, username, displayName, isAdmin: false, bio: '', avatar: '' } });
  } catch(e) { console.error('[register]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username||!password) return res.status(400).json({ error: '아이디와 비밀번호를 입력하세요.' });
    const snap = await db.collection('users').where('username', '==', username).limit(1).get();
    if (snap.empty) return res.status(401).json({ error: '아이디 또는 비밀번호가 틀렸습니다.' });
    const docSnap = snap.docs[0];
    const user = mapUser(docSnap.id, docSnap.data());
    const ok = await bcrypt.compare(password, user.pw);
    if (!ok) return res.status(401).json({ error: '아이디 또는 비밀번호가 틀렸습니다.' });
    if (user.banned) return res.status(403).json({ error: '정지된 계정입니다.', banned: true, bannedReason: user.bannedReason||'관리자에 의해 정지됨' });
    const token = jwt.sign({ id: user.id, username: user.username, displayName: user.displayName, isAdmin: user.isAdmin }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, username: user.username, displayName: user.displayName, isAdmin: user.isAdmin, bio: user.bio, avatar: user.avatar } });
  } catch(e) { console.error('[login]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.get('/api/auth/me', auth, async (req, res) => {
  try {
    const doc = await db.collection('users').doc(req.user.id).get();
    if (!doc.exists) return res.status(404).json({ error: '유저를 찾을 수 없습니다.' });
    const u = mapUser(doc.id, doc.data());
    res.json({ id: u.id, username: u.username, displayName: u.displayName, isAdmin: u.isAdmin, bio: u.bio, avatar: u.avatar });
  } catch(e) { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.patch('/api/auth/me', auth, async (req, res) => {
  try {
    const { displayName, bio } = req.body;
    const doc = await db.collection('users').doc(req.user.id).get();
    if (!doc.exists) return res.status(404).json({ error: '유저를 찾을 수 없습니다.' });
    const upd = {};
    if (displayName) upd.displayName = displayName;
    if (bio !== undefined) upd.bio = bio;
    await db.collection('users').doc(req.user.id).update(upd);
    res.json({ ok: true });
  } catch(e) { console.error('[patch me]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.patch('/api/auth/password', auth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword||!newPassword) return res.status(400).json({ error: '현재·새 비밀번호를 입력하세요.' });
    if (newPassword.length < 6 || newPassword.length > 128) return res.status(400).json({ error: '새 비밀번호는 6~128자여야 합니다.' });
    const doc = await db.collection('users').doc(req.user.id).get();
    const user = mapUser(doc.id, doc.data());
    const ok = await bcrypt.compare(currentPassword, user.pw);
    if (!ok) return res.status(401).json({ error: '현재 비밀번호가 틀렸습니다.' });
    const hashed = await bcrypt.hash(newPassword, 12);
    await db.collection('users').doc(req.user.id).update({ pw: hashed });
    res.json({ ok: true });
  } catch(e) { console.error('[password]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.post('/api/auth/avatar', auth, upload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });
    const url = await uploadToBlob(req.file);
    await db.collection('users').doc(req.user.id).update({ avatar: url });
    res.json({ url });
  } catch(e) { console.error('[avatar]', e); res.status(500).json({ error: '업로드 실패' }); }
});

app.delete('/api/auth/me', auth, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: '아이디와 비밀번호를 입력하세요.' });
    const doc = await db.collection('users').doc(req.user.id).get();
    if (!doc.exists) return res.status(404).json({ error: '유저를 찾을 수 없습니다.' });
    const user = mapUser(doc.id, doc.data());
    if (user.username !== username) return res.status(401).json({ error: '아이디가 틀렸습니다.' });
    const ok = await bcrypt.compare(password, user.pw);
    if (!ok) return res.status(401).json({ error: '비밀번호가 틀렸습니다.' });
    if (user.isAdmin) return res.status(400).json({ error: '관리자 계정은 탈퇴할 수 없습니다.' });
    const batch = db.batch();
    const postSnap = await db.collection('posts').where('authorId', '==', user.id).get();
    postSnap.docs.forEach(d => batch.delete(d.ref));
    const examSnap = await db.collection('qf_exams').where('userId', '==', user.id).get();
    examSnap.docs.forEach(d => batch.delete(d.ref));
    const beSnap = await db.collection('be_exams').where('userId', '==', user.id).get();
    beSnap.docs.forEach(d => batch.delete(d.ref));
    const repSnap = await db.collection('reports').where('reporterId', '==', user.id).get();
    repSnap.docs.forEach(d => batch.delete(d.ref));
    batch.delete(db.collection('users').doc(user.id));
    await batch.commit();
    res.json({ ok: true });
  } catch(e) { console.error('[delete me]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

/* ══ POSTS ══ */

app.get('/api/posts', async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)||1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit)||20));
    const snap  = await db.collection('posts').where('published','==',true).where('isPrivate','==',false).get();
    const all   = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a,b)=>b.createdAt-a.createdAt);
    const total = all.length;
    const paged = all.slice((page-1)*limit, page*limit);
    const result = await Promise.all(paged.map(async p => {
      const uDoc = await db.collection('users').doc(p.authorId).get();
      const u = uDoc.exists ? uDoc.data() : {};
      return { id: p.id, title: p.title, coverImage: p.coverImage||'', tags: p.tags||[], createdAt: p.createdAt, updatedAt: p.updatedAt, username: u.username||'', displayName: u.displayName||'(탈퇴)', avatar: u.avatar||'' };
    }));
    res.json({ posts: result, total, page, limit });
  } catch(e) { console.error('[get posts]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.get('/api/posts/mine', auth, async (req, res) => {
  try {
    const snap = await db.collection('posts').where('authorId','==',req.user.id).get();
    const posts = snap.docs.map(d => { const p = d.data(); return { id: d.id, title: p.title, coverImage: p.coverImage||'', tags: p.tags||[], isPrivate: p.isPrivate, published: p.published, createdAt: p.createdAt, updatedAt: p.updatedAt }; }).sort((a,b)=>b.createdAt-a.createdAt);
    res.json({ posts, total: posts.length, limit: 50 });
  } catch(e) { console.error('[mine]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.get('/api/posts/:id', async (req, res) => {
  try {
    const doc = await db.collection('posts').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: '게시글을 찾을 수 없습니다.' });
    const p = doc.data();
    if (p.isPrivate) {
      const token = req.headers.authorization?.slice(7);
      if (!token) return res.status(403).json({ error: '비공개 글입니다.' });
      try {
        const user = jwt.verify(token, JWT_SECRET);
        if (user.id !== p.authorId && !user.isAdmin) return res.status(403).json({ error: '비공개 글입니다.' });
      } catch { return res.status(403).json({ error: '비공개 글입니다.' }); }
    }
    const uDoc = await db.collection('users').doc(p.authorId).get();
    const u = uDoc.exists ? uDoc.data() : {};
    res.json({ id: doc.id, authorId: p.authorId, title: p.title, body: p.body, tags: p.tags||[], coverImage: p.coverImage||'', published: p.published, isPrivate: p.isPrivate, createdAt: p.createdAt, updatedAt: p.updatedAt, username: u.username||'', displayName: u.displayName||'(탈퇴)', avatar: u.avatar||'' });
  } catch(e) { console.error('[get post]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.post('/api/posts', auth, async (req, res) => {
  try {
    const { title, body, tags, coverImage, published, isPrivate } = req.body;
    if (!title||!body) return res.status(400).json({ error: '제목과 내용을 입력하세요.' });
    const snap = await db.collection('posts').where('authorId','==',req.user.id).get();
    if (snap.size >= 50) return res.status(400).json({ error: '개인 저장소 한도(50개)에 도달했습니다.' });
    const now = Date.now(); const id = uuid();
    await db.collection('posts').doc(id).set({ authorId: req.user.id, title, body, tags: Array.isArray(tags)?tags:[], coverImage: coverImage||'', published: published!==false, isPrivate: !!isPrivate, createdAt: now, updatedAt: now });
    res.json({ id });
  } catch(e) { console.error('[create post]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.patch('/api/posts/:id', auth, async (req, res) => {
  try {
    const doc = await db.collection('posts').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: '게시글을 찾을 수 없습니다.' });
    const p = doc.data();
    if (p.authorId !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: '권한이 없습니다.' });
    const { title, body, tags, coverImage, published, isPrivate } = req.body;
    const upd = { updatedAt: Date.now() };
    if (title !== undefined) upd.title = title;
    if (body !== undefined) upd.body = body;
    if (Array.isArray(tags)) upd.tags = tags;
    if (coverImage !== undefined) upd.coverImage = coverImage;
    if (published !== undefined) upd.published = published;
    if (isPrivate !== undefined) upd.isPrivate = !!isPrivate;
    await db.collection('posts').doc(req.params.id).update(upd);
    res.json({ ok: true });
  } catch(e) { console.error('[patch post]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.delete('/api/posts/:id', auth, async (req, res) => {
  try {
    const doc = await db.collection('posts').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: '게시글을 찾을 수 없습니다.' });
    if (doc.data().authorId !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: '권한이 없습니다.' });
    await db.collection('posts').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch(e) { console.error('[delete post]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.post('/api/upload/image', auth, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });
    const url = await uploadToBlob(req.file);
    res.json({ url });
  } catch(e) { console.error('[upload image]', e); res.status(500).json({ error: '업로드 실패' }); }
});

/* ══ NOTICES ══ */

app.get('/api/notices', async (req, res) => {
  try {
    const snap = await db.collection('notices').where('active','==',true).where('isBanner','==',false).get();
    res.json(snap.docs.map(d => { const n = d.data(); return { id: d.id, title: n.title, body: n.body, createdAt: n.createdAt }; }).sort((a,b)=>b.createdAt-a.createdAt));
  } catch(e) { console.error('[notices]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.post('/api/notices', auth, adminOnly, async (req, res) => {
  try {
    const { title, body } = req.body;
    if (!title||!body) return res.status(400).json({ error: '제목과 내용을 입력하세요.' });
    const id = uuid();
    await db.collection('notices').doc(id).set({ title, body, isBanner: false, active: true, createdAt: Date.now() });
    res.json({ id });
  } catch(e) { console.error('[create notice]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.get('/api/notices/banner', async (req, res) => {
  try {
    const snap = await db.collection('notices').where('active','==',true).where('isBanner','==',true).get();
    if (snap.empty) return res.json(null);
    const sorted = snap.docs.sort((a,b)=>b.data().createdAt-a.data().createdAt);
    const d = sorted[0]; const n = d.data();
    res.json({ id: d.id, message: n.message, createdAt: n.createdAt });
  } catch(e) { console.error('[notices/banner]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.post('/api/notices/banner', auth, adminOnly, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: '배너 문구를 입력하세요.' });
    const id = uuid();
    await db.collection('notices').doc(id).set({ message, isBanner: true, active: true, createdAt: Date.now() });
    res.json({ id });
  } catch(e) { console.error('[create banner]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.get('/api/admin/notices/regular', auth, adminOnly, async (req, res) => {
  try {
    const snap = await db.collection('notices').where('isBanner','==',false).get();
    res.json(snap.docs.map(d => { const n = d.data(); return { id: d.id, title: n.title, body: n.body, active: n.active, createdAt: n.createdAt }; }).sort((a,b)=>b.createdAt-a.createdAt));
  } catch(e) { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.get('/api/admin/notices/banner', auth, adminOnly, async (req, res) => {
  try {
    const snap = await db.collection('notices').where('isBanner','==',true).get();
    res.json(snap.docs.map(d => { const n = d.data(); return { id: d.id, message: n.message, active: n.active, createdAt: n.createdAt }; }).sort((a,b)=>b.createdAt-a.createdAt));
  } catch(e) { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.patch('/api/notices/:id', auth, adminOnly, async (req, res) => {
  try {
    const doc = await db.collection('notices').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: '공지를 찾을 수 없습니다.' });
    await db.collection('notices').doc(req.params.id).update({ active: !!req.body.active });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.delete('/api/notices/:id', auth, adminOnly, async (req, res) => {
  try {
    await db.collection('notices').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

/* ══ REPORTS ══ */

app.post('/api/reports', auth, async (req, res) => {
  try {
    const { postId, authorId, reason } = req.body;
    if (!postId || !reason) return res.status(400).json({ error: 'postId와 reason이 필요합니다.' });
    const existing = await db.collection('reports').where('postId','==',postId).where('reporterId','==',req.user.id).limit(1).get();
    if (!existing.empty) return res.status(409).json({ error: '이미 신고한 글입니다.' });
    await db.collection('reports').doc(uuid()).set({ postId, authorId: authorId||null, reporterId: req.user.id, reason: reason.trim().slice(0,300), createdAt: Date.now(), checked: false });
    res.json({ ok: true });
  } catch(e) { console.error('[reports]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.get('/api/admin/reports', auth, adminOnly, async (req, res) => {
  try {
    const snap = await db.collection('reports').orderBy('createdAt','desc').get();
    const result = await Promise.all(snap.docs.map(async d => {
      const r = d.data();
      const pDoc = await db.collection('posts').doc(r.postId).get();
      const aDoc = r.authorId ? await db.collection('users').doc(r.authorId).get() : null;
      const rDoc = await db.collection('users').doc(r.reporterId).get();
      return { id: d.id, postId: r.postId, postTitle: pDoc.exists?pDoc.data().title:'(삭제된 글)', authorUsername: aDoc?.exists?aDoc.data().username:'', authorDisplayName: aDoc?.exists?aDoc.data().displayName:'(탈퇴)', reporterUsername: rDoc.exists?rDoc.data().username:'', reason: r.reason, createdAt: r.createdAt, checked: r.checked };
    }));
    res.json(result);
  } catch(e) { console.error('[admin/reports]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.patch('/api/admin/reports/:id', auth, adminOnly, async (req, res) => {
  try {
    const doc = await db.collection('reports').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: '없음' });
    await db.collection('reports').doc(req.params.id).update({ checked: !doc.data().checked });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.delete('/api/admin/reports/:id', auth, adminOnly, async (req, res) => {
  try {
    await db.collection('reports').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

/* ══ PROMPTS ══ */

app.get('/api/prompts', async (req, res) => {
  try {
    const snap = await db.collection('prompts').orderBy('createdAt','desc').get();
    res.json(snap.docs.map(d => { const p = d.data(); return { id: d.id, codeName: p.codeName, version: p.version||'', note: p.note||'', content: p.content, createdAt: p.createdAt }; }));
  } catch(e) { console.error('[prompts]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.post('/api/admin/prompts', auth, adminOnly, async (req, res) => {
  try {
    const { codeName, version, note, content } = req.body;
    if (!codeName||!content) return res.status(400).json({ error: 'codeName과 content가 필요합니다.' });
    const id = uuid();
    await db.collection('prompts').doc(id).set({ codeName: codeName.trim(), version: (version||'').trim(), note: (note||'').trim(), content: String(content).slice(0,200000).trim(), createdAt: Date.now() });
    res.json({ ok: true, id });
  } catch(e) { console.error('[create prompt]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.delete('/api/admin/prompts/:id', auth, adminOnly, async (req, res) => {
  try {
    await db.collection('prompts').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

/* ══ ADMIN USERS ══ */

app.get('/api/admin/users', auth, adminOnly, async (req, res) => {
  try {
    const snap = await db.collection('users').orderBy('createdAt','desc').get();
    const result = await Promise.all(snap.docs.map(async d => {
      const u = d.data();
      const [pSnap, eSnap, beSnap] = await Promise.all([
        db.collection('posts').where('authorId','==',d.id).get(),
        db.collection('qf_exams').where('userId','==',d.id).get(),
        db.collection('be_exams').where('userId','==',d.id).get()
      ]);
      return { id: d.id, username: u.username, displayName: u.displayName, isAdmin: u.isAdmin||false, banned: u.banned||false, bannedReason: u.bannedReason||'', createdAt: u.createdAt, postCount: pSnap.size, examCount: eSnap.size, beExamCount: beSnap.size };
    }));
    res.json(result);
  } catch(e) { console.error('[admin/users]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.post('/api/admin/ban', auth, adminOnly, async (req, res) => {
  try {
    const { id, reason } = req.body;
    if (!id) return res.status(400).json({ error: '대상 ID 필요' });
    const doc = await db.collection('users').doc(id).get();
    if (!doc.exists) return res.status(404).json({ error: '유저 없음' });
    if (doc.data().isAdmin) return res.status(400).json({ error: '관리자는 정지할 수 없습니다.' });
    await db.collection('users').doc(id).update({ banned: true, bannedReason: (reason||'').trim().slice(0,200)||'관리자에 의해 정지됨', bannedAt: Date.now() });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.post('/api/admin/unban', auth, adminOnly, async (req, res) => {
  try {
    const { id } = req.body;
    const doc = await db.collection('users').doc(id).get();
    if (!doc.exists) return res.status(404).json({ error: '유저 없음' });
    await db.collection('users').doc(id).update({ banned: false, bannedReason: '', bannedAt: null });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.patch('/api/admin/users/:id', auth, adminOnly, async (req, res) => {
  try {
    const isAdmin = !!req.body.isAdmin;
    if (!isAdmin) {
      const snap = await db.collection('users').where('isAdmin','==',true).get();
      if (snap.size <= 1) return res.status(400).json({ error: '마지막 관리자의 권한은 제거할 수 없습니다.' });
    }
    await db.collection('users').doc(req.params.id).update({ isAdmin });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.patch('/api/admin/users/:id/credentials', auth, adminOnly, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username && !password) return res.status(400).json({ error: '변경할 내용을 입력하세요.' });
    const upd = {};
    if (username) {
      if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) return res.status(400).json({ error: '아이디는 영문·숫자·_만 3~30자로 입력하세요.' });
      const ex = await db.collection('users').where('username','==',username).limit(1).get();
      if (!ex.empty && ex.docs[0].id !== req.params.id) return res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });
      upd.username = username;
    }
    if (password) {
      if (password.length < 6) return res.status(400).json({ error: '비밀번호는 6자 이상이어야 합니다.' });
      if (password.length > 128) return res.status(400).json({ error: '비밀번호는 128자 이하여야 합니다.' });
      upd.pw = await bcrypt.hash(password, 12);
    }
    await db.collection('users').doc(req.params.id).update(upd);
    res.json({ ok: true });
  } catch(e) { console.error('[credentials]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.delete('/api/admin/users/:id', auth, adminOnly, async (req, res) => {
  try {
    if (req.params.id === req.user.id) return res.status(400).json({ error: '자기 자신은 삭제할 수 없습니다.' });
    const batch = db.batch();
    const [pSnap, eSnap, beSnap, rSnap] = await Promise.all([
      db.collection('posts').where('authorId','==',req.params.id).get(),
      db.collection('qf_exams').where('userId','==',req.params.id).get(),
      db.collection('be_exams').where('userId','==',req.params.id).get(),
      db.collection('reports').where('reporterId','==',req.params.id).get()
    ]);
    [pSnap, eSnap, beSnap, rSnap].forEach(s => s.docs.forEach(d => batch.delete(d.ref)));
    batch.delete(db.collection('users').doc(req.params.id));
    await batch.commit();
    res.json({ ok: true });
  } catch(e) { console.error('[admin del user]', e); res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.get('/api/admin/posts', auth, adminOnly, async (req, res) => {
  try {
    const snap = await db.collection('posts').orderBy('createdAt','desc').get();
    const result = await Promise.all(snap.docs.map(async d => {
      const p = d.data();
      const uDoc = await db.collection('users').doc(p.authorId).get();
      const u = uDoc.exists ? uDoc.data() : {};
      return { id: d.id, title: p.title, published: p.published, createdAt: p.createdAt, username: u.username||'', displayName: u.displayName||'(탈퇴)' };
    }));
    res.json(result);
  } catch(e) { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.get('/api/admin/series-stats', auth, adminOnly, async (req, res) => {
  try {
    const [uSnap, pSnap, eSnap, beSnap] = await Promise.all([
      db.collection('users').get(),
      db.collection('posts').get(),
      db.collection('qf_exams').get(),
      db.collection('be_exams').get()
    ]);
    const scopeMap = {};
    eSnap.docs.forEach(d => { const s = d.data().scope||'(미지정)'; scopeMap[s] = (scopeMap[s]||0)+1; });
    const scopes = Object.entries(scopeMap).sort((a,b)=>b[1]-a[1]).map(([scope,count])=>({scope,count}));
    res.json({ scopes, userCount: uSnap.size, postCount: pSnap.size, examCount: eSnap.size, beExamCount: beSnap.size });
  } catch(e) { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.get('/api/admin/stats', auth, adminOnly, async (req, res) => {
  try {
    const [uSnap, eSnap] = await Promise.all([db.collection('users').get(), db.collection('qf_exams').get()]);
    res.json({ userCount: uSnap.size, examCount: eSnap.size });
  } catch(e) { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

/* ══ EXAMS (qf_exams) ══ */

const MAX_EXAMS = 30;

app.get('/api/exams', auth, async (req, res) => {
  try {
    const snap = await db.collection('qf_exams').where('userId','==',req.user.id).get();
    res.json(snap.docs.map(d => { const e = d.data(); return { id: d.id, title: e.title, scope: e.scope, difficulty: e.difficulty, createdAt: e.createdAt }; }).sort((a,b)=>b.createdAt-a.createdAt));
  } catch(e) { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.get('/api/exams/:id', auth, async (req, res) => {
  try {
    const doc = await db.collection('qf_exams').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: '시험지를 찾을 수 없습니다.' });
    const e = doc.data();
    if (e.userId !== req.user.id) return res.status(403).json({ error: '권한이 없습니다.' });
    res.json({ id: doc.id, _id: doc.id, userId: e.userId, title: e.title, scope: e.scope, difficulty: e.difficulty, extra: e.extra, content: e.content, createdAt: e.createdAt });
  } catch(e) { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.post('/api/exams', auth, async (req, res) => {
  try {
    const snap = await db.collection('qf_exams').where('userId','==',req.user.id).get();
    if (snap.size >= MAX_EXAMS) return res.status(400).json({ error: `최대 ${MAX_EXAMS}개까지만 저장됩니다.` });
    const { title, scope, difficulty, content, extra } = req.body;
    if (!title || !content) return res.status(400).json({ error: '제목과 내용을 입력하세요.' });
    const id = uuid();
    await db.collection('qf_exams').doc(id).set({ userId: req.user.id, title: String(title).slice(0,120), scope: String(scope||'').slice(0,200), difficulty: String(difficulty||'기본').slice(0,50), extra: String(extra||'').slice(0,500), content: String(content).slice(0,200000), createdAt: Date.now() });
    res.status(201).json({ id });
  } catch(e) { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.delete('/api/exams/:id', auth, async (req, res) => {
  try {
    const doc = await db.collection('qf_exams').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: '시험지를 찾을 수 없습니다.' });
    if (doc.data().userId !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: '권한이 없습니다.' });
    await db.collection('qf_exams').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.get('/api/admin/exams', auth, adminOnly, async (req, res) => {
  try {
    const snap = await db.collection('qf_exams').orderBy('createdAt','desc').get();
    const result = await Promise.all(snap.docs.map(async d => {
      const e = d.data();
      const uDoc = await db.collection('users').doc(e.userId).get();
      const u = uDoc.exists ? uDoc.data() : {};
      return { id: d.id, title: e.title, scope: e.scope, difficulty: e.difficulty, createdAt: e.createdAt, username: u.username||'(탈퇴)', displayName: u.displayName||'(탈퇴)' };
    }));
    res.json(result);
  } catch(e) { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

app.delete('/api/admin/exams/:id', auth, adminOnly, async (req, res) => {
  try {
    await db.collection('qf_exams').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: '서버 오류가 발생했습니다.' }); }
});

/* ══ CONFIG ══ */
app.get('/api/config', (req, res) => {
  res.json({ bytenodeUrl: process.env.BYTENODE_URL || '' });
});

/* ══ SPA fallback ══ */
app.get('*', (req, res) => res.sendFile(path.join(PUB, 'index.html')));

app.listen(PORT, () => console.log(`\n✅ bytenode109 실행 중 → http://localhost:${PORT}\n`));
