// ================= SQAS – giao diện chính =================
const app = document.getElementById('app');
const nav = document.getElementById('nav');
const logoutBtn = document.getElementById('logout');
const who = document.getElementById('who');
const $ = id => document.getElementById(id);

let user = JSON.parse(localStorage.getItem('sqas_user') || 'null');
let token = localStorage.getItem('sqas_token');
let timers = [], es = null, scanner = null, scanBusy = false;

const DAY_MS = 86400000;
const ROLE_NAME = { SV: 'Sinh viên', GV: 'Giảng viên', ADMIN: 'Quản trị viên' };
const HOME = { SV: '#/sv', GV: '#/gv/lop', ADMIN: '#/admin/users' };
const PREFIX = { SV: 'sv', GV: 'gv', ADMIN: 'admin' };
const MENU = {
  SV: [
    ['#/sv', 'Trang chủ'], ['#/sv/tkb', 'Thời khóa biểu'], ['#/sv/diem-danh', 'Điểm danh & Quét QR'],
    ['#/sv/lich-su', 'Lịch sử & chuyên cần'], ['#/sv/don', 'Đơn xin phép nghỉ'], ['#/sv/khieu-nai', 'Khiếu nại kết quả'], ['#/sv/thong-bao', 'Thông báo'],
  ],
  GV: [
    ['#/gv/lop', 'Lớp học'], ['#/gv/buoi', 'Tạo buổi học & mã QR'], ['#/gv/realtime', 'Điểm danh realtime'],
    ['#/gv/don', 'Duyệt đơn xin phép'], ['#/gv/canh-bao', 'Cảnh báo vắng'], ['#/gv/khieu-nai', 'Khiếu nại của SV'], ['#/gv/thong-ke', 'Thống kê chuyên cần'],
  ],
  ADMIN: [
    ['#/admin/users', 'Người dùng & phân quyền'], ['#/admin/danh-muc', 'Môn học / Lớp / Học kỳ'],
    ['#/admin/sao-luu', 'Sao lưu dữ liệu'],
  ],
};
const STATUS_CLASS = { 'Có mặt': 'st-blue', 'Đi trễ': 'st-lightblue', 'Có phép': 'st-green', 'Vắng': 'st-red', 'Chưa điểm danh': 'st-gray' };
const GV_CLASS = { 'Có mặt': 'st-green', 'Đi trễ': 'st-orange', 'Có phép': 'st-blue', 'Vắng': 'st-red' };
const LEAVE_CLASS = { 'Đang chờ duyệt': 'st-orange', 'Đã chấp thuận': 'st-green', 'Bị từ chối': 'st-red' };
const DAY_NAMES = ['Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7', 'Chủ nhật'];
const NHOM_LIST = ['100%', '90–99%', '80–89%', 'Dưới 80% (nguy cơ)'];

// ---------- tiện ích ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad2 = n => String(n).padStart(2, '0');
const dmy = s => (s ? s.split('-').reverse().join('/') : '');
const isoDate = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const today = () => isoDate(new Date());
const setMsg = (id, text, ok = false) => { const el = $(id); if (el) { el.className = ok ? 'ok' : 'err'; el.textContent = text; } };
const run = fn => fn().catch(e => { if (user) app.innerHTML = `<section class="card"><p class="err">${esc(e.message)}</p></section>`; });

function stopLive() {
  timers.forEach(clearInterval);
  timers = [];
  if (es) { es.close(); es = null; }
}
function stopCamera() {
  if (scanner) {
    const s = scanner;
    scanner = null;
    try { s.stop().catch(() => {}); } catch {}
  }
}
function logout() {
  token = null; user = null;
  localStorage.removeItem('sqas_token'); localStorage.removeItem('sqas_user');
  if (location.hash) location.hash = ''; else render();
}

async function api(url, opt = {}) {
  const res = await fetch(url, {
    method: opt.method || 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && user) { logout(); throw new Error(data.error || 'Phiên đăng nhập đã hết hạn'); }
  if (!res.ok) throw new Error(data.error || 'Có lỗi xảy ra, vui lòng thử lại');
  return data;
}
async function apiForm(url, fd, method = 'POST') {
  const res = await fetch(url, { method, headers: { Authorization: 'Bearer ' + token }, body: fd });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && user) { logout(); throw new Error(data.error || 'Phiên đăng nhập đã hết hạn'); }
  if (!res.ok) throw new Error(data.error || 'Có lỗi xảy ra, vui lòng thử lại');
  return data;
}
async function download(url, name) {
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || 'Không tải được tệp');
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await res.blob());
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function donut(pct, label) {
  const r = 52, c = 2 * Math.PI * r, off = c * (1 - pct / 100);
  return `<svg viewBox="0 0 140 140" width="150" height="150" role="img" aria-label="${label} ${pct}%">
    <circle cx="70" cy="70" r="${r}" fill="none" stroke="#e3ecea" stroke-width="16"/>
    <circle cx="70" cy="70" r="${r}" fill="none" stroke="#f4a261" stroke-width="16" stroke-linecap="round"
      stroke-dasharray="${c}" stroke-dashoffset="${off}" transform="rotate(-90 70 70)"/>
    <text x="70" y="74" text-anchor="middle" font-size="24" font-weight="800" fill="#0f3d3e">${pct}%</text>
    <text x="70" y="94" text-anchor="middle" font-size="11" fill="#6b7876">${label}</text>
  </svg>`;
}
function progress(p) {
  if (p === null || p === undefined) return '<span class="muted">Chưa có dữ liệu</span>';
  return `<div style="display:flex;align-items:center;gap:8px">
    <div style="flex:1;min-width:90px;height:10px;background:#e3ecea;border-radius:8px;overflow:hidden">
      <div style="width:${p}%;height:100%;background:#f4a261"></div></div><b>${p}%</b></div>`;
}
function slot(r) {
  return `<div class="slot ${r.tt_buoi === 'Đang điểm danh' ? 'live' : ''}">
    <div><b>${r.gio_bd}–${r.gio_kt}</b> · ${esc(r.ten_mon)} (${esc(r.ma_lop)})</div>
    <div class="muted">${esc(r.gv)} · Phòng ${esc(r.phong || '—')} · ${esc(r.tt_buoi)}</div>
    <span class="${STATUS_CLASS[r.tt_sv] || ''}">${esc(r.tt_sv)}</span>
  </div>`;
}

// ---------- định tuyến ----------
function render() {
  stopLive();
  stopCamera();
  if (!user) {
    nav.innerHTML = ''; who.textContent = ''; logoutBtn.hidden = true;
    return viewLogin();
  }
  logoutBtn.hidden = false;
  who.innerHTML = `<b>${esc(user.ho_ten)}</b><br>${ROLE_NAME[user.vai_tro]}`;
  const h = location.hash || HOME[user.vai_tro];
  const key = h.replace('#/', '');
  if (!key.startsWith(PREFIX[user.vai_tro])) { location.hash = HOME[user.vai_tro]; return; }
  nav.innerHTML = MENU[user.vai_tro].map(([href, label]) =>
    `<a href="${href}" class="${h === href ? 'on' : ''}">${label}</a>`).join('');

  if (key.startsWith('gv/realtime/')) return run(() => viewGvRealtime(key.split('/')[2]));
  const route = ROUTES[key];
  if (route) return run(route);
  location.hash = HOME[user.vai_tro];
}
const ROUTES = {
  'sv': viewSvHome,
  'sv/tkb': () => viewSvTuan(0, ''),
  'sv/diem-danh': viewSvDiemDanh,
  'sv/lich-su': viewSvLichSu,
  'sv/don': viewSvDon,
  'sv/khieu-nai': viewSvKhieuNai,
  'sv/thong-bao': viewSvThongBao,
  'gv/lop': viewGvLop,
  'gv/buoi': () => viewGvBuoi(null),
  'gv/realtime': viewGvRealtimeList,
  'gv/don': viewGvDon,
  'gv/canh-bao': viewGvCanhBao,
  'gv/khieu-nai': viewGvKhieuNai,
  'gv/thong-ke': viewGvThongKe,
  'admin/users': viewAdminUsers,
  'admin/danh-muc': () => viewAdminDanhMuc('subjects'),
  'admin/sao-luu': viewAdminSaoLuu,
};

// ================= ĐĂNG NHẬP =================
function viewLogin() {
  app.innerHTML = `
  <section class="card login">
    <h1>Đăng nhập SQAS</h1>
    <p class="muted">Hệ thống điểm danh sinh viên bằng mã QR</p>
    <div class="demo">
      <button type="button" data-u="gv.nguyenvanan">Giảng viên<small>gv.nguyenvanan</small></button>
      <button type="button" data-u="admin.fit">Quản trị viên<small>admin.fit</small></button>
      <button type="button" data-u="2251010001">Sinh viên<small>2251010001</small></button>
    </div>
    <form id="fLogin" class="stack">
      <label>Tên đăng nhập <span class="req">*</span><input name="username" required autocomplete="username"></label>
      <label>Mật khẩu <span class="req">*</span><input name="password" type="password" required autocomplete="current-password"></label>
      <p id="loginErr" class="err"></p>
      <button class="primary">Đăng nhập</button>
    </form>
  </section>`;
  app.querySelectorAll('[data-u]').forEach(b => b.onclick = () => {
    const f = $('fLogin');
    f.username.value = b.dataset.u;
    f.password.value = '123456';
  });
  $('fLogin').onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    try {
      const r = await api('/api/login', { method: 'POST', body: { username: f.username.value.trim(), password: f.password.value } });
      token = r.token; user = r.user;
      localStorage.setItem('sqas_token', token);
      localStorage.setItem('sqas_user', JSON.stringify(user));
      location.hash = HOME[user.vai_tro];
      render();
    } catch (err) { setMsg('loginErr', err.message); }
  };
}

// ================= SINH VIÊN =================
async function viewSvHome() {
  const rows = await api('/api/sv/buoi');
  const live = rows.find(r => r.tt_buoi === 'Đang điểm danh');
  const next = rows.find(r => r.tt_buoi === 'Chưa diễn ra');
  const ended = rows.filter(r => r.tt_buoi === 'Đã kết thúc');
  const hien = ended.filter(r => ['Có mặt', 'Đi trễ'].includes(r.tt_sv)).length;
  const pct = ended.length ? Math.round(hien / ended.length * 100) : 0;
  const todays = rows.filter(r => r.ngay === today());
  app.innerHTML = `
  <section class="card banner ${live ? 'live' : ''}">
    ${live
      ? `<div><b>Đang điểm danh: ${esc(live.ten_mon)} (${esc(live.ma_lop)})</b>
          <p class="muted">Phòng ${esc(live.phong || '—')} · ${live.gio_bd}–${live.gio_kt}</p></div>
         <a class="btnlink" href="#/sv/diem-danh">Quét mã ngay</a>`
      : next
        ? `<div><b>Lớp học tiếp theo: ${esc(next.ten_mon)} (${esc(next.ma_lop)})</b>
            <p class="muted">${dmy(next.ngay)} · ${next.gio_bd}–${next.gio_kt} · Phòng ${esc(next.phong || '—')}</p></div>
           <a class="btnlink" href="#/sv/diem-danh">Sẵn sàng quét mã</a>`
        : '<div><b>Hiện không có buổi học nào sắp diễn ra</b></div>'}
  </section>
  <section class="card dash">
    ${donut(pct, 'Chuyên cần')}
    <div>
      <h3>Tổng quan</h3>
      <p>Đã kết thúc ${ended.length} buổi, có mặt hoặc đi trễ ${hien} buổi.</p>
      <p class="muted">Hôm nay có ${todays.length} buổi học.</p>
    </div>
  </section>
  <section class="card">
    <h2>Hôm nay</h2>
    ${todays.length ? todays.map(slot).join('') : '<p class="muted">Hôm nay không có buổi học.</p>'}
  </section>`;
}

async function viewSvTuan(offset = 0, subj = '') {
  const all = await api('/api/sv/buoi');
  const mon = new Date();
  mon.setHours(0, 0, 0, 0);
  mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7) + offset * 7);
  const days = [...Array(7)].map((_, i) => { const d = new Date(mon); d.setDate(mon.getDate() + i); return d; });
  const from = isoDate(days[0]), to = isoDate(days[6]);
  const subjects = [...new Set(all.map(r => r.ten_mon))];
  const list = all.filter(r => r.ngay >= from && r.ngay <= to && (!subj || r.ten_mon === subj));
  app.innerHTML = `
  <section class="card">
    <div class="row">
      <h2>Thời khóa biểu tuần</h2>
      <div class="row">
        <button class="small" id="pv">◀ Tuần trước</button>
        <button class="small" id="nw">Tuần này</button>
        <button class="small" id="nx">Tuần sau ▶</button>
      </div>
    </div>
    <div class="row">
      <p class="muted">Tuần ${dmy(from)} – ${dmy(to)}</p>
      <div class="row">
        <select id="fSub"><option value="">Tất cả môn</option>
          ${subjects.map(s => `<option ${s === subj ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
        <button class="small" id="btnIcs">Xuất lịch (.ics)</button>
        <button class="small" id="btnPrint">In</button>
      </div>
    </div>
  </section>
  <section class="week">
    ${days.map((d, i) => {
      const key = isoDate(d);
      const items = list.filter(r => r.ngay === key);
      return `<div class="day"><h3>${DAY_NAMES[i]} · ${dmy(key)}</h3>
        ${items.length ? items.map(slot).join('') : '<p class="muted">Không có buổi học</p>'}</div>`;
    }).join('')}
  </section>`;
  $('pv').onclick = () => run(() => viewSvTuan(offset - 1, subj));
  $('nx').onclick = () => run(() => viewSvTuan(offset + 1, subj));
  $('nw').onclick = () => run(() => viewSvTuan(0, subj));
  $('fSub').onchange = e => run(() => viewSvTuan(offset, e.target.value));
  $('btnIcs').onclick = () => xuatIcs(list);
  $('btnPrint').onclick = () => window.print();
}

function xuatIcs(list) {
  if (!list.length) return alert('Tuần này không có buổi học để xuất');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const local = (ngay, gio) => ngay.replace(/-/g, '') + 'T' + gio.replace(':', '') + '00';
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SQAS//VN', 'CALSCALE:GREGORIAN'];
  list.forEach(r => lines.push('BEGIN:VEVENT', `UID:sqas-${r.id}@sqas`, `DTSTAMP:${stamp}`,
    `DTSTART:${local(r.ngay, r.gio_bd)}`, `DTEND:${local(r.ngay, r.gio_kt)}`,
    `SUMMARY:${r.ten_mon} (${r.ma_lop})`, `LOCATION:${r.phong || ''}`, `DESCRIPTION:GV ${r.gv}`, 'END:VEVENT'));
  lines.push('END:VCALENDAR');
  const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'thoi-khoa-bieu.ics';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function viewSvDiemDanh() {
  const rows = await api('/api/sv/buoi');
  const live = rows.filter(r => r.tt_buoi === 'Đang điểm danh');
  app.innerHTML = `
  <section class="card">
    <h2>Điểm danh & Quét QR</h2>
    ${live.length ? `<p class="ok">Có ${live.length} buổi học đang điểm danh.</p>`
      : '<p class="muted">Hiện chưa có buổi học đang điểm danh.</p>'}
    <div id="reader" style="width:100%;max-width:420px;margin:0 auto"></div>
    <form id="fCode" class="stack" style="margin-top:14px">
      <label>Hoặc nhập mã trên màn hình giảng viên <span class="req">*</span>
        <input name="ma" placeholder="SQ-XXXX" maxlength="7" autocomplete="off" required></label>
      <p id="scanMsg" class="err"></p>
      <button class="primary">Điểm danh</button>
    </form>
  </section>
  <section class="card">
    <h3>Buổi đang diễn ra</h3>
    ${live.length ? live.map(slot).join('') : '<p class="muted">Không có buổi nào.</p>'}
  </section>`;
  $('fCode').onsubmit = e => { e.preventDefault(); submitCode(e.target.ma.value); };
  startCamera('reader');
}

function startCamera(elId) {
  scanBusy = false;
  if (!window.Html5Qrcode) {
    $(elId).textContent = 'Không tải được thư viện quét mã (cần kết nối mạng). Vui lòng nhập mã bên dưới.';
    return;
  }
  scanner = new Html5Qrcode(elId);
  scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: 220 }, async txt => {
    if (scanBusy) return;
    scanBusy = true;
    const ok = await submitCode(txt);
    if (ok) stopCamera();
    else setTimeout(() => { scanBusy = false; }, 1500);
  }).catch(() => { $(elId).textContent = 'Không mở được camera. Hãy nhập mã thủ công bên dưới.'; });
}

async function submitCode(ma) {
  setMsg('scanMsg', '');
  try {
    const r = await api('/api/sv/diem-danh', { method: 'POST', body: { ma: String(ma).trim().toUpperCase() } });
    setMsg('scanMsg', `Điểm danh thành công lúc ${r.thoi_gian} (${r.trang_thai})`, true);
    setTimeout(() => { if (location.hash === '#/sv/diem-danh') render(); }, 1500);
    return true;
  } catch (e) {
    setMsg('scanMsg', e.message);
    return false;
  }
}

async function viewSvLichSu() {
  const list = await api('/api/sv/lich-su');
  app.innerHTML = `
  <section class="card">
    <div class="row">
      <h2>Lịch sử điểm danh & tỷ lệ chuyên cần</h2>
      <div class="row">
        <input id="lsSearch" placeholder="Tìm môn / mã môn">
        <button class="small" id="btnLsXlsx">Xuất Excel</button>
      </div>
    </div>
  </section>
  <div id="lsList"></div>`;
  const draw = () => {
    const q = $('lsSearch').value.trim().toLowerCase();
    const items = list.filter(c => !q || `${c.ma_mon} ${c.ten_mon}`.toLowerCase().includes(q));
    $('lsList').innerHTML = items.length ? items.map(c => `
      <details class="card">
        <summary><b>${esc(c.ma_mon)} – ${esc(c.ten_mon)}</b> · ${c.so_tin_chi} tín chỉ · ${c.tong} buổi ·
          <span class="${c.tong === 0 ? 'st-gray' : c.nguy_co ? 'st-red' : 'st-green'}">
            ${c.tong === 0 ? 'Chưa có dữ liệu' : c.nguy_co ? 'Nguy cơ cấm thi' : 'Đạt chuẩn dự thi'}</span></summary>
        <div class="dash">
          ${donut(c.ty_le ?? 0, 'Chuyên cần')}
          <div class="stats">
            <div class="stat"><span>Có mặt</span><b>${c.co_mat}</b></div>
            <div class="stat"><span>Đi trễ</span><b>${c.di_tre}</b></div>
            <div class="stat"><span>Có phép</span><b>${c.co_phep}</b></div>
            <div class="stat"><span>Vắng</span><b>${c.vang}</b></div>
          </div>
        </div>
        <div class="scroll"><table>
          <tr><th>STT</th><th>Ngày</th><th>Giờ</th><th>Trạng thái</th><th>Hình thức</th></tr>
          ${c.buoi.map((b, i) => `<tr>
            <td>${i + 1}</td><td>${dmy(b.ngay)}</td><td>${b.gio_bd}–${b.gio_kt}</td>
            <td class="${STATUS_CLASS[c.chi_tiet[i].tt] || ''}">${esc(c.chi_tiet[i].tt)}</td>
            <td>${esc(c.chi_tiet[i].ht)}</td></tr>`).join('')}
        </table></div>
      </details>`).join('') : '<section class="card"><p class="muted">Chưa có dữ liệu.</p></section>';
  };
  $('lsSearch').oninput = draw;
  $('btnLsXlsx').onclick = () => download('/api/sv/lich-su/xlsx', 'lich-su-diem-danh.xlsx').catch(e => alert(e.message));
  draw();
}

async function viewSvDon() {
  const [don, buoi] = await Promise.all([api('/api/sv/don'), api('/api/sv/buoi')]);
  const nowMs = Date.now();
  const open = buoi.filter(r => {
    const st = new Date(`${r.ngay}T${r.gio_bd}:00`).getTime();
    const en = new Date(`${r.ngay}T${r.gio_kt}:00`).getTime();
    return st - nowMs >= DAY_MS || (nowMs >= en && nowMs - en <= 2 * DAY_MS);
  });
  app.innerHTML = `
  <section class="card">
    <h2>Gửi đơn xin phép nghỉ</h2>
    <p class="muted">Nộp trước buổi học ít nhất 24 giờ, hoặc tối đa 48 giờ sau buổi học.</p>
    ${open.length ? `<form id="fDon" class="grid">
      <label class="full">Buổi học <span class="req">*</span>
        <select name="session_id" required>
          ${open.map(b => `<option value="${b.id}">${dmy(b.ngay)} · ${b.gio_bd}–${b.gio_kt} · ${esc(b.ten_mon)} (${esc(b.ma_lop)})</option>`).join('')}
        </select></label>
      <label class="full">Lý do <span class="req">*</span>
        <textarea name="ly_do" maxlength="300" rows="3" required></textarea>
        <span class="muted" id="cnt">0/300</span></label>
      <label class="full">Minh chứng (PDF/JPG/PNG, tối đa 10MB)
        <input type="file" name="minh_chung" accept=".pdf,.jpg,.jpeg,.png"></label>
      <p id="donErr" class="err full"></p>
      <button class="primary full">Gửi đơn</button>
    </form>` : '<p class="muted">Hiện không có buổi học nào trong thời hạn nộp đơn.</p>'}
  </section>
  <section class="card">
    <h2>Đơn của tôi</h2>
    ${don.length ? `<div class="scroll"><table>
      <tr><th>Mã đơn</th><th>Ngày nghỉ</th><th>Môn</th><th>Lý do</th><th>Minh chứng</th><th>Trạng thái</th><th>Phản hồi GV</th><th></th></tr>
      ${don.map(d => `<tr>
        <td>${esc(d.ma)}</td>
        <td>${dmy(d.ngay)} ${d.gio_bd}–${d.gio_kt}</td>
        <td>${esc(d.ten_mon)} (${esc(d.ma_lop)})</td>
        <td>${esc(d.ly_do)}</td>
        <td>${d.file_name ? `<button class="small" data-file="${d.id}" data-name="${esc(d.file_name)}">Tải</button>` : '—'}</td>
        <td class="${LEAVE_CLASS[d.trang_thai] || ''}">${esc(d.trang_thai)}</td>
        <td>${esc(d.phan_hoi || '—')}</td>
        <td>${d.trang_thai === 'Đang chờ duyệt' ? `<button class="small" data-cancel="${d.id}">Hủy đơn</button>` : ''}</td>
      </tr>`).join('')}
    </table></div>` : '<p class="muted">Bạn chưa gửi đơn nào.</p>'}
  </section>`;

  if ($('fDon')) {
    const f = $('fDon');
    f.ly_do.oninput = () => $('cnt').textContent = `${f.ly_do.value.length}/300`;
    f.onsubmit = async e => {
      e.preventDefault();
      const fd = new FormData(f);
      const file = f.minh_chung.files[0];
      if (file && file.size > 10 * 1024 * 1024) return setMsg('donErr', 'Tệp minh chứng vượt quá 10MB');
      if (!file) fd.delete('minh_chung');
      try {
        const r = await apiForm('/api/sv/don', fd);
        alert(`Đã gửi đơn ${r.ma}`);
        run(viewSvDon);
      } catch (err) { setMsg('donErr', err.message); }
    };
  }
  app.querySelectorAll('[data-file]').forEach(b => b.onclick = () =>
    download(`/api/don/${b.dataset.file}/minh-chung`, b.dataset.name).catch(e => alert(e.message)));
  app.querySelectorAll('[data-cancel]').forEach(b => b.onclick = async () => {
    if (!confirm('Hủy đơn này?')) return;
    try { await api(`/api/sv/don/${b.dataset.cancel}`, { method: 'DELETE' }); run(viewSvDon); }
    catch (e) { alert(e.message); }
  });
}

// ================= GIẢNG VIÊN =================
async function viewGvLop() {
  const [classes, dm] = await Promise.all([api('/api/gv/lop'), api('/api/danh-muc')]);
  app.innerHTML = `
  <section class="card">
    <h2>Lớp học của tôi</h2>
    ${classes.length ? `<div class="scroll"><table>
      <tr><th>Mã lớp</th><th>Môn học</th><th>Học kỳ</th><th>Sĩ số</th><th>Chuyên cần TB</th></tr>
      ${classes.map(c => `<tr>
        <td>${esc(c.ma_lop)}</td><td>${esc(c.ten_mon)}</td><td>${esc(c.hoc_ky)}</td>
        <td>${c.so_sv}</td><td>${progress(c.ty_le_tb)}</td></tr>`).join('')}
    </table></div>` : '<p class="muted">Bạn chưa có lớp học nào.</p>'}
  </section>
  <section class="card">
    <h2>Tạo lớp học</h2>
    <form id="fLop" class="grid">
      <label>Mã lớp <span class="req">*</span><input name="ma_lop" required></label>
      <label>Tên lớp<input name="ten_lop"></label>
      <label>Môn học <span class="req">*</span>
        <select name="subject_id" required>
          ${dm.subjects.map(s => `<option value="${s.id}">${esc(s.ma_mon)} – ${esc(s.ten_mon)}</option>`).join('')}
        </select></label>
      <label>Học kỳ <span class="req">*</span>
        <select name="semester_id" required>
          ${dm.semesters.map(s => `<option value="${s.id}">${esc(s.ten)}</option>`).join('')}
        </select></label>
      <p id="lopErr" class="full"></p>
      <button class="primary full">Tạo lớp</button>
    </form>
  </section>
  ${classes.length ? `<section class="card">
    <h2>Nhập danh sách sinh viên</h2>
    <p class="muted">File Excel/CSV có các cột: <b>Mã SV, Họ tên, Lớp, Email</b>. Sinh viên mới đăng nhập bằng mã SV và mật khẩu tạm.</p>
    <form id="fImp" class="grid">
      <label>Lớp <span class="req">*</span>
        <select name="class_id">
          ${classes.map(c => `<option value="${c.id}">${esc(c.ma_lop)} – ${esc(c.ten_mon)}</option>`).join('')}
        </select></label>
      <label>File danh sách <span class="req">*</span>
        <input type="file" name="file" accept=".xlsx,.xls,.csv" required></label>
      <p id="impErr" class="full"></p>
      <button class="primary full">Nhập danh sách</button>
    </form>
    <div id="impRes"></div>
  </section>` : ''}`;

  $('fLop').onsubmit = async e => {
    e.preventDefault();
    const b = Object.fromEntries(new FormData(e.target));
    try {
      await api('/api/gv/lop', { method: 'POST', body: {
        ma_lop: b.ma_lop, ten_lop: b.ten_lop, subject_id: Number(b.subject_id), semester_id: Number(b.semester_id),
      } });
      run(viewGvLop);
    } catch (err) { setMsg('lopErr', err.message); }
  };
  if ($('fImp')) $('fImp').onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const r = await apiForm(`/api/gv/lop/${fd.get('class_id')}/sv`, fd);
      $('impRes').innerHTML = `<p class="ok">Đã thêm ${r.them} sinh viên mới, ${r.da_co} sinh viên đã có trong hệ thống.</p>
        ${r.bo_qua.length ? `<p class="err">Bỏ qua ${r.bo_qua.length} dòng:</p><ul>${r.bo_qua.map(x => `<li>Dòng ${x.dong}: ${esc(x.ly_do)}</li>`).join('')}</ul>` : ''}`;
      setMsg('impErr', '');
    } catch (err) { setMsg('impErr', err.message); }
  };
}

async function viewGvBuoi(editId) {
  const [classes, list] = await Promise.all([api('/api/gv/lop'), api('/api/gv/buoi')]);
  const cur = editId ? list.find(x => x.id === editId) : null;
  app.innerHTML = `
  ${cur ? `<section class="card">
    <h2>Sửa buổi học · ${esc(cur.ma_lop)}</h2>
    <form id="fEd" class="grid">
      <label>Ngày học <span class="req">*</span><input type="date" name="ngay" value="${cur.ngay}" required></label>
      <label>Giờ bắt đầu <span class="req">*</span><input type="time" name="gio_bd" value="${cur.gio_bd}" required></label>
      <label>Giờ kết thúc <span class="req">*</span><input type="time" name="gio_kt" value="${cur.gio_kt}" required></label>
      <label>Phòng<input name="phong" value="${esc(cur.phong || '')}"></label>
      <label class="full">Ghi chú<input name="ghi_chu" value="${esc(cur.ghi_chu || '')}"></label>
      <p id="edErr" class="err full"></p>
      <div class="row full"><button class="primary">Lưu thay đổi</button><button type="button" id="edCancel">Hủy</button></div>
    </form>
  </section>` : ''}
  <section class="card">
    <h2>Tạo buổi học & mã QR</h2>
    ${classes.length ? `<form id="fBuoi" class="grid">
      <label>Lớp <span class="req">*</span>
        <select name="class_id" required>
          ${classes.map(c => `<option value="${c.id}">${esc(c.ma_lop)} – ${esc(c.ten_mon)}</option>`).join('')}
        </select></label>
      <label>Ngày học <span class="req">*</span><input type="date" name="ngay" value="${today()}" required></label>
      <label>Giờ bắt đầu <span class="req">*</span><input type="time" name="gio_bd" required></label>
      <label>Giờ kết thúc <span class="req">*</span><input type="time" name="gio_kt" required></label>
      <label>Phòng học<input name="phong"></label>
      <label>Ghi chú<input name="ghi_chu"></label>
      <p id="buoiErr" class="err full"></p>
      <button class="primary full">Tạo buổi học & mã QR</button>
    </form>` : '<p class="muted">Bạn chưa có lớp học nào.</p>'}
  </section>
  <section class="card">
    <h2>Danh sách buổi học</h2>
    <div class="scroll"><table>
      <tr><th>Ngày</th><th>Giờ</th><th>Lớp</th><th>Phòng</th><th>Trạng thái</th><th></th></tr>
      ${list.map(s => `<tr>
        <td>${dmy(s.ngay)}</td><td>${s.gio_bd}–${s.gio_kt}</td><td>${esc(s.ma_lop)}</td>
        <td>${esc(s.phong || '—')}</td><td>${esc(s.trang_thai)}</td>
        <td>
          <a href="#/gv/realtime/${s.id}">Mở QR</a>
          <button class="small" data-ed="${s.id}">Sửa</button>
          <button class="small" data-del="${s.id}">Xóa</button>
        </td></tr>`).join('') || '<tr><td colspan="6">Chưa có buổi học nào</td></tr>'}
    </table></div>
  </section>`;

  if ($('fBuoi')) $('fBuoi').onsubmit = async e => {
    e.preventDefault();
    const b = Object.fromEntries(new FormData(e.target));
    try {
      const r = await api('/api/gv/buoi', { method: 'POST', body: { ...b, class_id: Number(b.class_id) } });
      location.hash = `#/gv/realtime/${r.id}`;
    } catch (err) { setMsg('buoiErr', err.message); }
  };
  if ($('fEd')) $('fEd').onsubmit = async e => {
    e.preventDefault();
    try {
      await api(`/api/gv/buoi/${cur.id}`, { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) });
      run(() => viewGvBuoi(null));
    } catch (err) { setMsg('edErr', err.message); }
  };
  if ($('edCancel')) $('edCancel').onclick = () => run(() => viewGvBuoi(null));
  app.querySelectorAll('[data-ed]').forEach(b => b.onclick = () => run(() => viewGvBuoi(Number(b.dataset.ed))));
  app.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('Xóa buổi học này?')) return;
    try { await api(`/api/gv/buoi/${b.dataset.del}`, { method: 'DELETE' }); run(() => viewGvBuoi(null)); }
    catch (e) { alert(e.message); }
  });
}

async function viewGvRealtimeList() {
  const list = (await api('/api/gv/buoi')).filter(s => s.trang_thai === 'Đang điểm danh');
  app.innerHTML = `<section class="card">
    <h2>Điểm danh realtime</h2>
    ${list.length ? list.map(s => `<div class="slot live">
        <div><b>${esc(s.ma_lop)} – ${esc(s.ten_mon)}</b></div>
        <div class="muted">${s.gio_bd}–${s.gio_kt} · Phòng ${esc(s.phong || '—')}</div>
        <a class="btnlink" href="#/gv/realtime/${s.id}">Mở danh sách</a>
      </div>`).join('')
      : '<p class="muted">Hiện không có buổi học nào đang điểm danh. Tạo buổi học tại mục Tạo buổi học & mã QR.</p>'}
  </section>`;
}

async function viewGvRealtime(id) {
  const info = await api(`/api/gv/buoi/${id}`);
  app.innerHTML = `
  <section class="card qr-card" id="qrCard">
    <div class="row">
      <div>
        <h2>${esc(info.ma_lop)} · ${esc(info.ten_mon)}</h2>
        <p class="muted">${dmy(info.ngay)} · ${info.gio_bd}–${info.gio_kt} · Phòng ${esc(info.phong || '—')}</p>
      </div>
      <button class="small" id="btnFull">Toàn màn hình</button>
    </div>
    <img id="qrImg" class="qr" alt="Mã QR điểm danh" hidden>
    <p class="code" id="qrCode">--</p>
    <p>Mã QR đổi mới sau: <b id="qrLeft">--</b> giây</p>
    <p id="qrErr" class="err"></p>
  </section>
  <section class="card">
    <h2>Danh sách điểm danh realtime</h2>
    <div class="stats" id="stats"></div>
    <div class="row">
      <input id="qSearch" placeholder="Tìm MSSV / họ tên">
      <select id="qFilter">
        <option value="all">Tất cả</option>
        <option value="Có mặt">Đã điểm danh</option>
        <option value="Đi trễ">Đi muộn</option>
        <option value="Có phép">Xin phép</option>
        <option value="chua">Chưa điểm danh</option>
      </select>
      <div class="row">
        <button class="small" id="btnGia">Giả lập quét QR</button>
        <button class="small" id="btnXlsx">Xuất Excel</button>
      </div>
    </div>
    <p id="rtStatus" class="muted">Đang kết nối...</p>
    <div class="scroll"><table id="roster"></table></div>
  </section>`;

  let roster = null, lastCode = '';

  const tickQr = async () => {
    try {
      const r = await api(`/api/gv/buoi/${id}/qr?co=${encodeURIComponent(lastCode)}`);
      if (r.png) $('qrImg').src = r.png;
      $('qrImg').hidden = false;
      lastCode = r.code;
      $('qrCode').textContent = r.code;
      $('qrLeft').textContent = r.con_lai;
      if (r.trang_thai === 'Đã kết thúc') {
        stopLive();
        $('qrErr').textContent = 'Buổi học đã kết thúc, mã QR không còn hiệu lực';
        $('rtStatus').textContent = 'Buổi học đã kết thúc, đã dừng theo dõi realtime';
      } else {
        $('qrErr').textContent = r.trang_thai === 'Chưa diễn ra' ? 'Chưa đến giờ điểm danh, mã QR chưa có hiệu lực' : '';
      }
    } catch (e) { $('qrErr').textContent = e.message; }
  };
  tickQr();
  timers.push(setInterval(tickQr, 1000));

  const drawStats = () => {
    if (!roster) return;
    const cards = [['Tổng sĩ số', roster.tong], ['Đã có mặt', roster.co_mat], ['Đi muộn', roster.di_tre],
      ['Xin phép', roster.xin_phep], ['Vắng mặt', roster.vang]];
    $('stats').innerHTML = cards.map(([t, v]) => `<div class="stat"><span>${t}</span><b>${v}</b></div>`).join('');
  };
  const drawRoster = () => {
    if (!roster) return;
    const q = $('qSearch').value.trim().toLowerCase(), f = $('qFilter').value;
    const rows = roster.sv.filter(x =>
      (!q || `${x.ma} ${x.ho_ten}`.toLowerCase().includes(q)) &&
      (f === 'all' || (f === 'chua' ? !x.trang_thai : x.trang_thai === f)));
    $('roster').innerHTML = `<tr><th>MSSV</th><th>Họ tên</th><th>Thời gian quét</th><th>Trạng thái</th><th>Hình thức</th><th></th></tr>`
      + rows.map(x => `<tr>
        <td>${esc(x.ma)}</td><td>${esc(x.ho_ten)}</td>
        <td>${esc(x.thoi_gian || '--:--:--')}</td>
        <td class="${GV_CLASS[x.trang_thai] || 'st-gray'}">${esc(x.trang_thai || 'Chưa điểm danh')}</td>
        <td>${esc(x.hinh_thuc || '—')}</td>
        <td>${x.trang_thai ? '' : `<button class="small" data-sv="${x.id}">Điểm danh tay</button>`}</td>
      </tr>`).join('');
  };

  $('qSearch').oninput = drawRoster;
  $('qFilter').onchange = drawRoster;
  $('btnFull').onclick = () => $('qrCard').classList.toggle('full');
  $('roster').onclick = async e => {
    const b = e.target.closest('[data-sv]');
    if (!b) return;
    try { await api(`/api/gv/buoi/${id}/thu-cong`, { method: 'POST', body: { sv_id: Number(b.dataset.sv) } }); }
    catch (err) { $('rtStatus').textContent = err.message; }
  };
  $('btnGia').onclick = async () => {
    try { await api(`/api/gv/buoi/${id}/gia-lap`, { method: 'POST' }); }
    catch (err) { $('rtStatus').textContent = err.message; }
  };
  $('btnXlsx').onclick = () => download(`/api/gv/buoi/${id}/xuat`, `diem-danh-${info.ma_lop}.xlsx`)
    .catch(e => $('rtStatus').textContent = e.message);

  es = new EventSource(`/api/gv/buoi/${id}/realtime?token=${encodeURIComponent(token)}`);
  es.onmessage = e => {
    roster = JSON.parse(e.data);
    drawStats();
    drawRoster();
    $('rtStatus').textContent = 'Đã kết nối · cập nhật realtime';
  };
  es.onerror = () => { if ($('rtStatus')) $('rtStatus').textContent = 'Mất kết nối, đang kết nối lại...'; };
}

async function viewGvDon() {
  app.innerHTML = `
  <section class="card">
    <div class="row">
      <h2>Duyệt đơn xin phép nghỉ</h2>
      <div class="row">
        <button class="small" id="btnHl">Duyệt hàng loạt (đơn có minh chứng)</button>
        <button class="small" id="btnXl">Xuất báo cáo nghỉ phép (Excel)</button>
      </div>
    </div>
    <div class="row">
      <input id="dSearch" placeholder="Tìm tên / MSSV / mã đơn">
      <select id="dFilter">
        <option value="Đang chờ duyệt">Đang chờ duyệt</option>
        <option value="Đã chấp thuận">Đã chấp thuận</option>
        <option value="Bị từ chối">Bị từ chối</option>
        <option value="all">Tất cả</option>
      </select>
    </div>
    <p id="dErr"></p>
    <div id="dList" class="scroll"></div>
  </section>`;

  let data = [];
  const draw = () => {
    const q = $('dSearch').value.trim().toLowerCase();
    const rows = data.filter(d => !q || `${d.ma_sv} ${d.ten_sv} ${d.ma}`.toLowerCase().includes(q));
    $('dList').innerHTML = rows.length ? `<table>
      <tr><th>Mã đơn</th><th>Sinh viên</th><th>Lớp</th><th>Ngày nghỉ</th><th>Lý do</th><th>Minh chứng</th><th>Trạng thái</th><th></th></tr>
      ${rows.map(d => `<tr>
        <td>${esc(d.ma)}</td>
        <td>${esc(d.ma_sv)} – ${esc(d.ten_sv)}</td>
        <td>${esc(d.ma_lop)}</td>
        <td>${dmy(d.ngay)} ${d.gio_bd}–${d.gio_kt}</td>
        <td>${esc(d.ly_do)}</td>
        <td>${d.file_name ? `<button class="small" data-file="${d.id}" data-name="${esc(d.file_name)}">Xem</button>` : '—'}</td>
        <td class="${LEAVE_CLASS[d.trang_thai] || ''}">${esc(d.trang_thai)}${d.phan_hoi ? `<br><small>${esc(d.phan_hoi)}</small>` : ''}</td>
        <td>${d.trang_thai === 'Đang chờ duyệt'
          ? `<button class="small primary" data-act="duyet" data-id="${d.id}">Duyệt</button>
             <button class="small" data-act="tu_choi" data-id="${d.id}">Từ chối</button>` : ''}</td>
      </tr>`).join('')}
    </table>` : '<p class="muted">Không có đơn nào trong danh sách này.</p>';
  };
  const load = async () => {
    data = await api(`/api/gv/don?trang_thai=${encodeURIComponent($('dFilter').value)}`);
    draw();
  };

  $('dSearch').oninput = draw;
  $('dFilter').onchange = () => run(load);
  $('dList').onclick = async e => {
    const f = e.target.closest('[data-file]');
    if (f) return download(`/api/don/${f.dataset.file}/minh-chung`, f.dataset.name).catch(err => setMsg('dErr', err.message));
    const b = e.target.closest('[data-act]');
    if (!b) return;
    let phanHoi = '';
    if (b.dataset.act === 'tu_choi') {
      phanHoi = (prompt('Nhập lý do từ chối đơn:') || '').trim();
      if (!phanHoi) return setMsg('dErr', 'Vui lòng nhập lý do từ chối');
    }
    try {
      await api(`/api/gv/don/${b.dataset.id}`, { method: 'PATCH', body: { hanh_dong: b.dataset.act, phan_hoi: phanHoi } });
      await load();
    } catch (err) { setMsg('dErr', err.message); }
  };
  $('btnHl').onclick = async () => {
    if (!confirm('Duyệt tất cả đơn đang chờ có minh chứng đính kèm?')) return;
    try {
      const r = await api('/api/gv/don/duyet-hang-loat', { method: 'POST' });
      alert(`Đã duyệt ${r.so} đơn.`);
      await load();
    } catch (e) { setMsg('dErr', e.message); }
  };
  $('btnXl').onclick = () => download('/api/gv/don/xuat', 'bao-cao-nghi-phep.xlsx').catch(e => setMsg('dErr', e.message));
  await load();
}

async function viewGvThongKe() {
  const classes = await api('/api/gv/lop');
  const first = new Date();
  first.setDate(1);
  app.innerHTML = `
  <section class="card">
    <h2>Thống kê chuyên cần</h2>
    ${classes.length ? `<form id="fTk" class="grid">
      <label>Lớp <span class="req">*</span>
        <select name="class_id">
          ${classes.map(c => `<option value="${c.id}">${esc(c.ma_lop)} – ${esc(c.ten_mon)}</option>`).join('')}
        </select></label>
      <label>Từ ngày <span class="req">*</span><input type="date" name="from" value="${isoDate(first)}" required></label>
      <label>Đến ngày <span class="req">*</span><input type="date" name="to" value="${today()}" required></label>
      <p id="tkErr" class="err full"></p>
      <div class="row full">
        <button class="primary">Xem thống kê</button>
        <button type="button" id="btnXl">Xuất Excel</button>
      </div>
    </form>` : '<p class="muted">Bạn chưa có lớp học nào.</p>'}
  </section>
  <section class="card" id="tkRes" hidden></section>`;
  if (!classes.length) return;

  const f = $('fTk');
  const qs = () => new URLSearchParams({ class_id: f.class_id.value, from: f.from.value, to: f.to.value }).toString();
  f.onsubmit = async e => {
    e.preventDefault();
    try {
      const r = await api(`/api/gv/thong-ke?${qs()}`);
      const box = $('tkRes');
      box.hidden = false;
      if (!r.so_buoi) { box.innerHTML = '<p class="muted">Chưa có dữ liệu trong khoảng thời gian đã chọn.</p>'; return; }
      box.innerHTML = `
        <h3>Kết quả · ${r.so_buoi} buổi đã kết thúc</h3>
        <div class="stats">${NHOM_LIST.map(g => `<div class="stat"><span>${g}</span><b>${r.rows.filter(x => x.nhom === g).length}</b></div>`).join('')}</div>
        <p class="muted">Chuyên cần = (có mặt + đi trễ) / tổng buổi đã kết thúc. Vắng không phép quá 20% là nguy cơ cấm thi.</p>
        <div class="scroll"><table>
          <tr><th>MSSV</th><th>Họ tên</th><th>Có mặt</th><th>Đi trễ</th><th>Có phép</th><th>Vắng</th><th>Tỷ lệ</th><th>Nhóm</th></tr>
          ${r.rows.map(x => `<tr style="${x.nguy_co ? 'background:#fdecea' : ''}">
            <td>${esc(x.ma)}</td><td>${esc(x.ho_ten)}</td>
            <td>${x.co_mat}</td><td>${x.di_tre}</td><td>${x.co_phep}</td><td>${x.vang}</td>
            <td>${x.ty_le === null ? '—' : x.ty_le + '%'}</td>
            <td>${esc(x.nhom)}${x.nguy_co ? ' · Nguy cơ cấm thi' : ''}</td>
          </tr>`).join('')}
        </table></div>`;
    } catch (err) { setMsg('tkErr', err.message); }
  };
  $('btnXl').onclick = () => download(`/api/gv/thong-ke/xlsx?${qs()}`, 'chuyen-can.xlsx').catch(e => setMsg('tkErr', e.message));
}

// ================= QUẢN TRỊ VIÊN =================
async function viewAdminUsers() {
  const users = await api('/api/admin/users');
  const roleOpts = sel => Object.entries(ROLE_NAME)
    .map(([v, l]) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${l}</option>`).join('');
  app.innerHTML = `
  <section class="card">
    <h2>Tạo tài khoản</h2>
    <form id="fUser" class="grid">
      <label>Mã số (MSSV/MSGV) <span class="req">*</span><input name="ma" required></label>
      <label>Họ tên <span class="req">*</span><input name="ho_ten" required></label>
      <label>Email<input name="email" type="email"></label>
      <label>Vai trò <span class="req">*</span><select name="vai_tro">${roleOpts('SV')}</select></label>
      <p id="uErr" class="err full"></p>
      <button class="primary full">Tạo tài khoản</button>
    </form>
  </section>
  <section class="card">
    <div class="row">
      <h2>Danh sách người dùng</h2>
      <input id="uSearch" placeholder="Tìm mã số / họ tên">
    </div>
    <p id="uMsg"></p>
    <div id="uList" class="scroll"></div>
  </section>`;

  const draw = () => {
    const q = $('uSearch').value.trim().toLowerCase();
    const rows = users.filter(u => !q || `${u.ma} ${u.ho_ten}`.toLowerCase().includes(q));
    $('uList').innerHTML = `<table>
      <tr><th>Mã số</th><th>Họ tên</th><th>Email</th><th>Vai trò</th><th>Trạng thái</th><th></th></tr>
      ${rows.map(u => `<tr>
        <td>${esc(u.ma)}</td><td>${esc(u.ho_ten)}</td><td>${esc(u.email || '')}</td>
        <td><select data-id="${u.id}" data-f="vai_tro">${roleOpts(u.vai_tro)}</select></td>
        <td><select data-id="${u.id}" data-f="trang_thai">
          ${['Đang hoạt động', 'Tạm khóa'].map(v => `<option ${v === u.trang_thai ? 'selected' : ''}>${v}</option>`).join('')}
        </select></td>
        <td><button class="small" data-edit="${u.id}">Sửa tên / email</button></td>
      </tr>`).join('')}
    </table>`;
  };
  $('uSearch').oninput = draw;
  $('uList').onchange = async e => {
    const sel = e.target.closest('select[data-id]');
    if (!sel) return;
    try {
      await api(`/api/admin/users/${sel.dataset.id}`, { method: 'PATCH', body: { [sel.dataset.f]: sel.value } });
      setMsg('uMsg', 'Đã cập nhật', true);
    } catch (err) { setMsg('uMsg', err.message); run(viewAdminUsers); }
  };
  $('uList').onclick = async e => {
    const b = e.target.closest('[data-edit]');
    if (!b) return;
    const u = users.find(x => String(x.id) === b.dataset.edit);
    const ten = prompt('Họ tên:', u.ho_ten);
    if (ten === null) return;
    const mail = prompt('Email:', u.email || '');
    if (mail === null) return;
    try {
      await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { ho_ten: ten, email: mail } });
      run(viewAdminUsers);
    } catch (err) { setMsg('uMsg', err.message); }
  };
  draw();

  $('fUser').onsubmit = async e => {
    e.preventDefault();
    try {
      const r = await api('/api/admin/users', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      alert(`Đã tạo tài khoản.\nMật khẩu tạm: ${r.mat_khau_tam}\nHãy gửi mật khẩu này cho người dùng. Mật khẩu chỉ hiển thị một lần.`);
      run(viewAdminUsers);
    } catch (err) { setMsg('uErr', err.message); }
  };
}

const DM = {
  subjects: {
    title: 'Môn học', ep: '/api/admin/subjects',
    fields: [
      { k: 'ma_mon', l: 'Mã môn' }, { k: 'ten_mon', l: 'Tên môn' },
      { k: 'so_tin_chi', l: 'Số tín chỉ', type: 'number' },
    ],
    cols: ['Mã môn', 'Tên môn', 'Số tín chỉ'],
    row: r => [r.ma_mon, r.ten_mon, r.so_tin_chi],
  },
  classes: {
    title: 'Lớp học phần', ep: '/api/admin/classes',
    fields: [
      { k: 'ma_lop', l: 'Mã lớp' }, { k: 'ten_lop', l: 'Tên lớp', opt: true },
      { k: 'subject_id', l: 'Môn học', sel: 'subjects', text: x => `${x.ma_mon} – ${x.ten_mon}` },
      { k: 'semester_id', l: 'Học kỳ', sel: 'semesters', text: x => x.ten },
      { k: 'gv_id', l: 'GV phụ trách', sel: 'gvs', text: x => `${x.ma} – ${x.ho_ten}` },
    ],
    cols: ['Mã lớp', 'Môn học', 'Học kỳ', 'GV phụ trách'],
    row: r => [r.ma_lop, r.ten_mon, r.ten_hoc_ky, r.ten_gv],
  },
  semesters: {
    title: 'Học kỳ & năm học', ep: '/api/admin/semesters',
    fields: [
      { k: 'ma', l: 'Mã học kỳ' }, { k: 'ten', l: 'Tên học kỳ' },
      { k: 'ngay_bd', l: 'Ngày bắt đầu', type: 'date' }, { k: 'ngay_kt', l: 'Ngày kết thúc', type: 'date' },
    ],
    cols: ['Mã', 'Tên', 'Bắt đầu', 'Kết thúc'],
    row: r => [r.ma, r.ten, dmy(r.ngay_bd), dmy(r.ngay_kt)],
  },
};

async function viewAdminDanhMuc(key = 'subjects') {
  const dm = await api('/api/danh-muc');
  app.innerHTML = `
  <section class="card">
    <div class="row">${Object.keys(DM).map(k =>
      `<button class="${k === key ? 'primary' : ''}" data-tab="${k}">${DM[k].title}</button>`).join('')}</div>
  </section>
  <section class="card" id="dmBody"></section>`;
  app.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => run(() => viewAdminDanhMuc(b.dataset.tab)));
  await drawDm(key, dm);
}

async function drawDm(key, dm) {
  const cfg = DM[key];
  const rows = await api(cfg.ep);
  const byId = new Map(rows.map(r => [String(r.id), r]));
  const fields = cfg.fields.map(f => {
    const req = f.opt ? '' : ' <span class="req">*</span>';
    const el = f.sel
      ? `<select name="${f.k}">${dm[f.sel].map(x => `<option value="${x.id}">${esc(f.text(x))}</option>`).join('')}</select>`
      : `<input name="${f.k}" type="${f.type || 'text'}" ${f.type === 'number' ? 'min="1"' : ''} ${f.opt ? '' : 'required'}>`;
    return `<label>${f.l}${req}${el}</label>`;
  }).join('');

  $('dmBody').innerHTML = `
    <div class="row">
      <h2>${cfg.title}</h2>
      <button class="small" id="btnBulk">Xóa các mục đã chọn</button>
    </div>
    <form id="fDm" class="grid">
      ${fields}
      <p id="dmErr" class="err full"></p>
      <div class="row full">
        <button class="primary" id="btnSave" type="submit">Thêm mới</button>
        <button type="button" id="btnReset">Làm mới form</button>
      </div>
    </form>
    ${key === 'subjects' ? `<details class="card">
      <summary>Nhập môn học từ file CSV (cột: ma_mon, ten_mon, so_tin_chi)</summary>
      <form id="fCsv" class="stack">
        <input type="file" name="file" accept=".csv,.xlsx" required>
        <p id="csvErr"></p>
        <button>Nhập file</button>
      </form>
      <div id="csvRes"></div>
    </details>` : ''}
    <p id="dmMsg"></p>
    <div class="scroll"><table>
      <tr><th><input type="checkbox" id="chkAll"></th>${cfg.cols.map(c => `<th>${c}</th>`).join('')}<th></th></tr>
      ${rows.map(r => `<tr>
        <td><input type="checkbox" class="chk" value="${r.id}"></td>
        ${cfg.row(r).map(v => `<td>${esc(v ?? '')}</td>`).join('')}
        <td><button class="small" data-edit="${r.id}">Sửa</button> <button class="small" data-del="${r.id}">Xóa</button></td>
      </tr>`).join('') || '<tr><td colspan="9">Chưa có dữ liệu</td></tr>'}
    </table></div>`;

  const f = $('fDm');
  let editing = null;
  $('btnReset').onclick = () => { f.reset(); editing = null; $('btnSave').textContent = 'Thêm mới'; };
  $('chkAll').onchange = e => document.querySelectorAll('.chk').forEach(c => c.checked = e.target.checked);
  f.onsubmit = async e => {
    e.preventDefault();
    try {
      await api(editing ? `${cfg.ep}/${editing}` : cfg.ep, {
        method: editing ? 'PUT' : 'POST',
        body: Object.fromEntries(new FormData(f)),
      });
      run(() => viewAdminDanhMuc(key));
    } catch (err) { setMsg('dmErr', err.message); }
  };
  $('dmBody').onclick = async e => {
    const ed = e.target.closest('[data-edit]');
    const del = e.target.closest('[data-del]');
    if (ed) {
      const r = byId.get(ed.dataset.edit);
      cfg.fields.forEach(x => { if (f[x.k]) f[x.k].value = r[x.k] ?? ''; });
      editing = r.id;
      $('btnSave').textContent = 'Lưu thay đổi';
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    if (del) {
      if (!confirm('Xóa mục này?')) return;
      try { await api(`${cfg.ep}/${del.dataset.del}`, { method: 'DELETE' }); run(() => viewAdminDanhMuc(key)); }
      catch (err) { setMsg('dmMsg', err.message); }
    }
  };
  $('btnBulk').onclick = async () => {
    const ids = [...document.querySelectorAll('.chk:checked')].map(c => Number(c.value));
    if (!ids.length) return setMsg('dmMsg', 'Chọn ít nhất một mục để xóa');
    if (!confirm(`Xóa ${ids.length} mục đã chọn?`)) return;
    try {
      const r = await api(`${cfg.ep}/xoa-hang-loat`, { method: 'POST', body: { ids } });
      alert(`Đã xóa ${r.xoa} mục.` + (r.khong_xoa ? ` ${r.khong_xoa} mục đang được sử dụng nên không được xóa.` : ''));
      run(() => viewAdminDanhMuc(key));
    } catch (e) { setMsg('dmMsg', e.message); }
  };
  if (key === 'subjects') $('fCsv').onsubmit = async e => {
    e.preventDefault();
    try {
      const fd = new FormData(e.target);
      const r = await apiForm(`${cfg.ep}/import`, fd);
      $('csvRes').innerHTML = `<p class="ok">Đã thêm ${r.them} môn học.</p>
        ${r.bo_qua.length ? `<ul>${r.bo_qua.map(x => `<li>Dòng ${x.dong}: ${esc(x.ly_do)}</li>`).join('')}</ul>` : ''}`;
      setMsg('csvErr', '');
    } catch (err) { setMsg('csvErr', err.message); }
  };
}

async function viewAdminSaoLuu() {
  const [list, logs] = await Promise.all([api('/api/admin/backups'), api('/api/admin/audit')]);
  const t = s => (s || '').replace('T', ' ').slice(0, 19);
  app.innerHTML = `
  <section class="card">
    <div class="row">
      <h2>Sao lưu dữ liệu</h2>
      <button class="primary" id="btnBk">Tạo bản sao lưu ngay</button>
    </div>
    <p class="muted">Bản sao lưu là toàn bộ cơ sở dữ liệu, lưu trong thư mục data/backups trên máy chủ.</p>
    <p id="bkMsg"></p>
  </section>
  <section class="card">
    <h2>Lịch sử sao lưu</h2>
    <div class="scroll"><table>
      <tr><th>Tên tệp</th><th>Loại</th><th>Dung lượng</th><th>Thời điểm</th><th>Người thực hiện</th><th>Trạng thái</th><th></th></tr>
      ${list.map(b => `<tr>
        <td>${esc(b.ten)}</td><td>${esc(b.loai)}</td><td>${((b.dung_luong || 0) / 1024).toFixed(1)} KB</td>
        <td>${t(b.tao_luc)}</td><td>${esc(b.nguoi)}</td>
        <td class="${b.trang_thai === 'Thành công' ? 'st-green' : 'st-red'}">${esc(b.trang_thai)}</td>
        <td>${b.trang_thai === 'Thành công'
          ? `<button class="small" data-dl="${b.id}" data-name="${esc(b.ten)}">Tải về</button>` : ''}</td>
      </tr>`).join('') || '<tr><td colspan="7">Chưa có bản sao lưu nào</td></tr>'}
    </table></div>
  </section>
  <section class="card">
    <h2>Nhật ký thao tác</h2>
    <div class="scroll"><table>
      <tr><th>Thời điểm</th><th>Người dùng</th><th>Hành động</th><th>Chi tiết</th></tr>
      ${logs.map(a => `<tr>
        <td>${t(a.thoi_gian)}</td><td>${esc(a.nguoi)}</td><td>${esc(a.hanh_dong)}</td><td>${esc(a.chi_tiet || '')}</td>
      </tr>`).join('') || '<tr><td colspan="4">Chưa có nhật ký</td></tr>'}
    </table></div>
  </section>`;

  const btn = $('btnBk');
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = 'Đang sao lưu...';
    try {
      const r = await api('/api/admin/backup', { method: 'POST' });
      alert(`Sao lưu hoàn tất: ${r.ten}`);
      run(viewAdminSaoLuu);
    } catch (e) {
      setMsg('bkMsg', e.message);
      btn.disabled = false;
      btn.textContent = 'Tạo bản sao lưu ngay';
    }
  };
  app.querySelectorAll('[data-dl]').forEach(b => b.onclick = () =>
    download(`/api/admin/backups/${b.dataset.dl}/tai`, b.dataset.name).catch(e => setMsg('bkMsg', e.message)));
}


// ================= ĐỢT 1: CẢNH BÁO & KHIẾU NẠI =================
async function viewSvThongBao() {
  const list = await api('/api/sv/thong-bao');
  app.innerHTML = `<section class="card"><h2>Thông báo</h2>
    ${list.length ? list.map(n => `<div class="slot"><div>${esc(n.noi_dung)}</div>
      <span class="muted">${esc((n.tao_luc || '').replace('T', ' ').slice(0, 16))}</span></div>`).join('')
      : '<p class="muted">Bạn chưa có thông báo nào.</p>'}
  </section>`;
}

async function viewSvKhieuNai() {
  const [list, classes] = await Promise.all([api('/api/sv/khieu-nai'), api('/api/sv/lich-su')]);
  app.innerHTML = `
  <section class="card">
    <h2>Gửi khiếu nại kết quả</h2>
    <p class="muted">Chỉ khiếu nại được trong vòng 48 giờ kể từ khi có cảnh báo vắng của lớp.</p>
    <form id="fKn" class="grid">
      <label>Lớp học <span class="req">*</span>
        <select name="class_id" required>
          ${classes.map(c => `<option value="${c.id}">${esc(c.ma_lop)} – ${esc(c.ten_mon)}</option>`).join('')}
        </select></label>
      <label class="full">Nội dung khiếu nại <span class="req">*</span>
        <textarea name="noi_dung" rows="3" maxlength="500" required></textarea></label>
      <p id="knErr" class="err full"></p>
      <button class="primary full">Gửi khiếu nại</button>
    </form>
  </section>
  <section class="card">
    <h2>Khiếu nại của tôi</h2>
    ${list.length ? `<div class="scroll"><table>
      <tr><th>Ngày gửi</th><th>Lớp</th><th>Nội dung</th><th>Trạng thái</th><th>Phản hồi</th></tr>
      ${list.map(k => `<tr><td>${esc((k.tao_luc || '').replace('T', ' ').slice(0, 16))}</td>
        <td>${esc(k.ma_lop)}</td><td>${esc(k.noi_dung)}</td>
        <td>${esc(k.trang_thai)}</td><td>${esc(k.phan_hoi || '—')}</td></tr>`).join('')}
    </table></div>` : '<p class="muted">Bạn chưa gửi khiếu nại nào.</p>'}
  </section>`;
  $('fKn').onsubmit = async e => {
    e.preventDefault();
    const b = Object.fromEntries(new FormData(e.target));
    try {
      await api('/api/sv/khieu-nai', { method: 'POST', body: { class_id: Number(b.class_id), noi_dung: b.noi_dung } });
      run(viewSvKhieuNai);
    } catch (err) { setMsg('knErr', err.message); }
  };
}

async function viewGvCanhBao() {
  const classes = await api('/api/gv/lop');
  app.innerHTML = `<section class="card">
    <h2>Cảnh báo sinh viên vắng</h2>
    <p class="muted">Gửi thông báo cho sinh viên vắng không phép trong lớp, tính trên các buổi đã kết thúc.</p>
    ${classes.length ? `<div class="scroll"><table>
      <tr><th>Lớp</th><th>Môn học</th><th>Sĩ số</th><th></th></tr>
      ${classes.map(c => `<tr><td>${esc(c.ma_lop)}</td><td>${esc(c.ten_mon)}</td><td>${c.so_sv}</td>
        <td><button class="small primary" data-cb="${c.id}">Gửi cảnh báo</button></td></tr>`).join('')}
    </table></div>` : '<p class="muted">Bạn chưa có lớp học nào.</p>'}
    <p id="cbMsg"></p>
  </section>`;
  app.querySelectorAll('[data-cb]').forEach(b => b.onclick = async () => {
    if (!confirm('Gửi cảnh báo vắng đến tất cả sinh viên vắng của lớp này?')) return;
    try {
      const r = await api(`/api/gv/lop/${b.dataset.cb}/canh-bao`, { method: 'POST' });
      setMsg('cbMsg', r.so ? `Đã gửi cảnh báo cho ${r.so} sinh viên.` : (r.message || 'Không có sinh viên vắng.'), true);
    } catch (e) { setMsg('cbMsg', e.message); }
  });
}

async function viewGvKhieuNai() {
  const list = await api('/api/gv/khieu-nai');
  app.innerHTML = `<section class="card">
    <h2>Khiếu nại của sinh viên</h2>
    ${list.length ? `<div class="scroll"><table>
      <tr><th>Ngày gửi</th><th>Sinh viên</th><th>Lớp</th><th>Nội dung</th><th>Trạng thái</th><th>Phản hồi</th><th></th></tr>
      ${list.map(k => `<tr><td>${esc((k.tao_luc || '').replace('T', ' ').slice(0, 16))}</td>
        <td>${esc(k.ma_sv)} – ${esc(k.ten_sv)}</td><td>${esc(k.ma_lop)}</td>
        <td>${esc(k.noi_dung)}</td><td>${esc(k.trang_thai)}</td><td>${esc(k.phan_hoi || '—')}</td>
        <td>${k.trang_thai === 'Chờ xử lý' ? `<button class="small" data-pr="${k.id}">Phản hồi</button>` : ''}</td></tr>`).join('')}
    </table></div>` : '<p class="muted">Chưa có khiếu nại nào.</p>'}
    <p id="knMsg"></p>
  </section>`;
  app.querySelectorAll('[data-pr]').forEach(b => b.onclick = async () => {
    const text = (prompt('Nhập phản hồi cho sinh viên:') || '').trim();
    if (!text) return;
    try {
      await api(`/api/gv/khieu-nai/${b.dataset.pr}`, { method: 'PATCH', body: { phan_hoi: text } });
      run(viewGvKhieuNai);
    } catch (e) { setMsg('knMsg', e.message); }
  });
}

// ================= KHỞI ĐỘNG =================
logoutBtn.onclick = logout;
window.addEventListener('hashchange', render);
render();
// Bấm logo SQAS ở thanh bên để về trang chủ
document.querySelector('.brand').addEventListener('click', () => {
  if (!user) return render();
  const target = HOME[user.vai_tro];
  if (location.hash === target) return render();
  location.hash = target;
});
