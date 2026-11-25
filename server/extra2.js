const fs = require('fs');
const path = require('path');

const BK_DIR = path.join(__dirname, '..', 'data', 'backups');
fs.mkdirSync(BK_DIR, { recursive: true });

module.exports = function mountExtra2(app, db, auth) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ten TEXT NOT NULL,
      loai TEXT NOT NULL,
      dung_luong INTEGER NOT NULL DEFAULT 0,
      tao_luc TEXT NOT NULL,
      nguoi TEXT,
      trang_thai TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thoi_gian TEXT NOT NULL,
      nguoi TEXT,
      hanh_dong TEXT NOT NULL,
      chi_tiet TEXT
    );
  `);

  const audit = (who, act, detail) =>
    db.prepare('INSERT INTO audit_log (thoi_gian, nguoi, hanh_dong, chi_tiet) VALUES (?,?,?,?)')
      .run(new Date().toISOString(), who, act, detail || null);

  const ownSession = (id, gvId) =>
    db.prepare(`SELECT s.*, c.gv_id FROM sessions s
      JOIN classes c ON c.id = s.class_id WHERE s.id = ? AND c.gv_id = ?`).get(id, gvId);

  // ---------- Giảng viên: sửa / xóa buổi học ----------
  app.put('/api/gv/buoi/:id', auth('GV'), (req, res) => {
    const s = ownSession(Number(req.params.id), req.user.id);
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
    const s = ownSession(Number(req.params.id), req.user.id);
    if (!s) return res.status(404).json({ error: 'Không tìm thấy buổi học' });
    const n = db.prepare(`SELECT (SELECT COUNT(*) FROM attendance WHERE session_id = ?)
      + (SELECT COUNT(*) FROM leave_requests WHERE session_id = ?) AS n`).get(s.id, s.id).n;
    if (n > 0) return res.status(409).json({ error: 'Buổi học đã có điểm danh hoặc đơn xin phép, không được xóa' });
    db.prepare('DELETE FROM sessions WHERE id = ?').run(s.id);
    audit(req.user.ho_ten, 'Xóa buổi học', `Buổi #${s.id}`);
    res.json({ ok: true });
  });

  // ---------- Quản trị viên: sao lưu, tải về, nhật ký ----------
  app.post('/api/admin/backup', auth('ADMIN'), async (req, res) => {
    const ten = `sqas-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
    const dest = path.join(BK_DIR, ten);
    const now = new Date().toISOString();
    const ghi = (size, tt) => db.prepare(`INSERT INTO backups (ten, loai, dung_luong, tao_luc, nguoi, trang_thai)
      VALUES (?,?,?,?,?,?)`).run(ten, 'Toàn phần', size, now, req.user.ho_ten, tt);
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
    const b = db.prepare('SELECT * FROM backups WHERE id = ? AND trang_thai = ?')
      .get(Number(req.params.id), 'Thành công');
    if (!b) return res.status(404).json({ error: 'Không tìm thấy bản sao lưu' });
    audit(req.user.ho_ten, 'Tải bản sao lưu', b.ten);
    res.download(path.join(BK_DIR, b.ten), b.ten);
  });

  app.get('/api/admin/audit', auth('ADMIN'), (req, res) =>
    res.json(db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 100').all()));
};