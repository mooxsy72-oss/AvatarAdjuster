import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

const MODULE_NAME = 'AvatarAdjuster';
const VERSION = '2.4.0';
const DEBUG = true;

// Версия схемы настроек. v3: настройки хранятся ПО ТЕМАМ.
// Подгонка аватарки осмысленна только внутри той темы, для которой её делали:
// у другой темы другой контейнер, другая обрезка, другая вёрстка. Поэтому при
// смене темы её набор настроек пустой — а пустой набор означает, что оверлей
// снимается полностью, то есть ровно то же, что делает кнопка «Сбросить».
const SCHEMA = 3;

const log = (...args) => { if (DEBUG) console.log(`[${MODULE_NAME} v${VERSION}]`, ...args); };

const RANGES = {
    scale:  { min: 100,  max: 400, step: 1 },   // % ; 100 = ровно как рисует тема
    x:      { min: -100, max: 100, step: 1 },   // % от доступного хода
    y:      { min: -100, max: 100, step: 1 },   // % от доступного хода
    rotate: { min: -180, max: 180, step: 1 },
};

const DEFAULTS = {
    scale: 100,
    x: 0,
    y: 0,
    rotate: 0,
};

// Состояние активного перетаскивания ползунка: { key, settings }.
// Сохранение отложено до отпускания ползунка (иначе тормозит телефон),
// поэтому параллельный applyToAvatarEl (новое сообщение, ресайз) должен
// видеть живые значения, а не устаревшие сохранённые.
let liveOverride = null;

function initSettings() {
    const store = extension_settings[MODULE_NAME] ?? (extension_settings[MODULE_NAME] = {});

    if (store.schema !== SCHEMA) {
        const from = store.schema ?? 1;
        delete store.avatars;          // плоское хранилище из v1/v2
        store.themes = {};
        store.schema = SCHEMA;
        saveSettingsDebounced();
        log(`хранилище v${from} → v${SCHEMA}: настройки теперь привязаны к теме`);
    }
    if (!store.themes) store.themes = {};
}

// ── Идентичность темы ──
// Имя темы из селектора ST + длина пользовательского CSS: второе нужно, чтобы
// правка CSS руками (имя темы при этом не меняется) тоже считалась сменой.
function getThemeId() {
    let name = '';
    try {
        name = document.querySelector('#themes')?.value || '';
        if (!name) {
            const ctx = window.SillyTavern?.getContext?.();
            name = ctx?.powerUserSettings?.theme || ctx?.power_user?.theme || '';
        }
    } catch {}

    let cssLen = 0;
    try {
        const box = document.querySelector('#customCSS');
        if (box && typeof box.value === 'string') {
            cssLen = box.value.length;
        } else {
            const styleEl = document.querySelector('#custom-style');
            cssLen = (styleEl?.textContent || '').length;
        }
    } catch {}

    return `${name || 'default'}#${cssLen}`;
}

let currentThemeId = null;

function getThemeBucket(themeId = currentThemeId) {
    const store = extension_settings[MODULE_NAME];
    const id = themeId || 'default';
    if (!store.themes[id]) store.themes[id] = {};
    return store.themes[id];
}

function hasStoredSettings(key) {
    const store = extension_settings[MODULE_NAME];
    const bucket = store.themes?.[currentThemeId || 'default'];
    return !!(bucket && bucket[key]);
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
        // fallback: имя файла без query (?_agb= и т.п. от AvatarGallery)
        const clean = imgSrc.split('#')[0].split('?')[0];
        const parts = clean.split('/');
        return `raw:${decodeURIComponent(parts[parts.length - 1])}`;
    } catch (e) {
        return null;
    }
}

function getAvatarSettings(key) {
    if (!key) return { ...DEFAULTS };
    const saved = getThemeBucket()[key];
    return { ...DEFAULTS, ...(saved || {}) };
}

function saveAvatarSettings(key, settings) {
    if (!key) return;
    const bucket = getThemeBucket();
    const isDefault = Object.keys(DEFAULTS).every(k => settings[k] === DEFAULTS[k]);
    if (isDefault) {
        delete bucket[key];
    } else {
        bucket[key] = { ...settings };
    }
    saveSettingsDebounced();
}

// ============================================================
//  Геометрия применяется к САМОМУ <img> темы
// ============================================================
//
// Раньше картинка рисовалась в отдельном слое-div, а `img` скрывался. Из-за
// этого ломались все эффекты и формы, которые темы вешают на
// `.mes .avatar img`: полупрозрачность, размытие, затемнение, clip-path
// (сердечки и прочие формы), маски. Теперь мы не подменяем элемент, а
// настраиваем его же — поэтому всё это продолжает работать само, включая
// hover-состояния, анимации и псевдоэлементы, которые скопировать было бы
// нельзя в принципе.

// Свойства, которые мы выставляем сами и, значит, обязаны уметь убрать.
const OWNED_IMG_PROPS = [
    'width', 'height', 'object-fit', 'object-position',
    'transform', 'transform-origin',
];

// Убирает следы расширения: инлайновые стили и слои прошлых версий.
function clearOwnStyles(avatarEl) {
    const img = avatarEl.querySelector(':scope > img');
    if (img) OWNED_IMG_PROPS.forEach(p => img.style.removeProperty(p));
    avatarEl.style.removeProperty('overflow');

    // DOM от версий 1.x–2.2 (слой + клиппер)
    avatarEl.querySelector(':scope > .aa-clip')?.remove();
    avatarEl.querySelector(':scope > .aa-original-layer')?.remove();
    avatarEl.classList.remove('aa-has-original');
    if (avatarEl.dataset.aaPositioned === '1') {
        avatarEl.style.removeProperty('position');
        delete avatarEl.dataset.aaPositioned;
    }
}

// clientWidth/Height = padding-box, без бордеров и без влияния transform.
function getContainerSize(el) {
    let w = el.clientWidth;
    let h = el.clientHeight;
    if (!w || !h) {
        const r = el.getBoundingClientRect();
        w = r.width;
        h = r.height;
    }
    return (w && h) ? { w, h } : null;
}

// Во сколько раз надо увеличить повёрнутый прямоугольник, чтобы он всё ещё
// полностью закрывал контейнер. Зависит только от пропорций контейнера.
function rotationCoverFactor(deg, size) {
    const r = ((deg % 180) + 180) % 180;
    if (r === 0 || !size) return 1;
    const rad = r * Math.PI / 180;
    const c = Math.abs(Math.cos(rad));
    const s = Math.abs(Math.sin(rad));
    const { w, h } = size;
    return Math.max((w * c + h * s) / w, (w * s + h * c) / h);
}

// Единственное место, где значения уезжают в CSS.
//
// Модель:
//   • object-fit: cover — картинка заполняет контейнер. Ставится инлайном с
//     !important, потому что темы часто пишут размеры `img` без !important и
//     проигрывают стилям ST: контейнер растягивается, а картинка внутри
//     остаётся мелкой.
//   • Сдвиг = % от ДОСТУПНОГО хода, а не пиксели, поэтому смена темы или
//     размера контейнера пересчитывается сама:
//       – object-position 0…100% — ход по обрезке cover (есть уже на 100%);
//       – translate ±(s−1)/2    — ход, появившийся от зума.
//     Оба двигают картинку в одну сторону: один ползунок = один смысл.
//   • overflow: hidden на контейнере включается ТОЛЬКО при зуме или повороте.
//     На дефолте тема не трогается, и её декорации, выходящие за границы
//     аватарки, продолжают рисоваться.
function applyGeometry(avatarEl, img, settings, size) {
    const userScale = Math.max(1, (settings.scale || 100) / 100);
    const rotate = settings.rotate || 0;
    const fx = Math.max(-1, Math.min(1, (settings.x || 0) / 100));
    const fy = Math.max(-1, Math.min(1, (settings.y || 0) / 100));

    img.style.setProperty('width', '100%', 'important');
    img.style.setProperty('height', '100%', 'important');
    img.style.setProperty('object-fit', 'cover', 'important');
    img.style.setProperty('object-position',
        `${50 + fx * 50}% ${50 + fy * 50}%`, 'important');

    const travel = (userScale - 1) * 50;
    const parts = [];
    if (travel) parts.push(`translate(${-fx * travel}%, ${-fy * travel}%)`);
    if (rotate) parts.push(`rotate(${rotate}deg)`);

    const scaleEff = userScale * rotationCoverFactor(rotate, size);
    if (scaleEff !== 1) parts.push(`scale(${scaleEff.toFixed(4)})`);

    if (parts.length) {
        img.style.setProperty('transform', parts.join(' '), 'important');
        img.style.setProperty('transform-origin', 'center center', 'important');
    } else {
        img.style.removeProperty('transform');
        img.style.removeProperty('transform-origin');
    }

    // Обрезка нужна только когда картинка реально выходит за контейнер
    if (userScale > 1 || rotate) {
        avatarEl.style.setProperty('overflow', 'hidden', 'important');
    } else {
        avatarEl.style.removeProperty('overflow');
    }
}

// Применение к элементу .avatar
function applyToAvatarEl(avatarEl) {
    const img = avatarEl.querySelector(':scope > img');
    if (!img) return;
    const key = getAvatarKey(img.getAttribute('src'));
    if (!key) return;

    // Слои от версий 1.x–2.2, если остались в DOM
    avatarEl.querySelector(':scope > .aa-clip')?.remove();
    avatarEl.querySelector(':scope > .aa-original-layer')?.remove();
    avatarEl.classList.remove('aa-has-original');

    const isLive = !!(liveOverride && liveOverride.key === key);
    const settings = isLive
        ? { ...DEFAULTS, ...liveOverride.settings }
        : getAvatarSettings(key);

    applyGeometry(avatarEl, img, settings, getContainerSize(avatarEl));
}

function applyToAllMatching(key) {
    document.querySelectorAll('#chat .mes .avatar').forEach(avatarEl => {
        const img = avatarEl.querySelector(':scope > img');
        if (!img) return;
        if (getAvatarKey(img.getAttribute('src')) === key) {
            applyToAvatarEl(avatarEl);
        }
    });
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

// ── Реакция на изменение РАЗМЕРА контейнера ──
// Смена темы не создаёт ни новых нод, ни смены src, поэтому MutationObserver
// её не видел. Сами проценты пересчитываются в CSS автоматически, но добавка
// на поворот зависит от пропорций контейнера — её надо переприменить.
const observedAvatars = new WeakSet();
let sizeObserver = null;
let sizePassScheduled = false;

function initSizeObserver() {
    if (sizeObserver || typeof ResizeObserver === 'undefined') return;
    sizeObserver = new ResizeObserver(() => {
        if (sizePassScheduled) return;
        sizePassScheduled = true;
        requestAnimationFrame(() => {
            sizePassScheduled = false;
            document.querySelectorAll('#chat .mes .avatar')
                .forEach(avatarEl => applyToAvatarEl(avatarEl));
        });
    });
}

function observeAvatarSize(avatarEl) {
    if (!sizeObserver || observedAvatars.has(avatarEl)) return;
    observedAvatars.add(avatarEl);
    sizeObserver.observe(avatarEl);
}

function processChatAvatars() {
    document.querySelectorAll('#chat .mes .avatar').forEach(avatarEl => {
        ensureEditButton(avatarEl);
        observeAvatarSize(avatarEl);
        applyToAvatarEl(avatarEl);
    });
}

// ── Смена темы ──
// То, что делает кнопка «Сбросить», но автоматически: оверлей снимается
// ПОЛНОСТЬЮ (вместе с классом .aa-has-original и нашим инлайновым position),
// и только потом применяются настройки новой темы — если они для неё есть.
function teardownAllStyles() {
    document.querySelectorAll('#chat .mes .avatar').forEach(clearOwnStyles);
}

function applyThemeChange(newThemeId) {
    const prev = currentThemeId;
    currentThemeId = newThemeId;
    liveOverride = null;
    closePanel();               // панель принадлежала прошлой теме
    teardownAllStyles();        // сначала снять своё, потом применить новое
    processChatAvatars();
    log(`тема сменилась: "${prev}" → "${newThemeId}". Свои стили сняты, ` +
        `применён набор настроек новой темы (${Object.keys(getThemeBucket()).length} шт.)`);
}

function initThemeWatcher() {
    currentThemeId = getThemeId();
    log(`текущая тема: "${currentThemeId}"`);

    let checkScheduled = false;
    const checkTheme = () => {
        if (checkScheduled) return;
        checkScheduled = true;
        setTimeout(() => {
            checkScheduled = false;
            const id = getThemeId();
            if (id !== currentThemeId) applyThemeChange(id);
        }, 150);
    };

    // 1) селектор тем и поле пользовательского CSS
    document.addEventListener('change', (e) => {
        if (e.target?.id === 'themes' || e.target?.id === 'customCSS') checkTheme();
    }, true);
    document.addEventListener('input', (e) => {
        if (e.target?.id === 'customCSS') checkTheme();
    }, true);

    // 2) сам инжектированный <style>: ловит любой способ применения темы,
    //    включая импорт файла и программную установку
    const head = document.head;
    if (head) {
        new MutationObserver(checkTheme).observe(head, {
            childList: true,
            subtree: true,
            characterData: true,
        });
    }

    // 3) события ST, если доступны
    try {
        const ctx = window.SillyTavern?.getContext?.();
        const ev = ctx?.eventSource;
        const et = ctx?.eventTypes ?? ctx?.event_types;
        if (ev && et) {
            [et.SETTINGS_UPDATED, et.APP_READY, et.EXTRAS_CONNECTED]
                .forEach(e => { if (e) { try { ev.on(e, checkTheme); } catch {} } });
        }
    } catch {}

    // 4) страховка на случай способа, который мы не предусмотрели
    setInterval(checkTheme, 3000);
}

// Диагностика: в консоли вызвать AvatarAdjusterDebug()
window.AvatarAdjusterDebug = function () {
    const rows = [];
    document.querySelectorAll('#chat .mes .avatar').forEach((el, i) => {
        const img = el.querySelector(':scope > img');
        const key = img ? getAvatarKey(img.getAttribute('src')) : null;
        const cs = window.getComputedStyle(el);
        const is = img ? window.getComputedStyle(img) : null;
        const box = (n) => n
            ? `${Math.round(n.getBoundingClientRect().width)}×${Math.round(n.getBoundingClientRect().height)}`
            : '—';

        rows.push({
            '#': i,
            key,
            'контейнер': `${el.clientWidth}×${el.clientHeight}`,
            'img на экране': box(img),
            'img natural': img ? `${img.naturalWidth}×${img.naturalHeight}` : '—',
            'object-fit': is ? is.objectFit : '—',
            'object-position': is ? is.objectPosition : '—',
            'transform': is ? is.transform : '—',
            // эффекты и формы темы — должны остаться НЕ тронутыми нами
            'filter': is ? is.filter : '—',
            'opacity': is ? is.opacity : '—',
            'clip-path': is ? is.clipPath : '—',
            'border-radius': is ? is.borderRadius : '—',
            'маска img': is && (is.maskImage !== 'none' || is.webkitMaskImage !== 'none') ? 'да' : 'нет',
            'маска .avatar': (cs.maskImage !== 'none' || cs.webkitMaskImage !== 'none') ? 'да' : 'нет',
            'overflow': cs.overflow,
            'настройки': key
                ? (hasStoredSettings(key) ? JSON.stringify(getAvatarSettings(key)) : 'дефолт')
                : '—',
        });
    });
    console.log(`[${MODULE_NAME} v${VERSION}] тема: "${currentThemeId}"`);
    console.table(rows);
    return rows;
};

// ============================================================
//  Панель
// ============================================================

let currentPanel = null;
let panelOpenedAt = 0;

function closePanel() {
    if (currentPanel) {
        currentPanel.remove();
        currentPanel = null;
        liveOverride = null;
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

function makeSliderRow(icon, hint, prop, state) {
    const range = RANGES[prop];
    const row = document.createElement('div');
    row.className = 'aa-row';

    const label = document.createElement('label');
    label.className = 'aa-icon';
    label.innerHTML = `<i class="fa-solid ${icon}"></i>`;
    label.title = hint;

    const input = document.createElement('input');
    input.type = 'range';
    input.min = range.min;
    input.max = range.max;
    input.step = range.step;
    input.value = state[prop];
    input.dataset.prop = prop;
    input.title = hint;

    row.appendChild(label);
    row.appendChild(input);
    return row;
}

async function openPanel(img, anchorBtn, avatarEl) {
    closePanel();
    const key = getAvatarKey(img.getAttribute('src'));
    if (!key) return;

    const settings = getAvatarSettings(key);

    const panel = document.createElement('div');
    panel.className = 'aa-panel';

    const header = document.createElement('div');
    header.className = 'aa-panel-header';

    const title = document.createElement('div');
    title.className = 'aa-panel-title';
    title.innerHTML = '<i class="fa-solid fa-image"></i>';
    title.title = 'Аватарка';

    const closeBtn = document.createElement('div');
    closeBtn.className = 'aa-panel-close';
    closeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';

    header.appendChild(title);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    const state = { ...settings };

    const rows = [
        ['fa-magnifying-glass-plus', 'Масштаб', 'scale'],
        ['fa-arrows-left-right',     'Влево / вправо', 'x'],
        ['fa-arrows-up-down',        'Вверх / вниз', 'y'],
        ['fa-rotate',                'Поворот', 'rotate'],
    ];

    rows.forEach(([icon, hint, prop]) => {
        panel.appendChild(makeSliderRow(icon, hint, prop, state));
    });

    const actions = document.createElement('div');
    actions.className = 'aa-panel-actions';

    const resetBtn = document.createElement('button');
    resetBtn.className = 'aa-btn aa-btn-reset';
    resetBtn.innerHTML = '<i class="fa-solid fa-rotate-left"></i>';
    resetBtn.title = 'Сбросить';

    const doneBtn = document.createElement('button');
    doneBtn.className = 'aa-btn aa-btn-done';
    doneBtn.innerHTML = '<i class="fa-solid fa-check"></i>';
    doneBtn.title = 'Готово';

    actions.appendChild(resetBtn);
    actions.appendChild(doneBtn);
    panel.appendChild(actions);

    document.body.appendChild(panel);
    currentPanel = panel;

    const panelRect = panel.getBoundingClientRect();
    const isMobile = window.innerWidth <= 768;

    if (isMobile) {
        const w = Math.min(window.innerWidth - 24, 300);
        panel.style.width = `${w}px`;
        panel.style.minWidth = '0px';
        panel.style.maxHeight = '70vh';
        panel.style.overflowY = 'auto';
        panel.style.left = `${Math.round((window.innerWidth - w) / 2)}px`;
        panel.style.top = `${Math.round(window.innerHeight - panelRect.height - 12)}px`;
    } else {
        const rect = anchorBtn.getBoundingClientRect();
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

    // Целевые слои и их размеры собираем ОДИН раз: раньше на каждый тик
    // ползунка шёл querySelectorAll по всему чату с разбором URL каждой
    // аватарки — именно это и тормозило на телефоне.
    let liveTargets = [];
    function collectLiveTargets() {
        liveTargets = [];
        document.querySelectorAll('#chat .mes .avatar').forEach(el => {
            const elImg = el.querySelector(':scope > img');
            if (!elImg || getAvatarKey(elImg.getAttribute('src')) !== key) return;
            liveTargets.push({ avatarEl: el, img: elImg, size: getContainerSize(el) });
        });
    }
    collectLiveTargets();

    // Живое превью: только запись CSS-переменных, не чаще раза за кадр.
    // Ни чтений layout, ни загрузки картинок, ни записи настроек.
    let rafId = 0;
    const scheduleLivePreview = () => {
        if (rafId) return;
        rafId = requestAnimationFrame(() => {
            rafId = 0;
            liveTargets.forEach(({ avatarEl: el, img: elImg, size }) => {
                applyGeometry(el, elImg, state, size);
            });
        });
    };

    let lastCommitted = JSON.stringify(state);
    let committedOnce = false;

    const commit = async () => {
        // Защита от двойного прогона (change и pointerup приходят вместе)
        const snapshot = JSON.stringify(state);
        if (committedOnce && snapshot === lastCommitted) return;
        lastCommitted = snapshot;
        committedOnce = true;

        saveAvatarSettings(key, state);
        liveOverride = null;
        await applyToAllMatching(key);
        collectLiveTargets();
    };

    panel.querySelectorAll('input[type="range"]').forEach(input => {
        input.addEventListener('input', () => {
            state[input.dataset.prop] = parseInt(input.value, 10);
            liveOverride = { key, settings: state };
            if (!liveTargets.length) {
                // слоя ещё нет (настройки были дефолтными) — создаём обычным путём
                commit();
                return;
            }
            scheduleLivePreview();
        });

        // Сохранение — только когда ползунок отпустили
        const onRelease = () => {
            state[input.dataset.prop] = parseInt(input.value, 10);
            commit();
        };
        input.addEventListener('change', onRelease);
        // Страховка: на части мобильных браузеров `change` у range ненадёжен
        input.addEventListener('pointerup', onRelease);
        input.addEventListener('touchend', onRelease, { passive: true });
    });

    resetBtn.addEventListener('click', async () => {
        Object.assign(state, DEFAULTS);
        panel.querySelectorAll('input[type="range"]').forEach(input => {
            input.value = state[input.dataset.prop];
        });
        await commit();
    });

    closeBtn.addEventListener('click', closePanel);
    doneBtn.addEventListener('click', closePanel);

    panelOpenedAt = Date.now();
    document.addEventListener('mousedown', onOutsideClick);
    document.addEventListener('touchstart', onOutsideClick, { passive: true });
}

// ============================================================
//  Наблюдение за чатом
// ============================================================

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
                    if (avatarEl) {
                        // Картинка сменилась (напр. через AvatarGallery)
                        applyToAvatarEl(avatarEl);
                    }
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

function reprocessAllAvatars() {
    document.querySelectorAll('#chat .mes .avatar').forEach(avatarEl => {
        applyToAvatarEl(avatarEl);
    });
}

jQuery(async () => {
    initSettings();
    initThemeWatcher();   // до initObserver: он сразу применяет настройки темы
    initSizeObserver();
    initObserver();

    try {
        const ctx = window.SillyTavern?.getContext?.();
        const ev = ctx?.eventSource;
        const et = ctx?.eventTypes ?? ctx?.event_types;
        if (ev && et) {
            const handler = () => setTimeout(reprocessAllAvatars, 300);
            [et.CHAT_CHANGED, et.CHARACTER_SELECTED, et.PERSONA_CHANGED,
             et.MESSAGE_RECEIVED, et.USER_MESSAGE_RENDERED,
             et.CHARACTER_MESSAGE_RENDERED].forEach(e => {
                if (e) { try { ev.on(e, handler); } catch {} }
            });
        }
    } catch {}

    log('loaded');
});
