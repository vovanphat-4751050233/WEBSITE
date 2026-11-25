const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dir, { recursive: true });
const db = new Database(path.join(dir, 'sqas.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ma TEXT UNIQUE NOT NULL,
  username TEXT UNIQUE NOT NULL,
  ho_ten TEXT NOT NULL,
  email TEXT,
  vai_tro TEXT NOT NULL CHECK (vai_tro IN ('SV','GV','ADMIN')),
  trang_thai TEXT NOT NULL DEFAULT 'Đang hoạt động',
  mat_khau TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subjects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ma_mon TEXT UNIQUE NOT NULL,
  ten_mon TEXT NOT NULL,
  so_tin_chi INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS semesters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ma TEXT UNIQUE NOT NULL,
  ten TEXT NOT NULL,
  ngay_bd TEXT NOT NULL,
  ngay_kt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ma_lop TEXT UNIQUE NOT NULL,
  ten_lop TEXT,
  subject_id INTEGER NOT NULL REFERENCES subjects(id),
  semester_id INTEGER NOT NULL REFERENCES semesters(id),
  gv_id INTEGER NOT NULL REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS enrollments (
  class_id INTEGER NOT NULL REFERENCES classes(id),
  sv_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (class_id, sv_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id),
  ngay TEXT NOT NULL,
  gio_bd TEXT NOT NULL,
  gio_kt TEXT NOT NULL,
  phong TEXT,
  ghi_chu TEXT,
  ma_qr TEXT,
  ma_qr_truoc TEXT,
  qr_doi_luc INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sess_qr ON sessions(ma_qr);
CREATE INDEX IF NOT EXISTS idx_sess_qr_t ON sessions(ma_qr_truoc);
CREATE TABLE IF NOT EXISTS attendance (
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  sv_id INTEGER NOT NULL REFERENCES users(id),
  thoi_gian TEXT,
  trang_thai TEXT NOT NULL,
  hinh_thuc TEXT NOT NULL,
  PRIMARY KEY (session_id, sv_id)
);
CREATE TABLE IF NOT EXISTS leave_requests (
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
);
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

module.exports = db;