const STORAGE_KEY = 'phantom-image-lab-history';
const HISTORY_DB = 'phantom-image-lab-history-db';
const HISTORY_STORE = 'images';
const REF_DB = 'phantom-image-lab-refs-db';
const REF_STORE = 'refs';
const CANVAS_KEY = 'phantom-image-lab-canvas';
const TASKS_KEY = 'phantom-image-lab-tasks';
const CANVAS_DB = 'phantom-image-lab-db';
const CANVAS_STORE = 'canvas';
// 多画布：注册表存 localStorage，各画布的节点数据按 boardId 分 key 存 IndexedDB
const BOARDS_KEY = 'phantom-image-lab-boards';
const ACTIVE_BOARD_KEY = 'phantom-image-lab-active-board';
const MAX_BOARDS = 10;
let canvasPersistRevision = 0; // 已改用时间戳版本号，保留变量名避免外部引用断裂
// 新节点的默认参数：分辨率 2K、比例 3:4。固定写死，不继承上一个节点的设置——
// 否则在一个 4K/16:9 的节点旁边点「新增节点」，新节点会带着一堆意外的参数开场。
const DEFAULT_NEW_NODE_TIER = '2K';
const DEFAULT_NEW_NODE_RATIO = '3:4';
const state = {
	mode: 'text', tier: '2K', ratio: '3:4', count: 1, quality: 'high', files: [],
	tasks: [], history: loadHistory(), historyFilter: 'all',
	frameSeq: 0, framePrompts: new Map(), frameFiles: new Map(), activeFrameEl: null,
	// 每个节点独立的参数面板：frameId -> { mode, tier, count, quality }
	frameSettings: new Map(),
	// 输入框当前内容归属的节点 id（与 activeFrameEl 解耦，防止提示词写串到其他节点）
	dockOwner: null,
	// 节点图片容器：frameId -> { images: [{src, prompt}], current }
	// 一次生成出的所有图片属于同一个「版本」，共用输入框/参数/参考图；‹ › 只在版本内切图，不动输入框。
	frameStore: new Map(),
	// 每个框独立比例：frameId -> ratio
	frameRatio: new Map(),
	editingFrameId: null, dockMode: 'text',
	// 当前画布 id；切换画布时下面这组节点数据会被整体重置（见 switchBoard）
	activeBoardId: '',
};
// ==================== 多画布：注册表与存储键 ====================
// 画布注册表：只存元信息，节点数据在 IndexedDB 里按 boardId 分 key
function loadBoards() {
	try {
		const list = JSON.parse(localStorage.getItem(BOARDS_KEY) || '[]');
		return Array.isArray(list) ? list.filter(b => b && b.id) : [];
	} catch { return []; }
}
function saveBoards(list) {
	try { localStorage.setItem(BOARDS_KEY, JSON.stringify(list)); } catch (e) { console.warn('画布注册表写入失败：', e); }
}
// 默认命名：画布一、画布二……取第一个没被占用的序号
function nextBoardName(list) {
	const used = new Set(list.map(b => b.name));
	const cn = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
	for (let i = 0; i < MAX_BOARDS; i++) {
		const name = `画布${cn[i] || i + 1}`;
		if (!used.has(name)) return name;
	}
	return `画布${list.length + 1}`;
}
function createBoard(name) {
	const list = loadBoards();
	if (list.length >= MAX_BOARDS) return null;
	const board = { id: `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: name || nextBoardName(list), createdAt: Date.now() };
	list.push(board);
	saveBoards(list);
	return board;
}
function getBoard(id) { return loadBoards().find(b => b.id === id) || null; }
function boardName(id) { const b = getBoard(id); return b ? b.name : '画布'; }
// IndexedDB 键：所有画布相关数据都带 boardId，避免画布之间互相覆盖
function boardSnapshotKey(id) { return `board:${id}`; }
function boardImageKey(boardId, frameId) { return `imgs:${boardId}:${frameId}`; }
function boardCanvasMetaKey(id) { return `${CANVAS_KEY}:${id}`; }
// 旧版单画布数据（key 没有 boardId 前缀）——迁移时归入第一个画布
const LEGACY_SNAPSHOT_KEY = 'current';
function isLegacyImageKey(key) { return typeof key === 'string' && key.startsWith('imgs:') && key.split(':').length === 2; }
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
// 图片渲染缓存：frameStore / history 里存的是 base64（持久化格式不变），但直接把几十万字符的
// base64 塞进 <img> 会让 DOM 和字符串比较都背负巨大开销，节点一多就卡。这里转成 blob URL，
// 长度只有几十字符，图片数据交给浏览器内部管理。同一张图按内容键复用，避免重复解码。
const blobUrlCache = new Map();   // 内容键 -> blob URL
const blobKeyOfSrc = new Map();   // 原 src -> 内容键
function srcKey(src) {
	let key = blobKeyOfSrc.get(src);
	if (!key) { key = `${src.length}:${src.slice(-64)}`; blobKeyOfSrc.set(src, key); }
	return key;
}
function renderSrc(src) {
	if (!src || typeof src !== 'string' || !src.startsWith('data:')) return src;
	const key = srcKey(src);
	const cached = blobUrlCache.get(key);
	if (cached) return cached;
	const comma = src.indexOf(',');
	if (comma < 0) return src;
	const mime = src.slice(5, comma).split(';')[0] || 'image/png';
	let url;
	try {
		const bin = atob(src.slice(comma + 1));
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		url = URL.createObjectURL(new Blob([bytes], { type: mime }));
	} catch { return src; }
	blobUrlCache.set(key, url);
	return url;
}
// data URL -> Blob：手工 atob 比 fetch 快得多（18MB 下 55ms vs 346ms）
function dataUrlToBlob(src) {
	const comma = src.indexOf(',');
	if (comma < 0) return Promise.resolve(new Blob([]));
	const mime = src.slice(5, comma).split(';')[0] || 'image/png';
	const bin = atob(src.slice(comma + 1));
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return Promise.resolve(new Blob([bytes], { type: mime }));
}
// ---------- 缩略图：画布节点只渲染缩略图，原图仅在全屏/下载/复制时使用 ----------
// 直接把 2K/4K 原图挂到节点上，浏览器要解码几十 MB 位图，节点一多滚动就卡。
// 这里用 canvas 降采样出缩略图，同一张图只做一次，之后全部命中缓存。
const THUMB_MAX_EDGE = 512;         // 画布节点缩略图最长边：节点最大 320px，512 在 2x 屏上也够清晰，体积只有 1024 的 1/4
const THUMB_QUALITY = 0.72;         // WebP 质量：再低就开始爆浆，0.72 是体积与观感的平衡点
// 历史列表缩略图单独一档：格子只有 60~70px，用 512 的图纯属浪费——解码慢、占空间。
// 128px 在 2x 屏上仍然清晰，单张 WebP 只有几 KB，落盘后下次刷新直接秒出。
const HISTORY_THUMB_MAX_EDGE = 128;
const HISTORY_THUMB_QUALITY = 0.7;
const THUMB_STORE_PREFIX = 'thumb:';   // IndexedDB key：thumb:<尺寸>:<内容哈希>
const THUMB_PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const thumbUrlCache = new Map();    // 「尺寸|内容键」 -> 缩略图 blob URL
const thumbTasks = new Map();       // 「尺寸|内容键」 -> Promise，避免同一张图并发重复生成
// ---------- 缩略图 Worker ----------
// 缩略图要解码 2K/4K 原图（单张 ~140ms），放主线程做的话，队列里堆十几张就会
// 在开头一两秒持续挤掉帧、拖动发涩。Worker + OffscreenCanvas 把这段计算彻底挪出主线程，
// 主线程只负责收一个 ArrayBuffer 再转成 blob URL。
const THUMB_WORKER_SRC = `
self.onmessage = async (e) => {
  const { id, src, maxEdge, quality } = e.data;
  try {
    const comma = src.indexOf(',');
    const mime = src.slice(5, comma).split(';')[0] || 'image/png';
    const bin = atob(src.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: mime });
    let bmp = await createImageBitmap(blob, { resizeWidth: maxEdge, resizeQuality: 'medium' });
    if (bmp.height > maxEdge) { bmp.close(); bmp = await createImageBitmap(blob, { resizeHeight: maxEdge, resizeQuality: 'medium' }); }
    const cv = new OffscreenCanvas(bmp.width, bmp.height);
    cv.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close();
    const outBlob = await cv.convertToBlob({ type: 'image/webp', quality });
    const buf = await outBlob.arrayBuffer();
    self.postMessage({ id, ok: true, buf }, [buf]);
  } catch (err) { self.postMessage({ id, ok: false }); }
};
`;
let thumbWorker = null;
let thumbWorkerSeq = 0;
const thumbWorkerPending = new Map();
function getThumbWorker() {
	if (thumbWorker !== null) return thumbWorker;
	// 环境不支持时置 false，回退到主线程路径
	if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap !== 'function') {
		thumbWorker = false; return thumbWorker;
	}
	try {
		thumbWorker = new Worker(URL.createObjectURL(new Blob([THUMB_WORKER_SRC], { type: 'application/javascript' })));
		thumbWorker.onmessage = e => {
			const { id, ok, buf } = e.data;
			const resolve = thumbWorkerPending.get(id);
			if (!resolve) return;
			thumbWorkerPending.delete(id);
			// 回传 Blob 而不是 URL：历史缩略图要落盘，拿 Blob 才不用再从 URL 反读一次
			resolve(ok && buf ? new Blob([buf], { type: 'image/webp' }) : null);
		};
		thumbWorker.onerror = () => { thumbWorker = false; };
	} catch { thumbWorker = false; }
	return thumbWorker;
}
function buildThumbInWorker(src, maxEdge, quality) {
	const w = getThumbWorker();
	if (!w) return Promise.resolve(null);
	return new Promise(resolve => {
		const id = ++thumbWorkerSeq;
		thumbWorkerPending.set(id, resolve);
		w.postMessage({ id, src, maxEdge, quality });
	});
}
// 生成缩略图 Blob：优先走 Worker；不支持时回退主线程（atob 比 fetch(dataURL) 快 6 倍）
async function buildThumbBlob(src, maxEdge = THUMB_MAX_EDGE, quality = THUMB_QUALITY) {
	const viaWorker = await buildThumbInWorker(src, maxEdge, quality);
	if (viaWorker) return viaWorker;
	return buildThumbMain(src, maxEdge, quality);
}
async function buildThumb(src, maxEdge = THUMB_MAX_EDGE, quality = THUMB_QUALITY) {
	const blob = await buildThumbBlob(src, maxEdge, quality);
	return blob ? URL.createObjectURL(blob) : '';
}
async function buildThumbMain(src, maxEdge, quality) {
	if (typeof createImageBitmap === 'function') {
		try {
			let bitmap = await createImageBitmap(await dataUrlToBlob(src), { resizeWidth: maxEdge, resizeQuality: 'medium' });
			if (bitmap && bitmap.height > maxEdge) {
				// 竖图：按宽度缩完高度仍超标，改按高度缩（两个都传会拉伸变形）
				bitmap.close();
				bitmap = await createImageBitmap(await dataUrlToBlob(src), { resizeHeight: maxEdge, resizeQuality: 'medium' });
			}
			if (bitmap) {
				const cv = document.createElement('canvas');
				cv.width = bitmap.width; cv.height = bitmap.height;
				cv.getContext('2d').drawImage(bitmap, 0, 0);
				bitmap.close();
				const out = await new Promise(r => cv.toBlob(r, 'image/webp', quality));
				if (out) return out;
			}
		} catch { /* 回退 */ }
	}
	return buildThumbFallback(src, maxEdge, quality);
}
function buildThumbFallback(src, maxEdge, quality) {
	return new Promise(resolve => {
		const image = new Image();
		image.decoding = 'async';
		image.onload = () => {
			try {
				const sw = image.naturalWidth, sh = image.naturalHeight;
				if (!sw || !sh) { resolve(null); return; }
				const scale = Math.min(1, maxEdge / Math.max(sw, sh));
				const tw = Math.max(1, Math.round(sw * scale));
				const th = Math.max(1, Math.round(sh * scale));
				const cv = document.createElement('canvas');
				cv.width = tw; cv.height = th;
				const ctx = cv.getContext('2d');
				ctx.imageSmoothingEnabled = true;
				ctx.imageSmoothingQuality = 'medium';
				ctx.drawImage(image, 0, 0, tw, th);
				cv.toBlob(resolve, 'image/webp', quality);
			} catch { resolve(null); }
		};
		image.onerror = () => resolve(null);
		image.src = src;
	});
}
// 同步取缩略图：已就绪直接返回，未就绪返回 '' 并触发后台生成（Worker 里排队，不占主线程）
function thumbKey(src, maxEdge) { return `${maxEdge}|${srcKey(src)}`; }
function thumbUrl(src, maxEdge = THUMB_MAX_EDGE) {
	if (!src || typeof src !== 'string') return '';
	const key = thumbKey(src, maxEdge);
	const hit = thumbUrlCache.get(key);
	if (hit) return hit;
	if (!thumbTasks.has(key)) {
		const promise = buildThumb(src, maxEdge).then(url => {
			thumbTasks.delete(key);
			if (url) thumbUrlCache.set(key, url);
			return url;
		}).catch(() => { thumbTasks.delete(key); return ''; });
		thumbTasks.set(key, promise);
	}
	return '';
}
// 等缩略图就绪：已就绪立即 resolve，否则等后台生成完
function thumbUrlAsync(src, maxEdge = THUMB_MAX_EDGE) {
	const hit = thumbUrl(src, maxEdge);
	if (hit) return Promise.resolve(hit);
	if (!src || typeof src !== 'string') return Promise.resolve('');
	return thumbTasks.get(thumbKey(src, maxEdge)) || Promise.resolve('');
}
// 历史列表缩略图：三级取图，避免每次打开面板都重新解码原图（2K 图单张约 140ms，100 条就是十几秒）。
//   1) 内存缓存——本次会话已经生成过
//   2) IndexedDB 的 thumb:<尺寸>:<哈希>——上次落盘的小图，只有几 KB，直接秒出
//   3) 原图 img:<哈希> 现场降采样，生成后回写 IDB，下次就走第 2 级
const historyThumbTasks = new Map();   // 内容哈希 -> Promise<blobUrl>，避免并发重复生成
function historyThumbUrl(item) {
	const hash = item?.imageHash;
	if (!hash) return Promise.resolve('');
	const memKey = `${HISTORY_THUMB_MAX_EDGE}|${hash}`;
	const cached = thumbUrlCache.get(memKey);
	if (cached) return Promise.resolve(cached);
	const running = historyThumbTasks.get(hash);
	if (running) return running;
	const task = (async () => {
		const storeKey = `${THUMB_STORE_PREFIX}${HISTORY_THUMB_MAX_EDGE}:${hash}`;
		const stored = await idbGet(CANVAS_DB, CANVAS_STORE, storeKey);
		if (stored) return cacheHistoryThumb(memKey, stored);
		const src = item.image || await idbGet(CANVAS_DB, CANVAS_STORE, IMG_HASH_PREFIX + hash);
		if (!src) return '';
		const blob = await buildThumbBlob(src, HISTORY_THUMB_MAX_EDGE, HISTORY_THUMB_QUALITY);
		if (!blob) return '';
		// 落盘失败不影响本次显示，忽略即可
		idbPut(CANVAS_DB, CANVAS_STORE, storeKey, blob).catch(() => {});
		return cacheHistoryThumb(memKey, blob);
	})().finally(() => historyThumbTasks.delete(hash));
	historyThumbTasks.set(hash, task);
	return task;
}
function cacheHistoryThumb(memKey, blob) {
	const url = URL.createObjectURL(blob);
	thumbUrlCache.set(memKey, url);
	return url;
}
// 恢复画布时要等所有缩略图就绪才撤掉加载遮罩，否则会先看到空白/占位符再跳变。
// 这里把每次触发的缩略图任务收进一个集合，供 restoreCanvas 统一等待。
const pendingThumbWork = new Set();
function trackThumb(src) {
	const p = thumbUrlAsync(src);
	if (p) { pendingThumbWork.add(p); p.finally(() => pendingThumbWork.delete(p)); }
	return p;
}
function waitForThumbs() {
	// 任务可能在等待过程中又新增（比如异步补图），循环等到集合清空
	const drain = () => pendingThumbWork.size
		? Promise.all([...pendingThumbWork]).then(drain)
		: Promise.resolve();
	return drain();
}
const sizes = { '1K': { '1:1':'1024 × 1024','16:9':'1344 × 768','9:16':'768 × 1344','4:3':'1152 × 864','3:4':'864 × 1152','3:2':'1216 × 832','2:3':'832 × 1216','21:9':'1536 × 640' }, '2K': { '1:1':'2048 × 2048','16:9':'2304 × 1296','9:16':'1296 × 2304','4:3':'2048 × 1536','3:4':'1536 × 2048','3:2':'2304 × 1536','2:3':'1536 × 2304','21:9':'2688 × 1152' }, '4K': { '1:1':'4096 × 4096','16:9':'3840 × 2160','9:16':'2160 × 3840','4:3':'4096 × 3072','3:4':'3072 × 4096','3:2':'4096 × 2736','2:3':'2736 × 4096','21:9':'4096 × 1792' } };
const prices = { '1K': 0.08, '2K': 0.15, '4K': 0.20 };
// 分辨率按钮上的单价统一在这里渲染：服务端改价后跟着变，避免 HTML 硬编码的价格和实际扣费对不上
function renderTierPrices() {
	$$('#tierOptions button').forEach(button => {
		const label = button.querySelector('small');
		if (label) label.textContent = formatUsd(prices[button.dataset.value] || 0);
	});
}
// 价格改为服务端动态配置：定期拉取，用户端无需刷新即可看到最新单价
async function refreshPrices() {
	try {
		const resp = await fetch('/api/prices');
		if (resp.ok) {
			const data = await resp.json();
			if (data && typeof data === 'object') { Object.assign(prices, data); update(); }
		}
	} catch { /* 静默，保留旧价格 */ }
	renderTierPrices();
}

/* ---------- 底部公告滚动条 ---------- */
// 滚动交给 Web Animations API，而不是 rAF 逐帧写 transform。
// transform 动画会被提升到合成线程，主线程被图片解码 / IndexedDB / 缩略图生成占住时也不会掉帧。
// 原来的 rAF 写法每帧都得等主线程空闲，生成任务一忙公告就卡住不动（实测阻塞 300ms 位移为 0）。
let announcementAnim = null;
function setupAnnouncement(text) {
	const bar = $('#announcementBar'); const track = $('#announcementTrack');
	if (!bar || !track) return;
	if (announcementAnim) { announcementAnim.cancel(); announcementAnim = null; }
	if (text === undefined) text = '';
	if (!text.trim()) { bar.hidden = true; return; }
	bar.hidden = false;
	// 先用一份文本测量
	track.innerHTML = `<span class="announcement-item">${escapeHtml(text)}</span>`;
	track.style.transform = '';
	const boxW = bar.clientWidth;
	const textW = track.firstElementChild ? track.firstElementChild.offsetWidth : 0;
	if (textW <= boxW) {
		// 短文本：静态居中
		track.style.justifyContent = 'center';
		return;
	}
	// 长文本：两份相同文本 + 间隔，无缝横向循环滚动
	const gap = 48;
	track.style.justifyContent = '';
	track.innerHTML = `<span class="announcement-item">${escapeHtml(text)}</span><span class="announcement-item" style="padding-left:${gap}px">${escapeHtml(text)}</span>`;
	const period = textW + gap; // 滚过一个周期的距离
	const start = (boxW - textW) / 2; // 初始位置在中间
	const speed = 40; // px/s
	// 起点先写进 inline style，避免动画首帧之前闪一下 x=0
	track.style.transform = `translate3d(${start}px, 0, 0)`;
	// 线性地从 start 滚到 start-period；第二份文本正好接上第一份的位置，循环接缝看不出来
	announcementAnim = track.animate(
		[{ transform: `translate3d(${start}px, 0, 0)` }, { transform: `translate3d(${start - period}px, 0, 0)` }],
		{ duration: (period / speed) * 1000, iterations: Infinity, easing: 'linear' }
	);
}
async function loadAnnouncement() {
	try {
		const resp = await fetch('/api/announcement');
		const data = await resp.json().catch(() => ({}));
		setupAnnouncement((data && data.text) || '');
	} catch { setupAnnouncement(''); }
}
window.addEventListener('resize', () => { const t = $('#announcementTrack')?.textContent || ''; if (t) { const bar = $('#announcementBar'); if (bar && !bar.hidden) loadAnnouncement(); } });
function loadHistory() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; } }
function loadPersistedTasks() { try { return JSON.parse(localStorage.getItem(TASKS_KEY) || '[]'); } catch { return []; } }
function storageSize(value) { return new Blob([value || '']).size; }
function historyStorageSize() { return storageSize(localStorage.getItem(STORAGE_KEY) || ''); }
function formatBytes(bytes) { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(2)} MB`; }
function updateStorageLabel() {
	const label = $('#storageLabel');
	if (!label) return;
	let bytes = historyStorageSize();
	// 图片实际存于 IndexedDB，localStorage 只有元数据，需叠加图片缓存字节数
	historyImageStorageSize().then(imgBytes => { bytes += imgBytes; label.textContent = `历史缓存：${formatBytes(bytes)}`; }).catch(() => { label.textContent = `历史缓存：${formatBytes(bytes)}`; });
}
// 统计图片存储总字节数（img:<hash> 存在 CANVAS_DB，画布与历史共用）
function historyImageStorageSize() {
	if (!window.indexedDB) return Promise.resolve(0);
	return new Promise(resolve => {
		try {
			const request = indexedDB.open(CANVAS_DB, 1);
			request.onupgradeneeded = () => request.result.createObjectStore(CANVAS_STORE);
			request.onsuccess = () => {
				const db = request.result;
				const tx = db.transaction(CANVAS_STORE, 'readonly');
				const store = tx.objectStore(CANVAS_STORE);
				let total = 0;
				const cursorReq = store.openCursor();
				cursorReq.onsuccess = () => {
					const cursor = cursorReq.result;
					if (cursor) { if (String(cursor.key).startsWith(IMG_HASH_PREFIX)) total += storageSize(cursor.value); cursor.continue(); }
					else { db.close(); resolve(total); }
				};
				cursorReq.onerror = () => { db.close(); resolve(total); };
			};
			request.onerror = () => resolve(0);
		} catch (e) { resolve(0); }
	});
}
// 元数据里存图片哈希而不是图片本身：图片统一在 img:<hash> 里，画布和历史共用一份。
// 解构时连 _src（查看器临时打开的原图）一起排除，否则会把几 MB 的 base64 写进 localStorage 爆配额。
function historyMeta() {
	return state.history.slice(0, 100).map(({ image, _src, ...meta }) => ({ ...meta, imageHash: image ? imageHash(image) : (meta.imageHash || '') }));
}
function saveHistory() {
	// localStorage 只存元数据（每条几十字节）；base64 图片进 IndexedDB（配额大几百倍）
	try { localStorage.setItem(STORAGE_KEY, JSON.stringify(historyMeta())); } catch (e) { /* 元数据极小，忽略 */ }
	persistHistoryImages();
	renderHistory();
	updateStorageLabel();
}
// 历史图片与画布图片共用同一份存储（CANVAS_DB 的 img:<hash>），不再单独存一份
function persistHistoryImages() {
	if (!window.indexedDB) return;
	try {
		const request = indexedDB.open(CANVAS_DB, 1);
		request.onupgradeneeded = () => request.result.createObjectStore(CANVAS_STORE);
		request.onsuccess = () => {
			const db = request.result;
			const tx = db.transaction(CANVAS_STORE, 'readwrite');
			const store = tx.objectStore(CANVAS_STORE);
			state.history.slice(0, 100).forEach(item => {
				if (item.image) store.put(item.image, IMG_HASH_PREFIX + imageHash(item.image));
			});
			tx.oncomplete = () => db.close();
		};
	} catch (e) { /* 忽略 */ }
}
// 批量读取：一次事务拿多个 key，避免逐条开库
function idbGetMany(dbName, storeName, keys) {
	return new Promise(resolve => {
		if (!window.indexedDB || !keys.length) return resolve({});
		try {
			const req = indexedDB.open(dbName, 1);
			req.onupgradeneeded = () => req.result.createObjectStore(storeName);
			req.onsuccess = () => {
				const db = req.result;
				let tx;
				try { tx = db.transaction(storeName, 'readonly'); } catch (e) { db.close(); return resolve({}); }
				const store = tx.objectStore(storeName);
				const out = {}; let pending = keys.length;
				keys.forEach(k => {
					const g = store.get(k);
					g.onsuccess = () => { if (g.result != null) out[k] = g.result; if (--pending === 0) { db.close(); resolve(out); } };
					g.onerror = () => { if (--pending === 0) { db.close(); resolve(out); } };
				});
			};
			req.onerror = () => resolve({});
		} catch (e) { resolve({}); }
	});
}
// 启动时只做「旧格式迁移 + 补 imageHash」，不再把原图读进内存：
// 100 条 2K 历史就是几百 MB 字符串常驻，而列表格子只有几十像素，完全没必要。
// 原图由 historyThumbUrl（列表缩略图）和 openHistoryViewer（全屏）各自按需取。
async function hydrateHistoryImages() {
	if (!window.indexedDB) { renderHistory(); return; }
	// 早期版本把图片按历史条目 id 存在 HISTORY_DB，且元数据没有 imageHash。
	// 迁到新库 img:<哈希> 并补上哈希，之后统一走哈希索引。
	const legacyItems = state.history.filter(item => !item.imageHash);
	if (legacyItems.length) {
		const legacy = await idbGetMany(HISTORY_DB, HISTORY_STORE, legacyItems.map(i => i.id));
		const migrated = legacyItems.filter(item => legacy[item.id]);
		await Promise.all(migrated.map(item => {
			item.imageHash = imageHash(legacy[item.id]);
			return idbPut(CANVAS_DB, CANVAS_STORE, IMG_HASH_PREFIX + item.imageHash, legacy[item.id]);
		}));
		if (migrated.length) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(historyMeta())); } catch (e) { /* 忽略 */ } }
	}
	updateStorageLabel();
	renderHistory();
}
function persistTasks() {
	try {
		localStorage.setItem(TASKS_KEY, JSON.stringify(state.tasks
			.filter(task => task.status === 'queued' || task.status === 'running' || task.serverTaskId)
			.map(({ controller, files, ...task }) => ({ ...task, files: [] }))));
	} catch (error) { console.warn('任务缓存写入失败：', error); }
}
function restoreTasks() {
	const saved = loadPersistedTasks();
	state.tasks.push(...saved.filter(task => task.serverTaskId && (task.status === 'queued' || task.status === 'running')));
}
function restoreTaskFrames() {
	const frames = [...$('#canvasWorld')?.querySelectorAll('.canvas-frame.loading') || []];
	state.tasks.forEach(task => {
		const frame = frames.find(el => el.dataset.task === task.serverTaskId);
		if (frame) {
			task.frameTarget = frameId(frame);
			// 立刻按持久化的开始时间续上计时器，避免先显示 0.00s 再跳变
			if (task.startedAt) startFrameTimer(frame, task.startedAt);
		}
	});
}
function persistCanvasNow() {
	// 用时间戳做版本号：跨页面刷新单调递增，避免新会话 revision 从 0 计数导致快照写入被旧值拦截
	const revision = Date.now();
	// 捕获当前画布 id：下面有异步回调，期间用户可能切了画布，用局部变量锁定本次写入目标
	const boardId = state.activeBoardId;
	if (!boardId) return;
	const frames = [...($('#canvasWorld')?.querySelectorAll('.canvas-frame') || [])].map(el => {
		const id = frameId(el);
		const store = state.frameStore.get(id);
		const status = el.className.includes('loading') ? 'loading' : el.className.includes('done') ? 'done' : 'empty';
		const promptText = state.framePrompts.get(id) || ((store && store.images && store.images[store.current]) ? (store.images[store.current].prompt || '') : '') || '';
		return { id, left: el.style.left, top: el.style.top, ratio: getFrameRatio(el), store: status === 'done' ? (store || null) : null, taskId: el.dataset.task || '', status, elapsed: el.dataset.elapsed || '', prompt: promptText, settings: state.frameSettings.get(id) || null };
	});
	try { localStorage.setItem(boardCanvasMetaKey(boardId), JSON.stringify({ panX: canvas.panX, panY: canvas.panY, zoom: canvas.zoom, frames: frames.map(frame => ({ ...frame, store: null })) })); } catch (error) { console.warn('画布位置缓存写入失败：', error); }
	if (!window.indexedDB) return;
	const request = indexedDB.open(CANVAS_DB, 1);
	request.onupgradeneeded = () => request.result.createObjectStore(CANVAS_STORE);
	request.onsuccess = () => {
		const db = request.result;
		const tx = db.transaction(CANVAS_STORE, 'readwrite');
		const store = tx.objectStore(CANVAS_STORE);
		const current = store.get(boardSnapshotKey(boardId));
		current.onsuccess = () => {
			const prevRev = Number(current.result && current.result.revision) || 0;
			if (prevRev > revision) return;
			// 图片按内容哈希单独存：整份快照里塞满 base64 时，structured clone 要遍历上百 MB，
			// 拖拽时触发就是几百毫秒的卡顿。拆开后快照本身只有几十 KB。
			// 同一张图在画布和历史里只占一份（img:<hash>），不再翻倍。
			const metaFrames = frames.map(frame => {
				const st = frame.store;
				if (!st) return frame;
				const images = st.images.map(img => {
					const hash = imageHash(img.src);
					store.put(img.src, IMG_HASH_PREFIX + hash);
					return { hash, prompt: img.prompt || '' };
				});
				return { ...frame, store: { current: st.current, images, external: true } };
			});
			store.put({ revision, panX: canvas.panX, panY: canvas.panY, zoom: canvas.zoom, frames: metaFrames }, boardSnapshotKey(boardId));
		};
		tx.oncomplete = () => db.close();
	};
}
// 画布落盘要序列化所有节点的版本栈（含 base64，6 张 2K 图就要 100ms+），
// 拖拽/滚轮期间触发会直接卡住手指。所以：
// 1) 防抖：连续操作只在停下来 400ms 后写一次；
// 2) 拖拽期间完全跳过，松手后再统一落一次；
// 3) 页面隐藏/卸载时立刻补写，保证不丢数据。
let persistCanvasTimer = null;
let isDraggingFrame = false;
function persistCanvas() {
	if (isDraggingFrame) return;   // 拖拽中不落盘，避开长任务
	if (persistCanvasTimer) clearTimeout(persistCanvasTimer);
	persistCanvasTimer = setTimeout(() => { persistCanvasTimer = null; persistCanvasNow(); }, 400);
}
function flushCanvasPersist() {
	if (!persistCanvasTimer) return;
	clearTimeout(persistCanvasTimer); persistCanvasTimer = null;
	persistCanvasNow();
}
function clearCanvas() {
	const world = $('#canvasWorld');
	if (!world) return;
	// 取消所有进行中的生成任务并清空任务记录，避免刷新后被 restoreTasks 恢复再次填图
	state.tasks.forEach(t => { if (t.controller) t.controller.abort(); });
	state.tasks = [];
	localStorage.removeItem(TASKS_KEY);
	world.innerHTML = '';
	state.frameStore.clear();
	state.frameRatio.clear();
	state.framePrompts.clear();
	state.frameFiles.clear();
	state.frameSettings.clear();
	state.dockOwner = null;
	state.files = [];
	// 同步收起输入框并清空提示词/参考图，做到一键彻底清空（无需再刷新页面）
	state.activeFrameEl = null;
	state.editingFrameId = null;
	const ta = $('#prompt'); if (ta) ta.innerHTML = '';
	const dock = $('#promptDock'); if (dock) { dock.hidden = true; dock.classList.remove('anchored'); dock.style.left = ''; dock.style.top = ''; }
	const pop = $('#paramPopover'); if (pop) { pop.hidden = true; const tg = $('#paramTrigger'); tg?.setAttribute('aria-expanded', 'false'); }
	state.files = []; $('#referenceImages').value = ''; renderPreviews();
	// 清空画布后，新节点回到默认参数（2K / 3:4），并同步参数面板高亮
	state.ratio = DEFAULT_NEW_NODE_RATIO;
	state.tier = DEFAULT_NEW_NODE_TIER;
	$$('#ratioOptions button').forEach(b => b.classList.toggle('selected', b.dataset.value === state.ratio));
	$$('#tierOptions button').forEach(b => b.classList.toggle('selected', b.dataset.value === state.tier));
	appendEmptyFrame();
	centerWorld();
	// 清掉当前画布的持久化数据；图片按内容哈希共享，交给 GC 统一回收
	const boardId = state.activeBoardId;
	purgeBoardData(boardId).catch(() => { /* 忽略 */ });
	renderTasks();
	update();
}
// ==================== 多画布：切换 ====================
// 清空运行期状态（内存 Map + DOM + 选中态）。切画布前调用，避免旧画布的数据残留到新画布。
function resetBoardRuntimeState() {
	const world = $('#canvasWorld'); if (world) world.innerHTML = '';
	state.frameStore = new Map();
	state.frameSettings = new Map();
	state.framePrompts = new Map();
	state.frameRatio = new Map();
	state.frameFiles = new Map();
	state.activeFrameEl = null;
	state.dockOwner = null;
	state.editingFrameId = null;
	state.dockMode = 'text';
	state.files = [];
	state.ratio = DEFAULT_NEW_NODE_RATIO;
	state.tier = DEFAULT_NEW_NODE_TIER;
	canvas.panX = 0; canvas.panY = 0; canvas.zoom = 1;
	const ta = $('#prompt'); if (ta) ta.innerHTML = '';
	const dock = $('#promptDock'); if (dock) { dock.hidden = true; dock.classList.remove('anchored'); dock.style.left = ''; dock.style.top = ''; }
	const pop = $('#paramPopover'); if (pop) { pop.hidden = true; $('#paramTrigger')?.setAttribute('aria-expanded', 'false'); }
	$$('#ratioOptions button').forEach(b => b.classList.toggle('selected', b.dataset.value === state.ratio));
	$$('#tierOptions button').forEach(b => b.classList.toggle('selected', b.dataset.value === state.tier));
	renderPreviews();
}
// 切换画布：当前画布落盘 → 重置运行态 → 按目标画布 id 恢复
async function switchBoard(targetId) {
	if (!targetId || targetId === state.activeBoardId) return;
	if (!getBoard(targetId)) return;
	const loading = $('#canvasLoading');
	if (loading) loading.hidden = false;
	flushCanvasPersist();          // 当前画布立即落盘，别丢最后一步操作
	saveRefFiles();                // 参考图也按当前画布存
	state.activeBoardId = targetId;
	try { localStorage.setItem(ACTIVE_BOARD_KEY, targetId); } catch (e) { /* 忽略 */ }
	resetBoardRuntimeState();
	await restoreCanvas(targetId);
	await restoreRefFiles();
	// 目标画布是全新的（没有快照）：给一个默认空节点，否则画布一片空白没法操作
	if (!document.querySelector('#canvasWorld .canvas-frame')) appendEmptyFrame();
	applyWorldTransform();
	if (loading) loading.hidden = true;
	renderBoardSwitcher();
	renderTasks();
	update();
}
// ==================== 多画布：初始化与迁移 ====================
// 首次运行：建「画布一」并把旧的单画布数据搬进它的命名空间。
// 旧格式的 key 没有 boardId 前缀（快照 'current'、图片 'imgs:<frameId>'、参考图 'current'），
// 升级后统一加上 boardId，否则老用户刷新后画布会变空。
// 返回 Promise：迁移是异步的，restoreCanvas 必须等它完成，否则会读到还没搬走的旧数据。
async function ensureBoards() {
	const list = loadBoards();
	if (!list.length) {
		const board = { id: `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: '画布一', createdAt: Date.now() };
		saveBoards([board]);
		await migrateLegacyData(board.id);
		state.activeBoardId = board.id;
	} else {
		const active = localStorage.getItem(ACTIVE_BOARD_KEY) || '';
		state.activeBoardId = list.some(b => b.id === active) ? active : list[0].id;
		// 注册表已存在时也检查一次：迁移可能中途失败过，残留的旧 key 归到第一个画布
		await migrateLegacyData(state.activeBoardId);
	}
	try { localStorage.setItem(ACTIVE_BOARD_KEY, state.activeBoardId); } catch (e) { /* 忽略 */ }
	// 旧版历史条目没有 boardId：统一归到当前画布，否则删除画布时它们不会被清理，缓存统计也会漏算
	if (state.history.some(h => !h.boardId)) {
		state.history.forEach(h => { if (!h.boardId) h.boardId = state.activeBoardId; });
		saveHistory();
	}
	return loadBoards();
}
function migrateLegacyData(boardId) {
	// localStorage：旧的整体快照 → 该画布的快照 key
	try {
		const legacyMeta = localStorage.getItem(CANVAS_KEY);
		if (legacyMeta && !localStorage.getItem(boardCanvasMetaKey(boardId))) {
			localStorage.setItem(boardCanvasMetaKey(boardId), legacyMeta);
		}
		if (legacyMeta) localStorage.removeItem(CANVAS_KEY);
	} catch (e) { /* 忽略 */ }
	if (!window.indexedDB) return Promise.resolve();
	// IndexedDB：快照 'current' + 图片 'imgs:<frameId>' → 加 boardId 前缀
	const migrateCanvas = new Promise(resolve => {
		try {
			const request = indexedDB.open(CANVAS_DB, 1);
			request.onupgradeneeded = () => request.result.createObjectStore(CANVAS_STORE);
			request.onsuccess = () => {
				const db = request.result;
				const tx = db.transaction(CANVAS_STORE, 'readwrite');
				const store = tx.objectStore(CANVAS_STORE);
				const keysReq = store.getAllKeys();
				keysReq.onsuccess = () => {
					const keys = (keysReq.result || []).map(String);
					keys.forEach(key => {
						if (key === LEGACY_SNAPSHOT_KEY) {
							const g = store.get(key);
							g.onsuccess = () => { if (g.result) store.put(g.result, boardSnapshotKey(boardId)); store.delete(key); };
						} else if (isLegacyImageKey(key)) {
							const frameIdPart = key.slice('imgs:'.length);
							const g = store.get(key);
							g.onsuccess = () => { if (g.result) store.put(g.result, boardImageKey(boardId, frameIdPart)); store.delete(key); };
						}
					});
				};
				tx.oncomplete = () => { db.close(); resolve(); };
				tx.onerror = () => { db.close(); resolve(); };
			};
			request.onerror = () => resolve();
		} catch (e) { resolve(); }
	});
	// 参考图：'current' → board:<id>
	const migrateRefs = new Promise(resolve => {
		try {
			const request = indexedDB.open(REF_DB, 1);
			request.onupgradeneeded = () => request.result.createObjectStore(REF_STORE);
			request.onsuccess = () => {
				const db = request.result;
				const tx = db.transaction(REF_STORE, 'readwrite');
				const store = tx.objectStore(REF_STORE);
				const g = store.get('current');
				g.onsuccess = () => {
					if (g.result) store.put(g.result, boardSnapshotKey(boardId));
					store.delete('current');
				};
				tx.oncomplete = () => { db.close(); resolve(); };
				tx.onerror = () => { db.close(); resolve(); };
			};
			request.onerror = () => resolve();
		} catch (e) { resolve(); }
	});
	return Promise.all([migrateCanvas, migrateRefs]);
}
// ==================== 多画布：缓存统计 ====================
// 从画布快照里收集它引用到的图片哈希
function collectSnapshotHashes(snap) {
	const set = new Set();
	(snap?.frames || []).forEach(f => (f.store?.images || []).forEach(img => { if (img?.hash) set.add(img.hash); }));
	return set;
}
// 该画布占用的本地缓存：元数据 + 快照 + 引用到的图片（画布与历史按哈希去重）+ 参考图
async function boardStorageSize(boardId) {
	let total = storageSize(localStorage.getItem(boardCanvasMetaKey(boardId)) || '');
	const snap = await idbGet(CANVAS_DB, CANVAS_STORE, boardSnapshotKey(boardId));
	total += storageSize(JSON.stringify(snap || {}));
	// 画布节点图片 + 该画布历史条目引用的图片，同一张图只算一次
	const hashes = collectSnapshotHashes(snap);
	state.history.forEach(h => { if (h.boardId === boardId && h.imageHash) hashes.add(h.imageHash); });
	if (hashes.size) {
		const imgs = await idbGetMany(CANVAS_DB, CANVAS_STORE, [...hashes].map(h => IMG_HASH_PREFIX + h));
		Object.values(imgs).forEach(v => { total += storageSize(v); });
	}
	// 参考图存的是 File 对象，JSON 化后只剩 {}，得单独按 size 累加
	total += await new Promise(resolve => {
		if (!window.indexedDB) return resolve(0);
		try {
			const req = indexedDB.open(REF_DB, 1);
			req.onupgradeneeded = () => req.result.createObjectStore(REF_STORE);
			req.onsuccess = () => {
				const db = req.result;
				const store = db.transaction(REF_STORE, 'readonly').objectStore(REF_STORE);
				const g = store.get(boardSnapshotKey(boardId));
				g.onsuccess = () => {
					const value = g.result; let sum = 0;
					if (value && typeof value === 'object') {
						Object.values(value).forEach(files => { if (Array.isArray(files)) files.forEach(f => { if (f && typeof f.size === 'number') sum += f.size; }); });
					}
					db.close(); resolve(sum);
				};
				g.onerror = () => { db.close(); resolve(0); };
			};
			req.onerror = () => resolve(0);
		} catch (e) { resolve(0); }
	});
	return total;
}
// 图片垃圾回收（标记-清除）：图片按内容哈希共享，不能按画布/历史条目直接删，
// 否则会误删别处还在用的图。这里扫描所有画布快照 + 历史元数据收集引用，再删掉没人用的。
let gcRunning = false;
async function gcImages() {
	if (!window.indexedDB || gcRunning) return;
	gcRunning = true;
	try {
		const keep = new Set();
		state.history.forEach(h => {
			if (h.imageHash) keep.add(h.imageHash);
			if (h.image) keep.add(imageHash(h.image));
		});
		for (const b of loadBoards()) {
			const snap = await idbGet(CANVAS_DB, CANVAS_STORE, boardSnapshotKey(b.id));
			collectSnapshotHashes(snap).forEach(h => keep.add(h));
		}
		// 内存里可能还有刚生成、尚未落盘的图
		state.frameStore.forEach(store => (store.images || []).forEach(img => { if (img?.src) keep.add(imageHash(img.src)); }));
		await new Promise(resolve => {
			try {
				const req = indexedDB.open(CANVAS_DB, 1);
				req.onupgradeneeded = () => req.result.createObjectStore(CANVAS_STORE);
				req.onsuccess = () => {
					const db = req.result;
					let tx;
					try { tx = db.transaction(CANVAS_STORE, 'readwrite'); } catch (e) { db.close(); return resolve(); }
					const store = tx.objectStore(CANVAS_STORE);
					const keysReq = store.getAllKeys();
					keysReq.onsuccess = () => {
						(keysReq.result || []).map(String).forEach(k => {
							// img:<hash> 不在引用表里 → 回收；imgs:* 是上一版的按节点存法，图片已迁到 img:<hash>，一并清掉
							if (k.startsWith(IMG_HASH_PREFIX) && !keep.has(k.slice(IMG_HASH_PREFIX.length))) store.delete(k);
							else if (k.startsWith('imgs:')) store.delete(k);
						});
					};
					tx.oncomplete = () => { db.close(); resolve(); };
					tx.onerror = () => { db.close(); resolve(); };
				};
				req.onerror = () => resolve();
			} catch (e) { resolve(); }
		});
	} finally { gcRunning = false; }
}
// ==================== 多画布：增删改 ====================
function renderBoardSwitcher() {
	const nameEl = $('#boardName');
	if (nameEl) nameEl.textContent = boardName(state.activeBoardId);
	const menu = $('#boardMenu');
	if (!menu) return;
	const list = loadBoards();
	menu.innerHTML = list.map(b => `
		<div class="board-item${b.id === state.activeBoardId ? ' active' : ''}" data-board="${b.id}">
			<span class="bi-name">${escapeHtml(b.name)}</span>
			<span class="bi-size" data-size="${b.id}">…</span>
			<button class="bi-act" type="button" data-rename="${b.id}" title="重命名">✎</button>
			<button class="bi-act" type="button" data-clear="${b.id}" title="清空该画布（保留画布本身）">⌫</button>
			<button class="bi-act danger" type="button" data-del="${b.id}" title="删除该画布（连同缓存）">×</button>
		</div>`).join('') || '<div class="board-menu-empty">还没有画布</div>';
	// 缓存体积异步填，不阻塞菜单展开
	list.forEach(b => boardStorageSize(b.id).then(bytes => {
		const el = menu.querySelector(`[data-size="${b.id}"]`);
		if (el) el.textContent = formatBytes(bytes);
	}));
}
async function addBoard() {
	const list = loadBoards();
	if (list.length >= MAX_BOARDS) { showToast(`最多 ${MAX_BOARDS} 个画布，先删除一些吧`, 'warn'); return; }
	const board = createBoard();
	if (!board) { showToast('创建画布失败', 'err'); return; }
	await switchBoard(board.id);
	showToast(`已创建「${board.name}」`, 'ok');
}
async function renameBoard(id) {
	const board = getBoard(id); if (!board) return;
	const name = await openModal({ title: '重命名画布', input: true, value: board.name, confirmText: '保存' });
	if (name == null) return;
	const finalName = String(name).trim();
	if (!finalName) return;
	const list = loadBoards();
	const target = list.find(b => b.id === id);
	if (target) target.name = finalName.slice(0, 30);
	saveBoards(list);
	renderBoardSwitcher();
	showToast('已重命名', 'ok');
}
// 清空指定画布：只删节点，画布本身和它的历史图片保留
async function clearBoard(id) {
	const ok = await openModal({
		title: '清空画布',
		message: `确定清空「${boardName(id)}」的所有节点吗？画布本身会保留，历史记录不受影响。`,
		confirmText: '清空', danger: true,
	});
	if (!ok) return;
	if (id !== state.activeBoardId) {
		// 非当前画布：直接清掉它的持久化数据即可（内存里没有它）
		await purgeBoardData(id);
		renderBoardSwitcher();
		showToast('已清空', 'ok');
		return;
	}
	clearCanvas();   // 当前画布走原逻辑：清 DOM + 内存 + 持久化
	showToast('已清空', 'ok');
}
// 删除画布：节点 + 该画布的历史图片 + 全部缓存一起清，注册表里移除
async function deleteBoard(id) {
	const list = loadBoards();
	if (list.length <= 1) { showToast('至少要保留一个画布', 'warn'); return; }
	const size = await boardStorageSize(id);
	const ok = await openModal({
		title: '删除画布',
		message: `确定删除「${boardName(id)}」吗？该画布的节点、参考图和历史图片都会一并删除，可释放约 ${formatBytes(size)}，此操作不可撤销。`,
		confirmText: '删除', danger: true,
	});
	if (!ok) return;
	const wasActive = id === state.activeBoardId;
	// 该画布的历史条目一并删除（图片本身由 GC 统一回收，因为可能与别的画布共用）
	if (state.history.some(h => h.boardId === id)) {
		state.history = state.history.filter(h => h.boardId !== id);
		saveHistory();
	}
	await purgeBoardData(id);
	saveBoards(loadBoards().filter(b => b.id !== id));
	if (wasActive) {
		const next = loadBoards()[0];
		state.activeBoardId = '';   // 置空，让 switchBoard 认为需要切换
		await switchBoard(next.id);
	} else {
		renderBoardSwitcher();
	}
	// 切换后内存里已经不残留被删画布的节点数据了，这时再回收一次才能把它的图片清干净
	await gcImages();
	showToast(`已删除画布，释放 ${formatBytes(size)}`, 'ok');
}
// 清掉一个画布的持久化数据（快照 / 参考图），并回收没人引用的图片
async function purgeBoardData(boardId) {
	try { localStorage.removeItem(boardCanvasMetaKey(boardId)); } catch (e) { /* 忽略 */ }
	if (!window.indexedDB) return;
	const drop = (dbName, storeName, matcher) => new Promise(resolve => {
		try {
			const req = indexedDB.open(dbName, 1);
			req.onupgradeneeded = () => req.result.createObjectStore(storeName);
			req.onsuccess = () => {
				const db = req.result;
				let tx;
				try { tx = db.transaction(storeName, 'readwrite'); } catch (e) { db.close(); return resolve(); }
				const store = tx.objectStore(storeName);
				const keysReq = store.getAllKeys();
				keysReq.onsuccess = () => {
					(keysReq.result || []).map(String).filter(matcher).forEach(k => store.delete(k));
				};
				tx.oncomplete = () => { db.close(); resolve(); };
				tx.onerror = () => { db.close(); resolve(); };
			};
			req.onerror = () => resolve();
		} catch (e) { resolve(); }
	});
	await Promise.all([
		drop(CANVAS_DB, CANVAS_STORE, k => k === boardSnapshotKey(boardId)),
		drop(REF_DB, REF_STORE, k => k === boardSnapshotKey(boardId)),
	]);
	await gcImages();   // 图片按内容哈希共享，删完引用后统一回收没人用的
}
// ==================== 多画布：任务跨画布 ====================
// 通用 IndexedDB 读写：跨画布任务需要在用户已经切走的情况下把结果写进目标画布
function idbGet(dbName, storeName, key) {
	return new Promise(resolve => {
		if (!window.indexedDB) return resolve(null);
		try {
			const req = indexedDB.open(dbName, 1);
			req.onupgradeneeded = () => req.result.createObjectStore(storeName);
			req.onsuccess = () => {
				const db = req.result;
				let tx;
				try { tx = db.transaction(storeName, 'readonly'); } catch (e) { db.close(); return resolve(null); }
				const g = tx.objectStore(storeName).get(key);
				g.onsuccess = () => { const v = g.result; db.close(); resolve(v == null ? null : v); };
				g.onerror = () => { db.close(); resolve(null); };
			};
			req.onerror = () => resolve(null);
		} catch (e) { resolve(null); }
	});
}
function idbPut(dbName, storeName, key, value) {
	return new Promise(resolve => {
		if (!window.indexedDB) return resolve(false);
		try {
			const req = indexedDB.open(dbName, 1);
			req.onupgradeneeded = () => req.result.createObjectStore(storeName);
			req.onsuccess = () => {
				const db = req.result;
				let tx;
				try { tx = db.transaction(storeName, 'readwrite'); } catch (e) { db.close(); return resolve(false); }
				tx.objectStore(storeName).put(value, key);
				tx.oncomplete = () => { db.close(); resolve(true); };
				tx.onerror = () => { db.close(); resolve(false); };
			};
			req.onerror = () => resolve(false);
		} catch (e) { resolve(false); }
	});
}
// 任务完成时用户已经切到别的画布：把结果直接写进目标画布的持久化数据，不动 DOM。
// 切回去时 restoreCanvas 会把它读出来，图片不会丢。
async function saveResultToBoardStorage(task, data, imageCount) {
	const boardId = task.boardId;
	const frameKey = task.frameTarget || task.editTarget;
	if (!boardId || !frameKey) return;
	const snap = await idbGet(CANVAS_DB, CANVAS_STORE, boardSnapshotKey(boardId));
	if (!snap || !Array.isArray(snap.frames)) return;
	const frame = snap.frames.find(f => f.id === frameKey);
	if (!frame) return;   // 节点已被删除，丢弃结果
	// 先把图片搞成 base64：新格式要从服务端拉原图
	const entries = [];
	if (data.images && data.images.length) {
		data.images.forEach(image => entries.push(image.type === 'base64' ? `data:image/png;base64,${image.value}` : image.value));
	} else {
		for (let i = 0; i < imageCount; i++) {
			try {
				const resp = await fetch(`/api/tasks/${task.serverTaskId}/image/${i}`);
				if (!resp.ok) continue;
				entries.push(await blobToDataUrl(await resp.blob()));
			} catch (e) { /* 单张失败不影响其他 */ }
		}
	}
	if (!entries.length) return;
	// 一次任务的结果整批替换该节点的图片（与前台覆盖语义一致），图片按内容哈希只存一份
	const images = entries.map(src => {
		const hash = imageHash(src);
		idbPut(CANVAS_DB, CANVAS_STORE, IMG_HASH_PREFIX + hash, src);
		return { hash, prompt: task.prompt || '' };
	});
	frame.status = 'done';
	frame.store = { current: images.length - 1, images, external: true };
	frame.prompt = task.prompt || frame.prompt || '';
	frame.elapsed = task.elapsed || frame.elapsed || '';
	snap.revision = Date.now();
	await idbPut(CANVAS_DB, CANVAS_STORE, boardSnapshotKey(boardId), snap);
	// 历史是公共的：跨画布生成的结果同样进历史，归属到任务所在画布
	entries.forEach(src => {
		const historyKey = `${batchKey}#${src.slice(-24)}`;
		if (state.history.some(h => h.historyKey === historyKey)) return;
		state.history.unshift({ id: `${Date.now()}-${Math.random()}`, historyKey, boardId, prompt: task.prompt || '', model: task.model || '', tier: state.tier, createdAt: Date.now(), favorite: false, image: src });
	});
	saveHistory();
}
// ==================== 图片内容去重 ====================
// 同一张图以前会在「画布节点」和「历史记录」各存一份（imgs:<boardId>:<frameId> 与历史 id），
// 实际磁盘占用翻倍。现在统一按内容哈希存到 img:<hash>，两边都只引用哈希，磁盘上只留一份。
const IMG_HASH_PREFIX = 'img:';
function imageHash(src) {
	if (!src || typeof src !== 'string') return '';
	// 采样头尾各 240 字符 + 总长度：base64 全量遍历太慢，这个组合足以区分不同图片
	const sample = src.length > 480 ? src.slice(0, 240) + src.slice(-240) : src;
	let h = 2166136261;
	for (let i = 0; i < sample.length; i++) { h ^= sample.charCodeAt(i); h = Math.imul(h, 16777619); }
	return `${(h >>> 0).toString(36)}-${src.length.toString(36)}`;
}
// 从快照重建画布 DOM。boardId 用于定位该画布自己的图片 key。
function restoreCanvas(boardId = state.activeBoardId) {
	return new Promise(resolve => {
	const applySnapshot = raw => {
	try {
		const saved = Array.isArray(raw) ? { frames: raw } : raw;
		const world = $('#canvasWorld');
		if (!world) return;
		world.innerHTML = '';
		// 空画布也要能正常恢复（新建画布第一次进来就是空快照），所以不因 frames 为空提前 return
		if (!saved || !Array.isArray(saved.frames) || !saved.frames.length) { return; }
		canvas.panX = Number(saved.panX) || 0;
		canvas.panY = Number(saved.panY) || 0;
		canvas.zoom = Math.min(3, Math.max(.5, Number(saved.zoom) || 1));
		applyWorldTransform();
		saved.frames.forEach(item => {
			const el = document.createElement('div');
			el.className = `canvas-frame ${item.status || (item.store ? 'done' : 'empty')}`;
			el.dataset.frameId = item.id || '';
			// 恢复历史节点后同步自增序号，避免新增节点与恢复节点的 frameId 冲突（否则数据互相串写）
			const seq = parseInt(String(item.id || '').replace(/^\D+/, ''), 10);
			if (!isNaN(seq) && seq > state.frameSeq) state.frameSeq = seq;
			el.style.position = 'absolute';
			el.style.left = item.left || '0px';
			el.style.top = item.top || '0px';
			frameId(el);
			state.frameRatio.set(frameId(el), item.ratio || '1:1');
			if (item.settings) state.frameSettings.set(frameId(el), item.settings);
			// 旧格式（versions）直接丢弃，只认新结构 images
			if (item.store && Array.isArray(item.store.images)) state.frameStore.set(frameId(el), item.store);
			if (item.prompt) state.framePrompts.set(frameId(el), item.prompt);
			else if (item.store && item.store.images && item.store.images[item.store.current]) state.framePrompts.set(frameId(el), item.store.images[item.store.current].prompt || '');
			if (item.elapsed) el.dataset.elapsed = item.elapsed;
			setFrameSize(el, item.ratio || '1:1');
			if (item.status === 'loading') {
				el.dataset.task = item.taskId || '';
				el.innerHTML = `${FRAME_DEL_BTN}<span class="canvas-spinner"></span><span class="loading-orbit">✦</span><span class="frame-timer">0.00s</span><span class="placeholder-label loading-message">正在调用 ChatGPT Images 2.5 构建图片<span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span></span>`;
				bindFrameDel(el);
			} else if (state.frameStore.has(frameId(el))) renderDoneFrame(el); else setFrameHint(el);
			world.appendChild(el);
		});
		if (typeof restoreTaskFrames === 'function') restoreTaskFrames();
		// 兜底：快照里若残留服务端 URL（原图还没升级完就刷新了），恢复时重新拉一次原图。
		// 否则任务记录过了 TTL 被清理后，这个 URL 就永久 404，节点会变成空白。
		resumePendingUpgrades();
		// 恢复后把视图中心和节点位置都保留，不触发重新排版。
	} catch {
		console.warn('画布缓存恢复失败');
	} finally {
		// 等所有节点缩略图就绪再放行：遮罩由调用方在 resolve 后移除，
		// 提前 resolve 会让用户先看到占位符再跳变。
		waitForThumbs().then(resolve, resolve);
	}
};
	if (window.indexedDB) {
		const request = indexedDB.open(CANVAS_DB, 1);
		request.onupgradeneeded = () => request.result.createObjectStore(CANVAS_STORE);
		request.onsuccess = () => {
			const db = request.result;
			const store = db.transaction(CANVAS_STORE, 'readonly').objectStore(CANVAS_STORE);
			const get = store.get(boardSnapshotKey(boardId));
			get.onsuccess = () => {
				const snapshot = get.result || JSON.parse(localStorage.getItem(boardCanvasMetaKey(boardId)) || 'null');
				// 图片数据：新格式按内容哈希存在 img:<hash>；旧格式整块存在 imgs:<boardId>:<frameId>
				const external = (snapshot?.frames || []).filter(f => f.store && f.store.external);
				if (!external.length) { applySnapshot(snapshot); db.close(); return; }
				const jobs = external.map(frame => new Promise(res => {
					const st = frame.store;
					if (Array.isArray(st.images)) {
						const need = st.images.filter(it => it && it.hash && !it.src);
						if (!need.length) return res();
						let n = need.length;
						need.forEach(it => {
							const g = store.get(IMG_HASH_PREFIX + it.hash);
							g.onsuccess = () => { it.src = g.result || ''; if (--n === 0) res(); };
							g.onerror = () => { if (--n === 0) res(); };
						});
						return;
					}
					// 旧格式兼容：整个 store 存在 imgs:<boardId>:<frameId>
					const g = store.get(boardImageKey(boardId, frame.id));
					g.onsuccess = () => { frame.store = g.result || null; res(); };
					g.onerror = () => { frame.store = null; res(); };
				}));
				Promise.all(jobs).then(() => { applySnapshot(snapshot); db.close(); });
			};
			get.onerror = () => { db.close(); resolve(); };
		};
		request.onerror = () => resolve();
	} else applySnapshot(JSON.parse(localStorage.getItem(boardCanvasMetaKey(boardId)) || 'null'));
	});
}
function isFrameGenerating(frameIdVal) {
	return state.tasks.some(task => (task.status === 'running' || task.status === 'queued') && (task.frameTarget === frameIdVal || task.editTarget === frameIdVal));
}
function update() {
	const prompt = getPromptText().trim();
	const promptCount = $('#promptCount'); const generateButton = $('#generateButton'); const cost = $('#cost');
	const generateCount = $('#generateCount'); const sizeLabel = $('#sizeLabel'); const batchCount = $('#batchCount'); const canvasWorld = $('#canvasWorld');
	const activeId = state.activeFrameEl ? frameId(state.activeFrameEl) : null;
	const generatingActive = activeId ? isFrameGenerating(activeId) : false;
	if (promptCount) promptCount.textContent = `${getPromptText().length} / 4000`;
	// 已有图片的节点：生成按钮替换为「编辑图片」（新图必须走新增节点）
	const activeStore = activeId ? state.frameStore.get(activeId) : null;
	const activeHasImage = !!(activeStore && activeStore.images && activeStore.images.length);
	const editButton = $('#editButton');
	if (editButton) {
		editButton.hidden = !activeHasImage;
		editButton.disabled = generatingActive || !prompt;
	}
	if (generateButton) {
		generateButton.hidden = activeHasImage;
		// 图生图的可提交条件：手动参考图 或 节点当前图，任一存在即可（节点图不占手动名额）
		generateButton.disabled = generatingActive || !prompt || (state.mode === 'reference' && !refSubmitCount());
	}
	if (cost) cost.textContent = (prices[state.tier] * state.count).toFixed(2);
	if (generateCount) generateCount.textContent = `${state.count} 张`;
	if (sizeLabel) sizeLabel.textContent = state.ratio === 'auto' ? '自动' : (sizes[state.tier][state.ratio] || '');
	if (batchCount && canvasWorld) batchCount.textContent = canvasWorld.querySelectorAll('.canvas-frame.done').length;
	// 删除按钮只在两个及以上节点时出现，统一在这里同步（新增/删除/恢复画布都会走到 update）
	syncFrameDelVisibility();
	// 有参考图时禁用「文生图」：带着参考图却按文生图提交，语义上自相矛盾。
	// 统一在这里同步，所有修改 state.files 的入口都会自动生效。
	syncModeAvailability();
	const tbMode = $('#tbMode'); const tbParams = $('#tbParams');
	if (tbMode) tbMode.textContent = activeHasImage ? '编辑图片' : (state.dockMode === 'edit' ? '编辑图片' : (state.mode === 'reference' ? '图生图' : '文生图'));
	if (tbParams) {
		const qLabel = ({ auto: 'Auto', high: '高', medium: '中', low: '低' })[state.quality] || state.quality;
		if (activeHasImage) {
			// 编辑态：档位取与节点比例最接近的标准档，固定出 1 张，结果进版本栈
			const editRatio = nearestRatioKey(state.ratio);
			const res = sizes[state.tier][editRatio] || '';
			// 参考图 = 手动上传的 + 节点当前查看的那一张（不再统计节点其他版本）
			const manualCount = state.files.length;
			const nodeCount = hasNodeCurrentRef() ? 1 : 0;
			const refParts = [`手动 ${manualCount}`];
			if (nodeCount) refParts.push('节点当前图 1');
			const parts = [
				`比例 ${editRatio}`,
				`质量 ${qLabel}`,
				`分辨率 ${state.tier}`,
				`编辑 1 张`,
				`参考图 ${manualCount + nodeCount} 张（${refParts.join(' + ')}）`,
				`预估费用 $${prices[state.tier].toFixed(2)}`,
				`尺寸 ${res}`,
			];
			tbParams.textContent = parts.join(' · ');
		} else {
			const res = state.ratio === 'auto' ? '自动' : (sizes[state.tier][state.ratio] || '');
			const cost = (prices[state.tier] * state.count).toFixed(2);
			const parts = [
				`比例 ${state.ratio === 'auto' ? '自动' : state.ratio}`,
				`质量 ${qLabel}`,
				`分辨率 ${state.tier}`,
				`生成 ${state.count} 张`,
			];
			if (state.mode === 'reference') parts.push(`参考图 ${state.files.length} 张`);
			parts.push(`预估费用 $${cost}`);
			parts.push(`尺寸 ${res}`);
			tbParams.textContent = parts.join(' · ');
		}
	}
}
function escapeHtml(value) { return value.replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character])); }

/* ---------- 无限画布 ---------- */
function ratioValue(ratio) { const [w, h] = ratio.split(':').map(Number); return h ? w / h : 1; }
function frameId(el) { if (!el.dataset.frameId) { el.dataset.frameId = `f${++state.frameSeq}`; } return el.dataset.frameId; }
function frameSize(ratio) { const aspect = ratioValue(ratio); const w = 320; return { w, h: Math.round(w / aspect) }; }
function setFrameSize(el, ratio) {
	const { w, h } = frameSize(ratio);
	// 尺寸过渡只在这时开启：过渡期间会持续触发重排，平时挂着会拖慢拖拽
	el.classList.add('frame-resizing');
	el.style.width = `${w}px`; el.style.height = `${h}px`;
	clearTimeout(el._resizeTimer);
	el._resizeTimer = setTimeout(() => el.classList.remove('frame-resizing'), 600);
}
function setFrameHint(el) { const r = getFrameRatio(el); el.innerHTML = `${FRAME_DEL_BTN}<span class="frame-hint">当前画布比例 <b>${r === 'auto' ? '自动' : r}</b> · 选择比例即可变化</span>`; bindFrameDel(el); }
// 绑定节点删除按钮（每次重建 innerHTML 后都要重新绑）
function bindFrameDel(el) { const db = el.querySelector('.frame-del'); if (db) db.addEventListener('click', event => { event.stopPropagation(); removeFrame(el); }); }
// 每个框独立的比例（无则用全局 state.ratio 初始化）
function getFrameRatio(el) { const id = frameId(el); if (!state.frameRatio.has(id)) state.frameRatio.set(id, state.ratio); return state.frameRatio.get(id); }
function setFrameRatio(el, ratio) { state.frameRatio.set(frameId(el), ratio); setFrameSize(el, ratio); setFrameHint(el); }
// 删除按钮的 HTML 片段：所有状态的节点都带上（是否可见由 .has-multi 控制）
const FRAME_DEL_BTN = '<button class="frame-del" type="button" title="删除节点" aria-label="删除节点">×</button>';
// 只有一个节点时禁止删除：给画布世界挂 has-multi 类，CSS 据此决定是否放出删除按钮
function syncFrameDelVisibility() {
	const world = $('#canvasWorld');
	if (!world) return;
	world.classList.toggle('has-multi', world.querySelectorAll('.canvas-frame').length >= 2);
}
// 删除一个节点：清理它在各个 Map 里的数据，若是当前选中节点则同时收起输入框
function removeFrame(el) {
	if (!el || !el.isConnected) return;
	const id = frameId(el);
	const wasActive = state.activeFrameEl === el;
	state.frameStore.delete(id);
	state.frameRatio.delete(id);
	state.framePrompts.delete(id);
	state.frameFiles.delete(id);
	state.frameSettings.delete(id);
	// 生成中的节点被删除时取消它的任务，避免后台完成后又往已删除的节点里写图
	const task = state.tasks.find(t => t.frameTarget === id || t.editTarget === id);
	if (task && task.controller) { try { task.controller.abort(); } catch (e) { /* 忽略 */ } }
	el.remove();
	if (wasActive) closeDock();
	persistCanvas();
	update();
}
function appendEmptyFrame() {
	const world = $('#canvasWorld'); const el = document.createElement('div'); el.className = 'canvas-frame empty';
	const r = DEFAULT_NEW_NODE_RATIO;
	frameId(el); setFrameSize(el, r); setFrameHint(el); state.frameRatio.set(frameId(el), r);
	// 新空白节点参数：分辨率固定 2K，模式强制文生图，数量用默认，质量跟随全局
	state.frameSettings.set(frameId(el), { mode: 'text', tier: DEFAULT_NEW_NODE_TIER, count: 1, quality: state.quality });
	world.appendChild(el); return el;
}
// 计算新框应放的世界坐标（视口中心附近的空白处），避免与已有框重叠
function nextFrameWorldPos(existingRects) {
	const world = $('#canvasWorld'); const vp = $('#canvasViewport'); if (!world) return { left: 50, top: 50, offX: 0, offY: 0 };
	// 统一使用世界坐标（布局坐标，不受 CSS zoom/pan 影响），避免拿到未布局框的临时/零坐标导致重复放置
	const wr = world.getBoundingClientRect();
	const vr = vp.getBoundingClientRect();
	const size = frameSize(state.ratio); const gap = 2.2 * 16; const step = size.w + gap;
	const viewCx = vr.left + vr.width / 2, viewCy = vr.top + vr.height / 2;
	const centerLeft = viewCx - wr.left - size.w / 2;
	const centerTop = viewCy - wr.top - size.h / 2;
	// 只检查「中心点」是否被已有框占据，允许边角轻微遮挡
	const centerFree = (left, top) => {
		const px = left + size.w / 2, py = top + size.h / 2;
		return !existingRects.some(f => px >= f.left && px <= f.right && py >= f.top && py <= f.bottom);
	};
	const pick = (left, top) => ({ left, top, offX: left - centerLeft, offY: top - centerTop });
	if (centerFree(centerLeft, centerTop)) return pick(centerLeft, centerTop);
	// 环形向外搜索（可延伸到屏幕之外），找第一个中心点空位
	for (let ring = 1; ring < 400; ring++) {
		const cands = [
			[centerLeft + ring * step, centerTop], [centerLeft - ring * step, centerTop],
			[centerLeft, centerTop + ring * step], [centerLeft, centerTop - ring * step],
			[centerLeft + ring * step, centerTop + ring * step], [centerLeft - ring * step, centerTop + ring * step],
			[centerLeft + ring * step, centerTop - ring * step], [centerLeft - ring * step, centerTop - ring * step],
		];
		for (const [left, top] of cands) if (centerFree(left, top)) return pick(left, top);
	}
	return pick(centerLeft, centerTop);
}
// 「新增节点」：新建空白框 → 定位到视口中心附近空位（可延伸到屏幕外）→ 平滑平移画布把它带进视野 → 选中
function addNewNode() {
	const world = $('#canvasWorld'); const vp = $('#canvasViewport');
	if (!world) return null;
	// 用世界坐标（style.left/top + offset 尺寸）读取已有框，保证新增后立即可被下一次检测到，避免重复堆叠
	const existingRects = [...world.querySelectorAll('.canvas-frame')].map(f => {
		const w = f.offsetWidth || 320, h = f.offsetHeight || 320;
		const left = parseFloat(f.style.left) || 0, top = parseFloat(f.style.top) || 0;
		return { left, top, right: left + w, bottom: top + h };
	});
	const pos = nextFrameWorldPos(existingRects);
	const el = appendEmptyFrame();
	el.style.position = 'absolute'; el.style.flex = 'none'; el.style.margin = '0';
	el.style.left = `${pos.left}px`; el.style.top = `${pos.top}px`;
	// 入场动画只播一次：animation-fill-mode:both 会让它永久霸占 transform，
	// 之后拖拽写的 inline transform 会被动画的 to 帧覆盖（节点不动、松手才闪现）。
	el.classList.add('node-enter');
	el.addEventListener('animationend', () => el.classList.remove('node-enter'), { once: true });
	// 若新框中心超出视口可见范围（跑到屏幕外），才平滑平移画布把它带回视野中央
	const vr = vp.getBoundingClientRect();
	const beyondX = Math.abs(pos.offX) > vr.width / 2 - 20;
	const beyondY = Math.abs(pos.offY) > vr.height / 2 - 20;
	if (beyondX || beyondY) smoothPanWorld(-pos.offX, -pos.offY);
	const dock = $('#promptDock');
	if (dock) dock.classList.add('dock-smooth');
	selectFrame(el, vp);
	update();
	if (dock) setTimeout(() => dock.classList.remove('dock-smooth'), 560);
	persistCanvas();
	return el;
}
// 平滑平移画布（world），dx/dy 为要平移的量（布局像素）
function smoothPanWorld(dx, dy) {
	const world = $('#canvasWorld'); if (!world) return;
	const startX = canvas.panX, startY = canvas.panY, targetX = canvas.panX + dx, targetY = canvas.panY + dy;
	const dur = 480, t0 = performance.now();
	const ease = t => 1 - Math.pow(1 - t, 3);
	const step = now => {
		const p = Math.min(1, (now - t0) / dur), e = ease(p);
		canvas.panX = startX + (targetX - startX) * e;
		canvas.panY = startY + (targetY - startY) * e;
		applyWorldTransform();
		if (p < 1) requestAnimationFrame(step);
	};
	requestAnimationFrame(step);
}
// 走秒计时器。startedAt 用墙钟时间戳（Date.now）而不是 performance.now：
// 后者以页面加载为原点，刷新后会归零，导致计时器从 0 重新开始。
// 任务对象持久化了 startedAt，刷新恢复后能接着原来的进度继续走。
function startFrameTimer(el, startedAt) {
	const timer = el.querySelector('.frame-timer');
	if (!timer) return;
	// 幂等：恢复画布时可能已经起过一次，重复调用要先掐掉旧的，否则会有两条 rAF 循环互相打架
	stopFrameTimer(el);
	const msg = el.querySelector('.placeholder-label.loading-message');
	const dots = '<span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>';
	const pcTexts = ['正在调用 ChatGPT Images 2.5 构建图片', '请耐心等待哦，这可能需要一两分钟时间'];
	const tick = () => {
		if (!el.isConnected) return;
		const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);
		timer.textContent = `${elapsed}s`;
		if (!el.classList.contains('loading')) return;
		if (msg) msg.innerHTML = pcTexts[Math.floor(Number(elapsed) / 6) % 2] + dots;
		el._frameTimer = requestAnimationFrame(tick);
	};
	tick();
}
function stopFrameTimer(el) {
	if (el?._frameTimer) cancelAnimationFrame(el._frameTimer);
	delete el?._frameTimer;
}
// pinching：双指捏合进行中。捏合与单指平移/节点拖拽互斥，用它让另外两套手势让路。
const canvas = { dragging: false, startX: 0, startY: 0, originX: 0, originY: 0, panX: 0, panY: 0, zoom: 1, pinching: false };
// 直接写 transform，而不是改 CSS 自定义属性：改 --pan-x 会让浏览器重新解析 calc() 并重算样式，
// 实测比直接写 matrix/transform 慢一个量级。画布平移/缩放每秒要跑上百次，这个差异直接决定跟不跟手。
function applyWorldTransform() {
	const w = $('#canvasWorld'); if (!w) return;
	w.style.transform = `translate(calc(-50% + ${canvas.panX}px), calc(-50% + ${canvas.panY}px)) scale(${canvas.zoom})`;
}
// 滚轮/拖拽期间输入框跟随画布重定位：positionDock 要读写布局，一秒上百次事件会把它放大上百倍。
// 这里合并到一帧只算一次；另外拖动节点期间直接跳过（松手后统一定位一次），
// 否则每帧都要读 offset 再写 left/top，读-写交替触发布局抖动，拖动就发涩。
let dockRaf = 0;
function schedulePositionDock() {
	if (isDraggingFrame) return;   // 拖动节点时不跟随，松手时再定位
	if (dockRaf) return;
	dockRaf = requestAnimationFrame(() => {
		dockRaf = 0;
		if (isDraggingFrame) return;
		if (state.activeFrameEl && !$('#promptDock').hidden) positionDock(state.activeFrameEl);
	});
}
function centerWorld() { const w = $('#canvasWorld'); if (!w) return; canvas.panX = 0; canvas.panY = 0; applyWorldTransform(); }
// 选中某个框：把输入框 dock 吸附到该框正下方并显示，并加载该框专属的提示词
function selectFrame(frame, vp) {
	// 生成中的节点：可选中高亮和拖动，但不弹出输入框（输入内容保持不动）
	if (frame.classList.contains('loading')) {
		const wasActive = state.activeFrameEl === frame;
		if (!wasActive) {
			saveActiveFramePrompt();
			state.activeFrameEl = frame;
			// 生成中的节点不显示输入框：解除内容归属，防止之后选中其他节点时把残留提示词写进去
			state.dockOwner = null;
			state.files = [...getFrameFiles(frameId(frame))];
			syncSettingsToState(frameId(frame));
			renderPreviews();
			const dock = $('#promptDock');
			if (dock) { dock.hidden = true; dock.classList.remove('anchored'); dock.style.left = ''; dock.style.top = ''; }
		}
		$$('.canvas-frame').forEach(f => f.classList.remove('frame-selected'));
		frame.classList.add('frame-selected');
		update();
		return;
	}
	saveActiveFramePrompt();
	// 选中的不是编辑目标框时，退出编辑图片态
	if (state.editingFrameId && frameId(frame) !== state.editingFrameId) {
		state.editingFrameId = null; state.dockMode = 'text';
		const ph = $('#prompt'); if (ph) ph.placeholder = '可直接文字生图，或上传图片输入文字指令对图片进行编辑，如：将背景改为雪夜';
	}
	$$('.canvas-frame').forEach(f => f.classList.remove('frame-selected'));
	frame.classList.add('frame-selected');
	state.activeFrameEl = frame;
	// 参考图按节点独立：切换视图到该节点的参考图
	state.files = [...getFrameFiles(frameId(frame))];
	renderPreviews();
	// 同步该框各自的比例：state.ratio = 选中框的比例，并高亮对应按钮
	state.ratio = getFrameRatio(frame);
	$$('#ratioOptions button').forEach(b => b.classList.toggle('selected', b.dataset.value === state.ratio));
	// 参数面板按节点独立：载入该节点自己的 模式/档位/张数/质量
	syncSettingsToState(frameId(frame));
	applySettingsUI();
	const ta = $('#prompt'); if (ta) setPromptContent(state.framePrompts.get(frameId(frame)) || '');
	// 输入框内容归属当前节点，之后保存/写入都只针对它
	state.dockOwner = frameId(frame);
	update();
	const dock = $('#promptDock'); if (!dock) return;
	dock.hidden = false; dock.classList.add('anchored');
	// dock 刚从 hidden 变可见，尺寸缓存要重算一次
	invalidateDockMetrics();
	positionDock(frame);
}
function getShellZoom() {
	// 总缩放 = app-shell 自身 zoom × body 页面缩放（右下角控件），视口视觉坐标归一化用
	const shell = document.querySelector('.app-shell');
	const s = shell ? parseFloat(getComputedStyle(shell).zoom) : 1;
	const b = parseFloat(getComputedStyle(document.body).zoom) || 1;
	const z = (s && s > 0 ? s : 1) * b;
	return (z && z > 0) ? z : 1;
}
// dock / shell 的尺寸在一次拖拽过程中不会变，但读取 offsetWidth/offsetHeight 会强制同步布局。
// 原来 positionDock 每帧都读一遍再写 left/top，读-写交替造成布局抖动，拖动就发涩。
// 这里把尺寸缓存起来，只在需要时（内容变化、窗口尺寸变化）重新测量。
let dockMetrics = null;
function invalidateDockMetrics() { dockMetrics = null; }
function measureDockMetrics() {
	const dock = $('#promptDock'); const shell = document.querySelector('.app-shell');
	if (!dock || !shell) return null;
	const nav = document.querySelector('.topbar');
	dockMetrics = {
		dw: dock.offsetWidth || 640,
		dh: dock.offsetHeight || 160,
		shellW: shell.offsetWidth,
		shellH: shell.offsetHeight,
		navBottom: (nav ? nav.offsetHeight : 0) + 12,
	};
	return dockMetrics;
}
function getDockMetrics() { return dockMetrics || measureDockMetrics(); }
function positionDock(frame) {
	const dock = $('#promptDock'); if (!dock) return;
	const shell = document.querySelector('.app-shell');
	if (!shell || !frame.isConnected) return;
	const m = getDockMetrics(); if (!m) return;
	const { dw, dh, shellW, shellH, navBottom } = m;
	const fr = frame.getBoundingClientRect();
	const sr = shell.getBoundingClientRect();
	const shellZoom = getShellZoom();
	// 节点和面板都归一到 app-shell 的未缩放布局坐标，避免半屏时产生漂移。
	const frameLeft = (fr.left - sr.left) / shellZoom;
	const frameTop = (fr.top - sr.top) / shellZoom;
	const frameWidth = fr.width / shellZoom;
	const frameHeight = fr.height / shellZoom;
	const dx = Math.max(12, Math.min(frameLeft + frameWidth / 2 - dw / 2, shellW - dw - 12));
	const gap = 12;
	const belowTop = frameTop + frameHeight + gap;
	const aboveTop = frameTop - dh - gap;
	// 节点下方放不下时改放上方，避免面板盖住节点；两侧都不足时再限制在工作区内。
	const dy = belowTop + dh <= shellH - 12
		? belowTop
		: Math.max(navBottom, Math.min(aboveTop, shellH - dh - 12));
	dock.style.left = `${dx}px`; dock.style.top = `${dy}px`;
}
function saveActiveFramePrompt() { const ta = $('#prompt'); if (state.dockOwner && ta) state.framePrompts.set(state.dockOwner, getPromptText()); }
function closeDock() {   saveActiveFramePrompt(); state.activeFrameEl = null; state.dockOwner = null; state.editingFrameId = null; state.dockMode = 'text'; const ph = $('#prompt'); if (ph) ph.dataset.placeholder = '可直接文字生图，或上传图片输入文字指令对图片进行编辑，如：将背景改为雪夜'; const dock = $('#promptDock'); if (dock) { dock.hidden = true; dock.classList.remove('anchored'); dock.style.left = ''; dock.style.top = ''; } const pop = $('#paramPopover'); if (pop) { pop.hidden = true; const tg = $('#paramTrigger'); tg?.setAttribute('aria-expanded', 'false'); } $$('.canvas-frame').forEach(f => f.classList.remove('frame-selected')); }
// 结果框拖动：拖的是图片节点，拖到视口边缘时视野跟随（平移 --pan，同时移动节点本身）
function initFrameDrag(vp, world) {
	const EDGE = 40; const PAN_STEP = 8; const CLICK_THRESHOLD = 6;
	world.querySelectorAll('.canvas-frame.done').forEach(frame => frame.dataset.frameDrag = '');
	if (world.dataset.frameDragBound) return; world.dataset.frameDragBound = '1';
	let down = false; let startX = 0; let startY = 0; let moved = false; let activeFrame = null;
	// 拖拽中：pointermove/pointerup 一律挂在 window 上，不再依赖元素命中。
	// 原来用 frame.setPointerCapture + 元素监听，捕获失效时事件会落到别的节点上，
	// 拖到一半就跳去选中另一个元素。挂 window 后全程只认发起拖拽的那个节点。
	let dragMove = null, dragUp = null;
	const endDrag = () => {
		if (dragMove) window.removeEventListener('pointermove', dragMove);
		if (dragUp) { window.removeEventListener('pointerup', dragUp); window.removeEventListener('pointercancel', dragUp); }
		dragMove = null; dragUp = null;
	};
	window.addEventListener('blur', endDrag);
	world.addEventListener('pointerdown', event => {
		if (down) return;   // 已在拖拽中，忽略新的按下（多指/异常事件）
		if (canvas.pinching) return;   // 双指捏合进行中，不让节点跟着手指跑
		const frame = event.target.closest('.canvas-frame.done, .canvas-frame.empty, .canvas-frame.loading');
		if (!frame || event.target.closest('.result-actions, .version-nav, .fs-btn, .frame-del')) return;
		event.preventDefault();
		activeFrame = frame; down = true; moved = false; startX = event.clientX; startY = event.clientY;
		// 合成事件 / 异常指针 id 下会抛错，保护一下：捕获失败也不影响后面的拖拽逻辑（事件已挂 window）
		try { frame.setPointerCapture(event.pointerId); } catch (e) { /* 忽略 */ }
		// 拖拽一开始就把该节点提到最顶层：原来 z-index 只在松手时的 selectFrame 里加，
		// 导致拖动过程中被其他节点盖住，要拖一阵子才浮上来
		$$('.canvas-frame').forEach(f => f.classList.remove('frame-selected'));
		frame.classList.add('frame-selected');
		isDraggingFrame = true;
		const wRect = world.getBoundingClientRect();
		const vRect = vp.getBoundingClientRect();
		const zoom = canvas.zoom || 1;
		// 指针位移是视觉像素，而 frame.style.left/top 是 world 的布局坐标。
		// 移动端整页有 body zoom（0.33），漏掉它节点只跟手 1/3，拖起来又慢又涩；PC 端 shellZoom=1，行为不变。
		const shellZoom = getShellZoom();
		const pxPerVisual = 1 / (shellZoom * zoom);
		const startLeft = parseFloat(frame.style.left || frame.offsetLeft) || 0;
		const startTop = parseFloat(frame.style.top || frame.offsetTop) || 0;
		const startCX = event.clientX, startCY = event.clientY;
		frame.classList.add('frame-dragging');
		// 保险：入场动画若因异常未结束，会锁住 transform 导致拖拽不跟手，这里强制清掉
		frame.classList.remove('node-enter');
		// 拖拽期间用 transform 位移（合成层），不碰 left/top（每帧触发重排）；松手时再落回 left/top。
		// 必须带上 translateZ(0)：.canvas-frame.done 原本靠它建合成层，内联 transform 会整个覆盖掉，
		// 节点退回普通渲染层后每帧都要重新栅格化整张图，移动端尤其明显。
		let curLeft = startLeft, curTop = startTop;
		const move = e => {
			if (canvas.pinching) return;   // 第二根手指落下后转为捏合，节点保持原位
			const dist = Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY);
			if (dist > CLICK_THRESHOLD) moved = true;
			curLeft = startLeft + (e.clientX - startCX) * pxPerVisual;
			curTop = startTop + (e.clientY - startCY) * pxPerVisual;
			frame.style.transform = `translateZ(0) translate(${(curLeft - startLeft).toFixed(2)}px, ${(curTop - startTop).toFixed(2)}px)`;
			// 拖到视口边缘才平移视野：原来无论是否在边缘都写一次 world transform，白白多一次样式计算
			let panChanged = false;
			if (e.clientX < vRect.left + EDGE) { canvas.panX += PAN_STEP; panChanged = true; }
			else if (e.clientX > vRect.right - EDGE) { canvas.panX -= PAN_STEP; panChanged = true; }
			if (e.clientY < vRect.top + EDGE) { canvas.panY += PAN_STEP; panChanged = true; }
			else if (e.clientY > vRect.bottom - EDGE) { canvas.panY -= PAN_STEP; panChanged = true; }
			if (panChanged) applyWorldTransform();
		};
		const up = () => {
			endDrag();
			// 把 transform 位移换算回 left/top，避免与尺寸自适应、持久化逻辑打架
			frame.style.transform = '';
			frame.style.left = `${curLeft}px`; frame.style.top = `${curTop}px`;
			frame.style.position = 'absolute'; frame.style.flex = 'none'; frame.style.margin = '0';
			frame.classList.remove('frame-dragging');
			isDraggingFrame = false;   // 松手后才允许落盘，这里会序列化整个画布
			persistCanvas();
			selectFrame(frame, vp); // 拖动或轻触后都选中该框并吸附输入框（内部会定位一次）
			down = false; activeFrame = null;
		};
		dragMove = move; dragUp = up;
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
		window.addEventListener('pointercancel', up);
	});
	// 点击画布空白处关闭输入框
	vp.addEventListener('pointerdown', event => {
		if (!event.target.closest('.canvas-frame') && !event.target.closest('.prompt-dock')) { if (down) return; closeDock(); }
	}, { capture: false });
}
// 以指针位置为锚点缩放画布：保持指针下方的内容不动
// 以指针位置为锚点把画布缩放到指定值：保持指针下方的内容不动。
// 滚轮（增量）和双指捏合（绝对值）共用这段锚点换算。
function zoomAtPoint(vp, clientX, clientY, nextZoom) {
	const oldZoom = canvas.zoom;
	const target = Math.min(3, Math.max(0.5, nextZoom));
	if (target === oldZoom) return;
	const rect = vp.getBoundingClientRect();
	const shellZoom = getShellZoom();
	// 坐标系：clientX/clientY 是视觉坐标；而 getBoundingClientRect 在有 zoom 的祖先下
	// 返回的是布局坐标（实测 1200 而非 285），所以 rect 的宽高/left 直接就是布局值。
	// 因此只把 clientX 换算成布局坐标，不能再把 rect 除一次 shellZoom——
	// 否则 centerX 会被放大 1/shellZoom 倍（移动端 0.24 → 中心算成 2500），缩放时画面直接飞走。
	const pointerX = clientX / shellZoom - rect.left;
	const pointerY = clientY / shellZoom - rect.top;
	const centerX = rect.width / 2;
	const centerY = rect.height / 2;
	// transform 为 translate(...) scale(...)：以画布中心为原点补偿平移，保持指针下的内容不动。
	canvas.panX = pointerX - centerX - (pointerX - centerX - canvas.panX) * target / oldZoom;
	canvas.panY = pointerY - centerY - (pointerY - centerY - canvas.panY) * target / oldZoom;
	canvas.zoom = target;
	applyWorldTransform();
	schedulePositionDock();
}
function zoomAtPointer(vp, clientX, clientY, delta) {
	zoomAtPoint(vp, clientX, clientY, canvas.zoom + delta);
}
function initCanvas() {
	const vp = $('#canvasViewport'); const w = $('#canvasWorld'); if (!vp || !w) return;
	initFrameDrag(vp, w);
	initCanvasPan(vp);
	// 阻止 Ctrl/⌘ + 滚轮 缩放整个页面，确保页面固定不变（画布内部缩放走下方 wheel 逻辑）
	window.addEventListener('wheel', event => { if (event.ctrlKey || event.metaKey) event.preventDefault(); }, { passive: false });
	vp.addEventListener('wheel', event => {
		// 输入框 / 参数面板等 UI 上的滚轮：不做任何缩放（固定大小）
		if (event.target.closest('.prompt-dock, .param-popover')) return;
		event.preventDefault();
		// Shift + 滚轮：横向平移画布（保留，方便左右浏览）
		if (event.shiftKey) {
			canvas.panX -= event.deltaY;
			applyWorldTransform();
			persistCanvas();
			schedulePositionDock();
			return;
		}
		// 普通滚轮 / Ctrl+滚轮：缩放画布，以指针位置为锚点
		zoomAtPointer(vp, event.clientX, event.clientY, event.deltaY < 0 ? 0.1 : -0.1);
		persistCanvas();
	}, { passive: false });
}

// 左键在空白处拖动 → 整体平移画布（节点自身的拖动由 initFrameDrag 处理）
// 触摸屏：单指平移，双指捏合缩放画布内部（不是整页缩放）
function initCanvasPan(vp) {
	const PAN_CLICK_THRESHOLD = 4;
	let panning = false, startCX = 0, startCY = 0, basePanX = 0, basePanY = 0, moved = false;
	let panMove = null, panUp = null;
	const endPan = () => {
		if (panMove) window.removeEventListener('pointermove', panMove);
		if (panUp) { window.removeEventListener('pointerup', panUp); window.removeEventListener('pointercancel', panUp); }
		panMove = null; panUp = null;
	};
	window.addEventListener('blur', endPan);
	// ---------- 双指捏合 ----------
	// 触摸指针登记表：只有攒到 2 个才进入捏合，避免把单指平移误判成缩放。
	const touchPoints = new Map();   // pointerId -> { x, y }
	let pinching = false;
	let pinchStartDist = 0;          // 捏合开始时的两指间距
	let pinchStartZoom = 1;          // 捏合开始时的画布缩放值
	const twoPoints = () => [...touchPoints.values()];
	const pinchDistance = () => { const [a, b] = twoPoints(); return Math.hypot(a.x - b.x, a.y - b.y); };
	const pinchCenter = () => { const [a, b] = twoPoints(); return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; };
	const beginPinch = () => {
		if (pinching) return;
		// 单指平移已经开始时升级为捏合：先收尾平移，避免两套手势同时改 pan
		if (panning) { endPan(); vp.classList.remove('dragging'); panning = false; moved = false; }
		pinching = true;
		canvas.pinching = true;   // 让 initFrameDrag 让路，避免节点跟着第一根手指乱跑
		pinchStartDist = pinchDistance();
		pinchStartZoom = canvas.zoom;
	};
	const movePinch = () => {
		if (!pinching || touchPoints.size < 2 || !pinchStartDist) return;
		const dist = pinchDistance();
		if (dist <= 0) return;
		const center = pinchCenter();
		// 以「捏合开始时的缩放 × 间距变化比」为目标值，锚点取两指中点
		zoomAtPoint(vp, center.x, center.y, pinchStartZoom * (dist / pinchStartDist));
	};
	const endPinch = () => {
		if (!pinching) return;
		pinching = false;
		canvas.pinching = false;
		touchPoints.clear();
		persistCanvas();
	};
	window.addEventListener('pointermove', event => {
		if (!touchPoints.has(event.pointerId)) return;
		touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
		if (pinching) movePinch();
	});
	const releaseTouch = event => {
		if (!touchPoints.has(event.pointerId)) return;
		touchPoints.delete(event.pointerId);
		if (touchPoints.size < 2) endPinch();
	};
	window.addEventListener('pointerup', releaseTouch);
	window.addEventListener('pointercancel', releaseTouch);
	window.addEventListener('blur', () => endPinch());

	vp.addEventListener('pointerdown', event => {
		// 触摸指针先登记，用来识别双指捏合（不区分落在节点还是空白）
		if (event.pointerType === 'touch') {
			if (event.target.closest('.prompt-dock, .param-popover, #page-zoom-ctl')) return;
			touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
			if (touchPoints.size === 2) { beginPinch(); return; }
			if (touchPoints.size > 2) return;   // 三指及以上不处理
		}
		if (event.button !== 0) return;                                   // 只响应左键
		if (panning) return;
		// 节点、输入框、参数面板上的按下不归这里管
		if (event.target.closest('.canvas-frame, .prompt-dock, .param-popover, #page-zoom-ctl')) return;
		event.preventDefault();
		panning = true; moved = false;
		startCX = event.clientX; startCY = event.clientY;
		basePanX = canvas.panX; basePanY = canvas.panY;
		vp.classList.add('dragging');
		const move = e => {
			if (canvas.pinching) return;   // 捏合期间不让单指平移插手
			const dx = e.clientX - startCX, dy = e.clientY - startCY;
			if (!moved && Math.abs(dx) + Math.abs(dy) > PAN_CLICK_THRESHOLD) moved = true;
			canvas.panX = basePanX + dx;
			canvas.panY = basePanY + dy;
			applyWorldTransform();
			schedulePositionDock();
		};
		const up = () => {
			endPan();
			vp.classList.remove('dragging');
			if (moved) persistCanvas();
			panning = false;
		};
		panMove = move; panUp = up;
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
		window.addEventListener('pointercancel', up);
	});
}
// 重置画布位置：平移归零（回到中心），缩放保持不变，带一段平滑动画
function resetCanvasView() {
	const world = $('#canvasWorld'); if (!world) return;
	const startX = canvas.panX, startY = canvas.panY;
	const dur = 420, t0 = performance.now();
	const ease = t => 1 - Math.pow(1 - t, 3);
	const step = now => {
		const p = Math.min(1, (now - t0) / dur), e = ease(p);
		canvas.panX = startX * (1 - e);
		canvas.panY = startY * (1 - e);
		applyWorldTransform();
		if (p < 1) requestAnimationFrame(step);
		else { canvas.panX = 0; canvas.panY = 0; applyWorldTransform(); persistCanvas(); schedulePositionDock(); }
	};
	requestAnimationFrame(step);
}
// 整理排版：把画布上所有节点按网格排整齐
// 规则：优先在可见区域内排满；放不下时继续往右/往下延伸到画布外；
// 整体相对可见区域居中，保持统一间距。
function tidyCanvas() {
	const world = $('#canvasWorld'); const vp = $('#canvasViewport');
	if (!world || !vp) return;
	const frames = [...world.querySelectorAll('.canvas-frame')];
	if (!frames.length) { showToast('画布上还没有节点', 'warn'); return; }

	const GAP = 2.2 * 16;              // 与 .canvas-world 的 gap 保持一致
	// 可见区域换算成世界坐标（world 的布局坐标系，不含 pan/zoom）
	const vw = vp.clientWidth, vh = vp.clientHeight;
	const zoom = canvas.zoom || 1;
	const viewW = vw / zoom, viewH = vh / zoom;

	// 节点尺寸取实际布局尺寸，比例不同的节点也能排得下
	const sizes = frames.map(el => ({ el, w: el.offsetWidth || 320, h: el.offsetHeight || 320 }));
	const maxW = Math.max(...sizes.map(s => s.w));
	const maxH = Math.max(...sizes.map(s => s.h));
	const cellW = maxW + GAP, cellH = maxH + GAP;

	// 可见区域能放几列：至少 1 列，避免视口过窄时算成 0
	const cols = Math.max(1, Math.floor((viewW + GAP) / cellW));
	const rows = Math.ceil(sizes.length / cols);

	// 整块网格的宽高
	const blockW = cols * cellW - GAP;
	const blockH = rows * cellH - GAP;
	// 世界坐标原点在视口中心（.canvas-world 用 left/top 50% 定位），所以居中就是负半宽。
	// 垂直方向：整块比视口高时从可见区顶部开始排（而不是从中心向上延伸，
	// 否则前几行会跑到视口上方看不见）；比视口矮时垂直居中。
	const originX = -blockW / 2;
	const originY = blockH > viewH ? -viewH / 2 : -blockH / 2;

	sizes.forEach((s, i) => {
		const col = i % cols, row = Math.floor(i / cols);
		// 每个节点在格子内按自己的尺寸居中，不同比例的节点看起来更整齐
		const cellLeft = originX + col * cellW;
		const cellTop = originY + row * cellH;
		s.el.style.position = 'absolute';
		s.el.style.flex = 'none';
		s.el.style.margin = '0';
		s.el.style.left = `${Math.round(cellLeft + (maxW - s.w) / 2)}px`;
		s.el.style.top = `${Math.round(cellTop + (maxH - s.h) / 2)}px`;
	});

	// 排版后把视图拉回原点，让整块网格居中显示
	canvas.panX = 0; canvas.panY = 0;
	applyWorldTransform();
	persistCanvas();
	schedulePositionDock();
	showToast(`已整理 ${sizes.length} 个节点`, 'ok');
}

// 阻止输入框 / 参数面板上的 Ctrl/Cmd+滚轮触发浏览器页面缩放（输入框保持固定大小）
function initUIWheelLock() {
	const lock = el => { if (!el) return; el.addEventListener('wheel', e => { if (e.ctrlKey || e.metaKey) e.preventDefault(); }, { passive: false }); };
	lock($('#promptDock')); lock($('#paramPopover'));
	lock($('#qualityMenu'));
}

function openModal({ title = '', message = '', input = false, value = '', confirmText = '确定', cancelText = '取消', showCancel = true, danger = false } = {}) {
	return new Promise(resolve => {
		const root = $('#modalRoot'); const body = $('#modalBody'); const footer = $('#modalFooter');
		$('#modalTitle').textContent = title;
		body.innerHTML = '';
		if (message) { const p = document.createElement('p'); p.className = 'modal-message'; p.textContent = message; body.appendChild(p); }
		let inputEl = null;
		if (input) { inputEl = document.createElement('input'); inputEl.className = 'modal-input'; inputEl.type = 'text'; inputEl.value = value; inputEl.maxLength = 30; inputEl.placeholder = '请输入名称'; body.appendChild(inputEl); }
		footer.innerHTML = '';
		const close = (result) => { root.hidden = true; root.classList.remove('open'); document.removeEventListener('keydown', onKey); resolve(result); };
		if (showCancel) { const cancel = document.createElement('button'); cancel.className = 'modal-button ghost'; cancel.type = 'button'; cancel.textContent = cancelText; cancel.addEventListener('click', () => close(input ? null : false)); footer.appendChild(cancel); }
		const ok = document.createElement('button'); ok.className = 'modal-button ' + (danger ? 'danger' : 'primary'); ok.type = 'button'; ok.textContent = confirmText; ok.addEventListener('click', () => close(input ? (inputEl.value.trim() || value.trim() || inputEl.value) : true)); footer.appendChild(ok);
		$('#modalClose').onclick = () => close(input ? null : false);
		$('#modalBackdrop').onclick = () => close(input ? null : false);
		function onKey(e) { if (e.key === 'Escape') close(input ? null : false); }
		document.addEventListener('keydown', onKey);
		root.hidden = false; requestAnimationFrame(() => root.classList.add('open'));
		if (inputEl) { inputEl.focus(); inputEl.select(); }
	});
}
function initQualityOptions() {
	const options = $('#qualityOptions'); if (!options) return;
	$$('#qualityOptions button').forEach(button => button.addEventListener('click', () => {
		state.quality = button.dataset.quality;
		$$('#qualityOptions button').forEach(item => item.classList.toggle('selected', item === button));
		persistActiveSettings({ quality: state.quality });
		update();
	}));
}
function placeParamPopover() {
	const trigger = $('#paramTrigger'); const pop = $('#paramPopover'); if (!trigger || !pop) return;
	// 移动端整页等比缩放时，getBoundingClientRect 返回的是「缩放后的视觉坐标」，
	// 而 style.left/top 写的是「布局坐标」，两者差一个缩放系数。不换算的话，
	// 弹框会按视觉坐标被再缩一次，位置整体偏向左上。PC 端（zoom 由用户手动设）保持原逻辑不变。
	const z = isMobileViewport() ? getShellZoom() : 1;
	const tr = trigger.getBoundingClientRect();
	// offsetWidth/Height 本身就是布局值，不受 zoom 影响，比 getBoundingClientRect 更适合这里
	const pw = pop.offsetWidth || 640; const ph = pop.offsetHeight || 500;
	const viewportW = (document.documentElement.clientWidth || window.innerWidth) / z;
	const viewportH = (document.documentElement.clientHeight || window.innerHeight) / z;
	const tLeft = tr.left / z, tTop = tr.top / z, tWidth = tr.width / z, tBottom = tr.bottom / z;
	let left = Math.max(12, Math.min(tLeft + tWidth / 2 - pw / 2, viewportW - pw - 12));
	let top = tTop - ph - 10;
	if (top < 12) top = Math.min(tBottom + 10, viewportH - ph - 12);
	pop.style.left = `${left}px`; pop.style.top = `${top}px`;
}
function toggleParamPopover(show) {
	const trigger = $('#paramTrigger'); const pop = $('#paramPopover'); if (!trigger || !pop) return;
	pop.hidden = show === false ? true : !pop.hidden;
	trigger.setAttribute('aria-expanded', String(!pop.hidden));
	if (!pop.hidden) placeParamPopover();
}
function initParamPopover() {
	const trigger = $('#paramTrigger'); const pop = $('#paramPopover'); if (!trigger || !pop) return;
	trigger.addEventListener('click', event => { event.stopPropagation(); toggleParamPopover(); });
	document.addEventListener('click', event => { if (!trigger.contains(event.target) && !pop.contains(event.target)) pop.hidden = true, trigger.setAttribute('aria-expanded', 'false'); });
	window.addEventListener('resize', () => { if (!pop.hidden) placeParamPopover(); });
}
// 参考图按节点独立：frameId → File[]；state.files 只是「当前选中节点」的视图
function getFrameFiles(id) { if (!state.frameFiles.has(id)) state.frameFiles.set(id, []); return state.frameFiles.get(id); }
function setFrameFiles(id, files) { state.frameFiles.set(id, (files || []).slice(0, 8)); }
function syncActiveFrameFiles() { if (state.activeFrameEl) setFrameFiles(frameId(state.activeFrameEl), state.files); }
// 参数面板按节点独立：frameId -> { mode, tier, count, quality }，选中节点时载入、改参数时写回
function getFrameSettings(id) {
	if (!state.frameSettings.has(id)) state.frameSettings.set(id, { mode: state.mode, tier: state.tier, count: state.count, quality: state.quality });
	return state.frameSettings.get(id);
}
function persistActiveSettings(patch) {
	if (!state.activeFrameEl) return;
	Object.assign(getFrameSettings(frameId(state.activeFrameEl)), patch);
	persistCanvas();
}
function syncSettingsToState(id) {
	const s = getFrameSettings(id);
	state.mode = s.mode; state.tier = s.tier; state.count = s.count; state.quality = s.quality;
}
// 有参考图时「文生图」不可选：同步按钮的禁用态。
// 注意不能用 disabled 属性——disabled 的按钮不会派发 click 事件，用户点了没有任何反馈。
// 这里只做视觉置灰（mode-disabled），点击拦截交给 click 处理器弹提示说明原因。
// 若当前正处于文生图而用户又加了参考图，自动切到图生图（否则状态自相矛盾）。
function syncModeAvailability() {
	const hasRefs = state.files.length > 0;
	const textBtn = $('.mode[data-mode="text"]');
	const refBtn = $('.mode[data-mode="reference"]');
	if (textBtn) {
		textBtn.classList.toggle('mode-disabled', hasRefs);
		textBtn.setAttribute('aria-disabled', hasRefs ? 'true' : 'false');
		textBtn.title = hasRefs ? '已添加参考图，无法使用文生图；删除全部参考图后可切换' : '';
	}
	if (hasRefs && state.mode === 'text') {
		state.mode = 'reference';
		persistActiveSettings({ mode: 'reference' });
		$('#referenceBox')?.classList.add('open');
	}
	if (textBtn) textBtn.classList.toggle('active', state.mode === 'text');
	if (refBtn) refBtn.classList.toggle('active', state.mode === 'reference');
}
function applySettingsUI() {
	$$('.mode').forEach(item => item.classList.toggle('active', item.dataset.mode === state.mode));
	$('#referenceBox')?.classList.toggle('open', state.mode === 'reference');
	$$('#tierOptions button').forEach(item => item.classList.toggle('selected', item.dataset.value === state.tier));
	$$('.quick-counts button').forEach(item => item.classList.toggle('selected', Number(item.dataset.count) === state.count));
	$$('#qualityOptions button').forEach(item => item.classList.toggle('selected', item.dataset.quality === state.quality));
}
// 参考图本地缓存：按节点存 IndexedDB（File 对象结构化克隆支持），刷新后与输入框 @ 一一对应。
// 多画布：按画布分 key，否则两个画布里的 f1 会指向同一份参考图。
function saveRefFiles() {
	if (!window.indexedDB) return;
	const boardId = state.activeBoardId;
	if (!boardId) return;
	try {
		const request = indexedDB.open(REF_DB, 1);
		request.onupgradeneeded = () => request.result.createObjectStore(REF_STORE);
		request.onsuccess = () => {
			const db = request.result;
			const tx = db.transaction(REF_STORE, 'readwrite');
			const data = {};
			state.frameFiles.forEach((files, id) => { data[id] = files.slice(0, 8); });
			tx.objectStore(REF_STORE).put(data, boardSnapshotKey(boardId));
			tx.oncomplete = () => db.close();
		};
	} catch (e) { /* 忽略 */ }
}
function restoreRefFiles() {
	if (!window.indexedDB) return Promise.resolve();
	const boardId = state.activeBoardId;
	if (!boardId) return Promise.resolve();
	return new Promise(resolve => {
		try {
			const request = indexedDB.open(REF_DB, 1);
			request.onupgradeneeded = () => request.result.createObjectStore(REF_STORE);
			request.onsuccess = () => {
				const db = request.result;
				const tx = db.transaction(REF_STORE, 'readonly');
				const get = tx.objectStore(REF_STORE).get(boardSnapshotKey(boardId));
				get.onsuccess = () => {
					const v = get.result;
					if (v && typeof v === 'object') {
						state.frameFiles = new Map(Object.entries(v).map(([id, files]) => [id, Array.isArray(files) ? files.slice(0, 8) : []]));
						if (state.activeFrameEl) state.files = [...getFrameFiles(frameId(state.activeFrameEl))];
					}
					db.close(); resolve();
				};
				get.onerror = () => { db.close(); resolve(); };
			};
			request.onerror = () => resolve();
		} catch (e) { resolve(); }
	});
}
const refSeqMap = new WeakMap();
let refSeqCursor = 0;
function refSeq(f) { let s = refSeqMap.get(f); if (s == null) { s = ++refSeqCursor; refSeqMap.set(f, s); } return s; }
function appendRefChip(seq) { const editor = $('#prompt'); if (!editor) return; editor.insertAdjacentHTML('beforeend', makeChip('@参考图' + seq)); editor.dispatchEvent(new Event('input', { bubbles: true })); }
function renderPreviews() {
	// 参考图缩略图会改变 dock 高度，尺寸缓存失效
	invalidateDockMetrics();
	$('#refCount').textContent = `${state.files.length} / 8`;
	$('#previewList').innerHTML = state.files.map((file, index) => `<div class="preview-item" data-file-index="${index}"><img src="${URL.createObjectURL(file)}" alt="参考图 ${refSeq(file)}" draggable="false"><button type="button" data-remove-file="${index}" aria-label="移除参考图">×</button><span class="preview-label">参考图 ${refSeq(file)}</span></div>`).join('');
	$$('.preview-item').forEach(item => {
		// 点击缩略图：追加对应 @ 标记到输入框
		item.addEventListener('click', event => { if (item._supClick) { item._supClick = false; return; } if (event.target.closest('button')) return; appendRefToken(refSeq(state.files[Number(item.dataset.fileIndex)])); });
		// Pointer 拖拽排序（避开 HTML5 drag 会话，避免挂起）
		let pd = null;
		item.addEventListener('pointerdown', e => { if (e.target.closest('button')) return; e.preventDefault(); try { item.setPointerCapture(e.pointerId); } catch (err) {} pd = { from: +item.dataset.fileIndex, x: e.clientX, y: e.clientY, moved: false }; });
		item.addEventListener('pointermove', e => { if (!pd) return; const dx = e.clientX - pd.x, dy = e.clientY - pd.y; if (Math.abs(dx) > 6 || Math.abs(dy) > 6) pd.moved = true; });
		item.addEventListener('pointerup', e => { if (!pd) return; if (pd.moved) { item._supClick = true; const t = document.elementFromPoint(e.clientX, e.clientY); const ti = t ? t.closest('.preview-item') : null; const to = ti ? +ti.dataset.fileIndex : pd.from; if (to !== pd.from) { [state.files[pd.from], state.files[to]] = [state.files[to], state.files[pd.from]]; requestAnimationFrame(renderPreviews); } } pd = null; });
		item.addEventListener('pointercancel', () => { pd = null; });
	});
	$$('[data-remove-file]').forEach(button => button.addEventListener('click', event => { event.stopPropagation(); const idx = Number(button.dataset.removeFile); state.files.splice(idx, 1); removeRefMention(idx); renderPreviews(); update(); }));
	// dock 吸附预览：同一份 state.files，交互与参数面板完全一致
	const dockList = $('#dockPreviewList');
	if (dockList) {
		dockList.hidden = state.files.length === 0;
		dockList.innerHTML = state.files.map((file, index) => `<div class="dock-preview-item" data-dock-index="${index}"><img src="${URL.createObjectURL(file)}" alt="参考图 ${refSeq(file)}"><button type="button" data-dock-remove="${index}" aria-label="移除参考图">×</button><span class="dock-preview-label">参考图 ${refSeq(file)}</span></div>`).join('');
		$$('.dock-preview-item').forEach(item => {
			// 点击缩略图：追加对应 @ 标记到输入框
			item.addEventListener('click', event => { if (item._supClick) { item._supClick = false; return; } if (event.target.closest('button')) return; appendRefToken(refSeq(state.files[Number(item.dataset.dockIndex)])); });
			// Pointer 拖拽排序（避开 HTML5 drag）
			let pd = null;
			item.addEventListener('pointerdown', e => { if (e.target.closest('button')) return; e.preventDefault(); try { item.setPointerCapture(e.pointerId); } catch (err) {} pd = { from: +item.dataset.dockIndex, x: e.clientX, y: e.clientY, moved: false }; });
			item.addEventListener('pointermove', e => { if (!pd) return; const dx = e.clientX - pd.x, dy = e.clientY - pd.y; if (Math.abs(dx) > 6 || Math.abs(dy) > 6) pd.moved = true; });
			item.addEventListener('pointerup', e => { if (!pd) return; if (pd.moved) { item._supClick = true; const t = document.elementFromPoint(e.clientX, e.clientY); const ti = t ? t.closest('.dock-preview-item') : null; const to = ti ? +ti.dataset.dockIndex : pd.from; if (to !== pd.from) { [state.files[pd.from], state.files[to]] = [state.files[to], state.files[pd.from]]; requestAnimationFrame(renderPreviews); } } pd = null; });
			item.addEventListener('pointercancel', () => { pd = null; });
		});
		$$('[data-dock-remove]').forEach(button => button.addEventListener('click', event => { event.stopPropagation(); const idx = Number(button.dataset.dockRemove); state.files.splice(idx, 1); removeRefMention(idx); renderPreviews(); update(); }));
	}
	syncActiveFrameFiles();
	saveRefFiles();
}
function updateQueueStatus() {
	const running = state.tasks.some(task => task.status === 'running' || task.status === 'queued');
	const count = state.tasks.filter(task => task.status === 'running' || task.status === 'queued').length;
	const el = $('#queueStatus'); const wrap = $('.topbar-actions');
	if (el) el.textContent = running ? `正在生成 ${count} 个任务` : '队列空闲';
	if (wrap) wrap.classList.toggle('running', running);
}
function renderTasks() {
	$('#taskList').innerHTML = state.tasks.map(task => `<div class="task-card ${task.status}"><span class="task-indicator"></span><div><b>${task.status === 'running' ? '正在生成' : task.status === 'queued' ? '排队中' : task.status === 'failed' ? '生成失败' : '已完成'}</b><small>${task.prompt.slice(0, 42)}${task.prompt.length > 42 ? '…' : ''}</small></div>${task.status === 'running' || task.status === 'queued' ? `<button class="text-button" data-cancel-task="${task.id}">取消</button>` : task.status === 'failed' ? `<button class="text-button" data-retry-task="${task.id}">重试</button>` : ''}</div>`).join('');
	$$('[data-cancel-task]').forEach(button => button.addEventListener('click', () => cancelTask(button.dataset.cancelTask)));
	$$('[data-retry-task]').forEach(button => button.addEventListener('click', () => retryTask(button.dataset.retryTask)));
}
function renderHistory() {
	const query = ($('#historySearch')?.value || '').toLowerCase();
	// 元数据可能还没补 imageHash（旧格式迁移中），字段一律做空值兜底，避免整块渲染抛错
	const items = state.history.filter(item => (state.historyFilter === 'all' || item.favorite) && `${item.prompt || ''} ${item.model || ''}`.toLowerCase().includes(query));
	// 缩略图统一走 historyThumbUrl（128px 落盘缓存）；内存里没有原图也不影响显示
	$('#historyList').innerHTML = items.length ? items.map(item => `<article class="history-item"><span class="history-thumb ${item.imageHash ? '' : 'placeholder'}" data-view="${item.id}" role="button" aria-label="查看图片">${item.imageHash ? `<img src="${THUMB_PLACEHOLDER}" alt="">` : '无图'}</span><div class="history-caption"><b>${escapeHtml(String(item.prompt || '').slice(0, 40))}</b><small>${item.tier || ''} · ${item.createdAt ? new Date(item.createdAt).toLocaleDateString() : ''}</small></div><div class="history-actions"><button class="favorite-button ${item.favorite ? 'active' : ''}" data-favorite="${item.id}" aria-label="收藏">${item.favorite ? '★' : '☆'}</button><button class="delete-button" data-delete="${item.id}" aria-label="删除记录">×</button></div></article>`).join('') : '<p class="history-empty">还没有符合条件的本地记录</p>';
	// 缩略图异步补上：命中落盘缓存时几乎是同步返回
	$$('#historyList .history-thumb[data-view] img').forEach(img => {
		const entry = state.history.find(entry => entry.id === img.closest('[data-view]').dataset.view);
		if (entry) historyThumbUrl(entry).then(url => { if (url && img.isConnected) img.src = url; });
	});
	$$('[data-favorite]').forEach(button => button.addEventListener('click', event => { event.stopPropagation(); const item = state.history.find(entry => entry.id === button.dataset.favorite); if (item) item.favorite = !item.favorite; saveHistory(); }));
	$$('[data-delete]').forEach(button => button.addEventListener('click', event => { event.stopPropagation(); const id = button.dataset.delete; state.history = state.history.filter(entry => entry.id !== id); saveHistory(); updateStorageLabel(); }));
	$$('[data-view]').forEach(el => el.addEventListener('click', () => { const item = state.history.find(entry => entry.id === el.dataset.view); if (item) openHistoryViewer(item); }));
}
let viewerScale = 1;
let viewerItem = null;
// 打开查看器才去 IndexedDB 取原图：列表阶段不加载，避免上百 MB 常驻内存。
// 取到的原图挂在 _src 上（不会写进 localStorage），关闭时清掉。
async function openHistoryViewer(item) {
	let src = item.image;
	if (!src && item.imageHash) src = (await idbGet(CANVAS_DB, CANVAS_STORE, IMG_HASH_PREFIX + item.imageHash)) || '';
	if (!src) { showToast('原图已丢失，无法预览', 'err'); return; }
	item._src = src;
	viewerItem = item;
	const img = $('#viewerImage');
	img.src = renderSrc(src); img.style.objectFit = 'contain'; img.style.width = 'auto'; img.style.height = 'auto'; img.style.maxWidth = '100%'; img.style.maxHeight = '100%';
	$('#viewerPrompt').textContent = item.prompt; $('#viewerMeta').textContent = `${item.model} · ${item.tier} · ${new Date(item.createdAt).toLocaleString()}`;
	viewerScale = 1; img.style.transform = 'scale(1)';
	$('#historyListView').hidden = true; $('#historyViewer').hidden = false;
}
function closeHistoryViewer() { if (viewerItem) viewerItem._src = null; viewerItem = null; $('#historyViewer').hidden = true; $('#historyListView').hidden = false; }
function initViewerActions() {
	$('#viewerCopyPrompt')?.addEventListener('click', async () => {
		if (!viewerItem) return;
		try { await navigator.clipboard.writeText(viewerItem.prompt); flashViewerAction('复制提示成功'); }
		catch { copyTextFallback(viewerItem.prompt) ? flashViewerAction('复制提示成功') : flashViewerAction('复制提示失败'); }
	});
	$('#viewerCopyImage')?.addEventListener('click', async () => {
		if (!viewerItem?._src) return;
		try { const blob = await (await fetch(viewerItem._src)).blob(); await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]); showToast('复制图片成功', 'ok'); }
		catch { showToast('复制图片失败', 'err'); }
	});
	$('#viewerDownload')?.addEventListener('click', () => {
		if (!viewerItem?._src) return;
		const a = document.createElement('a'); a.href = viewerItem._src; a.download = `UCanTech-${viewerItem.id}.png`; document.body.appendChild(a); a.click(); a.remove();
		showToast('图片已开始下载', 'info');
	});
	$('#viewerDelete')?.addEventListener('click', () => {
		if (!viewerItem) return;
		state.history = state.history.filter(entry => entry.id !== viewerItem.id);
		saveHistory(); closeHistoryViewer();
	});
}
function copyTextFallback(text) {
	try {
		const ta = document.createElement('textarea');
		ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
		document.body.appendChild(ta); ta.focus(); ta.select();
		const ok = document.execCommand('copy');
		ta.remove(); return ok;
	} catch { return false; }
}
function flashViewerAction(text) {
	const el = document.createElement('div'); el.className = 'viewer-toast'; el.textContent = text;
	document.body.appendChild(el); requestAnimationFrame(() => el.classList.add('show'));
	setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 1200);
}
function showToast(message, type = 'info', duration = 2800) {
	const root = document.getElementById('toastRoot'); if (!root) return;
	const el = document.createElement('div'); el.className = 'toast-item ' + type; el.textContent = message;
	root.appendChild(el); requestAnimationFrame(() => el.classList.add('show'));
	setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, duration);
}
// 一次生成的结果整批写入节点（覆盖语义）：4 张图 = 同一个版本，共用一套输入状态。
// 再次生成会替换掉节点里原有的图，旧图只在历史记录里保留。
function pushFrameVersion(el, src, prompt, batchKey = '') {
	const id = frameId(el);
	let store = state.frameStore.get(id);
	if (!store || !Array.isArray(store.images)) store = { images: [], current: 0, batch: '' };
	// 同一次任务（同 batch）追加为同版本内的下一张；换任务则整批替换
	const isSameBatch = !!store.batch && !!batchKey && store.batch === batchKey;
	if (!isSameBatch) { store.images = []; store.batch = batchKey; }
	// 同一张图（同 src）不重复添加，防止任务重跑导致图片重复
	const existing = store.images.findIndex(v => v.src === src);
	if (existing >= 0) { store.current = existing; state.frameStore.set(id, store); persistCanvas(); return { store, added: false }; }
	store.images.push({ src, prompt });
	store.current = store.images.length - 1;
	state.frameStore.set(id, store);
	persistCanvas();
	return { store, added: true };
}
// 渲染一个已完成框：图片 + 按钮区 + 版本切换
function renderDoneFrame(el) {
	const id = frameId(el);
	const store = state.frameStore.get(id);
	if (!store || !store.images || !store.images.length) return;
	const item = store.images[store.current];
	const multi = store.images.length > 1;
	const elapsedLabel = el.dataset.elapsed ? `<span class="frame-timer result-timer">用时 ${el.dataset.elapsed}s</span>` : '';
	// 节点里只挂缩略图，原图等到全屏/下载/复制时才取。
	// 服务端直出的 URL 本身就是缩略图，直接用；base64 才走本地缩略图生成。
	const thumb = item.src.startsWith('data:') ? thumbUrl(item.src) : item.src;
	el.innerHTML = `${FRAME_DEL_BTN}<img class="result-image" src="${thumb || THUMB_PLACEHOLDER}" alt="生成结果">${elapsedLabel}${multi ? `<span class="version-badge">${store.images.length} 张</span>` : ''}<button class="fs-btn" type="button" title="全屏查看" aria-label="全屏查看">⛶</button><div class="result-actions"><button class="bat-copy" type="button">复制图片</button><a class="bat-download" href="#" download="UCanTech-${id}-${store.current + 1}.png">下载图片</a></div>${multi ? `<div class="version-nav"><button class="v-prev" type="button" aria-label="上一张"${store.current <= 0 ? ' disabled' : ''}>‹</button><span class="v-count">${store.current + 1} / ${store.images.length}</span><button class="v-next" type="button" aria-label="下一张"${store.current >= store.images.length - 1 ? ' disabled' : ''}>›</button></div>` : ''}`;
	const imgEl = el.querySelector('.result-image');
	// 缩略图还在后台生成时先占位，生成完再换上，避免节点空白。
	// 用 trackThumb 记录任务，恢复画布时能等它完成再撤加载遮罩。
	// 服务端直出的 URL 不需要本地生成缩略图，跳过这段。
	if (imgEl && !thumb && item.src.startsWith('data:')) {
		trackThumb(item.src).then(url => {
			if (url && imgEl.isConnected && state.frameStore.get(id)?.images[state.frameStore.get(id).current] === item) imgEl.src = url;
		});
	}
	bindFrameDel(el);
	const copyBtn = el.querySelector('.bat-copy');
	const fsBtn = el.querySelector('.fs-btn');
	const prev = el.querySelector('.v-prev'); const next = el.querySelector('.v-next');
	if (copyBtn) copyBtn.addEventListener('click', event => { event.stopPropagation(); copyImageToClipboard(renderSrc(item.src)); });
	const dl = el.querySelector('.bat-download');
	// 下载链接懒生成：渲染时做全尺寸 base64->blob 转换会把主线程堵住，点下载时再转
	if (dl) dl.addEventListener('click', event => {
		event.stopPropagation();
		const url = renderSrc(item.src);
		dl.href = url;
		showToast('图片已开始下载', 'info');
	});
	if (fsBtn) fsBtn.addEventListener('click', event => { event.stopPropagation(); openImageLightbox(renderSrc(item.src), item.prompt); });
	if (prev) prev.addEventListener('click', event => { event.stopPropagation(); switchFrameVersion(el, -1); });
	if (next) next.addEventListener('click', event => { event.stopPropagation(); switchFrameVersion(el, 1); });
}
function openImageLightbox(src, prompt = '') {
	const lightbox = $('#imageLightbox'); const image = $('#lightboxImage');
	if (!lightbox || !image) return;
	// 提示词：有才显示，过长由 CSS 单行省略
	const promptEl = $('#lightboxPrompt');
	if (promptEl) {
		const text = String(prompt || '').trim();
		promptEl.textContent = text;
		promptEl.hidden = !text;
	}
	// 惰性绑定关闭事件（initImageLightbox 可能未执行），避免全屏无法关闭
	if (!lightbox._closeBound) {
		$('#lightboxClose')?.addEventListener('click', closeImageLightbox);
		lightbox.addEventListener('click', event => { if (event.target === event.currentTarget) closeImageLightbox(); });
		document.addEventListener('keydown', event => { if (event.key === 'Escape') closeImageLightbox(); });
		window.addEventListener('resize', () => { if (!lightbox.hidden && lightbox._fit) lightbox._fit(); });
		// 底部操作按钮：复制提示词 / 复制图片 / 下载图片
		$('#lightboxCopyPrompt')?.addEventListener('click', async event => {
			event.stopPropagation();
			const text = ($('#lightboxPrompt')?.textContent || '').trim();
			if (!text) { showToast('该图片没有提示词', 'warn'); return; }
			try { await navigator.clipboard.writeText(text); showToast('提示词已复制', 'ok'); }
			catch { showToast(copyTextFallback(text) ? '提示词已复制' : '复制失败', copyTextFallback(text) ? 'ok' : 'err'); }
		});
		$('#lightboxCopyImage')?.addEventListener('click', event => { event.stopPropagation(); copyImageToClipboard(image.src); });
		$('#lightboxDownload')?.addEventListener('click', event => {
			event.stopPropagation();
			const a = document.createElement('a');
			a.href = image.src; a.download = `UCanTech-${Date.now()}.png`;
			document.body.appendChild(a); a.click(); a.remove();
			showToast('图片已开始下载', 'info');
		});
		// 滚轮缩放图片（保持原比例，0.3x ~ 8x）
		lightbox.addEventListener('wheel', event => {
			if (lightbox.hidden) return;
			event.preventDefault();
			const cur = lightbox._imgScale || 1;
			lightbox._imgScale = Math.min(8, Math.max(0.3, event.deltaY < 0 ? cur * 1.15 : cur / 1.15));
			if (lightbox._fit) lightbox._fit();
		}, { passive: false });
		// 拖拽平移：仅在图片区域内按下才启动；图片外点击仍走关闭逻辑
		image.addEventListener('pointerdown', event => {
			if (lightbox.hidden) return;
			event.preventDefault();
			image.setPointerCapture(event.pointerId);
			const startX = event.clientX, startY = event.clientY;
			const baseX = lightbox._panX || 0, baseY = lightbox._panY || 0;
			const move = e => {
				lightbox._panX = baseX + (e.clientX - startX);
				lightbox._panY = baseY + (e.clientY - startY);
				image.style.transform = `translate(${Math.round(lightbox._panX)}px, ${Math.round(lightbox._panY)}px)`;
			};
			const up = () => {
				image.removeEventListener('pointermove', move);
				image.removeEventListener('pointerup', up);
				image.removeEventListener('pointercancel', up);
			};
			image.addEventListener('pointermove', move);
			image.addEventListener('pointerup', up);
			image.addEventListener('pointercancel', up);
		});
		lightbox._closeBound = true;
	}
	// 原比例适配视口：显式计算宽高，绝不拉伸铺满、也绝不超出屏幕。
	// 灯箱自身带反向 zoom（抵消 body 缩放），所以它的净缩放是 1：
	// 布局像素 = 视觉像素，可用空间直接用 innerWidth/innerHeight，不能再除一次 bz。
	// （旧代码除了一次 bz，PC 上 bz=1 看不出问题，移动端 bz=0.33 就把图片放大成三倍多。）
	lightbox._fit = () => {
		const bz = parseFloat(getComputedStyle(document.body).zoom) || 1;
		lightbox.style.zoom = String(+(1 / bz).toFixed(4));
		const availW = window.innerWidth - 40;
		const availH = window.innerHeight - 40;
		const nw = image.naturalWidth || 1, nh = image.naturalHeight || 1;
		const scale = Math.min(availW / nw, availH / nh) * (lightbox._imgScale || 1);
		image.style.width = `${Math.round(nw * scale)}px`;
		image.style.height = `${Math.round(nh * scale)}px`;
	};
	lightbox._imgScale = 1; lightbox._panX = 0; lightbox._panY = 0;
	image.style.transform = '';
	image.onload = () => lightbox._fit();
	image.src = src;
	// 反向补偿 body 页面缩放（_fit 内部会写），保证灯箱精确覆盖视口、图片不被屏幕切断
	lightbox.removeAttribute('hidden');
	if (image.complete && image.naturalWidth) lightbox._fit();
	document.body.classList.add('lightbox-open');
}
function closeImageLightbox() {
	const lightbox = $('#imageLightbox');
	if (!lightbox) return;
	lightbox.setAttribute('hidden', '');
	$('#lightboxImage').removeAttribute('src');
	document.body.classList.remove('lightbox-open');
}
function initImageLightbox() {
	$('#lightboxClose')?.addEventListener('click', closeImageLightbox);
	$('#imageLightbox')?.addEventListener('click', event => { if (event.target === event.currentTarget) closeImageLightbox(); });
	document.addEventListener('keydown', event => { if (event.key === 'Escape') closeImageLightbox(); });
}
function switchFrameVersion(el, delta) {
	const id = frameId(el);
	const store = state.frameStore.get(id);
	if (!store || store.images.length < 2) return;
	// 非循环切换：到边界（第一张/最后一张）即停
	const next = Math.min(store.images.length - 1, Math.max(0, store.current + delta));
	if (next === store.current) return;
	store.current = next;
	state.frameStore.set(id, store);
	// 同一版本内切图：只换显示，不动输入框/提示词/参数面板
	persistCanvas();
	renderDoneFrame(el); update();
}
function fillFrame(image, task, index, opts = {}) {
	const src = image.type === 'base64' ? `data:image/png;base64,${image.value}` : image.value;
	// 服务端直出的图片 URL（缩略图/原图接口）：不是 base64，本地不用再生成缩略图
	const isRemote = !src.startsWith('data:');
	// 生成结果始终放进「当前选中的框」(task.frameTarget) 里，复用该框作为新版本，绝不自动新建框
	const targetId = task.frameTarget || task.editTarget;
	const target = targetId ? $$('#canvasWorld .canvas-frame').find(f => f.dataset.frameId === targetId) : null;
	const el = target || (() => { const n = document.createElement('div'); n.className = 'canvas-frame done'; $('#canvasWorld').appendChild(n); frameId(n); return n; })();
	el.classList.remove('loading'); el.classList.add('done'); el.dataset.task = ''; el.dataset.index = '';
	// 记录该框的比例并应用尺寸
	state.frameRatio.set(frameId(el), task.ratio);
	setFrameSize(el, task.ratio);
	const res = pushFrameVersion(el, src, task.prompt, task.serverTaskId || task.id);
	// 取回的是重复图片（同图已存在）时不覆盖节点已记录的真实用时
	if (res && res.added && task.elapsed) el.dataset.elapsed = task.elapsed;
	renderDoneFrame(el);
	// transient：只画不落库。两段式加载的第一段（缩略图）用，
	// 避免原图还没到就写 IndexedDB，留下一个任务记录过期后 404 的临时 URL。
	if (!opts.transient) persistCanvas();
	// 框自适应图片真实比例：用缩略图解码测宽高（原图 18MB 解码一次很贵，比例信息在缩略图上完全一致）
	const applyRatio = (w, h) => {
		if (!w || !h || !el.isConnected) return;
		const ratioStr = `${w}:${h}`;
		state.frameRatio.set(frameId(el), ratioStr);
		setFrameSize(el, ratioStr);
		if (state.activeFrameEl === el) { state.ratio = ratioStr; $$('#ratioOptions button').forEach(b => b.classList.remove('selected')); positionDock(el); }
		if (!opts.transient) persistCanvas();
	};
	if (isRemote) {
		// 服务端 URL 本身就是缩略图，直接测尺寸，不用过本地缩略图流水线
		const probe = new Image();
		probe.onload = () => applyRatio(probe.naturalWidth, probe.naturalHeight);
		probe.src = src;
	} else {
		thumbUrlAsync(src).then(url => {
			if (!url) return;
			const probe = new Image();
			probe.onload = () => applyRatio(probe.naturalWidth, probe.naturalHeight);
			probe.src = url;
		});
	}
	if (opts.transient) { update(); return; }
	state.history.unshift({ id: `${Date.now()}-${Math.random()}`, boardId: task.boardId || state.activeBoardId, prompt: task.prompt, model: task.model || '', tier: state.tier, createdAt: Date.now(), favorite: false, image: src }); saveHistory(); persistCanvas(); update();
}
// 新格式取图：两段式。
// 第一段：把服务端缩略图（512px WebP，几十 KB）直接挂到节点上，用户几乎立刻看到图；
// 第二段：后台把原图拉回来（2K 图约 1.5MB）替换 src 并落库，下载/复制/全屏自动用原图。
function fillFrameRemote(task, index) {
	const thumbSrc = `/api/tasks/${task.serverTaskId}/thumb/${index}`;
	fillFrame({ type: 'url', value: thumbSrc }, task, index, { transient: true });
	upgradeFrameImage(task, index, thumbSrc);
}
async function upgradeFrameImage(task, index, thumbSrc) {
	const targetId = task.frameTarget || task.editTarget;
	const el = targetId ? $$('#canvasWorld .canvas-frame').find(f => f.dataset.frameId === targetId) : null;
	if (!el) return;
	try {
		const response = await fetch(`/api/tasks/${task.serverTaskId}/image/${index}`);
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const dataUrl = await blobToDataUrl(await response.blob());
		const id = frameId(el);
		const store = state.frameStore.get(id);
		if (!store) return;
		// 按 src 定位那一张：节点可能已被删除，或整批已被新任务覆盖（此时找不到，直接放弃）
		const item = store.images.find(v => v.src === thumbSrc);
		if (!item) return;
		item.src = dataUrl;
		state.frameStore.set(id, store);
		renderDoneFrame(el);
		// 原图到位后才写历史与画布快照。
		// 用 src 内容做去重：恢复画布时的补拉会再次走到这里，不防的话历史会越堆越多。
		const historyKey = `${task.serverTaskId || ''}#${index}`;
		const already = state.history.some(h => h.historyKey === historyKey);
		if (!already) {
			state.history.unshift({ id: `${Date.now()}-${Math.random()}`, historyKey, boardId: task.boardId || state.activeBoardId, prompt: task.prompt || '', model: task.model || '', tier: state.tier, createdAt: Date.now(), favorite: false, image: dataUrl });
			saveHistory();
		}
		persistCanvas();
	} catch (error) {
		// 原图取不到就保留缩略图，不打断用户——缩略图已足够看清内容
		console.warn('原图获取失败，保留缩略图：', error);
	}
}
function blobToDataUrl(blob) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result);
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(blob);
	});
}
// 恢复画布后的补救：快照里若还有 /api/tasks/<id>/image/<i> 之外的临时 URL，
// 说明上次原图没来得及下载就刷新了，这里补一次，避免任务记录过期后图片 404。
function resumePendingUpgrades() {
	state.frameStore.forEach((store, id) => {
		if (!store || !Array.isArray(store.images)) return;
		store.images.forEach((item, index) => {
			if (!item || typeof item.src !== 'string' || item.src.startsWith('data:')) return;
			const match = item.src.match(/\/api\/tasks\/([^/]+)\/thumb\/(\d+)/);
			if (!match) return;   // 不是本系统产出的 URL，不动
			const [, taskId, idx] = match;
			const el = $$('#canvasWorld .canvas-frame').find(f => frameId(f) === id);
			if (el) upgradeFrameImage({ serverTaskId: taskId, frameTarget: id }, Number(idx), item.src);
		});
	});
}
function dataUrlToFile(dataUrl) {
	const arr = dataUrl.split(','); const mime = (arr[0].match(/:(.*?);/) || [,'image/png'])[1];
	const bin = atob(arr[1]); const u8 = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
	return new File([u8], `edit-ref-${Date.now()}.png`, { type: mime });
}
async function copyImageToClipboard(src) {
	try {
		const blob = await (await fetch(src)).blob(); await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
		showToast('复制图片成功', 'ok');
	} catch { showToast('复制图片失败', 'err'); }
}
// 异步版：原图还在下载中（src 是服务端 URL）时先拉回来再转 File。
// enqueueEditTask 用它，保证即使原图没到位，编辑也能带上节点当前图。
async function currentNodeRefFileAsync() {
	const el = state.activeFrameEl;
	if (!el) return null;
	const store = state.frameStore.get(frameId(el));
	if (!store || !store.images || !store.images.length) return null;
	const item = store.images[store.current];
	if (!item) return null;
	if (item.src.startsWith('data:')) return dataUrlToFile(item.src);
	try {
		const response = await fetch(item.src);
		if (!response.ok) return null;
		const blob = await response.blob();
		const name = item.src.includes('/thumb/') ? 'node-ref-thumb.webp' : 'node-ref.png';
		return new File([blob], name, { type: blob.type || 'image/png' });
	} catch { return null; }
}
// 节点当前是否有可当参考图的图（不管原图到没到，有缩略图 URL 也算）
function hasNodeCurrentRef() {
	const el = state.activeFrameEl;
	if (!el) return false;
	const store = state.frameStore.get(frameId(el));
	return !!(store && store.images && store.images.length && store.images[store.current]);
}
// 图生图可提交的参考图总数：手动上传的（≤8）+ 节点当前图（最多 +1）
function refSubmitCount() {
	return state.files.length + (hasNodeCurrentRef() ? 1 : 0);
}
// 点击「编辑图片」：切到图生图。节点当前图不再塞进 state.files——
// 它由 enqueueEditTask 自动带上，塞进来会导致同一张图发两遍。
function startEditFrame(el) {
	const id = frameId(el);
	const store = state.frameStore.get(id);
	if (!store || !store.images.length) return;
	state.editingFrameId = id;
	state.mode = 'reference';
	persistActiveSettings({ mode: 'reference' });
	state.dockMode = 'edit';
	$$('.mode').forEach(button => button.classList.toggle('active', button.dataset.mode === 'reference'));
	$('#referenceBox')?.classList.add('open');
	renderPreviews(); update();
	const ta = $('#prompt'); if (ta) { ta.dataset.placeholder = '描述你想如何编辑这张图片，如：将背景改为雪夜'; }
	selectFrame(el, null);
}
async function processTask(task, silent = false) {
	if (task.filled) { task.status = 'done'; renderTasks(); updateQueueStatus(); return; }
	task.status = 'running';
	// 开始时间用墙钟：任务已持久化过就沿用原值，刷新恢复后计时器接着走而不是从 0 开始。
	// 必须在 persistTasks 之前赋值，否则首次落盘会漏掉这个字段。
	const startedAt = task.startedAt || Date.now();
	task.startedAt = startedAt;
	renderTasks(); updateQueueStatus();
	persistTasks();
	// 生成动画始终显示在当前选中的目标框内，绝不自动新建框
	const targetId = task.frameTarget || task.editTarget;
	const target = targetId ? $$('#canvasWorld .canvas-frame').find(f => f.dataset.frameId === targetId) : null;
	if (target) {
		const modeLabel = task.mode === 'reference' ? '编辑中' : '生成中';
		target.classList.remove('done'); target.classList.add('loading'); target.dataset.task = task.id;
		target.innerHTML = `${FRAME_DEL_BTN}<span class="canvas-spinner"></span><span class="loading-orbit">✦</span><span class="frame-timer">0.00s</span><span class="placeholder-label loading-message">正在调用 ChatGPT Images 2.5 构建图片<span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span></span>`;
		bindFrameDel(target);
		startFrameTimer(target, startedAt);
	}
	const controller = new AbortController(); task.controller = controller; const form = new FormData(); form.append('prompt', task.prompt); form.append('tier', task.tier); form.append('ratio', task.ratio); form.append('quality', task.quality); form.append('count', task.count); form.append('mode', task.mode); task.files.forEach(file => form.append('image', file));
	try {
		let response;
		if (!task.serverTaskId) {
			response = await fetch('/api/tasks', { method: 'POST', body: form, signal: controller.signal });
			const created = await response.json(); if (!response.ok) throw new Error(created.error || '任务提交失败');
			task.serverTaskId = created.task_id; task.files = []; persistTasks();
			if (typeof created.balance === 'number') setBalanceDisplay(created.balance);
		}
		let data;
		do {
			response = await fetch(`/api/tasks/${task.serverTaskId}`, { signal: controller.signal });
			data = await response.json(); if (!response.ok || data.status === 'failed') throw new Error((data.error || '生成失败') + (data.refunded ? '（未消耗额度已退款）' : ''));
			if (data.status !== 'done') await new Promise(resolve => setTimeout(resolve, 800));
		} while (data.status !== 'done');
		// 任务标记 done 但没图（上游异常）：视为失败，让 catch 弹 toast，不再无限走秒
		const hasBase64 = !!(data.images && data.images.length);
		const hasRefs = !!(data.cached_ids && data.cached_ids.length);
		if (!hasBase64 && !hasRefs) throw new Error(data.error || '上游未返回图片，费用已退回');
		// 优先用后端记录的真实生成耗时；恢复画布后重跑旧任务时才不会把取回耗时当作用时
		task.elapsed = (typeof data.elapsed === 'number' && data.elapsed > 0)
			? data.elapsed.toFixed(2)
			: ((Date.now() - startedAt) / 1000).toFixed(2);
		// 模型名由后端决定并回传，前端不猜（可能被管理员改过）
		task.model = data.model || task.model || '';
		// 新格式：后端只回 cached_ids，图片走 /api/tasks/<id>/thumb|image 两段式取回，
		// 缩略图先出（几十 KB），原图后台补。旧格式（任务里还带 base64）走原路径，两者并存。
		const imageCount = hasBase64 ? data.images.length : (data.image_count || data.cached_ids.length);
		if (task.boardId && task.boardId !== state.activeBoardId) {
			// 任务属于另一个画布（用户在生成期间切走了）：写进目标画布的持久化数据，不碰当前 DOM
			saveResultToBoardStorage(task, data, imageCount);
		} else if (hasBase64) {
			data.images.forEach((image, index) => fillFrame(image, task, index));
		} else {
			for (let index = 0; index < imageCount; index++) fillFrameRemote(task, index);
		}
		task.status = 'done'; task.filled = true;
		persistTasks();
		// 短提示：带上本次实际提交的参考图数量，用户能一眼确认这轮带了几张图
		if (!silent) {
			const refs = task.refCount || 0;
			showToast(`已生成 ${imageCount} 张${refs ? ` · 参考图 ${refs} 张` : ''}`, 'ok', 2200);
		}
	} catch (error) {
		task.elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);
		if (error.name === 'AbortError') task.status = 'cancelled';
		else { task.status = 'failed'; task.error = error.message; if (!silent) showToast(error.message || '生成失败，请稍后重试', 'err'); }
		if (target) {
			stopFrameTimer(target);
			target.classList.remove('loading'); target.dataset.task = '';
			target.dataset.elapsed = task.elapsed;
			if (state.frameStore.has(frameId(target))) { target.classList.add('done'); renderDoneFrame(target); }
			else { target.classList.add('empty'); setFrameHint(target); }
		}
	}
	finally { task.controller = null; renderTasks(); updateQueueStatus(); }
}
function enqueueTask() { 
	// #prompt 是 contenteditable div，没有 .value，必须走 getPromptText()
	const prompt = getPromptText().trim();
	if (!prompt) { showToast('请先输入提示词再生成', 'warn'); return; }
	if (state.mode === 'reference' && !refSubmitCount()) { showToast('请先上传参考图再生成', 'warn'); return; }
	if (typeof state.balance === 'number' && state.balance <= 0) { showToast('余额不足，请先兑换额度', 'err'); return; }
	if (state.dockOwner) state.framePrompts.set(state.dockOwner, prompt); const task = { id: `${Date.now()}-${Math.random()}`, boardId: state.activeBoardId, prompt, tier: state.tier, ratio: state.ratio, quality: state.quality, count: state.count, mode: state.mode, files: [...state.files], refCount: state.files.length, frameTarget: state.activeFrameEl ? frameId(state.activeFrameEl) : null, editTarget: state.editingFrameId || null, status: 'queued' }; state.tasks.push(task); $('#referenceImages').value = ''; update(); renderTasks(); processTask(task); }
// 从标准比例表里挑出与给定比例最接近的 key（编辑任务的 size 参数必须使用标准档位）
function nearestRatioKey(ratio) {
	const aspect = ratioValue(ratio);
	return Object.keys(sizes['1K']).reduce((best, key) => Math.abs(ratioValue(key) - aspect) < Math.abs(ratioValue(best) - aspect) ? key : best, Object.keys(sizes['1K'])[0]);
}
// 已有图片节点的「编辑图片」：参考图 = 用户手动上传的（≤8）+ 节点当前查看的那张（最多 +1）。
// 节点其他版本图一律不带——所见即所改。
async function enqueueEditTask() {
	const el = state.activeFrameEl;
	if (!el) return;
	const id = frameId(el);
	const store = state.frameStore.get(id);
	if (!store || !store.images || !store.images.length) return;
	const prompt = getPromptText().trim();
	if (!prompt) { showToast('请先输入编辑描述', 'warn'); return; }
	if (typeof state.balance === 'number' && state.balance <= 0) { showToast('余额不足，请先兑换额度', 'err'); return; }
	const manual = state.files.slice(0, 8);
	// 用异步版：原图可能还在后台下载（src 是服务端 URL），这时现拉一次再提交
	const currentRef = await currentNodeRefFileAsync();
	const refs = currentRef ? [...manual, currentRef] : manual;
	if (!refs.length) { showToast('该节点没有可用的参考图', 'err'); return; }
	const task = { id: `${Date.now()}-${Math.random()}`, boardId: state.activeBoardId, prompt, tier: state.tier, ratio: nearestRatioKey(getFrameRatio(el)), quality: state.quality, count: 1, mode: 'reference', files: refs, refCount: refs.length, frameTarget: id, editTarget: id, status: 'queued' };
	state.tasks.push(task);
	// 手动参考图同样保留，直到用户自己删
	$('#referenceImages').value = '';
	update(); renderTasks(); processTask(task);
}
$('#editButton')?.addEventListener('click', enqueueEditTask);
function cancelTask(id) { const task = state.tasks.find(item => item.id === id); if (task?.controller) task.controller.abort(); else if (task) task.status = 'cancelled'; renderTasks(); }
function retryTask(id) { const task = state.tasks.find(item => item.id === id); if (task) { task.status = 'queued'; processTask(task); } }

$$('.mode').forEach(button => button.addEventListener('click', () => {
	// 有参考图时不允许切回文生图：说明原因 + 告知怎么解除
	if (button.dataset.mode === 'text' && state.files.length) {
		showToast(`已添加 ${state.files.length} 张参考图，无法使用文生图。删除全部参考图后即可切换。`, 'warn', 4200);
		return;
	}
	state.mode = button.dataset.mode; state.editingFrameId = null; state.dockMode = 'text';
	const ta = $('#prompt'); if (ta) ta.dataset.placeholder = '可直接文字生图，或上传图片输入文字指令对图片进行编辑，如：将背景改为雪夜';
	$$('.mode').forEach(item => item.classList.toggle('active', item === button));
	$('#referenceBox').classList.toggle('open', state.mode === 'reference');
	persistActiveSettings({ mode: state.mode }); update();
}));
$$('#tierOptions button').forEach(button => button.addEventListener('click', () => { state.tier = button.dataset.value; $$('#tierOptions button').forEach(item => item.classList.toggle('selected', item === button)); persistActiveSettings({ tier: state.tier }); update(); }));
$$('#ratioOptions button').forEach(button => button.addEventListener('click', () => {
	state.ratio = button.dataset.value;
	$$('#ratioOptions button').forEach(item => item.classList.toggle('selected', item === button));
	// 只修改当前选中的框框，不影响其它框。
	if (state.activeFrameEl) {
		// 有图/生成中的节点：只调整框尺寸并保留内容（图片 contain 留白适配新比例），绝不清空重绘
		if (state.activeFrameEl.classList.contains('done') || state.activeFrameEl.classList.contains('loading')) {
			state.frameRatio.set(frameId(state.activeFrameEl), state.ratio);
			setFrameSize(state.activeFrameEl, state.ratio);
		} else {
			setFrameRatio(state.activeFrameEl, state.ratio);
		}
		positionDock(state.activeFrameEl);
	}
	persistCanvas();
	update();
}));
$$('.quick-counts button').forEach(button => button.addEventListener('click', () => { state.count = Number(button.dataset.count); $$('.quick-counts button').forEach(item => item.classList.toggle('selected', item === button)); persistActiveSettings({ count: state.count }); update(); }));
let promptPersistTimer = null;
let lastPromptSnapshot = '';
$('#prompt').addEventListener('input', () => {
	const text = getPromptText();
	if (text.length > 4000) { setPromptContent(lastPromptSnapshot); showToast('提示词最长 4000 字', 'warn'); }
	else { lastPromptSnapshot = text; if (state.dockOwner) state.framePrompts.set(state.dockOwner, text); }
	update(); clearTimeout(promptPersistTimer); promptPersistTimer = setTimeout(persistCanvas, 400);
});
$('#prompt').addEventListener('blur', () => { if (state.dockOwner) { state.framePrompts.set(state.dockOwner, getPromptText()); persistCanvas(); } });
$('#prompt').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); document.execCommand('insertLineBreak'); } });
$('#referenceImages').addEventListener('change', event => { const added = [...event.target.files].slice(0, 8 - state.files.length); state.files = [...state.files, ...added].slice(0, 8); added.forEach(f => appendRefChip(refSeq(f))); renderPreviews(); update(); });
$('#previewList').addEventListener('paste', event => { const images = [...event.clipboardData.files].filter(file => ALLOWED_IMAGE_TYPES.has(file.type)); const added = images.slice(0, 8 - state.files.length); state.files = [...state.files, ...added].slice(0, 8); added.forEach(f => appendRefChip(refSeq(f))); renderPreviews(); update(); });
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const refBox = $('#referenceBox');
if (refBox) {
	refBox.addEventListener('dragover', event => {
		if (event.dataTransfer?.types.includes('application/x-preview-reorder')) return; // 排序拖拽不高亮上传区
		if (!event.dataTransfer?.types.includes('Files')) return;
		event.preventDefault(); refBox.classList.add('dragging');
	});
	refBox.addEventListener('dragleave', () => refBox.classList.remove('dragging'));
	refBox.addEventListener('drop', event => {
		event.preventDefault(); refBox.classList.remove('dragging');
		if (event.dataTransfer?.types.includes('application/x-preview-reorder')) return; // 排序拖拽不当作外部文件添加
		if (!event.dataTransfer?.types.includes('Files')) return;
		const files = [...(event.dataTransfer?.files || [])].filter(file => ALLOWED_IMAGE_TYPES.has(file.type));
		if (files.length) { const added = files.slice(0, 8 - state.files.length); state.files = [...state.files, ...added].slice(0, 8); added.forEach(f => appendRefChip(refSeq(f))); renderPreviews(); update(); }
	});
}
$('#newNodeButton')?.addEventListener('click', () => { addNewNode(); });
$('#generateButton').addEventListener('click', () => { enqueueTask(); });
$('#historyToggle').addEventListener('click', () => { $('#historyDrawer').classList.add('open'); renderHistory(); });
$('#closeHistory').addEventListener('click', () => { closeHistoryViewer(); $('#historyDrawer').classList.remove('open'); });
$('#historyDrawer').addEventListener('click', event => { if (event.target === event.currentTarget) { closeHistoryViewer(); $('#historyDrawer').classList.remove('open'); } });
$('#closeViewer')?.addEventListener('click', closeHistoryViewer);
$('#viewerStage')?.addEventListener('click', event => { if (event.target === event.currentTarget) closeHistoryViewer(); });
$('#viewerStage')?.addEventListener('wheel', event => { event.preventDefault(); viewerScale = Math.min(4, Math.max(1, viewerScale + (event.deltaY < 0 ? 0.1 : -0.1))); $('#viewerImage').style.transform = `scale(${viewerScale})`; }, { passive: false });
document.addEventListener('keydown', event => { if (event.key === 'Escape') { if (!$('#historyViewer').hidden) closeHistoryViewer(); else $('#historyDrawer').classList.remove('open'); } });
$('#historySearch').addEventListener('input', renderHistory);
$$('[data-history-filter]').forEach(button => button.addEventListener('click', () => { state.historyFilter = button.dataset.historyFilter; $$('[data-history-filter]').forEach(item => item.classList.toggle('selected', item === button)); renderHistory(); }));
// 多画布：添加按钮 + 切换器下拉（菜单内容是动态渲染的，所以用事件委托）
$('#addBoard')?.addEventListener('click', addBoard);
$('#boardTrigger')?.addEventListener('click', event => {
	event.stopPropagation();
	const menu = $('#boardMenu'); if (!menu) return;
	if (menu.hidden) renderBoardSwitcher();   // 每次展开都重算，保证缓存体积是最新的
	menu.hidden = !menu.hidden;
	$('#boardTrigger').setAttribute('aria-expanded', String(!menu.hidden));
});
document.addEventListener('click', event => {
	const menu = $('#boardMenu'); const sw = $('#boardSwitch');
	if (!menu || menu.hidden) return;
	if (sw && !sw.contains(event.target)) { menu.hidden = true; $('#boardTrigger')?.setAttribute('aria-expanded', 'false'); }
});
$('#boardMenu')?.addEventListener('click', async event => {
	const btn = event.target.closest('[data-rename],[data-clear],[data-del]');
	if (btn) {
		event.stopPropagation();
		if (btn.dataset.rename) return renameBoard(btn.dataset.rename);
		if (btn.dataset.clear) return clearBoard(btn.dataset.clear);
		if (btn.dataset.del) return deleteBoard(btn.dataset.del);
		return;
	}
	const item = event.target.closest('[data-board]');
	if (item) {
		$('#boardMenu').hidden = true;
		$('#boardTrigger')?.setAttribute('aria-expanded', 'false');
		await switchBoard(item.dataset.board);
	}
});
$('#clearHistory').addEventListener('click', () => openModal({ title: '清空本地历史', message: '确定清空本地历史吗？历史图片缓存和画布内容都会被清除，此操作不可撤销。', confirmText: '清空', danger: true }).then(ok => { if (ok) { state.history = []; saveHistory(); clearCanvas(); } }));
// 让舞台标题文字尽量大，填满可用宽度（单行不换行）
function fitStageHeading() {
	const heading = $('#canvasViewport')?.closest('.stage-panel')?.querySelector('.stage-heading');
	if (!heading) return;
	const h1 = heading.querySelector('h1'); if (!h1) return;
	heading.style.whiteSpace = 'nowrap'; h1.style.whiteSpace = 'nowrap';
	// 让 h1 按文字内容测量，不被 grid 列裁剪
	h1.style.minWidth = 'max-content';
	// 可用宽度 = min(容器宽, 视口宽)。页面 min-width 1200 会横向溢出，
	// 必须按视口宽缩字号，保证标题单行时永远不超出屏幕
	const vp = $('#canvasViewport'); if (!vp) return;
	// 页面整体会被 body zoom 放大，视觉宽度 = 布局宽 × zoom，
	// 因此可用布局宽要按 1/zoom 折算，确保视觉上不超出屏幕
	const zoom = parseFloat(document.body.style.zoom) || 1;
	const avail = Math.min(vp.clientWidth, window.innerWidth / zoom) * 0.94;
	// 用二分查找最大字号，使文字宽度不超过可用宽度
	let lo = 12, hi = 72, best = 20;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		h1.style.fontSize = `${mid}px`;
		const w = h1.scrollWidth;
		if (w <= avail) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
	}
	h1.style.fontSize = `${best}px`;
	h1.style.minWidth = '';
}
// 移动端适配：以标题一行文字（设计字号 40px）宽度确定整体缩放，整页等比缩小，固定相对位置
// 工作台的设计宽度：PC 布局按这个宽度固定，窄屏（移动端）靠整体等比缩放来适配
const DESIGN_WIDTH = 1200;
// 是否为窄屏设备（移动端）。只按宽度判断——用高度判断会把 1440×800 这类
// 带浏览器工具栏的笔记本窗口误判成移动端（视口高度常常不足 820）。
// 手机横屏时宽度可能超过 820，所以补一个 UA 兜底。
function isMobileViewport() {
	if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) return true;
	return window.innerWidth <= 820;
}
// 移动端：把整页等比缩放到刚好塞进视口宽度，保持 PC 布局一字不改、内容不横向溢出。
// 返回缩放值；PC 端返回 1（不缩放，用户手动缩放照旧）。
function fitMobileZoom() {
	if (!isMobileViewport()) return 1;
	const vw = document.documentElement.clientWidth || window.innerWidth;
	// 留一点边距，避免贴着屏幕边缘；上限 1（不放大），下限 0.2 防止极端窄屏缩到不可用
	const z = Math.min(1, Math.max(0.2, Math.round((vw / DESIGN_WIDTH) * 1000) / 1000));
	return z;
}
function fitResponsive() {
	const shell = document.querySelector('.app-shell'); const workspace = document.querySelector('.workspace');
	if (!shell || !workspace) return;
	// 工作台固定设计尺寸，不随窗口/视口大小整体缩放（用户要求固定、不依赖之前窗口大小）
	shell.style.zoom = '';
	shell.style.height = '';
	workspace.style.height = '';
	// 移动端：自动等比缩放整页，保证 PC 布局在窄屏上完整可见。
	// 宽屏：恢复用户手动保存的缩放值——否则从窄屏拉宽后会一直卡在自动缩放的小比例上。
	const mobileZoom = fitMobileZoom();
	applyPageZoom(mobileZoom < 1 ? mobileZoom : getPageZoom(), { silent: true });
	// 刷新后页面缩放若非 100%，需按 1/zoom 补偿容器高度，否则缩放后内容高度小于视口、底部出现真空带
	const z = parseFloat(document.body.style.zoom) || 1;
	if (z !== 1) {
		shell.style.height = `calc(100vh / ${z})`;
		workspace.style.height = `calc(100vh / ${z} - 4.5rem)`;
	}
	fitStageHeading();
}
/* ---------- 用户额度：识别 / 余额 / 兑换 ---------- */
function formatUsd(amount) { return `$${Number(amount || 0).toFixed(2)}`; }
// 余额数字滚动动画：从当前显示值平滑过渡到目标值（兑换/扣费时递增/递减）
function animateUsd(el, toAmount) {
	if (!el) return;
	const from = parseFloat(el.textContent.replace(/[^0-9.]/g, '')) || 0;
	if (from === toAmount) { el.textContent = formatUsd(toAmount); return; }
	const dur = 600, t0 = performance.now();
	const step = now => {
		const p = Math.min(1, (now - t0) / dur);
		const ease = 1 - Math.pow(1 - p, 3); // easeOutCubic
		el.textContent = formatUsd(from + (toAmount - from) * ease);
		if (p < 1) requestAnimationFrame(step);
		else el.textContent = formatUsd(toAmount);
	};
	requestAnimationFrame(step);
}
function setBalanceDisplay(amount) {
	const chip = $('#balanceChip'); const val = $('#balanceVal'); const rb = $('#redeemBalance');
	// 移动端底部余额条：与顶栏同源，同一次赋值同时更新，保证两处永远一致
	const mobileBar = $('#mobileBalance'); const mobileVal = $('#mobileBalanceVal');
	state.balance = amount;
	if (val) animateUsd(val, amount);
	if (rb) animateUsd(rb, amount);
	if (mobileVal) animateUsd(mobileVal, amount);
	if (chip) chip.hidden = false;
	if (mobileBar) mobileBar.hidden = false;
}
function refreshUserBalance() {
	return fetch('/api/balance', { method: 'GET' })
		.then(r => r.json())
		.then(data => { setBalanceDisplay(data.balance); return data; })
		.catch(() => null);
}
async function loadPurchaseLink() {
	const buy = $('#redeemBuy');
	if (!buy) return;
	try {
		const r = await fetch('/api/purchase'); const data = await r.json();
		// 规范化成绝对链接：避免缺少协议时被当作相对路径在当前站基础上拼接
		let url = (data && data.url) ? String(data.url).trim() : '';
		if (url && !/^https?:\/\//i.test(url)) url = url.startsWith('//') ? 'https:' + url : 'https://' + url;
		if (url) { buy.href = url; buy.hidden = false; }
		else { buy.hidden = true; }
	} catch (e) { buy.hidden = true; }
}
function openRedeem() { $('#redeemMask').hidden = false; $('#redeemInput').value = ''; $('#redeemMsg').textContent = ''; $('#redeemMsg').className = 'redeem-msg'; loadPurchaseLink(); setTimeout(() => $('#redeemInput').focus(), 40); }
function closeRedeem() { $('#redeemMask').hidden = true; }
function initBilling() {
	$('#redeemButton')?.addEventListener('click', openRedeem);
	// 移动端底部余额条：点击同样打开兑换弹窗
	$('#mobileBalance')?.addEventListener('click', openRedeem);
	$('#redeemClose')?.addEventListener('click', closeRedeem);
	$('#redeemMask')?.addEventListener('click', e => { if (e.target === e.currentTarget) closeRedeem(); });
	document.addEventListener('keydown', e => { if (e.key === 'Escape') closeRedeem(); });
	$('#redeemSubmit')?.addEventListener('click', async () => {
		const code = ($('#redeemInput').value || '').trim();
		const msg = $('#redeemMsg');
		if (!code) { msg.textContent = '请输入激活码。'; msg.className = 'redeem-msg err'; return; }
		msg.textContent = '正在兑换…'; msg.className = 'redeem-msg';
		try {
			const resp = await fetch('/api/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
			const data = await resp.json();
			if (resp.ok && data.ok) {
				msg.textContent = data.message; msg.className = 'redeem-msg ok';
				setBalanceDisplay(data.balance);
				$('#redeemInput').value = '';
			} else { msg.textContent = data.message || data.error || '兑换失败。'; msg.className = 'redeem-msg err'; }
		} catch (err) { msg.textContent = '网络错误，请稍后重试。'; msg.className = 'redeem-msg err'; }
	});
	refreshUserBalance();
}
// 先确定画布（含旧数据迁移），再恢复该画布的内容。迁移是异步的，必须等它完成再读画布数据。
initQualityOptions(); initParamPopover(); initCanvas(); restoreTasks(); renderTierPrices();
// 首屏加载遮罩的收尾：恢复再快也要让 logo 完整露一次脸，否则一闪而过等于没有。
// 时序：淡入 .6s（CSS）→ 稳定显示到 2.4s → 淡出 .6s，合计约 3s。
const LOADING_MIN_SHOW = 2400;   // 从遮罩出现起算的最短展示时长
const LOADING_FADE_OUT = 600;    // 淡出时长，与 CSS 的 loading-fade-in 保持一致
const loadingShownAt = Date.now();
let loadingHidden = false;
function hideCanvasLoading() {
	const el = $('#canvasLoading');
	if (!el || loadingHidden) return;
	loadingHidden = true;
	const wait = Math.max(0, LOADING_MIN_SHOW - (Date.now() - loadingShownAt));
	setTimeout(() => {
		// animation 的 fill:both 会把 opacity 锁在终态，必须先关掉动画再交给 transition
		el.style.animation = 'none';
		el.style.opacity = '1';
		requestAnimationFrame(() => {
			el.style.transition = `opacity ${LOADING_FADE_OUT}ms ease`;
			el.style.opacity = '0';
			// 留一点余量，避免过渡还没跑完就 display:none
			setTimeout(() => { el.hidden = true; }, LOADING_FADE_OUT + 50);
		});
	}, wait);
}
ensureBoards().then(() => {
	renderBoardSwitcher();
	return restoreCanvas();
}).then(() => { hideCanvasLoading(); initImageLightbox(); initUIWheelLock(); initViewerActions(); restoreRefFiles().then(renderPreviews); renderTasks(); hydrateHistoryImages().then(renderHistory); updateStorageLabel(); update(); fitResponsive(); initBilling(); refreshPrices(); setInterval(refreshPrices, 15000); loadAnnouncement(); state.tasks.filter(task => task.status === 'queued' || task.status === 'running').forEach(task => processTask(task, true));
	// 空画布（新画布或刚清空过）：补一个默认空节点，否则画布一片空白没法操作
	if (!document.querySelector('#canvasWorld .canvas-frame')) appendEmptyFrame();
	// 启动后重落一次盘：把上一版按节点存的图片（imgs:*）迁移成内容哈希格式（img:<hash>），
	// 再让 GC 清掉旧 key，避免同一张图存两份
	persistCanvasNow();
	setTimeout(() => { gcImages(); updateStorageLabel(); }, 1500);
});
window.addEventListener('resize', () => {
	fitResponsive();
	invalidateDockMetrics();   // 窗口尺寸变了，dock/shell 的缓存要重算
	if (state.activeFrameEl && !$('#promptDock').hidden) {
		requestAnimationFrame(() => positionDock(state.activeFrameEl));
	}
});
/* ---------- 页面缩放控件（右下角，缩放 body，控件自身反向补偿保持大小不变） ---------- */
const PAGE_ZOOM_KEY = 'phantom-page-zoom';
// 给 fixed 覆盖层做反向缩放，并保证它在视觉上绝不超出给定的最大宽度。
// 反向缩放抵消整页 zoom 后，元素内部坐标 = 视觉像素，宽度量出来就是真实观感宽度；
// 若仍超宽，按比例把 zoom 再乘一次即可等比缩小（宽度与 zoom 成正比）。
function fitOverlay(el, invZoom, maxVisual) {
	if (!el) return;
	el.style.zoom = String(+invZoom.toFixed(4));
	if (maxVisual === Infinity) return;
	el.style.maxWidth = 'none';
	const w = el.getBoundingClientRect().width;
	if (w > maxVisual + 0.5) el.style.zoom = String(+(invZoom * (maxVisual / w)).toFixed(4));
}
// opts.silent = true 时用于自动适配：不写 localStorage，避免自动缩放覆盖用户手动设置的缩放值。
function applyPageZoom(v, opts = {}) {
	const mobile = isMobileViewport();
	// 移动端允许缩到 0.2（适配窄屏），PC 端沿用原来的 0.75 下限，避免被移动端的值带偏
	const bounds = mobile ? { min: 0.2, max: 1.5 } : { min: 0.75, max: 1.5 };
	const z = Math.min(bounds.max, Math.max(bounds.min, Math.round(v * 100) / 100)) || 1;
	document.body.style.zoom = String(z);
	// 缩放会同步缩小 100vh 布局高度，这里按 1/z 补偿容器高度，使缩放后内容正好撑满视口、不留空白带
	const shell = document.querySelector('.app-shell'); if (shell) shell.style.height = `calc(100vh / ${z})`;
	const ws = document.querySelector('.workspace'); if (ws) ws.style.height = `calc(100vh / ${z} - 4.5rem)`;
	const inv = 1 / z;
	const vw = document.documentElement.clientWidth || window.innerWidth;
	// 允许的最大视觉宽度：留 4% 余量，任何情况都不横向溢出
	const limit = vw * 0.96;
	// 底部工具条：始终反向缩放（PC 手动缩放时控件本身保持视觉大小不变），
	// 移动端再兜一层——余额条 + 按钮加起来再宽也等比缩进视口内。
	const ctl = $('#page-zoom-ctl');
	if (ctl) {
		ctl.style.maxWidth = mobile ? 'none' : '';
		fitOverlay(ctl, inv, mobile ? limit : Infinity);
	}
	// toast：在 .app-shell 之外但仍处于 body 内，会被整页缩放一起缩小到看不清。
	// 移动端反向缩放抵消并限宽；PC 端清空，保持原有表现。
	// 移动端余额条（#mobileBalance）在 #page-zoom-ctl 内部，共用 ctl 的反向 zoom，无需单独处理。
	const toast = $('#toastRoot');
	if (toast) {
		if (mobile) fitOverlay(toast, inv, limit);
		else { toast.style.zoom = ''; toast.style.maxWidth = ''; }
	}
	// 全屏覆盖层（兑换弹框 / 确认弹框 / 图片全屏 / 历史面板）：position:fixed + inset:0 在 body zoom 下会把
	// 宽度解析成「视口 / zoom」（320px 屏上量出来 1185px），grid 居中随之整体偏到屏幕外。
	// 反向缩放后内部坐标恢复成视觉像素，居中才正确，弹框也不会超宽。
	['#redeemMask', '#modalRoot', '#imageLightbox', '#historyDrawer'].forEach(sel => {
		const el = $(sel); if (!el) return;
		el.style.zoom = mobile ? String(+inv.toFixed(4)) : '';
	});
	// 标签始终反映真实缩放值；silent 只影响是否写 localStorage（不覆盖用户手动设置）
	const label = $('#pz-val'); if (label) label.textContent = Math.round(z * 100) + '%';
	if (!opts.silent) localStorage.setItem(PAGE_ZOOM_KEY, String(z));
	// body zoom 会放大标题，重新按视口折算字号，保证标题始终单行不超屏
	fitStageHeading();
	return z;
}
function getPageZoom() { const v = parseFloat(localStorage.getItem(PAGE_ZOOM_KEY) || '1'); return isNaN(v) ? 1 : v; }
// 当前实际生效的缩放值（可能是移动端自动适配出来的），缩放控件在此基础上加减
function currentZoom() { return parseFloat(document.body.style.zoom) || 1; }
// 移动端自动适配是"静默"的（不写 localStorage），用户一按缩放控件就切换为手动模式
$('#pz-dec')?.addEventListener('click', () => applyPageZoom(currentZoom() - 0.05));
$('#pz-inc')?.addEventListener('click', () => applyPageZoom(currentZoom() + 0.05));
$('#pz-val')?.addEventListener('click', () => applyPageZoom(1));
// 重置画布位置 / 整理排版：只作用于画布内容，不动页面缩放
$('#pz-reset')?.addEventListener('click', () => resetCanvasView());
$('#pz-tidy')?.addEventListener('click', () => tidyCanvas());
// 移动端优先：整页自动等比缩放以适配窄屏；PC 端沿用用户手动保存的缩放值
applyPageZoom(isMobileViewport() ? fitMobileZoom() : getPageZoom(), { silent: isMobileViewport() });
// 画布落盘是防抖的，页面被隐藏或卸载时把待写的快照立刻补上，避免丢最后一步操作
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushCanvasPersist(); });
window.addEventListener('pagehide', flushCanvasPersist);
/* ---------- 输入框拖入/粘贴图片：自动切图生图并加入参考图 ---------- */
function getPromptText() { const editor = $('#prompt'); return editor ? editor.innerText.replace(/\u200B/g, '') : ''; }
function setPromptContent(text) {
	// 恢复提示词：纯文本写入，@参考图N 自动转为原子 chip
	const editor = $('#prompt'); if (!editor) return;
	editor.innerHTML = '';
	String(text || '').split(/(@参考图\d+)/g).forEach(part => {
		if (!part) return;
		if (/^@参考图\d+$/.test(part)) editor.insertAdjacentHTML('beforeend', `<span class="mention-chip" contenteditable="false">${escapeHtml(part)}</span>`);
		else editor.appendChild(document.createTextNode(part));
	});
}
// 点击预览缩略图：把对应 @ 标记追加到输入框（输入框内有光标则在光标处，无光标则在末尾）
function appendRefToken(seq) { insertRefTokens(seq - 1, 1); }
// 删除参考图：移除输入框中对应的 @ chip，并把后续 chip 编号依次前移（保持一对一对应）
function removeRefMention(fileIndex) {
	// 删除对应图后：仅移除该图的 @chip，并前移后续编号；其它 @ 引用与文字原位保留
	const target = fileIndex + 1;
	state.files.forEach((f, i) => { refSeqMap.set(f, i + 1); });
	refSeqCursor = state.files.length;
	const editor = $('#prompt'); if (!editor) return;
	editor.querySelectorAll('.mention-chip').forEach(chip => {
		const m = chip.textContent.match(/@参考图(\d+)/); const n = m ? Number(m[1]) : 0;
		if (n === target) chip.remove();
		else if (n > target) chip.textContent = '@参考图' + (n - 1);
	});
}
function makeChip(text) { return `<span class="mention-chip" contenteditable="false">${escapeHtml(text)}</span>&#8203;`; }
function insertRefTokens(startIndex, count, appendToEnd = false) {
	// 手动添加的参考图：在输入框光标处插入原子 chip（整体编辑/删除，带颜色标识）；appendToEnd 时直接追加到末尾
	const editor = $('#prompt');
	if (!editor || count <= 0) return;
	editor.focus();
	const sel = window.getSelection();
	let range = (sel && sel.rangeCount) ? sel.getRangeAt(0) : null;
	if (appendToEnd || !range || !editor.contains(range.commonAncestorContainer)) {
		range = document.createRange();
		range.selectNodeContents(editor);
		range.collapse(false); // 追加/无有效光标时插到末尾
	}
	range.deleteContents();
	const frag = range.createContextualFragment(
		Array.from({ length: count }, (_, i) => makeChip(`@参考图${startIndex + i + 1}`)).join('') + '&#8203;'
	);
	const lastNode = frag.lastChild;
	range.insertNode(frag);
	if (lastNode) { range.setStartAfter(lastNode); range.collapse(true); }
	sel?.removeAllRanges(); sel?.addRange(range);
	editor.dispatchEvent(new Event('input', { bubbles: true }));
}
function addDockReferenceFiles(files) {
	const images = [...files].filter(file => ALLOWED_IMAGE_TYPES.has(file.type));
	if (!images.length) return;
	if (state.files.length >= 8) { showToast('参考图已达上限 8 张', 'warn'); return; }
	const added = images.slice(0, 8 - state.files.length);
	state.files = [...state.files, ...added].slice(0, 8);
	state.mode = 'reference';
	persistActiveSettings({ mode: 'reference' });
	$$('.mode').forEach(button => button.classList.toggle('active', button.dataset.mode === 'reference'));
	$('#referenceBox')?.classList.add('open');
	added.forEach(f => appendRefChip(refSeq(f)));
	renderPreviews(); update();
}
(function initDockImageDrop() {
	const dockEl = $('#promptDock');
	if (!dockEl) return;
	let dragDepth = 0;
	dockEl.addEventListener('dragenter', event => {
		if (event.dataTransfer?.types.includes('application/x-preview-reorder')) return;
		if (!event.dataTransfer?.types.includes('Files')) return;
		dragDepth++; dockEl.classList.add('drag-over');
	});
	dockEl.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dockEl.classList.remove('drag-over'); });
	dockEl.addEventListener('dragover', event => {
		if (event.dataTransfer?.types.includes('application/x-preview-reorder')) return;
		if (!event.dataTransfer?.types.includes('Files')) return;
		event.preventDefault();
	});
	dockEl.addEventListener('drop', event => {
		dragDepth = 0; dockEl.classList.remove('drag-over');
		if (event.dataTransfer?.types.includes('application/x-preview-reorder')) return; // 排序拖拽不当作外部文件
		if (!event.dataTransfer?.types.includes('Files')) return;
		event.preventDefault(); event.stopPropagation();
		addDockReferenceFiles(event.dataTransfer.files || []);
	});
})();
$('#prompt')?.addEventListener('paste', event => {
	const images = [...(event.clipboardData?.files || [])].filter(file => ALLOWED_IMAGE_TYPES.has(file.type));
	event.preventDefault();
	if (images.length) { addDockReferenceFiles(images); return; }
	const text = event.clipboardData?.getData('text/plain');
	if (text) document.execCommand('insertText', false, text);
});

