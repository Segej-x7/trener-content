// ============================================
// app.js
// Загрузка данных с сервера, тесты, сайты, гео, расписание
// ============================================

// ============================================
// БАЗОВЫЙ URL
// Приоритет: AndroidBridge → ?base= → localStorage → location.origin
// ============================================
const BASE_URL = (() => {
    // 1. AndroidBridge (WebView-обёртка)
    if (window.AndroidBridge && typeof window.AndroidBridge.getBaseUrl === 'function') {
        const base = window.AndroidBridge.getBaseUrl();
        if (base) {
            const clean = base.replace(/\/+$/, '');
            localStorage.setItem('appBaseUrl', clean);
            return clean;
        }
    }
    // 2. Query-параметр ?base=
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get('base');
    if (fromQuery) {
        const clean = fromQuery.replace(/\/+$/, '');
        localStorage.setItem('appBaseUrl', clean);
        return clean;
    }
    // 3. GitHub Pages: автодетект имени репозитория из пути
    if (location.hostname.endsWith('github.io')) {
        const parts = location.pathname.split('/').filter(Boolean);
        if (parts.length > 0) {
            const auto = `${location.origin}/${parts[0]}`;
            localStorage.setItem('appBaseUrl', auto);
            return auto;
        }
    }
    // 4. Сохранённое значение (локальная разработка)
    const saved = localStorage.getItem('appBaseUrl');
    if (saved) return saved.replace(/\/+$/, '');
    // 5. Fallback
    return location.origin;
})();

function url(path) {
    return `${BASE_URL}/${path.replace(/^\/+/, '')}`;
}
console.log('🌐 BASE_URL =', BASE_URL);

// ============================================
// СОСТОЯНИЕ
// ============================================
let currentTest = null;
let userAnswers = {};
let serverOffset = 0;
let serverSynced = false;
let lastPosition = null;
let lastPositionPromise = null;

function now() { return Date.now() + serverOffset; }

// ============================================
// DOM
// ============================================
const menuScreen   = document.getElementById('menu-screen');
const quizScreen   = document.getElementById('quiz-screen');
const sitesScreen  = document.getElementById('sites-screen');

const htmlTopicsContainer = document.getElementById('html-topics');
const cssTopicsContainer  = document.getElementById('css-topics');
const jsTopicsContainer   = document.getElementById('js-topics');

const quizTitle = document.getElementById('quiz-title');
const testDescription = document.getElementById('test-description');
const quizContainer = document.getElementById('quiz-container');

const checkBtn = document.getElementById('check-btn');
const resetBtn = document.getElementById('reset-btn');
const backBtn  = document.getElementById('back-btn');

const resultContainer = document.getElementById('result-container');
const scoreDisplay = document.getElementById('score-display');
const detailedResults = document.getElementById('detailed-results');

const sitesList    = document.getElementById('sites-list');
const sitesBackBtn = document.getElementById('sites-back-btn');
const geoStatusEl  = document.getElementById('geo-status');
const openSitesBtn = document.getElementById('open-sites-btn');

const timeStatusEl = document.getElementById('time-status');

// ============================================
// УТИЛИТЫ
// ============================================
function shuffleArray(a) {
    a = [...a];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function shuffleOptions(q) {
    const withMeta = q.options.map((text, i) => ({ text, isCorrect: q.correct.includes(i) }));
    const sh = shuffleArray(withMeta);
    const newCorrect = [];
    sh.forEach((o, i) => { if (o.isCorrect) newCorrect.push(i); });
    return { ...q, options: sh.map(o => o.text), correct: newCorrect };
}

function prepareTest(t) {
    return { ...t, questions: shuffleArray(t.questions).map(shuffleOptions) };
}

function arraysEqual(a, b) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
}

function escapeHtml(t) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return String(t).replace(/[&<>"']/g, m => map[m]);
}

function getByPath(obj, path) {
    return path.split('.').reduce((a, k) => (a == null ? a : a[k]), obj);
}

// Формула Хаверсина — расстояние между двумя точками в метрах
function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
              Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

// ============================================
// ГЕОПОЗИЦИЯ С КЭШЕМ
// ============================================
function getCurrentPosition(force = false) {
    const cacheMs = window.CONFIG?.geolocation?.cachePositionMs ?? 30000;

    if (!force && lastPosition && (Date.now() - lastPosition.timestamp < cacheMs)) {
        return Promise.resolve(lastPosition);
    }
    if (lastPositionPromise && !force) {
        return lastPositionPromise;
    }

    const cfg = window.CONFIG?.geolocation || {};
    const options = {
        enableHighAccuracy: cfg.enableHighAccuracy ?? true,
        timeout: cfg.timeoutMs ?? 10000,
        maximumAge: cfg.maximumAge ?? 60000
    };

    lastPositionPromise = new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
            lastPositionPromise = null;
            return reject(new Error('Геолокация не поддерживается устройством'));
        }
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                lastPosition = {
                    lat: pos.coords.latitude,
                    lon: pos.coords.longitude,
                    accuracy: pos.coords.accuracy,
                    timestamp: Date.now()
                };
                lastPositionPromise = null;
                resolve(lastPosition);
            },
            (err) => {
                lastPositionPromise = null;
                const messages = {
                    1: 'Доступ к геолокации запрещён',
                    2: 'Позиция недоступна',
                    3: 'Превышено время ожидания GPS'
                };
                reject(new Error(messages[err.code] || 'Ошибка геолокации'));
            },
            options
        );
    });

    return lastPositionPromise;
}

// ============================================
// ПРОВЕРКА ГЕОЗОНЫ
// ============================================
function checkGeofence(site, position) {
    const gf = site.geofence;
    if (!gf) return { ok: true };

    if (!position) {
        return { ok: false, reason: 'Нет данных о геопозиции' };
    }

    const distance = haversineMeters(position.lat, position.lon, gf.lat, gf.lon);

    if (distance <= gf.radiusMeters) {
        return { ok: true, distance };
    }

    return {
        ok: false,
        distance,
        reason: `Вы находитесь в ${Math.round(distance)} м от нужной точки (макс. ${gf.radiusMeters} м)`
    };
}

// ============================================
// ПРОВЕРКА РАСПИСАНИЯ (по серверному времени)
// ============================================
function checkSchedule(site) {
    const sc = site.schedule;
    if (!sc) return { ok: true };

    const currentDate = new Date(now());
    const tz = sc.timezone || 'UTC';

    const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' });
    const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const currentDay = dayMap[dayFmt.format(currentDate)];

    const timeFmt = new Intl.DateTimeFormat('ru-RU', {
        timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false
    });
    const currentTimeStr = timeFmt.format(currentDate);

    const [curH, curM] = currentTimeStr.split(':').map(Number);
    const [fromH, fromM] = sc.from.split(':').map(Number);
    const [toH, toM]     = sc.to.split(':').map(Number);

    const curMin  = curH * 60 + curM;
    const fromMin = fromH * 60 + fromM;
    const toMin   = toH * 60 + toM;

    const dayOk = Array.isArray(sc.days) && sc.days.includes(currentDay);

    let timeOk;
    if (fromMin <= toMin) {
        timeOk = curMin >= fromMin && curMin <= toMin;
    } else {
        timeOk = curMin >= fromMin || curMin <= toMin;
    }

    const dayNames = ['вс','пн','вт','ср','чт','пт','сб'];

    if (dayOk && timeOk) return { ok: true, currentDay, currentTimeStr };

    return {
        ok: false,
        currentDay,
        currentTimeStr,
        reason: `Доступ только: ${sc.days.map(d => dayNames[d]).join(', ')} в ${sc.from}–${sc.to} (${tz}). Сейчас: ${currentTimeStr}, ${dayNames[currentDay]}`
    };
}

// ============================================
// ЗАГРУЗКА С СЕРВЕРА
// ============================================
async function fetchJson(path) {
    const res = await fetch(url(path), { cache: 'no-store' });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
}

async function loadConfig() {
    try {
        const cfg = await fetchJson('config.json');
        window.setConfig(cfg);
        console.log('✅ config.json загружен');
        return cfg;
    } catch (e) {
        console.error('❌ config.json:', e);
        return null;
    }
}

async function loadSites() {
    try {
        const cfg = window.CONFIG;
        const sitesFile = cfg?.access?.sitesFile || 'access/sites.json';
        const data = await fetchJson(sitesFile);
        window.setSitesConfig(data);
        console.log(`✅ sites.json загружен (${data.sites?.length || 0})`);
        return data;
    } catch (e) {
        console.error('❌ sites.json:', e);
        return null;
    }
}

async function loadAllTests() {
    try {
        const cfg = window.CONFIG;
        const indexFile = cfg?.tests?.indexFile || 'tests/index.json';
        const indexData = await fetchJson(indexFile);

        if (!Array.isArray(indexData.tests)) throw new Error('index.json: нет "tests"');

        const loaded = await Promise.all(
            indexData.tests.map(async (entry) => {
                try {
                    const t = await fetchJson(entry.file);
                    if (!t.id || !t.title || !Array.isArray(t.questions)) return null;
                    return t;
                } catch (err) {
                    console.error(`❌ ${entry.file}:`, err);
                    return null;
                }
            })
        );

        window.setTestRegistry(loaded.filter(Boolean));
        console.log(`✅ Загружено тестов: ${window.TEST_REGISTRY.length}`);
    } catch (e) {
        console.error('❌ Ошибка загрузки тестов:', e);
        window.setTestRegistry([]);
    }
}

// ============================================
// СИНХРОНИЗАЦИЯ ВРЕМЕНИ
// ============================================
async function syncTime() {
    const providers = window.CONFIG?.timeSource?.providers || [];
    for (const p of providers) {
        try {
            const res = await fetch(p.url, { cache: 'no-store' });
            if (!res.ok) continue;
            const json = await res.json();
            const raw = getByPath(json, p.path);
            if (raw == null) continue;

            const serverMs = raw * (p.multiplier || 1);
            if (!isFinite(serverMs) || serverMs <= 0) continue;

            serverOffset = serverMs - Date.now();
            serverSynced = true;
            updateTimeStatus(true, p.name);
            console.log(`⏱ Время: ${p.name} (offset ${serverOffset}ms)`);
            return true;
        } catch (err) {
            console.warn(`⚠️ ${p.name} недоступен`);
        }
    }
    serverSynced = false;
    updateTimeStatus(false);
    return false;
}

function updateTimeStatus(ok, sourceName) {
    if (!window.CONFIG?.ui?.showTimeSource || !timeStatusEl) return;

    if (ok) {
        timeStatusEl.className = 'time-status ok';
        const drift = Math.round(serverOffset / 1000);
        timeStatusEl.textContent = `⏱ ${sourceName} (${drift >= 0 ? '+' : ''}${drift}с)`;
    } else {
        timeStatusEl.className = 'time-status error';
        timeStatusEl.textContent = '⚠ Время не синхронизировано';
    }
}

// ============================================
// МЕНЮ
// ============================================
function renderMenu() {
    htmlTopicsContainer.innerHTML = '';
    cssTopicsContainer.innerHTML = '';
    jsTopicsContainer.innerHTML = '';

    window.TEST_REGISTRY.forEach(test => {
        const btn = document.createElement('button');
        btn.className = 'topic-btn';
        btn.textContent = test.title;
        btn.addEventListener('click', () => startTest(test.id));

        if (test.category === 'html')      htmlTopicsContainer.appendChild(btn);
        else if (test.category === 'css')  cssTopicsContainer.appendChild(btn);
        else if (test.category === 'js')   jsTopicsContainer.appendChild(btn);
    });
}

function initAccordion() {
    document.querySelectorAll('.category-header').forEach(header => {
        header.addEventListener('click', () => {
            const list = document.getElementById(header.dataset.target);
            const section = header.closest('.category-section');
            section.classList.toggle('open');
            list.classList.toggle('collapsed');
        });
    });
}

// ============================================
// ТЕСТ
// ============================================
function startTest(testId) {
    const test = window.TEST_REGISTRY.find(t => t.id === testId);
    if (!test) return;

    currentTest = prepareTest(test);
    userAnswers = {};

    menuScreen.classList.add('hidden');
    quizScreen.classList.remove('hidden');

    quizTitle.textContent = test.title;
    testDescription.textContent = test.description;

    checkBtn.style.display = 'inline-block';
    checkBtn.disabled = false;
    resetBtn.style.display = 'none';
    resultContainer.classList.add('hidden');
    scoreDisplay.innerHTML = '';
    detailedResults.innerHTML = '';

    renderQuiz();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderQuiz() {
    let html = '';
    currentTest.questions.forEach((q, index) => {
        html += `<div class="question-card" data-qid="${q.id}">`;
        html += `<h3>Вопрос ${index + 1}: ${escapeHtml(q.question)}</h3>`;
        if (q.type === 'multiple') html += `<p class="hint">Выберите несколько вариантов</p>`;

        q.options.forEach((option, optIndex) => {
            const type = q.type === 'multiple' ? 'checkbox' : 'radio';
            const name = q.type === 'multiple' ? `q${q.id}[]` : `q${q.id}`;
            html += `
                <label class="option-label">
                    <input type="${type}" name="${name}" value="${optIndex}" data-qid="${q.id}">
                    <span>${escapeHtml(option)}</span>
                </label>`;
        });
        html += `</div>`;
    });
    quizContainer.innerHTML = html;
    quizContainer.removeEventListener('change', handleAnswerChange);
    quizContainer.addEventListener('change', handleAnswerChange);
}

function handleAnswerChange(e) {
    const qid = parseInt(e.target.dataset.qid);
    if (!userAnswers[qid]) userAnswers[qid] = [];
    const q = currentTest.questions.find(x => x.id === qid);

    if (q.type === 'single') {
        userAnswers[qid] = [parseInt(e.target.value)];
    } else {
        const val = parseInt(e.target.value);
        if (e.target.checked) {
            if (!userAnswers[qid].includes(val)) userAnswers[qid].push(val);
        } else {
            userAnswers[qid] = userAnswers[qid].filter(v => v !== val);
        }
    }
}

function checkAnswers() {
    let score = 0;
    const total = currentTest.questions.length;
    let detailsHtml = '';

    currentTest.questions.forEach((q, index) => {
        const ua = userAnswers[q.id] || [];
        const correct = arraysEqual([...ua].sort(), [...q.correct].sort());
        if (correct) score++;

        const card = document.querySelector(`.question-card[data-qid="${q.id}"]`);
        card.querySelectorAll('.option-label').forEach((label, i) => {
            const input = label.querySelector('input');
            label.classList.remove('correct', 'incorrect');
            if (q.correct.includes(i)) label.classList.add('correct');
            else if (ua.includes(i)) label.classList.add('incorrect');
            input.disabled = true;
        });

        detailsHtml += `
            <div class="result-item ${correct ? 'success' : 'fail'}">
                <p><strong>Вопрос ${index + 1}:</strong> ${correct ? '✅ Верно' : '❌ Неверно'}</p>
                <p class="explanation">💡 ${escapeHtml(q.explanation)}</p>
            </div>`;
    });

    scoreDisplay.innerHTML = `Вы набрали <span>${score}</span> из <span>${total}</span>`;
    detailedResults.innerHTML = detailsHtml;
    resultContainer.classList.remove('hidden');

    checkBtn.style.display = 'none';
    resetBtn.style.display = 'inline-block';
    resetBtn.scrollIntoView({ behavior: 'smooth' });
}

function resetQuiz() {
    if (!currentTest) return;
    startTest(currentTest.id);
}

function goBackToMenu() {
    quizScreen.classList.add('hidden');
    menuScreen.classList.remove('hidden');
    currentTest = null;
    userAnswers = {};
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ============================================
// ЭКРАН САЙТОВ
// ============================================
function renderSites() {
    const cfg = window.SITES_CONFIG;
    if (!cfg || !Array.isArray(cfg.sites)) {
        sitesList.innerHTML = '<div class="empty">Нет доступных сайтов</div>';
        return;
    }

    sitesList.innerHTML = '';

    cfg.sites.forEach(site => {
        const card = document.createElement('div');
        card.className = 'site-card';
        card.dataset.siteId = site.id;

        const geoBadge = site.geofence
            ? `<span class="badge badge-geo">📍 ${escapeHtml(site.geofence.label || `${site.geofence.radiusMeters}м`)}</span>`
            : '';
        const schedBadge = site.schedule
            ? `<span class="badge badge-sched">🕐 ${site.schedule.from}–${site.schedule.to}</span>`
            : '';

        card.innerHTML = `
            <div class="site-icon">${site.icon || '🌐'}</div>
            <div class="site-body">
                <div class="site-name">${escapeHtml(site.name)}</div>
                <div class="site-meta">
                    <span>Лимит: ${Math.round(site.limitMs / 60000)} мин</span>
                    ${geoBadge}
                    ${schedBadge}
                </div>
                <div class="site-tests">
                    Тесты: ${site.requiredTestIds.map(id => {
                        const t = window.TEST_REGISTRY.find(x => x.id === id);
                        return `<span class="test-chip">${escapeHtml(t ? t.title : id)}</span>`;
                    }).join('')}
                </div>
            </div>
            <button class="site-open-btn" data-open-for="${site.id}">▶ Открыть</button>
        `;

        sitesList.appendChild(card);
    });

    sitesList.querySelectorAll('.site-open-btn').forEach(btn => {
        btn.addEventListener('click', () => tryOpenSite(btn.dataset.openFor));
    });

    updateGeoStatus();
}

async function updateGeoStatus() {
    if (!geoStatusEl) return;

    const hasGeo = (window.SITES_CONFIG?.sites || []).some(s => s.geofence);
    if (!hasGeo) {
        geoStatusEl.textContent = '';
        geoStatusEl.className = 'geo-status';
        return;
    }

    geoStatusEl.textContent = '📍 Определяем вашу геопозицию…';
    geoStatusEl.className = 'geo-status checking';

    try {
        const pos = await getCurrentPosition();
        geoStatusEl.textContent = `📍 Вы: ${pos.lat.toFixed(5)}, ${pos.lon.toFixed(5)} (±${Math.round(pos.accuracy)} м)`;
        geoStatusEl.className = 'geo-status ok';
    } catch (e) {
        geoStatusEl.textContent = `⚠️ Геолокация недоступна: ${e.message}`;
        geoStatusEl.className = 'geo-status error';
    }
}

async function tryOpenSite(siteId) {
    const cfg = window.SITES_CONFIG;
    const site = cfg.sites.find(s => s.id === siteId);
    if (!site) return;

    // 1. Расписание
    const sch = checkSchedule(site);
    if (!sch.ok) {
        alert(`🚫 ${sch.reason}`);
        return;
    }

    // 2. Гео
    if (site.geofence) {
        try {
            const pos = await getCurrentPosition(true);
            const geo = checkGeofence(site, pos);
            if (!geo.ok) {
                alert(`📍 ${geo.reason}\n\nЦелевая точка: ${site.geofence.label || ''}\nВы: ${pos.lat.toFixed(5)}, ${pos.lon.toFixed(5)}\nЦель: ${site.geofence.lat}, ${site.geofence.lon}`);
                return;
            }
        } catch (e) {
            alert(`⚠️ Не удалось получить геопозицию: ${e.message}`);
            return;
        }
    }

    // 3. Открываем
    openSiteContent(site);
}

function openSiteContent(site) {
    console.log('✅ Открываем сайт:', site.url);

    const win = window.open(site.url, '_blank');
    if (!win) {
        alert('Не удалось открыть окно. Разрешите всплывающие окна.');
        return;
    }

    setTimeout(() => {
        try { win.close(); } catch (e) {}
    }, site.limitMs);
}

// ============================================
// СЛУШАТЕЛИ
// ============================================
checkBtn.addEventListener('click', checkAnswers);
resetBtn.addEventListener('click', resetQuiz);
backBtn.addEventListener('click', goBackToMenu);

if (sitesBackBtn) {
    sitesBackBtn.addEventListener('click', () => {
        sitesScreen.classList.add('hidden');
        menuScreen.classList.remove('hidden');
    });
}

if (openSitesBtn) {
    openSitesBtn.addEventListener('click', () => {
        menuScreen.classList.add('hidden');
        sitesScreen.classList.remove('hidden');
        renderSites();
    });
}

// ============================================
// ИНИЦИАЛИЗАЦИЯ
// ============================================
(async function init() {
    console.log('🚀 Старт');

    const cfg = await loadConfig();
    await syncTime();

    if (cfg?.ui?.blockOnTimeSyncFailure && !serverSynced) {
        document.body.innerHTML = `
            <div style="padding:40px;text-align:center;color:#f44336">
                <h2>⚠️ Нет синхронизации времени</h2>
                <p>Приложение не может получить серверное время.</p>
            </div>`;
        return;
    }

    await Promise.all([loadSites(), loadAllTests()]);

    renderMenu();
    initAccordion();
    renderSites();

    setInterval(syncTime, cfg?.timeSource?.resyncIntervalMs || 30000);
    setInterval(updateGeoStatus, 60000);

    console.log('✅ Готово');
})();
