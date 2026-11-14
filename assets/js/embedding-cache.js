// 向量缓存：同一段文本 + 同一个模型，只付一次 embedding 的钱。
// 换 API 站、换 Key、把模型切回来，都不应该重新算一遍。
//
// 独立库 RPHubEmbeddingCache，不碰主库 RPHubDB —— 改主库版本会触发 upgrade，
// 而应用此刻正持有连接，风险不值得冒。
(function () {
    const DB_NAME = 'RPHubEmbeddingCache';
    const DB_VERSION = 1;
    const STORE = 'vectors';
    const MAX_ENTRIES = 6000;
    // 反量化后按 float 用；量化存储把 768 维从 3KB 压到 768B
    const QUANT_SCALE = 127;

    let dbPromise = null;
    let disabled = false;

    const fnv1a = (text) => {
        let hash = 0x811c9dc5;
        const source = String(text || '');
        for (let i = 0; i < source.length; i += 1) {
            hash ^= source.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193) >>> 0;
        }
        return hash.toString(36);
    };

    // key 里带模型指纹和文本长度：模型换一份缓存、文本撞 hash 也能二次区分
    const buildKey = (model, text) => `e${fnv1a(model)}.${fnv1a(text)}.${String(text || '').length.toString(36)}`;

    const openDB = () => {
        if (disabled) return Promise.resolve(null);
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve) => {
            let request;
            try {
                request = indexedDB.open(DB_NAME, DB_VERSION);
            } catch (_) {
                disabled = true;
                resolve(null);
                return;
            }
            request.onupgradeneeded = (event) => {
                const database = event.target.result;
                if (!database.objectStoreNames.contains(STORE)) {
                    const store = database.createObjectStore(STORE, { keyPath: 'key' });
                    store.createIndex('at', 'at');
                }
            };
            request.onsuccess = (event) => resolve(event.target.result);
            request.onerror = () => { disabled = true; resolve(null); };
            request.onblocked = () => { disabled = true; resolve(null); };
        });
        return dbPromise;
    };

    const withStore = async (mode, worker) => {
        const database = await openDB();
        if (!database) return null;
        return new Promise((resolve) => {
            let transaction;
            try {
                transaction = database.transaction(STORE, mode);
            } catch (_) {
                resolve(null);
                return;
            }
            const store = transaction.objectStore(STORE);
            let result = null;
            try {
                result = worker(store);
            } catch (_) {
                resolve(null);
                return;
            }
            transaction.oncomplete = () => resolve(result && result.__request ? result.__value : result);
            transaction.onerror = () => resolve(null);
            transaction.onabort = () => resolve(null);
        });
    };

    const quantize = (vector) => {
        if (!Array.isArray(vector) || !vector.length) return null;
        let maxAbs = 0;
        for (let i = 0; i < vector.length; i += 1) {
            const value = Math.abs(Number(vector[i]) || 0);
            if (value > maxAbs) maxAbs = value;
        }
        if (!(maxAbs > 0)) return null;
        const bytes = new Int8Array(vector.length);
        for (let i = 0; i < vector.length; i += 1) {
            const scaled = Math.round(((Number(vector[i]) || 0) / maxAbs) * QUANT_SCALE);
            bytes[i] = Math.max(-QUANT_SCALE, Math.min(QUANT_SCALE, scaled));
        }
        return { bytes, scale: maxAbs / QUANT_SCALE };
    };

    const dequantize = (bytes, scale) => {
        if (!bytes || !bytes.length) return [];
        const out = new Array(bytes.length);
        for (let i = 0; i < bytes.length; i += 1) out[i] = bytes[i] * scale;
        return out;
    };

    // 取出命中的条目：返回 Map<inputIndex, float 向量>
    const lookup = async (model, texts) => {
        const hits = new Map();
        if (!model || !Array.isArray(texts) || !texts.length) return hits;
        const keys = texts.map(text => buildKey(model, text));
        const rows = await withStore('readonly', (store) => {
            const collected = new Map();
            let pending = keys.length;
            keys.forEach((key, index) => {
                const request = store.get(key);
                request.onsuccess = () => {
                    const record = request.result;
                    if (record && record.model === model && record.q && record.q.length) {
                        collected.set(index, dequantize(record.q, record.scale));
                    }
                    pending -= 1;
                    if (pending === 0) collected.__done = true;
                };
                request.onerror = () => { pending -= 1; };
            });
            return collected;
        });
        if (rows instanceof Map) rows.forEach((value, index) => hits.set(index, value));
        return hits;
    };

    // 写入缓存。不 await、不阻塞主流程，失败就当没缓存。
    const store = (model, texts, vectors) => {
        if (!model || !Array.isArray(texts) || !Array.isArray(vectors) || texts.length !== vectors.length) return;
        const at = Date.now();
        const records = [];
        texts.forEach((text, index) => {
            const packed = quantize(vectors[index]);
            if (!packed) return;
            records.push({
                key: buildKey(model, text),
                model,
                dims: packed.bytes.length,
                q: packed.bytes,
                scale: packed.scale,
                at
            });
        });
        if (!records.length) return;
        withStore('readwrite', (objectStore) => {
            records.forEach(record => objectStore.put(record));
        }).then(() => prune()).catch(() => { /* 缓存失败不影响功能 */ });
    };

    // 超上限就按写入时间淘汰一半，避免无限长胖
    const prune = async () => {
        const count = await withStore('readonly', (objectStore) => {
            const request = objectStore.count();
            const holder = { __request: true, __value: 0 };
            request.onsuccess = () => { holder.__value = request.result; };
            return holder;
        });
        if (!Number.isFinite(count) || count <= MAX_ENTRIES) return;
        const dropTarget = Math.ceil(count - MAX_ENTRIES * 0.5);
        await withStore('readwrite', (objectStore) => {
            let removed = 0;
            const cursorRequest = objectStore.index('at').openCursor();
            cursorRequest.onsuccess = () => {
                const cursor = cursorRequest.result;
                if (!cursor || removed >= dropTarget) return;
                cursor.delete();
                removed += 1;
                cursor.continue();
            };
        });
    };

    const stats = async () => {
        const info = await withStore('readonly', (objectStore) => {
            const holder = { __request: true, __value: { count: 0, bytes: 0 } };
            const cursorRequest = objectStore.openCursor();
            let count = 0;
            let bytes = 0;
            cursorRequest.onsuccess = () => {
                const cursor = cursorRequest.result;
                if (!cursor) {
                    holder.__value = { count, bytes };
                    return;
                }
                const record = cursor.value;
                count += 1;
                bytes += (record.q && record.q.length ? record.q.length : 0) + 64;
                cursor.continue();
            };
            return holder;
        });
        return info || { count: 0, bytes: 0 };
    };

    const clear = async () => {
        await withStore('readwrite', (objectStore) => {
            objectStore.clear();
        });
    };

    window.RPHubEmbeddingCache = {
        lookup,
        store,
        stats,
        clear,
        __buildKey: buildKey,
        __MAX_ENTRIES: MAX_ENTRIES
    };
})();
