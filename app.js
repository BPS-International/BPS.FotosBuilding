/* BPS.FotosBuilding viewer */
(() => {
  const SHARE = new URLSearchParams(location.search).get('mode') === 'share'
    || document.body?.dataset?.mode === 'share'
    || window.BPS_SHARE === true;
  const WEB = document.body?.dataset?.backend === 'web'
    || window.BPS_BACKEND === 'web';

  const DOT_R = 15;
  const CONE_HALF_DEG = 28;
  const CONE_LEN = 100; // фиксированная длина конуса (как на скрине)
  const PREVIEW_MIN = 180;
  const PREVIEW_MAX = 1200;
  const LS_PREVIEW = 'bps.fotosbuilding.previewWidth.v3';
  const LS_GROUP_DIAM = 'bps.fotosbuilding.groupDiameterPx';
  const LS_PREVIEW_FADE = 'bps.fotosbuilding.previewFadeMs';
  const DEFAULT_PREVIEW_FADE_MS = 1100;
  const FLOOR_ORDER = ['UG', 'EG', '1.OG', 'DG'];
  const TAP_MOVE_PX = 10;
  const GROUP_RADIUS_M = 2; // радиус группировки снимков «то же место, другая дата»
  const DATE_SCALE_STOPS = [
    { h: 252, s: 58, l: 42 },
    { h: 228, s: 62, l: 48 },
    { h: 204, s: 65, l: 52 },
    { h: 178, s: 55, l: 55 },
    { h: 195, s: 45, l: 72 },
  ];

  const RADAR_SVG = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/>
      <circle cx="12" cy="12" r="5" fill="none" stroke="currentColor" stroke-width="1.6"/>
      <circle cx="12" cy="12" r="1.8" fill="currentColor"/>
      <path d="M12 12 L19 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    </svg>`;

  const state = {
    photos: [],
    dates: [],
    activeDate: null,
    selectedId: null,
    floors: [],
    activeFloorId: 'UG',
    seedsByFloor: new Map(), // floorId -> Map(id -> seed)
    cameras: new Map(),
    pageWidth: 0,
    pageHeight: 0,
    scale: 1,
    panX: 0,
    panY: 0,
    draggingPan: false,
    dragStart: null,
    resizingPreview: false,
    place: {
      active: false,
      id: null,
      step: 'idle',
      x: null,
      y: null,
      yawDeg: null,
      coneLen: CONE_LEN,
    },
    planRotation: 0,
    gpsCalibMode: false,
    gpsCalibByFloor: new Map(), // floorId -> { anchorId, points:[{id,x,y,lat,lon}], scale, theta }
    groupTestDiameterPx: 120,
    previewFadeMs: DEFAULT_PREVIEW_FADE_MS,
    previewLayer: 'a',
    previewFadeToken: 0,
    previewZoomScale: 1,
    lightboxZoomScale: 1,
    previewPan: { x: 0, y: 0 },
    lightboxPan: { x: 0, y: 0 },
    groupBlendActive: false,
    groupScrub: null, // { date, u, dominantId, clientX }
    drawnPlanKey: '',
    planPdfDocs: new Map(), // `${floorId}/${file}` -> pdf.js document
    planRenderToken: 0,
  };

  const els = {
    layout: document.getElementById('layout'),
    floorTabs: document.getElementById('floorTabs'),
    dateSelect: document.getElementById('dateSelect'),
    projectSelect: document.getElementById('projectSelect'),
    btnAddProject: document.getElementById('btnAddProject'),
    buildStamp: document.getElementById('buildStamp'),
    photoList: document.getElementById('photoList'),
    photoCount: document.getElementById('photoCount'),
    placedCount: document.getElementById('placedCount'),
    stage: document.getElementById('stage'),
    planCanvas: document.getElementById('planCanvas'),
    overlay: document.getElementById('overlay'),
    planEmpty: document.getElementById('planEmpty'),
    dateScale: document.getElementById('dateScale'),
    dateScaleTrack: document.getElementById('dateScaleTrack'),
    dateScaleThumb: document.getElementById('dateScaleThumb'),
    statusHint: document.getElementById('statusHint'),
    previewPanel: document.getElementById('previewPanel'),
    previewSplitter: document.getElementById('previewSplitter'),
    groupScaleBar: document.getElementById('groupScaleBar'),
    groupScale: document.getElementById('groupScale'),
    groupScaleTrack: document.getElementById('groupScaleTrack'),
    groupScaleThumb: document.getElementById('groupScaleThumb'),
    groupDiameterPx: document.getElementById('groupDiameterPx'),
    previewFadeMs: document.getElementById('previewFadeMs'),
    previewImg: document.getElementById('previewImg'),
    previewImgAlt: document.getElementById('previewImgAlt'),
    previewPhotoWrap: document.querySelector('.preview-photo-wrap'),
    openOriginal: document.getElementById('openOriginal'),
    seedInfo: document.getElementById('seedInfo'),
    exifCam: document.getElementById('exifCam'),
    exifGps: document.getElementById('exifGps'),
    photoMetaGrid: document.getElementById('photoMetaGrid'),
    lightbox: document.getElementById('lightbox'),
    lightboxImg: document.getElementById('lightboxImg'),
    lightboxClose: document.getElementById('lightboxClose'),
    btnSave: document.getElementById('btnSave'),
    btnClearSeed: document.getElementById('btnClearSeed'),
    btnCancelPlace: document.getElementById('btnCancelPlace'),
    btnGpsCalib: document.getElementById('btnGpsCalib'),
    btnGpsAuto: document.getElementById('btnGpsAuto'),
    btnReplacePlan: document.getElementById('btnReplacePlan'),
    btnRefreshPhotos: document.getElementById('btnRefreshPhotos'),
    planSelect: document.getElementById('planSelect'),
    planFileInput: document.getElementById('planFileInput'),
    btnZoomIn: document.getElementById('btnZoomIn'),
    btnZoomOut: document.getElementById('btnZoomOut'),
    btnZoomFit: document.getElementById('btnZoomFit'),
    btnRotateLeft: document.getElementById('btnRotateLeft'),
    btnRotateRight: document.getElementById('btnRotateRight'),
  };

  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  function photoById(id) {
    return state.photos.find((p) => p.id === id);
  }

  function currentFloor() {
    return state.floors.find((f) => f.id === state.activeFloorId) || null;
  }

  function normalizeFloor(f) {
    const floor = {
      ...f,
      planFile: f.planFile ? String(f.planFile) : null,
      planRotation: Number(f.planRotation) || 0,
      planByDate: {},
    };
    if (f.planByDate && typeof f.planByDate === 'object') {
      for (const [d, entry] of Object.entries(f.planByDate)) {
        if (entry && entry.planFile) {
          floor.planByDate[d] = {
            planFile: String(entry.planFile),
            planRotation: Number(entry.planRotation) || 0,
          };
        }
      }
    }
    return floor;
  }

  function setPlanEntryForDate(floor, date, planFile, planRotation) {
    if (!floor || !date || !planFile) return;
    if (!floor.planByDate) floor.planByDate = {};
    floor.planByDate[date] = {
      planFile: String(planFile),
      planRotation: Number(planRotation) || 0,
    };
  }

  function resolveFloorPlan(floor, date) {
    if (!floor) return null;
    const dateKey = date || state.activeDate;
    const entry = dateKey && floor.planByDate ? floor.planByDate[dateKey] : null;
    if (entry && entry.planFile) {
      return {
        planFile: entry.planFile,
        planRotation: Number(entry.planRotation ?? floor.planRotation) || 0,
        date: dateKey,
      };
    }
    if (floor.planFile) {
      return {
        planFile: floor.planFile,
        planRotation: Number(floor.planRotation) || 0,
        date: null,
      };
    }
    return null;
  }

  function floorHasAnyPlan(f) {
    if (!f) return false;
    if (f.planFile) return true;
    const by = f.planByDate || {};
    return Object.values(by).some((e) => e && e.planFile);
  }

  function formatScaleDateLabel(date, isActive) {
    if (isActive) return date;
    const m = String(date).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return `${m[3]}.${m[2]}.`;
    return date;
  }

  function seedMap() {
    if (!state.seedsByFloor.has(state.activeFloorId)) {
      state.seedsByFloor.set(state.activeFloorId, new Map());
    }
    return state.seedsByFloor.get(state.activeFloorId);
  }

  function poseOf(id) {
    const seeds = seedMap();
    if (seeds.has(id)) {
      const s = seeds.get(id);
      let status = 'seed';
      if (s.source === 'gps') status = 'gps';
      else if (s.source === 'auto') status = 'auto';
      return { ...s, status };
    }
    if (state.cameras.has(id)) {
      return { ...state.cameras.get(id), status: 'auto' };
    }
    return null;
  }

  function filteredPhotos() {
    return state.photos
      .filter((p) => p.date === state.activeDate)
      .sort((a, b) => a.number - b.number);
  }

  function applyTransform() {
    const t = `translate(${state.panX}px, ${state.panY}px) scale(${state.scale})`;
    els.planCanvas.style.transform = t;
    els.overlay.style.transform = t;
  }

  function fitPlan() {
    const rect = els.stage.getBoundingClientRect();
    if (!state.pageWidth || !rect.width) return;
    const sx = (rect.width - 24) / state.pageWidth;
    const sy = (rect.height - 24) / state.pageHeight;
    state.scale = Math.max(0.05, Math.min(sx, sy));
    state.panX = (rect.width - state.pageWidth * state.scale) / 2;
    state.panY = (rect.height - state.pageHeight * state.scale) / 2;
    applyTransform();
  }

  function sortedFloors() {
    return [...state.floors].sort((a, b) => {
      const ia = FLOOR_ORDER.indexOf(a.id);
      const ib = FLOOR_ORDER.indexOf(b.id);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });
  }

  function maxPreviewWidth() {
    const total = window.innerWidth || 1600;
    const sidebar = 280;
    const splitter = 6;
    const minStage = 300;
    // По умолчанию ~4/5 от максимально возможной ширины превью (на 1/5 меньше).
    const full = clamp(total - sidebar - splitter - minStage, PREVIEW_MIN, PREVIEW_MAX);
    return Math.round(full * 0.8);
  }

  function isMobileLayout() {
    return window.matchMedia('(max-width: 768px)').matches;
  }

  function openLightboxFor(id) {
    const p = photoById(id);
    if (!p) return;
    resetLightboxZoom();
    els.lightboxImg.src = `/${p.originalUrl}`;
    els.lightbox.classList.remove('hidden');
  }

  function closeLightbox() {
    els.lightbox.classList.add('hidden');
    resetLightboxZoom();
    resetPhotoPanUi();
  }

  function fitImageBoxInContainer(img, container) {
    if (!img || !container || !(img.naturalWidth > 0)) return null;
    const cw = Math.max(1, container.clientWidth);
    const ch = Math.max(1, container.clientHeight);
    const ir = img.naturalWidth / img.naturalHeight;
    const cr = cw / ch;
    if (ir > cr) return { w: cw, h: cw / ir };
    return { w: ch * ir, h: ch };
  }

  function previewPanTransform() {
    const { x, y } = state.previewPan;
    return `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
  }

  function applyPreviewPanTransform() {
    const img = activePreviewImg();
    if (!img || state.previewZoomScale <= 1) return;
    img.style.left = '50%';
    img.style.top = '50%';
    img.style.transform = previewPanTransform();
  }

  function applyLightboxPanTransform() {
    const img = els.lightboxImg;
    if (!img || state.lightboxZoomScale <= 1) return;
    const { x, y } = state.lightboxPan;
    img.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
  }

  function applyPreviewZoom() {
    const wrap = els.previewPhotoWrap;
    if (!wrap) return;
    const scale = state.previewZoomScale;
    const imgs = [els.previewImg, els.previewImgAlt].filter(Boolean);
    if (scale <= 1) {
      wrap.classList.remove('is-zoomed');
      state.previewPan = { x: 0, y: 0 };
      for (const img of imgs) {
        img.style.width = '';
        img.style.height = '';
        img.style.maxWidth = '';
        img.style.maxHeight = '';
        img.style.left = '';
        img.style.top = '';
        img.style.transform = '';
      }
      return;
    }
    wrap.classList.add('is-zoomed');
    const ref = activePreviewImg() || els.previewImg;
    const box = fitImageBoxInContainer(ref, wrap);
    if (!box) return;
    const w = `${box.w * scale}px`;
    const h = `${box.h * scale}px`;
    for (const img of imgs) {
      if (!img.getAttribute('src')) continue;
      img.style.maxWidth = 'none';
      img.style.maxHeight = 'none';
      img.style.width = w;
      img.style.height = h;
      if (img.classList.contains('is-front')) {
        img.style.left = '50%';
        img.style.top = '50%';
        img.style.transform = previewPanTransform();
      }
    }
  }

  function resetPreviewZoom() {
    state.previewZoomScale = 1;
    state.previewPan = { x: 0, y: 0 };
    applyPreviewZoom();
    updatePhotoPanCursor();
  }

  function resetLightboxZoom() {
    state.lightboxZoomScale = 1;
    state.lightboxPan = { x: 0, y: 0 };
    if (!els.lightboxImg) return;
    els.lightboxImg.style.width = '';
    els.lightboxImg.style.height = '';
    els.lightboxImg.style.maxWidth = '';
    els.lightboxImg.style.maxHeight = '';
    els.lightboxImg.style.left = '';
    els.lightboxImg.style.top = '';
    els.lightboxImg.style.transform = '';
    els.lightbox?.classList.remove('is-zoomed');
    updatePhotoPanCursor();
  }

  function applyLightboxZoom() {
    const scale = state.lightboxZoomScale;
    const img = els.lightboxImg;
    const box = els.lightbox;
    if (!img || !box) return;
    if (scale <= 1) {
      resetLightboxZoom();
      return;
    }
    box.classList.add('is-zoomed');
    const viewport = box.querySelector('.lightbox-viewport') || box;
    const fit = fitImageBoxInContainer(img, viewport);
    if (!fit) return;
    img.style.maxWidth = 'none';
    img.style.maxHeight = 'none';
    img.style.width = `${fit.w * scale}px`;
    img.style.height = `${fit.h * scale}px`;
    img.style.left = '50%';
    img.style.top = '50%';
    img.style.position = 'absolute';
    const { x, y } = state.lightboxPan;
    img.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
  }

  function onPreviewWheel(ev) {
    if (!state.selectedId || !els.previewPhotoWrap) return;
    const img = activePreviewImg();
    if (!img || !img.getAttribute('src')) return;
    ev.preventDefault();
    const factor = ev.deltaY > 0 ? 0.9 : 1.1;
    state.previewZoomScale = clamp(state.previewZoomScale * factor, 1, 5);
    applyPreviewZoom();
    updatePhotoPanCursor();
  }

  function onLightboxWheel(ev) {
    if (els.lightbox.classList.contains('hidden')) return;
    if (!els.lightboxImg.getAttribute('src')) return;
    ev.preventDefault();
    const factor = ev.deltaY > 0 ? 0.9 : 1.1;
    state.lightboxZoomScale = clamp(state.lightboxZoomScale * factor, 1, 6);
    applyLightboxZoom();
    updatePhotoPanCursor();
  }

  const photoPan = {
    spaceDown: false,
    dragging: false,
    target: null,
    startX: 0,
    startY: 0,
    startPanX: 0,
    startPanY: 0,
    moved: false,
    suppressClick: false,
  };

  function isPreviewZoomed() {
    return state.previewZoomScale > 1;
  }

  function isLightboxZoomed() {
    return state.lightboxZoomScale > 1 && els.lightbox && !els.lightbox.classList.contains('hidden');
  }

  function canPhotoPan() {
    return (isPreviewZoomed() || isLightboxZoomed());
  }

  function updatePhotoPanCursor() {
    const previewReady = photoPan.spaceDown && isPreviewZoomed();
    const lightboxReady = photoPan.spaceDown && isLightboxZoomed();
    els.previewPhotoWrap?.classList.toggle('pan-ready', previewReady && !photoPan.dragging);
    els.previewPhotoWrap?.classList.toggle('pan-dragging', previewReady && photoPan.dragging && photoPan.target === 'preview');
    els.lightbox?.classList.toggle('pan-ready', lightboxReady && !photoPan.dragging);
    els.lightbox?.classList.toggle('pan-dragging', lightboxReady && photoPan.dragging && photoPan.target === 'lightbox');
  }

  function resolvePhotoPanTarget(ev) {
    if (isPreviewZoomed() && els.previewPhotoWrap?.contains(ev.target)) return 'preview';
    if (isLightboxZoomed() && els.lightbox?.contains(ev.target) && !ev.target.closest('.lightbox-close')) {
      return 'lightbox';
    }
    return null;
  }

  function panOffset(mode) {
    return mode === 'preview' ? state.previewPan : state.lightboxPan;
  }

  function onPhotoPanMouseDown(ev) {
    if (!photoPan.spaceDown || ev.button !== 0) return;
    const mode = resolvePhotoPanTarget(ev);
    if (!mode) return;
    ev.preventDefault();
    const pan = panOffset(mode);
    photoPan.dragging = true;
    photoPan.target = mode;
    photoPan.startX = ev.clientX;
    photoPan.startY = ev.clientY;
    photoPan.startPanX = pan.x;
    photoPan.startPanY = pan.y;
    photoPan.moved = false;
    updatePhotoPanCursor();
  }

  function onPhotoPanMouseMove(ev) {
    if (!photoPan.dragging || !photoPan.target) return;
    const dx = ev.clientX - photoPan.startX;
    const dy = ev.clientY - photoPan.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) photoPan.moved = true;
    if (!photoPan.moved) return;
    ev.preventDefault();
    const pan = panOffset(photoPan.target);
    pan.x = photoPan.startPanX + dx;
    pan.y = photoPan.startPanY + dy;
    if (photoPan.target === 'preview') applyPreviewPanTransform();
    else applyLightboxPanTransform();
  }

  function endPhotoPanDrag() {
    if (!photoPan.dragging) return;
    if (photoPan.moved) {
      photoPan.suppressClick = true;
      setTimeout(() => { photoPan.suppressClick = false; }, 0);
    }
    photoPan.dragging = false;
    photoPan.target = null;
    updatePhotoPanCursor();
  }

  function handlePhotoPanKeyDown(ev) {
    if (ev.code !== 'Space' && ev.key !== ' ') return;
    if (isTypingTarget(document.activeElement)) return;
    if (!canPhotoPan()) return;
    if (photoPan.spaceDown) return;
    ev.preventDefault();
    photoPan.spaceDown = true;
    updatePhotoPanCursor();
  }

  function handlePhotoPanKeyUp(ev) {
    if (ev.code !== 'Space' && ev.key !== ' ') return;
    if (!photoPan.spaceDown) return;
    photoPan.spaceDown = false;
    endPhotoPanDrag();
    updatePhotoPanCursor();
  }

  function resetPhotoPanUi() {
    photoPan.spaceDown = false;
    endPhotoPanDrag();
    updatePhotoPanCursor();
  }

  function bindPhotoZoomUi() {
    if (els.previewPhotoWrap) {
      els.previewPhotoWrap.addEventListener('wheel', onPreviewWheel, { passive: false });
    }
    if (els.lightbox) {
      els.lightbox.addEventListener('wheel', onLightboxWheel, { passive: false });
    }
    for (const img of [els.previewImg, els.previewImgAlt]) {
      if (!img) continue;
      img.addEventListener('load', () => {
        if (state.previewZoomScale > 1) applyPreviewZoom();
      });
    }
    if (els.lightboxImg) {
      els.lightboxImg.addEventListener('load', () => {
        if (state.lightboxZoomScale > 1) applyLightboxZoom();
      });
    }
    window.addEventListener('mousedown', onPhotoPanMouseDown);
    window.addEventListener('mousemove', onPhotoPanMouseMove);
    window.addEventListener('mouseup', endPhotoPanDrag);
  }

  function dist(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function hitTestMarker(clientX, clientY) {
    const pt = clientToPlan(clientX, clientY);
    const list = filteredPhotos();
    let best = null;
    let bestD = Infinity;
    const hitR = DOT_R + (isMobileLayout() ? 18 : 8);
    for (const p of list) {
      const pose = poseOf(p.id);
      if (!pose || pose.x == null || pose.y == null) continue;
      const d = dist(pt, { x: pose.x, y: pose.y });
      if (d <= hitR && d < bestD) {
        bestD = d;
        best = p.id;
      }
    }
    return best;
  }

  function setPreviewWidth(px) {
    const w = Math.round(clamp(px, PREVIEW_MIN, PREVIEW_MAX));
    document.documentElement.style.setProperty('--preview-w', `${w}px`);
    try { localStorage.setItem(LS_PREVIEW, String(w)); } catch { /* ignore */ }
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function clientToPlan(clientX, clientY) {
    const rect = els.stage.getBoundingClientRect();
    return {
      x: (clientX - rect.left - state.panX) / state.scale,
      y: (clientY - rect.top - state.panY) / state.scale,
    };
  }

  function yawFromPoints(from, to) {
    let deg = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
    if (deg < 0) deg += 360;
    return deg;
  }

  function statusLabel(status) {
    if (status === 'gps') return 'GPS';
    if (status === 'seed') return 'seed';
    if (status === 'auto') return 'auto';
    return 'keine';
  }

  function isTypingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  const yawKeyState = { timer: null, direction: null, firstTick: true, dirty: false };

  function stopYawKeyRepeat() {
    if (yawKeyState.timer) clearInterval(yawKeyState.timer);
    yawKeyState.timer = null;
    yawKeyState.direction = null;
    yawKeyState.firstTick = true;
  }

  function rotateSelectedYaw(deltaDeg) {
    if (!state.selectedId || state.place.active) return false;
    const seeds = seedMap();
    const seed = seeds.get(state.selectedId);
    if (!seed || seed.yawDeg == null) return false;
    seed.yawDeg = ((Number(seed.yawDeg) + deltaDeg) % 360 + 360) % 360;
    yawKeyState.dirty = true;
    redrawOverlay();
    updatePreviewMeta(state.selectedId, { skipImage: true });
    return true;
  }

  function tickYawKeyRepeat() {
    if (!yawKeyState.direction) return;
    const step = yawKeyState.firstTick ? 3 : 10;
    yawKeyState.firstTick = false;
    const delta = yawKeyState.direction === 'left' ? -step : step;
    if (!rotateSelectedYaw(delta)) stopYawKeyRepeat();
  }

  function startYawKeyRepeat(direction) {
    if (yawKeyState.direction === direction && yawKeyState.timer) return;
    stopYawKeyRepeat();
    yawKeyState.direction = direction;
    yawKeyState.firstTick = true;
    tickYawKeyRepeat();
    yawKeyState.timer = setInterval(tickYawKeyRepeat, 120);
  }

  async function flushYawRotationSave() {
    if (!yawKeyState.dirty) return;
    yawKeyState.dirty = false;
    await saveSeeds({ silent: true });
  }

  function handleYawKeyDown(ev) {
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    if (isTypingTarget(document.activeElement)) return;
    if (state.place.active) return;
    if (!state.selectedId) return;
    const seed = seedMap().get(state.selectedId);
    if (!seed || seed.yawDeg == null) return;
    ev.preventDefault();
    startYawKeyRepeat(ev.key === 'ArrowLeft' ? 'left' : 'right');
  }

  function handleYawKeyUp(ev) {
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    if (yawKeyState.direction !== (ev.key === 'ArrowLeft' ? 'left' : 'right')) return;
    stopYawKeyRepeat();
    flushYawRotationSave();
  }

  function setStatusHint(text) {if (!els.statusHint) return;
    const msg = String(text || '').trim();
    if (!msg) {
      els.statusHint.textContent = '';
      els.statusHint.classList.add('hidden');
      return;
    }
    els.statusHint.textContent = msg;
    els.statusHint.classList.remove('hidden');
  }

  function dateScaleGradient(index, total) {
    if (total <= 1) {
      const c = DATE_SCALE_STOPS[0];
      return `linear-gradient(180deg, hsl(${c.h} ${c.s}% ${c.l + 10}%) 0%, hsl(${c.h} ${c.s}% ${c.l}%) 100%)`;
    }
    const t = index / (total - 1);
    const pos = t * (DATE_SCALE_STOPS.length - 1);
    const i0 = Math.floor(pos);
    const i1 = Math.min(DATE_SCALE_STOPS.length - 1, i0 + 1);
    const f = pos - i0;
    const a = DATE_SCALE_STOPS[i0];
    const b = DATE_SCALE_STOPS[i1];
    const h = a.h + (b.h - a.h) * f;
    const s = a.s + (b.s - a.s) * f;
    const l = a.l + (b.l - a.l) * f;
    return `linear-gradient(180deg, hsl(${h} ${s}% ${l + 10}%) 0%, hsl(${h} ${s}% ${l}%) 100%)`;
  }

  /** Шкала дат: набор сегментов + бегунок. Используется и для общей шкалы, и для шкалы точки. */
  function createDateScale(cfg) {
    const local = { dates: [], value: null, dragging: false };

    function indexOfDate(date) {
      const i = local.dates.indexOf(date);
      return i >= 0 ? i : 0;
    }

    function isEnabled(date) {
      return cfg.isEnabled ? !!cfg.isEnabled(date) : true;
    }

    function dateIndexFromClientX(clientX) {
      const track = cfg.trackEl;
      if (!track || !local.dates.length) return 0;
      const rect = track.getBoundingClientRect();
      if (rect.width <= 0) return 0;
      const x = Math.max(0, Math.min(rect.width - 0.001, clientX - rect.left));
      const n = local.dates.length;
      if (n === 1) return 0;
      return Math.max(0, Math.min(n - 1, Math.floor((x / rect.width) * n)));
    }

    function dateFromClientX(clientX) {
      if (!local.dates.length) return null;
      return local.dates[dateIndexFromClientX(clientX)];
    }

    function syncStepLabels(track, activeIdx) {
      track.querySelectorAll('.date-step').forEach((el, i) => {
        el.classList.toggle('active', i === activeIdx);
        const lbl = el.querySelector('.date-step-label');
        if (lbl && local.dates[i]) {
          lbl.textContent = formatScaleDateLabel(local.dates[i], i === activeIdx);
        }
      });
    }

    function setThumbOverlay(on) {
      if (cfg.scaleEl) cfg.scaleEl.classList.toggle('has-thumb-label', !!on);
    }

    function updateThumb() {
      const track = cfg.trackEl;
      const thumb = cfg.thumbEl;
      if (!track || !thumb || !local.dates.length) return;
      const idx = indexOfDate(local.value);
      const n = local.dates.length;
      const fraction = n === 1 ? 0.5 : (idx + 0.5) / n;
      thumb.style.left = `${fraction * 100}%`;
      thumb.textContent = '';
      thumb.classList.remove('has-label');
      setThumbOverlay(false);
      syncStepLabels(track, idx);
    }

    function render(dates, value) {
      local.dates = Array.isArray(dates) ? dates.slice() : [];
      local.value = value;
      const track = cfg.trackEl;
      if (!track) return;
      track.innerHTML = '';
      if (!local.dates.length) return;
      local.dates.forEach((date, i) => {
        const seg = document.createElement('div');
        seg.className = 'date-step';
        seg.dataset.date = date;
        if (local.dates.length === 1) seg.classList.add('only');
        else {
          if (i === 0) seg.classList.add('first');
          if (i === local.dates.length - 1) seg.classList.add('last');
        }
        if (date === local.value) seg.classList.add('active');
        if (isEnabled(date)) seg.style.background = dateScaleGradient(i, local.dates.length);
        else seg.classList.add('disabled');
        seg.title = cfg.titleFor ? cfg.titleFor(date) : date;
        const lbl = document.createElement('span');
        lbl.className = 'date-step-label';
        lbl.textContent = formatScaleDateLabel(date, date === local.value);
        seg.appendChild(lbl);
        track.appendChild(seg);
      });
      updateThumb();
    }

    function setValue(value) {
      local.value = value;
      updateThumb();
    }

    function setThumbClientX(clientX, label) {
      const track = cfg.trackEl;
      const thumb = cfg.thumbEl;
      if (!track || !thumb) return;
      const rect = track.getBoundingClientRect();
      if (rect.width <= 0) return;
      const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      thumb.style.left = `${fraction * 100}%`;
      const date = dateFromClientX(clientX);
      if (date) {
        local.value = date;
        const idx = dateIndexFromClientX(clientX);
        syncStepLabels(track, idx);
        const plainDate = !label || label === date;
        if (plainDate) {
          thumb.textContent = '';
          thumb.classList.remove('has-label');
          setThumbOverlay(false);
        } else {
          thumb.textContent = label;
          thumb.classList.add('has-label');
          setThumbOverlay(true);
        }
      }
    }

    function pick(clientX) {
      if (cfg.onPickX) {
        cfg.onPickX(clientX);
        return;
      }
      const date = dateFromClientX(clientX);
      if (!date || !isEnabled(date)) return;
      cfg.onPick(date);
    }

    function bind() {
      const scale = cfg.scaleEl;
      if (!scale || !cfg.trackEl) return;

      function startDrag(clientX) {
        local.dragging = true;
        scale.classList.add('dragging');
        document.body.classList.add('date-scale-dragging');
        pick(clientX);
      }

      function endDrag() {
        if (!local.dragging) return;
        local.dragging = false;
        scale.classList.remove('dragging');
        document.body.classList.remove('date-scale-dragging');
        if (cfg.onDragEnd) cfg.onDragEnd();
      }

      scale.addEventListener('mousedown', (ev) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        startDrag(ev.clientX);
      });

      window.addEventListener('mousemove', (ev) => {
        if (!local.dragging) return;
        ev.preventDefault();
        pick(ev.clientX);
      });

      window.addEventListener('mouseup', endDrag);

      scale.addEventListener('touchstart', (ev) => {
        if (!ev.touches.length) return;
        startDrag(ev.touches[0].clientX);
      }, { passive: true });

      window.addEventListener('touchmove', (ev) => {
        if (!local.dragging || !ev.touches.length) return;
        pick(ev.touches[0].clientX);
      }, { passive: true });

      window.addEventListener('touchend', endDrag);
      window.addEventListener('touchcancel', endDrag);

      if (cfg.scrubOnHover) {
        scale.addEventListener('mousemove', (ev) => {
          if (local.dragging) return;
          pick(ev.clientX);
        });
      }
    }

    return { render, setValue, setThumbClientX, bind };
  }

  const mainDateScale = createDateScale({
    scaleEl: els.dateScale,
    trackEl: els.dateScaleTrack,
    thumbEl: els.dateScaleThumb,
    onPick: (date) => setActiveDate(date, { skipScaleRender: true, silent: true }),
  });

  const photoGroup = { anchorId: null, byDate: new Map() };

  const groupDateScale = createDateScale({
    scaleEl: els.groupScale,
    trackEl: els.groupScaleTrack,
    thumbEl: els.groupScaleThumb,
    isEnabled: (date) => {
      const hits = photoGroup.byDate.get(date);
      return !!(hits && hits.length);
    },
    titleFor: (date) => {
      const hits = photoGroup.byDate.get(date);
      if (!hits || !hits.length) return `${date} · keine Fotos in der Nähe`;
      const head = hits.length > 1 ? `${date} · ${hits.length} Fotos` : date;
      const first = hits[0];
      if (planPixelsPerMeter()) return `${head} · ${first.distM.toFixed(1)} m`;
      return `${head} · ${first.distPx.toFixed(0)} px`;
    },
    onPickX: (clientX) => pickGroupAt(clientX),
    onDragEnd: () => syncGroupThumbFromSelection(),
  });

  function groupSegmentInfoFromClientX(clientX) {
    const track = els.groupScaleTrack;
    const dates = state.dates || [];
    if (!track || !dates.length) return null;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return null;
    const x = Math.max(0, Math.min(rect.width - 0.001, clientX - rect.left));
    const n = dates.length;
    const dateIdx = n === 1 ? 0 : Math.floor((x / rect.width) * n);
    const date = dates[Math.max(0, Math.min(n - 1, dateIdx))];
    const hits = photoGroup.byDate.get(date);
    if (!hits || !hits.length) return null;

    const segLeft = (dateIdx / n) * rect.width;
    const segWidth = rect.width / n;
    const localX = Math.max(0, Math.min(segWidth, x - segLeft));
    const t = segWidth > 0 ? localX / segWidth : 0.5;

    const count = hits.length;
    let leftIdx = 0;
    let rightIdx = 0;
    let blend = 0;
    let u = 0;

    if (count > 1) {
      u = t * (count - 1);
      leftIdx = Math.floor(u);
      rightIdx = Math.min(count - 1, leftIdx + 1);
      blend = leftIdx === rightIdx ? 0 : u - leftIdx;
    }

    const dominantIdx = Math.max(0, Math.min(count - 1, Math.round(u)));

    return {
      date,
      hits,
      leftIdx,
      rightIdx,
      leftId: hits[leftIdx].id,
      rightId: hits[rightIdx].id,
      blend,
      u,
      dominantIdx,
      dominantId: hits[dominantIdx].id,
    };
  }

  function groupThumbLabelContinuous(date, u, count, pressed) {
    if (!pressed || count <= 1) return date;
    const idx = Math.max(1, Math.min(count, Math.round(u) + 1));
    return `${idx}/${count}`;
  }

  function syncGroupThumbFromSelection() {
    const dates = state.dates || [];
    const date = state.activeDate;
    const hits = photoGroup.byDate.get(date);
    if (!hits || !hits.length || !els.groupScaleTrack) return;
    const dateIdx = dates.indexOf(date);
    if (dateIdx < 0) return;
    const n = dates.length;
    let subIdx = hits.findIndex((h) => h.id === state.selectedId);
    if (subIdx < 0) subIdx = 0;
    const u = hits.length === 1 ? 0 : subIdx;
    const subFraction = hits.length === 1 ? 0.5 : (u + 0.5) / hits.length;
    const fraction = (dateIdx + subFraction) / n;
    const rect = els.groupScaleTrack.getBoundingClientRect();
    groupDateScale.setThumbClientX(rect.left + fraction * rect.width, groupThumbLabelContinuous(date, u, hits.length));
  }

  function renderDateScale() {
    mainDateScale.render(state.dates || [], state.activeDate);
  }

  function bindDateScaleDrag() {
    mainDateScale.bind();
    groupDateScale.bind();
    bindGroupScaleFinalize();
  }

  function bindGroupScaleFinalize() {
    const bar = els.groupScaleBar;
    if (!bar || bar.dataset.groupFinalizeBound) return;
    bar.dataset.groupFinalizeBound = '1';
    bar.addEventListener('mouseleave', () => {
      finalizeGroupBlend();
    });
  }

  function floorCalib() {
    const bucket = state.gpsCalibByFloor.get(state.activeFloorId);
    return bucket && bucket.calib ? bucket.calib : null;
  }

  /** Пикселей плана в одном метре: известно только после GPS-калибровки этажа. */
  function planPixelsPerMeter() {
    const calib = floorCalib();
    if (!calib || !(Number(calib.scale) > 0)) return null;
    return Number(calib.scale);
  }

  /** Радиус группы на плане (px): тестовый диаметр или GPS-калибровка. */
  function groupRadiusPx() {
    const d = Number(state.groupTestDiameterPx);
    if (d > 0) return d / 2;
    const pxPerM = planPixelsPerMeter();
    if (pxPerM) return GROUP_RADIUS_M * pxPerM;
    return null;
  }

  /** Снимки в радиусе 2 м от выбранного: массив на дату, ближайшие первыми. */
  function buildPhotoGroup(id) {
    const found = new Map();
    const base = poseOf(id);
    const radiusPx = groupRadiusPx();
    const pxPerM = planPixelsPerMeter();
    if (!base || base.x == null || base.y == null || radiusPx == null) return found;
    const seeds = seedMap();
    for (const p of state.photos) {
      const s = seeds.get(p.id);
      if (!s || s.x == null || s.y == null) continue;
      const d = dist(base, s);
      if (d > radiusPx) continue;
      const distM = pxPerM ? d / pxPerM : (d / radiusPx) * GROUP_RADIUS_M;
      if (!found.has(p.date)) found.set(p.date, []);
      found.get(p.date).push({ id: p.id, distPx: d, distM, number: p.number });
    }
    for (const arr of found.values()) {
      arr.sort((a, b) => a.distPx - b.distPx);
    }
    return found;
  }

  function renderGroupScale(opts = {}) {
    const bar = els.groupScaleBar;
    if (!bar) return;
    const id = state.selectedId;
    const rebuildGroup = opts.rebuildGroup !== false;
    if (rebuildGroup || !photoGroup.anchorId) {
      photoGroup.anchorId = id;
      photoGroup.byDate = id ? buildPhotoGroup(id) : new Map();
    }
    const dates = state.dates || [];
    const hasSeed = id && poseOf(id);
    if (!hasSeed || dates.length < 2 || groupRadiusPx() == null) {
      bar.classList.add('hidden');
      groupDateScale.render([], null);
      return;
    }
    bar.classList.remove('hidden');
    groupDateScale.render(dates, state.activeDate);
    syncGroupThumbFromSelection();
  }

  function pickGroupAt(clientX) {
    const info = groupSegmentInfoFromClientX(clientX);
    if (!info) return;

    const { date, hits, leftId, rightId, blend, u, dominantId } = info;

    groupDateScale.setThumbClientX(clientX, groupThumbLabelContinuous(date, u, hits.length, true));

    if (date !== state.activeDate) {
      setActiveDate(date, { keepSelection: true, silent: true, skipGroupScale: true });
    }

    setPreviewGroupBlend(leftId, rightId, blend);
    state.groupScrub = { date, u, dominantId, clientX };

    const dominantChanged = state.selectedId !== dominantId;
    state.selectedId = dominantId;
    if (dominantChanged) {
      updatePreviewMeta(dominantId, { skipImage: true });
      redrawOverlay();
    }
  }

  function setActiveDate(date, opts = {}) {
    if (!date) return;
    if (date === state.activeDate && !opts.force) {
      if (!opts.skipScaleRender) mainDateScale.setValue(date);
      return;
    }
    if (state.place.active) cancelPlacement();
    state.activeDate = date;
    if (els.dateSelect) els.dateSelect.value = date;
    if (!opts.keepSelection) {
      state.selectedId = null;
      els.previewImg.removeAttribute('src');
      if (els.previewImgAlt) els.previewImgAlt.removeAttribute('src');
      state.previewLayer = 'a';
      clearPreviewMetaBlocks();
    }
    if (opts.skipScaleRender) {
      mainDateScale.setValue(date);
    } else {
      renderDateScale();
    }
    renderList();
    redrawOverlay();
    if (!opts.skipGroupScale) renderGroupScale();
    if (!opts.skipPlanRender) {
      void renderPlanSelect();
      void renderPlanForFloor();
    }
    if (!opts.silent) setStatusHint('');
  }

  function conePath(x, y, yawDeg, len) {
    const rad = (yawDeg * Math.PI) / 180;
    const half = (CONE_HALF_DEG * Math.PI) / 180;
    const x1 = x + Math.cos(rad - half) * len;
    const y1 = y + Math.sin(rad - half) * len;
    const x2 = x + Math.cos(rad + half) * len;
    const y2 = y + Math.sin(rad + half) * len;
    return `M ${x} ${y} L ${x1} ${y1} L ${x2} ${y2} Z`;
  }

  function setPlaceUi() {
    const on = state.place.active;
    els.stage.classList.toggle('placing', on);
    els.btnCancelPlace.classList.toggle('hidden', !on);
    if (!on) {
      setStatusHint('');
      return;
    }
    if (state.place.step === 'await_point') {
      setStatusHint('1. Klick: Kameraposition auf dem Plan.');
    } else if (state.place.step === 'await_yaw') {
      setStatusHint('Maus bewegen — Blickkegel. 2. Klick legt die Richtung fest.');
    }
  }

  function clearCanvas() {
    const ctx = els.planCanvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, els.planCanvas.width || 1, els.planCanvas.height || 1);
    state.pageWidth = 0;
    state.pageHeight = 0;
    state.drawnPlanKey = '';
    els.overlay.innerHTML = '';
  }

  function planDocKey(floorId, planFile) {
    return `${floorId}/${planFile}`;
  }

  function planDrawKey(floorId, planFile, rotation) {
    return `${floorId}|${planFile}|${rotation}`;
  }

  function forgetPlanPdf(floorId, planFile) {
    if (!floorId || !planFile) return;
    const key = planDocKey(floorId, planFile);
    const doc = state.planPdfDocs.get(key);
    if (doc && typeof doc.destroy === 'function') {
      try { doc.destroy(); } catch { /* ignore */ }
    }
    state.planPdfDocs.delete(key);
  }

  async function renderPlanForFloor(opts = {}) {
    const floor = currentFloor();
    const plan = resolveFloorPlan(floor, state.activeDate);
    const hasPlan = !!(plan && plan.planFile);
    els.planEmpty.classList.toggle('hidden', hasPlan);
    if (!hasPlan) {
      clearCanvas();
      els.planCanvas.width = 1;
      els.planCanvas.height = 1;
      redrawOverlay();
      return;
    }
    const rot = ((Number(plan.planRotation) || 0) % 360 + 360) % 360;
    const drawKey = planDrawKey(floor.id, plan.planFile, rot);
    if (!opts.force && state.drawnPlanKey === drawKey && state.pageWidth > 1) {
      redrawOverlay();
      return;
    }
    const token = ++state.planRenderToken;
    const docKey = planDocKey(floor.id, plan.planFile);
    if (opts.bustCache) forgetPlanPdf(floor.id, plan.planFile);
    let pdf = state.planPdfDocs.get(docKey);
    if (!pdf) {
      const bust = opts.bustCache ? `?t=${Date.now()}` : '';
      const url = `/plan/${encodeURIComponent(floor.id)}/${encodeURIComponent(plan.planFile)}${bust}`;
      pdf = await pdfjsLib.getDocument(url).promise;
      if (token !== state.planRenderToken) return;
      state.planPdfDocs.set(docKey, pdf);
    }
    const page = await pdf.getPage(1);
    if (token !== state.planRenderToken) return;
    state.planRotation = rot;
    const viewport = page.getViewport({ scale: 2, rotation: rot });
    state.pageWidth = viewport.width;
    state.pageHeight = viewport.height;
    els.planCanvas.width = viewport.width;
    els.planCanvas.height = viewport.height;
    els.overlay.setAttribute('width', String(viewport.width));
    els.overlay.setAttribute('height', String(viewport.height));
    els.overlay.setAttribute('viewBox', `0 0 ${viewport.width} ${viewport.height}`);
    const ctx = els.planCanvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, viewport.width, viewport.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    if (token !== state.planRenderToken) return;
    state.drawnPlanKey = drawKey;
    fitPlan();
    redrawOverlay();
  }

  async function rotatePlan(deltaDeg) {
    if (SHARE) return;
    const floor = currentFloor();
    const plan = resolveFloorPlan(floor, state.activeDate);
    if (!floor || !plan || !plan.planFile) return;
    const next = ((Number(plan.planRotation) || 0) + deltaDeg + 360) % 360;
    const date = state.activeDate;
    if (date && floor.planByDate && floor.planByDate[date]) {
      floor.planByDate[date].planRotation = next;
    } else if (date && plan.planFile) {
      setPlanEntryForDate(floor, date, plan.planFile, next);
    } else {
      floor.planRotation = next;
    }
    state.planRotation = next;
    try {
      await fetch('/api/floor-rotation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ floorId: floor.id, date: date || null, planRotation: next }),
      });
    } catch { /* ignore network; UI already updated */ }
    await renderPlanForFloor();
    const hintDate = date ? ` · ${date}` : '';
    setStatusHint(`Plandrehung ${floor.id}${hintDate}: ${next}°. Markierung nach Drehung prüfen.`);
  }

  function applyShareUi() {
    if (!SHARE) return;
    document.body.classList.add('share-mode');
    document.title = 'BPS.FotosBuilding';
    // Save / Сброс / Заменить план — только локальный edit. Отмена разметки показывается при размещении.
    ['btnReplacePlan', 'btnSave', 'btnClearSeed', 'btnRotateLeft', 'btnRotateRight', 'btnGpsCalib', 'btnGpsAuto']
      .forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
      });
    document.querySelector('.plan-select-wrap')?.classList.add('hidden');
    document.querySelectorAll('.top-setting').forEach((el) => el.classList.add('hidden'));
    const brand = document.querySelector('.brand');
    if (brand) brand.textContent = 'BPS.FotosBuilding';
    setStatusHint('Markierung: Radar-Symbol am Foto → 1. Klick Punkt, 2. Klick Richtung. Wird sofort gespeichert.');
  }

  function fillDateSelect(keepDate) {
    if (!els.dateSelect) return;
    els.dateSelect.innerHTML = '';
    for (const d of state.dates) {
      const opt = document.createElement('option');
      opt.value = d;
      opt.textContent = d;
      els.dateSelect.appendChild(opt);
    }
    const preferred = keepDate && state.dates.includes(keepDate)
      ? keepDate
      : (state.dates[state.dates.length - 1] || null);
    state.activeDate = preferred;
    if (preferred) els.dateSelect.value = preferred;
  }

  function applyPhotosIndex(index, opts = {}) {
    const keepDate = opts.keepDate !== false ? state.activeDate : null;
    state.photos = index.photos || [];
    state.dates = index.dates && index.dates.length
      ? index.dates.slice()
      : [...new Set(state.photos.map((p) => p.date))].sort();
    if (index.buildStamp && els.buildStamp) els.buildStamp.textContent = index.buildStamp;
    fillDateSelect(keepDate);
    if (opts.ui === false) return;
    renderDateScale();
    renderList();
    redrawOverlay();
    renderGroupScale({ rebuildGroup: true });
    void renderPlanSelect();
    void renderPlanForFloor();
    if (state.selectedId && !photoById(state.selectedId)) {
      state.selectedId = null;
    }
    if (!state.selectedId && filteredPhotos().length) {
      selectPhoto(filteredPhotos()[0].id);
    } else if (state.selectedId) {
      updatePreviewMeta(state.selectedId);
    }
  }

  function projectLabelFromPath(photosRoot) {
    const s = String(photosRoot || '').replace(/\//g, '\\');
    const sliced = s.slice(37, 48);
    const job = s.split('\\').find((part) => /^\d{2,4}_/.test(part));
    return (job || sliced || s).trim();
  }

  function fillProjectSelect(projects, activeRoot) {
    if (!els.projectSelect) return;
    const list = Array.isArray(projects) ? projects : [];
    els.projectSelect.innerHTML = '';
    for (const p of list) {
      const opt = document.createElement('option');
      opt.value = p.photosRoot;
      opt.textContent = p.label || projectLabelFromPath(p.photosRoot);
      opt.title = p.photosRoot;
      els.projectSelect.appendChild(opt);
    }
    if (activeRoot) els.projectSelect.value = activeRoot;
    els.projectSelect.disabled = list.length === 0;
  }

  async function loadProjects() {
    const data = await loadJson('/api/projects', { projects: [], activePhotosRoot: '' });
    fillProjectSelect(data.projects || [], data.activePhotosRoot || '');
    return data;
  }

  function setProjectControlsDisabled(disabled) {
    if (els.projectSelect) els.projectSelect.disabled = disabled;
    if (els.btnAddProject) els.btnAddProject.disabled = disabled;
  }

  async function loadSwitchedProject(summary, photosRoot) {
    const index = await loadJson(`/data/photos.json?t=${Date.now()}`, { photos: [], dates: [] });
    state.selectedId = null;
    applyPhotosIndex(index, { keepDate: false });
    fillProjectSelect(summary.projects || [], summary.photosRoot || photosRoot);
    const label = summary.label || projectLabelFromPath(summary.photosRoot || photosRoot);
    const n = summary.count != null ? summary.count : state.photos.length;
    setStatusHint(`Projekt ${label}: ${n} Fotos`);
  }

  async function postProjectChange(url, photosRoot, pendingHint, failHint) {
    if (!photosRoot) return;
    setProjectControlsDisabled(true);
    setStatusHint(pendingHint);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photosRoot }),
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || ('HTTP ' + res.status));
      }
      const summary = await res.json();
      await loadSwitchedProject(summary, photosRoot);
    } catch (err) {
      console.error(err);
      setStatusHint(failHint + (err.message || err));
      alert(failHint + (err.message || err));
      await loadProjects();
    } finally {
      setProjectControlsDisabled(false);
    }
  }

  async function selectProject(photosRoot) {
    await postProjectChange(
      '/api/project-select',
      photosRoot,
      'Projekt wird geladen…',
      'Projektwechsel fehlgeschlagen: '
    );
  }

  async function addProjectFromPrompt() {
    if (SHARE) return;
    const entered = window.prompt(
      'Pfad zum Fotoordner (Fotos building) oder zum Projektordner, z.B.\n'
      + 'C:\\BPS\\OneDrive - BPS International GmbH\\100_BPS.OSZ\\04_DOC\\00_KOR\\Fotos building',
      ''
    );
    if (entered == null) return;
    const photosRoot = entered.trim().replace(/^["']|["']$/g, '');
    if (!photosRoot) return;
    await postProjectChange(
      '/api/project-add',
      photosRoot,
      'Projekt wird hinzugefügt…',
      'Projekt konnte nicht hinzugefügt werden:\n'
    );
  }

  async function refreshPhotosFromFolder() {
    const btn = els.btnRefreshPhotos;
    if (btn) btn.disabled = true;
    setStatusHint('Gemeinsamen Fotoordner wird gescannt…');
    try {
      const res = await fetch('/api/refresh-photos', { method: 'POST' });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || ('HTTP ' + res.status));
      }
      const summary = await res.json();
      const index = await loadJson(`/data/photos.json?t=${Date.now()}`, { photos: [], dates: [] });
      applyPhotosIndex(index);
      const n = summary.count != null ? summary.count : (index.count || state.photos.length);
      const datesTxt = Array.isArray(summary.dates) ? summary.dates.join(', ') : state.dates.join(', ');
      setStatusHint(`Fotos aktualisiert: ${n} Dateien · Daten: ${datesTxt || '—'}`);
    } catch (err) {
      console.error(err);
      setStatusHint('Aktualisierung fehlgeschlagen: ' + (err.message || err));
      alert('Fotos konnten nicht aktualisiert werden:\n' + (err.message || err));
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function startPlacement(id) {
    if (!resolveFloorPlan(currentFloor(), state.activeDate)) {
      setStatusHint('Zuerst den PDF-Plan für dieses Geschoss und Datum wählen.');
      return;
    }
    selectPhoto(id, { skipList: false });
    state.place = {
      active: true,
      id,
      step: 'await_point',
      x: null,
      y: null,
      yawDeg: null,
      coneLen: CONE_LEN,
    };
    seedMap().delete(id);
    setPlaceUi();
    renderList();
    redrawOverlay();
  }

  function cancelPlacement() {
    state.place = {
      active: false,
      id: null,
      step: 'idle',
      x: null,
      y: null,
      yawDeg: null,
      coneLen: CONE_LEN,
    };
    setPlaceUi();
    renderList();
    redrawOverlay();
    if (state.selectedId) updatePreviewMeta(state.selectedId);
  }

  async function finishPlacement() {
    const pl = state.place;
    if (!pl.id || pl.x == null || pl.y == null || pl.yawDeg == null) return;
    const photo = photoById(pl.id);
    seedMap().set(pl.id, {
      id: pl.id,
      file: photo?.file,
      floorId: state.activeFloorId,
      x: pl.x,
      y: pl.y,
      yawDeg: pl.yawDeg,
      coneLen: CONE_LEN,
      source: 'manual',
      note: '',
    });
    const doneId = pl.id;
    cancelPlacement();
    selectPhoto(doneId);

    if (state.gpsCalibMode) {
      await onCalibPointPlaced(doneId);
      return;
    }

    const ok = await saveSeeds({ silent: true });
    if (!ok) {
      const num = photoById(doneId)?.number ?? '';
      alert(`Punkt #${num} liegt auf dem Plan, Speichern auf dem Server ist fehlgeschlagen.`);
    }
  }

  function appendMarker(ns, parent, pose, opts) {
    const { id, number, isPreview, status, isSelected } = opts;
    const r = isSelected && !isPreview ? DOT_R + 2 : DOT_R;

    if (pose.yawDeg != null) {
      const cone = document.createElementNS(ns, 'path');
      cone.setAttribute('d', conePath(pose.x, pose.y, Number(pose.yawDeg), CONE_LEN));
      let coneCls = 'cam-cone';
      if (isPreview) coneCls += ' preview';
      if (isSelected) coneCls += ' selected';
      cone.setAttribute('class', coneCls);
      parent.appendChild(cone);
    }

    const dot = document.createElementNS(ns, 'circle');
    dot.setAttribute('cx', pose.x);
    dot.setAttribute('cy', pose.y);
    dot.setAttribute('r', String(r));
    let cls = 'cam-dot';
    if (isPreview) cls += ' preview';
    else if (isSelected) cls += ' selected';
    else if (status === 'gps') cls += ' gps';
    else if (status === 'auto') cls += ' auto';
    dot.setAttribute('class', cls);
    parent.appendChild(dot);

    const label = document.createElementNS(ns, 'text');
    label.setAttribute('x', pose.x + r + 5);
    label.setAttribute('y', pose.y - r + 2);
    label.setAttribute('class', 'cam-label' + (isSelected ? ' selected' : ''));
    label.textContent = String(number);
    parent.appendChild(label);

    if (!isPreview) {
      parent.classList.add('hit');
      if (isSelected) parent.classList.add('selected');
      parent.addEventListener('click', (ev) => {
        if (state.place.active) return;
        ev.stopPropagation();
        selectPhoto(id, { fromMap: true });
      });
    }
  }

  function redrawOverlay() {
    const ns = 'http://www.w3.org/2000/svg';
    while (els.overlay.firstChild) els.overlay.removeChild(els.overlay.firstChild);
    const list = filteredPhotos();
    const selected = [];

    for (const p of list) {
      if (state.place.active && state.place.id === p.id) continue;
      const pose = poseOf(p.id);
      if (!pose || pose.x == null || pose.y == null) continue;
      const isSelected = p.id === state.selectedId;
      const g = document.createElementNS(ns, 'g');
      g.setAttribute('data-id', p.id);
      appendMarker(ns, g, {
        x: pose.x,
        y: pose.y,
        yawDeg: pose.yawDeg,
      }, {
        id: p.id,
        number: p.number,
        isPreview: false,
        status: pose.status,
        isSelected,
      });
      if (isSelected) selected.push(g);
      else els.overlay.appendChild(g);
    }
    for (const g of selected) els.overlay.appendChild(g);

    if (state.selectedId) {
      const selPose = poseOf(state.selectedId);
      const r = groupRadiusPx();
      if (selPose && selPose.x != null && selPose.y != null && r != null) {
        const ring = document.createElementNS(ns, 'circle');
        ring.setAttribute('cx', selPose.x);
        ring.setAttribute('cy', selPose.y);
        ring.setAttribute('r', String(r));
        ring.setAttribute('class', 'group-radius-hint');
        els.overlay.appendChild(ring);
      }
    }

    if (state.place.active && state.place.x != null && state.place.y != null) {
      const p = photoById(state.place.id);
      const g = document.createElementNS(ns, 'g');
      appendMarker(ns, g, {
        x: state.place.x,
        y: state.place.y,
        yawDeg: state.place.step === 'await_yaw' ? state.place.yawDeg : null,
      }, {
        id: state.place.id,
        number: p?.number ?? '?',
        isPreview: true,
        status: 'seed',
        isSelected: false,
      });
      els.overlay.appendChild(g);
    }
  }

  function renderFloorTabs() {
    els.floorTabs.innerHTML = '';
    for (const f of sortedFloors()) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'floor-tab'
        + (f.id === state.activeFloorId ? ' active' : '')
        + (!floorHasAnyPlan(f) ? ' no-plan' : '');
      btn.textContent = f.label || f.id;
      const plan = f.id === state.activeFloorId ? resolveFloorPlan(f, state.activeDate) : null;
      btn.title = plan
        ? `${f.id} · ${state.activeDate || ''}: ${plan.planFile}`
        : (floorHasAnyPlan(f) ? `${f.id}: Plan(e) gespeichert` : `${f.id}: kein PDF`);
      btn.addEventListener('click', () => switchFloor(f.id));
      els.floorTabs.appendChild(btn);
    }
  }

  async function renderPlanSelect() {
    if (!els.planSelect || SHARE) return;
    const floor = currentFloor();
    const floorId = state.activeFloorId;
    const date = state.activeDate;
    let files = [];
    try {
      const data = await loadJson(`/api/plans?floorId=${encodeURIComponent(floorId)}`, { files: [] });
      files = Array.isArray(data.files) ? data.files.slice().sort((a, b) => a.localeCompare(b)) : [];
    } catch { /* offline/share */ }
    const currentPlan = resolveFloorPlan(floor, date);
    const current = currentPlan?.planFile || '';
    if (current && !files.includes(current)) files.unshift(current);
    els.planSelect.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = date
      ? (files.length ? `— Plan für ${date} —` : `— kein PDF (${date}) —`)
      : (files.length ? '— Datum wählen —' : '— kein PDF —');
    els.planSelect.appendChild(placeholder);
    for (const name of files) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      els.planSelect.appendChild(opt);
    }
    els.planSelect.value = current && files.includes(current) ? current : '';
    els.planSelect.disabled = !date || files.length === 0;
  }

  async function selectPlanFile(planFile) {
    if (SHARE || !planFile) return;
    if (!state.activeDate) {
      setStatusHint('Zuerst ein Datum wählen, dann den PDF-Plan.');
      await renderPlanSelect();
      return;
    }
    const floorId = state.activeFloorId;
    const floor = currentFloor();
    if (!floor) return;
    const currentPlan = resolveFloorPlan(floor, state.activeDate);
    if (currentPlan && currentPlan.planFile === planFile) {
      await renderPlanForFloor();
      return;
    }
    try {
      const res = await fetch('/api/plan-select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          floorId,
          date: state.activeDate,
          planFile,
        }),
      });
      if (!res.ok) {
        const t = await res.text();
        alert('Plan konnte nicht gewählt werden: ' + t);
        await renderPlanSelect();
        return;
      }
      const data = await res.json();
      if (data.date) {
        setPlanEntryForDate(floor, data.date, data.planFile, data.planRotation);
      } else {
        floor.planFile = data.planFile;
        floor.planRotation = Number(data.planRotation) || 0;
      }
    } catch (err) {
      alert('Plan konnte nicht gewählt werden: ' + err.message);
      await renderPlanSelect();
      return;
    }
    renderFloorTabs();
    await renderPlanForFloor();
    setStatusHint(`Plan ${floorId} · ${state.activeDate}: ${planFile}`);
  }

  async function switchFloor(floorId) {
    if (floorId === state.activeFloorId) return;
    if (state.place.active) cancelPlacement();
    state.activeFloorId = floorId;
    renderFloorTabs();
    await renderPlanSelect();
    await renderPlanForFloor();
    renderList();
    if (state.selectedId) updatePreviewMeta(state.selectedId);
    renderGroupScale();
  }

  function formatPhotoWhen(p) {
    if (p.dateTakenDisplay) return p.dateTakenDisplay;
    if (p.exif && p.exif.dateTakenDisplay) return p.exif.dateTakenDisplay;
    const raw = p.dateTaken || p.modifiedAt || p.timestamp || '';
    if (!raw) return p.time || '';
    const m = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2})?/);
    if (m) return `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}`;
    return p.time || raw;
  }

  function renderList() {
    const list = filteredPhotos();
    els.photoCount.textContent = String(list.length);
    let placed = 0;
    els.photoList.innerHTML = '';
    for (const p of list) {
      const pose = poseOf(p.id);
      const isPlaced = !!(pose && pose.yawDeg != null);
      if (isPlaced) placed++;
      const item = document.createElement('div');
      const isPlacing = state.place.active && state.place.id === p.id;
      item.className = 'photo-item'
        + (p.id === state.selectedId ? ' active' : '')
        + (isPlacing ? ' placing-row' : '');

      const img = document.createElement('img');
      img.src = `/${p.thumb}`;
      img.alt = '';
      img.loading = 'lazy';

      const meta = document.createElement('div');
      meta.className = 'meta';
      const status = isPlaced ? pose.status : 'none';
      const statusText = statusLabel(status);
      const res = (p.width && p.height) ? `${p.width}×${p.height}` : '';
      const kb = (p.sizeKb != null)
        ? p.sizeKb
        : (p.bytes != null ? Math.round(Number(p.bytes) / 1024) : null);
      const sizeTxt = kb != null ? `${kb} KB` : '';
      const headBits = [`#${p.number}`, res, sizeTxt].filter(Boolean).join(' · ');
      const when = formatPhotoWhen(p);
      const gpsMark = (p.exif && p.exif.hasGps) ? ' · GPS' : '';

      const head = document.createElement('strong');
      head.textContent = headBits;

      const bottom = document.createElement('div');
      bottom.className = 'meta-bottom';

      const left = document.createElement('div');
      left.className = 'meta-left';
      left.innerHTML = `
        <span class="badge ${status}">${statusText}</span>
        <span class="muted meta-when">${when}${gpsMark}</span>`;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-radar'
        + (isPlaced ? ' placed' : '')
        + (isPlaced && status === 'gps' ? ' gps' : '')
        + (isPlacing ? ' active-place' : '');
      btn.title = isPlacing ? 'Markierung abbrechen' : (isPlaced ? 'Neu markieren' : 'Markieren');
      btn.innerHTML = RADAR_SVG;
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (state.place.active && state.place.id === p.id) {
          cancelPlacement();
          return;
        }
        startPlacement(p.id);
      });

      bottom.appendChild(left);
      bottom.appendChild(btn);
      meta.appendChild(head);
      meta.appendChild(bottom);

      item.appendChild(img);
      item.appendChild(meta);
      item.addEventListener('click', () => {
        if (state.place.active && state.place.id !== p.id) return;
        selectPhoto(p.id);
        if (isMobileLayout()) openLightboxFor(p.id);
      });
      els.photoList.appendChild(item);
    }
    els.placedCount.textContent = `· markiert ${placed}`;
  }

  function dlRows(rows) {
    return rows
      .map(([k, v]) => `<div class="meta-line"><span class="meta-k">${k}:</span> <span class="meta-v">${v}</span></div>`)
      .join('');
  }

  function activePreviewImg() {
    return state.previewLayer === 'b' && els.previewImgAlt ? els.previewImgAlt : els.previewImg;
  }

  function applyPreviewFadeMs(ms) {
    const v = Math.max(0, Number(ms));
    state.previewFadeMs = Number.isFinite(v) ? v : DEFAULT_PREVIEW_FADE_MS;
    const cssVal = `${state.previewFadeMs}ms`;
    document.documentElement.style.setProperty('--preview-fade-ms', cssVal);
  }

  function photoPreviewUrl(id) {
    const p = photoById(id);
    return p ? `/${p.ai || p.thumb}` : '';
  }

  function clearPreviewGroupBlend() {
    state.groupBlendActive = false;
    if (els.previewImg) els.previewImg.classList.remove('preview-blend-scrub');
    if (els.previewImgAlt) els.previewImgAlt.classList.remove('preview-blend-scrub');
  }

  function setPreviewGroupBlend(leftId, rightId, blend) {
    const imgA = els.previewImg;
    const imgB = els.previewImgAlt;
    if (!imgA || !imgB) return;

    const leftUrl = photoPreviewUrl(leftId);
    const rightUrl = photoPreviewUrl(rightId);
    if (!leftUrl) return;

    state.groupBlendActive = true;
    state.previewFadeToken += 1;

    imgA.classList.add('preview-blend-scrub');
    imgB.classList.add('preview-blend-scrub');

    const b = Math.max(0, Math.min(1, blend));
    const single = leftId === rightId;

    if (single || b <= 0.001) {
      if (imgA.getAttribute('src') !== leftUrl) imgA.src = leftUrl;
      imgA.style.opacity = '1';
      imgB.style.opacity = '0';
      imgA.classList.add('is-front');
      imgB.classList.remove('is-front');
      state.previewLayer = 'a';
      return;
    }

    if (b >= 0.999) {
      if (imgA.getAttribute('src') !== rightUrl) imgA.src = rightUrl;
      imgA.style.opacity = '1';
      imgB.style.opacity = '0';
      imgA.classList.add('is-front');
      imgB.classList.remove('is-front');
      state.previewLayer = 'a';
      return;
    }

    if (imgA.getAttribute('src') !== leftUrl) imgA.src = leftUrl;
    if (imgB.getAttribute('src') !== rightUrl) imgB.src = rightUrl;
    imgA.style.opacity = String(1 - b);
    imgB.style.opacity = String(b);
    imgA.classList.add('is-front');
    imgB.classList.add('is-front');
  }

  function snapPreviewToPhoto(id) {
    const imgA = els.previewImg;
    const imgB = els.previewImgAlt;
    if (!imgA || !id) return;
    const url = photoPreviewUrl(id);
    if (!url) return;

    state.previewFadeToken += 1;
    clearPreviewGroupBlend();
    imgA.src = url;
    imgA.style.opacity = '1';
    imgA.classList.add('is-front');
    if (imgB) {
      imgB.style.opacity = '0';
      imgB.classList.remove('is-front');
      imgB.removeAttribute('src');
    }
    state.previewLayer = 'a';
  }

  function finalizeGroupBlend() {
    if (!state.groupBlendActive && !state.groupScrub) return;

    const snapId = state.groupScrub?.dominantId || state.selectedId;
    state.groupScrub = null;
    if (!snapId) {
      clearPreviewGroupBlend();
      return;
    }

    state.selectedId = snapId;
    snapPreviewToPhoto(snapId);
    updatePreviewMeta(snapId, { skipImage: true });
    syncGroupThumbFromSelection();
    redrawOverlay();
  }

  function setPreviewImageSrc(url, fade) {
    const imgA = els.previewImg;
    const imgB = els.previewImgAlt;
    if (!imgA) return;

    clearPreviewGroupBlend();

    const showInstant = (targetUrl) => {
      state.previewFadeToken += 1;
      resetPreviewZoom();
      imgA.src = targetUrl;
      imgA.style.opacity = '1';
      imgA.classList.add('is-front');
      if (imgB) {
        imgB.style.opacity = '0';
        imgB.classList.remove('is-front');
        imgB.removeAttribute('src');
      }
      state.previewLayer = 'a';
    };

    const cur = activePreviewImg();
    const curSrc = cur && cur.getAttribute('src');
    const useFade = fade && state.previewFadeMs > 0 && curSrc && imgB;
    if (!useFade || curSrc === url) {
      if (curSrc !== url) showInstant(url);
      return;
    }

    state.previewFadeToken += 1;
    const token = state.previewFadeToken;
    const from = activePreviewImg();
    const to = state.previewLayer === 'a' ? imgB : imgA;

    const preload = new Image();
    preload.onload = () => {
      if (token !== state.previewFadeToken) return;
      resetPreviewZoom();
      to.src = url;
      to.style.opacity = '0';
      to.classList.add('is-front');
      from.classList.remove('is-front');
      void to.offsetWidth;
      from.style.opacity = '0';
      to.style.opacity = '1';
      state.previewLayer = state.previewLayer === 'a' ? 'b' : 'a';
    };
    preload.onerror = () => {
      if (token !== state.previewFadeToken) return;
      showInstant(url);
    };
    preload.src = url;
  }

  function bindTopSettings() {
    const savedDiam = Number(localStorage.getItem(LS_GROUP_DIAM));
    if (savedDiam >= 20) state.groupTestDiameterPx = savedDiam;
    if (els.groupDiameterPx) {
      els.groupDiameterPx.value = String(state.groupTestDiameterPx);
      els.groupDiameterPx.addEventListener('input', () => {
        state.groupTestDiameterPx = Math.max(20, Number(els.groupDiameterPx.value) || 120);
        localStorage.setItem(LS_GROUP_DIAM, String(state.groupTestDiameterPx));
        renderGroupScale();
        redrawOverlay();
      });
    }
    const savedFade = Number(localStorage.getItem(LS_PREVIEW_FADE));
    const fadeMs = Number.isFinite(savedFade) && savedFade >= 0 ? savedFade : DEFAULT_PREVIEW_FADE_MS;
    applyPreviewFadeMs(fadeMs);
    if (els.previewFadeMs) {
      els.previewFadeMs.value = String(state.previewFadeMs);
      els.previewFadeMs.addEventListener('input', () => {
        applyPreviewFadeMs(Number(els.previewFadeMs.value));
        localStorage.setItem(LS_PREVIEW_FADE, String(state.previewFadeMs));
      });
      els.previewFadeMs.addEventListener('change', () => {
        applyPreviewFadeMs(Number(els.previewFadeMs.value));
        localStorage.setItem(LS_PREVIEW_FADE, String(state.previewFadeMs));
      });
    }
  }

  function updatePreviewMeta(id, opts = {}) {
    const p = photoById(id);
    if (!p) return;
    if (!opts.skipImage) {
      setPreviewImageSrc(`/${p.ai || p.thumb}`, !!opts.fadePreview);
    }
    els.openOriginal.href = `/${p.originalUrl}`;

    const ex = p.exif || {};
    const camRows = [];
    if (ex.cameraMake) camRows.push(['Kamera', ex.cameraMake]);
    if (ex.cameraModel) camRows.push(['Modell', ex.cameraModel]);
    if (ex.aperture) camRows.push(['Blende', ex.aperture]);
    if (ex.shutter) camRows.push(['Verschlusszeit', ex.shutter]);
    if (ex.iso) camRows.push(['ISO', ex.iso]);
    if (ex.digitalZoom != null) camRows.push(['Digitalzoom', String(ex.digitalZoom)]);
    if (els.exifCam) els.exifCam.innerHTML = dlRows(camRows);

    const gpsRows = [];
    if (ex.hasGps) {
      gpsRows.push(['Breitengrad', ex.gpsLatDms || String(ex.gpsLat)]);
      gpsRows.push(['Längengrad', ex.gpsLonDms || String(ex.gpsLon)]);
      if (ex.gpsAlt != null) gpsRows.push(['Höhe', String(ex.gpsAlt)]);
    }
    if (els.exifGps) els.exifGps.innerHTML = dlRows(gpsRows);

    const pose = poseOf(id);
    let seedRows;
    if (pose && pose.yawDeg != null) {
      seedRows = [
        ['Geschoss', state.activeFloorId],
        ['Status', statusLabel(pose.status)],
        ['X', Number(pose.x).toFixed(1)],
        ['Y', Number(pose.y).toFixed(1)],
        ['Yaw', `${Number(pose.yawDeg).toFixed(1)}°`],
      ];
    } else if (state.place.active && state.place.id === id && state.place.x != null) {
      seedRows = [
        ['Geschoss', state.activeFloorId],
        ['Status', 'Markierung…'],
        ['X', Number(state.place.x).toFixed(1)],
        ['Y', Number(state.place.y).toFixed(1)],
        ['Yaw', state.place.yawDeg != null ? `${Number(state.place.yawDeg).toFixed(1)}°` : '—'],
      ];
    } else {
      seedRows = [
        ['Geschoss', state.activeFloorId],
        ['Status', 'nicht markiert'],
      ];
    }
    els.seedInfo.innerHTML = dlRows(seedRows);
  }

  function clearPreviewMetaBlocks() {
    if (els.exifCam) els.exifCam.innerHTML = '';
    if (els.exifGps) els.exifGps.innerHTML = '';
    if (els.seedInfo) els.seedInfo.innerHTML = '';
  }

  function selectPhoto(id, opts = {}) {
    state.groupScrub = null;
    state.selectedId = id;
    const p = photoById(id);
    if (!p) return;
    if (p.date !== state.activeDate) {
      state.activeDate = p.date;
      els.dateSelect.value = p.date;
      renderDateScale();
    }
    updatePreviewMeta(id, opts);
    if (opts.skipGroupScale) {
      redrawOverlay();
    } else {
      renderGroupScale({ rebuildGroup: true });
      redrawOverlay();
    }
    if (!opts.skipList) renderList();
    if (opts.fromMap && isMobileLayout()) openLightboxFor(id);
  }

  function photoGps(p) {
    if (!p || !p.exif || !p.exif.hasGps) return null;
    if (p.exif.gpsLat == null || p.exif.gpsLon == null) return null;
    return { lat: Number(p.exif.gpsLat), lon: Number(p.exif.gpsLon) };
  }

  function gpsToLocalMeters(lat, lon, lat0, lon0) {
    const R = 6378137;
    const x = ((lon - lon0) * Math.PI / 180) * R * Math.cos((lat0 * Math.PI) / 180);
    const y = ((lat - lat0) * Math.PI / 180) * R;
    return { x, y };
  }

  /** Подобие с якорем P1: scale+theta по векторам точек 2..N относительно GPS/плана. */
  function fitSimilarityFixedOrigin(points) {
    // points: [{gx,gy,px,py}] relative to anchor (anchor itself not included)
    let numRe = 0;
    let numIm = 0;
    let den = 0;
    for (const p of points) {
      den += p.gx * p.gx + p.gy * p.gy;
      numRe += p.gx * p.px + p.gy * p.py;
      numIm += p.gx * p.py - p.gy * p.px;
    }
    if (den < 1e-12) return null;
    const scale = Math.hypot(numRe, numIm) / den;
    const theta = Math.atan2(numIm, numRe);
    return { scale, theta };
  }

  function applyGpsTransform(lat, lon, calib) {
    const local = gpsToLocalMeters(lat, lon, calib.lat0, calib.lon0);
    const c = Math.cos(calib.theta);
    const s = Math.sin(calib.theta);
    const rx = calib.scale * (c * local.x - s * local.y);
    const ry = calib.scale * (s * local.x + c * local.y);
    return {
      x: calib.x0 + rx,
      y: calib.y0 + ry,
    };
  }

  function buildCalibFromPoints(points) {
    // points[0] = anchor
    if (!points || points.length < 3) return null;
    const a = points[0];
    const rel = [];
    for (let i = 1; i < points.length; i++) {
      const p = points[i];
      const g = gpsToLocalMeters(p.lat, p.lon, a.lat, a.lon);
      rel.push({
        gx: g.x,
        gy: g.y,
        px: p.x - a.x,
        py: p.y - a.y,
      });
    }
    const fit = fitSimilarityFixedOrigin(rel);
    if (!fit) return null;
    return {
      floorId: state.activeFloorId,
      anchorId: a.id,
      ids: points.map((p) => p.id),
      lat0: a.lat,
      lon0: a.lon,
      x0: a.x,
      y0: a.y,
      scale: fit.scale,
      theta: fit.theta,
      points: points.map((p) => ({ id: p.id, x: p.x, y: p.y, lat: p.lat, lon: p.lon })),
    };
  }

  function startGpsCalib() {
    if (!resolveFloorPlan(currentFloor(), state.activeDate)) {
      setStatusHint('Zuerst wird der PDF-Plan des Geschosses für dieses Datum benötigt.');
      return;
    }
    state.gpsCalibMode = true;
    state.gpsCalibByFloor.set(state.activeFloorId, { draft: [], calib: null });
    setStatusHint('GPS-Kalibrierung 1/3: GPS-Foto wählen und per Radar markieren (Punkt + Richtung). 1. Punkt ist der Anker.');
  }

  async function onCalibPointPlaced(id) {
    const p = photoById(id);
    const gps = photoGps(p);
    const pose = seedMap().get(id);
    const bucket = state.gpsCalibByFloor.get(state.activeFloorId) || { draft: [], calib: null };
    if (!gps) {
      seedMap().delete(id);
      renderList();
      redrawOverlay();
      setStatusHint('Dieses Foto hat kein GPS in den EXIF-Daten. Bitte ein anderes wählen.');
      await saveSeeds({ silent: true });
      return;
    }
    // убрать дубликат id из draft
    bucket.draft = (bucket.draft || []).filter((d) => d.id !== id);
    bucket.draft.push({
      id,
      x: pose.x,
      y: pose.y,
      lat: gps.lat,
      lon: gps.lon,
    });
    state.gpsCalibByFloor.set(state.activeFloorId, bucket);

    if (bucket.draft.length < 3) {
      await saveSeeds({ silent: true });
      setStatusHint(`GPS-Kalibrierung ${bucket.draft.length}/3: nächstes GPS-Foto markieren.`);
      return;
    }

    // 3 точки: посчитать transform, поправить 2 и 3
    const calib = buildCalibFromPoints(bucket.draft);
    if (!calib) {
      setStatusHint('GPS-Zuordnung konnte nicht berechnet werden (Punkte zu nah?).');
      state.gpsCalibMode = false;
      return;
    }

    for (let i = 1; i < bucket.draft.length; i++) {
      const d = bucket.draft[i];
      const pt = applyGpsTransform(d.lat, d.lon, calib);
      const seed = seedMap().get(d.id);
      if (seed) {
        seed.x = pt.x;
        seed.y = pt.y;
        seed.source = 'manual';
        seed.note = 'gps-calib';
        seedMap().set(d.id, seed);
      }
      calib.points[i].x = pt.x;
      calib.points[i].y = pt.y;
    }
    bucket.calib = calib;
    bucket.draft = calib.points.map((p) => ({ ...p }));
    state.gpsCalibByFloor.set(state.activeFloorId, bucket);
    state.gpsCalibMode = false;
    renderList();
    redrawOverlay();
    const ok = await saveSeeds({ silent: true });
    setStatusHint(ok
      ? 'Kalibrierung fertig: 1. Punkt ist der Anker, 2 und 3 sind per GPS ausgerichtet. Jetzt „Automatisch platzieren“ möglich.'
      : 'Kalibrierung berechnet, Speichern fehlgeschlagen.');
  }

  async function autoPlaceByGps() {
    const bucket = state.gpsCalibByFloor.get(state.activeFloorId);
    const calib = bucket && bucket.calib;
    if (!calib) {
      setStatusHint('Zuerst „Lage kalibrieren“ ausführen (3 GPS-Fotos).');
      return;
    }

    // ещё раз поправить 2 и 3
    for (let i = 1; i < (calib.points || []).length; i++) {
      const d = calib.points[i];
      const pt = applyGpsTransform(d.lat, d.lon, calib);
      d.x = pt.x;
      d.y = pt.y;
      const seed = seedMap().get(d.id) || {
        id: d.id,
        file: photoById(d.id)?.file,
        floorId: state.activeFloorId,
        yawDeg: 0,
        coneLen: CONE_LEN,
        note: 'gps-calib',
      };
      seed.x = pt.x;
      seed.y = pt.y;
      seed.source = 'manual';
      seed.yawDeg = seed.yawDeg != null ? seed.yawDeg : 0;
      seed.coneLen = CONE_LEN;
      seedMap().set(d.id, seed);
    }

    const calibIds = new Set((calib.ids || []).map(String));
    let placed = 0;
    let skipped = 0;
    for (const p of filteredPhotos()) {
      if (calibIds.has(String(p.id))) continue;
      const gps = photoGps(p);
      if (!gps) { skipped++; continue; }
      const pt = applyGpsTransform(gps.lat, gps.lon, calib);
      seedMap().set(p.id, {
        id: p.id,
        file: p.file,
        floorId: state.activeFloorId,
        x: pt.x,
        y: pt.y,
        yawDeg: 0,
        coneLen: CONE_LEN,
        source: 'gps',
        note: 'auto-gps',
      });
      placed++;
    }

    renderList();
    redrawOverlay();
    if (state.selectedId) updatePreviewMeta(state.selectedId);
    renderGroupScale();
    const ok = await saveSeeds({ silent: true });
    setStatusHint(ok
      ? `GPS: ${placed} platziert, ohne GPS übersprungen ${skipped}. Status neuer Punkte: gps.`
      : `${placed} im Speicher platziert, Speichern auf dem Server fehlgeschlagen.`);
  }

  function collectSeedsPayload() {
    const byFloor = {};
    for (const f of state.floors) {
      const map = state.seedsByFloor.get(f.id) || new Map();
      byFloor[f.id] = Array.from(map.values()).map((s) => ({
        id: s.id,
        file: s.file,
        floorId: f.id,
        x: s.x,
        y: s.y,
        yawDeg: s.yawDeg,
        coneLen: CONE_LEN,
        source: s.source || 'manual',
        note: s.note || '',
      }));
    }
    const gpsCalib = {};
    for (const [floorId, bucket] of state.gpsCalibByFloor.entries()) {
      if (bucket && bucket.calib) gpsCalib[floorId] = bucket.calib;
    }
    return { byFloor, gpsCalib };
  }

  async function saveSeeds(opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const token = window.BPS_WRITE_TOKEN || localStorage.getItem('bps.fotosbuilding.writeToken') || '';
    if (token) headers['X-BPS-Token'] = token;
    const payload = collectSeedsPayload();
    const res = await fetch('/api/seeds', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      if (!opts.silent) alert('seeds.json konnte nicht gespeichert werden');
      return false;
    }
    if (!opts.silent) {
      const n = Object.values(payload.byFloor || {}).reduce((a, arr) => a + arr.length, 0);
      setStatusHint(`Seeds gespeichert: ${n} (nach Geschoss).`);
    }
    return true;
  }

  function clearSelectedSeed() {
    if (!state.selectedId) return;
    if (state.place.active && state.place.id === state.selectedId) cancelPlacement();
    seedMap().delete(state.selectedId);
    selectPhoto(state.selectedId);
  }

  function loadSeedsDoc(doc) {
    state.seedsByFloor.clear();
    for (const f of state.floors) state.seedsByFloor.set(f.id, new Map());

    if (doc && doc.byFloor && typeof doc.byFloor === 'object') {
      for (const [floorId, arr] of Object.entries(doc.byFloor)) {
        if (!state.seedsByFloor.has(floorId)) state.seedsByFloor.set(floorId, new Map());
        const map = state.seedsByFloor.get(floorId);
        for (const s of arr || []) {
          if (s && s.id) map.set(s.id, s);
        }
      }
      state.gpsCalibByFloor.clear();
      if (doc.gpsCalib && typeof doc.gpsCalib === 'object') {
        for (const [floorId, calib] of Object.entries(doc.gpsCalib)) {
          if (calib) state.gpsCalibByFloor.set(floorId, { draft: [], calib });
        }
      }
      return;
    }

    // Миграция старого формата { seeds: [...] } → активный этаж
    const legacy = doc && Array.isArray(doc.seeds) ? doc.seeds : [];
    const target = state.activeFloorId || 'UG';
    if (!state.seedsByFloor.has(target)) state.seedsByFloor.set(target, new Map());
    const map = state.seedsByFloor.get(target);
    for (const s of legacy) {
      if (s && s.id) map.set(s.id, { ...s, floorId: target });
    }
  }

  async function replacePlanFile(file) {
    if (SHARE) return;
    if (!file) return;
    if (!state.activeDate) {
      setStatusHint('Zuerst ein Datum wählen, dann PDF hochladen.');
      return;
    }
    const floorId = state.activeFloorId;
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    const base64 = btoa(binary);
    const res = await fetch('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        floorId,
        date: state.activeDate,
        fileName: file.name,
        contentBase64: base64,
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      alert('Plan konnte nicht hochgeladen werden: ' + t);
      return;
    }
    const data = await res.json();
    const floor = state.floors.find((f) => f.id === floorId);
    if (floor) {
      if (data.date) {
        setPlanEntryForDate(floor, data.date, data.planFile, data.planRotation);
      } else {
        floor.planFile = data.planFile;
        floor.planRotation = Number(data.planRotation) || 0;
      }
    }
    renderFloorTabs();
    await renderPlanSelect();
    forgetPlanPdf(floorId, data.planFile);
    await renderPlanForFloor({ force: true, bustCache: true });
    setStatusHint(`Plan ${floorId} · ${state.activeDate}: ${data.planFile}. Bei falscher Ausrichtung ⟲ ⟳ nutzen.`);
  }

  // --- events ---
  els.stage.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const before = clientToPlan(ev.clientX, ev.clientY);
    const factor = ev.deltaY > 0 ? 0.9 : 1.1;
    state.scale = Math.min(8, Math.max(0.05, state.scale * factor));
    const rect = els.stage.getBoundingClientRect();
    state.panX = ev.clientX - rect.left - before.x * state.scale;
    state.panY = ev.clientY - rect.top - before.y * state.scale;
    applyTransform();
  }, { passive: false });

  const touchState = {
    mode: null,
    startDist: 0,
    startScale: 1,
    anchor: null,
  };
  let touchTap = null;

  function touchDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  }

  function touchMidpoint(touches) {
    return {
      x: (touches[0].clientX + touches[1].clientX) / 2,
      y: (touches[0].clientY + touches[1].clientY) / 2,
    };
  }

  els.stage.addEventListener('touchstart', (ev) => {
    if (ev.touches.length === 2) {
      ev.preventDefault();
      touchTap = null;
      const mid = touchMidpoint(ev.touches);
      touchState.mode = 'pinch';
      touchState.startDist = touchDistance(ev.touches);
      touchState.startScale = state.scale;
      touchState.anchor = clientToPlan(mid.x, mid.y);
      state.draggingPan = false;
      state.dragStart = null;
      return;
    }
    if (ev.touches.length !== 1) return;
    if (state.place.active) {
      // Разметка идёт через touchend (короткий тап), без панорамирования.
      const t = ev.touches[0];
      touchTap = { x: t.clientX, y: t.clientY, moved: false, t: Date.now() };
      return;
    }
    const t = ev.touches[0];
    touchTap = { x: t.clientX, y: t.clientY, moved: false, t: Date.now() };
    state.draggingPan = false;
    state.dragStart = null;
  }, { passive: false });

  els.stage.addEventListener('touchmove', (ev) => {
    if (touchState.mode === 'pinch' && ev.touches.length === 2) {
      ev.preventDefault();
      touchTap = null;
      const mid = touchMidpoint(ev.touches);
      const factor = touchDistance(ev.touches) / touchState.startDist;
      state.scale = Math.min(8, Math.max(0.05, touchState.startScale * factor));
      const rect = els.stage.getBoundingClientRect();
      state.panX = mid.x - rect.left - touchState.anchor.x * state.scale;
      state.panY = mid.y - rect.top - touchState.anchor.y * state.scale;
      applyTransform();
      return;
    }
    if (ev.touches.length !== 1 || !touchTap) return;
    if (state.place.active && state.place.step === 'await_yaw' && state.place.x != null) {
      ev.preventDefault();
      const t = ev.touches[0];
      const pt = clientToPlan(t.clientX, t.clientY);
      state.place.yawDeg = yawFromPoints({ x: state.place.x, y: state.place.y }, pt);
      state.place.coneLen = CONE_LEN;
      redrawOverlay();
      updatePreviewMeta(state.place.id);
      return;
    }
    const t = ev.touches[0];
    const dx = t.clientX - touchTap.x;
    const dy = t.clientY - touchTap.y;
    if (!touchTap.moved && Math.hypot(dx, dy) > TAP_MOVE_PX) {
      touchTap.moved = true;
      if (state.place.active) return;
      state.draggingPan = true;
      state.dragStart = { x: touchTap.x, y: touchTap.y, panX: state.panX, panY: state.panY };
      els.stage.classList.add('panning');
    }
    if (!state.draggingPan || !state.dragStart) return;
    ev.preventDefault();
    state.panX = state.dragStart.panX + (t.clientX - state.dragStart.x);
    state.panY = state.dragStart.panY + (t.clientY - state.dragStart.y);
    applyTransform();
  }, { passive: false });

  els.stage.addEventListener('touchend', (ev) => {
    if (state.place.active && touchTap && !touchTap.moved) {
      const pt = clientToPlan(touchTap.x, touchTap.y);
      if (state.place.step === 'await_point') {
        ev.preventDefault();
        state.place.x = pt.x;
        state.place.y = pt.y;
        state.place.yawDeg = null;
        state.place.coneLen = CONE_LEN;
        state.place.step = 'await_yaw';
        setPlaceUi();
        updatePreviewMeta(state.place.id);
        redrawOverlay();
        touchTap = null;
        return;
      }
      if (state.place.step === 'await_yaw') {
        ev.preventDefault();
        state.place.yawDeg = yawFromPoints({ x: state.place.x, y: state.place.y }, pt);
        state.place.coneLen = CONE_LEN;
        finishPlacement();
        touchTap = null;
        touchState.mode = null;
        return;
      }
    }
    if (touchTap && !touchTap.moved && !touchState.mode && !state.place.active) {
      const dt = Date.now() - touchTap.t;
      if (dt < 450) {
        const hitId = hitTestMarker(touchTap.x, touchTap.y);
        if (hitId) {
          ev.preventDefault();
          selectPhoto(hitId, { fromMap: true });
          touchTap = null;
          touchState.mode = null;
          state.draggingPan = false;
          state.dragStart = null;
          els.stage.classList.remove('panning');
          return;
        }
      }
    }
    touchTap = null;
    touchState.mode = null;
    state.draggingPan = false;
    state.dragStart = null;
    els.stage.classList.remove('panning');
  });

  els.stage.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return;
    const pt = clientToPlan(ev.clientX, ev.clientY);
    if (state.place.active) {
      if (state.place.step === 'await_point') {
        state.place.x = pt.x;
        state.place.y = pt.y;
        state.place.yawDeg = null;
        state.place.coneLen = CONE_LEN;
        state.place.step = 'await_yaw';
        setPlaceUi();
        updatePreviewMeta(state.place.id);
        redrawOverlay();
        return;
      }
      if (state.place.step === 'await_yaw') {
        state.place.yawDeg = yawFromPoints({ x: state.place.x, y: state.place.y }, pt);
        state.place.coneLen = CONE_LEN;
        finishPlacement();
        return;
      }
    }
    state.draggingPan = true;
    state.dragStart = { x: ev.clientX, y: ev.clientY, panX: state.panX, panY: state.panY };
    els.stage.classList.add('panning');
  });

  window.addEventListener('mousemove', (ev) => {
    if (state.resizingPreview) {
      const layoutRect = els.layout.getBoundingClientRect();
      const width = layoutRect.right - ev.clientX;
      setPreviewWidth(width);
      return;
    }
    if (state.place.active && state.place.step === 'await_yaw' && state.place.x != null) {
      const pt = clientToPlan(ev.clientX, ev.clientY);
      state.place.yawDeg = yawFromPoints({ x: state.place.x, y: state.place.y }, pt);
      state.place.coneLen = CONE_LEN;
      redrawOverlay();
      updatePreviewMeta(state.place.id);
      return;
    }
    if (!state.draggingPan || !state.dragStart) return;
    state.panX = state.dragStart.panX + (ev.clientX - state.dragStart.x);
    state.panY = state.dragStart.panY + (ev.clientY - state.dragStart.y);
    applyTransform();
  });

  window.addEventListener('mouseup', () => {
    state.draggingPan = false;
    state.dragStart = null;
    state.resizingPreview = false;
    els.stage.classList.remove('panning');
    els.previewSplitter.classList.remove('dragging');
  });

  els.previewSplitter.addEventListener('mousedown', (ev) => {
    ev.preventDefault();
    state.resizingPreview = true;
    els.previewSplitter.classList.add('dragging');
  });

  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && state.place.active) cancelPlacement();
    handleYawKeyDown(ev);
    handlePhotoPanKeyDown(ev);
  });

  window.addEventListener('keyup', (ev) => {
    handleYawKeyUp(ev);
    handlePhotoPanKeyUp(ev);
  });

  window.addEventListener('blur', () => {
    if (yawKeyState.direction) {
      stopYawKeyRepeat();
      flushYawRotationSave();
    }
    resetPhotoPanUi();
  });

  els.dateSelect.addEventListener('change', () => setActiveDate(els.dateSelect.value));
  if (els.projectSelect) {
    els.projectSelect.addEventListener('change', () => {
      const root = els.projectSelect.value;
      if (root) void selectProject(root);
    });
  }
  if (els.btnAddProject) {
    els.btnAddProject.addEventListener('click', () => { void addProjectFromPrompt(); });
  }

  els.btnSave.addEventListener('click', () => saveSeeds());
  els.btnClearSeed.addEventListener('click', () => clearSelectedSeed());
  els.btnCancelPlace.addEventListener('click', () => cancelPlacement());
  if (els.btnGpsCalib) els.btnGpsCalib.addEventListener('click', () => startGpsCalib());
  if (els.btnGpsAuto) els.btnGpsAuto.addEventListener('click', () => autoPlaceByGps());
  if (els.planSelect) {
    els.planSelect.addEventListener('change', () => {
      const file = els.planSelect.value;
      if (file) void selectPlanFile(file);
    });
  }
  els.btnReplacePlan.addEventListener('click', () => els.planFileInput.click());
  if (els.btnRefreshPhotos) {
    els.btnRefreshPhotos.addEventListener('click', () => { void refreshPhotosFromFolder(); });
  }
  els.planFileInput.addEventListener('change', async () => {
    const file = els.planFileInput.files && els.planFileInput.files[0];
    els.planFileInput.value = '';
    if (file) await replacePlanFile(file);
  });
  els.btnZoomIn.addEventListener('click', () => {
    state.scale = Math.min(8, state.scale * 1.2);
    applyTransform();
  });
  els.btnZoomOut.addEventListener('click', () => {
    state.scale = Math.max(0.05, state.scale / 1.2);
    applyTransform();
  });
  els.btnZoomFit.addEventListener('click', () => fitPlan());
  els.btnRotateLeft.addEventListener('click', () => rotatePlan(-90));
  els.btnRotateRight.addEventListener('click', () => rotatePlan(90));

  const previewClickTarget = els.previewPhotoWrap || els.previewImg;
  previewClickTarget.addEventListener('click', (ev) => {
    if (!state.selectedId) return;
    if (photoPan.spaceDown || photoPan.suppressClick || photoPan.dragging) return;
    if (ev.target.closest('.preview-layer') == null && ev.target !== previewClickTarget) return;
    const p = photoById(state.selectedId);
    resetLightboxZoom();
    els.lightboxImg.src = `/${p.originalUrl}`;
    els.lightbox.classList.remove('hidden');
  });
  els.lightboxClose.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    closeLightbox();
  });
  els.lightboxImg.addEventListener('click', (ev) => {
    if (photoPan.spaceDown || photoPan.suppressClick) return;
    ev.stopPropagation();
    closeLightbox();
  });
  els.lightbox.addEventListener('click', (ev) => {
    if (photoPan.spaceDown || photoPan.suppressClick) return;
    if (ev.target.closest('.lightbox-close')) return;
    if (ev.target === els.lightbox || ev.target.classList.contains('lightbox-viewport')) {
      closeLightbox();
    }
  });
  bindPhotoZoomUi();

  async function loadJson(url, fallback) {
    try {
      const res = await fetch(url);
      if (!res.ok) return fallback;
      return await res.json();
    } catch {
      return fallback;
    }
  }

  async function init() {
    applyShareUi();
    bindDateScaleDrag();
    bindTopSettings();
    const savedW = Number(localStorage.getItem(LS_PREVIEW) || 0);
    setPreviewWidth(savedW > 0 ? savedW : maxPreviewWidth());
    window.addEventListener('resize', () => {
      if (!localStorage.getItem(LS_PREVIEW)) setPreviewWidth(maxPreviewWidth());
    });

    const meta = await loadJson(SHARE ? '/data/meta.json' : '/api/meta', {});
    if (meta.buildStamp) els.buildStamp.textContent = meta.buildStamp;
    await loadProjects();

    const floorsDoc = await loadJson(SHARE ? '/data/floors.json' : '/api/floors', null);
    if (floorsDoc && Array.isArray(floorsDoc.floors)) {
      state.floors = floorsDoc.floors.map((f) => normalizeFloor(f));
      state.activeFloorId = floorsDoc.activeFloorId || state.floors[0]?.id || 'UG';
    } else {
      state.floors = [
        { id: 'UG', label: 'UG', planFile: '101_BPS.UH9_ARC_UG.pdf', planRotation: 0 },
        { id: 'EG', label: 'EG', planFile: null, planRotation: 0 },
        { id: '1.OG', label: '1.OG', planFile: null, planRotation: 0 },
        { id: 'DG', label: 'DG', planFile: null, planRotation: 0 },
      ];
      state.activeFloorId = 'UG';
    }

    const index = await loadJson('/data/photos.json', { photos: [], dates: [] });
    applyPhotosIndex(index, { keepDate: false, ui: false });

    const seedsDoc = await loadJson(
      WEB ? '/api/seeds' : (SHARE ? '/data/seeds.json' : '/api/seeds'),
      { seeds: [], byFloor: {} }
    );
    loadSeedsDoc(seedsDoc);

    const camDoc = await loadJson('/data/cameras.json', { cameras: [] });
    state.cameras.clear();
    for (const c of camDoc.cameras || []) {
      if (c && c.id) state.cameras.set(c.id, c);
    }

    renderDateScale();
    renderFloorTabs();
    await renderPlanSelect();
    setPlaceUi();
    await renderPlanForFloor();
    renderList();
    if (filteredPhotos().length) selectPhoto(filteredPhotos()[0].id);
  }

  init().catch((err) => {
    console.error(err);
    setStatusHint('Ladefehler: ' + err.message);
  });
})();
