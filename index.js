// ===== Avatar Gallery =====
// Галерея аватарок прямо в SillyTavern. На аватарках (персоны, персонаж, аватары
// в сообщениях, список персонажей) — значок 🖼. Клик → набор картинок для ЭТОЙ
// аватарки; выбор реально заменяет аватарку персоны/персонажа в таверне (везде).
// В меню-палочке — «Менеджер аватарок» со всеми сохранёнными. Хранение: IndexedDB
// (без раздувания settings.json). Дизайн адаптируется под тему ST.
(async function () {
    'use strict';

    let _ext, _script, _personas, _power;
    try { _ext      = await import('../../../extensions.js'); } catch {}
    try { _script   = await import('../../../../script.js');  } catch {}
    try { _personas = await import('../../../personas.js');   } catch {}
    try { _power    = await import('../../../power-user.js'); } catch {}

    const MY_KEY = 'avatar-gallery';
    const STORE_MAX = 1024;   // макс. сторона картинки в пикселях
    const THUMB_MAX = 128;    // макс. сторона мини-превью для ленты
    const MAX_IMAGES = 60;    // макс. число картинок в одной галерее

    // ── Настройки ───────────────────────────────────────────────────────────
    function ctx() { try { return window.SillyTavern?.getContext?.() ?? null; } catch { return null; } }
    function settings() {
        const s = ctx()?.extensionSettings ?? _ext?.extension_settings ?? (window.extension_settings ??= {});
        if (!s[MY_KEY] || typeof s[MY_KEY] !== 'object') s[MY_KEY] = {};
        const m = s[MY_KEY];
        if (typeof m.enabled !== 'boolean') m.enabled = true;
        if (typeof m.onMessages !== 'boolean') m.onMessages = true;
        return m;
    }
    function save() { try { ctx()?.saveSettingsDebounced?.(); } catch { _ext?.saveSettingsDebounced?.(); } }
    const isEnabled = () => settings().enabled !== false;
    const characters = () => ctx()?.characters ?? _script?.characters ?? [];

    // ── IndexedDB ───────────────────────────────────────────────────────────
    const DB_NAME = 'avatar_gallery_db', DB_STORE = 'galleries';
    let _dbPromise = null;
    function db() {
        if (_dbPromise) return _dbPromise;
        _dbPromise = new Promise((res, rej) => {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => { req.result.createObjectStore(DB_STORE, { keyPath: 'key' }); };
            req.onsuccess = () => res(req.result);
            req.onerror = () => rej(req.error);
        });
        return _dbPromise;
    }
    async function idbGet(key) {
        const d = await db();
        return new Promise((res) => { const r = d.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(key); r.onsuccess = () => res(r.result || null); r.onerror = () => res(null); });
    }
    async function idbSet(record) {
        const d = await db();
        return new Promise((res) => { const tx = d.transaction(DB_STORE, 'readwrite'); tx.objectStore(DB_STORE).put(record); tx.oncomplete = () => res(true); tx.onerror = () => res(false); });
    }
    async function idbGetAll() {
        const d = await db();
        return new Promise((res) => { const r = d.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => res([]); });
    }
    async function idbDel(key) {
        const d = await db();
        return new Promise((res) => { const tx = d.transaction(DB_STORE, 'readwrite'); tx.objectStore(DB_STORE).delete(key); tx.oncomplete = () => res(true); tx.onerror = () => res(false); });
    }

    // ── Картинки ────────────────────────────────────────────────────────────
    function loadImage(src) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('img')); i.src = src; }); }
    async function downscale(dataUrl, max = STORE_MAX) {
        try {
            const img = await loadImage(dataUrl);
            let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
            if (!w || !h) return dataUrl;
            const scale = Math.min(1, max / Math.max(w, h));
            if (scale >= 1) return dataUrl;
            const cv = document.createElement('canvas');
            cv.width = Math.round(w * scale); cv.height = Math.round(h * scale);
            cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
            // PNG/WebP/GIF могут иметь прозрачность — не перекодируем в JPEG; фото (JPEG) жмём в JPEG.
            const srcMime = (dataUrl.match(/^data:([^;,]+)/) || [, ''])[1].toLowerCase();
            const keepPng = srcMime !== 'image/jpeg' && srcMime !== 'image/jpg';
            return keepPng ? cv.toDataURL('image/png') : cv.toDataURL('image/jpeg', 0.9);
        } catch { return dataUrl; }
    }
    function fileToDataUrl(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result || '')); r.onerror = () => rej(r.error); r.readAsDataURL(file); }); }
    async function urlToDataUrl(url) {
        try {
            const r = await fetch(url, { cache: 'no-cache' });
            if (!r.ok) return null;
            const blob = await r.blob();
            return await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result || '')); fr.onerror = () => res(null); fr.readAsDataURL(blob); });
        } catch { return null; }
    }
    function dataUrlToBlob(dataUrl) {
        const [h, d] = dataUrl.split(',');
        const mime = (h.match(/:(.*?);/) || [, 'image/png'])[1];
        const bin = atob(d); const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return new Blob([arr], { type: mime });
    }

    // ── ST helpers ──────────────────────────────────────────────────────────
    function headers() {
        try { const h = (_script?.getRequestHeaders?.({ omitContentType: true })) ?? ctx()?.getRequestHeaders?.() ?? {}; delete h['Content-Type']; return h; } catch { return {}; }
    }
    function thumb(type, id) { try { if (_script?.getThumbnailUrl) return _script.getThumbnailUrl(type, id); } catch {} return `/thumbnail?type=${type}&file=${encodeURIComponent(id)}`; }
    function bustImages(type, id) {
        if (!id) return;
        const kind = type === 'persona' ? 'persona' : 'char';
        document.querySelectorAll('img').forEach(img => {
            const src = img.getAttribute('src') || '';
            const parsed = parseAvatarFromSrc(src);
            if (!parsed || parsed.kind !== kind || parsed.id !== id) return;
            const base = src.split('#')[0].split('?')[0];
            let q = (src.split('?')[1] || '').split('#')[0];
            q = q.split('&').filter(p => p && !p.startsWith('_agb=')).join('&');
            img.src = base + '?' + (q ? q + '&' : '') + '_agb=' + Date.now();
        });
    }

    // ── Сущности ────────────────────────────────────────────────────────────
    function personaEntity(avatarId, name) {
        if (!avatarId) return null;
        let nm = name;
        try { if (!nm && _power?.power_user?.personas) nm = _power.power_user.personas[avatarId]; } catch {}
        return { type: 'persona', id: avatarId, key: 'persona:' + avatarId, name: nm || avatarId, currentSrc: thumb('persona', avatarId), fullSrc: '/User Avatars/' + encodeURIComponent(avatarId) };
    }
    function charEntityFor(avatarKey, name) {
        if (!avatarKey) return null;
        return { type: 'char', id: avatarKey, key: 'char:' + avatarKey, name: name || avatarKey, currentSrc: thumb('avatar', avatarKey), fullSrc: '/characters/' + encodeURIComponent(avatarKey) };
    }
    function charEntity() {
        const c = ctx();
        const idx = c?.characterId ?? _script?.this_chid ?? -1;
        const char = characters()?.[idx];
        return char?.avatar ? charEntityFor(char.avatar, char.name) : null;
    }
    function entityFromKey(key) {
        if (typeof key !== 'string') return null;
        if (key.startsWith('persona:')) return personaEntity(key.slice(8));
        if (key.startsWith('char:')) { const av = key.slice(5); const ch = characters()?.find?.(x => x?.avatar === av); return charEntityFor(av, ch?.name); }
        return null;
    }
    function parseAvatarFromSrc(src) {
        try {
            const u = new URL(src, location.href);
            const type = u.searchParams.get('type'), file = u.searchParams.get('file');
            if (type === 'persona' && file) return { kind: 'persona', id: decodeURIComponent(file) };
            if (type === 'avatar' && file) return { kind: 'char', id: decodeURIComponent(file) };
            const p = decodeURIComponent(u.pathname); let m;
            if ((m = p.match(/\/User Avatars\/(.+)$/))) return { kind: 'persona', id: m[1] };
            if ((m = p.match(/\/characters\/(.+)$/))) return { kind: 'char', id: m[1] };
        } catch {}
        return null;
    }
    function entityFromMessage(mes) {
        if (!mes) return null;
        const isUser = mes.getAttribute('is_user') === 'true';
        const img = mes.querySelector('.mesAvatarWrapper .avatar img, .avatar img');
        const parsed = parseAvatarFromSrc(img?.getAttribute('src') || '');
        if (parsed?.kind === 'persona') return personaEntity(parsed.id);
        if (parsed?.kind === 'char') return charEntityFor(parsed.id, mes.getAttribute('ch_name'));
        return isUser ? personaEntity(_personas?.user_avatar) : charEntity();
    }

    // ── Применение к реальной аватарке ──────────────────────────────────────
    async function applyToST(entity, dataUrl) {
        const blob = dataUrlToBlob(dataUrl);
        const fd = new FormData();
        let url;
        if (entity.type === 'persona') { fd.append('avatar', blob, 'avatar.png'); fd.append('overwrite_name', entity.id); url = '/api/avatars/upload'; }
        else { fd.append('avatar', blob, 'avatar.png'); fd.append('avatar_url', entity.id); url = '/api/characters/edit-avatar'; }
        const r = await fetch(url, { method: 'POST', headers: headers(), cache: 'no-cache', body: fd });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        try { await fetch(thumb(entity.type === 'persona' ? 'persona' : 'avatar', entity.id), { cache: 'reload' }); } catch {}
        bustImages(entity.type, entity.id);
        return true;
    }

    // ── Хранилище галереи ───────────────────────────────────────────────────
    function mkImgId() { return 'img_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }
    async function getGallery(entity) {
        let rec = await idbGet(entity.key);
        const isNew = !rec;
        if (!rec) rec = { key: entity.key, images: [], appliedId: null };
        if (!Array.isArray(rec.images)) rec.images = [];
        // Засеваем текущей аватаркой только при ПЕРВОМ создании записи: если пользователь
        // сам опустошил галерею — не воскрешаем. Запись сохраняем всегда (даже пустую),
        // чтобы не пере-засевать и не бить по сети при каждом открытии.
        if (isNew) {
            const cur = await urlToDataUrl(entity.fullSrc) || await urlToDataUrl(entity.currentSrc);
            if (cur) {
                const data = await downscale(cur);
                const item = { id: mkImgId(), data, thumb: await downscale(data, THUMB_MAX), ts: Date.now() };
                rec.images.push(item); rec.appliedId = item.id;
            }
            await idbSet(rec);
        }
        return rec;
    }
    async function addImages(entity, dataUrls) {
        // Жёсткий лимит: добавляем только пока есть место до MAX_IMAGES, лишнее не берём.
        const rec = await getGallery(entity);
        let last = null;
        for (const du of dataUrls) {
            if (rec.images.length >= MAX_IMAGES) break;
            const data = await downscale(du);
            const item = { id: mkImgId(), data, thumb: await downscale(data, THUMB_MAX), ts: Date.now() };
            rec.images.push(item); last = item;
        }
        await idbSet(rec);
        return last;
    }
    async function removeImage(entity, imgId) {
        const rec = await getGallery(entity);
        rec.images = rec.images.filter(i => i.id !== imgId);
        if (rec.appliedId === imgId) rec.appliedId = null;
        await idbSet(rec);
        return rec;
    }
    async function markApplied(entity, imgId) { const rec = await getGallery(entity); rec.appliedId = imgId; await idbSet(rec); }

    // ── Одиночная галерея (модалка) ─────────────────────────────────────────
    let _entity = null, _rec = null, _view = 0, _busy = false;

    // ST закрывает открытые панели (персоны/персонаж) по mousedown/touchstart на html,
    // если нажатие вне панели. Не пускаем события из наших окон/значков наверх,
    // иначе панель под галереей закрывается.
    function shieldFromST(el) {
        ['mousedown', 'touchstart', 'pointerdown', 'click'].forEach(t =>
            el.addEventListener(t, (e) => e.stopPropagation()));
    }

    function buildModal() {
        if (document.getElementById('ag-modal')) return;
        document.body.insertAdjacentHTML('beforeend', `
<div id="ag-modal" role="dialog" aria-modal="true">
  <div class="ag-panel">
    <div class="ag-head">
      <div class="ag-title"><span class="ag-ic"><i class="fa-solid fa-images"></i></span> <span id="ag-name">Галерея</span></div>
      <button class="ag-close" id="ag-close" title="Закрыть"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div class="ag-sub" id="ag-sub"></div>
    <div class="ag-stage">
      <button class="ag-arrow" id="ag-prev"><i class="fa-solid fa-chevron-left"></i></button>
      <div class="ag-figure" id="ag-figure">
        <img id="ag-main" src="" alt="avatar">
        <div class="ag-ring"></div>
        <div class="ag-empty" id="ag-empty"><i class="fa-solid fa-image"></i><div>Пусто</div><small>Загрузи картинки ниже</small></div>
      </div>
      <button class="ag-arrow" id="ag-next"><i class="fa-solid fa-chevron-right"></i></button>
    </div>
    <div class="ag-bar">
      <span class="ag-counter" id="ag-counter">0 / 0</span>
      <button class="ag-apply menu_button" id="ag-apply"><i class="fa-solid fa-wand-magic-sparkles"></i> Сделать аватаркой</button>
    </div>
    <div class="ag-thumbs" id="ag-thumbs"></div>
    <div class="ag-foot">
      <button class="ag-upload menu_button" id="ag-upload"><i class="fa-solid fa-plus"></i> Загрузить картинки</button>
      <input type="file" id="ag-file" accept="image/*" multiple hidden>
    </div>
    <div class="ag-status" id="ag-status"></div>
  </div>
</div>`);
        const $ = (id) => document.getElementById(id);
        shieldFromST($('ag-modal'));
        $('ag-close').onclick = closeModal;
        $('ag-modal').onclick = (e) => { if (e.target.id === 'ag-modal') closeModal(); };
        $('ag-prev').onclick = () => nav(-1);
        $('ag-next').onclick = () => nav(1);
        $('ag-apply').onclick = onApply;
        $('ag-upload').onclick = () => $('ag-file').click();
        $('ag-file').onchange = onUpload;
        document.addEventListener('keydown', (e) => {
            const galOpen = document.getElementById('ag-modal')?.classList.contains('open');
            const mgr = document.getElementById('agm-modal');
            if (e.key === 'Escape') {
                if (galOpen) closeModal();
                else if (mgr?.classList.contains('open')) mgr.classList.remove('open');
                return;
            }
            if (!galOpen) return;
            if (e.key === 'ArrowLeft') nav(-1);
            if (e.key === 'ArrowRight') nav(1);
        });
    }
    function closeModal() { document.getElementById('ag-modal')?.classList.remove('open'); }

    async function openFor(entity) {
        if (!entity) return;
        buildModal();
        _entity = entity; _view = 0;
        document.getElementById('ag-modal').classList.add('open');
        document.getElementById('ag-name').textContent = entity.name;
        document.getElementById('ag-sub').textContent = entity.type === 'persona' ? 'Персона' : 'Персонаж';
        setStatus('Загрузка…', '');
        _rec = await getGallery(entity);
        if (_rec.appliedId) { const i = _rec.images.findIndex(x => x.id === _rec.appliedId); if (i >= 0) _view = i; }
        setStatus('', '');
        render();
        ensureThumbs(entity);
    }

    // Догенерируем мини-превью у старых галерей в фоне: сейчас лента уже показана
    // полноразмерными, а при следующих открытиях загрузится быстро.
    async function ensureThumbs(entity) {
        const rec = await idbGet(entity.key);
        if (!rec?.images?.some(i => !i.thumb)) return;
        const made = {};
        for (const im of rec.images) { if (!im.thumb) { try { made[im.id] = await downscale(im.data, THUMB_MAX); } catch {} } }
        // Перечитываем запись перед сохранением: пока делали превью, картинки могли удалить/добавить.
        const fresh = await idbGet(entity.key);
        if (!fresh || !Array.isArray(fresh.images)) return;
        let touched = false;
        for (const im of fresh.images) { if (!im.thumb && made[im.id]) { im.thumb = made[im.id]; touched = true; } }
        if (touched) await idbSet(fresh);
        if (_rec && _entity?.key === entity.key) { for (const im of _rec.images) { if (!im.thumb && made[im.id]) im.thumb = made[im.id]; } }
    }

    function render() {
        const $ = (id) => document.getElementById(id);
        const imgs = _rec?.images || [];
        const total = imgs.length;
        const main = $('ag-main'), empty = $('ag-empty'), fig = $('ag-figure'), apply = $('ag-apply');
        if (total === 0) {
            main.style.display = 'none'; empty.style.display = 'flex'; fig.classList.remove('is-applied');
            $('ag-counter').textContent = '0 / 0'; $('ag-prev').disabled = $('ag-next').disabled = true;
            apply.disabled = true; $('ag-thumbs').innerHTML = ''; render._sig = ''; return;
        }
        if (_view >= total) _view = total - 1; if (_view < 0) _view = 0;
        const cur = imgs[_view];
        const applied = cur.id === _rec.appliedId;
        main.style.display = 'block'; empty.style.display = 'none';
        showMain(main, cur.data);
        fig.classList.toggle('is-applied', applied);
        $('ag-counter').textContent = `${_view + 1} / ${total}`;
        $('ag-prev').disabled = $('ag-next').disabled = total <= 1;
        apply.disabled = applied || _busy;
        apply.classList.toggle('is-current', applied);
        apply.innerHTML = applied ? '<i class="fa-solid fa-circle-check"></i> Текущая аватарка' : '<i class="fa-solid fa-wand-magic-sparkles"></i> Сделать аватаркой';

        const thumbs = $('ag-thumbs');
        // Ленту пересобираем только при изменении состава; при листании — только классы,
        // иначе миниатюры пере-декодируются и мигают.
        const sig = imgs.map(x => x.id).join(',') + '|' + _rec.appliedId;
        if (render._sig !== sig) {
            render._sig = sig;
            thumbs.innerHTML = '';
            imgs.forEach((im, i) => thumbs.appendChild(thumbEl(im, i === _view, im.id === _rec.appliedId,
                () => { _view = i; render(); },
                (e) => { e.stopPropagation(); onDelete(im.id); })));
        } else {
            Array.from(thumbs.children).forEach((w, i) => w.querySelector('.ag-thumb')?.classList.toggle('selected', i === _view));
        }
        // Центрируем активную миниатюру скроллом самой ленты: scrollIntoView крутит и
        // родителей вплоть до страницы — на телефоне от этого уезжал весь экран.
        const active = thumbs.children[_view];
        if (active) {
            const tr = thumbs.getBoundingClientRect(), ar = active.getBoundingClientRect();
            thumbs.scrollLeft += (ar.left + ar.width / 2) - (tr.left + tr.width / 2);
        }
    }
    // Подменяем главную картинку только когда она уже декодирована — без пустого кадра.
    function showMain(img, src) {
        if (img.src === src) return;
        const token = (showMain._t = {});
        const pre = new Image();
        const swap = () => { if (showMain._t === token) img.src = src; };
        pre.src = src;
        if (pre.decode) pre.decode().then(swap, swap); else { pre.onload = swap; pre.onerror = swap; }
    }
    function thumbEl(im, selected, applied, onClick, onDel) {
        const wrap = document.createElement('div');
        wrap.className = 'ag-thumb-wrap' + (applied ? ' applied' : '');
        const t = document.createElement('img');
        t.className = 'ag-thumb' + (selected ? ' selected' : '');
        t.src = im.thumb || im.data; t.decoding = 'async'; t.onclick = onClick;
        const del = document.createElement('button');
        del.className = 'ag-thumb-del'; del.title = 'Удалить'; del.innerHTML = '<i class="fa-solid fa-xmark"></i>'; del.onclick = onDel;
        if (applied) { const s = document.createElement('div'); s.className = 'ag-thumb-star'; s.innerHTML = '<i class="fa-solid fa-circle-check"></i>'; wrap.appendChild(s); }
        wrap.appendChild(t); wrap.appendChild(del);
        return wrap;
    }
    function nav(d) { const total = _rec?.images?.length || 0; if (!total) return; _view = (_view + d + total) % total; render(); }
    function setStatus(text, kind) {
        const el = document.getElementById('ag-status'); if (!el) return;
        el.textContent = text; el.className = 'ag-status ' + (kind || '');
        if (kind === 'ok' || kind === 'warn') { clearTimeout(setStatus._t); setStatus._t = setTimeout(() => { el.textContent = ''; el.className = 'ag-status'; }, 3500); }
    }
    async function onUpload(e) {
        const files = Array.from(e.target.files || []); e.target.value = '';
        if (!files.length || !_entity) return;
        // Считаем свободные места ДО чтения файлов — лишние не читаем и не добавляем.
        const free = MAX_IMAGES - (await getGallery(_entity)).images.length;
        if (free <= 0) { setStatus(`⚠ Лимит ${MAX_IMAGES} достигнут — удали лишнее`, 'warn'); return; }
        const accept = files.slice(0, free);
        const skipped = files.length - accept.length;
        setStatus('Добавляю…', '');
        const dataUrls = [];
        for (const f of accept) { try { dataUrls.push(await fileToDataUrl(f)); } catch {} }
        const last = await addImages(_entity, dataUrls);
        _rec = await getGallery(_entity);
        if (last) { const i = _rec.images.findIndex(x => x.id === last.id); if (i >= 0) _view = i; }
        render();
        if (skipped > 0) setStatus(`⚠ Добавлено ${dataUrls.length}, не вошло ${skipped} (лимит ${MAX_IMAGES})`, 'warn');
        else setStatus(`✓ Добавлено: ${dataUrls.length}`, 'ok');
    }
    async function onDelete(imgId) {
        if (!_entity) return;
        _rec = await removeImage(_entity, imgId);
        if (_view >= _rec.images.length) _view = Math.max(0, _rec.images.length - 1);
        render();
    }
    async function onApply() {
        if (!_entity || _busy) return;
        const cur = _rec?.images?.[_view]; if (!cur) return;
        _busy = true; render(); setStatus('Применяю…', '');
        try { await applyToST(_entity, cur.data); await markApplied(_entity, cur.id); _rec = await getGallery(_entity); setStatus('✓ Аватарка обновлена', 'ok'); }
        catch (err) { console.error('[AvatarGallery] apply', err); setStatus('⚠ Не удалось применить (' + (err?.message || 'ошибка') + ')', 'warn'); }
        finally { _busy = false; render(); }
    }

    // ── Менеджер всех аватарок ──────────────────────────────────────────────
    function buildManager() {
        if (document.getElementById('agm-modal')) return;
        document.body.insertAdjacentHTML('beforeend', `
<div id="agm-modal" role="dialog" aria-modal="true">
  <div class="ag-panel agm-panel">
    <div class="ag-head">
      <div class="ag-title"><span class="ag-ic"><i class="fa-solid fa-layer-group"></i></span> <span>Менеджер аватарок</span></div>
      <button class="ag-close" id="agm-close" title="Закрыть"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div class="agm-list" id="agm-list"></div>
    <div class="ag-status" id="agm-status"></div>
  </div>
</div>`);
        shieldFromST(document.getElementById('agm-modal'));
        document.getElementById('agm-close').onclick = () => document.getElementById('agm-modal').classList.remove('open');
        document.getElementById('agm-modal').onclick = (e) => { if (e.target.id === 'agm-modal') e.currentTarget.classList.remove('open'); };
    }
    async function openManager() {
        buildManager();
        document.getElementById('agm-modal').classList.add('open');
        await renderManager();
    }
    function mgrStatus(text, kind) {
        const el = document.getElementById('agm-status'); if (!el) return;
        el.textContent = text; el.className = 'ag-status ' + (kind || '');
        if (kind) { clearTimeout(mgrStatus._t); mgrStatus._t = setTimeout(() => { el.textContent = ''; el.className = 'ag-status'; }, 3000); }
    }
    async function renderManager() {
        const list = document.getElementById('agm-list'); if (!list) return;
        const recs = (await idbGetAll()).filter(r => Array.isArray(r.images) && r.images.length);
        list.innerHTML = '';
        if (!recs.length) { list.innerHTML = '<div class="agm-empty"><i class="fa-solid fa-folder-open"></i><div>Пока нет сохранённых аватарок</div><small>Открой галерею на любой аватарке и добавь картинки</small></div>'; return; }
        recs.sort((a, b) => a.key.localeCompare(b.key));
        for (const rec of recs) {
            const ent = entityFromKey(rec.key);
            const name = ent?.name || rec.key;
            const isPersona = rec.key.startsWith('persona:');
            const sec = document.createElement('div'); sec.className = 'agm-entity';
            const head = document.createElement('div'); head.className = 'agm-entity-head';
            head.innerHTML = `<span class="agm-ic"><i class="fa-solid ${isPersona ? 'fa-id-badge' : 'fa-user'}"></i></span>
                <span class="agm-entity-name" title="Открыть галерею">${escapeHtml(name)}</span>
                <span class="agm-entity-cnt">${rec.images.length}</span>`;
            const delAll = document.createElement('button');
            delAll.className = 'agm-entity-del'; delAll.title = 'Удалить всю галерею этой аватарки';
            delAll.innerHTML = '<i class="fa-solid fa-trash"></i>';
            delAll.onclick = async (e) => { e.stopPropagation(); if (confirm(`Удалить все ${rec.images.length} картинок для «${name}»?`)) { await idbDel(rec.key); renderManager(); } };
            head.appendChild(delAll);
            head.querySelector('.agm-entity-name').onclick = () => { if (ent) { document.getElementById('agm-modal').classList.remove('open'); openFor(ent); } };
            sec.appendChild(head);

            const strip = document.createElement('div'); strip.className = 'ag-thumbs agm-strip';
            rec.images.forEach((im) => strip.appendChild(thumbEl(im, false, im.id === rec.appliedId,
                () => mgrApply(rec.key, im.id),
                (e) => { e.stopPropagation(); mgrDelImg(rec.key, im.id); })));
            sec.appendChild(strip);
            list.appendChild(sec);
        }
    }
    async function mgrApply(key, imgId) {
        const ent = entityFromKey(key); const rec = await idbGet(key);
        const im = rec?.images?.find(i => i.id === imgId);
        if (!ent || !im) return;
        mgrStatus('Применяю…', 'wait');
        try { await applyToST(ent, im.data); rec.appliedId = imgId; await idbSet(rec); await renderManager(); mgrStatus('✓ «' + ent.name + '» обновлена', 'ok'); }
        catch (err) { mgrStatus('⚠ Ошибка: ' + (err?.message || ''), 'warn'); }
    }
    async function mgrDelImg(key, imgId) {
        const rec = await idbGet(key); if (!rec) return;
        rec.images = rec.images.filter(i => i.id !== imgId);
        if (rec.appliedId === imgId) rec.appliedId = null;
        await idbSet(rec); // храним пустую запись (галерея просто скрывается из списка), чтобы не воскрешать текущей аватаркой
        renderManager();
    }
    function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

    // ── Значки-оверлеи ──────────────────────────────────────────────────────
    function makeBtn(onClick, variant) {
        const b = document.createElement('div');
        b.className = 'ag-ov' + (variant ? ' ' + variant : '');
        b.title = 'Галерея аватарок';
        b.innerHTML = '<i class="fa-solid fa-images"></i>';
        shieldFromST(b);
        b.onclick = (e) => { e.preventDefault(); onClick(); };
        return b;
    }
    function attachOverlay(av, onClick, variant) {
        if (!av || av.querySelector(':scope > .ag-ov')) return;
        av.style.position = 'relative';
        av.appendChild(makeBtn(onClick, variant));
    }
    function attachPersonaOverlays() {
        document.querySelectorAll('#user_avatar_block .avatar-container[data-avatar-id]').forEach(cont => {
            const av = cont.querySelector('.avatar') || cont;
            attachOverlay(av, () => {
                const id = cont.getAttribute('data-avatar-id');
                const name = cont.querySelector('.ch_name')?.textContent?.trim();
                if (id) openFor(personaEntity(id, name));
            });
        });
    }
    function attachCharOverlay() {
        const host = document.getElementById('avatar_div_div');
        if (!host) return;
        // Нет выбранного персонажа (группа / welcome) — не показываем бесполезный значок.
        if (!charEntity()) { host.querySelector(':scope > .ag-ov')?.remove(); return; }
        attachOverlay(host, () => { const e = charEntity(); if (e) openFor(e); });
    }
    function attachMessageOverlays() {
        if (!settings().onMessages) return;
        document.querySelectorAll('#chat .mes .mesAvatarWrapper .avatar').forEach(av => {
            const mes = av.closest('.mes');
            attachOverlay(av, () => { const e = entityFromMessage(mes); if (e) openFor(e); }, 'hoveronly');
        });
    }
    function removeOverlays(sel) { document.querySelectorAll(sel || '.ag-ov').forEach(el => el.remove()); }

    // ── Меню-палочка ────────────────────────────────────────────────────────
    function addWandEntry() {
        const menu = document.getElementById('extensionsMenu');
        if (!menu || document.getElementById('ag-wand')) return;
        const item = document.createElement('div');
        item.id = 'ag-wand';
        item.className = 'list-group-item flex-container flexGap5 interactable';
        item.tabIndex = 0;
        item.innerHTML = '<div class="fa-solid fa-images extensionsMenuExtensionButton"></div><span>Менеджер аватарок</span>';
        item.onclick = openManager;
        menu.appendChild(item);
    }
    function removeWandEntry() { document.getElementById('ag-wand')?.remove(); }

    // ── Настройки ───────────────────────────────────────────────────────────
    function addSettingsPanel() {
        const root = document.getElementById('extensions_settings') || document.getElementById('extensions_settings2');
        if (!root || document.getElementById('ag-settings')) return;
        root.insertAdjacentHTML('beforeend', `
<div id="ag-settings" class="inline-drawer">
  <div class="inline-drawer-header" id="ag-drawer-head" style="cursor:pointer">
    <b><i class="fa-solid fa-images"></i> Галерея аватарок</b>
    <div id="ag-drawer-icon" class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
  </div>
  <div class="inline-drawer-content" id="ag-drawer-body" style="display:none">
    <label class="checkbox_label ag-toggle"><input type="checkbox" id="ag-enabled"><span>Включить галерею</span></label>
    <label class="checkbox_label ag-toggle"><input type="checkbox" id="ag-on-messages"><span>Значки в сообщениях чата</span></label>
    <button id="ag-open-mgr" class="menu_button ag-mgr-btn"><i class="fa-solid fa-layer-group"></i> Менеджер аватарок</button>
    <div class="ag-facts">
      <div class="ag-fact"><i class="fa-solid fa-images"></i><b>${MAX_IMAGES}</b><span>в галерее</span></div>
      <div class="ag-fact"><i class="fa-solid fa-expand"></i><b>${STORE_MAX}px</b><span>макс. сторона</span></div>
      <div class="ag-fact"><i class="fa-solid fa-database"></i><b>Локально</b><span>IndexedDB</span></div>
    </div>
    <small class="ag-hint"><i class="fa-solid fa-circle-info"></i><span>Прозрачность PNG/WebP сохраняется, фото пережимаются в JPEG. Клик по значку 🖼 на аватарке — её галерея.</span></small>
  </div>
</div>`);
        const body = document.getElementById('ag-drawer-body');
        const icon = document.getElementById('ag-drawer-icon');
        document.getElementById('ag-drawer-head').onclick = () => {
            const open = body.style.display !== 'none';
            body.style.display = open ? 'none' : 'flex';
            icon.classList.toggle('fa-circle-chevron-up', !open);
            icon.classList.toggle('fa-circle-chevron-down', open);
            icon.classList.toggle('up', !open); icon.classList.toggle('down', open);
        };
        document.getElementById('ag-open-mgr').onclick = openManager;
        const en = document.getElementById('ag-enabled');
        const msg = document.getElementById('ag-on-messages');
        en.checked = isEnabled(); msg.checked = settings().onMessages !== false;
        en.onchange = () => { settings().enabled = en.checked; save(); applyEnabledState(); };
        msg.onchange = () => { settings().onMessages = msg.checked; save(); removeOverlays('.ag-ov.hoveronly'); tick(); };
    }
    function applyEnabledState() {
        if (isEnabled()) { tick(); }
        else { removeOverlays(); removeWandEntry(); closeModal(); document.getElementById('agm-modal')?.classList.remove('open'); }
    }

    // ── Init ────────────────────────────────────────────────────────────────
    buildModal();
    function tick() {
        if (!isEnabled()) return;
        attachPersonaOverlays();
        attachCharOverlay();
        attachMessageOverlays();
        addWandEntry();
    }
function initOnce() {
    addSettingsPanel();
    addWandEntry();
    applyEnabledState();
    return !!document.getElementById('ag-settings');
}
(function retryInit(attempt = 0) {
    const ok = initOnce();
    if (!ok && attempt < 60) {
        setTimeout(() => retryInit(attempt + 1), 500);
    }
})();

const rootObs = new MutationObserver(() => {
    if (!document.getElementById('ag-settings')) addSettingsPanel();
    if (!document.getElementById('ag-wand') && isEnabled()) addWandEntry();
});
rootObs.observe(document.body, { childList: true, subtree: true });


    try {
        const ev = _script?.eventSource ?? ctx()?.eventSource;
        const et = _script?.event_types ?? ctx()?.eventTypes ?? ctx()?.event_types;
        if (ev && et) {
            const on = () => setTimeout(tick, 250);
            [et.CHAT_CHANGED, et.CHARACTER_SELECTED, et.PERSONA_CHANGED, et.SETTINGS_UPDATED, et.MESSAGE_RECEIVED, et.USER_MESSAGE_RENDERED, et.CHARACTER_MESSAGE_RENDERED].forEach(e => { if (e) try { ev.on(e, on); } catch {} });
        }
    } catch {}

    let dbt;
    const isOurNode = (n) => n.nodeType === 1 && (n.classList?.contains('ag-ov') || n.id === 'ag-wand');
    const obs = new MutationObserver((muts) => {
        if (!isEnabled()) return;
        // Пропускаем мутации, вызванные нашими же оверлеями/пунктом меню — иначе observer гоняет tick вхолостую.
        const onlyOurs = muts.some(m => m.addedNodes.length > 0)
            && muts.every(m => m.removedNodes.length === 0 && Array.from(m.addedNodes).every(isOurNode));
        if (onlyOurs) return;
        clearTimeout(dbt); dbt = setTimeout(tick, 200);
    });
    const observe = (id, opts) => { const el = document.getElementById(id); if (el) obs.observe(el, opts); };
    const startObs = () => {
        observe('user_avatar_block', { childList: true, subtree: true });
        observe('extensionsMenu', { childList: true });
        observe('chat', { childList: true });
    };
    [500, 2000].forEach(t => setTimeout(startObs, t));

    window.AvatarGallery = { open: openFor, openManager, personaEntity, charEntity, charEntityFor };
    console.log('[AvatarGallery] ready ✓ (real ST avatar swap + manager)');
})();
