// --- ตั้งค่า URL ที่นี่เพื่อให้โปรแกรมจำค่าได้อัตโนมัติ (ไม่ต้องกรอกทุกครั้ง) ---
const DEFAULT_URL = "https://script.google.com/macros/s/AKfycbwEBxNq4oqVbhbbhV8Mrar_81hP3xxkqI9I8PO9am1TUKspIONHRiMIpIw45uQvEzZ4/exec"; // <--- นำลิงก์ Google Script มาใส่ในเครื่องหมายคำพูดนี้ได้เลยครับ
// ----------------------------------------------------------------------

const DB_KEY = 'chemo_db_v2';
const API_URL_KEY = 'chemo_api_url';
let SCRIPT_URL = localStorage.getItem(API_URL_KEY) || DEFAULT_URL;
let isSyncing = false;

let db = JSON.parse(localStorage.getItem(DB_KEY));

if (!db) {
    db = {
        drugs: [],
        inventoryLogs: [],
        users: [
            { id: 1, name: 'Admin User', username: 'admin', password: '1234', role: 'หัวหน้าคลังยา', access: 'ผู้ดูแลระบบ', status: 'ออฟไลน์', lastLogin: null }
        ],
        prescriptions: [],
        patients: []
    };
    // Save locally only, DO NOT sync to cloud on first run
    localStorage.setItem(DB_KEY, JSON.stringify(db));
}

function ensureDBDefaults() {
    if (!db.prescriptions) db.prescriptions = [];
    if (!db.patients) db.patients = [];
    if (!db.inventoryLogs) db.inventoryLogs = [];
    if (!db.drugs) db.drugs = [];
    if (!db.users || db.users.length === 0) {
        db.users = [{ id: 1, name: 'Admin User', username: 'admin', password: '1234', role: 'หัวหน้าคลังยา', access: 'ผู้ดูแลระบบ', status: 'ออฟไลน์', lastLogin: null }];
    } else {
        // Ensure existing users have username/password/lastLogin
        db.users.forEach(u => {
            // Fix previously auto-generated bad usernames (e.g. 'adminuser' from 'Admin User')
            if (!u.username || u.username === u.name.toLowerCase().replace(/\s+/g, '')) {
                u.username = u.name.split(' ')[0].toLowerCase();
            }
            if (!u.password) u.password = '1234';
            if (!u.status) u.status = 'ออฟไลน์';
            if (u.lastLogin === undefined) u.lastLogin = null;
        });
    }

    if (db.prescriptions) {
        db.prescriptions.forEach(rx => {
            if (typeof rx.items === 'string' && rx.items.trim() !== "") {
                try {
                    rx.items = JSON.parse(rx.items);
                } catch (e) {
                    rx.items = [];
                }
            }
            if (!Array.isArray(rx.items)) rx.items = [];
        });
    }
}

ensureDBDefaults();
localStorage.setItem(DB_KEY, JSON.stringify(db));

function saveDB() {
    localStorage.setItem(DB_KEY, JSON.stringify(db));
    if (window.updateNotifications) updateNotifications();
}

async function fetchDataFromCloud() {
    if (!SCRIPT_URL) return;
    try {
        const res = await fetch(SCRIPT_URL);
        const data = await res.json();
        
        if (data) {
            // กรองแถวว่างจาก Google Sheets
            if (data.drugs) data.drugs = data.drugs.filter(x => x && x.id);
            if (data.patients) data.patients = data.patients.filter(x => x && x.hn);
            if (data.prescriptions) data.prescriptions = data.prescriptions.filter(x => x && x.id);

            // Preserve local arrays if cloud doesn't have them or they are empty
            if ((!data.patients || data.patients.length === 0) && db.patients && db.patients.length > 0) data.patients = db.patients;
            if ((!data.prescriptions || data.prescriptions.length === 0) && db.prescriptions && db.prescriptions.length > 0) data.prescriptions = db.prescriptions;

            // MERGE users: เอาข้อมูล Cloud เป็นฐาน แล้วเพิ่ม users ที่มีแค่ในเครื่องเข้าไปด้วย
            const localUsers = db.users || [];
            const cloudUsers = (data.users && data.users.length > 0) ? data.users : [];
            const mergedUsers = [...cloudUsers];
            localUsers.forEach(localUser => {
                const existsInCloud = cloudUsers.some(cu => String(cu.id) === String(localUser.id));
                if (!existsInCloud) {
                    mergedUsers.push(localUser); // user ใหม่ที่ Cloud ยังไม่มี
                }
            });
            data.users = mergedUsers.length > 0 ? mergedUsers : localUsers;

            db = data;

            // ซ่อมแซมข้อมูล ID และข้อมูลพื้นฐาน
            if (db.users) {
                db.users.forEach((u, index) => {
                    if (u.id === undefined || u.id === null || u.id === "") {
                        u.id = index + 1;
                    }
                });
            }

            if (db.patients) {
                db.patients.forEach(p => {
                    p.hn = String(p.hn || '').trim();
                    p.name = String(p.name || '').trim();
                    p.surname = String(p.surname || '').trim();
                });
            }

            if (db.drugs) {
                db.drugs.forEach(d => {
                    if (!d) return;
                    d.id = String(d.id || '').trim();
                    d.genericName = String(d.genericName || '').trim();
                    d.tradeName = String(d.tradeName || '').trim();
                });
            }

            if (db.prescriptions) {
                db.prescriptions.forEach(rx => {
                    if (typeof rx.items === 'string' && rx.items.trim() !== "") {
                        try {
                            rx.items = JSON.parse(rx.items);
                        } catch (e) {
                            console.error("Parse error for RX items:", e);
                            rx.items = [];
                        }
                    }
                    if (!Array.isArray(rx.items)) rx.items = [];
                });
            }

            ensureDBDefaults();
            localStorage.setItem(DB_KEY, JSON.stringify(db));
            if (window.updateNotifications) updateNotifications();
            showToast('ดึงข้อมูลจาก Cloud สำเร็จ');
            if (appState.currentRoute) navigateTo(appState.currentRoute);
        }
    } catch (e) {
        console.error("Cloud fetch failed:", e);
        showToast('ไม่สามารถดึงข้อมูลจาก Cloud ได้');
    }
}

async function syncDataWithCloud() {
    if (!SCRIPT_URL || isSyncing) return;
    isSyncing = true;
    const statusEl = document.getElementById('syncStatusIndicator');
    if (statusEl) statusEl.innerHTML = '<span class="text-blue-500 animate-pulse">กำลังซิงค์...</span>';

    try {
        await fetch(SCRIPT_URL, {
            method: 'POST',
            mode: 'no-cors', // Essential for Google Apps Script POST
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ action: 'syncAll', db: db })
        });

        showToast('ส่งข้อมูลไป Google Sheets แล้ว');
        if (statusEl) statusEl.innerHTML = '<span class="text-emerald-500 text-xs">ซิงค์ล่าสุด: ' + new Date().toLocaleTimeString() + '</span>';
    } catch (e) {
        console.error("Cloud sync failed:", e);
        showToast('การซิงค์ล้มเหลว');
        if (statusEl) statusEl.innerHTML = '<span class="text-red-500">ซิงค์ล้มเหลว</span>';
    }
    isSyncing = false;
}

const appState = {
    currentRoute: 'dashboard',
    isSidebarOpen: false
};

const navItems = [
    { id: 'dashboard', label: 'ภาพรวมสถานะ (Dashboard)', icon: 'layout-dashboard' },
    { id: 'drugs', label: 'จัดการข้อมูลยา', icon: 'pill' },
    { id: 'inventory', label: 'จัดการเบิก-รับยา', icon: 'arrow-left-right' },
    { id: 'patients', label: 'จัดการรายชื่อผู้ป่วย', icon: 'users' },
    { id: 'dispensing', label: 'ใบสั่งยาและจ่ายยา', icon: 'file-text' },
    { id: 'reports', label: 'จัดพิมพ์รายงาน', icon: 'printer' },
    { id: 'settings', label: 'ผู้ใช้งานและตั้งค่า', icon: 'settings' }
];

document.addEventListener('DOMContentLoaded', () => {
    checkLogin();
    initNavigation();
    initSidebar();
    lucide.createIcons();
    navigateTo('dashboard');
    setupToast();
    fetchDataFromCloud();
    if (window.updateNotifications) updateNotifications();

    // เติม URL อัตโนมัติในหน้า Login ถ้าเคยกรอกไว้แล้ว
    const loginUrlInput = document.getElementById('sheetUrl');
    if (loginUrlInput && SCRIPT_URL) {
        loginUrlInput.value = SCRIPT_URL;
    }
});

function initSidebar() {
    const sidebar = document.getElementById('sidebar');
    const openBtn = document.getElementById('openSidebar');
    const closeBtn = document.getElementById('closeSidebar');

    if (openBtn) {
        openBtn.addEventListener('click', () => {
            sidebar.classList.remove('-translate-x-full');
            appState.isSidebarOpen = true;
        });
    }

    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            sidebar.classList.add('-translate-x-full');
            appState.isSidebarOpen = false;
        });
    }
}

function initNavigation() {
    const navMenu = document.getElementById('navMenu');
    navMenu.innerHTML = '';

    navItems.forEach(item => {
        const li = document.createElement('li');
        li.innerHTML = `
            <a href="#" data-route="${item.id}" class="nav-link flex items-center gap-3 px-4 py-3 rounded-lg text-gray-600 hover:bg-primary-light hover:text-primary transition-colors">
                <i data-lucide="${item.icon}" class="w-5 h-5"></i>
                <span class="font-medium">${item.label}</span>
            </a>
        `;
        navMenu.appendChild(li);
    });

    document.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const route = e.currentTarget.getAttribute('data-route');
            navigateTo(route);
            if (window.innerWidth < 768) {
                document.getElementById('sidebar').classList.add('-translate-x-full');
            }
        });
    });
}

function navigateTo(routeId) {
    appState.currentRoute = routeId;

    document.querySelectorAll('.nav-link').forEach(link => {
        if (link.getAttribute('data-route') === routeId) {
            link.classList.add('bg-primary-light', 'text-primary');
            link.classList.remove('text-gray-600');
        } else {
            link.classList.remove('bg-primary-light', 'text-primary');
            link.classList.add('text-gray-600');
        }
    });

    const navItem = navItems.find(item => item.id === routeId);
    if (navItem) document.getElementById('pageTitle').textContent = navItem.label;

    const mainContent = document.getElementById('mainContent');
    mainContent.style.opacity = '0';
    mainContent.style.transform = 'translateY(10px)';

    setTimeout(() => {
        mainContent.innerHTML = getPageContent(routeId);
        lucide.createIcons();

        // Setup specific event listeners
        if (routeId === 'drugs') setupDrugSearch();
        if (routeId === 'prescriptions') setupRxFilter();

        mainContent.style.transition = 'opacity 300ms, transform 300ms';
        mainContent.style.opacity = '1';
        mainContent.style.transform = 'translateY(0)';
    }, 150);
}



window.liveDispensePatientSearch = function(hn) {
    const p = db.patients.find(x => String(x.hn).trim() === String(hn).trim());
    if (p) {
        document.getElementById('dispensePatient').value = `${p.title || ''}${p.name} ${p.surname || ''}`.trim();
    } else {
        document.getElementById('dispensePatient').value = '';
    }
}
function formatDate(isoString) {
    if (!isoString || isoString === 'null') return 'ไม่เคยล็อกอิน';
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return 'ไม่เคยล็อกอิน';
    return d.toLocaleDateString('th-TH', { day: '2-digit', month: 'short', year: '2-digit' }) + ' ' + d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
}

window.formatSimpleDate = function (val) {
    if (!val || val === 'null' || val === '-') return '-';
    let d = new Date(val);
    if (isNaN(d.getTime())) {
        if (typeof val === 'string' && val.includes('/')) {
            const parts = val.split('/');
            if (parts.length === 3) return `${parts[0].padStart(2, '0')}/${parts[1].padStart(2, '0')}/${parts[2]}`;
        }
        return val;
    }
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}/${month}/${year}`;
}
function getPageContent(routeId) {
    const lowStockDrugs = db.drugs.filter(d => d.stock <= d.minLevel);

    switch (routeId) {
        case 'dashboard':
            const todayStatusDash = new Date();
            const threeMonthsStatusDash = new Date();
            threeMonthsStatusDash.setMonth(todayStatusDash.getMonth() + 3);

            const expiredDrugsDash = db.drugs.filter(d => d.expiryDate && new Date(d.expiryDate) < todayStatusDash);
            const nearExpiryDrugsDash = db.drugs.filter(d => d.expiryDate && new Date(d.expiryDate) >= todayStatusDash && new Date(d.expiryDate) <= threeMonthsStatusDash);
            const highAlertDrugsDash = db.drugs.filter(d => d.isHighAlert);

            return `
                <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
                    <div class="bg-white rounded-xl shadow-sm p-6 border border-gray-100 flex items-center justify-between">
                        <div>
                            <p class="text-sm text-gray-500 font-medium mb-1">รายการยาทั้งหมด</p>
                            <h3 class="text-3xl font-bold text-gray-800">${db.drugs.length}</h3>
                            <p class="text-[10px] text-gray-400 mt-1">v4.0 (Latest)</p>
                        </div>
                        <div class="w-12 h-12 bg-blue-50 text-blue-500 rounded-full flex items-center justify-center">
                            <i data-lucide="pill" class="w-6 h-6"></i>
                        </div>
                    </div>
                    <div class="bg-white rounded-xl shadow-sm p-6 border border-gray-100 flex items-center justify-between">
                        <div>
                            <p class="text-sm text-gray-500 font-medium mb-1">ยาใกล้หมดสต๊อก</p>
                            <h3 class="text-3xl font-bold text-amber-600">${lowStockDrugs.length}</h3>
                        </div>
                        <div class="w-12 h-12 bg-amber-50 text-amber-500 rounded-full flex items-center justify-center">
                            <i data-lucide="alert-triangle" class="w-6 h-6"></i>
                        </div>
                    </div>
                    <div class="bg-white rounded-xl shadow-sm p-6 border border-gray-100 flex items-center justify-between">
                        <div>
                            <p class="text-sm text-gray-500 font-medium mb-1">ใบสั่งยารอดำเนินการ</p>
                            <h3 class="text-3xl font-bold text-primary">${db.prescriptions.filter(r => r.status === 'รอจัดยา').length}</h3>
                        </div>
                        <div class="w-12 h-12 bg-sky-50 text-primary rounded-full flex items-center justify-center">
                            <i data-lucide="file-clock" class="w-6 h-6"></i>
                        </div>
                    </div>
                    <div class="bg-white rounded-xl shadow-sm p-6 border border-gray-100 flex items-center justify-between">
                        <div>
                            <p class="text-sm text-gray-500 font-medium mb-1">ยาความเสี่ยงสูง</p>
                            <h3 class="text-3xl font-bold text-purple-600">${highAlertDrugsDash.length}</h3>
                        </div>
                        <div class="w-12 h-12 bg-purple-50 text-purple-500 rounded-full flex items-center justify-center">
                            <i data-lucide="zap" class="w-6 h-6"></i>
                        </div>
                    </div>
                </div>

                <div class="mb-4 flex items-center gap-2 text-gray-800 font-bold">
                    <i data-lucide="shield-check" class="w-5 h-5 text-primary"></i>
                    <span>ตรวจสอบสถานะคลังยา (เรียลไทม์)</span>
                </div>
                <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
                    <!-- 1. Expired -->
                    <div class="bg-white rounded-xl shadow-sm border border-red-200 overflow-hidden flex flex-col">
                        <div class="p-4 bg-red-50 border-b border-red-100 flex items-center justify-between">
                            <h3 class="font-bold text-red-700 flex items-center gap-2 text-sm"><i data-lucide="x-circle" class="w-4 h-4"></i> ยาหมดอายุ</h3>
                            <span class="bg-red-600 text-white text-xs px-2 py-0.5 rounded-full">${expiredDrugsDash.length}</span>
                        </div>
                        <div class="p-4 space-y-2 max-h-48 overflow-y-auto flex-1 bg-white">
                            ${expiredDrugsDash.length ? expiredDrugsDash.map(d => `<div class="text-xs p-2 bg-red-50/50 rounded border border-red-100"><p class="font-bold text-gray-800">${d.genericName}</p><p class="text-red-600">หมดอายุ: ${window.formatSimpleDate(d.expiryDate)}</p></div>`).join('') : '<p class="text-gray-400 text-xs text-center py-4">ไม่มีรายการยาหมดอายุ</p>'}
                        </div>
                    </div>

                    <!-- 2. Near Expiry -->
                    <div class="bg-white rounded-xl shadow-sm border border-orange-200 overflow-hidden flex flex-col">
                        <div class="p-4 bg-orange-50 border-b border-orange-100 flex items-center justify-between">
                            <h3 class="font-bold text-orange-700 flex items-center gap-2 text-sm"><i data-lucide="clock" class="w-4 h-4"></i> ใกล้หมดอายุ (< 3 ด.)</h3>
                            <span class="bg-orange-500 text-white text-xs px-2 py-0.5 rounded-full">${nearExpiryDrugsDash.length}</span>
                        </div>
                        <div class="p-4 space-y-2 max-h-48 overflow-y-auto flex-1 bg-white">
                            ${nearExpiryDrugsDash.length ? nearExpiryDrugsDash.map(d => `<div class="text-xs p-2 bg-orange-50/50 rounded border border-orange-100"><p class="font-bold text-gray-800">${d.genericName}</p><p class="text-orange-600">หมดอายุ: ${window.formatSimpleDate(d.expiryDate)}</p></div>`).join('') : '<p class="text-gray-400 text-xs text-center py-4">ไม่มีรายการยาใกล้หมดอายุ</p>'}
                        </div>
                    </div>

                    <!-- 3. Low Stock -->
                    <div class="bg-white rounded-xl shadow-sm border border-amber-200 overflow-hidden flex flex-col">
                        <div class="p-4 bg-amber-50 border-b border-amber-100 flex items-center justify-between">
                            <h3 class="font-bold text-amber-700 flex items-center gap-2 text-sm"><i data-lucide="alert-triangle" class="w-4 h-4"></i> ยาสต๊อกต่ำ</h3>
                            <span class="bg-amber-500 text-white text-xs px-2 py-0.5 rounded-full">${lowStockDrugs.length}</span>
                        </div>
                        <div class="p-4 space-y-2 max-h-48 overflow-y-auto flex-1 bg-white">
                            ${lowStockDrugs.length ? lowStockDrugs.map(d => `<div class="text-xs p-2 bg-amber-50/50 rounded border border-amber-100"><p class="font-bold text-gray-800">${d.genericName}</p><p class="text-amber-600">คงเหลือ: ${d.stock} (Min: ${d.minLevel})</p></div>`).join('') : '<p class="text-gray-400 text-xs text-center py-4">ไม่มีรายการยาสต๊อกต่ำ</p>'}
                        </div>
                    </div>

                    <!-- 4. HAD -->
                    <div class="bg-white rounded-xl shadow-sm border border-purple-200 overflow-hidden flex flex-col">
                        <div class="p-4 bg-purple-50 border-b border-purple-100 flex items-center justify-between">
                            <h3 class="font-bold text-purple-700 flex items-center gap-2 text-sm"><i data-lucide="zap" class="w-4 h-4"></i> High Alert Drug</h3>
                            <span class="bg-purple-600 text-white text-xs px-2 py-0.5 rounded-full">${highAlertDrugsDash.length}</span>
                        </div>
                        <div class="p-4 space-y-2 max-h-48 overflow-y-auto flex-1 bg-white">
                            ${highAlertDrugsDash.length ? highAlertDrugsDash.map(d => `<div class="text-xs p-2 bg-purple-50/50 rounded border border-purple-100"><p class="font-bold text-gray-800">${d.genericName}</p><p class="text-purple-600">ยาความเสี่ยงสูง</p></div>`).join('') : '<p class="text-gray-400 text-xs text-center py-4">ไม่มีรายการยาความเสี่ยงสูง</p>'}
                        </div>
                    </div>
                </div>
            `;

        case 'drugs':
            return `
                <div class="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                    <div class="p-6 border-b flex flex-col md:flex-row md:items-center justify-between gap-4">
                        <div class="relative w-full md:w-64">
                            <i data-lucide="search" class="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-4 h-4"></i>
                            <input type="text" id="drugSearch" placeholder="ค้นหารหัสยา, ชื่อยา..." class="w-full pl-9 pr-4 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent">
                        </div>
                        <button onclick="openModal('addDrugModal')" class="bg-primary hover:bg-primary-dark text-white px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-colors">
                            <i data-lucide="plus" class="w-4 h-4"></i> เพิ่มข้อมูลยาใหม่
                        </button>
                    </div>
                    
                    <div class="overflow-x-auto">
                        <table class="w-full text-left border-collapse">
                            <thead>
                                <tr class="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider">
                                    <th class="p-4 font-medium">รหัสยา</th>
                                    <th class="p-4 font-medium">ชื่อสามัญ (Generic Name)</th>
                                    <th class="p-4 font-medium">ความแรง</th>
                                    <th class="p-4 font-medium text-center">วันหมดอายุ</th>
                                    <th class="p-4 font-medium text-center">จุดสั่งซื้อ</th>
                                    <th class="p-4 font-medium text-center">คงเหลือ</th>
                                    <th class="p-4 font-medium text-center">จัดการ</th>
                                </tr>
                            </thead>
                            <tbody id="drugsTableBody" class="text-sm divide-y divide-gray-100">
                                ${generateDrugsTableHTML(db.drugs)}
                            </tbody>
                        </table>
                    </div>
                </div>
            `;

        case 'inventory':
            const recvFilterStart = appState.recvStart || '';
            const recvFilterEnd = appState.recvEnd || '';

            let combinedLogs = db.inventoryLogs.filter(l => l.type === 'รับเข้า' || l.type === 'เบิกออก');
            if (recvFilterStart) combinedLogs = combinedLogs.filter(l => l.date.split('T')[0] >= recvFilterStart);
            if (recvFilterEnd) combinedLogs = combinedLogs.filter(l => l.date.split('T')[0] <= recvFilterEnd);
            combinedLogs = combinedLogs.slice().reverse();

            return `
                <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
                    <!-- รับยาเข้า -->
                    <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
                        <h2 class="text-lg font-bold text-gray-800 mb-4 flex items-center gap-2">
                            <i data-lucide="download" class="w-5 h-5 text-emerald-600"></i> บันทึกรับยาเข้า
                        </h2>
                        <form onsubmit="window.saveReceive(event)">
                            <div class="space-y-4">
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">เลือกยา (พิมพ์เพื่อค้นหา)</label>
                                    <input list="recvDrugOptions" id="recvDrugId" required onchange="window.updateCurrentStock(this.value.includes(':') ? this.value.split(':')[0].trim() : this.value)" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:border-emerald-500 focus:outline-none" placeholder="ค้นหารหัสยา หรือ ชื่อยา...">
                                    <datalist id="recvDrugOptions">
                                        ${db.drugs.map(d => `<option value="${d.id} : ${d.genericName}"></option>`).join('')}
                                    </datalist>
                                </div>
                                <div class="grid grid-cols-2 gap-4">
                                    <div>
                                        <label class="block text-xs font-medium text-gray-700 mb-1">วันที่รับเข้า</label>
                                        <input type="date" id="recvDate" required class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:border-emerald-500 focus:outline-none">
                                    </div>
                                    <div>
                                        <label class="block text-xs font-medium text-emerald-700 mb-1">จำนวน (ยอดนับได้)</label>
                                        <input type="number" id="recvQty" min="1" required class="w-full px-3 py-2 border border-emerald-300 rounded-md text-sm focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500">
                                    </div>
                                </div>
                                <div class="hidden">
                                    <input type="number" id="recvCurrentStock" readonly>
                                </div>
                                <button type="submit" class="w-full bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-md text-sm font-medium transition-colors mt-2 flex items-center justify-center gap-2 shadow-sm">
                                    <i data-lucide="save" class="w-4 h-4"></i> บันทึกรับเข้า
                                </button>
                            </div>
                        </form>
                    </div>

                    <!-- เบิกออก/ตัดจำหน่าย -->
                    <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
                        <h2 class="text-lg font-bold text-gray-800 mb-4 flex items-center gap-2">
                            <i data-lucide="upload" class="w-5 h-5 text-amber-500"></i> บันทึกเบิกออก/ตัดจำหน่าย
                        </h2>
                        <form id="inventoryForm" onsubmit="window.saveInventoryOut(event)">
                            <div class="space-y-4">
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">เลือกยา (พิมพ์เพื่อค้นหา)</label>
                                    <input list="invDrugOutOptions" id="invDrugIdOut" required class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:border-amber-500 focus:outline-none" placeholder="ค้นหารหัสยา หรือ ชื่อยา...">
                                    <datalist id="invDrugOutOptions">
                                        ${db.drugs.map(d => `<option value="${d.id} : ${d.genericName} (คงเหลือ: ${d.stock})"></option>`).join('')}
                                    </datalist>
                                </div>
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">จำนวนเบิกออก/ตัดจำหน่าย</label>
                                    <input type="number" id="invQtyOut" min="1" required class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:border-amber-500 focus:outline-none">
                                </div>
                                <div class="pt-1"></div>
                                <button type="submit" class="w-full bg-amber-500 hover:bg-amber-600 text-white px-4 py-2 rounded-md text-sm font-medium transition-colors shadow-sm mt-2 flex items-center justify-center gap-2">
                                    <i data-lucide="upload" class="w-4 h-4"></i> บันทึกรายการเบิกออก
                                </button>
                            </div>
                        </form>
                    </div>
                </div>

                <!-- ประวัติ -->
                <div class="bg-white rounded-xl shadow-sm border border-gray-100 flex flex-col">
                    <div class="p-6 border-b flex flex-col sm:flex-row justify-between items-start sm:items-center bg-gray-50 gap-4">
                        <h2 class="text-lg font-bold text-gray-800 flex items-center gap-2"><i data-lucide="history" class="w-5 h-5 text-gray-500"></i> ประวัติการรับเข้าและเบิกออก</h2>
                        <div class="flex items-center gap-2 text-sm bg-white p-1 rounded-md border shadow-sm">
                            <input type="date" id="recvFilterStartInp" value="${recvFilterStart}" class="px-2 py-1 outline-none text-xs text-gray-600">
                            <span class="text-gray-400">-</span>
                            <input type="date" id="recvFilterEndInp" value="${recvFilterEnd}" class="px-2 py-1 outline-none text-xs text-gray-600">
                            <button onclick="window.applyReceiveFilter()" class="bg-gray-800 text-white px-3 py-1 rounded text-xs hover:bg-gray-700 transition-colors">กรอง</button>
                        </div>
                    </div>
                    <div class="overflow-x-auto flex-1 max-h-96">
                        <table class="w-full text-left">
                            <thead class="bg-white text-gray-500 text-xs border-b sticky top-0">
                                <tr>
                                    <th class="p-4 font-medium">วันที่</th>
                                    <th class="p-4 font-medium">ประเภท</th>
                                    <th class="p-4 font-medium">รายการยา</th>
                                    <th class="p-4 font-medium text-right">จำนวน</th>
                                    <th class="p-4 font-medium">ผู้ทำรายการ</th>
                                </tr>
                            </thead>
                            <tbody class="text-sm divide-y divide-gray-100">
                                ${combinedLogs.length === 0 ? `<tr><td colspan="5" class="p-8 text-center text-gray-400">ไม่พบประวัติในช่วงเวลานี้</td></tr>` :
                    combinedLogs.map(log => `
                                    <tr class="hover:bg-gray-50 transition-colors">
                                        <td class="p-4 text-gray-500 text-xs">${formatDate(log.date)}</td>
                                        <td class="p-4 font-medium ${log.type === 'รับเข้า' ? 'text-emerald-600' : 'text-amber-600'}">${log.type}</td>
                                        <td class="p-4 font-medium text-gray-800">${log.drugName}</td>
                                        <td class="p-4 text-right font-bold ${log.type === 'รับเข้า' ? 'text-emerald-600' : 'text-amber-600'}">${log.qty}</td>
                                        <td class="p-4 text-gray-600 text-xs flex items-center gap-1"><i data-lucide="user" class="w-3 h-3"></i> ${log.user}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            `;

        case 'patients':
            const patientSearch = appState.patientSearch || '';
            let filteredPatients = db.patients || [];
            if (patientSearch) {
                const s = patientSearch.toLowerCase();
                filteredPatients = filteredPatients.filter(p => {
                    const hn = String(p.hn || '').toLowerCase();
                    const name = String(p.name || '').toLowerCase();
                    const surname = String(p.surname || '').toLowerCase();
                    return hn.includes(s) || name.includes(s) || surname.includes(s);
                });
            }

            return `
                <div class="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                    <div class="p-6 border-b flex flex-col md:flex-row md:items-center justify-between gap-4 bg-gray-50/50">
                        <div class="flex items-center gap-4 flex-1">
                             <div class="relative w-full max-w-md">
                                <i data-lucide="search" class="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-4 h-4"></i>
                                <input type="text" id="patientSearch" value="${patientSearch}" 
                                    oninput="window.livePatientSearch(this.value)"
                                    onkeydown="if(event.key === 'Enter') event.preventDefault();"
                                    placeholder="ค้นหา HN หรือ ชื่อ-นามสกุล..." class="w-full pl-9 pr-4 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary">
                            </div>
                        </div>
                        <button onclick="openModal('addPatientModal')" class="bg-primary hover:bg-primary-dark text-white px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-colors shadow-sm">
                            <i data-lucide="user-plus" class="w-4 h-4"></i> เพิ่มผู้ป่วยใหม่
                        </button>
                    </div>
                    
                    <div class="overflow-x-auto">
                        <table class="w-full text-left border-collapse">
                            <thead>
                                <tr class="bg-gray-50 text-gray-500 text-[10px] uppercase tracking-wider border-b">
                                    <th class="p-4 font-medium text-center">ลำดับ</th>
                                    <th class="p-4 font-medium">HN</th>
                                    <th class="p-4 font-medium">คำนำหน้า</th>
                                    <th class="p-4 font-medium">ชื่อ-นามสกุล</th>
                                    <th class="p-4 font-medium">เพศ</th>
                                    <th class="p-4 font-medium">อายุ</th>
                                    <th class="p-4 font-medium">วันเกิด</th>
                                    <th class="p-4 font-medium">สัญชาติ</th>
                                    <th class="p-4 font-medium text-center">จัดการ</th>
                                </tr>
                            </thead>
                            <tbody id="patientTableBody" class="text-sm divide-y divide-gray-100">
                                ${filteredPatients.length === 0 ? '<tr><td colspan="9" class="p-8 text-center text-gray-400">ไม่พบข้อมูลผู้ป่วย</td></tr>' :
                    filteredPatients.map((p, idx) => `
                                    <tr class="hover:bg-gray-50 transition-colors">
                                        <td class="p-4 text-center text-gray-400">${idx + 1}</td>
                                        <td class="p-4 font-bold text-primary">${p.hn}</td>
                                        <td class="p-4">${p.title || '-'}</td>
                                        <td class="p-4 font-medium">${p.name} ${p.surname || ''}</td>
                                        <td class="p-4">${p.gender || '-'}</td>
                                        <td class="p-4">${p.age || '-'}</td>
                                        <td class="p-4 text-xs text-gray-500">${window.formatSimpleDate(p.birthDate)}</td>
                                        <td class="p-4 text-xs">${p.nationality || 'ไทย'}</td>
                                        <td class="p-4 flex justify-center gap-2">
                                            <button onclick="window.openEditPatient('${p.hn}')" class="p-1.5 text-gray-400 hover:text-blue-600 rounded"><i data-lucide="edit" class="w-4 h-4"></i></button>
                                            <button onclick="window.deletePatient('${p.hn}')" class="p-1.5 text-gray-400 hover:text-red-600 rounded"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
                                        </td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            `;

        case 'dispensing':
            const dispenseLogs = db.inventoryLogs.filter(l => l.type === 'จ่ายยา').slice().reverse().slice(0, 10);
            return `
                <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
                    <!-- จ่ายยา -->
                    <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
                        <h2 class="text-lg font-bold text-gray-800 mb-4 flex items-center gap-2">
                            <i data-lucide="package-plus" class="w-5 h-5 text-primary"></i> บันทึกการจ่ายยาผู้ป่วย
                        </h2>
                        <form onsubmit="window.dispenseDrugSubmit(event)">
                            <div class="space-y-4">
                                <div class="grid grid-cols-2 gap-4">
                                    <div>
                                        <label class="block text-xs font-medium text-gray-700 mb-1">HN ผู้ป่วย *</label>
                                        <input type="text" id="dispenseRx" required class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:border-primary focus:outline-none" placeholder="ค้นหาด้วยรหัส HN..." oninput="window.liveDispensePatientSearch(this.value)">
                                    </div>
                                    <div>
                                        <label class="block text-xs font-medium text-gray-700 mb-1">ชื่อ-นามสกุลผู้ป่วย *</label>
                                        <input type="text" id="dispensePatient" required readonly class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:border-primary focus:outline-none bg-gray-50" placeholder="ดึงข้อมูลอัตโนมัติ">
                                    </div>
                                </div>
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">เลือกยาเคมีบำบัดที่จะจ่าย (พิมพ์เพื่อค้นหา) *</label>
                                    <input list="dispenseDrugOptions" id="dispenseDrugId" required class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:border-primary focus:outline-none" placeholder="ค้นหารหัสยา หรือ ชื่อยา...">
                                    <datalist id="dispenseDrugOptions">
                                        ${db.drugs.map(d => `<option value="${d.id} : ${d.genericName} (คงเหลือ: ${d.stock})"></option>`).join('')}
                                    </datalist>
                                </div>
                                <div class="grid grid-cols-2 gap-4">
                                    <div>
                                        <label class="block text-xs font-medium text-gray-700 mb-1">Cycle *</label>
                                        <input type="text" id="dispenseCycle" required class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:border-primary focus:outline-none" placeholder="เช่น 1, 2">
                                    </div>
                                    <div>
                                        <label class="block text-xs font-medium text-gray-700 mb-1">จำนวนที่จ่าย *</label>
                                        <input type="number" id="dispenseQty" min="1" required class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:border-primary focus:outline-none">
                                    </div>
                                </div>
                                <button type="submit" class="w-full bg-primary hover:bg-primary-dark text-white px-4 py-2 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-2 shadow-sm mt-2">
                                    <i data-lucide="check-circle" class="w-4 h-4"></i> ยืนยันการจ่ายยา
                                </button>
                            </div>
                        </form>
                    </div>

                    <!-- ใบสั่งยา -->
                    <div class="bg-white rounded-xl shadow-sm border border-gray-100 flex flex-col h-full">
                        <div class="p-4 border-b flex justify-between items-center bg-gray-50">
                            <h2 class="text-lg font-bold text-gray-800 flex items-center gap-2"><i data-lucide="file-text" class="w-5 h-5 text-gray-500"></i> ใบสั่งยารอดำเนินการ</h2>
                            <button onclick="openModal('addRxModal')" class="bg-primary hover:bg-primary-dark text-white px-3 py-1.5 rounded text-xs font-medium flex items-center gap-1 transition-colors shadow-sm">
                                <i data-lucide="plus" class="w-3 h-3"></i> เพิ่มใบสั่งยา
                            </button>
                        </div>
                        <div class="overflow-x-auto flex-1 max-h-80">
                            <table class="w-full text-left">
                                <thead class="bg-white text-gray-500 text-xs border-b sticky top-0">
                                    <tr>
                                        <th class="p-3 font-medium">วันที่</th>
                                        <th class="p-3 font-medium">ผู้ป่วย</th>
                                        <th class="p-3 font-medium">รายการ</th>
                                        <th class="p-3 font-medium text-center">จัดการ</th>
                                    </tr>
                                </thead>
                                <tbody class="text-sm divide-y divide-gray-100">
                                    ${db.prescriptions.filter(r => r.status === 'รอจัดยา').length === 0 ? '<tr><td colspan="4" class="p-6 text-center text-gray-400 text-xs">ไม่มีใบสั่งยารอดำเนินการ</td></tr>' :
                    db.prescriptions.filter(r => r.status === 'รอจัดยา').map(rx => `
                                    <tr class="hover:bg-gray-50">
                                        <td class="p-3 text-xs text-gray-500">${formatDate(rx.date).split(' ').slice(0, 3).join(' ')}</td>
                                        <td class="p-3">
                                            <div class="font-medium text-gray-800 text-xs">${rx.hn}</div>
                                            <div class="text-[10px] text-gray-500">${rx.patientName}</div>
                                        </td>
                                        <td class="p-3 text-[10px] text-gray-600">
                                            ${(rx.items || []).map(item => {
                        const drug = (db.drugs || []).find(d => d.id === item.drugId);
                        return `• ${drug ? drug.genericName : (item.drugId || 'ไม่ทราบรหัส')} <b class="text-primary">(${item.qty || 0})</b>`;
                    }).join('<br>')}
                                        </td>
                                        <td class="p-3 flex justify-center gap-1">
                                            <button onclick="window.completeRx('${rx.id}')" class="p-1 text-emerald-600 hover:bg-emerald-50 rounded" title="เสร็จสิ้น"><i data-lucide="check-circle" class="w-4 h-4"></i></button>
                                            <button onclick="window.deleteRx('${rx.id}')" class="p-1 text-gray-400 hover:text-red-600 rounded" title="ลบ"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
                                        </td>
                                    </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>

                <!-- ประวัติการจ่ายยา -->
                <div class="bg-white rounded-xl shadow-sm border border-gray-100 flex flex-col h-full">
                    <div class="p-6 border-b flex justify-between items-center bg-gray-50">
                        <h2 class="text-lg font-bold text-gray-800 flex items-center gap-2"><i data-lucide="history" class="w-5 h-5 text-gray-500"></i> ประวัติการจ่ายยาล่าสุด</h2>
                    </div>
                    <div class="overflow-x-auto flex-1">
                        <table class="w-full text-left">
                            <thead class="bg-white text-gray-500 text-xs border-b">
                                <tr>
                                    <th class="p-4 font-medium">วันที่-เวลา</th>
                                    <th class="p-4 font-medium">ใบสั่งยา/ผู้ป่วย</th>
                                    <th class="p-4 font-medium">รายการยา</th>
                                    <th class="p-4 font-medium text-center">จำนวน</th>
                                    <th class="p-4 font-medium text-center">Cycle</th>
                                    <th class="p-4 font-medium">ผู้จ่ายยา</th>
                                </tr>
                            </thead>
                            <tbody class="text-sm divide-y divide-gray-100">
                                ${dispenseLogs.length === 0 ? `<tr><td colspan="6" class="p-8 text-center text-gray-400">ยังไม่มีประวัติการจ่ายยา</td></tr>` :
                    dispenseLogs.map(log => `
                                    <tr class="hover:bg-gray-50 transition-colors">
                                        <td class="p-4 text-gray-500 text-xs">${formatDate(log.date)}</td>
                                        <td class="p-4">
                                            <div class="font-medium text-gray-800">${log.rx || '-'}</div>
                                            <div class="text-xs text-gray-500">${log.patient || (log.rx ? (db.patients.find(p => String(p.hn).trim() === String(log.rx).trim())?.name || '-') : '-')}</div>
                                        </td>
                                        <td class="p-4"><span class="px-2 py-1 bg-blue-50 text-blue-600 rounded-md text-xs border border-blue-100">${log.drugName}</span></td>
                                        <td class="p-4 text-center font-bold text-red-500">${log.qty}</td>
                                        <td class="p-4 text-center text-xs text-gray-600">${log.cycle || '-'}</td>
                                        <td class="p-4 text-gray-600 text-xs flex items-center gap-1"><i data-lucide="user" class="w-3 h-3"></i> ${log.user}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            `;



        case 'reports':
            return `
                <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
                    <h2 class="text-xl font-bold text-gray-800 mb-6 flex items-center gap-2">
                        <i data-lucide="printer" class="w-6 h-6 text-primary"></i> จัดพิมพ์รายงานสรุป
                    </h2>
                    
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-10">
                        <div class="space-y-6 border-r pr-10">
                            <div class="bg-gray-50 p-6 rounded-xl border border-gray-100">
                                <h3 class="font-bold text-gray-700 mb-4 flex items-center gap-2"><i data-lucide="filter" class="w-4 h-4"></i> 1. เลือกตัวเลือกรายงาน</h3>
                                
                                <div class="space-y-4">
                                    <div>
                                        <label class="block text-sm font-medium text-gray-700 mb-1">ประเภทรายงานที่ต้องการ</label>
                                        <select id="rptType" onchange="document.getElementById('drugSelectContainer').style.display = this.value === 'stock_card' ? 'block' : 'none'" class="w-full px-3 py-3 border border-gray-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-primary focus:outline-none shadow-sm">
                                            <option value="summary">สรุปยาคงคลังปัจจุบัน (Current Inventory Summary)</option>
                                            <option value="in">รายงานการรับยาเข้า (Drug Receive Log)</option>
                                            <option value="out">รายงานการจ่ายยา/เบิกออก (Drug Dispense Log)</option>
                                            <option value="stock_card">แบบฟอร์ม Stock (Stock Card)</option>
                                        </select>
                                    </div>
                                    <div id="drugSelectContainer" style="display: none;">
                                        <label class="block text-sm font-medium text-gray-700 mb-1">เลือกยา</label>
                                        <select id="rptDrugId" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-primary focus:outline-none">
                                            <option value="">-- กรุณาเลือกยา --</option>
                                            ${db.drugs.map(d => `<option value="${d.id}">${d.id} : ${d.genericName}</option>`).join('')}
                                        </select>
                                    </div>
                                    
                                    <div class="grid grid-cols-2 gap-4">
                                        <div>
                                            <label class="block text-sm font-medium text-gray-700 mb-1">เริ่มต้นวันที่</label>
                                            <input type="date" id="rptStart" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-primary focus:outline-none">
                                        </div>
                                        <div>
                                            <label class="block text-sm font-medium text-gray-700 mb-1">สิ้นสุดวันที่</label>
                                            <input type="date" id="rptEnd" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-primary focus:outline-none">
                                        </div>
                                    </div>
                                    <p class="text-[10px] text-gray-400">* รายงานแบบสรุปคงคลัง ไม่จำเป็นต้องเลือกวันที่</p>
                                    
                                    <div>
                                        <label class="block text-sm font-medium text-gray-700 mb-1">ผู้ออกรายงาน</label>
                                        <input type="text" id="rptIssuer" value="${(function(){
                                            const userId = sessionStorage.getItem('loggedInUserId');
                                            const u = db.users.find(x => x.id == userId);
                                            return u ? u.name : 'Admin';
                                        })()}" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-primary focus:outline-none shadow-sm">
                                    </div>
                                    
                                    <div class="pt-4">
                                        <button onclick="window.generateReportAction()" class="w-full bg-primary hover:bg-primary-dark text-white py-3 rounded-lg font-bold flex items-center justify-center gap-2 shadow-lg transition-all active:scale-95">
                                            <i data-lucide="file-text" class="w-5 h-5"></i> 2. ดูตัวอย่างรายงาน (Preview PDF)
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                        
                        <div class="flex flex-col items-center justify-center text-center py-10">
                            <div class="w-20 h-20 bg-primary-light text-primary rounded-full flex items-center justify-center mb-6 opacity-30">
                                <i data-lucide="printer" class="w-10 h-10"></i>
                            </div>
                            <h3 class="text-lg font-bold text-gray-800">ขั้นตอนการออกรายงาน</h3>
                            <ul class="text-gray-500 text-sm mt-4 space-y-2 text-left list-disc list-inside">
                                <li>เลือกประเภทรายงานที่ต้องการ (รับเข้า/เบิกออก/คงคลัง)</li>
                                <li>เลือกช่วงเวลาที่ต้องการตรวจสอบ</li>
                                <li>กดปุ่ม "ดูตัวอย่างรายงาน"</li>
                                <li>ในหน้าใหม่ที่เปิดขึ้นมา กดปุ่ม "พิมพ์รายงาน"</li>
                                <li>เลือก Printer เป็น "Save as PDF" เพื่อบันทึกไฟล์</li>
                            </ul>
                        </div>
                    </div>
                </div>
            `;
        case 'settings':
            return `
                <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <!-- ผู้ใช้งาน -->
                    <div class="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden flex flex-col">
                        <div class="p-6 border-b flex justify-between items-center bg-gray-50 gap-4">
                            <h2 class="text-lg font-bold text-gray-800 flex items-center gap-2"><i data-lucide="users" class="w-5 h-5 text-blue-500"></i> จัดการผู้ใช้งาน</h2>
                            <button onclick="openModal('addUserModal')" class="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1 transition-colors">
                                <i data-lucide="plus" class="w-3 h-3"></i> เพิ่มผู้ใช้งาน
                            </button>
                        </div>
                        <div class="overflow-x-auto flex-1 max-h-[500px]">
                            <table class="w-full text-left border-collapse">
                                <thead class="bg-white text-gray-500 text-xs border-b sticky top-0">
                                    <tr>
                                        <th class="p-4 font-medium">ชื่อ-นามสกุล</th>
                                        <th class="p-4 font-medium">บทบาท/สิทธิ์</th>
                                        <th class="p-4 font-medium text-center">จัดการ</th>
                                    </tr>
                                </thead>
                                <tbody class="text-sm divide-y divide-gray-100">
                                    ${db.users.length === 0 ? '<tr><td colspan="3" class="p-4 text-center text-gray-500">ไม่พบข้อมูล</td></tr>' :
                    db.users.map(u => `
                                    <tr class="hover:bg-gray-50">
                                        <td class="p-4">
                                            <div class="flex items-center gap-3">
                                                <img src="https://ui-avatars.com/api/?name=${encodeURIComponent(u.name)}&background=0ea5e9&color=fff" class="w-8 h-8 rounded-full">
                                                <div>
                                                    <div class="font-medium text-gray-800 text-sm">${u.name} <span class="text-xs text-gray-400 font-normal">(@${u.username || '-'})</span></div>
                                                    <div class="text-[10px] text-gray-500 flex items-center gap-1 mt-0.5">
                                                        บทบาท: ${u.role || '-'}
                                                    </div>
                                                </div>
                                            </div>
                                        </td>
                                        <td class="p-4">
                                            <div class="text-xs text-gray-600">${u.role}</div>
                                            <span class="inline-block mt-1 px-1.5 py-0.5 bg-purple-100 text-purple-700 text-[10px] rounded">${u.access}</span>
                                        </td>
                                        <td class="p-4 flex justify-center gap-2">
                                            <button onclick="window.openEditUser(${u.id})" class="p-1.5 text-gray-400 hover:text-blue-600 rounded" title="แก้ไขผู้ใช้งาน"><i data-lucide="edit-3" class="w-4 h-4"></i></button>
                                            <button onclick="window.deleteUser(${u.id})" class="p-1.5 text-gray-400 hover:text-red-600 rounded" title="ลบผู้ใช้งาน"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
                                        </td>
                                    </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    <!-- ตั้งค่าฐานข้อมูล -->
                    <div class="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden flex flex-col h-fit">
                        <div class="p-6 border-b bg-gray-50 flex items-center gap-3">
                            <i data-lucide="settings" class="w-5 h-5 text-gray-600"></i>
                            <h2 class="text-lg font-bold text-gray-800">ตั้งค่าระบบ (Google Sheets Sync)</h2>
                        </div>
                        <div class="p-6">
                            <div class="mb-6 p-4 bg-blue-50 text-blue-800 rounded-lg text-xs border border-blue-100 flex gap-3">
                                <i data-lucide="info" class="w-4 h-4 flex-shrink-0 mt-0.5"></i>
                                <div>
                                    <p class="font-bold mb-1">การเชื่อมต่อฐานข้อมูล Cloud</p>
                                    <p>ใส่ URL ของ Google Apps Script เพื่อซิงค์ข้อมูลให้ตรงกันทุกเครื่อง หากไม่ต้องการเชื่อมต่อให้เว้นว่างไว้</p>
                                </div>
                            </div>
                            
                            <form onsubmit="window.saveSettings(event)">
                                <div class="mb-4">
                                    <label class="block text-xs font-medium text-gray-700 mb-2">Web App URL</label>
                                    <input type="url" id="apiUrlInput" value="${SCRIPT_URL}" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-primary focus:border-primary" placeholder="https://script.google.com/macros/s/.../exec">
                                </div>
                                <div id="syncStatusIndicator" class="text-xs mb-4 font-medium">
                                    ${SCRIPT_URL ? '<span class="text-emerald-600 flex items-center gap-1"><i data-lucide="check-circle" class="w-3 h-3"></i> พร้อมซิงค์ข้อมูลอัตโนมัติ</span>' : '<span class="text-amber-500 flex items-center gap-1"><i data-lucide="alert-circle" class="w-3 h-3"></i> เก็บข้อมูลแค่ในเครื่องนี้เท่านั้น</span>'}
                                </div>
                                <div class="flex flex-col sm:flex-row justify-between items-center mt-6 pt-4 border-t border-gray-100 gap-4">
                                    <button type="button" onclick="window.resetAppData()" class="text-red-500 hover:text-red-700 text-xs font-medium flex items-center gap-1 order-2 sm:order-1">
                                        <i data-lucide="trash-2" class="w-3 h-3"></i> ล้างข้อมูลแอป
                                    </button>
                                    <div class="flex flex-wrap gap-2 w-full sm:w-auto order-1 sm:order-2 justify-end">
                                        ${SCRIPT_URL ? `
                                        <button type="button" onclick="window.fetchDataFromCloud()" class="bg-gray-100 hover:bg-gray-200 text-gray-700 px-3 py-2 rounded-lg text-xs font-medium transition-colors flex items-center gap-1">
                                            <i data-lucide="download" class="w-3 h-3"></i> ดึงข้อมูล
                                        </button>
                                        <button type="button" onclick="window.manualSync()" class="bg-blue-50 hover:bg-blue-100 text-blue-700 px-3 py-2 rounded-lg text-xs font-medium transition-colors flex items-center gap-1 border border-blue-200">
                                            <i data-lucide="upload" class="w-3 h-3"></i> ส่งข้อมูลไป Cloud
                                        </button>
                                        ` : ''}
                                        <button type="submit" class="bg-primary hover:bg-primary-dark text-white px-4 py-2 rounded-lg text-xs font-medium transition-colors flex items-center gap-1 shadow-sm">
                                            <i data-lucide="save" class="w-3 h-3"></i> บันทึกตั้งค่า
                                        </button>
                                    </div>
                                </div>
                            </form>
                        </div>
                    </div>
                </div>
            `;

        default:
            return '<div class="p-8 text-center text-gray-500">ไม่พบหน้าที่ต้องการ</div>';
    }
}

function generateDrugsTableHTML(drugsArray) {
    if (!drugsArray || drugsArray.length === 0) return `<tr><td colspan="7" class="p-4 text-center text-gray-500">ไม่พบข้อมูล</td></tr>`;
    return drugsArray.filter(d => !!d).map(d => {
        const isLowStock = d.stock <= d.minLevel;
        const stockBadge = isLowStock
            ? `<span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-800">ใกล้หมด (${d.stock})</span>`
            : `<span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800">ปกติ (${d.stock})</span>`;

        const highAlertBadge = d.isHighAlert ? `<span class="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-purple-600 text-white">HAD</span>` : '';

        return `
            <tr class="table-row-hover transition-colors">
                <td class="p-4 font-medium text-primary">${d.id}</td>
                <td class="p-4">
                    <div class="font-bold flex items-center">${d.genericName} ${highAlertBadge}</div>
                    <div class="text-xs text-gray-400">${d.tradeName}</div>
                </td>
                <td class="p-4">${d.strength}</td>
                <td class="p-4 text-center text-xs text-gray-500">${window.formatSimpleDate(d.expiryDate)}</td>
                <td class="p-4 text-center font-bold text-gray-600">${d.minLevel}</td>
                <td class="p-4 text-center">${stockBadge}</td>
                <td class="p-4 flex justify-center gap-2">
                    <button onclick="window.openEditDrug('${d.id}')" class="p-1.5 text-gray-400 hover:text-blue-600 rounded" title="แก้ไข"><i data-lucide="edit-2" class="w-4 h-4"></i></button>
                    <button onclick="window.deleteDrug('${d.id}')" class="p-1.5 text-gray-400 hover:text-red-600 rounded" title="ลบ"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
                </td>
            </tr>
        `;
    }).join('');
}

function generateUsersTableHTML(usersArray) {
    if (usersArray.length === 0) return `<tr><td colspan="5" class="p-4 text-center text-gray-500">ไม่พบข้อมูลผู้ใช้งาน</td></tr>`;
    return usersArray.map(u => `
        <tr class="table-row-hover transition-colors">
            <td class="p-4">
                <div class="flex items-center gap-3">
                    <img src="https://ui-avatars.com/api/?name=${encodeURIComponent(u.name)}&background=0ea5e9&color=fff" class="w-8 h-8 rounded-full">
                    <span class="font-medium text-gray-800">${u.name}</span>
                </div>
            </td>
            <td class="p-4 text-gray-500">${u.role}</td>
            <td class="p-4"><span class="px-2 py-1 bg-purple-100 text-purple-700 text-xs rounded-md">${u.access}</span></td>
            <td class="p-4 text-xs text-gray-500">บทบาท: ${u.role}</td>
            <td class="p-4 flex justify-center gap-2">
                <button onclick="window.openEditUser(${u.id})" class="p-1.5 text-gray-400 hover:text-blue-600 rounded"><i data-lucide="edit-3" class="w-4 h-4"></i></button>
                <button onclick="window.deleteUser(${u.id})" class="p-1.5 text-gray-400 hover:text-red-600 rounded"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
            </td>
        </tr>
    `).join('');
}

function generateRxTableHTML(rxArray) {
    if (rxArray.length === 0) return `<tr><td colspan="6" class="p-8 text-center text-gray-400">ไม่มีข้อมูลใบสั่งยา</td></tr>`;
    return rxArray.map(rx => `
        <tr class="hover:bg-gray-50 transition-colors">
            <td class="p-4 font-medium text-primary">${rx.id}</td>
            <td class="p-4 text-gray-500 text-xs">${formatDate(rx.date)}</td>
            <td class="p-4">
                <div class="font-medium text-gray-800">${rx.hn}</div>
                <div class="text-xs text-gray-500">${rx.patientName}</div>
            </td>
            <td class="p-4 text-xs text-gray-600">
                ${rx.items.map(item => {
        const drug = db.drugs.find(d => d.id === item.drugId);
        return `• ${drug ? drug.genericName : item.drugId} <span class="text-primary font-medium">(${item.qty})</span>`;
    }).join('<br>')}
            </td>
            <td class="p-4 text-center">
                <span class="px-2 py-1 rounded-md text-xs border inline-block w-24 text-center ${rx.status === 'รอจัดยา' ? 'bg-amber-50 text-amber-600 border-amber-100' : 'bg-emerald-50 text-emerald-600 border-emerald-100'}">${rx.status}</span>
            </td>
            <td class="p-4 flex justify-center gap-2">
                ${rx.status === 'รอจัดยา' ? `<button onclick="window.completeRx('${rx.id}')" class="p-1.5 text-emerald-600 hover:bg-emerald-50 rounded transition-colors" title="จัดยาเสร็จสิ้น"><i data-lucide="check-circle" class="w-5 h-5"></i></button>` : ''}
                <button onclick="window.deleteRx('${rx.id}')" class="p-1.5 text-gray-400 hover:text-red-600 rounded transition-colors" title="ลบข้อมูล"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
            </td>
        </tr>
    `).join('');
}

function setupDrugSearch() {
    const input = document.getElementById('drugSearch');
    if (!input) return;
    input.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        const filtered = db.drugs.filter(d =>
            d.id.toLowerCase().includes(query) ||
            d.genericName.toLowerCase().includes(query) ||
            d.tradeName.toLowerCase().includes(query)
        );
        document.getElementById('drugsTableBody').innerHTML = generateDrugsTableHTML(filtered);
        lucide.createIcons();
    });
}

function setupRxFilter() {
    const filter = document.getElementById('rxStatusFilter');
    if (!filter) return;
    filter.addEventListener('change', (e) => {
        const val = e.target.value;
        const filtered = val === 'all' ? db.prescriptions : db.prescriptions.filter(r => r.status === val);
        document.getElementById('rxTableBody').innerHTML = generateRxTableHTML(filtered);
        lucide.createIcons();
    });
}

window.updateCurrentStock = function (drugId) {
    const d = db.drugs.find(x => x.id === drugId);
    if (d) document.getElementById('recvCurrentStock').value = d.stock;
    else document.getElementById('recvCurrentStock').value = '';
}

window.applyReceiveFilter = function () {
    appState.recvStart = document.getElementById('recvFilterStartInp').value;
    appState.recvEnd = document.getElementById('recvFilterEndInp').value;
    navigateTo('inventory');
}

window.saveReceive = function (e) {
    e.preventDefault();
    const drugRaw = document.getElementById('recvDrugId').value;
    const drugId = drugRaw.includes(':') ? drugRaw.split(':')[0].trim() : drugRaw.trim();
    const dateVal = document.getElementById('recvDate').value;
    const qty = parseInt(document.getElementById('recvQty').value);

    if (!drugId || !dateVal || !qty || qty <= 0) return alert('ข้อมูลไม่ครบถ้วน');

    window.showConfirmCustom('ยืนยันการบันทึก', `ยืนยันการบันทึกรับเข้ายาจำนวน ${qty} หน่วย ใช่หรือไม่?`, () => {
        const drug = db.drugs.find(d => String(d.id).trim() === String(drugId).trim());
        if (!drug) return alert('ไม่พบข้อมูลยา');
        drug.stock += qty;

        db.inventoryLogs.push({
            date: new Date(dateVal).toISOString(), 
            type: 'รับเข้า',
            drugId: drug.id,
            drugName: drug.genericName,
            qty: `+${qty}`,
            user: (function() {
                const userId = sessionStorage.getItem('loggedInUserId');
                const u = db.users.find(x => x.id == userId);
                return u ? u.name : 'Admin';
            })()
        });

        saveDB();
        syncDataWithCloud();
        showToast('บันทึกการรับยาเข้าเรียบร้อย');
        navigateTo('inventory');
    });
}

window.saveInventoryOut = function (e) {
    e.preventDefault();
    const drugRaw = document.getElementById('invDrugIdOut').value;
    const drugId = drugRaw.includes(':') ? drugRaw.split(':')[0].trim() : drugRaw.trim();
    const qty = parseInt(document.getElementById('invQtyOut').value);

    if (!drugId || !qty || qty <= 0) return alert('ข้อมูลไม่ถูกต้อง');
    const drug = db.drugs.find(d => String(d.id).trim() === String(drugId).trim());
    if (!drug) return alert('ไม่พบข้อมูลยา');
    if (drug.stock < qty) return alert('สต๊อกไม่พอให้เบิก (คงเหลือ: ' + drug.stock + ')');

    window.showConfirmCustom('ยืนยันการเบิกออก', `ยืนยันการบันทึกเบิกออกยาจำนวน ${qty} หน่วย ใช่หรือไม่?`, () => {
        drug.stock -= qty;
        db.inventoryLogs.push({
            date: new Date().toISOString(),
            type: 'เบิกออก',
            drugId: drug.id,
            drugName: drug.genericName,
            qty: `-${qty}`,
            user: (function() {
                const userId = sessionStorage.getItem('loggedInUserId');
                const u = db.users.find(x => x.id == userId);
                return u ? u.name : 'Admin';
            })()
        });

        saveDB();
        syncDataWithCloud();
        showToast('บันทึกเบิกออกสำเร็จ');
        navigateTo('inventory');
    });
};

window.dispenseDrugSubmit = function (e) {
    e.preventDefault();
    const rx = document.getElementById('dispenseRx').value.trim();
    const patient = document.getElementById('dispensePatient').value.trim();
    const drugRaw = document.getElementById('dispenseDrugId').value;
    const drugId = drugRaw.includes(':') ? drugRaw.split(':')[0].trim() : drugRaw.trim();
    const cycle = document.getElementById('dispenseCycle').value.trim();
    const qty = parseInt(document.getElementById('dispenseQty').value);

    if (!drugId || !qty || qty <= 0 || !cycle) return alert('ข้อมูลไม่ครบถ้วน');

    const drug = db.drugs.find(d => String(d.id).trim() === String(drugId).trim());
    if (!drug) return alert('ไม่พบข้อมูลยา');
    if (drug.stock < qty) return alert('สต๊อกไม่พอให้จ่าย (คงเหลือ: ' + drug.stock + ')');

    window.showConfirmCustom('ยืนยันการจ่ายยา', `ยืนยันการจ่ายยาให้ผู้ป่วย ${patient} จำนวน ${qty} หน่วย ใช่หรือไม่?`, () => {
        drug.stock -= qty;

        db.inventoryLogs.push({
            date: new Date().toISOString(),
            type: 'จ่ายยา',
            drugId: drug.id,
            rx: rx,
            patient: patient,
            cycle: cycle,
            drugName: drug.genericName,
            exp: drug.expiryDate || '-',
            qty: `-${qty}`,
            user: (function() {
                const userId = sessionStorage.getItem('loggedInUserId');
                const u = db.users.find(x => x.id == userId);
                return u ? u.name : 'Admin';
            })()
        });

        saveDB();
        syncDataWithCloud();
        showToast('บันทึกการจ่ายยาเรียบร้อยแล้ว');
        navigateTo('dispensing');
    });
}

window.deleteDrug = function (id) {
    const sId = String(id).trim();
    window.showConfirmCustom('ยืนยันการลบ', `ต้องการลบข้อมูลยา [${sId}] ใช่หรือไม่?`, () => {
        db.drugs = db.drugs.filter(d => String(d.id || '').trim() !== sId);
        saveDB();
        syncDataWithCloud();
        showToast('ลบข้อมูลสำเร็จ');
        if (appState.currentRoute === 'drugs') navigateTo('drugs');
    });
}

window.openEditDrug = function (id) {
    window.currentEditDrugId = id;
    openModal('editDrugModal');
}

window.editDrugSubmit = function (e) {
    e.preventDefault();
    const id = document.getElementById('editDrugId').value.trim();
    const genericName = document.getElementById('editDrugGeneric').value.trim();
    const tradeName = document.getElementById('editDrugTrade').value.trim();
    const strength = document.getElementById('editDrugStrength').value.trim();
    const type = document.getElementById('editDrugType').value;
    const minLevel = parseInt(document.getElementById('editDrugMin').value) || 0;
    const expiryDate = document.getElementById('editDrugExpiry').value;
    const isHighAlert = document.getElementById('editDrugHAD').checked;

    const drug = db.drugs.find(d => String(d.id).trim() === String(window.currentEditDrugId).trim());
    if (drug) {
        // If ID changed, check for duplicates
        if (id !== window.currentEditDrugId && db.drugs.find(d => String(d.id).trim() === id)) {
            return alert('รหัสยาใหม่นี้มีในระบบแล้ว!');
        }
        drug.id = id;
        drug.genericName = genericName;
        drug.tradeName = tradeName;
        drug.strength = strength;
        drug.type = type;
        drug.minLevel = minLevel;
        drug.expiryDate = expiryDate;
        drug.isHighAlert = isHighAlert;

        saveDB();
        syncDataWithCloud();
        closeModal();
        showToast('แก้ไขข้อมูลยาสำเร็จ');
        if (appState.currentRoute === 'drugs') navigateTo('drugs');
    }
}

window.addDrugSubmit = function (e) {
    e.preventDefault();
    const id = document.getElementById('newDrugId').value;
    const genericName = document.getElementById('newDrugGeneric').value;
    const tradeName = document.getElementById('newDrugTrade').value;
    const strength = document.getElementById('newDrugStrength').value;
    const type = document.getElementById('newDrugType').value;
    const minLevel = parseInt(document.getElementById('newDrugMin').value) || 0;
    const expiryDate = document.getElementById('newDrugExpiry').value;
    const isHighAlert = document.getElementById('newDrugHAD').checked;

    if (db.drugs.find(d => d.id === id)) {
        return alert('รหัสยานี้มีในระบบแล้ว!');
    }

    db.drugs.push({ id, genericName, tradeName, strength, type, minLevel, expiryDate, isHighAlert, stock: 0 });
    saveDB();
    closeModal();
    showToast('เพิ่มข้อมูลยาใหม่สำเร็จ');
    if (appState.currentRoute === 'drugs') navigateTo('drugs');
}

function setupToast() {
    const toast = document.createElement('div');
    toast.id = 'toastMessage';
    toast.className = 'fixed top-4 right-4 bg-emerald-500 text-white px-6 py-3 rounded-lg shadow-lg transform transition-transform duration-300 translate-x-full opacity-0 z-50 flex items-center gap-2 font-medium';
    toast.innerHTML = `<i data-lucide="check-circle" class="w-5 h-5"></i> <span>Success</span>`;
    document.body.appendChild(toast);
}

function showToast(msg) {
    const toast = document.getElementById('toastMessage');
    if (!toast) return;
    toast.querySelector('span').textContent = msg;
    toast.classList.remove('translate-x-full', 'opacity-0');

    setTimeout(() => {
        toast.classList.add('translate-x-full', 'opacity-0');
    }, 3000);
}

window.openModal = function (modalId) {
    const container = document.getElementById('modalContainer');
    if (modalId === 'addDrugModal') {
        container.innerHTML = `
            <div class="fixed inset-0 z-50 flex items-center justify-center modal-overlay bg-black/40 backdrop-blur-sm" id="addDrugOverlay">
                <div class="bg-white rounded-xl shadow-xl w-full max-w-lg overflow-hidden modal-content m-4 transform transition-all scale-100">
                    <form onsubmit="window.addDrugSubmit(event)">
                        <div class="p-4 border-b flex justify-between items-center bg-gray-50">
                            <h3 class="font-bold text-gray-800">เพิ่มข้อมูลยาใหม่</h3>
                            <button type="button" onclick="closeModal()" class="text-gray-400 hover:text-gray-600"><i data-lucide="x" class="w-5 h-5"></i></button>
                        </div>
                        <div class="p-6 space-y-4">
                            <div class="grid grid-cols-2 gap-4">
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">รหัสยา (Drug ID) *</label>
                                    <input type="text" id="newDrugId" required class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-primary focus:border-primary">
                                </div>
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">ประเภท</label>
                                    <select id="newDrugType" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-primary focus:border-primary bg-white">
                                        <option value="Vial">Vial</option>
                                        <option value="Ampule">Ampule</option>
                                        <option value="Bottle">Bottle</option>
                                    </select>
                                </div>
                            </div>
                            <div>
                                <label class="block text-xs font-medium text-gray-700 mb-1">ชื่อสามัญ (Generic Name) *</label>
                                <input type="text" id="newDrugGeneric" required class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-primary focus:border-primary">
                            </div>
                            <div>
                                <label class="block text-xs font-medium text-gray-700 mb-1">ชื่อการค้า (Trade Name)</label>
                                <input type="text" id="newDrugTrade" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-primary focus:border-primary">
                            </div>
                            <div class="grid grid-cols-2 gap-4">
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">ความแรง (Strength)</label>
                                    <input type="text" id="newDrugStrength" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-primary focus:border-primary" placeholder="เช่น 500 mg">
                                </div>
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">จุดสั่งซื้อ (Min Level)</label>
                                    <input type="number" id="newDrugMin" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-primary focus:border-primary">
                                </div>
                            </div>
                            <div class="grid grid-cols-2 gap-4">
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">วันหมดอายุ (Expiry Date)</label>
                                    <input type="date" id="newDrugExpiry" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-primary focus:border-primary">
                                </div>
                                <div class="flex items-center gap-2 pt-6">
                                    <input type="checkbox" id="newDrugHAD" class="w-4 h-4 text-purple-600 focus:ring-purple-500 border-gray-300 rounded">
                                    <label class="text-xs font-bold text-purple-700">High Alert Drug (HAD)</label>
                                </div>
                            </div>
                        </div>
                        <div class="p-4 border-t bg-gray-50 flex justify-end gap-3">
                            <button type="button" onclick="closeModal()" class="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">ยกเลิก</button>
                            <button type="submit" class="px-4 py-2 text-sm font-medium text-white bg-primary rounded-lg hover:bg-primary-dark">บันทึกข้อมูล</button>
                        </div>
                    </form>
                </div>
            </div>
        `;
    }
    if (modalId === 'editDrugModal') {
        const d = db.drugs.find(x => String(x.id).trim() === String(window.currentEditDrugId).trim());
        if (!d) return closeModal();
        container.innerHTML = `
            <div class="fixed inset-0 z-50 flex items-center justify-center modal-overlay bg-black/40 backdrop-blur-sm" id="editDrugOverlay">
                <div class="bg-white rounded-xl shadow-xl w-full max-w-lg overflow-hidden modal-content m-4 transform transition-all scale-100">
                    <form onsubmit="window.editDrugSubmit(event)">
                        <div class="p-4 border-b flex justify-between items-center bg-gray-50">
                            <h3 class="font-bold text-gray-800">แก้ไขข้อมูลยา</h3>
                            <button type="button" onclick="closeModal()" class="text-gray-400 hover:text-gray-600"><i data-lucide="x" class="w-5 h-5"></i></button>
                        </div>
                        <div class="p-6 space-y-4">
                            <div class="grid grid-cols-2 gap-4">
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">รหัสยา (Drug ID) *</label>
                                    <input type="text" id="editDrugId" value="${d.id}" required class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-primary focus:border-primary">
                                </div>
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">ประเภท</label>
                                    <select id="editDrugType" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-primary focus:border-primary bg-white">
                                        <option value="Vial" ${d.type === 'Vial' ? 'selected' : ''}>Vial</option>
                                        <option value="Ampule" ${d.type === 'Ampule' ? 'selected' : ''}>Ampule</option>
                                        <option value="Bottle" ${d.type === 'Bottle' ? 'selected' : ''}>Bottle</option>
                                    </select>
                                </div>
                            </div>
                            <div>
                                <label class="block text-xs font-medium text-gray-700 mb-1">ชื่อสามัญ (Generic Name) *</label>
                                <input type="text" id="editDrugGeneric" value="${d.genericName}" required class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-primary focus:border-primary">
                            </div>
                            <div>
                                <label class="block text-xs font-medium text-gray-700 mb-1">ชื่อการค้า (Trade Name)</label>
                                <input type="text" id="editDrugTrade" value="${d.tradeName || ''}" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-primary focus:border-primary">
                            </div>
                            <div class="grid grid-cols-2 gap-4">
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">ความแรง (Strength)</label>
                                    <input type="text" id="editDrugStrength" value="${d.strength || ''}" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-primary focus:border-primary">
                                </div>
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">จุดสั่งซื้อ (Min Level)</label>
                                    <input type="number" id="editDrugMin" value="${d.minLevel || 0}" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-primary focus:border-primary">
                                </div>
                            </div>
                            <div class="grid grid-cols-2 gap-4">
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">วันหมดอายุ (Expiry Date)</label>
                                    <input type="date" id="editDrugExpiry" value="${d.expiryDate || ''}" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-primary focus:border-primary">
                                </div>
                                <div class="flex items-center gap-2 pt-6">
                                    <input type="checkbox" id="editDrugHAD" ${d.isHighAlert ? 'checked' : ''} class="w-4 h-4 text-purple-600 focus:ring-purple-500 border-gray-300 rounded">
                                    <label class="text-xs font-bold text-purple-700">High Alert Drug (HAD)</label>
                                </div>
                            </div>
                        </div>
                        <div class="p-4 border-t bg-gray-50 flex justify-end gap-3">
                            <button type="button" onclick="closeModal()" class="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">ยกเลิก</button>
                            <button type="submit" class="px-4 py-2 text-sm font-medium text-white bg-primary rounded-lg hover:bg-primary-dark">บันทึกการแก้ไข</button>
                        </div>
                    </form>
                </div>
            </div>
        `;
    }
    if (modalId === 'addUserModal') {
        container.innerHTML = `
            <div class="fixed inset-0 z-50 flex items-center justify-center modal-overlay bg-black/40 backdrop-blur-sm" id="addUserOverlay">
                <div class="bg-white rounded-xl shadow-xl w-full max-w-lg overflow-hidden modal-content m-4 transform transition-all scale-100">
                    <form onsubmit="window.addUserSubmit(event)">
                        <div class="p-4 border-b flex justify-between items-center bg-gray-50">
                            <h3 class="font-bold text-gray-800">เพิ่มผู้ใช้งานใหม่</h3>
                            <button type="button" onclick="closeModal()" class="text-gray-400 hover:text-gray-600"><i data-lucide="x" class="w-5 h-5"></i></button>
                        </div>
                        <div class="p-6 space-y-4">
                            <div>
                                <label class="block text-xs font-medium text-gray-700 mb-1">ชื่อ - นามสกุล *</label>
                                <input type="text" id="newUserName" required class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-primary focus:border-primary">
                            </div>
                            <div class="grid grid-cols-2 gap-4">
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">ชื่อผู้ใช้งาน (Username) *</label>
                                    <input type="text" id="newUserUsername" required class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-primary focus:border-primary" placeholder="ใช้ล็อกอิน">
                                </div>
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">รหัสผ่าน (Password) *</label>
                                    <input type="password" id="newUserPassword" required class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-primary focus:border-primary" placeholder="ตั้งรหัสผ่าน">
                                </div>
                            </div>
                            <div class="grid grid-cols-2 gap-4">
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">ตำแหน่ง</label>
                                    <input type="text" id="newUserRole" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-primary focus:border-primary" placeholder="เช่น เภสัชกร">
                                </div>
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">สิทธิ์การใช้งาน</label>
                                    <select id="newUserAccess" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-primary focus:border-primary bg-white">
                                        <option value="เจ้าหน้าที่">เจ้าหน้าที่</option>
                                        <option value="ผู้ดูแลระบบ">ผู้ดูแลระบบ</option>
                                    </select>
                                </div>
                            </div>
                        </div>
                        <div class="p-4 border-t bg-gray-50 flex justify-end gap-3">
                            <button type="button" onclick="closeModal()" class="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">ยกเลิก</button>
                            <button type="submit" class="px-4 py-2 text-sm font-medium text-white bg-primary rounded-lg hover:bg-primary-dark">บันทึกข้อมูล</button>
                        </div>
                    </form>
                </div>
            </div>
        `;
    }
    if (modalId === 'editUserModal') {
        const u = db.users.find(x => x.id === window.currentEditUserId);
        container.innerHTML = `
            <div class="fixed inset-0 z-50 flex items-center justify-center modal-overlay bg-black/40 backdrop-blur-sm" id="editUserOverlay">
                <div class="bg-white rounded-xl shadow-xl w-full max-w-lg overflow-hidden modal-content m-4 transform transition-all scale-100">
                    <form onsubmit="window.editUserSubmit(event)">
                        <div class="p-4 border-b flex justify-between items-center bg-gray-50">
                            <h3 class="font-bold text-gray-800">แก้ไขผู้ใช้งาน</h3>
                            <button type="button" onclick="closeModal()" class="text-gray-400 hover:text-gray-600"><i data-lucide="x" class="w-5 h-5"></i></button>
                        </div>
                        <div class="p-6 space-y-4">
                            <div>
                                <label class="block text-xs font-medium text-gray-700 mb-1">ชื่อ - นามสกุล *</label>
                                <input type="text" id="editUserName" value="${u ? u.name : ''}" required class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-primary focus:border-primary">
                            </div>
                            <div class="grid grid-cols-2 gap-4">
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">ชื่อผู้ใช้งาน (Username) *</label>
                                    <input type="text" id="editUserUsername" value="${u ? (u.username || '') : ''}" required class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-primary focus:border-primary">
                                </div>
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">รหัสผ่านใหม่ (ปล่อยว่างถ้าไม่เปลี่ยน)</label>
                                    <input type="password" id="editUserPassword" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-primary focus:border-primary" placeholder="*******">
                                </div>
                            </div>
                            <div class="grid grid-cols-2 gap-4">
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">ตำแหน่ง</label>
                                    <input type="text" id="editUserRole" value="${u ? u.role : ''}" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-primary focus:border-primary">
                                </div>
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">สิทธิ์การใช้งาน</label>
                                    <select id="editUserAccess" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-primary focus:border-primary bg-white">
                                        <option value="เจ้าหน้าที่" ${u && u.access === 'เจ้าหน้าที่' ? 'selected' : ''}>เจ้าหน้าที่</option>
                                        <option value="ผู้ดูแลระบบ" ${u && u.access === 'ผู้ดูแลระบบ' ? 'selected' : ''}>ผู้ดูแลระบบ</option>
                                    </select>
                                </div>
                            </div>
                        </div>
                        <div class="p-4 border-t bg-gray-50 flex justify-end gap-3">
                            <button type="button" onclick="closeModal()" class="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">ยกเลิก</button>
                            <button type="submit" class="px-4 py-2 text-sm font-medium text-white bg-primary rounded-lg hover:bg-primary-dark">บันทึกข้อมูล</button>
                        </div>
                    </form>
                </div>
            </div>
        `;
    }
    if (modalId === 'addRxModal') {
        container.innerHTML = `
            <div class="fixed inset-0 z-50 flex items-center justify-center modal-overlay bg-black/40 backdrop-blur-sm" id="addRxOverlay">
                <div class="bg-white rounded-xl shadow-xl w-full max-w-lg overflow-hidden modal-content m-4 transform transition-all scale-100">
                    <form onsubmit="window.addRxSubmit(event)">
                        <div class="p-4 border-b flex justify-between items-center bg-gray-50">
                            <h3 class="font-bold text-gray-800">เพิ่มข้อมูลใบสั่งยา</h3>
                            <button type="button" onclick="closeModal()" class="text-gray-400 hover:text-gray-600"><i data-lucide="x" class="w-5 h-5"></i></button>
                        </div>
                        <div class="p-6 space-y-4">
                            <div class="grid grid-cols-2 gap-4">
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">เลขที่ใบสั่งยา (Rx) *</label>
                                    <input type="text" id="newRxId" required class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-primary focus:border-primary" placeholder="เช่น RX-1002">
                                </div>
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">HN ผู้ป่วย *</label>
                                    <input type="text" id="newRxHn" required class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-primary focus:border-primary" placeholder="เช่น HN-54321">
                                </div>
                            </div>
                            <div class="grid grid-cols-12 gap-4">
                                <div class="col-span-6">
                                    <label class="block text-xs font-medium text-gray-700 mb-1">ชื่อ-นามสกุลผู้ป่วย *</label>
                                    <input type="text" id="newRxPatient" required readonly class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-gray-50 focus:outline-none" placeholder="ดึงข้อมูลอัตโนมัติ">
                                </div>
                                <div class="col-span-3">
                                    <label class="block text-xs font-medium text-gray-700 mb-1">อายุ</label>
                                    <input type="text" id="newRxAge" readonly class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-gray-50 focus:outline-none" placeholder="-">
                                </div>
                                <div class="col-span-3">
                                    <label class="block text-xs font-medium text-gray-700 mb-1">เพศ</label>
                                    <input type="text" id="newRxGender" readonly class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-gray-50 focus:outline-none" placeholder="-">
                                </div>
                            </div>
                            <div class="grid grid-cols-3 gap-4">
                                <div class="col-span-2">
                                    <label class="block text-xs font-medium text-gray-700 mb-1">เลือกยา (พิมพ์เพื่อค้นหา) *</label>
                                    <input list="newRxDrugOptions" id="newRxDrug" required class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-primary focus:border-primary" placeholder="ค้นหารหัสยา หรือ ชื่อยา...">
                                    <datalist id="newRxDrugOptions">
                                        ${db.drugs.map(d => `<option value="${d.id} : ${d.genericName}"></option>`).join('')}
                                    </datalist>
                                </div>
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">จำนวน *</label>
                                    <input type="number" id="newRxQty" min="1" required class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-primary focus:border-primary">
                                </div>
                            </div>
                        </div>
                        <div class="p-4 border-t bg-gray-50 flex justify-end gap-3">
                            <button type="button" onclick="closeModal()" class="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">ยกเลิก</button>
                            <button type="submit" class="px-4 py-2 text-sm font-medium text-white bg-primary rounded-lg hover:bg-primary-dark">บันทึกใบสั่งยา</button>
                        </div>
                    </form>
                </div>
            </div>
        `;

        // Auto-fill patient name from HN
        const hnInput = document.getElementById('newRxHn');
        const patientInput = document.getElementById('newRxPatient');
        const ageInput = document.getElementById('newRxAge');
        const genderInput = document.getElementById('newRxGender');
        
        if (hnInput && patientInput) {
            hnInput.addEventListener('input', (e) => {
                const hn = e.target.value.trim();
                const p = db.patients.find(x => String(x.hn).trim() === hn);
                if (p) {
                    patientInput.value = `${p.title || ''}${p.name} ${p.surname || ''}`.trim();
                    if(ageInput) ageInput.value = p.age ? `${p.age} ปี` : '-';
                    if(genderInput) genderInput.value = p.gender || '-';
                } else {
                    patientInput.value = '';
                    if(ageInput) ageInput.value = '';
                    if(genderInput) genderInput.value = '';
                }
            });
        }
    } else if (modalId === 'addPatientModal') {
        container.innerHTML = `
            <div class="fixed inset-0 z-50 flex items-center justify-center modal-overlay bg-black/40 backdrop-blur-sm" id="addPatientOverlay">
                <div class="bg-white rounded-xl shadow-xl w-full max-w-lg overflow-hidden modal-content m-4">
                    <form onsubmit="window.addPatientSubmit(event)">
                        <div class="p-4 border-b flex justify-between items-center bg-gray-50">
                            <h3 class="font-bold text-gray-800 flex items-center gap-2"><i data-lucide="user-plus" class="w-5 h-5"></i> เพิ่มข้อมูลผู้ป่วยใหม่</h3>
                            <button type="button" onclick="closeModal()" class="text-gray-400 hover:text-gray-600"><i data-lucide="x" class="w-5 h-5"></i></button>
                        </div>
                        <div class="p-6 space-y-4">
                            <div class="grid grid-cols-2 gap-4">
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">HN (รหัสผู้ป่วย) *</label>
                                    <input type="number" id="newPhn" required placeholder="เช่น 66001234" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-primary focus:border-primary outline-none">
                                </div>
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">คำนำหน้า *</label>
                                    <select id="newPtitle" required class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-primary focus:border-primary outline-none bg-white">
                                        <option value="นาย">นาย</option>
                                        <option value="นาง">นาง</option>
                                        <option value="นางสาว">นางสาว</option>
                                        <option value="ด.ช.">ด.ช.</option>
                                        <option value="ด.ญ.">ด.ญ.</option>
                                    </select>
                                </div>
                            </div>
                            <div class="grid grid-cols-2 gap-4">
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">ชื่อ *</label>
                                    <input type="text" id="newPname" required class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-primary focus:border-primary outline-none">
                                </div>
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">นามสกุล *</label>
                                    <input type="text" id="newPsurname" required class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-primary focus:border-primary outline-none">
                                </div>
                            </div>
                            <div class="grid grid-cols-3 gap-4">
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">เพศ</label>
                                    <select id="newPgender" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm outline-none bg-white">
                                        <option value="ชาย">ชาย</option>
                                        <option value="หญิง">หญิง</option>
                                    </select>
                                </div>
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">อายุ</label>
                                    <input type="number" id="newPage" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm outline-none">
                                </div>
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">สัญชาติ</label>
                                    <input type="text" id="newPnat" value="ไทย" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm outline-none">
                                </div>
                            </div>
                            <div>
                                <label class="block text-xs font-medium text-gray-700 mb-1">วันเกิด</label>
                                <input type="date" id="newPbirth" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm outline-none">
                            </div>
                        </div>
                        <div class="p-4 border-t bg-gray-50 flex justify-end gap-3">
                            <button type="button" onclick="closeModal()" class="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">ยกเลิก</button>
                            <button type="submit" class="px-4 py-2 text-sm font-medium text-white bg-primary rounded-lg hover:bg-primary-dark transition-colors shadow-md">บันทึกข้อมูลผู้ป่วย</button>
                        </div>
                    </form>
                </div>
            </div>
        `;
    } else if (modalId === 'editPatientModal') {
        const p = db.patients.find(x => String(x.hn).trim() === String(window.currentEditPatientHn).trim());
        if (!p) return closeModal();
        container.innerHTML = `
            <div class="fixed inset-0 z-50 flex items-center justify-center modal-overlay bg-black/40 backdrop-blur-sm" id="editPatientOverlay">
                <div class="bg-white rounded-xl shadow-xl w-full max-w-lg overflow-hidden modal-content m-4">
                    <form onsubmit="window.editPatientSubmit(event)">
                        <div class="p-4 border-b flex justify-between items-center bg-gray-50">
                            <h3 class="font-bold text-gray-800 flex items-center gap-2"><i data-lucide="user-cog" class="w-5 h-5"></i> แก้ไขข้อมูลผู้ป่วย</h3>
                            <button type="button" onclick="closeModal()" class="text-gray-400 hover:text-gray-600"><i data-lucide="x" class="w-5 h-5"></i></button>
                        </div>
                        <div class="p-6 space-y-4">
                            <div class="grid grid-cols-2 gap-4">
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">HN (รหัสผู้ป่วย) *</label>
                                    <input type="number" id="editPhn" value="${p.hn}" required class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-primary focus:border-primary outline-none bg-gray-50" readonly>
                                </div>
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">คำนำหน้า *</label>
                                    <select id="editPtitle" required class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-primary focus:border-primary outline-none bg-white">
                                        <option value="นาย" ${p.title === 'นาย' ? 'selected' : ''}>นาย</option>
                                        <option value="นาง" ${p.title === 'นาง' ? 'selected' : ''}>นาง</option>
                                        <option value="นางสาว" ${p.title === 'นางสาว' ? 'selected' : ''}>นางสาว</option>
                                        <option value="ด.ช." ${p.title === 'ด.ช.' ? 'selected' : ''}>ด.ช.</option>
                                        <option value="ด.ญ." ${p.title === 'ด.ญ.' ? 'selected' : ''}>ด.ญ.</option>
                                    </select>
                                </div>
                            </div>
                            <div class="grid grid-cols-2 gap-4">
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">ชื่อ *</label>
                                    <input type="text" id="editPname" value="${p.name}" required class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-primary focus:border-primary outline-none">
                                </div>
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">นามสกุล *</label>
                                    <input type="text" id="editPsurname" value="${p.surname || ''}" required class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-primary focus:border-primary outline-none">
                                </div>
                            </div>
                            <div class="grid grid-cols-3 gap-4">
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">เพศ</label>
                                    <select id="editPgender" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm outline-none bg-white">
                                        <option value="ชาย" ${p.gender === 'ชาย' ? 'selected' : ''}>ชาย</option>
                                        <option value="หญิง" ${p.gender === 'หญิง' ? 'selected' : ''}>หญิง</option>
                                    </select>
                                </div>
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">อายุ</label>
                                    <input type="number" id="editPage" value="${p.age || ''}" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm outline-none">
                                </div>
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">สัญชาติ</label>
                                    <input type="text" id="editPnat" value="${p.nationality || 'ไทย'}" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm outline-none">
                                </div>
                            </div>
                            <div>
                                <label class="block text-xs font-medium text-gray-700 mb-1">วันเกิด</label>
                                <input type="date" id="editPbirth" value="${p.birthDate || ''}" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm outline-none">
                            </div>
                        </div>
                        <div class="p-4 border-t bg-gray-50 flex justify-end gap-3">
                            <button type="button" onclick="closeModal()" class="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">ยกเลิก</button>
                            <button type="submit" class="px-4 py-2 text-sm font-medium text-white bg-primary rounded-lg hover:bg-primary-dark transition-colors shadow-md">บันทึกการแก้ไข</button>
                        </div>
                    </form>
                </div>
            </div>
        `;
    }

    if(window.lucide) window.lucide.createIcons();

    // Close on overlay click
    document.getElementById('editPatientOverlay')?.addEventListener('click', (e) => {
        if (e.target.id === 'editPatientOverlay') closeModal();
    });
    document.getElementById('addDrugOverlay')?.addEventListener('click', (e) => {
        if (e.target.id === 'addDrugOverlay') closeModal();
    });
    document.getElementById('editDrugOverlay')?.addEventListener('click', (e) => {
        if (e.target.id === 'editDrugOverlay') closeModal();
    });
    document.getElementById('addUserOverlay')?.addEventListener('click', (e) => {
        if (e.target.id === 'addUserOverlay') closeModal();
    });
    document.getElementById('editUserOverlay')?.addEventListener('click', (e) => {
        if (e.target.id === 'editUserOverlay') closeModal();
    });
    document.getElementById('addRxOverlay')?.addEventListener('click', (e) => {
        if (e.target.id === 'addRxOverlay') closeModal();
    });
    document.getElementById('addPatientOverlay')?.addEventListener('click', (e) => {
        if (e.target.id === 'addPatientOverlay') closeModal();
    });
}

window.closeModal = function () {
    document.getElementById('modalContainer').innerHTML = '';
}

// Redundant checkLogin removed (complex version is at the end of the file)


window.handleLogin = function (e) {
    e.preventDefault();
    const u = document.getElementById('loginUsername').value.trim().toLowerCase();
    const p = document.getElementById('loginPassword').value.trim();
    const urlInput = document.getElementById('sheetUrl');

    let matchedUser = db.users.find(user => (user.username || '').toLowerCase() === u && String(user.password) === p);

    // Safety net: If admin/1234 is used but not found, check if we can fix the default admin
    if (!matchedUser && u === 'admin' && p === '1234') {
        matchedUser = db.users.find(user => user.id === 1 || user.name === 'Admin User');
        if (matchedUser) {
            matchedUser.username = 'admin';
            matchedUser.password = '1234';
            saveDB();
        syncDataWithCloud();
        }
    }

    if (matchedUser) {
        sessionStorage.setItem('isLoggedIn', 'true');
        sessionStorage.setItem('loggedInUserId', matchedUser.id);

        matchedUser.status = 'ออนไลน์';
        matchedUser.lastLogin = new Date().toISOString();
        saveDB();
        syncDataWithCloud();

        document.getElementById('loginScreen').style.display = 'none';
        document.getElementById('appLayout').classList.remove('hidden');
        document.getElementById('loginError').classList.add('hidden');

        updateUserProfileUI(matchedUser);

        if (urlInput && urlInput.value.trim()) {
            SCRIPT_URL = urlInput.value.trim();
            localStorage.setItem(API_URL_KEY, SCRIPT_URL);
            showToast('กำลังโหลดข้อมูลจาก Google Sheets...');
            fetchDataFromCloud();
        }
    } else {
        document.getElementById('loginError').classList.remove('hidden');
    }
}

window.handleLogout = function () {
    const userId = sessionStorage.getItem('loggedInUserId');
    if (userId) {
        const u = db.users.find(user => user.id == userId);
        if (u) {
            u.status = 'ออฟไลน์';
            saveDB();
        syncDataWithCloud();
        }
    }
    sessionStorage.removeItem('isLoggedIn');
    sessionStorage.removeItem('loggedInUserId');
    window.location.reload();
}

window.deleteUser = function (id) {
    const loggedInId = sessionStorage.getItem('loggedInUserId');
    if (id == loggedInId) {
        return alert('ไม่สามารถลบผู้ใช้งานที่กำลังล็อกอินอยู่ได้');
    }
    const u = db.users.find(user => String(user.id).trim() === String(id).trim());
    window.showConfirmCustom('ยืนยันการลบ', `ต้องการลบผู้ใช้งาน [${u ? u.name : id}] ใช่หรือไม่?`, () => {
        db.users = db.users.filter(user => String(user.id).trim() !== String(id).trim());
        saveDB();
        syncDataWithCloud();
        showToast('ลบผู้ใช้งานสำเร็จ');
        if (appState.currentRoute === 'settings') navigateTo('settings');
    });
}

window.addUserSubmit = function (e) {
    e.preventDefault();
    const name = document.getElementById('newUserName').value;
    const username = document.getElementById('newUserUsername').value.trim().toLowerCase();
    const password = document.getElementById('newUserPassword').value.trim();
    const role = document.getElementById('newUserRole').value;
    const access = document.getElementById('newUserAccess').value;

    if (db.users.find(u => (u.username || '').toLowerCase() === username)) {
        return alert('ชื่อผู้ใช้งาน (Username) นี้มีในระบบแล้ว!');
    }

    const newId = db.users.length ? Math.max(...db.users.map(u => u.id)) + 1 : 1;
    db.users.push({ id: newId, name, username, password, role, access, status: 'ออฟไลน์', lastLogin: null });
    saveDB();
    closeModal();
    showToast('เพิ่มผู้ใช้งานสำเร็จ');
    if (appState.currentRoute === 'settings') navigateTo('settings');
}

window.openEditUser = function (id) {
    window.currentEditUserId = id;
    openModal('editUserModal');
}

window.editUserSubmit = function (e) {
    e.preventDefault();
    const name = document.getElementById('editUserName').value;
    const username = document.getElementById('editUserUsername').value.trim().toLowerCase();
    const password = document.getElementById('editUserPassword').value.trim();
    const role = document.getElementById('editUserRole').value;
    const access = document.getElementById('editUserAccess').value;

    const u = db.users.find(x => x.id === window.currentEditUserId);
    if (u) {
        if (db.users.find(x => x.id !== u.id && (x.username || '').toLowerCase() === username)) {
            return alert('ชื่อผู้ใช้งาน (Username) นี้มีในระบบแล้ว!');
        }
        u.name = name;
        u.username = username;
        if (password) u.password = password; // Only update if provided
        u.role = role;
        u.access = access;
        saveDB();
        syncDataWithCloud();
        closeModal();
        showToast('แก้ไขข้อมูลสำเร็จ');
        if (appState.currentRoute === 'settings') navigateTo('settings');
    }
}

window.addRxSubmit = function (e) {
    e.preventDefault();
    const id = document.getElementById('newRxId').value.trim();
    const hn = document.getElementById('newRxHn').value.trim();
    const patientName = document.getElementById('newRxPatient').value.trim();
    const drugRaw = document.getElementById('newRxDrug').value;
    const drugId = drugRaw.includes(':') ? drugRaw.split(':')[0].trim() : drugRaw.trim();
    const qty = parseInt(document.getElementById('newRxQty').value);

    if (db.prescriptions.find(r => String(r.id).trim() === String(id).trim())) {
        return alert('เลขที่ใบสั่งยานี้มีในระบบแล้ว!');
    }

    window.showConfirmCustom('ยืนยันการเพิ่ม', `ยืนยันการเพิ่มใบสั่งยาเลขที่ ${id} ใช่หรือไม่?`, () => {
        db.prescriptions.push({
            id, hn, patientName, status: 'รอจัดยา', date: new Date().toISOString(), items: [{ drugId, qty }]
        });
        saveDB();
        syncDataWithCloud();
        closeModal();
        showToast('เพิ่มใบสั่งยาสำเร็จ');
        if (appState.currentRoute === 'dispensing') navigateTo('dispensing');
    });
}

window.completeRx = function (id) {
    const rx = db.prescriptions.find(r => r.id === id);
    if (rx) {
        rx.status = 'จ่ายยาแล้ว';
        saveDB();
        syncDataWithCloud();
        showToast('อัปเดตสถานะเป็นจ่ายยาแล้ว');
        if (appState.currentRoute === 'dispensing') navigateTo('dispensing');
    }
}

window.deleteRx = function (id) {
    db.prescriptions = db.prescriptions.filter(r => r.id !== id);
    saveDB();
    showToast('ลบใบสั่งยาสำเร็จ');
    if (appState.currentRoute === 'dispensing') navigateTo('dispensing');
}

window.saveSettings = function (e) {
    e.preventDefault();
    const url = document.getElementById('apiUrlInput').value.trim();
    SCRIPT_URL = url;
    localStorage.setItem(API_URL_KEY, url);
    showToast('บันทึกการตั้งค่าเรียบร้อยแล้ว');
    if (url) {
        showToast('กำลังโหลดข้อมูลจาก Google Sheets...');
        fetchDataFromCloud();
    }
}

window.resetAppData = function () {
    if (confirm('คำเตือน: ข้อมูลทั้งหมดในเครื่องนี้จะถูกลบและเริ่มใหม่ (ถ้าเชื่อมต่อ Google Sheets ข้อมูลบน Cloud จะไม่หาย) ยืนยันใช่หรือไม่?')) {
        localStorage.removeItem(DB_KEY);
        window.location.reload();
    }
}

window.deletePatient = function (hn) {
    const sHn = String(hn).trim();
    window.showConfirmCustom('ยืนยันการลบ', `ต้องการลบข้อมูลผู้ป่วย HN: ${sHn} ใช่หรือไม่?`, () => {
        db.patients = db.patients.filter(p => String(p.hn).trim() !== sHn);
        saveDB();
        syncDataWithCloud();
        showToast('ลบข้อมูลผู้ป่วยสำเร็จ');
        if (appState.currentRoute === 'patients') navigateTo('patients');
    });
}

window.addPatientSubmit = function (e) {
    e.preventDefault();
    const hn = document.getElementById('newPhn').value.trim();
    const title = document.getElementById('newPtitle').value;
    const name = document.getElementById('newPname').value.trim();
    const surname = document.getElementById('newPsurname').value.trim();
    const gender = document.getElementById('newPgender').value;
    const age = document.getElementById('newPage').value;
    const birthDate = document.getElementById('newPbirth').value;
    const nationality = document.getElementById('newPnat').value || 'ไทย';

    if (db.patients.find(p => p.hn === hn)) {
        return alert('HN นี้มีในระบบแล้ว!');
    }

    db.patients.push({ hn, title, name, surname, gender, age, birthDate, nationality });
    saveDB();
    closeModal();
    showToast('เพิ่มข้อมูลผู้ป่วยสำเร็จ');
    if (appState.currentRoute === 'patients') navigateTo('patients');
}

window.generateReportAction = function () {
    const type = document.getElementById('rptType').value;
    const start = document.getElementById('rptStart').value;
    const end = document.getElementById('rptEnd').value;
    const drugId = document.getElementById('rptDrugId') ? document.getElementById('rptDrugId').value : null;

    if (type !== 'summary' && (!start || !end)) {
        return alert('กรุณาเลือกช่วงเวลา (วันที่เริ่มต้นและสิ้นสุด) สำหรับรายงานประเภทนี้');
    }

    if (start && end && start > end) {
        return alert('วันที่เริ่มต้นต้องไม่เกินวันที่สิ้นสุด');
    }

    if (type === 'stock_card' && !drugId) {
        return alert('กรุณาเลือกยา สำหรับจัดพิมพ์แบบฟอร์ม Stock');
    }

    const issuer = document.getElementById('rptIssuer') ? document.getElementById('rptIssuer').value : 'Admin';

    window.printReportPDF(type, start, end, drugId, issuer);
}

window.printReportPDF = function (type = 'summary', start = null, end = null, drugId = null, issuer = 'Admin') {
    const printWindow = window.open('', '_blank');

    let title = "รายงานยาคงคลังปัจจุบัน";
    let dataHtml = "";
    let filterText = "";

    if (type === 'stock_card') {
        const drug = db.drugs.find(d => d.id === drugId);
        title = "แบบฟอร์ม Stock";
        filterText = `<h3 style="text-align:center;">รายการยา: ${drug.genericName}</h3><p class="date">ช่วงเวลา: ${start} ถึง ${end}</p>`;

        let allLogs = db.inventoryLogs.filter(log => log.drugId === drugId || log.drugName === drug.genericName);
        allLogs.sort((a, b) => new Date(a.date) - new Date(b.date));

        let balance = 0;
        let bfBalance = 0;
        let processedLogs = [];

        for (let log of allLogs) {
            let logDate = log.date.split('T')[0];
            let qty = parseInt(log.qty);
            balance += qty;

            if (logDate < start) {
                bfBalance = balance;
            } else if (logDate >= start && logDate <= end) {
                processedLogs.push({ ...log, balanceAfter: balance });
            }
        }

        dataHtml = `
            <table>
                <thead>
                    <tr>
                        <th rowspan="2" style="text-align:center; vertical-align:middle;">วัน-เดือน-ปี</th>
                        <th colspan="3" style="text-align:center;">จำนวน</th>
                        <th rowspan="2" style="text-align:center; vertical-align:middle;">HN</th>
                        <th rowspan="2" style="text-align:center; vertical-align:middle;">ชื่อ-นามสกุล</th>
                        <th rowspan="2" style="text-align:center; vertical-align:middle;">Cycle</th>
                        <th rowspan="2" style="text-align:center; vertical-align:middle;">Exp</th>
                        <th rowspan="2" style="text-align:center; vertical-align:middle;">เภสัชกร</th>
                    </tr>
                    <tr>
                        <th style="text-align:center;">รับ</th>
                        <th style="text-align:center;">จ่าย</th>
                        <th style="text-align:center;">คงเหลือ</th>
                    </tr>
                </thead>
                <tbody>
                    <tr style="background-color: #fcfcfc;">
                        <td colspan="3" style="text-align:right; font-weight:bold;">ยอดยกมา</td>
                        <td style="text-align:center; font-weight:bold;">${bfBalance}</td>
                        <td colspan="5"></td>
                    </tr>
                    ${processedLogs.length === 0 ? '<tr><td colspan="9" style="text-align:center">ไม่มีรายการในช่วงเวลานี้</td></tr>' :
                processedLogs.map(l => {
                    let qtyAbs = Math.abs(parseInt(l.qty));
                    let isReceive = parseInt(l.qty) > 0;
                    return `
                          <tr>
                              <td style="text-align:center;">${l.date.split('T')[0]}</td>
                              <td style="text-align:center; color:green; font-weight:bold;">${isReceive ? qtyAbs : ''}</td>
                              <td style="text-align:center; color:red; font-weight:bold;">${!isReceive ? qtyAbs : ''}</td>
                              <td style="text-align:center; font-weight:bold;">${l.balanceAfter}</td>
                              <td style="text-align:center;">${l.hn || l.rx || ''}</td>
                              <td style="text-align:center;">${l.patientName || l.patient || ''}</td>
                              <td style="text-align:center;">${l.cycle || ''}</td>
                              <td style="text-align:center;">${l.exp || ''}</td>
                              <td style="text-align:center;">${l.user || ''}</td>
                          </tr>
                          `;
                }).join('')}
                </tbody>
            </table>
        `;
    } else if (type === 'summary') {
        title = "รายงานสรุปยาคงคลัง";
        dataHtml = `
            <table>
                <thead>
                    <tr>
                        <th>รหัสยา</th>
                        <th>ชื่อสามัญ (Generic Name)</th>
                        <th>วันหมดอายุ</th>
                        <th>ความแรง</th>
                        <th>คงเหลือ</th>
                        <th>สถานะ</th>
                    </tr>
                </thead>
                <tbody>
                    ${db.drugs.map(d => `
                        <tr>
                            <td>${d.id}</td>
                            <td>${d.genericName} ${d.isHighAlert ? '<b style="color:purple">[HAD]</b>' : ''}</td>
                            <td>${d.expiryDate || '-'}</td>
                            <td>${d.strength}</td>
                            <td class="${d.stock <= d.minLevel ? 'low-stock' : ''}">${d.stock}</td>
                            <td>${d.stock <= d.minLevel ? 'ควรสั่งซื้อเพิ่ม' : 'ปกติ'}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    } else {
        const isReceive = type === 'in';
        title = isReceive ? "รายงานการรับยา" : "รายงานการจ่ายยา";
        filterText = `<p class="date">ช่วงเวลา: ${start} ถึง ${end}</p>`;

        const logs = db.inventoryLogs.filter(log => {
            const logDate = log.date.split('T')[0];
            const matchesDate = logDate >= start && logDate <= end;
            const matchesType = isReceive ? (log.type === 'รับเข้า') : (log.type === 'จ่ายยา' || log.type === 'เบิกออก');
            return matchesDate && matchesType;
        });

        dataHtml = `
            <table>
                <thead>
                    <tr>
                        <th>วันที่-เวลา</th>
                        <th>รายการยา</th>
                        <th>จำนวน</th>
                        <th>ผู้ป่วย/Rx</th>
                        <th>ผู้ทำรายการ</th>
                    </tr>
                </thead>
                <tbody>
                    ${logs.length === 0 ? '<tr><td colspan="5" style="text-align:center">ไม่พบข้อมูลในช่วงเวลาที่เลือก</td></tr>' :
                logs.map(l => `
                        <tr>
                            <td>${formatDate(l.date)}</td>
                            <td>${l.drugName}</td>
                            <td style="font-weight:bold; color:${isReceive ? 'green' : 'red'}">${l.qty}</td>
                            <td>${l.patient || l.rx || '-'}</td>
                            <td>${l.user}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    }

    let html = `
    <!DOCTYPE html>
    <html lang="th">
    <head>
        <meta charset="UTF-8">
        <title>${title}</title>
        <style>
            @import url('https://fonts.googleapis.com/css2?family=Sarabun:wght@300;400;700&display=swap');
            body { font-family: 'Sarabun', sans-serif; padding: 40px; color: #333; line-height: 1.6; }
            table { width: 100%; border-collapse: collapse; margin-top: 20px; font-size: 14px; }
            th, td { border: 1px solid #ddd; padding: 12px; text-align: left; }
            th { background-color: #f8f9fa; font-weight: bold; }
            .header { text-align: center; margin-bottom: 30px; border-bottom: 2px solid #eee; padding-bottom: 20px; }
            .footer { margin-top: 50px; text-align: right; font-size: 12px; border-top: 1px solid #eee; padding-top: 20px; }
            .low-stock { color: red; font-weight: bold; }
            .date { text-align: center; color: #666; margin-top: -20px; margin-bottom: 20px; }
            @media print { 
                @page { margin: 0; }
                body { margin: 1.5cm; }
                button { display: none; } 
            }
            .print-btn { background: #0ea5e9; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; float: right; }
        </style>
    </head>
    <body>
        <button class="print-btn" onclick="window.print()">🖨️ พิมพ์รายงาน</button>
        <div class="header">
            <h2>${title}</h2>
        </div>
        ${filterText}
        ${dataHtml}
        <div class="footer">
            <p>ผู้ออกรายงาน: ${issuer} • วันที่ออกรายงาน: ${new Date().toLocaleDateString('th-TH')} ${new Date().toLocaleTimeString('th-TH')}</p>
        </div>
    </body>
    </html>
    `;
    printWindow.document.write(html);
    printWindow.document.close();
}

function updateUserProfileUI(user) {
    if (!user) return;
    const nameEl = document.querySelector('header .font-medium.text-gray-700');
    const roleEl = document.querySelector('header .text-xs.text-gray-500');
    const imgEl = document.querySelector('header img.rounded-full');
    if (nameEl) nameEl.textContent = user.name;
    if (roleEl) roleEl.textContent = user.role;
    if (imgEl) imgEl.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(user.name)}&background=0ea5e9&color=fff`;
}

function checkLogin() {
    if (sessionStorage.getItem('isLoggedIn') === 'true') {
        document.getElementById('loginScreen').style.display = 'none';
        document.getElementById('appLayout')?.classList.remove('hidden');
        const userId = sessionStorage.getItem('loggedInUserId');
        if (userId) {
            const u = db.users.find(x => x.id == userId);
            updateUserProfileUI(u);
        }
    } else {
        document.getElementById('loginScreen').style.display = 'flex';
        document.getElementById('appLayout')?.classList.add('hidden');
    }
}

window.toggleNotifications = function (e) {
    if (e) e.stopPropagation();
    const dropdown = document.getElementById('notifDropdown');
    dropdown.classList.toggle('hidden');
    // Hide red dot when clicked
    document.getElementById('notifBadge').classList.add('hidden');
}

window.toggleUserMenu = function (e) {
    if (e) e.stopPropagation();
    const dropdown = document.getElementById('userMenuDropdown');
    dropdown.classList.toggle('hidden');
}

// Global click to close dropdowns
document.addEventListener('click', () => {
    document.getElementById('notifDropdown')?.classList.add('hidden');
    document.getElementById('userMenuDropdown')?.classList.add('hidden');
});

function updateNotifications() {
    const today = new Date();
    const threeMonths = new Date();
    threeMonths.setMonth(today.getMonth() + 3);

    const expired = db.drugs.filter(d => d.expiryDate && new Date(d.expiryDate) < today);
    const nearExpiry = db.drugs.filter(d => d.expiryDate && new Date(d.expiryDate) >= today && new Date(d.expiryDate) <= threeMonths);
    const lowStock = db.drugs.filter(d => d.stock <= d.minLevel);

    const notifs = [];

    expired.forEach(d => {
        notifs.push({ type: 'danger', icon: 'alert-triangle', title: 'ยาหมดอายุ', desc: `${d.genericName} (${d.id}) หมดอายุแล้ว!` });
    });
    nearExpiry.forEach(d => {
        notifs.push({ type: 'warning', icon: 'clock', title: 'ยาใกล้หมดอายุ', desc: `${d.genericName} (${d.id}) จะหมดอายุในเร็วๆนี้` });
    });
    lowStock.forEach(d => {
        notifs.push({ type: 'info', icon: 'package-minus', title: 'ยาสต๊อกเหลือน้อย', desc: `${d.genericName} (${d.id}) ต่ำกว่าจุดสั่งซื้อ (เหลือ ${d.stock})` });
    });

    const notifCount = document.getElementById('notifCount');
    const notifBadge = document.getElementById('notifBadge');
    const notifList = document.getElementById('notifList');

    if (notifs.length > 0) {
        notifCount.textContent = notifs.length;
        notifBadge.classList.remove('hidden');
        notifList.innerHTML = notifs.map(n => `
            <div class="p-3 hover:bg-gray-50 flex gap-3 items-start">
                <div class="mt-0.5 ${n.type === 'danger' ? 'text-red-500' : n.type === 'warning' ? 'text-amber-500' : 'text-blue-500'}">
                    <i data-lucide="${n.icon}" class="w-4 h-4"></i>
                </div>
                <div>
                    <div class="text-xs font-bold text-gray-800">${n.title}</div>
                    <div class="text-[10px] text-gray-600 mt-0.5">${n.desc}</div>
                </div>
            </div>
        `).join('');
    } else {
        notifCount.textContent = '0';
        notifBadge.classList.add('hidden');
        notifList.innerHTML = '<div class="p-4 text-center text-xs text-gray-400">ไม่มีการแจ้งเตือนใหม่</div>';
    }

    if (window.lucide) window.lucide.createIcons();
}

window.livePatientSearch = function(value) {
    appState.patientSearch = value;
    const s = value.toLowerCase().trim();
    const rows = document.querySelectorAll('#patientTableBody tr');
    if (rows.length === 0) {
        // fallback: re-render if table not found
        navigateTo('patients');
        return;
    }
    rows.forEach(row => {
        const text = row.textContent.toLowerCase();
        if (!s || text.includes(s)) {
            row.style.display = '';
        } else {
            row.style.display = 'none';
        }
    });
}

window.showConfirmCustom = function(title, message, onConfirm) {
    const container = document.getElementById('modalContainer');
    container.innerHTML = `
        <div class="fixed inset-0 z-[200] flex items-center justify-center modal-overlay bg-black/60 backdrop-blur-sm" id="confirmOverlay">
            <div class="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden modal-content m-4 transform animate-in fade-in zoom-in duration-200 border border-gray-100">
                <div class="p-6 text-center">
                    <div class="w-16 h-16 bg-amber-50 text-amber-500 rounded-full flex items-center justify-center mx-auto mb-4">
                        <i data-lucide="help-circle" class="w-8 h-8"></i>
                    </div>
                    <h3 class="text-xl font-bold text-gray-800 mb-2">${title}</h3>
                    <p class="text-gray-500 text-sm mb-6">${message}</p>
                    <div class="flex gap-3 justify-center">
                        <button onclick="closeModal()" class="flex-1 px-4 py-2.5 text-sm font-medium text-gray-700 bg-gray-100 rounded-xl hover:bg-gray-200 transition-colors">ยกเลิก</button>
                        <button id="confirmBtnAction" class="flex-1 px-4 py-2.5 text-sm font-medium text-white bg-primary rounded-xl hover:bg-primary-dark transition-colors shadow-md shadow-primary/20">ยืนยัน</button>
                    </div>
                </div>
            </div>
        </div>
    `;
    if(window.lucide) window.lucide.createIcons();
    document.getElementById('confirmBtnAction').onclick = () => {
        document.getElementById('modalContainer').innerHTML = '';
        onConfirm();
    };
    document.getElementById('confirmOverlay').onclick = (e) => {
        if(e.target.id === 'confirmOverlay') document.getElementById('modalContainer').innerHTML = '';
    };
}

window.deleteUser = function(id) {
    const loggedInId = sessionStorage.getItem('loggedInUserId');
    if (String(id) === String(loggedInId)) {
        return alert('ไม่สามารถลบผู้ใช้งานที่คุณกำลังล็อกอินอยู่ได้');
    }
    
    const u = db.users.find(x => String(x.id) === String(id));
    if (!u) return alert('ไม่พบข้อมูลผู้ใช้งาน');

    window.showConfirmCustom('ยืนยันการลบผู้ใช้', `ต้องการลบผู้ใช้งาน "${u.name}" ใช่หรือไม่?`, () => {
        db.users = db.users.filter(x => String(x.id) !== String(id));
        saveDB();
        syncDataWithCloud();
        showToast('ลบข้อมูลผู้ใช้งานสำเร็จ');
        if (appState.currentRoute === 'settings') navigateTo('settings');
    });
};

window.manualSync = async function() {
    showToast('กำลังส่งข้อมูลไป Google Sheets...');
    await syncDataWithCloud();
};
