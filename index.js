import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

const MODULE_NAME = 'AvatarAdjuster';
const DEBUG = true;

const log = (...args) => { if (DEBUG) console.log(`[${MODULE_NAME}]`, ...args); };

const RANGES = {
    scale:  { min: 20,   max: 800, step: 1 },
    x:      { min: -600, max: 600, step: 1 },
    y:      { min: -600, max: 600, step: 1 },
    rotate: { min: -180, max: 180, step: 1 },
};


const DEFAULTS = {
    scale: 200,
    x: 0,
    y: 0,
    rotate: 0,
};


// Кэш URL оригиналов: key -> URL или null
const originalUrlCache = new Map();
// In-flight запросы, чтобы не дёргать один и тот же URL параллельно
const pendingLookups = new Map();
// Кэш натуральных размеров картинок: url -> {w, h}
const imageSizeCache = new Map();


function initSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = { avatars: {} };
    }
    if (!extension_settings[MODULE_NAME].avatars) {
        extension_settings[MODULE_NAME].avatars = {};
    }
}

function getAvatarKey(imgSrc) {
    if (!imgSrc) return null;
    try {
        const url = new URL(imgSrc, window.location.origin);
        const type = url.searchParams.get('type');
        const file = url.searchParams.get('file');
        if (type && file) {
            return `${type}:${decodeURIComponent(file)}`;
        }
        const parts = imgSrc.split('/');
        return `raw:${parts[parts.length - 1]}`;
    } catch (e) {
        return null;
    }
}

function getAvatarSettings(key) {
    if (!key) return { ...DEFAULTS };
    const saved = extension_settings[MODULE_NAME].avatars[key];
    return { ...DEFAULTS, ...(saved || {}) };
}

function saveAvatarSettings(key, settings) {
    if (!key) return;
    const isDefault = Object.keys(DEFAULTS).every(k => settings[k] === DEFAULTS[k]);
    if (isDefault) {
        delete extension_settings[MODULE_NAME].avatars[key];
    } else {
        extension_settings[MODULE_NAME].avatars[key] = { ...settings };
    }
    saveSettingsDebounced();
}

// Возможные пути к оригиналу
function getCandidateUrls(type, file) {
    const encoded = encodeURIComponent(file);
    if (type === 'avatar') {
        return [
            `/characters/${encoded}`,
            `/User%20Avatars/${encoded}`,
        ];
    }
    if (type === 'persona') {
        return [
            `/User%20Avatars/${encoded}`,
            `/user/avatars/${encoded}`,
            `/characters/${encoded}`,
        ];
    }
    return [];
}

// Проверка URL через реальную загрузку + запоминаем натуральные размеры
function checkImageLoads(url) {
    return new Promise((resolve) => {
        const img = new Image();
        const timeout = setTimeout(() => resolve(false), 5000);
        img.onload = () => {
            clearTimeout(timeout);
            imageSizeCache.set(url, { w: img.naturalWidth, h: img.naturalHeight });
            resolve(true);
        };
        img.onerror = () => { clearTimeout(timeout); resolve(false); };
        img.src = url;
    });
}

// Гарантированно получить размеры картинки (из кэша или загрузить)
function getImageSize(url) {
    return new Promise((resolve) => {
        if (imageSizeCache.has(url)) {
            resolve(imageSizeCache.get(url));
            return;
        }
        const img = new Image();
        const timeout = setTimeout(() => resolve(null), 5000);
        img.onload = () => {
            clearTimeout(timeout);
            const size = { w: img.naturalWidth, h: img.naturalHeight };
            imageSizeCache.set(url, size);
            resolve(size);
        };
        img.onerror = () => { clearTimeout(timeout); resolve(null); };
        img.src = url;
    });
}


async function findWorkingOriginalUrl(key) {
    if (originalUrlCache.has(key)) return originalUrlCache.get(key);
    if (pendingLookups.has(key)) return pendingLookups.get(key);

    const promise = (async () => {
        const [type, file] = key.split(':');
        if (!type || !file) {
            originalUrlCache.set(key, null);
            return null;
        }
        const candidates = getCandidateUrls(type, file);
        log(`Searching original for "${key}". Candidates:`, candidates);
        for (const url of candidates) {
            const ok = await checkImageLoads(url);
            log(`  → ${url} : ${ok ? '✅ OK' : '❌ fail'}`);
            if (ok) {
                originalUrlCache.set(key, url);
                pendingLookups.delete(key);
                return url;
            }
        }
        log(`  ⚠ No working original for "${key}", will use thumbnail`);
        originalUrlCache.set(key, null);
        pendingLookups.delete(key);
        return null;
    })();

    pendingLookups.set(key, promise);
    return promise;
}

// Гарантируем наличие слоя-оверлея
function ensureOverlayLayer(avatarEl) {
    let layer = avatarEl.querySelector(':scope > .aa-original-layer');
    if (!layer) {
        layer = document.createElement('div');
        layer.className = 'aa-original-layer';
        avatarEl.appendChild(layer);
    }
    return layer;
}

function removeOverlayLayer(avatarEl) {
    const layer = avatarEl.querySelector(':scope > .aa-original-layer');
    if (layer) layer.remove();
    avatarEl.classList.remove('aa-has-original');
}

// Вычисляет минимальный масштаб (cover) и максимальный сдвиг,
// чтобы картинка не уезжала за границы контейнера.
// contMode = 'contain' (как у нас в CSS: background-size: contain)
function computeBounds(contW, contH, imgW, imgH) {
    if (!contW || !contH || !imgW || !imgH) {
        return { minScale: 1, maxX: 300, maxY: 300 };
    }

    // background-size: contain — как картинка вписана изначально (scale=1)
    const containScale = Math.min(contW / imgW, contH / imgH);
    const baseW = imgW * containScale; // ширина картинки на экране при scale=1
    const baseH = imgH * containScale;

    // Масштаб (относительно contain), при котором картинка ПОЛНОСТЬЮ закрывает контейнер
    const minScaleToCover = Math.max(contW / baseW, contH / baseH);

    return { minScale: minScaleToCover, baseW, baseH, contW, contH };
}

// Зажимает сдвиг так, чтобы края картинки не заходили внутрь контейнера
function clampOffsets(settings, bounds) {
    if (!bounds || !bounds.baseW) return settings;

    const scale = settings.scale / 100;
    const scaledW = bounds.baseW * scale;
    const scaledH = bounds.baseH * scale;

    // Сколько картинка "выступает" за контейнер с каждой стороны
    const maxX = Math.max(0, (scaledW - bounds.contW) / 2);
    const maxY = Math.max(0, (scaledH - bounds.contH) / 2);

    settings.x = Math.max(-maxX, Math.min(maxX, settings.x));
    settings.y = Math.max(-maxY, Math.min(maxY, settings.y));
    return settings;
}

// Применение стилей к элементу .avatar
async function applyToAvatarEl(avatarEl) {
    const img = avatarEl.querySelector(':scope > img');
    if (!img) return;
    const src = img.getAttribute('src');
    const key = getAvatarKey(src);
    if (!key) return;

    const settings = getAvatarSettings(key);
    const hasCustom = !!extension_settings[MODULE_NAME].avatars[key];

    if (!hasCustom) {
        removeOverlayLayer(avatarEl);
        return;
    }

    // Находим оригинал
    let originalUrl = originalUrlCache.get(key);
    if (originalUrl === undefined) {
        originalUrl = await findWorkingOriginalUrl(key);
    }
    if (!originalUrl) originalUrl = src; // fallback на thumbnail

    // Создаём слой
    const layer = ensureOverlayLayer(avatarEl);
    avatarEl.classList.add('aa-has-original');

    // Устанавливаем фон только если изменился
    const desiredBg = `url("${originalUrl}")`;
    if (layer.style.backgroundImage !== desiredBg) {
        layer.style.backgroundImage = desiredBg;
    }

    // ── Считаем реальные размеры и зажимаем сдвиг по границам ──
    const imgSize = await getImageSize(originalUrl);
    const rect = avatarEl.getBoundingClientRect();
    if (imgSize && rect.width && rect.height) {
        const bounds = computeBounds(rect.width, rect.height, imgSize.w, imgSize.h);

        // Не даём масштабу опуститься ниже минимального (чтобы не было дыр)
        const minScalePercent = Math.ceil(bounds.minScale * 100);
        if (settings.scale < minScalePercent) {
            settings.scale = minScalePercent;
        }

        // Зажимаем сдвиг X/Y по границам
        clampOffsets(settings, bounds);

        // Сохраняем скорректированные значения обратно
        saveAvatarSettings(key, settings);
    }

    // Трансформации через CSS-переменные на слое
    layer.style.setProperty('--aa-scale', (settings.scale / 100).toString());
    layer.style.setProperty('--aa-x', `${settings.x}px`);
    layer.style.setProperty('--aa-y', `${settings.y}px`);
    layer.style.setProperty('--aa-rotate', `${settings.rotate}deg`);
}


async function applyToAllMatching(key) {
    const avatars = document.querySelectorAll('#chat .mes .avatar');
    for (const avatarEl of avatars) {
        const img = avatarEl.querySelector(':scope > img');
        if (!img) continue;
        if (getAvatarKey(img.getAttribute('src')) === key) {
            await applyToAvatarEl(avatarEl);
        }
    }
}

function ensureEditButton(avatarEl) {
    // Ищем родительский .mes — на него вешаем кнопку (у него нет overflow:hidden)
    const mesEl = avatarEl.closest('.mes');
    if (!mesEl) return;
    if (mesEl.querySelector(':scope > .aa-edit-btn')) return;

    const computed = window.getComputedStyle(mesEl);
    if (computed.position === 'static') {
        mesEl.style.position = 'relative';
    }

    const btn = document.createElement('div');
    btn.className = 'aa-edit-btn';
    btn.title = 'Редактировать аватарку';
    btn.innerHTML = '<i class="fa-solid fa-gear"></i>';
    btn.addEventListener('pointerup', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const img = avatarEl.querySelector(':scope > img');
        if (img) openPanel(img, btn, avatarEl);
    });
    mesEl.appendChild(btn);
}


function processChatAvatars() {
    document.querySelectorAll('#chat .mes .avatar').forEach(avatarEl => {
        ensureEditButton(avatarEl);
        applyToAvatarEl(avatarEl);
    });
}

// ---- Панель ----
let currentPanel = null;
let panelOpenedAt = 0;


function closePanel() {
    if (currentPanel) {
        currentPanel.remove();
        currentPanel = null;
        document.removeEventListener('mousedown', onOutsideClick);
        document.removeEventListener('touchstart', onOutsideClick);
    }
}

function onOutsideClick(e) {
    if (Date.now() - panelOpenedAt < 400) return;
    if (currentPanel && !currentPanel.contains(e.target) && !e.target.closest('.aa-edit-btn')) {
        closePanel();
    }
}



function makeSliderRow(labelText, prop, state) {
    const range = RANGES[prop];
    const row = document.createElement('div');
    row.className = 'aa-row';

    const label = document.createElement('label');
    label.textContent = labelText;

    const input = document.createElement('input');
    input.type = 'range';
    input.min = range.min;
    input.max = range.max;
    input.step = range.step;
    input.value = state[prop];
    input.dataset.prop = prop;

    row.appendChild(label);
    row.appendChild(input);
    return row;
}

// Возвращает минимально допустимый масштаб (в %) для конкретной аватарки,
// чтобы картинка полностью закрывала контейнер (cover). Если посчитать нельзя — null.
async function getMinScalePercent(avatarEl, key) {
    if (!avatarEl) return null;

    // Находим URL оригинала
    let originalUrl = originalUrlCache.get(key);
    if (originalUrl === undefined) {
        originalUrl = await findWorkingOriginalUrl(key);
    }
    const img = avatarEl.querySelector(':scope > img');
    if (!originalUrl && img) originalUrl = img.getAttribute('src');
    if (!originalUrl) return null;

    const imgSize = await getImageSize(originalUrl);
    const rect = avatarEl.getBoundingClientRect();
    if (!imgSize || !rect.width || !rect.height) return null;

    const bounds = computeBounds(rect.width, rect.height, imgSize.w, imgSize.h);
    if (!bounds || !bounds.minScale) return null;

    return Math.ceil(bounds.minScale * 100);
}

async function openPanel(img, anchorBtn, avatarEl) {
    closePanel();
    const key = getAvatarKey(img.getAttribute('src'));
    if (!key) return;

    // Заранее прогреваем поиск оригинала
    findWorkingOriginalUrl(key);

    const settings = getAvatarSettings(key);
    const displayName = key.split(':')[1] || key;

    const panel = document.createElement('div');
    panel.className = 'aa-panel';

    const header = document.createElement('div');
    header.className = 'aa-panel-header';

    const title = document.createElement('div');
    title.className = 'aa-panel-title';
    title.textContent = 'Аватарка';
    title.title = 'Аватарка';


    const closeBtn = document.createElement('div');
    closeBtn.className = 'aa-panel-close';
    closeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';

    header.appendChild(title);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    const state = { ...settings };

    const rows = [
        ['Масштаб', 'scale'],
        ['Сдвиг X', 'x'],
        ['Сдвиг Y', 'y'],
        ['Поворот', 'rotate'],
    ];

        rows.forEach(([labelText, prop]) => {
        panel.appendChild(makeSliderRow(labelText, prop, state));
    });

    // ── Подстраиваем минимум ползунка "Масштаб" под реальную аватарку ──
    (async () => {
        const minScalePercent = await getMinScalePercent(avatarEl, key);
        if (minScalePercent) {
            const scaleInput = panel.querySelector('input[data-prop="scale"]');
            if (scaleInput) {
                scaleInput.min = minScalePercent;
                // Если текущее значение ниже минимума — подтягиваем к минимуму
                if (parseInt(scaleInput.value, 10) < minScalePercent) {
                    scaleInput.value = minScalePercent;
                    state.scale = minScalePercent;
                    saveAvatarSettings(key, state);
                    await applyToAllMatching(key);
                }
            }
        }
    })();


    const actions = document.createElement('div');
    actions.className = 'aa-panel-actions';

    const resetBtn = document.createElement('button');
    resetBtn.className = 'aa-btn aa-btn-reset';
    resetBtn.innerHTML = '<i class="fa-solid fa-rotate-left"></i> Сбросить';

    const doneBtn = document.createElement('button');
    doneBtn.className = 'aa-btn aa-btn-done';
    doneBtn.innerHTML = '<i class="fa-solid fa-check"></i> Готово';

    actions.appendChild(resetBtn);
    actions.appendChild(doneBtn);
    panel.appendChild(actions);

    document.body.appendChild(panel);
    currentPanel = panel;

    const isMobile = window.matchMedia('(hover: none), (pointer: coarse), (max-width: 768px)').matches;

    if (!isMobile) {
        const rect = anchorBtn.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        let left = rect.right + 8;
        let top = rect.top;
        if (left + panelRect.width > window.innerWidth - 10) {
            left = rect.left - panelRect.width - 8;
        }
        if (left < 10) left = 10;
        if (top + panelRect.height > window.innerHeight - 10) {
            top = window.innerHeight - panelRect.height - 10;
        }
        if (top < 10) top = 10;
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
    }
    // На мобилке позицию задаёт CSS-медиазапрос (bottom по центру) — JS координаты не трогаем


    panel.querySelectorAll('input[type="range"]').forEach(input => {
        input.addEventListener('input', async () => {
            const prop = input.dataset.prop;
            const val = parseInt(input.value, 10);
            state[prop] = val;
            saveAvatarSettings(key, state);
            await applyToAllMatching(key);
        });
    });


    resetBtn.addEventListener('click', async () => {
        Object.assign(state, DEFAULTS);
        panel.querySelectorAll('input[type="range"]').forEach(input => {
            const prop = input.dataset.prop;
            input.value = state[prop];
        });
        saveAvatarSettings(key, state);
        await applyToAllMatching(key);
    });


    closeBtn.addEventListener('click', closePanel);
    doneBtn.addEventListener('click', closePanel);

    panelOpenedAt = Date.now();
    document.addEventListener('mousedown', onOutsideClick);
    document.addEventListener('touchstart', onOutsideClick, { passive: true });

}

function initObserver() {
    const chat = document.getElementById('chat');
    if (!chat) {
        setTimeout(initObserver, 500);
        return;
    }

    let processScheduled = false;
    const scheduleProcess = () => {
        if (processScheduled) return;
        processScheduled = true;
        requestAnimationFrame(() => {
            processScheduled = false;
            processChatAvatars();
        });
    };

    const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
            if (m.addedNodes.length > 0) {
                scheduleProcess();
                return;
            }
            if (m.type === 'attributes' && m.attributeName === 'src') {
                if (m.target.tagName === 'IMG' && m.target.closest('#chat .mes .avatar')) {
                    const avatarEl = m.target.closest('.avatar');
                    if (avatarEl) applyToAvatarEl(avatarEl);
                }
            }
        }
    });

    observer.observe(chat, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src'],
    });

    processChatAvatars();
}

jQuery(async () => {
    initSettings();
    initObserver();
    log('loaded');
});
