const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const multer = require('multer');
const XLSX = require('xlsx');
const db = require('./db');
require('./seed')();

const SECRET = process.env.JWT_SECRET || 'sqas-dev-secret';
const PORT = process.env.PORT || 3000;
const QR_MS = 45000;
const GRACE_MS = 10000;
const LATE_MIN = 15;
const DAY = 24 * 3600 * 1000;
const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DEFAULT_PASS = process.env.DEFAULT_SV_PASSWORD || '123456';
const ROLES = ['SV', 'GV', 'ADMIN'];
const STATUSES = ['Đang hoạt động', 'Tạm khóa'];
const LEAVE_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
const DATA_DIR = path.join(__dirname, '..', 'data');
const UP_DIR = path.join(DATA_DIR, 'uploads');
const BK_DIR = path.join(DATA_DIR, 'backups');
fs.mkdirSync(UP_DIR, { recursive: true });
fs.mkdirSync(BK_DIR, { recursive: true });

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const uploadOne = field => (req, res, next) =>
  upload.single(field)(req, res, err =>
    err ? res.status(400).json({ error: 'Tệp quá lớn hoặc không hợp lệ (tối đa 10MB)' }) : next());

// ---------- thời gian ----------
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const hms = d => `${hm(d)}:${pad(d.getSeconds())}`;
const addMin = (t, m) => {
  const [h, mi] = t.split(':').map(Number);
  const x = h * 60 + mi + m;
  return `${pad(Math.floor(x / 60))}:${pad(x % 60)}`;
};
const startOf = s => new Date(`${s.ngay}T${s.gio_bd}:00`).getTime();
const endOf = s => new Date(`${s.ngay}T${s.gio_kt}:00`).getTime();
function trangThaiBuoi(s, d = new Date()) {
  const today = ymd(d), t = hm(d);
  if (s.ngay < today || (s.ngay === today && t >= s.gio_kt)) return 'Đã kết thúc';
  if (s.ngay === today && t >= s.gio_bd) return 'Đang điểm danh';
  return 'Chưa diễn ra';
}

// ---------- tiện ích chung ----------
function fail(res, e, dupMsg = 'Dữ liệu đã tồn tại') {
  if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: dupMsg });
  if (String(e.code || '').startsWith('SQLITE_CONSTRAINT'))
    return res.status(400).json({ error: 'Dữ liệu tham chiếu không hợp lệ hoặc đang được sử dụng' });
  console.error(e);
  return res.status(500).json({ error: 'Lỗi máy chủ, vui lòng thử lại' });
}
const audit = (who, act, detail) =>
  db.prepare('INSERT INTO audit_log (thoi_gian, nguoi, hanh_dong, chi_tiet) VALUES (?,?,?,?)')
    .run(new Date().toISOString(), who, act, detail || null);
const readSheet = buf => {
  const wb = XLSX.read(buf, { type: 'buffer' });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
};
function sendXlsx(res, rows, sheet, filename) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), sheet);
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
  res.send(buf);
}
const nhomOf = ty => {
  if (ty === null) return 'Chưa có dữ liệu';
  if (ty >= 100) return '100%';
  if (ty >= 90) return '90–99%';
  if (ty >= 80) return '80–89%';
  return 'Dưới 80% (nguy cơ)';
};

// Tổng hợp chuyên cần từ danh sách trạng thái từng buổi
function tongHop(chiTiet) {
  const n = chiTiet.length;
  const dem = t => chiTiet.filter(x => x.tt === t).length;
  const coMat = dem('Có mặt'), diTre = dem('Đi trễ'), coPhep = dem('Có phép'), vang = dem('Vắng');
  const ty = n ? Math.round(((coMat + diTre) / n) * 1000) / 10 : null;
  return {
    tong: n, co_mat: coMat, di_tre: diTre, co_phep: coPhep, vang,
    ty_le: ty, nhom: nhomOf(ty), nguy_co: n > 0 && vang / n > 0.2,
  };
}

// ---------- xác thực & phân quyền ----------
function auth(...roles) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    const raw = h.startsWith('Bearer ') ? h.slice(7) : req.query.token;
    let p;
    try { p = jwt.verify(raw, SECRET); }
    catch { return res.status(401).json({ error: 'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại' }); }
    const u = db.prepare('SELECT id, ho_ten, vai_tro, trang_thai FROM users WHERE id = ?').get(p.id);
    if (!u || u.trang_thai !== 'Đang hoạt động')
      return res.status(401).json({ error: 'Tài khoản đã bị khóa hoặc không tồn tại' });
    if (roles.length && !roles.includes(u.vai_tro))
      return res.status(403).json({ error: 'Bạn không có quyền thực hiện thao tác này' });
    req.user = { id: u.id, vai_tro: u.vai_tro, ho_ten: u.ho_ten };
    next();
  };
}

// ---------- mã QR động ----------
function maQrMoi() {
  let c;
  do {
    c = 'SQ-' + Array.from(crypto.randomBytes(4), b => ALPH[b % ALPH.length]).join('');
  } while (db.prepare('SELECT 1 FROM sessions WHERE ma_qr = ? OR ma_qr_truoc = ?').get(c, c));
  return c;
}
function xoayMa(s) {
  const now = Date.now();
  if (now < s.qr_doi_luc + QR_MS) return s;
  db.prepare('UPDATE sessions SET ma_qr_truoc = ma_qr, ma_qr = ?, qr_doi_luc = ? WHERE id = ?')
    .run(maQrMoi(), now, s.id);
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(s.id);
}
const sessionOfGv = (id, gvId) => db.prepare(`
  SELECT s.*, c.gv_id FROM sessions s JOIN classes c ON c.id = s.class_id
  WHERE s.id = ? AND c.gv_id = ?`).get(id, gvId);

// ---------- realtime (SSE) ----------
const clients = new Map();
function bangDiemDanh(sessionId) {
  const sv = db.prepare(`
    SELECT u.id, u.ma, u.ho_ten, a.thoi_gian, a.hinh_thuc,
      COALESCE(a.trang_thai, CASE WHEN EXISTS (SELECT 1 FROM leave_requests l
        WHERE l.session_id = s.id AND l.sv_id = u.id AND l.trang_thai = 'Đã chấp thuận') THEN 'Có phép' END) AS trang_thai
    FROM sessions s
    JOIN enrollments e ON e.class_id = s.class_id
    JOIN users u ON u.id = e.sv_id
    LEFT JOIN attendance a ON a.session_id = s.id AND a.sv_id = u.id
    WHERE s.id = ? ORDER BY u.ma`).all(Number(sessionId));
  const dem = t => sv.filter(x => x.trang_thai === t).length;
  return {
    sv, tong: sv.length, co_mat: dem('Có mặt'), di_tre: dem('Đi trễ'),
    xin_phep: dem('Có phép'), vang: sv.filter(x => !x.trang_thai).length,
  };
}
function broadcast(sessionId) {
  const set = clients.get(String(sessionId));
  if (!set) return;
  const data = `data: ${JSON.stringify(bangDiemDanh(sessionId))}\n\n`;
  set.forEach(r => r.write(data));
}
function ghiDiemDanh(sessionId, svId, thoiGian, trangThai, hinhThuc) {
  db.prepare('INSERT INTO attendance (session_id, sv_id, thoi_gian, trang_thai, hinh_thuc) VALUES (?,?,?,?,?)')
    .run(sessionId, svId, thoiGian, trangThai, hinhThuc);
  broadcast(sessionId);
}

// ---------- thống kê chuyên cần ----------
function thongKeLop(classId, from, to) {
  const buoi = db.prepare(`SELECT id, ngay, gio_bd, gio_kt FROM sessions
    WHERE class_id = ? AND ngay BETWEEN ? AND ? ORDER BY ngay, gio_bd`)
    .all(classId, from, to).filter(s => endOf(s) <= Date.now());
  const svs = db.prepare(`SELECT u.id, u.ma, u.ho_ten FROM enrollments e
    JOIN users u ON u.id = e.sv_id WHERE e.class_id = ? ORDER BY u.ma`).all(classId);
  const att = new Map(db.prepare(`SELECT session_id, sv_id, trang_thai, hinh_thuc FROM attendance
    WHERE session_id IN (SELECT id FROM sessions WHERE class_id = ?)`).all(classId)
    .map(a => [a.session_id + ':' + a.sv_id, a]));
  const leave = new Set(db.prepare(`SELECT session_id, sv_id FROM leave_requests
    WHERE trang_thai = 'Đã chấp thuận' AND session_id IN (SELECT id FROM sessions WHERE class_id = ?)`)
    .all(classId).map(l => l.session_id + ':' + l.sv_id));
  const rows = svs.map(sv => {
    const chi_tiet = buoi.map(s => {
      const k = s.id + ':' + sv.id;
      const a = att.get(k);
      if (a) return { tt: a.trang_thai, ht: a.hinh_thuc };
      if (leave.has(k)) return { tt: 'Có phép', ht: 'Đơn xin phép' };
      return { tt: 'Vắng', ht: '—' };
    });
    return { sv_id: sv.id, ma: sv.ma, ho_ten: sv.ho_ten, chi_tiet, ...tongHop(chi_tiet) };
  });
  return { buoi, rows };
}
function tyLeTb(classId) {
  const vals = thongKeLop(classId, '0001-01-01', '9999-12-31').rows
    .map(r => r.ty_le).filter(v => v !== null);
  return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null;
}
function lichSuSv(svId) {
  const classes = db.prepare(`SELECT c.id, c.ma_lop, sub.ma_mon, sub.ten_mon, sub.so_tin_chi
    FROM enrollments e JOIN classes c ON c.id = e.class_id JOIN subjects sub ON sub.id = c.subject_id
    WHERE e.sv_id = ? ORDER BY c.ma_lop`).all(svId);
  return classes.map(c => {
    const t = thongKeLop(c.id, '0001-01-01', '9999-12-31');
    const me = t.rows.find(r => r.sv_id === svId);
    const chi = me ? me.chi_tiet : [];
    return { ...c, buoi: t.buoi, chi_tiet: chi, ...tongHop(chi) };
  });
}

// ---------- đăng nhập ----------
app.post('/api/login', (req, res) => {
  const { username = '', password = '' } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username));
  if (!u || !bcrypt.compareSync(String(password), u.mat_khau) || u.trang_thai !== 'Đang hoạt động')
    return res.status(401).json({ error: 'Tên đăng nhập hoặc mật khẩu không đúng' });
  const token = jwt.sign({ id: u.id, ho_ten: u.ho_ten }, SECRET, { expiresIn: '8h' });
  res.json({ token, user: { id: u.id, ho_ten: u.ho_ten, vai_tro: u.vai_tro } });
});

// ---------- danh mục dùng chung ----------
app.get('/api/danh-muc', auth('GV', 'ADMIN'), (req, res) => res.json({
  subjects: db.prepare('SELECT id, ma_mon, ten_mon, so_tin_chi FROM subjects ORDER BY ma_mon').all(),
  semesters: db.prepare('SELECT id, ma, ten, ngay_bd, ngay_kt FROM semesters ORDER BY ngay_bd DESC').all(),
  gvs: db.prepare("SELECT id, ma, ho_ten FROM users WHERE vai_tro = 'GV' ORDER BY ho_ten").all(),
}));

// =================== SINH VIÊN ===================
const LEAVE_SELECT = `
  SELECT l.id, l.ma, l.ly_do, l.file_name, l.trang_thai, l.phan_hoi, l.tao_luc,
    s.id AS session_id, s.ngay, s.gio_bd, s.gio_kt, c.ma_lop, c.gv_id, sub.ten_mon,
    u.ma AS ma_sv, u.ho_ten AS ten_sv
  FROM leave_requests l
  JOIN sessions s ON s.id = l.session_id
  JOIN classes c ON c.id = s.class_id
  JOIN subjects sub ON sub.id = c.subject_id
  JOIN users u ON u.id = l.sv_id`;

app.get('/api/sv/buoi', auth('SV'), (req, res) => {
  const d = new Date();
  const rows = db.prepare(`
    SELECT s.id, s.class_id, s.ngay, s.gio_bd, s.gio_kt, s.phong, c.ma_lop, sub.ma_mon, sub.ten_mon,
      sub.so_tin_chi, u.ho_ten AS gv, a.trang_thai, a.hinh_thuc,
      EXISTS (SELECT 1 FROM leave_requests l WHERE l.session_id = s.id AND l.sv_id = e.sv_id
        AND l.trang_thai = 'Đã chấp thuận') AS co_phep
    FROM enrollments e
    JOIN classes c ON c.id = e.class_id
    JOIN subjects sub ON sub.id = c.subject_id
    JOIN users u ON u.id = c.gv_id
    JOIN sessions s ON s.class_id = c.id
    LEFT JOIN attendance a ON a.session_id = s.id AND a.sv_id = e.sv_id
    WHERE e.sv_id = ? ORDER BY s.ngay, s.gio_bd`).all(req.user.id);
  res.json(rows.map(r => {
    const tt = trangThaiBuoi(r, d);
    const tt_sv = r.trang_thai || (r.co_phep ? 'Có phép' : tt === 'Đã kết thúc' ? 'Vắng' : 'Chưa điểm danh');
    return { ...r, tt_buoi: tt, tt_sv };
  }));
});

app.post('/api/sv/diem-danh', auth('SV'), (req, res) => {
  const ma = String(req.body?.ma || '').trim().toUpperCase();
  if (!/^SQ-[A-Z0-9]{4}$/.test(ma)) return res.status(400).json({ error: 'Mã không đúng định dạng SQ-XXXX' });
  let s = db.prepare('SELECT * FROM sessions WHERE ma_qr = ? OR ma_qr_truoc = ?').get(ma, ma);
  if (!s) return res.status(400).json({ error: 'Mã không hợp lệ, không ghi nhận điểm danh' });
  s = xoayMa(s);
  const hopLe = ma === s.ma_qr || (ma === s.ma_qr_truoc && Date.now() < s.qr_doi_luc + GRACE_MS);
  if (!hopLe) return res.status(400).json({ error: 'Mã QR đã hết hạn, vui lòng quét mã mới' });
  if (!db.prepare('SELECT 1 FROM enrollments WHERE class_id = ? AND sv_id = ?').get(s.class_id, req.user.id))
    return res.status(403).json({ error: 'Bạn không thuộc lớp của buổi học này' });
  if (db.prepare('SELECT 1 FROM attendance WHERE session_id = ? AND sv_id = ?').get(s.id, req.user.id))
    return res.status(409).json({ error: 'Bạn đã điểm danh buổi học này' });
  const d = new Date();
  if (trangThaiBuoi(s, d) !== 'Đang điểm danh')
    return res.status(400).json({ error: 'Buổi học hiện không trong thời gian điểm danh' });
  const trangThai = hm(d) > addMin(s.gio_bd, LATE_MIN) ? 'Đi trễ' : 'Có mặt';
  const thoiGian = hms(d);
  ghiDiemDanh(s.id, req.user.id, thoiGian, trangThai, 'QR Code');
  res.json({ thoi_gian: thoiGian, trang_thai: trangThai });
});

app.get('/api/sv/lich-su', auth('SV'), (req, res) => res.json(lichSuSv(req.user.id)));

app.get('/api/sv/lich-su/xlsx', auth('SV'), (req, res) => {
  const rows = [];
  lichSuSv(req.user.id).forEach(c => c.buoi.forEach((b, i) => rows.push({
    'Mã môn': c.ma_mon, 'Môn học': c.ten_mon, Ngày: b.ngay, Giờ: `${b.gio_bd}-${b.gio_kt}`,
    'Trạng thái': c.chi_tiet[i].tt, 'Hình thức': c.chi_tiet[i].ht,
  })));
  sendXlsx(res, rows, 'Lich su', 'lich-su-diem-danh.xlsx');
});

app.get('/api/sv/don', auth('SV'), (req, res) =>
  res.json(db.prepare(LEAVE_SELECT + ' WHERE l.sv_id = ? ORDER BY l.id DESC').all(req.user.id)));

app.post('/api/sv/don', auth('SV'), uploadOne('minh_chung'), (req, res) => {
  const sessionId = Number(req.body.session_id);
  const lyDo = String(req.body.ly_do || '').trim();
  if (!lyDo) return res.status(400).json({ error: 'Vui lòng nhập lý do xin phép' });
  if (lyDo.length > 300) return res.status(400).json({ error: 'Lý do tối đa 300 ký tự' });
  const s = db.prepare(`SELECT s.* FROM sessions s JOIN enrollments e ON e.class_id = s.class_id
    WHERE s.id = ? AND e.sv_id = ?`).get(sessionId, req.user.id);
  if (!s) return res.status(404).json({ error: 'Không tìm thấy buổi học của bạn' });
  const now = Date.now();
  const truoc = startOf(s) - now >= DAY;
  const sau = now >= endOf(s) && now - endOf(s) <= 2 * DAY;
  if (!truoc && !sau)
    return res.status(400).json({ error: 'Chỉ nộp đơn trước buổi học ít nhất 24 giờ, hoặc trong vòng 48 giờ sau buổi học' });
  if (db.prepare(`SELECT 1 FROM leave_requests WHERE session_id = ? AND sv_id = ?
    AND trang_thai IN ('Đang chờ duyệt','Đã chấp thuận')`).get(s.id, req.user.id))
    return res.status(409).json({ error: 'Bạn đã có đơn xin phép cho buổi học này' });

  let fileName = null, filePath = null;
  if (req.file) {
    if (!LEAVE_TYPES.includes(req.file.mimetype))
      return res.status(400).json({ error: 'Minh chứng chỉ chấp nhận PDF, JPG, PNG' });
    filePath = crypto.randomUUID() + path.extname(req.file.originalname).toLowerCase();
    fs.writeFileSync(path.join(UP_DIR, filePath), req.file.buffer);
    fileName = req.file.originalname;
  }
  const ma = '#NP-' + crypto.randomBytes(3).toString('hex').toUpperCase();
  db.prepare(`INSERT INTO leave_requests (ma, sv_id, session_id, ly_do, file_name, file_path, tao_luc)
    VALUES (?,?,?,?,?,?,?)`).run(ma, req.user.id, s.id, lyDo, fileName, filePath, new Date().toISOString());
  res.json({ ok: true, ma });
});

app.delete('/api/sv/don/:id', auth('SV'), (req, res) => {
  const l = db.prepare('SELECT * FROM leave_requests WHERE id = ? AND sv_id = ?').get(Number(req.params.id), req.user.id);
  if (!l) return res.status(404).json({ error: 'Không tìm thấy đơn' });
  if (l.trang_thai !== 'Đang chờ duyệt') return res.status(409).json({ error: 'Chỉ hủy được đơn đang chờ duyệt' });
  db.prepare('DELETE FROM leave_requests WHERE id = ?').run(l.id);
  if (l.file_path) try { fs.unlinkSync(path.join(UP_DIR, l.file_path)); } catch {}
  res.json({ ok: true });
});

// Tải minh chứng: chủ đơn, giảng viên của lớp, hoặc quản trị viên
app.get('/api/don/:id/minh-chung', auth(), (req, res) => {
  const l = db.prepare(`SELECT l.*, c.gv_id FROM leave_requests l
    JOIN sessions s ON s.id = l.session_id JOIN classes c ON c.id = s.class_id WHERE l.id = ?`)
    .get(Number(req.params.id));
  if (!l || !l.file_path) return res.status(404).json({ error: 'Không có minh chứng' });
  const ok = req.user.vai_tro === 'ADMIN'
    || (req.user.vai_tro === 'SV' && l.sv_id === req.user.id)
    || (req.user.vai_tro === 'GV' && l.gv_id === req.user.id);
  if (!ok) return res.status(403).json({ error: 'Bạn không có quyền xem tệp này' });
  res.download(path.join(UP_DIR, l.file_path), l.file_name);
});

// =================== GIẢNG VIÊN ===================
app.get('/api/gv/lop', auth('GV'), (req, res) => {
  const list = db.prepare(`SELECT c.id, c.ma_lop, c.ten_lop, sub.ma_mon, sub.ten_mon, sem.ten AS hoc_ky,
      (SELECT COUNT(*) FROM enrollments e WHERE e.class_id = c.id) AS so_sv
    FROM classes c JOIN subjects sub ON sub.id = c.subject_id JOIN semesters sem ON sem.id = c.semester_id
    WHERE c.gv_id = ? ORDER BY c.ma_lop`).all(req.user.id);
  res.json(list.map(c => ({ ...c, ty_le_tb: tyLeTb(c.id) })));
});

app.post('/api/gv/lop', auth('GV'), (req, res) => {
  const { ma_lop, ten_lop, subject_id, semester_id } = req.body || {};
  if (!String(ma_lop || '').trim() || !subject_id || !semester_id)
    return res.status(400).json({ error: 'Vui lòng nhập mã lớp, chọn môn học và học kỳ' });
  try {
    const r = db.prepare('INSERT INTO classes (ma_lop, ten_lop, subject_id, semester_id, gv_id) VALUES (?,?,?,?,?)')
      .run(String(ma_lop).trim(), ten_lop ? String(ten_lop).trim() : null, Number(subject_id), Number(semester_id), req.user.id);
    audit(req.user.ho_ten, 'Tạo lớp', String(ma_lop).trim());
    res.json({ id: r.lastInsertRowid });
  } catch (e) { fail(res, e, 'Mã lớp đã tồn tại'); }
});

app.post('/api/gv/lop/:id/sv', auth('GV'), uploadOne('file'), (req, res) => {
  const c = db.prepare('SELECT * FROM classes WHERE id = ? AND gv_id = ?').get(Number(req.params.id), req.user.id);
  if (!c) return res.status(404).json({ error: 'Không tìm thấy lớp học' });
  if (!req.file) return res.status(400).json({ error: 'Vui lòng chọn file Excel (.xlsx) hoặc CSV' });
  let rows;
  try { rows = readSheet(req.file.buffer); }
  catch { return res.status(400).json({ error: 'Không đọc được file, vui lòng chọn lại file đúng định dạng' }); }
  const need = ['Mã SV', 'Họ tên', 'Lớp', 'Email'];
  const headers = Object.keys(rows[0] || {});
  const thieu = need.filter(h => !headers.includes(h));
  if (thieu.length) return res.status(400).json({ error: `File thiếu cột bắt buộc: ${thieu.join(', ')}. Vui lòng chọn lại file.` });

  const ket = { them: 0, da_co: 0, bo_qua: [] };
  const seen = new Set();
  const findUser = db.prepare('SELECT id, vai_tro FROM users WHERE ma = ?');
  const insUser = db.prepare(`INSERT INTO users (ma, username, ho_ten, email, vai_tro, mat_khau) VALUES (?,?,?,?,'SV',?)`);
  const enroll = db.prepare('INSERT OR IGNORE INTO enrollments (class_id, sv_id) VALUES (?,?)');
  const hash = bcrypt.hashSync(DEFAULT_PASS, 10);
  db.transaction(() => {
    rows.forEach((r, i) => {
      const dong = i + 2;
      const ma = String(r['Mã SV'] ?? '').trim();
      const ten = String(r['Họ tên'] ?? '').trim();
      const email = String(r['Email'] ?? '').trim();
      if (!ma && !ten) return;
      if (!ma || !ten) return ket.bo_qua.push({ dong, ly_do: 'Thiếu mã SV hoặc họ tên' });
      if (seen.has(ma)) return ket.bo_qua.push({ dong, ly_do: `Trùng mã SV ${ma} trong file` });
      seen.add(ma);
      let u = findUser.get(ma);
      if (u && u.vai_tro !== 'SV') return ket.bo_qua.push({ dong, ly_do: `Mã ${ma} không phải sinh viên` });
      if (!u) {
        u = { id: insUser.run(ma, ma, ten, email || null, hash).lastInsertRowid };
        ket.them++;
      } else ket.da_co++;
      enroll.run(c.id, u.id);
    });
  })();
  res.json(ket);
});

app.get('/api/gv/buoi', auth('GV'), (req, res) => {
  const d = new Date();
  const rows = db.prepare(`SELECT s.*, c.ma_lop, sub.ten_mon FROM sessions s
    JOIN classes c ON c.id = s.class_id JOIN subjects sub ON sub.id = c.subject_id
    WHERE c.gv_id = ? ORDER BY s.ngay DESC, s.gio_bd DESC`).all(req.user.id);
  res.json(rows.map(r => ({
    id: r.id, class_id: r.class_id, ma_lop: r.ma_lop, ten_mon: r.ten_mon, ngay: r.ngay,
    gio_bd: r.gio_bd, gio_kt: r.gio_kt, phong: r.phong, ghi_chu: r.ghi_chu,
    trang_thai: trangThaiBuoi(r, d),
  })));
});

app.get('/api/gv/buoi/:id', auth('GV'), (req, res) => {
  const s = sessionOfGv(Number(req.params.id), req.user.id);
  if (!s) return res.status(404).json({ error: 'Không tìm thấy buổi học' });
  const info = db.prepare(`SELECT s.*, c.ma_lop, sub.ten_mon FROM sessions s
    JOIN classes c ON c.id = s.class_id JOIN subjects sub ON sub.id = c.subject_id WHERE s.id = ?`).get(s.id);
  res.json({ ...info, trang_thai: trangThaiBuoi(s) });
});

app.post('/api/gv/buoi', auth('GV'), (req, res) => {
  const { class_id, ngay, gio_bd, gio_kt, phong, ghi_chu } = req.body || {};
  if (!class_id || !ngay || !gio_bd || !gio_kt)
    return res.status(400).json({ error: 'Vui lòng chọn lớp, ngày và giờ học' });
  if (gio_kt <= gio_bd) return res.status(400).json({ error: 'Giờ kết thúc phải sau giờ bắt đầu' });
  if (!db.prepare('SELECT 1 FROM classes WHERE id = ? AND gv_id = ?').get(Number(class_id), req.user.id))
    return res.status(403).json({ error: 'Lớp này không thuộc giảng viên đang đăng nhập' });
  const info = db.prepare(`INSERT INTO sessions (class_id, ngay, gio_bd, gio_kt, phong, ghi_chu, ma_qr, qr_doi_luc)
    VALUES (?,?,?,?,?,?,?,?)`).run(Number(class_id), ngay, gio_bd, gio_kt, phong || null, ghi_chu || null, maQrMoi(), Date.now());
  res.json({ id: info.lastInsertRowid });
});

app.put('/api/gv/buoi/:id', auth('GV'), (req, res) => {
  const s = sessionOfGv(Number(req.params.id), req.user.id);
  if (!s) return res.status(404).json({ error: 'Không tìm thấy buổi học' });
  const { ngay, gio_bd, gio_kt, phong, ghi_chu } = req.body || {};
  if (!ngay || !gio_bd || !gio_kt) return res.status(400).json({ error: 'Vui lòng nhập ngày và giờ học' });
  if (gio_kt <= gio_bd) return res.status(400).json({ error: 'Giờ kết thúc phải sau giờ bắt đầu' });
  db.prepare('UPDATE sessions SET ngay = ?, gio_bd = ?, gio_kt = ?, phong = ?, ghi_chu = ? WHERE id = ?')
    .run(ngay, gio_bd, gio_kt, phong || null, ghi_chu || null, s.id);
  audit(req.user.ho_ten, 'Sửa buổi học', `Buổi #${s.id}: ${ngay} ${gio_bd}–${gio_kt}`);
  res.json({ ok: true });
});

app.delete('/api/gv/buoi/:id', auth('GV'), (req, res) => {
  const s = sessionOfGv(Number(req.params.id), req.user.id);
  if (!s) return res.status(404).json({ error: 'Không tìm thấy buổi học' });
  const n = db.prepare(`SELECT (SELECT COUNT(*) FROM attendance WHERE session_id = ?)
    + (SELECT COUNT(*) FROM leave_requests WHERE session_id = ?) AS n`).get(s.id, s.id).n;
  if (n > 0) return res.status(409).json({ error: 'Buổi học đã có điểm danh hoặc đơn xin phép, không được xóa' });
  db.prepare('DELETE FROM sessions WHERE id = ?').run(s.id);
  audit(req.user.ho_ten, 'Xóa buổi học', `Buổi #${s.id}`);
  res.json({ ok: true });
});

app.get('/api/gv/buoi/:id/qr', auth('GV'), async (req, res) => {
  const s0 = sessionOfGv(Number(req.params.id), req.user.id);
  if (!s0) return res.status(404).json({ error: 'Không tìm thấy buổi học' });
  const s = xoayMa(s0);
  const data = {
    code: s.ma_qr,
    con_lai: Math.max(0, Math.ceil((s.qr_doi_luc + QR_MS - Date.now()) / 1000)),
    trang_thai: trangThaiBuoi(s),
  };
  if (req.query.co !== s.ma_qr) data.png = await QRCode.toDataURL(s.ma_qr, { width: 320, margin: 1 });
  res.json(data);
});

app.get('/api/gv/buoi/:id/realtime', auth('GV'), (req, res) => {
  const s = sessionOfGv(Number(req.params.id), req.user.id);
  if (!s) return res.status(404).json({ error: 'Không tìm thấy buổi học' });
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const id = String(s.id);
  if (!clients.has(id)) clients.set(id, new Set());
  clients.get(id).add(res);
  res.write(`data: ${JSON.stringify(bangDiemDanh(id))}\n\n`);
  const ka = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ka); clients.get(id)?.delete(res); });
});

app.post('/api/gv/buoi/:id/thu-cong', auth('GV'), (req, res) => {
  const s = sessionOfGv(Number(req.params.id), req.user.id);
  if (!s) return res.status(404).json({ error: 'Không tìm thấy buổi học' });
  const svId = Number(req.body?.sv_id);
  if (!db.prepare('SELECT 1 FROM enrollments WHERE class_id = ? AND sv_id = ?').get(s.class_id, svId))
    return res.status(400).json({ error: 'Sinh viên không thuộc lớp này' });
  if (db.prepare('SELECT 1 FROM attendance WHERE session_id = ? AND sv_id = ?').get(s.id, svId))
    return res.status(409).json({ error: 'Sinh viên đã được điểm danh, không ghi nhận thêm' });
  ghiDiemDanh(s.id, svId, hms(new Date()), 'Có mặt', 'Giảng viên điểm danh tay');
  res.json({ ok: true });
});

app.post('/api/gv/buoi/:id/gia-lap', auth('GV'), (req, res) => {
  const s = sessionOfGv(Number(req.params.id), req.user.id);
  if (!s) return res.status(404).json({ error: 'Không tìm thấy buổi học' });
  if (trangThaiBuoi(s) !== 'Đang điểm danh') return res.status(409).json({ error: 'Buổi học không còn diễn ra' });
  const sv = db.prepare(`SELECT e.sv_id FROM enrollments e
    WHERE e.class_id = ? AND e.sv_id NOT IN (SELECT sv_id FROM attendance WHERE session_id = ?)
    ORDER BY RANDOM() LIMIT 1`).get(s.class_id, s.id);
  if (!sv) return res.status(409).json({ error: 'Tất cả sinh viên đã điểm danh' });
  ghiDiemDanh(s.id, sv.sv_id, hms(new Date()), 'Có mặt', 'QR Code (giả lập)');
  res.json({ ok: true });
});

app.get('/api/gv/buoi/:id/xuat', auth('GV'), (req, res) => {
  const s = sessionOfGv(Number(req.params.id), req.user.id);
  if (!s) return res.status(404).json({ error: 'Không tìm thấy buổi học' });
  const t = bangDiemDanh(s.id);
  sendXlsx(res, t.sv.map(x => ({
    MSSV: x.ma, 'Họ tên': x.ho_ten, 'Thời gian quét': x.thoi_gian || '',
    'Trạng thái': x.trang_thai || 'Chưa điểm danh', 'Hình thức': x.hinh_thuc || '',
  })), 'Diem danh', `diem-danh-${s.id}.xlsx`);
});

// Đơn xin phép (giảng viên)
app.get('/api/gv/don', auth('GV'), (req, res) => {
  const tt = req.query.trang_thai;
  let sql = LEAVE_SELECT + ' WHERE c.gv_id = ?';
  const args = [req.user.id];
  if (tt && tt !== 'all') { sql += ' AND l.trang_thai = ?'; args.push(tt); }
  res.json(db.prepare(sql + ' ORDER BY l.id DESC').all(...args));
});

app.patch('/api/gv/don/:id', auth('GV'), (req, res) => {
  const l = db.prepare(`${LEAVE_SELECT} WHERE l.id = ? AND c.gv_id = ?`).get(Number(req.params.id), req.user.id);
  if (!l) return res.status(404).json({ error: 'Không tìm thấy đơn' });
  if (l.trang_thai !== 'Đang chờ duyệt') return res.status(409).json({ error: 'Đơn đã được xử lý trước đó' });
  const hd = req.body?.hanh_dong;
  const phanHoi = String(req.body?.phan_hoi || '').trim();
  let trangThai;
  if (hd === 'duyet') trangThai = 'Đã chấp thuận';
  else if (hd === 'tu_choi') {
    if (!phanHoi) return res.status(400).json({ error: 'Vui lòng nhập lý do từ chối' });
    trangThai = 'Bị từ chối';
  } else return res.status(400).json({ error: 'Hành động không hợp lệ' });
  db.prepare('UPDATE leave_requests SET trang_thai = ?, phan_hoi = ? WHERE id = ?')
    .run(trangThai, phanHoi || null, l.id);
  audit(req.user.ho_ten, 'Xử lý đơn', `${l.ma}: ${trangThai}`);
  res.json({ ok: true, trang_thai: trangThai });
});

app.post('/api/gv/don/duyet-hang-loat', auth('GV'), (req, res) => {
  const ids = db.prepare(`SELECT l.id FROM leave_requests l JOIN sessions s ON s.id = l.session_id
    JOIN classes c ON c.id = s.class_id
    WHERE c.gv_id = ? AND l.trang_thai = 'Đang chờ duyệt' AND l.file_path IS NOT NULL`).all(req.user.id);
  const up = db.prepare(`UPDATE leave_requests SET trang_thai = 'Đã chấp thuận' WHERE id = ?`);
  db.transaction(() => ids.forEach(x => up.run(x.id)))();
  if (ids.length) audit(req.user.ho_ten, 'Duyệt hàng loạt đơn', `${ids.length} đơn`);
  res.json({ so: ids.length });
});

app.get('/api/gv/don/xuat', auth('GV'), (req, res) => {
  const rows = db.prepare(`${LEAVE_SELECT} WHERE c.gv_id = ? ORDER BY l.id DESC`).all(req.user.id);
  sendXlsx(res, rows.map(l => ({
    'Mã đơn': l.ma, MSSV: l.ma_sv, 'Họ tên': l.ten_sv, Lớp: l.ma_lop, Môn: l.ten_mon,
    Ngày: l.ngay, Giờ: `${l.gio_bd}-${l.gio_kt}`, 'Lý do': l.ly_do,
    'Trạng thái': l.trang_thai, 'Phản hồi': l.phan_hoi || '',
  })), 'Nghi phep', 'bao-cao-nghi-phep.xlsx');
});

// Thống kê chuyên cần
function thongKeParams(req, res) {
  const c = db.prepare('SELECT * FROM classes WHERE id = ? AND gv_id = ?').get(Number(req.query.class_id), req.user.id);
  if (!c) { res.status(403).json({ error: 'Lớp này không thuộc giảng viên đang đăng nhập' }); return null; }
  const { from, to } = req.query;
  if (!from || !to || from > to) {
    res.status(400).json({ error: 'Tiêu chí không hợp lệ, vui lòng kiểm tra và nhập lại' });
    return null;
  }
  return { c, from, to };
}
app.get('/api/gv/thong-ke', auth('GV'), (req, res) => {
  const p = thongKeParams(req, res);
  if (!p) return;
  const t = thongKeLop(p.c.id, p.from, p.to);
  res.json({ so_buoi: t.buoi.length, rows: t.rows });
});
app.get('/api/gv/thong-ke/xlsx', auth('GV'), (req, res) => {
  const p = thongKeParams(req, res);
  if (!p) return;
  const rows = thongKeLop(p.c.id, p.from, p.to).rows.map(r => ({
    MSSV: r.ma, 'Họ tên': r.ho_ten, 'Có mặt': r.co_mat, 'Đi trễ': r.di_tre, 'Có phép': r.co_phep,
    'Vắng': r.vang, 'Tỷ lệ (%)': r.ty_le ?? '', Nhóm: r.nhom, 'Nguy cơ cấm thi': r.nguy_co ? 'Có' : 'Không',
  }));
  sendXlsx(res, rows, 'ChuyenCan', 'chuyen-can.xlsx');
});

// =================== QUẢN TRỊ VIÊN ===================
app.get('/api/admin/users', auth('ADMIN'), (req, res) =>
  res.json(db.prepare('SELECT id, ma, ho_ten, email, vai_tro, trang_thai FROM users ORDER BY vai_tro, ma').all()));

app.post('/api/admin/users', auth('ADMIN'), (req, res) => {
  const { ma, ho_ten, email, vai_tro } = req.body || {};
  if (!String(ma || '').trim() || !String(ho_ten || '').trim() || !vai_tro)
    return res.status(400).json({ error: 'Vui lòng nhập mã số, họ tên và vai trò' });
  if (!ROLES.includes(vai_tro)) return res.status(400).json({ error: 'Vai trò không hợp lệ' });
  const maTrim = String(ma).trim();
  if (db.prepare('SELECT 1 FROM users WHERE ma = ? OR username = ?').get(maTrim, maTrim))
    return res.status(409).json({ error: 'Mã số đã tồn tại, không tạo tài khoản' });
  const tmp = crypto.randomBytes(4).toString('hex');
  try {
    db.prepare('INSERT INTO users (ma, username, ho_ten, email, vai_tro, mat_khau) VALUES (?,?,?,?,?,?)')
      .run(maTrim, maTrim, String(ho_ten).trim(), email ? String(email).trim() : null, vai_tro, bcrypt.hashSync(tmp, 10));
    audit(req.user.ho_ten, 'Tạo tài khoản', `${maTrim} (${vai_tro})`);
    res.json({ ok: true, mat_khau_tam: tmp });
  } catch (e) { fail(res, e, 'Mã số đã tồn tại, không tạo tài khoản'); }
});

app.patch('/api/admin/users/:id', auth('ADMIN'), (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  if (id === req.user.id && (b.vai_tro !== undefined || b.trang_thai !== undefined))
    return res.status(400).json({ error: 'Không thể tự thay đổi quyền hoặc trạng thái của chính mình' });
  const sets = [], args = [];
  if (b.ho_ten !== undefined) {
    const v = String(b.ho_ten).trim();
    if (!v) return res.status(400).json({ error: 'Họ tên không được để trống' });
    sets.push('ho_ten = ?'); args.push(v);
  }
  if (b.email !== undefined) { sets.push('email = ?'); args.push(String(b.email).trim() || null); }
  if (b.vai_tro !== undefined) {
    if (!ROLES.includes(b.vai_tro)) return res.status(400).json({ error: 'Vai trò không hợp lệ' });
    sets.push('vai_tro = ?'); args.push(b.vai_tro);
  }
  if (b.trang_thai !== undefined) {
    if (!STATUSES.includes(b.trang_thai)) return res.status(400).json({ error: 'Trạng thái không hợp lệ' });
    sets.push('trang_thai = ?'); args.push(b.trang_thai);
  }
  if (!sets.length) return res.json({ ok: true });
  const r = db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  if (!r.changes) return res.status(404).json({ error: 'Không tìm thấy người dùng' });
  audit(req.user.ho_ten, 'Cập nhật người dùng', `ID ${id}: ${JSON.stringify(b)}`);
  res.json({ ok: true });
});

// Danh mục: môn học, lớp học phần, học kỳ
const LABEL = {
  ma_mon: 'Mã môn', ten_mon: 'Tên môn', so_tin_chi: 'Số tín chỉ', ma: 'Mã học kỳ', ten: 'Tên học kỳ',
  ngay_bd: 'Ngày bắt đầu', ngay_kt: 'Ngày kết thúc', ma_lop: 'Mã lớp', ten_lop: 'Tên lớp',
  subject_id: 'Môn học', semester_id: 'Học kỳ', gv_id: 'Giảng viên phụ trách',
};
const CRUD = {
  subjects: {
    name: 'môn học', table: 'subjects',
    fields: ['ma_mon', 'ten_mon', 'so_tin_chi'], nums: ['so_tin_chi'], required: ['ma_mon', 'ten_mon', 'so_tin_chi'],
    list: () => db.prepare('SELECT * FROM subjects ORDER BY ma_mon').all(),
    inUse: id => db.prepare('SELECT COUNT(*) AS n FROM classes WHERE subject_id = ?').get(id).n,
    check: d => (d.so_tin_chi > 0 ? null : 'Số tín chỉ phải lớn hơn 0'),
  },
  semesters: {
    name: 'học kỳ', table: 'semesters',
    fields: ['ma', 'ten', 'ngay_bd', 'ngay_kt'], nums: [], required: ['ma', 'ten', 'ngay_bd', 'ngay_kt'],
    list: () => db.prepare('SELECT * FROM semesters ORDER BY ngay_bd DESC').all(),
    inUse: id => db.prepare('SELECT COUNT(*) AS n FROM classes WHERE semester_id = ?').get(id).n,
    check: d => (d.ngay_kt > d.ngay_bd ? null : 'Ngày kết thúc phải sau ngày bắt đầu'),
  },
  classes: {
    name: 'lớp học phần', table: 'classes',
    fields: ['ma_lop', 'ten_lop', 'subject_id', 'semester_id', 'gv_id'],
    nums: ['subject_id', 'semester_id', 'gv_id'], required: ['ma_lop', 'subject_id', 'semester_id', 'gv_id'],
    list: () => db.prepare(`SELECT c.*, sub.ten_mon, sem.ten AS ten_hoc_ky, u.ho_ten AS ten_gv
      FROM classes c JOIN subjects sub ON sub.id = c.subject_id JOIN semesters sem ON sem.id = c.semester_id
      JOIN users u ON u.id = c.gv_id ORDER BY c.ma_lop`).all(),
    inUse: id => db.prepare(`SELECT (SELECT COUNT(*) FROM sessions WHERE class_id = ?)
      + (SELECT COUNT(*) FROM enrollments WHERE class_id = ?) AS n`).get(id, id).n,
  },
};

function parseBody(cfg, body) {
  const data = {};
  for (const f of cfg.fields) {
    const v = body?.[f];
    if (v === undefined || v === null || String(v).trim() === '') {
      if (cfg.required.includes(f)) return { error: `Vui lòng nhập ${LABEL[f]}` };
      data[f] = null;
      continue;
    }
    data[f] = cfg.nums.includes(f) ? Number(v) : String(v).trim();
  }
  if (cfg.check) {
    const e = cfg.check(data);
    if (e) return { error: e };
  }
  return { data };
}

function saveCrud(name, req, res, id) {
  const cfg = CRUD[name];
  const { data, error } = parseBody(cfg, req.body);
  if (error) return res.status(400).json({ error });
  try {
    if (id) {
      db.prepare(`UPDATE ${cfg.table} SET ${cfg.fields.map(f => f + ' = ?').join(', ')} WHERE id = ?`)
        .run(...cfg.fields.map(f => data[f]), id);
    } else {
      db.prepare(`INSERT INTO ${cfg.table} (${cfg.fields.join(', ')}) VALUES (${cfg.fields.map(() => '?').join(', ')})`)
        .run(...cfg.fields.map(f => data[f]));
    }
    audit(req.user.ho_ten, (id ? 'Sửa ' : 'Thêm ') + cfg.name, JSON.stringify(data));
    res.json({ ok: true });
  } catch (e) { fail(res, e, 'Mã đã tồn tại, không thể lưu trùng'); }
}

function removeCrud(name, ids, res, who) {
  const cfg = CRUD[name];
  let xoa = 0, khong = 0;
  for (const id of ids) {
    if (cfg.inUse(id) > 0) { khong++; continue; }
    db.prepare(`DELETE FROM ${cfg.table} WHERE id = ?`).run(id);
    xoa++;
  }
  if (xoa) audit(who, `Xóa ${cfg.name}`, `${xoa} mục`);
  if (ids.length === 1 && khong === 1)
    return res.status(409).json({ error: 'Mục này đang được sử dụng nên không được xóa' });
  res.json({ xoa, khong_xoa: khong });
}

for (const name of Object.keys(CRUD)) {
  const base = `/api/admin/${name}`;
  app.get(base, auth('ADMIN'), (req, res) => res.json(CRUD[name].list()));
  app.post(base, auth('ADMIN'), (req, res) => saveCrud(name, req, res, null));
  app.put(`${base}/:id`, auth('ADMIN'), (req, res) => saveCrud(name, req, res, Number(req.params.id)));
  app.delete(`${base}/:id`, auth('ADMIN'), (req, res) =>
    removeCrud(name, [Number(req.params.id)], res, req.user.ho_ten));
  app.post(`${base}/xoa-hang-loat`, auth('ADMIN'), (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ error: 'Chọn ít nhất một mục để xóa' });
    removeCrud(name, ids, res, req.user.ho_ten);
  });
}

app.post('/api/admin/subjects/import', auth('ADMIN'), uploadOne('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Vui lòng chọn file CSV' });
  let rows;
  try { rows = readSheet(req.file.buffer); }
  catch { return res.status(400).json({ error: 'Không đọc được file, vui lòng kiểm tra định dạng' }); }
  const need = ['ma_mon', 'ten_mon', 'so_tin_chi'];
  const headers = Object.keys(rows[0] || {});
  const thieu = need.filter(h => !headers.includes(h));
  if (thieu.length) return res.status(400).json({ error: `File sai định dạng, thiếu cột: ${thieu.join(', ')}` });
  const ins = db.prepare('INSERT INTO subjects (ma_mon, ten_mon, so_tin_chi) VALUES (?,?,?)');
  let them = 0;
  const boQua = [];
  rows.forEach((r, i) => {
    const ma = String(r.ma_mon ?? '').trim();
    const ten = String(r.ten_mon ?? '').trim();
    const tc = Number(r.so_tin_chi);
    if (!ma || !ten || !(tc > 0)) return boQua.push({ dong: i + 2, ly_do: 'Thiếu mã, tên hoặc số tín chỉ không hợp lệ' });
    try { ins.run(ma, ten, tc); them++; }
    catch { boQua.push({ dong: i + 2, ly_do: `Mã ${ma} đã tồn tại` }); }
  });
  audit(req.user.ho_ten, 'Nhập môn học từ file', `${them} môn`);
  res.json({ them, bo_qua: boQua });
});

// Sao lưu & nhật ký
app.post('/api/admin/backup', auth('ADMIN'), async (req, res) => {
  const ten = `sqas-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
  const dest = path.join(BK_DIR, ten);
  const ghi = (size, tt) => db.prepare(`INSERT INTO backups (ten, loai, dung_luong, tao_luc, nguoi, trang_thai)
    VALUES (?,?,?,?,?,?)`).run(ten, 'Toàn phần', size, new Date().toISOString(), req.user.ho_ten, tt);
  try {
    await db.backup(dest);
    ghi(fs.statSync(dest).size, 'Thành công');
    audit(req.user.ho_ten, 'Sao lưu', ten);
    res.json({ ok: true, ten });
  } catch (e) {
    console.error(e);
    ghi(0, 'Thất bại');
    res.status(500).json({ error: 'Sao lưu thất bại, vui lòng thử lại' });
  }
});

app.get('/api/admin/backups', auth('ADMIN'), (req, res) =>
  res.json(db.prepare('SELECT * FROM backups ORDER BY id DESC').all()));

app.get('/api/admin/backups/:id/tai', auth('ADMIN'), (req, res) => {
  const b = db.prepare('SELECT * FROM backups WHERE id = ? AND trang_thai = ?').get(Number(req.params.id), 'Thành công');
  if (!b) return res.status(404).json({ error: 'Không tìm thấy bản sao lưu' });
  audit(req.user.ho_ten, 'Tải bản sao lưu', b.ten);
  res.download(path.join(BK_DIR, b.ten), b.ten);
});

app.get('/api/admin/audit', auth('ADMIN'), (req, res) =>
  res.json(db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all()));


// =================== ĐỢT 1: CẢNH BÁO & KHIẾU NẠI ===================
db.exec(`CREATE TABLE IF NOT EXISTS complaints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sv_id INTEGER NOT NULL REFERENCES users(id),
  class_id INTEGER NOT NULL REFERENCES classes(id),
  noi_dung TEXT NOT NULL,
  tao_luc TEXT NOT NULL,
  trang_thai TEXT NOT NULL DEFAULT 'Chờ xử lý',
  phan_hoi TEXT
)`);
db.exec(`CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sv_id INTEGER NOT NULL REFERENCES users(id),
  noi_dung TEXT NOT NULL,
  tao_luc TEXT NOT NULL,
  da_doc INTEGER NOT NULL DEFAULT 0
)`);

app.get('/api/sv/thong-bao', auth('SV'), (req, res) =>
  res.json(db.prepare('SELECT * FROM notifications WHERE sv_id = ? ORDER BY id DESC LIMIT 50').all(req.user.id)));

app.post('/api/gv/lop/:id/canh-bao', auth('GV'), (req, res) => {
  const c = db.prepare('SELECT * FROM classes WHERE id = ? AND gv_id = ?').get(Number(req.params.id), req.user.id);
  if (!c) return res.status(404).json({ error: 'Không tìm thấy lớp học' });
  const t = thongKeLop(c.id, '0001-01-01', '9999-12-31');
  const tb = t.buoi.length;
  const ds = t.rows.filter(r => r.vang > 0);
  if (!ds.length) return res.json({ so: 0, message: 'Không có sinh viên vắng' });
  const now = new Date().toISOString();
  const ins = db.prepare('INSERT INTO notifications (sv_id, noi_dung, tao_luc) VALUES (?,?,?)');
  db.transaction(() => ds.forEach(r => ins.run(
    r.sv_id,
    `Bạn đã vắng ${r.vang}/${tb} buổi của lớp ${c.ma_lop} (không phép). Vui lòng liên hệ giảng viên.`,
    now)))();
  audit(req.user.ho_ten, 'Cảnh báo vắng', `${c.ma_lop}: ${ds.length} sinh viên`);
  res.json({ so: ds.length });
});

app.post('/api/sv/khieu-nai', auth('SV'), (req, res) => {
  const classId = Number(req.body?.class_id);
  const noiDung = String(req.body?.noi_dung || '').trim();
  if (!noiDung) return res.status(400).json({ error: 'Vui lòng nhập nội dung khiếu nại' });
  if (noiDung.length > 500) return res.status(400).json({ error: 'Nội dung tối đa 500 ký tự' });
  const enrolled = db.prepare('SELECT 1 FROM enrollments WHERE class_id = ? AND sv_id = ?').get(classId, req.user.id);
  if (!enrolled) return res.status(403).json({ error: 'Bạn không thuộc lớp này' });
  const cls = db.prepare('SELECT ma_lop FROM classes WHERE id = ?').get(classId);
  const last = db.prepare(`SELECT tao_luc FROM notifications WHERE sv_id = ? AND noi_dung LIKE ?
    ORDER BY id DESC LIMIT 1`).get(req.user.id, `%lớp ${cls.ma_lop}%`);
  if (!last) return res.status(400).json({ error: 'Chưa có kết quả vắng của lớp này để khiếu nại' });
  if (Date.now() - new Date(last.tao_luc).getTime() > 2 * DAY)
    return res.status(400).json({ error: 'Đã quá 48 giờ kể từ khi có kết quả, không thể khiếu nại' });
  db.prepare('INSERT INTO complaints (sv_id, class_id, noi_dung, tao_luc) VALUES (?,?,?,?)')
    .run(req.user.id, classId, noiDung, new Date().toISOString());
  res.json({ ok: true });
});

app.get('/api/sv/khieu-nai', auth('SV'), (req, res) => res.json(db.prepare(`
  SELECT k.*, c.ma_lop FROM complaints k JOIN classes c ON c.id = k.class_id
  WHERE k.sv_id = ? ORDER BY k.id DESC`).all(req.user.id)));

app.get('/api/gv/khieu-nai', auth('GV'), (req, res) => res.json(db.prepare(`
  SELECT k.*, c.ma_lop, u.ma AS ma_sv, u.ho_ten AS ten_sv
  FROM complaints k JOIN classes c ON c.id = k.class_id JOIN users u ON u.id = k.sv_id
  WHERE c.gv_id = ? ORDER BY k.id DESC`).all(req.user.id)));

app.patch('/api/gv/khieu-nai/:id', auth('GV'), (req, res) => {
  const k = db.prepare(`SELECT k.* FROM complaints k JOIN classes c ON c.id = k.class_id
    WHERE k.id = ? AND c.gv_id = ?`).get(Number(req.params.id), req.user.id);
  if (!k) return res.status(404).json({ error: 'Không tìm thấy khiếu nại' });
  const phanHoi = String(req.body?.phan_hoi || '').trim();
  if (!phanHoi) return res.status(400).json({ error: 'Vui lòng nhập phản hồi' });
  db.prepare("UPDATE complaints SET trang_thai = 'Đã xử lý', phan_hoi = ? WHERE id = ?").run(phanHoi, k.id);
  audit(req.user.ho_ten, 'Phản hồi khiếu nại', `#${k.id}`);
  res.json({ ok: true });
});

const port = process.env.PORT || PORT;
app.listen(port, () => console.log(`SQAS đang chạy tại http://localhost:${port}`));