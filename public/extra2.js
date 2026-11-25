// Bổ sung: thời khóa biểu tuần (SV), sửa/xóa buổi học (GV), sao lưu & nhật ký (Admin).
// Nạp sau app.js để thêm mục menu và trang mới.
const STATUS_OK = ['Có mặt', 'Đi trễ'];
const DAY_NAMES = ['Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7', 'Chủ nhật'];

const startOfWeek = d => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
};

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

// ---------- Sinh viên: thời khóa biểu tuần ----------
async function svTuan(offset = 0, subj = '') {
  const all = await api('/api/sv/buoi');
  const mon = startOfWeek(new Date());
  mon.setDate(mon.getDate() + offset * 7);
  const days = [0, 1, 2, 3, 4, 5, 6].map(i => {
    const d = new Date(mon);
    d.setDate(mon.getDate() + i);
    return d;
  });
  const from = isoDate(days[0]), to = isoDate(days[6]);
  const ended = all.filter(r => r.tt_buoi === 'Đã kết thúc');
  const coMat = ended.filter(r => STATUS_OK.includes(r.tt_sv)).length;
  const pct = ended.length ? Math.round(coMat / ended.length * 100) : 0;
  const subjects = [...new Set(all.map(r => r.ten_mon))];
  const list = all.filter(r => r.ngay >= from && r.ngay <= to && (!subj || r.ten_mon === subj));

  const slot = r => `
    <div class="slot ${r.tt_buoi === 'Đang điểm danh' ? 'live' : ''}">
      <div><b>${r.gio_bd}–${r.gio_kt}</b> · ${esc(r.ten_mon)} (${esc(r.ma_lop)})</div>
      <div class="muted">${esc(r.gv)} · Phòng ${esc(r.phong || '—')} · ${esc(r.tt_buoi)}</div>
      <div class="row">
        <span class="${STATUS_CLASS[r.tt_sv] || ''}">${esc(r.tt_sv)}</span>
        ${r.tt_buoi === 'Đang điểm danh' && r.tt_sv !== 'Có mặt'
          ? '<button class="small primary" data-scan>Quét mã</button>' : ''}
      </div>
    </div>`;

  app.innerHTML = `
  <section class="card">
    <div class="row">
      <h2>Thời khóa biểu tuần</h2>
      <div class="row">
        <button id="pv" class="small">◀ Tuần trước</button>
        <button id="nw" class="small">Tuần này</button>
        <button id="nx" class="small">Tuần sau ▶</button>
      </div>
    </div>
    <div class="row">
      <p class="muted">Tuần ${dmy(from)} – ${dmy(to)}</p>
      <select id="fSub"><option value="">Tất cả môn</option>
        ${subjects.map(s => `<option ${s === subj ? 'selected' : ''}>${esc(s)}</option>`).join('')}
      </select>
    </div>
  </section>
  <section class="card dash">
    ${donut(pct, 'Chuyên cần')}
    <div>
      <h3>Tổng quan học kỳ</h3>
      <p>Đã kết thúc ${ended.length} buổi, có mặt ${coMat} buổi.</p>
      <p class="muted">Tỷ lệ tính trên các buổi đã kết thúc, gồm có mặt và đi trễ.</p>
    </div>
  </section>
  <section class="week">
    ${days.map((d, i) => {
      const key = isoDate(d);
      const items = list.filter(r => r.ngay === key);
      return `<div class="day"><h3>${DAY_NAMES[i]} · ${dmy(key)}</h3>
        ${items.length ? items.map(slot).join('') : '<p class="muted">Không có buổi học</p>'}
      </div>`;
    }).join('')}
  </section>`;

  document.getElementById('pv').onclick = () => run(() => svTuan(offset - 1, subj));
  document.getElementById('nx').onclick = () => run(() => svTuan(offset + 1, subj));
  document.getElementById('nw').onclick = () => run(() => svTuan(0, subj));
  document.getElementById('fSub').onchange = e => run(() => svTuan(offset, e.target.value));
  app.querySelectorAll('[data-scan]').forEach(b => b.onclick = () => openScanner());
}

// ---------- Giảng viên: sửa / xóa buổi học ----------
async function gvQuanLyBuoi(editId = null) {
  const list = await api('/api/gv/buoi');
  const cur = editId ? list.find(x => x.id === editId) : null;
  app.innerHTML = `
  ${cur ? `<section class="card">
    <h2>Sửa buổi học · ${esc(cur.ma_lop)}</h2>
    <form id="fEd" class="grid">
      <label>Ngày học <span class="req">*</span><input type="date" name="ngay" value="${cur.ngay}" required></label>
      <label>Giờ bắt đầu <span class="req">*</span><input type="time" name="gio_bd" value="${cur.gio_bd}" required></label>
      <label>Giờ kết thúc <span class="req">*</span><input type="time" name="gio_kt" value="${cur.gio_kt}" required></label>
      <label>Phòng<input name="phong" value="${esc(cur.phong || '')}"></label>
      <p id="edErr" class="err full"></p>
      <div class="row full">
        <button class="primary" type="submit">Lưu thay đổi</button>
        <button type="button" id="edCancel">Hủy</button>
      </div>
    </form>
  </section>` : ''}
  <section class="card">
    <h2>Quản lý buổi học</h2>
    <div class="scroll"><table>
      <tr><th>Ngày</th><th>Giờ</th><th>Lớp</th><th>Phòng</th><th>Trạng thái</th><th></th></tr>
      ${list.map(s => `<tr>
        <td>${dmy(s.ngay)}</td><td>${s.gio_bd}–${s.gio_kt}</td><td>${esc(s.ma_lop)}</td>
        <td>${esc(s.phong || '—')}</td><td>${esc(s.trang_thai)}</td>
        <td><button class="small" data-ed="${s.id}">Sửa</button>
            <button class="small" data-del="${s.id}">Xóa</button></td>
      </tr>`).join('') || '<tr><td colspan="6">Chưa có buổi học nào</td></tr>'}
    </table></div>
  </section>`;

  if (cur) {
    const f = document.getElementById('fEd');
    f.onsubmit = async e => {
      e.preventDefault();
      try {
        await api(`/api/gv/buoi/${cur.id}`, { method: 'PUT', body: Object.fromEntries(new FormData(f)) });
        run(() => gvQuanLyBuoi());
      } catch (err) { setMsg('edErr', err.message); }
    };
    document.getElementById('edCancel').onclick = () => run(() => gvQuanLyBuoi());
  }
  app.querySelectorAll('[data-ed]').forEach(b => b.onclick = () => run(() => gvQuanLyBuoi(Number(b.dataset.ed))));
  app.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('Xóa buổi học này?')) return;
    try {
      await api(`/api/gv/buoi/${b.dataset.del}`, { method: 'DELETE' });
      run(() => gvQuanLyBuoi());
    } catch (e) { alert(e.message); }
  });
}

// ---------- Quản trị viên: sao lưu & nhật ký ----------
async function adminSaoLuu() {
  const [list, logs] = await Promise.all([api('/api/admin/backups'), api('/api/admin/audit')]);
  const time = s => (s || '').replace('T', ' ').slice(0, 19);
  app.innerHTML = `
  <section class="card">
    <div class="row">
      <h2>Sao lưu dữ liệu</h2>
      <button class="primary" id="btnBk">Tạo bản sao lưu ngay</button>
    </div>
    <p class="muted">Bản sao lưu là toàn bộ cơ sở dữ liệu. Khôi phục hiện thực hiện trên máy chủ, chưa có trên giao diện.</p>
  </section>
  <section class="card">
    <h2>Lịch sử sao lưu</h2>
    <div class="scroll"><table>
      <tr><th>Tên tệp</th><th>Loại</th><th>Dung lượng</th><th>Thời điểm</th><th>Người thực hiện</th><th>Trạng thái</th><th></th></tr>
      ${list.map(b => `<tr>
        <td>${esc(b.ten)}</td><td>${esc(b.loai)}</td><td>${((b.dung_luong || 0) / 1024).toFixed(1)} KB</td>
        <td>${time(b.tao_luc)}</td><td>${esc(b.nguoi)}</td>
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
        <td>${time(a.thoi_gian)}</td><td>${esc(a.nguoi)}</td><td>${esc(a.hanh_dong)}</td><td>${esc(a.chi_tiet || '')}</td>
      </tr>`).join('') || '<tr><td colspan="4">Chưa có nhật ký</td></tr>'}
    </table></div>
  </section>`;

  const btn = document.getElementById('btnBk');
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = 'Đang sao lưu...';
    try {
      const r = await api('/api/admin/backup', { method: 'POST' });
      alert(`Sao lưu hoàn tất: ${r.ten}`);
      run(() => adminSaoLuu());
    } catch (e) {
      alert(e.message);
      btn.disabled = false;
      btn.textContent = 'Tạo bản sao lưu ngay';
    }
  };
  app.querySelectorAll('[data-dl]').forEach(b => b.onclick = () =>
    download(`/api/admin/backups/${b.dataset.dl}/tai`, b.dataset.name).catch(e => alert(e.message)));
}

// ---------- Đăng ký menu và trang mới ----------
MENU.SV.push(['#/sv/tkb', 'Thời khóa biểu tuần']);
MENU.GV.push(['#/gv/quan-ly-buoi', 'Sửa / xóa buổi học']);
MENU.ADMIN.push(['#/admin/sao-luu', 'Sao lưu & nhật ký']);

const ROUTES = {
  'sv/tkb': () => svTuan(0),
  'gv/quan-ly-buoi': () => gvQuanLyBuoi(),
  'admin/sao-luu': () => adminSaoLuu(),
};
const prevRoute = window.extraRoute;
window.extraRoute = key => {
  if (ROUTES[key]) { run(ROUTES[key]); return true; }
  return prevRoute ? prevRoute(key) : false;
};

// Giao diện bổ sung cho thời khóa biểu, thẻ buổi học và bảng sao lưu
document.head.insertAdjacentHTML('beforeend', `<style>
  .dash { display: flex; gap: 20px; align-items: center; flex-wrap: wrap; }
  .week { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
  .day { background: #fff; border: 1px solid var(--line); border-radius: 16px; padding: 14px;
    display: grid; gap: 10px; align-content: start; }
  .day h3 { font-size: 15px; margin: 0; }
  .slot { border-radius: 12px; padding: 10px; background: #f6faf9; border-left: 4px solid var(--teal-2);
    display: grid; gap: 6px; font-size: 14px; }
  .slot.live { border-left-color: var(--green); background: #e8f7ee; }
  .slot .muted { font-size: 12px; }
</style>`);

render();