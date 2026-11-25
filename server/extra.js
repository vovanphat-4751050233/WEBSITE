const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const XLSX = require('xlsx');

const UP_DIR = path.join(__dirname, '..', 'data', 'uploads');
fs.mkdirSync(UP_DIR, { recursive: true });

const DAY = 24 * 3600 * 1000;
const DEFAULT_SV_PASSWORD = process.env.DEFAULT_SV_PASSWORD || '123456';
const LEAVE_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const uploadOne = field => (req, res, next) =>
  upload.single(field)(req, res, err =>
    err ? res.status(400).json({ error: 'Tệp quá lớn hoặc không hợp lệ (tối đa 10MB)' }) : next());

const sessionStart = s => new Date(`${s.ngay}T${s.gio_bd}:00`).getTime();
const sessionEnd = s => new Date(`${s.ngay}T${s.gio_kt}:00`).getTime();
const readSheet = buf => {
  const wb = XLSX.read(buf, { type: 'buffer' });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
};
const nhomOf = ty => {
  if (ty === null) return 'Chưa có dữ liệu';
  if (ty >= 100) return '100%';
  if (ty >= 90) return '90–99%';
  if (ty >= 80) return '80–89%';
  return 'Dưới 80% (nguy cơ)';
};

module.exports = function mountExtra(app, db, auth) {
  db.exec(`CREATE TABLE IF NOT EXISTS leave_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ma TEXT UNIQUE NOT NULL,
    sv_id INTEGER NOT NULL REFERENCES users(id),
    session_id INTEGER NOT NULL REFERENCES sessions(id),
    ly_do TEXT NOT NULL,
    file_name TEXT,
    file_path TEXT,
    trang_thai TEXT NOT NULL DEFAULT 'Đang chờ duyệt',
    phan_hoi TEXT,
    tao_luc TEXT NOT NULL
  )`);

  function dbErr(res, e, dupMsg) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: dupMsg });
    if (e.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') return res.status(400).json({ error: 'Dữ liệu tham chiếu không tồn tại' });
    if (String(e.code || '').startsWith('SQLITE_CONSTRAINT')) return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });
    console.error(e);
    return res.status(500).json({ error: 'Lỗi máy chủ, vui lòng thử lại' });
  }

  const classOfGv = (id, gvId) =>
    db.prepare('SELECT * FROM classes WHERE id = ? AND gv_id = ?').get(id, gvId);

  const LEAVE_SELECT = `
    SELECT l.id, l.ma, l.ly_do, l.file_name, l.trang_thai, l.phan_hoi, l.tao_luc,
      s.id AS session_id, s.ngay, s.gio_bd, s.gio_kt, c.ma_lop, c.gv_id, sub.ten_mon,
      u.ma AS ma_sv, u.ho_ten AS ten_sv
    FROM leave_requests l
    JOIN sessions s ON s.id = l.session_id
    JOIN classes c ON c.id = s.class_id
    JOIN subjects sub ON sub.id = c.subject_id
    JOIN users u ON u.id = l.sv_id`;

  // ---------- Sinh viên: đơn xin phép (UC-08) ----------
  app.get('/api/sv/don', auth('SV'), (req, res) => {
    res.json(db.prepare(LEAVE_SELECT + ' WHERE l.sv_id = ? ORDER BY l.id DESC').all(req.user.id));
  });

  app.post('/api/sv/don', auth('SV'), uploadOne('minh_chung'), (req, res) => {
    const sessionId = Number(req.body.session_id);
    const lyDo = String(req.body.ly_do || '').trim();
    if (!lyDo) return res.status(400).json({ error: 'Vui lòng nhập lý do xin phép' });
    if (lyDo.length > 300) return res.status(400).json({ error: 'Lý do tối đa 300 ký tự' });

    const s = db.prepare(`SELECT s.* FROM sessions s
      JOIN enrollments e ON e.class_id = s.class_id
      WHERE s.id = ? AND e.sv_id = ?`).get(sessionId, req.user.id);
    if (!s) return res.status(404).json({ error: 'Không tìm thấy buổi học của bạn' });

    const now = Date.now();
    const truoc = sessionStart(s) - now >= DAY;
    const sau = now >= sessionEnd(s) && now - sessionEnd(s) <= 2 * DAY;
    if (!truoc && !sau)
      return res.status(400).json({ error: 'Chỉ nộp đơn trước buổi học ít nhất 24 giờ, hoặc trong vòng 48 giờ sau buổi học' });

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

  // Tải minh chứng: SV chủ đơn, GV của lớp, hoặc quản trị viên
  app.get('/api/don/:id/minh-chung', auth(), (req, res) => {
    const l = db.prepare(`SELECT l.*, c.gv_id FROM leave_requests l
      JOIN sessions s ON s.id = l.session_id JOIN classes c ON c.id = s.class_id
      WHERE l.id = ?`).get(Number(req.params.id));
    if (!l || !l.file_path) return res.status(404).json({ error: 'Không có minh chứng' });
    const ok = req.user.vai_tro === 'ADMIN'
      || (req.user.vai_tro === 'SV' && l.sv_id === req.user.id)
      || (req.user.vai_tro === 'GV' && l.gv_id === req.user.id);
    if (!ok) return res.status(403).json({ error: 'Bạn không có quyền xem tệp này' });
    res.download(path.join(UP_DIR, l.file_path), l.file_name);
  });

  // ---------- Giảng viên: duyệt đơn (UC-08) ----------
  app.get('/api/gv/don', auth('GV'), (req, res) => {
    const tt = req.query.trang_thai;
    let sql = LEAVE_SELECT + ' WHERE c.gv_id = ?';
    const args = [req.user.id];
    if (tt && tt !== 'all') { sql += ' AND l.trang_thai = ?'; args.push(tt); }
    sql += ' ORDER BY l.id DESC';
    res.json(db.prepare(sql).all(...args));
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
    res.json({ ok: true, trang_thai: trangThai });
  });

  // ---------- Danh mục dùng chung (chọn trong form) ----------
  app.get('/api/danh-muc', auth('GV', 'ADMIN'), (req, res) => {
    res.json({
      subjects: db.prepare('SELECT id, ma_mon, ten_mon, so_tin_chi FROM subjects ORDER BY ma_mon').all(),
      semesters: db.prepare('SELECT id, ma, ten, ngay_bd, ngay_kt FROM semesters ORDER BY ngay_bd DESC').all(),
      gvs: db.prepare("SELECT id, ma, ho_ten FROM users WHERE vai_tro = 'GV' ORDER BY ho_ten").all(),
    });
  });

  // ---------- Giảng viên: tạo lớp & nhập Excel (UC-05) ----------
  app.post('/api/gv/lop', auth('GV'), (req, res) => {
    const { ma_lop, ten_lop, subject_id, semester_id } = req.body || {};
    if (!ma_lop || !subject_id || !semester_id)
      return res.status(400).json({ error: 'Vui lòng nhập mã lớp, chọn môn học và học kỳ' });
    try {
      const r = db.prepare(`INSERT INTO classes (ma_lop, ten_lop, subject_id, semester_id, gv_id)
        VALUES (?,?,?,?,?)`).run(String(ma_lop).trim(), ten_lop || null, Number(subject_id), Number(semester_id), req.user.id);
      res.json({ id: r.lastInsertRowid });
    } catch (e) { dbErr(res, e, 'Mã lớp đã tồn tại'); }
  });

  app.post('/api/gv/lop/:id/sv', auth('GV'), uploadOne('file'), (req, res) => {
    const c = classOfGv(Number(req.params.id), req.user.id);
    if (!c) return res.status(404).json({ error: 'Không tìm thấy lớp học' });
    if (!req.file) return res.status(400).json({ error: 'Vui lòng chọn file Excel (.xlsx) hoặc CSV' });

    let rows;
    try { rows = readSheet(req.file.buffer); }
    catch { return res.status(400).json({ error: 'Không đọc được file, vui lòng chọn lại file đúng định dạng' }); }

    const need = ['Mã SV', 'Họ tên', 'Lớp', 'Email'];
    const headers = Object.keys(rows[0] || {});
    const thieu = need.filter(h => !headers.includes(h));
    if (thieu.length)
      return res.status(400).json({ error: `File thiếu cột bắt buộc: ${thieu.join(', ')}. Vui lòng chọn lại file.` });

    const ket = { them: 0, da_co: 0, bo_qua: [] };
    const seen = new Set();
    const findUser = db.prepare('SELECT id, vai_tro FROM users WHERE ma = ?');
    const insUser = db.prepare(`INSERT INTO users (ma, username, ho_ten, email, vai_tro, mat_khau)
      VALUES (?,?,?,?,'SV',?)`);
    const enroll = db.prepare('INSERT OR IGNORE INTO enrollments (class_id, sv_id) VALUES (?,?)');
    const hash = bcrypt.hashSync(DEFAULT_SV_PASSWORD, 10);

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

  // ---------- Giảng viên: thống kê chuyên cần & xuất Excel (UC-10) ----------
  function thongKe(classId, from, to) {
    const sessions = db.prepare('SELECT * FROM sessions WHERE class_id = ? AND ngay BETWEEN ? AND ? ORDER BY ngay, gio_bd')
      .all(classId, from, to)
      .filter(s => sessionEnd(s) <= Date.now());
    const svs = db.prepare(`SELECT u.id, u.ma, u.ho_ten FROM enrollments e
      JOIN users u ON u.id = e.sv_id WHERE e.class_id = ? ORDER BY u.ma`).all(classId);
    const att = new Map(db.prepare(`SELECT session_id, sv_id, trang_thai FROM attendance
      WHERE session_id IN (SELECT id FROM sessions WHERE class_id = ?)`).all(classId)
      .map(a => [a.session_id + ':' + a.sv_id, a.trang_thai]));
    const leave = new Set(db.prepare(`SELECT session_id, sv_id FROM leave_requests
      WHERE trang_thai = 'Đã chấp thuận' AND session_id IN (SELECT id FROM sessions WHERE class_id = ?)`)
      .all(classId).map(l => l.session_id + ':' + l.sv_id));

    const rows = svs.map(sv => {
      let coMat = 0, diTre = 0, coPhep = 0, vang = 0;
      sessions.forEach(s => {
        const k = s.id + ':' + sv.id;
        const tt = att.get(k);
        if (tt === 'Có mặt') coMat++;
        else if (tt === 'Đi trễ') diTre++;
        else if (tt === 'Có phép' || leave.has(k)) coPhep++;
        else vang++;
      });
      const tong = sessions.length;
      const tyLe = tong ? Math.round((coMat + diTre) / tong * 1000) / 10 : null;
      return {
        ma: sv.ma, ho_ten: sv.ho_ten, tong, co_mat: coMat, di_tre: diTre, co_phep: coPhep, vang,
        ty_le: tyLe, nhom: nhomOf(tyLe), nguy_co: tong > 0 && vang / tong > 0.2,
      };
    });
    return { tong_buoi: sessions.length, rows };
  }

  function thongKeParams(req, res) {
    const c = classOfGv(Number(req.query.class_id), req.user.id);
    if (!c) { res.status(403).json({ error: 'Lớp này không thuộc giảng viên đang đăng nhập' }); return null; }
    const { from, to } = req.query;
    if (!from || !to || from > to) { res.status(400).json({ error: 'Tiêu chí không hợp lệ, vui lòng kiểm tra và nhập lại' }); return null; }
    return { c, from, to };
  }

  app.get('/api/gv/thong-ke', auth('GV'), (req, res) => {
    const p = thongKeParams(req, res);
    if (p) res.json(thongKe(p.c.id, p.from, p.to));
  });

  app.get('/api/gv/thong-ke/xlsx', auth('GV'), (req, res) => {
    const p = thongKeParams(req, res);
    if (!p) return;
    const data = thongKe(p.c.id, p.from, p.to).rows.map(r => ({
      'MSSV': r.ma, 'Họ tên': r.ho_ten, 'Có mặt': r.co_mat, 'Đi trễ': r.di_tre,
      'Có phép': r.co_phep, 'Vắng': r.vang, 'Tỷ lệ chuyên cần (%)': r.ty_le ?? '',
      'Nhóm': r.nhom, 'Nguy cơ cấm thi': r.nguy_co ? 'Có' : 'Không',
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'ChuyenCan');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="chuyen-can.xlsx"',
    });
    res.send(buf);
  });

  // ---------- Quản trị viên: tạo tài khoản (UC-11) ----------
  app.post('/api/admin/users', auth('ADMIN'), (req, res) => {
    const { ma, ho_ten, email, vai_tro } = req.body || {};
    if (!ma || !ho_ten || !vai_tro) return res.status(400).json({ error: 'Vui lòng nhập mã số, họ tên và vai trò' });
    if (!['SV', 'GV', 'ADMIN'].includes(vai_tro)) return res.status(400).json({ error: 'Vai trò không hợp lệ' });
    const maTrim = String(ma).trim();
    if (db.prepare('SELECT 1 FROM users WHERE ma = ? OR username = ?').get(maTrim, maTrim))
      return res.status(409).json({ error: 'Mã số đã tồn tại, không tạo tài khoản' });
    const tmp = crypto.randomBytes(4).toString('hex');
    try {
      db.prepare(`INSERT INTO users (ma, username, ho_ten, email, vai_tro, mat_khau) VALUES (?,?,?,?,?,?)`)
        .run(maTrim, maTrim, String(ho_ten).trim(), email || null, vai_tro, bcrypt.hashSync(tmp, 10));
      res.json({ ok: true, mat_khau_tam: tmp });
    } catch (e) { dbErr(res, e, 'Mã số đã tồn tại, không tạo tài khoản'); }
  });

  // ---------- Quản trị viên: môn học / lớp học phần / học kỳ (UC-12) ----------
  const TABLES = {
    subjects: { table: 'subjects', fields: ['ma_mon', 'ten_mon', 'so_tin_chi'] },
    semesters: { table: 'semesters', fields: ['ma', 'ten', 'ngay_bd', 'ngay_kt'] },
    classes: { table: 'classes', fields: ['ma_lop', 'ten_lop', 'subject_id', 'semester_id', 'gv_id'], optional: ['ten_lop'] },
  };
  const LABEL = {
    ma_mon: 'Mã môn', ten_mon: 'Tên môn', so_tin_chi: 'Số tín chỉ', ma: 'Mã học kỳ', ten: 'Tên học kỳ',
    ngay_bd: 'Ngày bắt đầu', ngay_kt: 'Ngày kết thúc', ma_lop: 'Mã lớp', ten_lop: 'Tên lớp',
    subject_id: 'Môn học', semester_id: 'Học kỳ', gv_id: 'Giảng viên phụ trách',
  };
  const NUMERIC = ['so_tin_chi', 'subject_id', 'semester_id', 'gv_id'];
  const inUse = {
    subjects: id => db.prepare('SELECT COUNT(*) AS n FROM classes WHERE subject_id = ?').get(id).n,
    semesters: id => db.prepare('SELECT COUNT(*) AS n FROM classes WHERE semester_id = ?').get(id).n,
    classes: id => db.prepare(`SELECT (SELECT COUNT(*) FROM sessions WHERE class_id = ?)
      + (SELECT COUNT(*) FROM enrollments WHERE class_id = ?) AS n`).get(id, id).n,
  };
  const listOf = {
    subjects: () => db.prepare('SELECT * FROM subjects ORDER BY ma_mon').all(),
    semesters: () => db.prepare('SELECT * FROM semesters ORDER BY ngay_bd DESC').all(),
    classes: () => db.prepare(`SELECT c.*, sub.ten_mon, sem.ten AS ten_hoc_ky, u.ho_ten AS ten_gv
      FROM classes c JOIN subjects sub ON sub.id = c.subject_id
      JOIN semesters sem ON sem.id = c.semester_id JOIN users u ON u.id = c.gv_id
      ORDER BY c.ma_lop`).all(),
  };

  function saveItem(name, req, res, id) {
    const cfg = TABLES[name];
    const data = {};
    for (const f of cfg.fields) {
      const v = req.body?.[f];
      if (v === undefined || v === '' || v === null) {
        if (cfg.optional?.includes(f)) { data[f] = null; continue; }
        return res.status(400).json({ error: `Vui lòng nhập ${LABEL[f]}` });
      }
      data[f] = NUMERIC.includes(f) ? Number(v) : String(v).trim();
    }
    if (name === 'semesters' && data.ngay_kt <= data.ngay_bd)
      return res.status(400).json({ error: 'Ngày kết thúc phải sau ngày bắt đầu' });
    if (name === 'subjects' && !(data.so_tin_chi > 0))
      return res.status(400).json({ error: 'Số tín chỉ phải lớn hơn 0' });
    try {
      if (id) {
        db.prepare(`UPDATE ${cfg.table} SET ${cfg.fields.map(f => f + ' = ?').join(', ')} WHERE id = ?`)
          .run(...cfg.fields.map(f => data[f]), id);
      } else {
        db.prepare(`INSERT INTO ${cfg.table} (${cfg.fields.join(', ')}) VALUES (${cfg.fields.map(() => '?').join(', ')})`)
          .run(...cfg.fields.map(f => data[f]));
      }
      res.json({ ok: true });
    } catch (e) { dbErr(res, e, 'Mã đã tồn tại, không thể lưu trùng'); }
  }

  function removeItems(name, ids, res) {
    let xoa = 0, khongXoa = 0;
    for (const id of ids) {
      if (inUse[name](id) > 0) { khongXoa++; continue; }
      db.prepare(`DELETE FROM ${TABLES[name].table} WHERE id = ?`).run(id);
      xoa++;
    }
    if (ids.length === 1 && khongXoa === 1)
      return res.status(409).json({ error: 'Mục này đang được sử dụng nên không được xóa' });
    res.json({ xoa, khong_xoa: khongXoa });
  }

  for (const name of Object.keys(TABLES)) {
    const base = `/api/admin/${name}`;
    app.get(base, auth('ADMIN'), (req, res) => res.json(listOf[name]()));
    app.post(base, auth('ADMIN'), (req, res) => saveItem(name, req, res, null));
    app.put(`${base}/:id`, auth('ADMIN'), (req, res) => saveItem(name, req, res, Number(req.params.id)));
    app.delete(`${base}/:id`, auth('ADMIN'), (req, res) => removeItems(name, [Number(req.params.id)], res));
    app.post(`${base}/xoa-hang-loat`, auth('ADMIN'), (req, res) => {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
      if (!ids.length) return res.status(400).json({ error: 'Chọn ít nhất một mục để xóa' });
      removeItems(name, ids, res);
    });
  }

  // Nhập môn học từ CSV/Excel
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
    res.json({ them, bo_qua: boQua });
  });
};