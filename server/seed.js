const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const plus = m => hm(new Date(Date.now() + m * 60000));
const daysAgo = n => ymd(new Date(Date.now() - n * 86400000));
const qrCode = () => 'SQ-' + crypto.randomBytes(2).toString('hex').toUpperCase();

module.exports = function seed() {
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return;
  const hash = bcrypt.hashSync('123456', 10);
  const now = new Date();

  const insUser = db.prepare('INSERT INTO users (ma, username, ho_ten, email, vai_tro, mat_khau) VALUES (?,?,?,?,?,?)');
  insUser.run('GV001', 'gv.nguyenvanan', 'Nguyễn Văn An', 'gv.nguyenvanan@example.com', 'GV', hash);
  insUser.run('ADM001', 'admin.fit', 'Quản trị hệ thống', 'admin.fit@example.com', 'ADMIN', hash);
  [['2251010001', 'Sinh viên Demo'], ['2251010002', 'Trần Thị Bình'], ['2251010003', 'Lê Minh Châu'],
   ['2251010004', 'Phạm Quốc Dũng'], ['2251010005', 'Hoàng Thu Hà']]
    .forEach(([ma, ten]) => insUser.run(ma, ma, ten, `${ma}@example.com`, 'SV', hash));

  const semId = db.prepare('INSERT INTO semesters (ma, ten, ngay_bd, ngay_kt) VALUES (?,?,?,?)')
    .run('HK2-2025-2026', 'Học kỳ 2, năm học 2025–2026', '2026-01-05', '2026-05-30').lastInsertRowid;
  const insSub = db.prepare('INSERT INTO subjects (ma_mon, ten_mon, so_tin_chi) VALUES (?,?,?)');
  const subCsdl = insSub.run('CSDL101', 'Cơ sở dữ liệu', 3).lastInsertRowid;
  const subLtw = insSub.run('LTW201', 'Lập trình web', 3).lastInsertRowid;

  const gvId = db.prepare("SELECT id FROM users WHERE username = 'gv.nguyenvanan'").get().id;
  const insClass = db.prepare('INSERT INTO classes (ma_lop, ten_lop, subject_id, semester_id, gv_id) VALUES (?,?,?,?,?)');
  const cCsdl = insClass.run('CSDL101-01', 'CSDL 01', subCsdl, semId, gvId).lastInsertRowid;
  const cLtw = insClass.run('LTW201-01', 'LTW 01', subLtw, semId, gvId).lastInsertRowid;

  const allSv = db.prepare("SELECT id FROM users WHERE vai_tro = 'SV' ORDER BY ma").all().map(r => r.id);
  const insEn = db.prepare('INSERT INTO enrollments (class_id, sv_id) VALUES (?,?)');
  allSv.forEach(sv => { insEn.run(cCsdl, sv); insEn.run(cLtw, sv); });

  const insSess = db.prepare('INSERT INTO sessions (class_id, ngay, gio_bd, gio_kt, phong, ghi_chu, ma_qr, qr_doi_luc) VALUES (?,?,?,?,?,?,?,?)');
  const insAtt = db.prepare('INSERT INTO attendance (session_id, sv_id, thoi_gian, trang_thai, hinh_thuc) VALUES (?,?,?,?,?)');

  // Buổi đang diễn ra: để thử quét mã ngay
  const today = ymd(now);
  const active = insSess.run(cCsdl, today, plus(-10), plus(80), 'A203', 'Buổi đang diễn ra', qrCode(), Date.now()).lastInsertRowid;
  insAtt.run(active, allSv[1], hm(now) + ':00', 'Có mặt', 'QR Code');
  insAtt.run(active, allSv[2], hm(now) + ':00', 'Có mặt', 'QR Code');
  insSess.run(cLtw, today, plus(120), plus(210), 'B105', 'Thực hành', qrCode(), Date.now());

  // Buổi đã kết thúc: dữ liệu lịch sử
  const kq = ['Có mặt', 'Đi trễ', 'Có phép', null, 'Có mặt'];
  [daysAgo(1), daysAgo(2)].forEach(day => {
    const sid = insSess.run(cCsdl, day, '07:00', '09:30', 'A203', null, qrCode(), 0).lastInsertRowid;
    allSv.forEach((sv, i) => {
      if (kq[i]) insAtt.run(sid, sv, `07:0${i + 1}:00`, kq[i], kq[i] === 'Có phép' ? 'Giảng viên điểm danh tay' : 'QR Code');
    });
  });
};