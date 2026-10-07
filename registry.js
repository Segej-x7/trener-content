// ============================================
// registry.js
// Глобальные реестры, заполняются данными с сервера
// ============================================

window.TEST_REGISTRY  = [];
window.CONFIG         = null;
window.SITES_CONFIG   = null;

window.setTestRegistry  = (tests) => { window.TEST_REGISTRY = tests; };
window.setConfig        = (cfg)   => { window.CONFIG = cfg; };
window.setSitesConfig   = (data)  => { window.SITES_CONFIG = data; };

console.log('✅ Registry инициализирован');