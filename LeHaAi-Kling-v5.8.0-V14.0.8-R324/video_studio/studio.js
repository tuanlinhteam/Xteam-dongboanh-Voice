const state = {
  records: [], selected: new Set(), timeline: [], activeId: '', selectedVideoIds: new Set(),
  audioPath: '', audioName: '', audioUrl: '', audioSourceDuration: 0,
  audioStart: 0, audioTrim: 0, audioDuration: 0, zoom: 90, previewZoom: 100,
  audioClips: [], audioAssets: [], activeAudioId: '', selectedAudioIds: new Set(), copiedAudio: null, previewAudioId: '', videoTrackMuted: false, audioTrackMuted: false,
  playhead: 0, history: [], future: [], playing: false,
  scrubbing: false, panning: false, clipPointerMoved: false, surfacePointer: false,
  copiedClip: null, activeTrack: 'video', musicStopTimer: 0,
  providerFilter: 'all', editedPage: 1, libraryPages: { source: 1, merged: 1, edited: 1 },
  assetLimit: 40, renderedAssetsSignature: '', renderedAudioSignature: '', timelineRenderFrame: 0,
  masterMuted: false, tiktokSingleId: '', tiktokSettings: null,
};
const LIBRARY_PAGE_SIZE = 24;
let libraryRefreshBusy = false;
let libraryRecordsSignature = '';

const $ = id => document.getElementById(id);
const clamp = (v, min, max) => Math.min(max, Math.max(min, Number(v) || 0));
const fmt = s => {
  s = Math.max(0, Number(s) || 0);
  return `${Math.floor(s / 60).toString().padStart(2, '0')}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
};
const fmtPrecise = s => {
  s = Math.max(0, Number(s) || 0);
  return `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toFixed(2).padStart(5, '0')}`;
};
const fmtLibraryTime = value => {
  let epoch = Number(value) || 0;
  if (!epoch) return '—';
  if (epoch < 100000000000) epoch *= 1000;
  const date = new Date(epoch);
  if (Number.isNaN(date.getTime())) return '—';
  const two = number => String(number).padStart(2, '0');
  return `${two(date.getHours())}:${two(date.getMinutes())} · ${two(date.getDate())}/${two(date.getMonth() + 1)}/${two(date.getFullYear() % 100)}`;
};
const escapeHtml = s => String(s || '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

async function api(url, opts = {}) {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const json = await response.json();
  if (!response.ok || json.ok === false) throw new Error(json.error || 'Lỗi xử lý');
  return json;
}

function setView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `${name}View`));
  document.querySelectorAll('.nav').forEach(v => v.classList.toggle('active', v.dataset.view === name));
  if (name === 'editor') requestAnimationFrame(renderTimeline);
  if (name === 'library') refreshLibraryIfChanged();
}
function recordById(id) { return state.records.find(r => r.id === id); }
function activeClip() { return state.timeline.find(c => c.uid === state.activeId) || null; }
function selectedVideoClips() {
  const clips = state.timeline.filter(c => state.selectedVideoIds.has(c.uid));
  return clips.length ? clips : (activeClip() ? [activeClip()] : []);
}
function selectedAudioClips() {
  const clips = state.audioClips.filter(c => state.selectedAudioIds.has(c.uid));
  return clips.length ? clips : (activeAudioClip() ? [activeAudioClip()] : []);
}
function selectOnlyVideo(id) {
  state.selectedVideoIds = new Set(id ? [id] : []);
  state.selectedAudioIds.clear();
  state.activeId = id || '';
  state.activeAudioId = '';
  state.activeTrack = 'video';
}
function selectOnlyAudio(id) {
  state.selectedAudioIds = new Set(id ? [id] : []);
  state.selectedVideoIds.clear();
  state.activeAudioId = id || '';
  state.activeId = '';
  state.activeTrack = 'audio';
}
function clipOutputDuration(c) { return Math.max(.01, (Number(c.end) - Number(c.start)) / Math.max(.25, Number(c.speed) || 1)); }
function projectDuration() { return state.timeline.reduce((sum, c) => sum + clipOutputDuration(c), 0); }
function clipLayout() {
  let cursor = 0;
  return state.timeline.map((clip, index) => {
    const start = cursor;
    const duration = clipOutputDuration(clip);
    cursor += duration;
    return { clip, index, start, end: cursor, duration };
  });
}
function clipAtProject(time) {
  const rows = clipLayout();
  if (!rows.length) return null;
  const t = clamp(time, 0, projectDuration());
  return rows.find(row => t < row.end - .0001) || rows[rows.length - 1];
}
function sourceTimeAtPlayhead(row = null) {
  row = row || clipLayout().find(x => x.clip.uid === state.activeId);
  if (!row) return null;
  const localProject = clamp(state.playhead - row.start, 0, row.duration);
  return row.clip.start + localProject * row.clip.speed;
}

function snapshotHistory() {
  state.history.push(JSON.stringify({ timeline: state.timeline, activeId: state.activeId, playhead: state.playhead, audioClips: state.audioClips, activeAudioId: state.activeAudioId }));
  if (state.history.length > 60) state.history.shift();
  state.future = [];
  updateUndoButtons();
}
function restoreSnapshot(raw) {
  try {
    const value = JSON.parse(raw);
    state.timeline = value.timeline || [];
    state.activeId = value.activeId || state.timeline[0]?.uid || '';
    state.audioClips = value.audioClips || state.audioClips || [];
    state.activeAudioId = value.activeAudioId || '';
    state.playhead = Number(value.playhead) || 0;
    renderEditor();
    seekProject(state.playhead, false);
  } catch (_) {}
}
function undo() {
  if (!state.history.length) return;
  state.future.push(JSON.stringify({ timeline: state.timeline, activeId: state.activeId, playhead: state.playhead, audioClips: state.audioClips, activeAudioId: state.activeAudioId }));
  restoreSnapshot(state.history.pop());
  updateUndoButtons();
}
function redo() {
  if (!state.future.length) return;
  state.history.push(JSON.stringify({ timeline: state.timeline, activeId: state.activeId, playhead: state.playhead, audioClips: state.audioClips, activeAudioId: state.activeAudioId }));
  restoreSnapshot(state.future.pop());
  updateUndoButtons();
}
function updateUndoButtons() {
  $('undo').disabled = !state.history.length;
  $('redo').disabled = !state.future.length;
}

async function load() {
  const data = await api('/api/library');
  state.records = data.records;
  libraryRecordsSignature = recordsSignature(data.records);
  state.selected = new Set(data.records.filter(x => x.selected).map(x => x.id));
  renderLibrary();
  if (location.hash === '#editor') openEditor();
  // Kho nhạc có thể phải đọc metadata nhiều file. Không để việc đó chặn lần
  // hiển thị đầu tiên của Thư viện Video; nạp nền rồi cập nhật editor sau.
  api('/api/audio/library').then(data => {
    state.audioAssets = data.assets || [];
    if ($('editorView').classList.contains('active')) renderAudioAssets();
  }).catch(() => { state.audioAssets = []; });
}
function recordsSignature(records) {
  return (Array.isArray(records) ? records : []).map(record => [
    record.id, record.title, record.createdAt, record.sizeBytes, record.provider, record.kind,
  ].join(':')).join('|');
}
async function refreshLibraryIfChanged() {
  // R360: Flow downloads/imports happen on a background worker. A Studio
  // window that was already open previously kept its one-time snapshot and
  // made a successfully imported video look missing. Refresh only the visible
  // Library page; never disturb the Editor/timeline while the user is working.
  if (libraryRefreshBusy || document.hidden || !$('libraryView')?.classList.contains('active')) return;
  libraryRefreshBusy = true;
  try {
    const data = await api(`/api/library?refresh=${Date.now()}`);
    const records = Array.isArray(data.records) ? data.records : [];
    const nextSignature = recordsSignature(records);
    if (nextSignature === libraryRecordsSignature) return;
    const available = new Set(records.map(record => record.id));
    state.selected = new Set([...state.selected].filter(id => available.has(id)));
    state.records = records;
    libraryRecordsSignature = nextSignature;
    renderLibrary();
    showToast('Thư viện đã nhận video mới.');
  } catch (_) {
    // The next focus/interval tick retries. A transient localhost request must
    // not interrupt preview or editing with a modal error.
  } finally {
    libraryRefreshBusy = false;
  }
}
function renderLibraryGroup(key, rows, gridId, emptyMessage) {
  const pages = Math.max(1, Math.ceil(rows.length / LIBRARY_PAGE_SIZE));
  state.libraryPages[key] = clamp(state.libraryPages[key] || 1, 1, pages);
  const page = state.libraryPages[key];
  const shown = rows.slice((page - 1) * LIBRARY_PAGE_SIZE, page * LIBRARY_PAGE_SIZE);
  const grid = $(gridId);
  grid.innerHTML = rows.length ? shown.map(card).join('') : `<div class="empty">${emptyMessage}</div>`;
  let pager = grid.nextElementSibling;
  if (!pager || !pager.classList.contains('library-pager')) {
    pager = document.createElement('div');
    pager.className = 'library-pager';
    grid.after(pager);
  }
  pager.innerHTML = rows.length > LIBRARY_PAGE_SIZE
    ? `<button data-library-page="${key}" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>‹ Trước</button><span>Trang ${page}/${pages} · đang hiện ${shown.length}/${rows.length}</span><button data-library-page="${key}" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>Sau ›</button>`
    : '';
}
function libraryProvider(record) {
  const provider = String(record && record.provider || '').trim().toLowerCase();
  return provider === 'dola' ? 'seedance' : provider;
}
function renderLibrary() {
  const providerCounts = {
    kling: state.records.filter(r => libraryProvider(r) === 'kling').length,
    veo: state.records.filter(r => libraryProvider(r) === 'veo').length,
    seedance: state.records.filter(r => libraryProvider(r) === 'seedance').length,
    local: state.records.filter(r => libraryProvider(r) === 'local').length,
  };
  const visible = state.providerFilter === 'all' ? state.records : state.records.filter(r => libraryProvider(r) === state.providerFilter);
  const sources = visible.filter(r => !r.kind || ['source', 'flow', 'seedance', 'dola'].includes(String(r.kind).toLowerCase()));
  const merged = visible.filter(r => r.kind === 'merged');
  const edited = visible.filter(r => r.kind === 'edited');
  $('count').textContent = `${state.records.length} video`;
  $('sourceCount').textContent = `${sources.length} video`;
  $('mergedCount').textContent = `${merged.length} video`;
  $('editedCount').textContent = `${edited.length} video`;
  $('allMenuCount').textContent = state.records.length;
  $('klingMenuCount').textContent = providerCounts.kling;
  $('veoMenuCount').textContent = providerCounts.veo;
  $('dolaMenuCount').textContent = providerCounts.seedance;
  $('localMenuCount').textContent = providerCounts.local;
  $('mergedMenuCount').textContent = merged.length;
  $('editedMenuCount').textContent = edited.length;
  $('selectedCount').textContent = `Đã chọn ${state.selected.size}`;
  updateDolaLogoButton();
  ['editSelected', 'mergeSelected', 'deleteSelected', 'publishTikTokSelected'].forEach(id => $(id).disabled = !state.selected.size);
  const empty = message => `<div class="empty">${message}</div>`;
  document.querySelectorAll('[data-provider-filter]').forEach(el => el.classList.toggle('active', el.dataset.providerFilter === state.providerFilter));
  renderLibraryGroup('source', sources, 'sourceGrid', 'Không có video nguồn trong bộ lọc này.');
  renderLibraryGroup('merged', merged, 'mergedGrid', 'Chưa có video đã ghép. Chọn các clip rồi bấm Ghép video.');
  renderLibraryGroup('edited', edited, 'editedGrid', 'Chưa có video đã xuất từ timeline.');
  const allEdited = state.records.filter(r => r.kind === 'edited');
  const editedPages = Math.max(1, Math.ceil(allEdited.length / 8));
  state.editedPage = clamp(state.editedPage, 1, editedPages);
  const editedRows = allEdited.slice((state.editedPage - 1) * 8, state.editedPage * 8);
  $('editorEditedCount').textContent = `${allEdited.length} video`;
  $('editorEditedGrid').innerHTML = allEdited.length ? editedRows.map(card).join('') : empty('Video xuất từ trang Edit sẽ hiển thị tại đây.');
  $('editedPager').innerHTML = allEdited.length > 8 ? `<button data-edited-page="${state.editedPage - 1}" ${state.editedPage <= 1 ? 'disabled' : ''}>‹ Trước</button><span>Trang ${state.editedPage}/${editedPages}</span><button data-edited-page="${state.editedPage + 1}" ${state.editedPage >= editedPages ? 'disabled' : ''}>Sau ›</button>` : '';
  document.querySelectorAll('[data-edited-page]').forEach(button => button.onclick = () => { state.editedPage = Number(button.dataset.editedPage); renderLibrary(); $('editorEditedSection').scrollIntoView({ block: 'start' }); });
  document.querySelectorAll('[data-library-page]').forEach(button => button.onclick = () => {
    const key = button.dataset.libraryPage;
    state.libraryPages[key] = Number(button.dataset.page) || 1;
    renderLibrary();
    $(`${key}Section`).scrollIntoView({ block: 'start' });
  });
  document.querySelectorAll('.card .check').forEach(el => el.onchange = () => toggle(el.dataset.id, el.checked));
  document.querySelectorAll('[data-preview]').forEach(el => el.onclick = () => previewCard(el.dataset.preview));
  document.querySelectorAll('[data-quick-preview]').forEach(el => el.onclick = event => quickPreviewCard(event, el.dataset.quickPreview));
  document.querySelectorAll('[data-edit-card]').forEach(el => el.onclick = () => editCard(el.dataset.editCard));
  // One click opens Explorer and selects the exact saved file. The API responds
  // before launching Explorer, so a slow Windows shell does not freeze the UI.
  document.querySelectorAll('.card .actions a[download]').forEach(el => {
    const article = el.closest('.card');
    const checkbox = article && article.querySelector('.check');
    const id = checkbox && checkbox.dataset.id;
    const downloadUrl = el.getAttribute('href') || '';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Tải Video';
    button.title = 'Mở vị trí file video đã lưu';
    button.onclick = () => openCardLocation(id).catch(error => alert(error.message || 'Không mở được vị trí video.'));
    el.replaceWith(button);
  });
  document.querySelectorAll('[data-delete-card]').forEach(el => el.onclick = () => deleteCardNow(el.dataset.deleteCard));
  document.querySelectorAll('[data-rename-card]').forEach(el => el.onclick = event => beginInlineRename(event, el.dataset.renameCard));
  document.querySelectorAll('[data-remove-logo]').forEach(el => el.onclick = () => removeLogoCopy(el.dataset.removeLogo, el));
  document.querySelectorAll('[data-publish-tiktok]').forEach(el => el.onclick = () => ttBusy('Đang mở TikTok…', () => openTikTokDialog(el.dataset.publishTiktok)));
}
async function removeLogoCopy(id, button) {
  await startLogoBatch([id]);
}
let logoBatchId = '';
let logoPolling = false;
let logoStarting = false;
function selectedDolaLogoIds() {
  return [...state.selected].filter(id => libraryProvider(recordById(id)) === 'seedance');
}
function updateDolaLogoButton() {
  const count = selectedDolaLogoIds().length;
  const active = Boolean(logoBatchId) || logoStarting;
  const button = $('removeLogosSelected');
  button.disabled = active || !count;
  button.textContent = active ? 'Đang xóa logo…' : 'Xóa logo Dola';
  button.title = count ? `Xử lý ${count} video Dola đã chọn; giữ bản gốc` : 'Hãy tích chọn video Dola';
}
async function startLogoBatch(ids) {
  if (logoBatchId || logoStarting || !ids.length) return;
  logoStarting = true;
  $('logoBatchDetails').hidden = false;
  $('logoBatchErrors').textContent = '';
  $('logoBatchStatus').textContent = `Đang bắt đầu xử lý ${ids.length} video…`;
  $('removeLogosSelected').disabled = true;
  try {
    const result = await api('/api/remove-logo/start', { method: 'POST', body: JSON.stringify({ ids }) });
    logoBatchId = result.jobId;
    sessionStorage.setItem('logoBatchId', logoBatchId);
    await pollLogoBatch();
  } catch (error) {
    $('logoBatchStatus').textContent = (error.message || 'Chưa thể xử lý logo.') + ' Video gốc vẫn được giữ nguyên.';
  } finally {
    logoStarting = false;
    updateDolaLogoButton();
  }
}
async function pollLogoBatch() {
  if (!logoBatchId || logoPolling) return;
  logoPolling = true;
  try {
    const response = await fetch(`/api/remove-logo/status?id=${encodeURIComponent(logoBatchId)}`);
    if (response.status === 404) {
      logoBatchId = '';
      sessionStorage.removeItem('logoBatchId');
      $('logoBatchStatus').textContent = 'Phiên xử lý trước đã kết thúc. Kiểm tra Video đã chỉnh sửa trước khi chạy lại.';
      updateDolaLogoButton();
      return;
    }
    if (!response.ok) throw new Error('Không đọc được tiến độ.');
    const job = await response.json();
    $('logoBatchStatus').textContent = `${job.status === 'done' ? 'Hoàn tất' : 'Đang xóa logo'}: ${job.completed}/${job.total} · Thành công ${job.succeeded} · Lỗi ${job.failed}`;
    if (job.status === 'done') {
      $('logoBatchDetails').hidden = false;
      $('logoBatchErrors').textContent = job.items.map(item => {
        const title = recordById(item.sourceId)?.title || item.sourceId;
        return item.status === 'done' ? `✓ ${title}` : `✗ ${title}: ${item.error}`;
      }).join('\n');
      for (const item of job.items) if (item.status === 'done') state.selected.delete(item.sourceId);
      logoBatchId = '';
      sessionStorage.removeItem('logoBatchId');
      await load();
      showToast(`Đã tạo ${job.succeeded} bản trong Video đã chỉnh sửa. ${job.failed} video lỗi.`);
    }
  } catch (error) {
    $('logoBatchStatus').textContent = 'Mất kết nối tiến độ; đang thử đọc lại…';
  } finally {
    logoPolling = false;
    updateDolaLogoButton();
    if (logoBatchId) setTimeout(pollLogoBatch, 1500);
  }
}
$('removeLogosSelected').onclick = () => startLogoBatch(selectedDolaLogoIds());
logoBatchId = sessionStorage.getItem('logoBatchId') || '';
if (logoBatchId) pollLogoBatch();
let toastTimer = 0;
function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 4200);
}

async function importLibraryVideo(file, input) {
  if (!file) return;
  await busy('Đang tải video vào Thư viện…', async () => {
    const response = await fetch('/api/video', {
      method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) }, body: file,
    });
    const json = await response.json();
    if (!response.ok || !json.ok) throw new Error(json.error || 'Không tải được video vào Thư viện');
    state.providerFilter = 'local';
    await load();
    showToast('Video đã được tải lên Thư viện và gắn nhãn “NỘI BỘ”.');
    if (input) input.value = '';
  });
}
async function openCardLocation(id) {
  if (!id) return;
  await api('/api/open-location', { method: 'POST', body: JSON.stringify({ id }) });
}
function downloadCard(id, url) {
  if (!id || !url) return;
  const record = recordById(id);
  const cleanTitle = String(record?.title || 'Kling-Video').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Kling-Video';
  const fileName = /\.mp4$/i.test(cleanTitle) ? cleanTitle : `${cleanTitle}.mp4`;
  const separator = url.includes('?') ? '&' : '?';
  const anchor = document.createElement('a');
  anchor.href = `${url}${separator}attachment=1&t=${Date.now()}`;
  anchor.download = fileName;
  anchor.hidden = true;
  document.body.appendChild(anchor);
  anchor.click();
  setTimeout(() => anchor.remove(), 1500);
}
function card(r) {
  const provider = libraryProvider(r);
  const providerLabel = provider === 'veo' ? 'VEO · FLOW' : provider === 'kling' ? 'KLING' : provider === 'seedance' ? 'DOLA · SEEDANCE' : 'NỘI BỘ';
  const kindLabel = r.kind === 'merged' ? `ĐÃ GHÉP · ${providerLabel}` : r.kind === 'edited' ? 'ĐÃ CHỈNH' : providerLabel;
  return `<article class="card ${state.selected.has(r.id) ? 'selected' : ''}">
    <span class="kind-badge provider-${escapeHtml(provider || 'local')}">${kindLabel}</span>
    <input class="check" type="checkbox" data-id="${r.id}" ${state.selected.has(r.id) ? 'checked' : ''}>
    <div class="thumb quick-preview" data-quick-preview="${r.id}" title="Bấm để xem nhanh"><img src="${r.thumbnailUrl}" loading="lazy" decoding="async" onerror="this.style.display='none'"><button class="thumb-play" data-quick-preview-button="${r.id}" title="Xem nhanh video" aria-label="Xem nhanh video">▶</button></div>
    <div class="meta"><div class="title-row"><strong data-title-id="${escapeHtml(r.id)}" title="${escapeHtml(r.title)}">${escapeHtml(r.title)}</strong><button class="rename-title" data-rename-card="${escapeHtml(r.id)}" title="Sửa tên video" aria-label="Sửa tên video">✎</button></div><small>${escapeHtml(r.email)} · ${fmt(r.duration)} · ${(r.sizeBytes / 1048576).toFixed(1)} MB <span class="library-time">${fmtLibraryTime(r.createdAt)}</span></small></div>
    <div class="actions"><button class="card-edit" data-edit-card="${r.id}" title="Chỉnh sửa video">✎</button><button data-preview="${r.id}">Xem</button><button data-publish-tiktok="${r.id}" class="tiktok-mini">Đăng</button><button data-remove-logo="${r.id}" title="${libraryProvider(r) === 'seedance' ? 'Cắt mép logo Dola; giữ video gốc' : libraryProvider(r) === 'veo' ? 'Xử lý vùng logo VEO, không cắt mép; giữ video gốc' : 'Tạo bản sạch, giữ nguyên video gốc'}">Xóa logo</button><a href="${r.downloadUrl}" download>Tải</a><button class="quick-delete" data-delete-card="${r.id}" title="Xóa ngay, không hỏi">🗑</button></div>
  </article>`;
}
async function beginInlineRename(event, id) {
  event.preventDefault();
  event.stopPropagation();
  const record = recordById(id);
  const button = event.currentTarget;
  const row = button.closest('.title-row');
  const label = row && row.querySelector('[data-title-id]');
  if (!record || !row || !label || row.querySelector('.title-input')) return;
  const original = record.title || '';
  const input = document.createElement('input');
  input.className = 'title-input';
  input.type = 'text';
  input.maxLength = 180;
  input.value = original;
  label.replaceWith(input);
  button.hidden = true;
  input.focus();
  input.select();
  let finished = false;
  const finish = async save => {
    if (finished) return;
    finished = true;
    const next = input.value.replace(/\s+/g, ' ').trim();
    let finalTitle = original;
    try {
      if (save && next && next !== original) {
        const result = await api('/api/rename', {
          method: 'POST', body: JSON.stringify({ id, title: next }),
        });
        finalTitle = result.title;
        record.title = finalTitle;
        state.timeline.filter(clip => clip.id === id).forEach(clip => { clip.title = finalTitle; });
      }
    } catch (error) {
      alert(error.message || 'Không lưu được tên video.');
    }
    const restored = document.createElement('strong');
    restored.dataset.titleId = id;
    restored.title = finalTitle;
    restored.textContent = finalTitle;
    input.replaceWith(restored);
    button.hidden = false;
  };
  input.addEventListener('keydown', keyEvent => {
    if (keyEvent.key === 'Enter') { keyEvent.preventDefault(); finish(true); }
    if (keyEvent.key === 'Escape') { keyEvent.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true), { once: true });
}
async function deleteCardNow(id) {
  await api('/api/delete', { method: 'POST', body: JSON.stringify({ ids: [id] }) });
  state.selected.delete(id);
  state.timeline = state.timeline.filter(c => c.id !== id);
  await load();
}
function editCard(id) {
  state.selected = new Set([id]);
  state.timeline = [];
  state.activeId = '';
  openEditor();
}
function toggle(id, on) {
  on ? state.selected.add(id) : state.selected.delete(id);
  document.querySelectorAll(`.check[data-id="${CSS.escape(id)}"]`).forEach(box => {
    box.checked = on;
    box.closest('.card')?.classList.toggle('selected', on);
  });
  $('selectedCount').textContent = `Đã chọn ${state.selected.size}`;
  ['editSelected', 'mergeSelected', 'deleteSelected', 'publishTikTokSelected'].forEach(name => $(name).disabled = !state.selected.size);
  updateDolaLogoButton();
}
function previewCard(id) {
  const record = recordById(id);
  if (!record) return;
  const win = window.open('', `preview-${id}`, 'width=540,height=900');
  if (!win) return;
  win.document.title = record.title || 'Xem video';
  win.document.body.style.cssText = 'margin:0;background:#000;display:grid;place-items:center;min-height:100vh;overflow:hidden';
  win.document.body.innerHTML = '';
  const video = win.document.createElement('video');
  video.src = location.origin + record.previewUrl;
  video.controls = true;
  video.autoplay = true;
  video.muted = false;
  video.volume = 1;
  video.playsInline = true;
  video.preload = 'auto';
  video.style.cssText = 'max-width:100%;max-height:100vh;width:100%;height:100%;object-fit:contain;background:#000';
  win.document.body.appendChild(video);
  const playNow = () => { video.muted = false; video.volume = 1; video.play().catch(() => {}); };
  video.addEventListener('loadedmetadata', playNow, { once: true });
  video.addEventListener('canplay', playNow, { once: true });
  playNow();
  win.focus();
}

function quickPreviewCard(event, id) {
  event.preventDefault();
  event.stopPropagation();
  const record = recordById(id);
  const cardNode = event.currentTarget.closest('.card');
  const host = event.currentTarget.closest('.quick-preview') || cardNode?.querySelector('.quick-preview');
  if (!record || !host) return;
  state.playing = false;
  $('preview').pause();
  $('musicPreview').pause();
  const existing = host.querySelector('video');
  if (existing) {
    if (existing.paused) { existing.muted = false; existing.volume = 1; existing.play().catch(() => {}); }
    else { existing.pause(); resetQuickPreview(host, record); }
    host.classList.toggle('playing', !existing.paused);
    return;
  }
  document.querySelectorAll('.quick-preview video').forEach(video => {
    const otherHost = video.closest('.quick-preview');
    const other = recordById(otherHost?.dataset.quickPreview);
    video.pause();
    if (otherHost && other) resetQuickPreview(otherHost, other);
  });
  const video = document.createElement('video');
  video.src = record.previewUrl;
  video.controls = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.muted = false;
  video.volume = 1;
  host.innerHTML = '';
  host.appendChild(video);
  host.classList.add('playing');
  const playNow = () => { video.muted = false; video.volume = 1; video.play().catch(() => {}); };
  video.addEventListener('canplay', playNow, { once: true });
  playNow();
  video.onended = () => resetQuickPreview(host, record);
}
function resetQuickPreview(host, record) {
  host.classList.remove('playing');
  host.innerHTML = `<img src="${record.thumbnailUrl}" loading="lazy" decoding="async" onerror="this.style.display='none'"><button class="thumb-play" data-quick-preview-button="${record.id}" title="Xem nhanh video" aria-label="Xem nhanh video">▶</button>`;
}
function selectedRecords() { return [...state.selected].map(recordById).filter(Boolean); }
function makeClip(record) {
  const duration = Math.max(.05, Number(record.duration) || 10);
  return {
    uid: crypto.randomUUID(), id: record.id, title: record.title,
    start: 0, end: duration, sourceDuration: duration,
    speed: 1, volume: 1, muted: false, effect: 'none', transition: 'none', crop: { x: 0, y: 0, w: 1, h: 1 },
    previewUrl: record.previewUrl, thumbnailUrl: record.thumbnailUrl,
  };
}
function openEditor() {
  const records = selectedRecords();
  // The Editor tab is navigation, including when no library item is selected.
  if (!state.timeline.length && records.length) {
    state.timeline = records.map(makeClip);
    state.activeId = state.timeline[0]?.uid || '';
    state.playhead = 0;
    state.history = [];
    state.future = [];
  }
  setView('editor');
  renderEditor();
  seekProject(state.playhead, false);
}
function renderAssets() {
  const assets = state.records;
  const shown = assets.slice(0, state.assetLimit);
  const signature = `${state.assetLimit}|${assets.map(r => `${r.id}:${r.title}`).join('|')}`;
  if (signature === state.renderedAssetsSignature) return;
  state.renderedAssetsSignature = signature;
  $('assetList').innerHTML = (shown.map(r => `<article class="asset-item" draggable="true" data-asset-id="${r.id}">
    <img class="asset-thumb" src="${r.thumbnailUrl}" loading="lazy" decoding="async"><div class="asset-copy"><strong>${escapeHtml(r.title)}</strong><small>${fmt(r.duration)}</small></div>
    <button class="asset-add" data-add-asset="${r.id}">＋</button></article>`).join('') || '<div class="empty">Chọn video trong thư viện.</div>')
    + (assets.length > shown.length ? `<button class="asset-load-more" data-load-more-assets>Hiện thêm (${shown.length}/${assets.length})</button>` : '');
  document.querySelectorAll('[data-asset-id]').forEach(node => node.addEventListener('dragstart', event => {
    event.dataTransfer.setData('application/x-leha-asset', node.dataset.assetId);
    event.dataTransfer.effectAllowed = 'copy';
  }));
  document.querySelectorAll('[data-add-asset]').forEach(btn => btn.onclick = event => {
    event.stopPropagation(); addAsset(btn.dataset.addAsset);
  });
  document.querySelector('[data-load-more-assets]')?.addEventListener('click', () => {
    state.assetLimit += 40;
    state.renderedAssetsSignature = '';
    renderAssets();
  });
  document.querySelectorAll('[data-asset-id]').forEach(node => {
    const record = recordById(node.dataset.assetId);
    const copy = node.querySelector('.asset-copy');
    if (!copy || copy.querySelector('.asset-rename')) return;
    const rename = document.createElement('button');
    rename.className = 'asset-rename'; rename.title = 'Đổi tên video'; rename.textContent = '✎';
    rename.onclick = async event => {
      event.stopPropagation();
      const title = copy.querySelector('strong'); title.contentEditable = 'true'; title.focus(); document.execCommand('selectAll', false, null);
      title.onblur = async () => { title.contentEditable = 'false'; const value = title.textContent.trim(); if (!value) return renderAssets(); await api('/api/rename', { method: 'POST', body: JSON.stringify({ id: record.id, title: value }) }); await load(); renderAssets(); };
    };
    copy.appendChild(rename);
  });
}
function renderAudioAssets() {
  const signature = state.audioAssets.map(asset => `${asset.id}:${asset.name}:${asset.duration}`).join('|');
  if (signature === state.renderedAudioSignature) return;
  state.renderedAudioSignature = signature;
  $('audioAssetCount').textContent = `${state.audioAssets.length} file`;
  $('audioAssetList').innerHTML = state.audioAssets.map(asset => `<article class="audio-asset">
    <button class="audio-preview" data-preview-audio="${escapeHtml(asset.id)}" title="Nghe thử">▶</button>
    <div><strong>${escapeHtml(asset.name)}</strong><small>MP3 · ${fmt(asset.duration)}</small></div>
    <button data-rename-audio="${escapeHtml(asset.id)}" title="Đổi tên">✎</button><button data-add-audio="${escapeHtml(asset.id)}" title="Đưa vào timeline">＋</button><button data-delete-audio="${escapeHtml(asset.id)}" title="Xóa MP3">×</button>
  </article>`).join('') || '<small class="audio-empty">Nhạc đã nhập hoặc tách sẽ nằm ở đây.</small>';
  document.querySelectorAll('[data-add-audio]').forEach(btn => btn.onclick = () => {
    const asset = state.audioAssets.find(item => item.id === btn.dataset.addAudio);
    if (asset) addAudioAsset(asset);
  });
  document.querySelectorAll('[data-preview-audio]').forEach(btn => btn.onclick = () => {
    const asset = state.audioAssets.find(item => item.id === btn.dataset.previewAudio);
    const player = $('audioAssetPreview');
    if (!asset) return;
    if (state.previewAudioId === asset.id && !player.paused) { player.pause(); btn.textContent = '▶'; return; }
    document.querySelectorAll('.audio-preview').forEach(node => node.textContent = '▶');
    state.previewAudioId = asset.id; player.src = asset.url; player.play(); btn.textContent = '❚❚';
    player.onended = () => { btn.textContent = '▶'; state.previewAudioId = ''; };
  });
  document.querySelectorAll('[data-rename-audio]').forEach(btn => btn.onclick = async () => {
    const asset = state.audioAssets.find(item => item.id === btn.dataset.renameAudio);
    const title = btn.parentElement.querySelector('strong'); title.contentEditable = 'true'; title.focus(); document.execCommand('selectAll', false, null);
    title.onblur = async () => { title.contentEditable = 'false'; const name = title.textContent.trim(); if (!name) return; await api('/api/audio/rename', { method: 'POST', body: JSON.stringify({ id: asset.id, name }) }); state.audioAssets = (await api('/api/audio/library')).assets || []; state.renderedAudioSignature = ''; renderAudioAssets(); };
  });
  document.querySelectorAll('[data-delete-audio]').forEach(btn => btn.onclick = async () => { await api('/api/audio/delete', { method: 'POST', body: JSON.stringify({ id: btn.dataset.deleteAudio }) }); state.audioAssets = (await api('/api/audio/library')).assets || []; state.renderedAudioSignature = ''; renderAudioAssets(); });
}
function renderEditor() {
  state.selectedVideoIds = new Set([...state.selectedVideoIds].filter(id => state.timeline.some(clip => clip.uid === id)));
  state.selectedAudioIds = new Set([...state.selectedAudioIds].filter(id => state.audioClips.some(clip => clip.uid === id)));
  renderAssets();
  renderAudioAssets();
  renderTimeline();
  renderInspector();
  updatePreviewControls();
  updateUndoButtons();
  const total = projectDuration();
  $('projectInfo').textContent = `${state.timeline.length} đoạn · ${total.toFixed(1)}s`;
  $('timelineDuration').textContent = `${total.toFixed(1)}s`;
  const hasAudio = state.audioClips.length > 0;
  if (hasAudio) {
    $('audioTrack').classList.add('has-audio');
    $('audioTrackText').textContent = `${state.audioClips.length} đoạn âm thanh`;
    $('removeAudio').disabled = false;
    $('audioInfo').textContent = `${state.audioClips.length} đoạn · có thể kéo, trim, tách, copy và paste`;
  } else {
    $('audioTrack').classList.remove('has-audio');
    $('audioTrackText').textContent = 'Chưa có nhạc';
    $('removeAudio').disabled = true;
    $('audioInfo').textContent = 'Chưa có nhạc trên timeline';
  }
  renderAudioClip();
}
function renderAudioClip() {
  const host = $('audioClips');
  host.innerHTML = '';
  state.audioClips.forEach(clip => {
    const node = document.createElement('div');
    node.className = `audio-clip ${clip.uid === state.activeAudioId ? 'active' : ''} ${state.selectedAudioIds.has(clip.uid) ? 'multi-selected' : ''}`;
    node.dataset.audioId = clip.uid;
    node.style.left = `${Math.max(0, clip.timelineStart * state.zoom)}px`;
    node.style.width = `${Math.max(28, clip.duration * state.zoom)}px`;
    node.innerHTML = `<i class="audio-trim left" data-audio-trim="left"></i><button class="clip-mute" data-audio-mute title="Bật/tắt nhạc">${clip.muted ? '🔇' : '🔊'}</button><span>♫ ${escapeHtml(clip.name)} · ${Number(clip.speed || 1).toFixed(2)}x</span><i class="audio-trim right" data-audio-trim="right"></i>`;
    const mute = node.querySelector('[data-audio-mute]');
    mute.onpointerdown = event => { event.stopPropagation(); };
    mute.onclick = event => { event.preventDefault(); event.stopPropagation(); clip.muted = !clip.muted; renderAudioClip(); syncMusic(false); };
    node.addEventListener('pointerdown', beginAudioPointer);
    host.appendChild(node);
  });
}
function syncMusic(autoplay = false) {
  const audio = $('musicPreview');
  if (state.musicStopTimer) {
    clearTimeout(state.musicStopTimer);
    state.musicStopTimer = 0;
  }
  const clip = state.audioClips.find(item => state.playhead >= item.timelineStart && state.playhead < item.timelineStart + item.duration);
  if (!audio || !clip) {
    if (audio) audio.pause();
    return;
  }
  if (audio.dataset.audioId !== clip.uid) {
    audio.dataset.audioId = clip.uid;
    audio.src = clip.url;
    audio.load();
  }
  const speed = clamp(Number(clip.speed) || 1, .5, 2);
  const sourceTime = clip.trim + (state.playhead - clip.timelineStart) * speed;
  if (Math.abs((audio.currentTime || 0) - sourceTime) > .18) {
    try { audio.currentTime = sourceTime; } catch (_) {}
  }
  const previewVolume = Number($('musicVolume').value) * (Number.isFinite(Number(clip.volume)) ? Number(clip.volume) : 1);
  audio.volume = (state.masterMuted || state.audioTrackMuted || clip.muted) ? 0 : clamp(previewVolume, 0, 1);
  audio.playbackRate = speed;
  if (autoplay) {
    audio.play().catch(() => {});
    const remaining = Math.max(0, clip.timelineStart + clip.duration - state.playhead);
    state.musicStopTimer = setTimeout(() => {
      if (audio.dataset.audioId === clip.uid) audio.pause();
      state.musicStopTimer = 0;
    }, Math.max(1, remaining * 1000 + 20));
  }
}
function beginAudioPointer(event) {
  if (event.button !== 0 || event.target.closest('[data-audio-mute]')) return;
  event.stopPropagation();
  const id = event.currentTarget?.dataset.audioId || event.target.closest('[data-audio-id]')?.dataset.audioId;
  const clip = state.audioClips.find(item => item.uid === id);
  if (!clip) return;
  if (event.ctrlKey || event.metaKey) {
    if (state.selectedAudioIds.has(clip.uid)) state.selectedAudioIds.delete(clip.uid);
    else state.selectedAudioIds.add(clip.uid);
    state.activeAudioId = state.selectedAudioIds.has(clip.uid) ? clip.uid : (state.selectedAudioIds.values().next().value || '');
    state.activeTrack = state.activeAudioId ? 'audio' : (state.activeId ? 'video' : 'none');
    renderAudioClip(); renderTimeline(); renderInspector();
    return;
  }
  selectOnlyAudio(clip.uid);
  renderAudioClip();
  renderInspector();
  const side = event.target.dataset.audioTrim || '';
  const startX = event.clientX;
  const original = { start: clip.timelineStart, trim: clip.trim, duration: clip.duration };
  const move = pointer => {
    const delta = (pointer.clientX - startX) / state.zoom;
    if (side === 'left') {
      const speed = clamp(Number(clip.speed) || 1, .5, 2);
      const change = clamp(delta, -Math.min(original.trim / speed, original.start), original.duration - .1);
      clip.timelineStart = original.start + change;
      clip.trim = original.trim + change * speed;
      clip.duration = original.duration - change;
    } else if (side === 'right') {
      const speed = clamp(Number(clip.speed) || 1, .5, 2);
      clip.duration = clamp(original.duration + delta, .1, (clip.sourceDuration - original.trim) / speed);
    } else {
      clip.timelineStart = clamp(original.start + delta, 0, Math.max(0, projectDuration() - .1));
    }
    renderAudioClip();
    $('audioInfo').textContent = `${fmtPrecise(clip.timelineStart)} → ${fmtPrecise(clip.timelineStart + clip.duration)}`;
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up, { once: true });
}
function renderInspector() {
  const clip = activeClip();
  const audio = activeAudioClip();
  const badge = $('activeTrackBadge');
  badge.className = `active-track-badge ${state.activeTrack || 'none'}`;
  const selectedCount = state.selectedVideoIds.size + state.selectedAudioIds.size;
  badge.textContent = selectedCount > 1 ? `✓ ĐÃ CHỌN ${selectedCount} ĐOẠN` : state.activeTrack === 'audio' ? '♫ ĐANG CHỌN NHẠC' : clip ? '▶ ĐANG CHỌN VIDEO' : 'CHƯA CHỌN';
  $('videoTrack').classList.toggle('track-selected', state.activeTrack === 'video' && !!clip);
  $('audioTrack').classList.toggle('track-selected', state.activeTrack === 'audio' && !!audio);
  $('audioClipVolumeBox').hidden = !audio;
  if (audio) {
    const audioVolume = Number.isFinite(Number(audio.volume)) ? Number(audio.volume) : 1;
    $('audioClipVolume').value = audioVolume;
    $('audioClipVolumeValue').textContent = `${Math.round(audioVolume * 100)}%`;
    const audioSpeed = clamp(Number(audio.speed) || 1, .5, 2);
    $('audioClipSpeed').value = audioSpeed;
    $('audioClipSpeedValue').textContent = `${audioSpeed.toFixed(2)}x`;
    $('activeClipName').textContent = state.selectedAudioIds.size > 1 ? `${state.selectedAudioIds.size} đoạn nhạc` : (audio.name || 'Âm thanh');
  }
  const disabled = !clip;
  ['clipStart', 'clipEnd', 'clipSpeed', 'clipVolume', 'clipEffect', 'clipTransition',
   'split', 'cutBefore', 'cutAfter', 'removeClip', 'timelineSplit', 'timelineCutBefore',
   'timelineCutAfter', 'timelineDelete'].forEach(id => { if ($(id)) $(id).disabled = disabled; });
  ['timelineSplit', 'timelineCutBefore', 'timelineCutAfter', 'timelineDelete'].forEach(id => {
    if ($(id)) $(id).disabled = !(clip || audio);
  });
  if (!clip) {
    if (!audio) $('activeClipName').textContent = 'Chưa chọn';
    return;
  }
  $('activeClipName').textContent = state.selectedVideoIds.size > 1 ? `${state.selectedVideoIds.size} đoạn video` : clip.title;
  $('clipStart').value = Number(clip.start).toFixed(2);
  $('clipEnd').value = Number(clip.end).toFixed(2);
  $('clipSpeed').value = clip.speed;
  $('speedValue').textContent = `${Number(clip.speed).toFixed(2)}x`;
  $('clipVolume').value = clip.volume;
  $('volumeValue').textContent = `${Math.round(clip.volume * 100)}%`;
  $('clipEffect').value = clip.effect || 'none';
  $('clipTransition').value = clip.transition || 'none';
  $('viewerInfo').textContent = clip.title;
}
function renderRuler(width, total) {
  const ruler = $('timeRuler');
  let interval = state.zoom >= 150 ? .5 : state.zoom >= 80 ? 1 : state.zoom >= 45 ? 2 : 5;
  while ((Math.max(total, 1) / (interval / 2)) > 500) interval *= 2;
  let html = '';
  for (let t = 0; t <= Math.max(total, 1) + interval; t += interval / 2) {
    const major = Math.abs((t / interval) - Math.round(t / interval)) < .001;
    const left = t * state.zoom;
    html += `<span class="ruler-tick ${major ? 'major' : ''}" style="left:${left}px"></span>`;
    if (major) html += `<span class="ruler-label" style="left:${left}px">${fmtPrecise(t)}</span>`;
  }
  ruler.innerHTML = html;
  ruler.style.width = `${width}px`;
}
function updateClipSelection() {
  document.querySelectorAll('.timeline-clip').forEach(node => {
    node.classList.toggle('active', node.dataset.clipId === state.activeId);
    node.classList.toggle('multi-selected', state.selectedVideoIds.has(node.dataset.clipId));
  });
}
function renderTimeline() {
  const total = projectDuration();
  const scroller = $('timelineScroller');
  const contentWidth = Math.max((scroller?.clientWidth || 900) - 64, total * state.zoom + 240);
  $('timelineCanvas').style.width = `${contentWidth + 64}px`;
  renderRuler(contentWidth, total);
  const track = $('videoTrack');
  const rows = clipLayout();
  track.innerHTML = rows.length ? '' : '<div class="drop-hint">Kéo Media vào đây</div>';

  for (const row of rows) {
    const clip = row.clip;
    const width = Math.max(34, row.duration * state.zoom);
    const node = document.createElement('article');
    node.className = `timeline-clip ${clip.uid === state.activeId ? 'active' : ''} ${state.selectedVideoIds.has(clip.uid) ? 'multi-selected' : ''}`;
    node.dataset.clipId = clip.uid;
    node.style.left = `${row.start * state.zoom}px`;
    node.style.width = `${width}px`;
    node.innerHTML = `<div class="clip-thumbs" style="--clip-thumb:url('${escapeHtml(clip.thumbnailUrl)}')"></div>
      <div class="clip-overlay"><button class="clip-mute video-mute" data-video-mute title="Bật/tắt âm video">${clip.muted ? '🔇' : '🔊'}</button><strong>${escapeHtml(clip.title)}</strong><small>${row.duration.toFixed(2)}s · ${Number(clip.speed).toFixed(2)}x</small></div>
      <span class="trim-handle left" data-trim="left" title="Giữ chuột tại mép thumbnail và kéo để cắt đầu"><i></i></span>
      <span class="trim-handle right" data-trim="right" title="Giữ chuột tại mép thumbnail và kéo để cắt cuối"><i></i></span>`;
    node.querySelectorAll('[data-trim]').forEach(handle => handle.addEventListener('pointerdown', event => beginTrim(event, clip.uid, handle.dataset.trim)));
    const mute = node.querySelector('[data-video-mute]');
    mute.onpointerdown = event => { event.stopPropagation(); };
    mute.onclick = event => { event.preventDefault(); event.stopPropagation(); clip.muted = !clip.muted; clip.volume = clip.muted ? 0 : 1; renderTimeline(); seekProject(state.playhead, false); };
    node.addEventListener('pointermove', event => updateClipEdgeCursor(event, node));
    node.addEventListener('pointerleave', () => { if (!node.classList.contains('trimming')) node.style.cursor = 'grab'; });
    node.addEventListener('pointerdown', event => beginClipPointer(event, clip.uid));
    track.appendChild(node);
  }
  $('audioTrack').style.width = `${contentWidth}px`;
  $('videoTrack').style.width = `${contentWidth}px`;
  updatePlayhead(false);
}
function scheduleTimelineRender() {
  if (state.timelineRenderFrame) cancelAnimationFrame(state.timelineRenderFrame);
  state.timelineRenderFrame = requestAnimationFrame(() => {
    state.timelineRenderFrame = 0;
    renderTimeline();
  });
}
function addAsset(id, atIndex = state.timeline.length) {
  const record = recordById(id);
  if (!record) return;
  snapshotHistory();
  const clip = makeClip(record);
  state.timeline.splice(clamp(atIndex, 0, state.timeline.length), 0, clip);
  state.activeId = clip.uid;
  state.activeAudioId = '';
  state.activeTrack = 'video';
  renderEditor();
  const row = clipLayout().find(x => x.clip.uid === clip.uid);
  seekProject(row?.start || 0, false);
}

function timelineProjectFromClientX(clientX) {
  const rect = $('videoTrack').getBoundingClientRect();
  // getBoundingClientRect already includes the horizontal scroll offset. Adding
  // scrollLeft again (old code) doubled the position and made click/drag inaccurate.
  return clamp((clientX - rect.left) / state.zoom, 0, projectDuration());
}
function beginScrub(event) {
  if (event.button !== 0 || event.target.closest('.timeline-clip')) return;
  event.preventDefault();
  event.stopPropagation();
  const owner = event.currentTarget || event.target;
  const scroller = $('timelineScroller');
  try { owner.setPointerCapture(event.pointerId); } catch (_) {}
  state.playing = false;
  $('preview').pause();
  state.scrubbing = true;
  document.documentElement.classList.add('editor-scrubbing');
  const move = pointer => {
    // Keep scrubbing when the pointer reaches either edge. This is especially
    // important for left-to-right drags after the timeline has been scrolled.
    const bounds = scroller.getBoundingClientRect();
    if (pointer.clientX > bounds.right - 28) scroller.scrollLeft += Math.max(4, (pointer.clientX - (bounds.right - 28)) * .45);
    if (pointer.clientX < bounds.left + 28) scroller.scrollLeft -= Math.max(4, ((bounds.left + 28) - pointer.clientX) * .45);
    seekProject(timelineProjectFromClientX(pointer.clientX), false);
  };
  const finish = pointer => {
    if (pointer) move(pointer);
    state.scrubbing = false;
    try { owner.releasePointerCapture(event.pointerId); } catch (_) {}
    document.removeEventListener('pointermove', move, true);
    document.removeEventListener('pointerup', finish, true);
    document.removeEventListener('pointercancel', finish, true);
    document.documentElement.classList.remove('editor-scrubbing');
  };
  move(event);
  // Document capture is a fallback for Chromium/WebView builds where pointer capture
  // can be lost when moving quickly from left to right across nested timeline nodes.
  document.addEventListener('pointermove', move, true);
  document.addEventListener('pointerup', finish, true);
  document.addEventListener('pointercancel', finish, true);
}
function beginPlayheadDrag(event) {
  event.stopPropagation();
  beginScrub(event);
}
function beginTimelinePan(event) {
  if (event.button !== 0 && event.button !== 1) return;
  if (event.target.closest('.timeline-clip,.playhead')) return;
  event.preventDefault();
  const owner = event.currentTarget;
  const scroller = $('timelineScroller');
  const startX = event.clientX;
  const initialScroll = scroller.scrollLeft;
  const maxScroll = () => Math.max(0, scroller.scrollWidth - scroller.clientWidth);
  let moved = false;
  try { owner.setPointerCapture(event.pointerId); } catch (_) {}
  state.surfacePointer = true;
  const move = pointer => {
    const delta = pointer.clientX - startX;
    if (!moved && Math.abs(delta) < 4) return;
    moved = true;
    state.panning = true;
    document.documentElement.classList.add('editor-panning');
    let desired = initialScroll - delta; // grab-content behavior
    // Edge assist: at the far-left edge, a left-to-right gesture previously clamped
    // to zero and looked broken. Let either initial drag direction enter the timeline.
    if (initialScroll <= 1 && delta > 0) desired = initialScroll + delta;
    const maximum = maxScroll();
    if (initialScroll >= maximum - 1 && delta < 0) desired = initialScroll + delta;
    scroller.scrollLeft = clamp(desired, 0, maximum);
  };
  const finish = pointer => {
    if (!moved && event.button === 0) seekProject(timelineProjectFromClientX(pointer.clientX), false);
    state.panning = false;
    state.surfacePointer = false;
    try { owner.releasePointerCapture(event.pointerId); } catch (_) {}
    document.removeEventListener('pointermove', move, true);
    document.removeEventListener('pointerup', finish, true);
    document.removeEventListener('pointercancel', finish, true);
    document.documentElement.classList.remove('editor-panning');
  };
  document.addEventListener('pointermove', move, true);
  document.addEventListener('pointerup', finish, true);
  document.addEventListener('pointercancel', finish, true);
}

const CLIP_TRIM_HIT_PX = 34;
function trimSideAtClientX(clientX, node) {
  const rect = node.getBoundingClientRect();
  const hit = Math.min(CLIP_TRIM_HIT_PX, Math.max(10, rect.width * .35));
  if (clientX <= rect.left + hit) return 'left';
  if (clientX >= rect.right - hit) return 'right';
  return '';
}
function updateClipEdgeCursor(event, node) {
  if (node.classList.contains('trimming')) return;
  node.style.cursor = trimSideAtClientX(event.clientX, node) ? 'ew-resize' : 'grab';
}
function beginClipPointer(event, id) {
  if (event.button !== 0 || event.target.closest('[data-trim]')) return;
  const node = event.currentTarget;
  const edgeSide = trimSideAtClientX(event.clientX, node);
  if (edgeSide) {
    beginTrim(event, id, edgeSide, node);
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault(); event.stopPropagation();
    if (state.selectedVideoIds.has(id)) state.selectedVideoIds.delete(id);
    else state.selectedVideoIds.add(id);
    state.activeId = state.selectedVideoIds.has(id) ? id : (state.selectedVideoIds.values().next().value || '');
    state.activeTrack = state.activeId ? 'video' : (state.activeAudioId ? 'audio' : 'none');
    updateClipSelection(); renderAudioClip(); renderInspector();
    return;
  }
  const originalIndex = state.timeline.findIndex(c => c.uid === id);
  const startX = event.clientX;
  let moved = false;
  selectOnlyVideo(id);
  updateClipSelection();
  renderInspector();

  const move = pointer => {
    const delta = pointer.clientX - startX;
    if (!moved && Math.abs(delta) < 5) return;
    moved = true;
    state.clipPointerMoved = true;
    node.classList.add('moving');
    node.style.transform = `translateX(${delta}px)`;
  };
  const up = pointer => {
    document.removeEventListener('pointermove', move, true);
    document.removeEventListener('pointerup', up, true);
    document.removeEventListener('pointercancel', up, true);
    try { node.releasePointerCapture(event.pointerId); } catch (_) {}
    node.classList.remove('moving');
    node.style.transform = '';
    if (moved) {
      snapshotHistory();
      const project = timelineProjectFromClientX(pointer.clientX);
      const rows = clipLayout().filter(row => row.clip.uid !== id);
      let targetIndex = rows.findIndex(row => project < (row.start + row.end) / 2);
      if (targetIndex < 0) targetIndex = rows.length;
      const [clip] = state.timeline.splice(originalIndex, 1);
      state.timeline.splice(clamp(targetIndex, 0, state.timeline.length), 0, clip);
      renderEditor();
      const row = clipLayout().find(x => x.clip.uid === id);
      seekProject(row?.start || 0, false);
    } else {
      const row = clipLayout().find(x => x.clip.uid === id);
      const project = timelineProjectFromClientX(pointer.clientX);
      seekProject(clamp(project, row?.start || 0, row?.end || projectDuration()), false);
    }
    setTimeout(() => { state.clipPointerMoved = false; }, 0);
  };
  try { node.setPointerCapture(event.pointerId); } catch (_) {}
  document.addEventListener('pointermove', move, true);
  document.addEventListener('pointerup', up, { once: true, capture: true });
  document.addEventListener('pointercancel', up, { once: true, capture: true });
}
function beginTrim(event, id, side, captureOwner = null) {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  const clip = state.timeline.find(x => x.uid === id);
  const node = event.currentTarget.closest('.timeline-clip');
  if (!clip || !node) return;
  snapshotHistory();
  state.activeId = id;
  state.activeAudioId = '';
  state.activeTrack = 'video';
  updateClipSelection();
  const handle = captureOwner || event.currentTarget;
  const startX = event.clientX;
  const initialStart = Number(clip.start);
  const initialEnd = Number(clip.end);
  const initialWidth = node.getBoundingClientRect().width;
  let changed = false;
  try { handle.setPointerCapture(event.pointerId); } catch (_) {}
  document.documentElement.classList.add('editor-trimming');
  node.classList.add('trimming');
  const updateInspectorLive = () => {
    $('clipStart').value = Number(clip.start).toFixed(2);
    $('clipEnd').value = Number(clip.end).toFixed(2);
    $('activeClipName').textContent = clip.title;
  };
  const move = pointer => {
    const deltaProject = (pointer.clientX - startX) / state.zoom;
    const deltaSource = deltaProject * Math.max(.25, Number(clip.speed) || 1);
    if (side === 'left') clip.start = clamp(initialStart + deltaSource, 0, initialEnd - .10);
    else clip.end = clamp(initialEnd + deltaSource, initialStart + .10, clip.sourceDuration);
    changed = changed || Math.abs(pointer.clientX - startX) >= 1;
    const outputDuration = clipOutputDuration(clip);
    const newWidth = Math.max(34, outputDuration * state.zoom);
    node.style.width = `${newWidth}px`;
    // Keep the opposite edge anchored. Negative translation is intentional when the
    // left handle is pulled outward to restore previously trimmed source frames.
    if (side === 'left') node.style.transform = `translateX(${initialWidth - newWidth}px)`;
    const overlay = node.querySelector('.clip-overlay small');
    if (overlay) overlay.textContent = `${outputDuration.toFixed(2)}s · ${Number(clip.speed).toFixed(2)}x`;
    updateInspectorLive();
  };
  const finish = pointer => {
    if (pointer) move(pointer);
    try { handle.releasePointerCapture(event.pointerId); } catch (_) {}
    document.removeEventListener('pointermove', move, true);
    document.removeEventListener('pointerup', finish, true);
    document.removeEventListener('pointercancel', finish, true);
    document.documentElement.classList.remove('editor-trimming');
    node.classList.remove('trimming');
    node.style.transform = '';
    if (!changed) {
      state.history.pop();
      updateUndoButtons();
    }
    renderEditor();
    const row = clipLayout().find(x => x.clip.uid === id);
    seekProject(row?.start || 0, false);
  };
  document.addEventListener('pointermove', move, true);
  document.addEventListener('pointerup', finish, true);
  document.addEventListener('pointercancel', finish, true);
}


function updateActive(push = true) {
  const clip = activeClip();
  if (!clip) return;
  if (push) snapshotHistory();
  const newStart = clamp($('clipStart').value, 0, clip.sourceDuration - .05);
  const newEnd = clamp($('clipEnd').value, newStart + .05, clip.sourceDuration);
  clip.start = newStart; clip.end = newEnd;
  selectedVideoClips().forEach(item => {
    item.speed = clamp($('clipSpeed').value, .25, 4);
    item.volume = clamp($('clipVolume').value, 0, 2);
    item.effect = $('clipEffect').value;
    item.transition = $('clipTransition').value;
  });
  renderEditor();
  seekProject(state.playhead, false);
}
function splitActive() {
  const clip = activeClip();
  if (!clip) return;
  const row = clipLayout().find(x => x.clip.uid === clip.uid);
  if (!row) return;
  const sourceAt = sourceTimeAtPlayhead(row);
  if (sourceAt <= clip.start + .05 || sourceAt >= clip.end - .05) return alert('Đưa đầu phát vào bên trong clip để tách.');
  snapshotHistory();
  const right = { ...clip, uid: crypto.randomUUID(), start: sourceAt };
  clip.end = sourceAt;
  const index = state.timeline.findIndex(x => x.uid === clip.uid);
  state.timeline.splice(index + 1, 0, right);
  state.activeId = right.uid;
  renderEditor();
  seekProject(state.playhead, false);
}
function cutBeforePlayhead() {
  const clip = activeClip();
  const row = clipLayout().find(x => x.clip.uid === clip?.uid);
  if (!clip || !row) return;
  const sourceAt = sourceTimeAtPlayhead(row);
  if (sourceAt <= clip.start + .05 || sourceAt >= clip.end - .05) return alert('Đưa đầu phát vào bên trong clip.');
  snapshotHistory();
  clip.start = sourceAt;
  renderEditor();
  const updated = clipLayout().find(x => x.clip.uid === clip.uid);
  seekProject(updated?.start || 0, false);
}
function cutAfterPlayhead() {
  const clip = activeClip();
  const row = clipLayout().find(x => x.clip.uid === clip?.uid);
  if (!clip || !row) return;
  const sourceAt = sourceTimeAtPlayhead(row);
  if (sourceAt <= clip.start + .05 || sourceAt >= clip.end - .05) return alert('Đưa đầu phát vào bên trong clip.');
  snapshotHistory();
  clip.end = sourceAt;
  renderEditor();
  const updated = clipLayout().find(x => x.clip.uid === clip.uid);
  seekProject(updated?.end || 0, false);
}
function removeActive() {
  const index = state.timeline.findIndex(c => c.uid === state.activeId);
  if (index < 0) return;
  snapshotHistory();
  state.timeline.splice(index, 1);
  state.activeId = state.timeline[Math.min(index, state.timeline.length - 1)]?.uid || '';
  state.playhead = clamp(state.playhead, 0, projectDuration());
  renderEditor();
  seekProject(state.playhead, false);
}

function copyActiveClip() {
  const clip = activeClip();
  if (!clip) return;
  state.copiedClip = JSON.parse(JSON.stringify(clip));
  $('timelinePaste').disabled = false;
}

function pasteCopiedClip() {
  if (!state.copiedClip) return;
  snapshotHistory();
  const copy = {
    ...JSON.parse(JSON.stringify(state.copiedClip)),
    uid: crypto.randomUUID(),
    title: `${state.copiedClip.title} (Copy)`,
  };
  const activeIndex = state.timeline.findIndex(c => c.uid === state.activeId);
  state.timeline.splice(activeIndex < 0 ? state.timeline.length : activeIndex + 1, 0, copy);
  state.activeId = copy.uid;
  renderEditor();
  const row = clipLayout().find(x => x.clip.uid === copy.uid);
  seekProject(row?.start || 0, false);
}

function addAudioAsset(asset, timelineStart = state.playhead) {
  const sourceDuration = Math.max(.1, Number(asset.duration) || projectDuration() || 1);
  const clip = {
    uid: crypto.randomUUID(), path: asset.path, url: asset.url, name: asset.name || 'Âm thanh',
    sourceDuration, trim: 0, timelineStart: clamp(timelineStart, 0, projectDuration()),
    duration: Math.min(sourceDuration, Math.max(.1, projectDuration() - timelineStart) || sourceDuration),
    volume: Number(asset.volume) || 1, speed: 1,
    muted: false,
  };
  snapshotHistory();
  state.audioClips.push(clip);
  state.activeAudioId = clip.uid;
  state.activeId = '';
  renderEditor();
  seekProject(clip.timelineStart, false);
}
function activeAudioClip() { return state.audioClips.find(item => item.uid === state.activeAudioId) || null; }
function splitActiveAudio() {
  const clip = activeAudioClip();
  if (!clip) return false;
  const local = state.playhead - clip.timelineStart;
  if (local <= .05 || local >= clip.duration - .05) return false;
  snapshotHistory();
  const right = { ...clip, uid: crypto.randomUUID(), trim: clip.trim + local * (Number(clip.speed) || 1), timelineStart: state.playhead, duration: clip.duration - local, name: `${clip.name} (2)` };
  clip.duration = local;
  state.audioClips.push(right);
  state.activeAudioId = right.uid;
  renderEditor();
  return true;
}
function copyActiveAudio() {
  const clip = activeAudioClip();
  if (!clip) return false;
  state.copiedAudio = JSON.parse(JSON.stringify(clip));
  $('timelinePaste').disabled = false;
  return true;
}
function pasteCopiedAudio() {
  if (!state.copiedAudio) return false;
  snapshotHistory();
  const clip = { ...JSON.parse(JSON.stringify(state.copiedAudio)), uid: crypto.randomUUID(), timelineStart: state.playhead, name: `${state.copiedAudio.name} (Copy)` };
  state.audioClips.push(clip);
  state.activeAudioId = clip.uid;
  renderEditor();
  return true;
}
function cutAudioBeforePlayhead() {
  const clip = activeAudioClip();
  if (!clip) return false;
  const local = state.playhead - clip.timelineStart;
  if (local <= .05 || local >= clip.duration - .05) return true;
  snapshotHistory();
  clip.trim += local * (Number(clip.speed) || 1);
  clip.timelineStart = state.playhead;
  clip.duration -= local;
  renderEditor();
  return true;
}
function cutAudioAfterPlayhead() {
  const clip = activeAudioClip();
  if (!clip) return false;
  const local = state.playhead - clip.timelineStart;
  if (local <= .05 || local >= clip.duration - .05) return true;
  snapshotHistory();
  clip.duration = local;
  renderEditor();
  return true;
}
function removeActiveAudio() {
  if (!state.activeAudioId) return false;
  snapshotHistory();
  state.audioClips = state.audioClips.filter(item => item.uid !== state.activeAudioId);
  state.activeAudioId = '';
  $('musicPreview').pause();
  renderEditor();
  return true;
}

function seekProject(time, autoplay = state.playing) {
  const total = projectDuration();
  state.playhead = clamp(time, 0, total);
  const row = clipAtProject(state.playhead);
  if (!row) {
    $('preview').pause();
    $('preview').removeAttribute('src');
    $('previewEmpty').style.display = 'block';
    updatePlayhead();
    updatePreviewControls();
    return;
  }
  const changed = state.activeId !== row.clip.uid || !$('preview').src.endsWith(row.clip.previewUrl);
  state.activeId = row.clip.uid;
  const source = row.clip.start + (state.playhead - row.start) * row.clip.speed;
  const video = $('preview');
  if (changed) { video.src = row.clip.previewUrl; video.load(); }
  video.playbackRate = row.clip.speed;
  video.volume = (state.masterMuted || state.videoTrackMuted) ? 0 : clamp(row.clip.volume, 0, 1);
  const apply = () => {
    try { video.currentTime = clamp(source, row.clip.start, row.clip.end - .01); } catch (_) {}
    if (autoplay) video.play().catch(() => {});
    syncMusic(autoplay);
  };
  if (video.readyState >= 1) apply(); else video.onloadedmetadata = apply;
  $('previewEmpty').style.display = 'none';
  updateClipSelection();
  renderInspector();
  updatePreviewControls();
}
function updatePlayhead(autoScroll = true) {
  const left = 64 + state.playhead * state.zoom;
  $('playhead').style.left = `${left}px`;
  const scroller = $('timelineScroller');
  if (!autoScroll || !scroller || state.scrubbing || state.panning) return;
  if (left - scroller.scrollLeft > scroller.clientWidth - 80) scroller.scrollLeft = Math.max(0, left - scroller.clientWidth + 160);
  if (left - scroller.scrollLeft < 70) scroller.scrollLeft = Math.max(0, left - 100);
}
function togglePlay() {
  if (!state.timeline.length) return;
  const video = $('preview');
  if (state.playing) { state.playing = false; video.pause(); $('musicPreview').pause(); }
  else {
    state.playing = true;
    if (state.playhead >= projectDuration() - .01) state.playhead = 0;
    seekProject(state.playhead, true);
  }
  updatePreviewControls();
}
function updatePreviewControls() {
  const total = projectDuration();
  $('previewTime').textContent = `${fmtPrecise(state.playhead)} / ${fmtPrecise(total)}`;
  $('previewPlay').textContent = state.playing ? '❚❚' : '▶';
  $('timelinePlay').textContent = state.playing ? '❚❚ Dừng' : '▶ Phát';
  $('preview').style.transform = `scale(${state.previewZoom / 100})`;
  renderCropBox();
  updatePlayhead(!state.scrubbing);
}

function renderCropBox() {
  const box = $('cropBox');
  const clip = activeClip();
  if (!box || !clip || !$('preview').src) { if (box) box.hidden = true; return; }
  const crop = clip.crop || (clip.crop = { x: 0, y: 0, w: 1, h: 1 });
  const wrapRect = box.parentElement.getBoundingClientRect();
  const elementRect = $('preview').getBoundingClientRect();
  const sourceRatio = ($('preview').videoWidth || elementRect.width) / Math.max(1, $('preview').videoHeight || elementRect.height);
  const elementRatio = elementRect.width / Math.max(1, elementRect.height);
  const videoWidth = sourceRatio > elementRatio ? elementRect.width : elementRect.height * sourceRatio;
  const videoHeight = sourceRatio > elementRatio ? elementRect.width / sourceRatio : elementRect.height;
  const videoLeft = Math.max(0, elementRect.left - wrapRect.left + (elementRect.width - videoWidth) / 2);
  const videoTop = Math.max(0, elementRect.top - wrapRect.top + (elementRect.height - videoHeight) / 2);
  box.hidden = false;
  box.style.left = `${videoLeft + clamp(crop.x, 0, 1) * videoWidth}px`;
  box.style.top = `${videoTop + clamp(crop.y, 0, 1) * videoHeight}px`;
  box.style.width = `${clamp(crop.w, .05, 1) * videoWidth}px`;
  box.style.height = `${clamp(crop.h, .05, 1) * videoHeight}px`;
}

function beginCropResize(event) {
  const clip = activeClip();
  if (!clip || event.button !== 0) return;
  event.preventDefault(); event.stopPropagation();
  snapshotHistory();
  const side = event.currentTarget.dataset.cropHandle || 'move';
  const wrap = event.currentTarget.parentElement.getBoundingClientRect();
  const original = { ...(clip.crop || { x: 0, y: 0, w: 1, h: 1 }) };
  const startX = event.clientX; const startY = event.clientY;
  const ratio = original.w / Math.max(.001, original.h);
  const move = pointer => {
    const dx = (pointer.clientX - startX) / Math.max(1, wrap.width);
    const dy = (pointer.clientY - startY) / Math.max(1, wrap.height);
    let { x, y, w, h } = original;
    if (side === 'move') {
      x = clamp(original.x + dx, 0, 1 - original.w);
      y = clamp(original.y + dy, 0, 1 - original.h);
    } else {
      if (side.includes('w')) { x = clamp(original.x + dx, 0, original.x + original.w - .05); w = original.w - (x - original.x); }
      if (side.includes('e')) w = clamp(original.w + dx, .05, 1 - original.x);
      if (side.includes('n')) { y = clamp(original.y + dy, 0, original.y + original.h - .05); h = original.h - (y - original.y); }
      if (side.includes('s')) h = clamp(original.h + dy, .05, 1 - original.y);
      if (pointer.shiftKey) {
        if (side === 'n' || side === 's') w = clamp(h * ratio, .05, 1 - x);
        else h = clamp(w / ratio, .05, 1 - y);
        if (side.includes('w')) x = clamp(original.x + original.w - w, 0, 1 - w);
        if (side.includes('n')) y = clamp(original.y + original.h - h, 0, 1 - h);
      }
    }
    clip.crop = { x, y, w, h };
    renderCropBox();
  };
  const up = () => { document.removeEventListener('pointermove', move, true); document.removeEventListener('pointerup', up, true); };
  document.addEventListener('pointermove', move, true);
  document.addEventListener('pointerup', up, { once: true, capture: true });
}
$('preview').addEventListener('timeupdate', () => {
  if (!state.playing) return;
  const clip = activeClip();
  const row = clipLayout().find(x => x.clip.uid === state.activeId);
  if (!clip || !row) return;
  const source = $('preview').currentTime;
  if (source >= clip.end - .025) {
    const next = clipLayout()[row.index + 1];
    if (next) { state.playhead = next.start; state.activeId = next.clip.uid; seekProject(next.start, true); }
    else { state.playing = false; state.playhead = projectDuration(); $('preview').pause(); updatePreviewControls(); }
    return;
  }
  state.playhead = clamp(row.start + (source - clip.start) / clip.speed, row.start, row.end);
  syncMusic(true);
  updatePreviewControls();
});
$('preview').addEventListener('ended', () => { if (state.playing) seekProject(state.playhead, true); });
$('musicPreview').addEventListener('timeupdate', () => {
  const audio = $('musicPreview');
  const clip = state.audioClips.find(item => item.uid === audio.dataset.audioId);
  if (!clip) {
    audio.pause();
    return;
  }
  const sourceEnd = Number(clip.trim || 0) + Number(clip.duration || 0) * clamp(Number(clip.speed) || 1, .5, 2);
  if (sourceEnd > 0 && audio.currentTime >= sourceEnd - .015) audio.pause();
});

async function busy(title, fn) {
  $('busyTitle').textContent = title;
  $('busy').showModal();
  try {
    return await fn();
  } finally {
    $('exportProgressWrap').hidden = true;
    $('busy').close();
  }
}

$('refresh').onclick = load;
$('selectAll').onclick = () => {
  state.records.filter(r => state.providerFilter === 'all' || libraryProvider(r) === state.providerFilter).forEach(r => state.selected.add(r.id));
  renderLibrary();
};
$('clearAll').onclick = () => { state.selected.clear(); renderLibrary(); };
$('uploadLibrary').onclick = () => $('libraryVideoFile').click();
$('libraryVideoFile').onchange = event => importLibraryVideo(event.target.files[0], event.target).catch(error => alert(error.message || 'Không tải được video.'));
$('editSelected').onclick = openEditor;
$('mergeSelected').onclick = () => busy('Đang ghép video…', async () => {
  const ids = [...state.selected];
  const result = await api('/api/merge', { method: 'POST', body: JSON.stringify({ ids }) });
  await load();
  $('mergedSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('deleteSelected').onclick = async () => {
  if (!confirm('Xóa các video đã chọn khỏi tool?')) return;
  await api('/api/delete', { method: 'POST', body: JSON.stringify({ ids: [...state.selected] }) });
  state.timeline = state.timeline.filter(c => !state.selected.has(c.id));
  await load();
};
document.querySelectorAll('.nav').forEach(el => el.onclick = () => el.dataset.view === 'editor' ? openEditor() : setView('library'));
document.querySelectorAll('[data-scroll-section]').forEach(el => el.onclick = () => {
  setView('library');
  $(el.dataset.scrollSection).scrollIntoView({ behavior: 'smooth', block: 'start' });
});
document.querySelectorAll('[data-provider-filter]').forEach(el => el.onclick = () => {
  state.providerFilter = el.dataset.providerFilter || 'all';
  state.libraryPages = { source: 1, merged: 1, edited: 1 };
  setView('library');
  renderLibrary();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
$('backLibrary').onclick = () => setView('library');

['clipStart', 'clipEnd', 'clipEffect', 'clipTransition'].forEach(id => $(id).onchange = () => updateActive(true));
$('clipSpeed').onchange = () => updateActive(true);
$('clipSpeed').oninput = () => $('speedValue').textContent = `${Number($('clipSpeed').value).toFixed(2)}x`;
$('clipVolume').onchange = () => updateActive(true);
$('clipVolume').oninput = () => $('volumeValue').textContent = `${Math.round(Number($('clipVolume').value) * 100)}%`;
$('split').onclick = splitActive;
$('timelineSplit').onclick = () => state.activeTrack === 'audio' ? splitActiveAudio() : splitActive();
$('cutBefore').onclick = cutBeforePlayhead;
$('cutAfter').onclick = cutAfterPlayhead;
$('timelineCutBefore').onclick = () => state.activeTrack === 'audio' ? cutAudioBeforePlayhead() : cutBeforePlayhead();
$('timelineCutAfter').onclick = () => state.activeTrack === 'audio' ? cutAudioAfterPlayhead() : cutAfterPlayhead();
$('removeClip').onclick = removeActive;
$('timelineDelete').onclick = () => state.activeTrack === 'audio' ? removeActiveAudio() : removeActive();
$('timelineCopy').onclick = () => state.activeTrack === 'audio' ? copyActiveAudio() : copyActiveClip();
$('timelinePaste').onclick = () => state.activeTrack === 'audio' ? pasteCopiedAudio() : pasteCopiedClip();
$('timelinePaste').disabled = true;
$('undo').onclick = undo;
$('redo').onclick = redo;
$('previewPlay').onclick = togglePlay;
$('timelinePlay').onclick = togglePlay;
$('videoTrackMute').onclick = event => { event.stopPropagation(); state.videoTrackMuted = !state.videoTrackMuted; $('videoTrackMute').textContent = state.videoTrackMuted ? '🔇' : '🔊'; seekProject(state.playhead, false); };
$('audioTrackMute').onclick = event => { event.stopPropagation(); state.audioTrackMuted = !state.audioTrackMuted; $('audioTrackMute').textContent = state.audioTrackMuted ? '🔇' : '🔊'; syncMusic(false); };
document.querySelectorAll('[data-crop-handle]').forEach(handle => handle.addEventListener('pointerdown', beginCropResize));
$('cropBox').addEventListener('pointerdown', event => { if (!event.target.closest('[data-crop-handle]')) beginCropResize(event); });
$('timelineZoom').oninput = () => {
  state.zoom = Number($('timelineZoom').value) || 90;
  $('timelineZoomValue').textContent = `${state.zoom} px/s`;
  scheduleTimelineRender();
};
$('previewZoom').oninput = () => { state.previewZoom = Number($('previewZoom').value) || 100; updatePreviewControls(); };

$('timeRuler').addEventListener('pointerdown', beginScrub);
$('videoTrack').addEventListener('pointerdown', beginTimelinePan);
$('audioTrack').addEventListener('pointerdown', beginTimelinePan);
$('playhead').addEventListener('pointerdown', beginPlayheadDrag);
$('videoTrack').addEventListener('dragover', event => { event.preventDefault(); $('videoTrack').classList.add('drag-target'); });
$('videoTrack').addEventListener('dragleave', () => $('videoTrack').classList.remove('drag-target'));
$('videoTrack').addEventListener('drop', event => {
  event.preventDefault();
  $('videoTrack').classList.remove('drag-target');
  const asset = event.dataTransfer.getData('application/x-leha-asset');
  if (!asset) return;
  const project = timelineProjectFromClientX(event.clientX);
  const rows = clipLayout();
  const index = rows.findIndex(row => project < row.end);
  addAsset(asset, index < 0 ? state.timeline.length : index);
});
$('videoFile').onchange = async event => {
  const file = event.target.files[0];
  if (!file) return;
  await busy('Đang nhập video vào Thư viện…', async () => {
    const response = await fetch('/api/video', {
      method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) }, body: file,
    });
    const json = await response.json();
    if (!response.ok || !json.ok) throw new Error(json.error || 'Không nhập được video');
    await load();
    if (recordById(json.id)) addAsset(json.id);
    event.target.value = '';
  });
};
$('audioFile').onchange = async event => {
  const file = event.target.files[0];
  if (!file) return;
  await busy('Đang nhập âm thanh…', async () => {
    const response = await fetch('/api/audio', {
      method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) }, body: file,
    });
    const json = await response.json();
    if (!response.ok || !json.ok) throw new Error(json.error || 'Không nhập được âm thanh');
    state.audioAssets = (await api('/api/audio/library')).assets || [];
    const uploadedAsset = state.audioAssets.find(asset => asset.id === json.id) || json.asset;
    if (!uploadedAsset) throw new Error('Không tìm thấy file vừa nhập trong Kho nhạc');
    addAudioAsset(uploadedAsset);
    event.target.value = '';
  });
};
$('removeAudio').onclick = () => {
  $('musicPreview').pause();
  $('musicPreview').removeAttribute('src');
  snapshotHistory();
  state.audioClips = [];
  state.activeAudioId = '';
  state.audioPath = state.audioName = state.audioUrl = '';
  state.audioSourceDuration = state.audioStart = state.audioTrim = state.audioDuration = 0;
  renderEditor();
};
$('audioTrackAdd').onclick = event => { event.stopPropagation(); $('audioFile').click(); };
$('audioTrackAdd').onpointerdown = event => event.stopPropagation();
$('extractAudioTop').onclick = () => $('extractAudioFile').click();
$('extractAudio').onclick = () => $('extractAudioFile').click();
$('extractAudioFile').onchange = event => busy('Đang tách MP3 từ video trên máy…', async () => {
  const file = event.target.files[0];
  if (!file) return;
  const response = await fetch('/api/video', {
    method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) }, body: file,
  });
  const imported = await response.json();
  if (!response.ok || !imported.ok) throw new Error(imported.error || 'Không nhập được video local.');
  await api('/api/audio/extract', { method: 'POST', body: JSON.stringify({ id: imported.id }) });
  state.audioAssets = (await api('/api/audio/library')).assets || [];
  await load(); renderAudioAssets(); event.target.value = '';
});
$('importAudioUrl').onclick = () => busy('Đang lấy âm thanh từ URL TikTok…', async () => {
  const pasted = $('audioUrl').value.trim();
  const url = (pasted.match(/https:\/\/[^\s]+/i) || [pasted])[0].replace(/[),.;]+$/, '');
  if (!url) throw new Error('Hãy dán URL video TikTok.');
  await api('/api/audio/url', { method: 'POST', body: JSON.stringify({ url }) });
  state.audioAssets = (await api('/api/audio/library')).assets || [];
  renderAudioAssets();
  $('audioUrl').value = '';
});
$('musicVolume').oninput = () => { $('musicPreview').volume = clamp(Number($('musicVolume').value), 0, 1); };
$('audioClipVolume').oninput = () => {
  const clip = activeAudioClip();
  if (!clip) return;
  const volume = clamp(Number($('audioClipVolume').value), 0, 2);
  selectedAudioClips().forEach(item => { item.volume = volume; item.muted = volume <= 0; });
  $('audioClipVolumeValue').textContent = `${Math.round(volume * 100)}%`;
  renderAudioClip();
  syncMusic(false);
};
$('audioClipVolume').onpointerdown = () => { if (activeAudioClip()) snapshotHistory(); };
$('audioClipSpeed').oninput = () => {
  const clip = activeAudioClip();
  if (!clip) return;
  const speed = clamp(Number($('audioClipSpeed').value), .5, 2);
  selectedAudioClips().forEach(item => {
    const oldSpeed = clamp(Number(item.speed) || 1, .5, 2);
    const sourceSpan = item.duration * oldSpeed;
    item.speed = speed;
    item.duration = Math.min(Math.max(.1, sourceSpan / speed), Math.max(.1, (item.sourceDuration - item.trim) / speed));
  });
  $('audioClipSpeedValue').textContent = `${speed.toFixed(2)}x`;
  renderAudioClip();
  syncMusic(false);
};
$('audioClipSpeed').onpointerdown = () => { if (activeAudioClip()) snapshotHistory(); };
$('export').onclick = () => busy('Đang xuất video 1080P chất lượng cao…', async () => {
  if (!state.timeline.length) throw new Error('Timeline chưa có clip.');
  const payload = {
    clips: state.timeline.map(({ uid, thumbnailUrl, previewUrl, sourceDuration, ...clip }) => clip),
    text: $('textOverlay').value, textSize: Number($('textSize').value), textColor: $('textColor').value,
    outlineColor: $('outlineColor').value, outlineWidth: Number($('outlineWidth').value), textPosition: $('textPosition').value,
    audioPath: state.audioPath, musicVolume: Number($('musicVolume').value),
    videoTrackMuted: state.videoTrackMuted, audioTrackMuted: state.audioTrackMuted,
    audioStart: state.audioStart, audioTrim: state.audioTrim, audioDuration: state.audioDuration,
    audioClips: state.audioClips.map(({ uid, url, sourceDuration, ...clip }) => clip),
  };
  $('exportProgressWrap').hidden = false;
  $('exportProgress').value = 0;
  $('exportProgressText').textContent = '0%';
  const started = await api('/api/export/start', { method: 'POST', body: JSON.stringify(payload) });
  let result;
  while (true) {
    await new Promise(resolve => setTimeout(resolve, 400));
    result = await api(`/api/export/status?id=${encodeURIComponent(started.jobId)}`);
    const percent = Math.max(0, Math.min(100, Number(result.progress) || 0));
    $('exportProgress').value = percent;
    $('exportProgressText').textContent = `${percent}%`;
    if (result.status === 'done') break;
    if (result.status === 'error') throw new Error(result.error || 'Xuất video thất bại.');
  }
  await load();
  if (result.recordId && !state.records.some(item => item.id === result.recordId)) {
    await new Promise(resolve => setTimeout(resolve, 250));
    await load();
  }
  if (result.recordId && !state.records.some(item => item.id === result.recordId)) {
    throw new Error('Video đã xuất thành công nhưng chưa xuất hiện trong Thư viện. File vẫn được giữ tại: ' + result.file);
  }
  $('exportProgressWrap').hidden = true;
  setView('editor');
  $('editorEditedSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
  showToast(`Xuất video thành công · Đã lưu vào Thư viện: ${result.file}`);
  $('exportSuccessPath').textContent = result.file;
  $('exportSuccess').showModal();
});
$('exportSuccessClose').onclick = () => $('exportSuccess').close();
$('exportSuccessFolder').onclick = async () => {
  await api('/api/open-folder', { method: 'POST', body: JSON.stringify({ exports: true }) });
  $('exportSuccess').close();
};
$('openFolder').onclick = async () => api('/api/open-folder', { method: 'POST', body: JSON.stringify({ exports: false }) });
$('openExports').onclick = async () => api('/api/open-folder', { method: 'POST', body: JSON.stringify({ exports: true }) });

document.addEventListener('keydown', event => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
  if (event.code === 'Space') { event.preventDefault(); togglePlay(); }
  else if (event.key.toLowerCase() === 's') { event.preventDefault(); state.activeTrack === 'audio' ? splitActiveAudio() : splitActive(); }
  else if (event.key === 'Delete') { event.preventDefault(); state.activeTrack === 'audio' ? removeActiveAudio() : removeActive(); }
  else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') { event.preventDefault(); state.activeTrack === 'audio' ? copyActiveAudio() : copyActiveClip(); }
  else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') { event.preventDefault(); state.activeTrack === 'audio' ? pasteCopiedAudio() : pasteCopiedClip(); }
  else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); }
  else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); }
});
$('timelineScroller').addEventListener('wheel', event => {
  if (event.ctrlKey) {
    event.preventDefault();
    state.zoom = clamp(state.zoom + (event.deltaY < 0 ? 10 : -10), 35, 240);
    $('timelineZoom').value = state.zoom;
    $('timelineZoomValue').textContent = `${state.zoom} px/s`;
    scheduleTimelineRender();
  } else if (event.shiftKey) {
    event.preventDefault();
    $('timelineScroller').scrollLeft += event.deltaY || event.deltaX;
  }
}, { passive: false });
window.addEventListener('resize', scheduleTimelineRender);

function selectedTikTokIds() {
  if (state.tiktokSingleId) return [state.tiktokSingleId];
  return [...state.selected];
}
async function ttBusy(title, fn) { try { return await busy(title, fn); } catch(e) { alert(e.message || 'Chưa hoàn tất thao tác TikTok.'); } }
const ttLabels = {draft:'Bản nháp',queued:'Đang chờ',scheduled:'Đã lên lịch',opening:'Mở tài khoản',uploading:'Đang chuẩn bị video',review:'Chờ kiểm tra & đăng',needs_attention:'Cần xử lý',uncertain:'Cần đối chiếu',done:'Đã đăng',cancelled:'Đã hủy'};
let ttComposeIds=[];
const ttLocalTime=epoch=>{const d=new Date(epoch*1000);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
const ttOptions=()=>'<option value="">Chọn nick…</option>'+(state.tiktokSettings?.accounts||[]).map(a=>`<option value="${a.id}">@${escapeHtml(a.username)}</option>`).join('');
function renderTTItems(ids){
 ttComposeIds=[...ids];
 $('ttItems').innerHTML=ids.map((id,i)=>{const r=state.records.find(r=>r.id===id);return `<div class="tt-item" data-record="${escapeHtml(id)}"><div><b>${i+1}. ${escapeHtml(r?.title||id)}</b><button type="button" data-tt-preview="${escapeHtml(id)}">▷ Xem video</button></div><select data-field="accountId">${ttOptions()}</select><textarea data-field="caption" maxlength="2200" placeholder="Caption riêng"></textarea><input data-field="at" type="datetime-local"><div class="social-grid"><input data-field="product" placeholder="Ghi chú sản phẩm" maxlength="300"><input data-field="music" placeholder="Ghi chú nhạc TikTok" maxlength="300"></div></div>`;}).join('');
 $('ttItems').querySelectorAll('[data-tt-preview]').forEach(e=>e.onclick=()=>{const r=state.records.find(x=>x.id===e.dataset.ttPreview);$('ttPreviewVideo').src=r?.mediaUrl||('/media/'+encodeURIComponent(e.dataset.ttPreview));$('ttPreviewDialog').showModal();});
}
function collectTTItems(){return [...$('ttItems').querySelectorAll('.tt-item')].map(e=>{const get=k=>e.querySelector(`[data-field="${k}"]`).value;const item={recordId:e.dataset.record,accountId:get('accountId')||$('ttAccount').value,caption:get('caption'),product:get('product'),music:get('music')};if(get('at'))item.scheduledAt=new Date(get('at')).getTime()/1000;return item;});}
$('ttApplyAll').onclick=()=>{const at=$('tiktokSchedule').value?new Date($('tiktokSchedule').value).getTime()/1000:Date.now()/1000;const interval=Number($('ttInterval').value)*60;[...$('ttItems').querySelectorAll('.tt-item')].forEach((e,i)=>{for(const [k,v] of Object.entries({accountId:$('ttAccount').value,caption:$('tiktokCaption').value,product:$('ttProduct').value,music:$('ttMusic').value,at:ttLocalTime(at+i*interval)}))e.querySelector(`[data-field="${k}"]`).value=v;});};
$('ttPreviewDialog').addEventListener('close',()=>{$('ttPreviewVideo').pause();$('ttPreviewVideo').removeAttribute('src');$('ttPreviewVideo').load();});
function editTTJob(j){$('ttEditId').value=j.id;$('ttEditAccount').innerHTML=ttOptions();$('ttEditAccount').value=j.accountId;$('ttEditCaption').value=j.caption;$('ttEditAt').value=ttLocalTime(j.scheduledAt);$('ttEditProduct').value=j.product||'';$('ttEditMusic').value=j.music||'';$('ttEditDialog').showModal();}
$('ttEditSave').onclick=()=>ttBusy('Đang lưu thay đổi…',async()=>{if(!$('ttEditAt').value)throw new Error('Chọn thời gian.');await api('/api/tiktok/job',{method:'POST',body:JSON.stringify({action:'edit',jobId:$('ttEditId').value,accountId:$('ttEditAccount').value,caption:$('ttEditCaption').value,scheduledAt:new Date($('ttEditAt').value).getTime()/1000,product:$('ttEditProduct').value,music:$('ttEditMusic').value})});$('ttEditDialog').close();await loadTikTokSettings();});
function renderTikTokJobs(jobs = []) {
  const accounts = state.tiktokSettings?.accounts || [];
  const counts={draft:0,scheduled:0,review:0,done:0,needs_attention:0};jobs.forEach(j=>{if(j.status in counts)counts[j.status]++;});$('ttSummary').innerHTML=Object.entries(counts).map(([k,v])=>`<span><b>${v}</b> ${ttLabels[k]}</span>`).join('');
  const query=$('ttSearch').value.toLocaleLowerCase('vi').normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const filtered=jobs.filter(j=>(!$('ttStatus').value||j.status===$('ttStatus').value)&&((j.title||'')+' '+(accounts.find(a=>a.id===j.accountId)?.username||'')).toLocaleLowerCase('vi').normalize('NFD').replace(/[\u0300-\u036f]/g,'').includes(query));
  $('tiktokJobs').innerHTML = filtered.length ? [...filtered].reverse().map(j => `<div class="tiktok-job">
    <b>${escapeHtml(j.title)}</b><span>${escapeHtml(ttLabels[j.status] || j.status)}</span>
    <small>@${escapeHtml(accounts.find(a=>a.id===j.accountId)?.username || '')} · ${escapeHtml(new Date(j.scheduledAt*1000).toLocaleString('vi-VN'))}</small>
    <progress max="100" value="${Number(j.progress)||0}"></progress><small>${escapeHtml(j.error || '')}</small>
    <div>${['draft','queued','scheduled'].includes(j.status)?`<button data-tt-job="${j.id}" data-action="edit">Sửa nội dung / lịch</button>`:''}${j.status==='draft'?`<button data-tt-job="${j.id}" data-action="activate">Đưa vào lịch</button>`:''}<button data-tt-job="${j.id}" data-action="open">Mở TikTok</button>${j.status==='needs_attention'&&!j.fileSent?`<button data-tt-job="${j.id}" data-action="retry">Thử lại</button>`:''}${['review','uncertain','needs_attention'].includes(j.status)?`<button data-tt-job="${j.id}" data-action="confirm_manual">Đã đăng · Nhập link</button>`:''}${['draft','queued','scheduled','review','needs_attention'].includes(j.status)?`<button data-tt-job="${j.id}" data-action="cancel">Hủy lịch</button>`:''}</div>
    </div>`).join('') : '<small>Chưa có video trong hàng đợi.</small>';
  document.querySelectorAll('[data-tt-job]').forEach(e=>e.onclick=()=>ttBusy('Đang xử lý…',async()=>{const job=jobs.find(j=>j.id===e.dataset.ttJob);if(e.dataset.action==='edit'){editTTJob(job);return;}if(e.dataset.action==='activate'&&!confirm('Đưa bản nháp vào lịch chuẩn bị video cho nick đã chọn?'))return;let postUrl='';if(e.dataset.action==='confirm_manual'){postUrl=prompt('Dán link bài đã đăng đúng video và nick để ghi nhận xác nhận thủ công:');if(!postUrl)return;}await api('/api/tiktok/job',{method:'POST',body:JSON.stringify({jobId:e.dataset.ttJob,action:e.dataset.action,postUrl,consent:e.dataset.action==='activate'})});await loadTikTokSettings();}));
}
async function loadTikTokSettings() {
  const data = await api('/api/tiktok/settings'); state.tiktokSettings=data;
  const selected=$('ttAccount').value;
  $('ttAccount').innerHTML='<option value="">Chọn tài khoản…</option>'+(data.accounts||[]).map(a=>`<option value="${a.id}">@${escapeHtml(a.username)}</option>`).join('');
  if ((data.accounts||[]).some(a=>a.id===selected)) $('ttAccount').value=selected;
  $('ttAccounts').innerHTML=(data.accounts||[]).map(a=>`<div class="tt-account"><b>♪ @${escapeHtml(a.username)}</b><small>${escapeHtml(a.status)}</small><div><button data-tt-account="${a.id}" data-action="open">Đăng nhập / Mở</button><button data-tt-account="${a.id}" data-action="check">Kiểm tra</button><button data-tt-account="${a.id}" data-action="close">Đóng</button></div></div>`).join('') || '<p>Thêm nick để tạo profile riêng.</p>';
  document.querySelectorAll('[data-tt-account]').forEach(e=>e.onclick=()=>ttBusy('Đang xử lý tài khoản…',async()=>{await api('/api/tiktok/account',{method:'POST',body:JSON.stringify({accountId:e.dataset.ttAccount,action:e.dataset.action})});await loadTikTokSettings();}));
  $('ttPause').textContent=data.paused?'Tiếp tục hàng đợi':'Tạm dừng hàng đợi';renderTikTokJobs(data.jobs||[]);return data;
}
async function openTikTokDialog(singleId='') {
  state.tiktokSingleId=singleId; $('tiktokConsent').checked=false;
  await loadTikTokSettings(); const ids=selectedTikTokIds();
  $('tiktokSelectedText').textContent=`Đã chọn ${ids.length} video`;
  $('ttVideos').innerHTML=ids.map(id=>{const card=document.querySelector(`[data-publish-tiktok="${CSS.escape(id)}"]`)?.closest('.card');const img=card?.querySelector('img');return img?`<img src="${escapeHtml(img.src)}" alt="Video đã chọn">`:'';}).join('');
  renderTTItems(ids);
  if (!$('tiktokDialog').open) $('tiktokDialog').showModal();
}
$('publishTikTokSelected').onclick=()=>ttBusy('Đang mở TikTok…',()=>openTikTokDialog(''));
$('tiktokSettings').onclick=()=>ttBusy('Đang mở TikTok…',()=>openTikTokDialog(''));
$('closeTikTok').onclick=()=>$('tiktokDialog').close();
$('saveTikTok').onclick=()=>ttBusy('Đang thêm nick…',async()=>{await api('/api/tiktok/configure',{method:'POST',body:JSON.stringify({display_name:$('tiktokDisplayName').value.trim()})});$('tiktokDisplayName').value='';await loadTikTokSettings();});
$('ttRefresh').onclick=()=>ttBusy('Đang cập nhật…',loadTikTokSettings);
$('ttPause').onclick=()=>ttBusy('Đang cập nhật…',async()=>{await api('/api/tiktok/job',{method:'POST',body:JSON.stringify({action:'pause',paused:!state.tiktokSettings?.paused})});await loadTikTokSettings();});
async function saveTTBatch(draft=false){
 const items=collectTTItems();if(!items.length)throw new Error('Chọn ít nhất một video.');
 if(items.some(i=>!i.accountId))throw new Error('Chọn nick cho từng video.');
 if(!draft&&!$('tiktokConsent').checked)throw new Error('Hãy kiểm tra và xác nhận nội dung.');
 await api('/api/tiktok/enqueue',{method:'POST',body:JSON.stringify({ids:ttComposeIds,items,accountId:$('ttAccount').value,scheduledAt:$('tiktokSchedule').value?new Date($('tiktokSchedule').value).getTime()/1000:Date.now()/1000,intervalMinutes:Number($('ttInterval').value),consent:$('tiktokConsent').checked,draft})});
 await loadTikTokSettings();showToast(draft?'Đã lưu bản nháp.':'Đã lưu lịch chuẩn bị video.');
}
$('queueTikTok').onclick=()=>ttBusy('Đang lưu lịch…',()=>saveTTBatch(false));
$('ttSaveDraft').onclick=()=>ttBusy('Đang lưu bản nháp…',()=>saveTTBatch(true));
$('ttSearch').oninput=$('ttStatus').onchange=()=>renderTikTokJobs(state.tiktokSettings?.jobs||[]);
let ttPolling=false;
setInterval(async()=>{if(!$('tiktokDialog').open||ttPolling)return;ttPolling=true;try{await loadTikTokSettings();}catch(e){$('tiktokConnection').textContent='Chưa cập nhật được trạng thái: '+e.message;}finally{ttPolling=false;}},4000);
window.addEventListener('focus', refreshLibraryIfChanged);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshLibraryIfChanged();
});
setInterval(refreshLibraryIfChanged, 3000);
load();
