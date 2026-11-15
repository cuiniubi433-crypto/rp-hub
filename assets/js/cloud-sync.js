// 云同步：把整个本地数据库打成快照，同步到「平台云」或「自己的 GitHub 私有 Gist」。
// 平台云：登录一次，同一账号在任意设备打开网址就能接着玩（同域数据面，走 WorkBuddy 云服务）。
// GitHub：端到端加密后存私有 Gist，只有密文，作者本人没有同步密码也读不回来。
(function () {
    const { reactive } = Vue;
    const branchUtils = window.RPHubStoryBranches;
    const storage = () => window.RPHubStorage;

    const GIST_API = 'https://api.github.com';
    const CONFIG_KEY = 'rphub_cloud_sync_config';
    const FILE_PREFIX = 'rphub-sync-';
    const PBKDF2_ITERATIONS = 210000;
    const SNAPSHOT_VERSION = 1;
    const MAX_PAYLOAD_BYTES = 9 * 1024 * 1024;
    // 单行塞不下的聊天包按片切，每片目标 1MB 明文。
    // 密文要再过 base64（+33%），按最坏情况算每片请求也就 1.4MB，远低于网关上限。
    const VAULT_PART_BYTES = 1 * 1024 * 1024;
    const CLOUD_TABLE = 'rphub_snapshots';
    // 发起登录时记下用的是哪种方式：中继回调不一定把 provider 带回来
    const OAUTH_PENDING_KEY = 'rphub_oauth_pending';
    // 已经拿去换过会话的 code，防止刷新页面反复重试一个失效 code
    const OAUTH_USED_KEY = 'rphub_oauth_used_codes';

    // 平台云公开配置（开通云服务时由平台返回的 publicConfig，可安全放在前端）
    const PUBLIC_CLOUD = {
        endpoint: 'https://rphub-multiapi.app.workbuddy.host',
        oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
        publishableKey: 'wbpk_igYY7KDIoCurKlVQOL2p4n_bVBhSFeUym5FOwYW36PBk23kSEIJl3si'
    };
    const CLOUD_HOST_OK = (() => {
        try {
            if (location.protocol === 'https:' && /(^|\.)app\.workbuddy\.host$/.test(location.hostname)) return true;
        } catch (_) { /* 忽略 */ }
        // 仅用于自动化测试时绕过域名判定；线上仍以真实域名为准
        return window.__rphubCloudForce === true;
    })();

    // 同步分成两包：聊天与角色 / 设置与预设。
    // 换手机只想带设置、或者只想搬聊天记录的时候，不必整包覆盖对方。
    const GROUP_KEYS = {
        chat: ['characters', 'last_active_char', 'active_profile_id'],
        settings: [
            'active_tools', 'global_regex', 'global_ui_templates', 'global_worldinfo',
            'memory_settings', 'presets', 'regex', 'settings', 'user', 'user_profiles',
            'worldinfo', 'worldinfo_settings', 'world_sim'
        ]
    };
    const SYNC_GROUPS = ['chat', 'settings'];
    const GROUP_LABEL = { chat: '聊天与角色', settings: '设置与预设', all: '全部数据' };
    // 全局键；作用域键（chat / classic_memories / branches）按角色与分支单独收集
    const GLOBAL_KEYS = [...GROUP_KEYS.chat, ...GROUP_KEYS.settings];
    const SCOPED_NAMES = ['chat', 'classic_memories', 'branches'];

    // 同步码保管箱：不需要登录，码本身就是密钥。
    // 表里存的是密文，没有码的人即使把整张表读下来也解不开。
    const VAULT_TABLE = 'rphub_vault';
    const VAULT_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // 去掉 0/O/1/I/L，免得电话里念错
    const VAULT_PREFIX = 'RPH';

    const blankGroupStatus = () => ({
        hasRemote: false, updatedAt: 0, device: '', keyCount: 0, size: 0,
        at: 0, direction: '', error: '', dirty: false
    });

    const state = reactive({
        provider: 'vault',            // vault | cloud | gist
        providerTab: 'vault',         // UI 上当前查看的通道
        // 分组状态：每包各自显示「云端有没有、多新、来自哪台设备」
        groups: { chat: blankGroupStatus(), settings: blankGroupStatus() },
        scope: { chat: true, settings: true },  // 这个通道要同步哪几包
        vaultCode: '',
        vaultConfigured: false,
        vaultInput: '',
        vaultShowCode: false,
        cloudAvailable: CLOUD_HOST_OK,
        cloudSignedIn: false,
        cloudUserName: '',
        cloudAvatar: '',
        cloudUpdatedAt: 0,
        cloudDevice: '',
        cloudKeyCount: 0,
        cloudHasRemote: false,
        cloudLoading: false,
        configured: false,            // 仅 GitHub 通道使用
        busy: false,
        progress: { label: '', percent: 0, detail: '' },
        tokenInput: '',
        passwordInput: '',
        confirmInput: '',
        codeInput: '',
        syncCode: '',
        gistId: '',
        gistUrl: '',
        autoInterval: 0,
        syncOnHide: true,
        lastSyncAt: 0,
        lastSyncDirection: '',
        deviceName: '',
        pendingChanges: false,
        lastSyncError: '',
        remote: { updatedAt: 0, device: '', keyCount: 0, size: 0 },
        message: { type: '', text: '' }
    });

    const setMessage = (type, text) => { state.message = { type, text }; };
    const currentPassword = () => state.passwordInput || window.__rphubSyncPassword || '';

    // 每包单独记「上次什么时候同步过」，否则只传设置时会把聊天的记录冲掉，
    // 另一台设备再上传就会被误判成「有人覆盖了你」。
    const groupSyncAt = (group) => {
        const config = loadConfig() || {};
        if (group === 'all') return Number(config.lastSyncAt) || 0;
        return Number(config.groupSync?.[group]?.at) || 0;
    };
    const stampGroupSync = (config, group, direction = 'upload') => {
        const at = Date.now();
        if (group === 'all') {
            return { ...config, lastSyncAt: at, lastSyncDirection: direction, groupSync: { ...(config.groupSync || {}), chat: { at, direction }, settings: { at, direction } } };
        }
        return {
            ...config,
            lastSyncAt: at,
            lastSyncDirection: direction,
            groupSync: { ...(config.groupSync || {}), [group]: { at, direction } }
        };
    };
    const markGroup = (group, patch) => {
        const target = state.groups[group];
        if (!target) return;
        Object.assign(target, patch);
        state.pendingChanges = SYNC_GROUPS.some(name => state.groups[name].dirty);
    };

    // ── 本地配置（只存 localStorage，不进快照） ──
    const loadConfig = () => {
        try {
            const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null');
            if (!saved || typeof saved !== 'object') return null;
            return saved;
        } catch (_) { return null; }
    };
    const saveConfig = (config) => {
        localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
        applyConfig(config);
    };
    const applyConfig = (config) => {
        const hasVault = !!config?.vaultCode;
        const provider = config?.provider === 'gist' || config?.gistId
            ? 'gist'
            : (config?.provider === 'cloud' || config?.cloudUserId ? 'cloud' : (hasVault ? 'vault' : 'vault'));
        state.provider = provider;
        state.configured = provider === 'gist'
            ? !!(config?.token && config?.gistId)
            : (provider === 'vault' ? hasVault : !!config?.cloudUserId);
        state.vaultCode = config?.vaultCode || '';
        state.vaultConfigured = hasVault;
        state.scope = {
            chat: config?.scope?.chat !== false,
            settings: config?.scope?.settings !== false
        };
        SYNC_GROUPS.forEach((group) => {
            const saved = config?.groupSync?.[group] || {};
            state.groups[group].at = Number(saved.at) || 0;
            state.groups[group].direction = saved.direction || '';
        });
        state.syncCode = config?.syncCode || '';
        state.gistId = config?.gistId || '';
        state.gistUrl = config?.gistUrl || '';
        state.autoInterval = Number(config?.autoInterval) || 0;
        state.syncOnHide = config?.syncOnHide !== false;
        state.lastSyncAt = Number(config?.lastSyncAt) || 0;
        state.lastSyncDirection = config?.lastSyncDirection || '';
        state.deviceName = config?.deviceName || '';
        // 注意：这里不能重置 pendingChanges。上传成功后会 saveConfig，如果中途用户又发了消息，
        // 那次 markDirty 的标记会被这行吃掉，那几条就永远等不到下一次同步。
        if (provider === 'cloud') state.providerTab = 'cloud';
        else if (provider === 'gist' && config?.token) state.providerTab = 'gist';
        else if (hasVault) state.providerTab = 'vault';
    };

    const makeDeviceName = () => {
        const platform = (navigator.userAgentData?.platform || navigator.platform || 'device').slice(0, 24);
        const suffix = Array.from(crypto.getRandomValues(new Uint8Array(2)))
            .map(byte => byte.toString(36).padStart(2, '0')).join('').slice(0, 3);
        return `${platform}-${suffix}`;
    };
    const ensureDeviceName = () => {
        if (state.deviceName) return state.deviceName;
        const name = makeDeviceName();
        state.deviceName = name;
        const config = loadConfig();
        if (config) saveConfig({ ...config, deviceName: name });
        return name;
    };

    // ── 加密：PBKDF2 派生密钥 + AES-GCM ──
    const deriveKey = (password, salt, iterations) => crypto.subtle.importKey(
        'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']
    ).then(baseKey => crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
        baseKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    ));

    const toBase64 = (bytes) => {
        // 逐字节字符串拼接在几 MB 的数据上会明显卡，按块转
        let binary = '';
        const chunk = 0x8000;
        for (let index = 0; index < bytes.length; index += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
        }
        return btoa(binary);
    };
    const fromBase64 = (text) => Uint8Array.from(atob(text), char => char.charCodeAt(0));

    const gzipBytes = (bytes) => (typeof CompressionStream === 'function'
        ? new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()
        : Promise.resolve(null));
    const gunzipBytes = (bytes) => (typeof DecompressionStream === 'function'
        ? new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
        : Promise.reject(new Error('当前浏览器不支持解压，无法读取云端同步数据')));

    // 分片时每片都要加密，但 PBKDF2 只该算一次：把 salt/key 传给后续各片
    const prepareCipher = async (password) => {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
        return { salt, key };
    };
    const encryptSnapshot = async (snapshot, password, preset = null) => {
        const salt = preset?.salt || crypto.getRandomValues(new Uint8Array(16));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const key = preset?.key || await deriveKey(password, salt, PBKDF2_ITERATIONS);
        const plain = new TextEncoder().encode(JSON.stringify(snapshot));
        const packed = await gzipBytes(plain);
        const cipher = new Uint8Array(await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv }, key, packed || plain
        ));
        return {
            v: SNAPSHOT_VERSION,
            alg: 'AES-GCM-256',
            kdf: 'PBKDF2-SHA256',
            iter: PBKDF2_ITERATIONS,
            compressed: !!packed,
            salt: toBase64(salt),
            iv: toBase64(iv),
            data: toBase64(cipher),
            keys: Array.isArray(snapshot.entries) ? snapshot.entries.length : 0,
            device: snapshot.device || '',
            createdAt: snapshot.createdAt || Date.now()
        };
    };

    const decryptSnapshot = async (envelope, password) => {
        if (!envelope || envelope.alg !== 'AES-GCM-256') throw new Error('云端数据格式不正确');
        const key = await deriveKey(password, fromBase64(envelope.salt), Number(envelope.iter) || PBKDF2_ITERATIONS);
        let plain;
        try {
            plain = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: fromBase64(envelope.iv) }, key, fromBase64(envelope.data)
            );
        } catch (_) {
            throw new Error('同步密码不正确，或云端数据已损坏');
        }
        const bytes = new Uint8Array(plain);
        const text = envelope.compressed ? new TextDecoder().decode(await gunzipBytes(bytes)) : new TextDecoder().decode(bytes);
        return JSON.parse(text);
    };

    // ── 同步码 ──
    // 码 = 身份 + 密钥。12 位，字符集 32 个，够一个人自己用，也够挡住瞎猜。
    const normalizeVaultCode = (raw) => {
        const cleaned = String(raw || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
        return cleaned.startsWith(VAULT_PREFIX) ? cleaned.slice(VAULT_PREFIX.length) : cleaned;
    };
    const formatVaultCode = (normalized) => {
        const body = String(normalized || '');
        return body.length === 12 ? `RPH-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}` : body;
    };
    const makeVaultCode = () => {
        const bytes = crypto.getRandomValues(new Uint8Array(12));
        return Array.from(bytes).map(byte => VAULT_ALPHABET[byte % VAULT_ALPHABET.length]).join('');
    };
    const sha256Hex = async (text) => {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
        return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
    };
    // 表里只存哈希：整张表被人读走，也没法从哈希反推码
    const vaultCodeHash = (normalized) => sha256Hex(`rphub-vault-v1|${normalized}`);
    const vaultPassword = (normalized) => `vault:${normalized}`;

    // ── 快照：整库枚举与回写 ──
    const collectSnapshot = async (onProgress, group = 'all') => {
        const { getStoredValue, getScopedStoredValue } = storage();
        const wantChat = group === 'all' || group === 'chat';
        const wantSettings = group === 'all' || group === 'settings';
        const keys = wantChat && wantSettings
            ? GLOBAL_KEYS
            : (wantSettings ? GROUP_KEYS.settings : GROUP_KEYS.chat);
        const entries = [];
        for (let index = 0; index < keys.length; index += 1) {
            const name = keys[index];
            const value = await getStoredValue(name);
            if (value !== undefined) entries.push({ name, id: null, value });
            onProgress?.(index / (keys.length + 1), `正在读取 ${name}`);
        }
        const owners = [];
        if (wantChat) {
            const characters = (await getStoredValue('characters')) || [];
            for (const character of characters) {
                if (!character?.uuid) continue;
                owners.push(character.uuid);
                const branchesValue = await getScopedStoredValue('branches', character.uuid);
                if (branchesValue !== undefined && branchesValue !== null) {
                    entries.push({ name: 'branches', id: character.uuid, value: branchesValue });
                }
                const branchList = Array.isArray(branchesValue?.branches) && branchesValue.branches.length
                    ? branchesValue.branches
                    : [{ id: branchUtils.STORY_BRANCH_MAIN_ID }];
                for (const branch of branchList) {
                    const scopeId = branchUtils.getStoryBranchScopeId(character.uuid, branch.id);
                    for (const name of SCOPED_NAMES) {
                        if (name === 'branches') continue;
                        const value = await getScopedStoredValue(name, scopeId);
                        if (value !== undefined) entries.push({ name, id: scopeId, value });
                    }
                }
            }
        }
        onProgress?.(1, `共 ${entries.length} 项数据`);
        return {
            v: SNAPSHOT_VERSION,
            group,
            createdAt: Date.now(),
            device: state.deviceName,
            owners,
            entries
        };
    };

    // 聊天记录、角色卡都是「一整条」数组，光按项切根本切不开。
    // 所以数组型的大条目先在元素级别拆开，带 __slice 标记，拼回来时再合成原来那一条。
    const sliceEntries = (entries, limit = VAULT_PART_BYTES) => {
        const out = [];
        entries.forEach((entry) => {
            if (!Array.isArray(entry.value) || !entry.value.length) { out.push(entry); return; }
            if (JSON.stringify(entry).length <= limit) { out.push(entry); return; }
            const buckets = [];
            let bucket = [];
            let size = 0;
            entry.value.forEach((item) => {
                const itemSize = JSON.stringify(item).length + 1;
                if (bucket.length && size + itemSize > limit) {
                    buckets.push(bucket);
                    bucket = [];
                    size = 0;
                }
                bucket.push(item);
                size += itemSize;
            });
            if (bucket.length) buckets.push(bucket);
            if (buckets.length <= 1) { out.push(entry); return; }
            buckets.forEach((items, index) => {
                out.push({ ...entry, __slice: { index, total: buckets.length }, value: items });
            });
        });
        return out;
    };

    // 把 __slice 碎片按序号拼回原来那一条；普通条目原样放回原来的位置。
    const joinSlicedEntries = (entries) => {
        const records = new Map();
        const order = [];
        entries.forEach((entry) => {
            if (!entry || !entry.__slice) { order.push({ entry }); return; }
            const key = `${entry.name}::${entry.id ?? ''}`;
            if (!records.has(key)) {
                records.set(key, { name: entry.name, id: entry.id, buckets: [] });
                order.push({ key });
            }
            records.get(key).buckets[entry.__slice.index] = entry.value;
        });
        const out = [];
        const done = new Set();
        order.forEach((node) => {
            if (node.entry) { out.push(node.entry); return; }
            if (done.has(node.key)) return;
            done.add(node.key);
            const record = records.get(node.key);
            const merged = [];
            record.buckets.forEach((bucket) => {
                if (Array.isArray(bucket)) merged.push(...bucket);
            });
            out.push({ name: record.name, id: record.id, value: merged });
        });
        return out;
    };

    // 拆完数组后，再按「一项数据」为最小单位装片，不跨项切断。
    // 某一项自己就超了目标大小（比如一个巨大的世界书对象），让它独占一片，只要不撞单次上限就行。
    const chunkSnapshot = (snapshot, limit = VAULT_PART_BYTES) => {
        const base = { ...snapshot, entries: [] };
        const emptySize = JSON.stringify(base).length;
        const chunks = [];
        let entries = [];
        let size = emptySize;
        const flush = () => {
            chunks.push({ ...base, entries });
            entries = [];
            size = emptySize;
        };
        (snapshot.entries || []).forEach((entry) => {
            const entrySize = JSON.stringify(entry).length + 1;
            if (entries.length && size + entrySize > limit) flush();
            entries.push(entry);
            size += entrySize;
        });
        if (entries.length || !chunks.length) flush();
        return chunks;
    };

    const applySnapshot = async (snapshot, onProgress, group = 'all') => {
        const { setStoredValue, setScopedStoredValue, setWritesPaused, initDB } = storage();
        if (!Array.isArray(snapshot?.entries)) throw new Error('快照内容为空或已损坏');
        await initDB();
        const keepScoped = new Set(snapshot.entries
            .filter(entry => entry.id !== null && entry.id !== undefined)
            .map(entry => `${entry.name}_${entry.id}`));
        const keepOwners = new Set(Array.isArray(snapshot.owners) ? snapshot.owners : []);

        setWritesPaused(true);
        try {
            let done = 0;
            for (const entry of snapshot.entries) {
                if (entry.id === null || entry.id === undefined) {
                    await setStoredValue(entry.name, entry.value, { clone: false, force: true });
                } else {
                    await setScopedStoredValue(entry.name, entry.id, entry.value, { clone: false, force: true });
                }
                done += 1;
                onProgress?.(done / snapshot.entries.length, `正在写回 ${entry.name}`);
            }
            // 其它设备上被删掉的角色/分支，本地要跟着删，否则恢复后会多出孤儿数据。
            // 只恢复设置包时不能动聊天数据，否则「只同步设置」会把对面板清空。
            if (group === 'settings') return { written: snapshot.entries.length, removed: 0 };
            const { getLegacyDb, getMainDb, getStorageLogicalKey, readStorageKeys } = storage();
            const keys = [...await readStorageKeys(getMainDb()), ...await readStorageKeys(getLegacyDb())];
            const orphans = [];
            new Set(keys.map(getStorageLogicalKey)).forEach((logicalKey) => {
                const name = SCOPED_NAMES.find(item => logicalKey.startsWith(`${item}_`));
                if (!name) return;
                const id = logicalKey.slice(name.length + 1);
                if (keepScoped.has(`${name}_${id}`)) return;
                const owner = branchUtils.getStoryBranchOwnerId(id);
                if (!keepOwners.has(owner)) orphans.push({ name, id });
            });
            const { deleteScopedStoredValue } = storage();
            for (const orphan of orphans) {
                await deleteScopedStoredValue(orphan.name, orphan.id);
            }
            return { written: snapshot.entries.length, removed: orphans.length };
        } finally {
            setWritesPaused(false);
        }
    };

    const runBusy = async (label, task) => {
        // 已经在传就别插队：两路上传会互相覆盖 progress，也浪费流量
        if (state.busy) return null;
        state.busy = true;
        state.progress = { label, percent: 0, detail: '' };
        try {
            return await task((percent, detail) => {
                state.progress = { label, percent: Math.max(0, Math.min(100, percent * 100)), detail: detail || '' };
            });
        } finally {
            state.busy = false;
            state.progress = { label: '', percent: 0, detail: '' };
        }
    };

    // ══════════════════ 平台云 ══════════════════
    const cloudRuntime = { client: null, session: null };

    // SDK 不再挂在 head 里阻塞首屏，第一次真要用云能力时才拉。
    const ensureCloudSdk = async () => {
        const W = window.WorkBuddyCloud;
        if (W && typeof W.createWorkBuddyCloud === 'function') return W;
        if (typeof window.__rphubLoadCloudSdk !== 'function') return null;
        await window.__rphubLoadCloudSdk();
        const loaded = window.WorkBuddyCloud;
        return (loaded && typeof loaded.createWorkBuddyCloud === 'function') ? loaded : null;
    };

    const getClient = () => {
        if (cloudRuntime.client) return cloudRuntime.client;
        const W = window.WorkBuddyCloud;
        if (!W || typeof W.createWorkBuddyCloud !== 'function') {
            throw new Error('云服务组件还没加载，点一下「平台云」按钮会自动加载；也可改用 GitHub 通道');
        }
        if (!CLOUD_HOST_OK) {
            throw new Error('平台云同步只能在线上网址使用（本地文件打开时不支持）');
        }
        cloudRuntime.client = W.createWorkBuddyCloud({
            endpoint: PUBLIC_CLOUD.endpoint,
            oauthRelayBaseUrl: PUBLIC_CLOUD.oauthRelayBaseUrl,
            publishableKey: PUBLIC_CLOUD.publishableKey
        });
        return cloudRuntime.client;
    };

    const syncCloudUser = (session) => {
        cloudRuntime.session = session || null;
        state.cloudSignedIn = !!(session && session.user);
        state.cloudUserName = session?.user?.name || '';
        state.cloudAvatar = session?.user?.avatarUrl || '';
        const config = loadConfig() || {};
        if (session?.user?.id) {
            // 名字和头像一起落到本地配置：下次启动不必等 SDK 下载完就能先把界面点亮
            const next = {
                provider: 'cloud',
                cloudUserId: session.user.id,
                cloudUserName: session.user.name || '',
                cloudAvatar: session.user.avatarUrl || '',
                deviceName: config.deviceName || ensureDeviceName()
            };
            if (config.cloudUserId !== next.cloudUserId
                || config.cloudUserName !== next.cloudUserName
                || config.cloudAvatar !== next.cloudAvatar
                || !config.deviceName) {
                saveConfig({ ...config, ...next });
            }
            state.provider = 'cloud';
            state.configured = true;
        } else {
            state.cloudSignedIn = false;
            // 真的没有会话才清掉登录痕迹；网络失败走不到这里，避免抖动一次就被当成退出登录
            if (config.provider === 'cloud' && config.cloudUserId) {
                saveConfig({ ...config, cloudUserId: '', cloudUserName: '', cloudAvatar: '' });
                state.configured = false;
            }
        }
    };

    // 启动瞬间先用本地缓存把「已登录」显示出来，别让人盯着未登录界面等 SDK
    const applyCachedCloudUser = () => {
        const config = loadConfig();
        if (!config?.cloudUserId) return false;
        state.cloudSignedIn = true;
        state.cloudUserName = config.cloudUserName || '';
        state.cloudAvatar = config.cloudAvatar || '';
        state.provider = 'cloud';
        state.configured = true;
        return true;
    };

    const cloudRestoreSession = async () => {
        if (!CLOUD_HOST_OK) return null;
        try {
            // SDK 是按需加载的，启动这个时间点它一定还没到。
            // 以前直接 getClient() 会抛错，被 catch 吞掉，表现就是「重启一次就显示未登录」。
            const sdk = await ensureCloudSdk();
            if (!sdk) return null;
            const cloud = getClient();
            const { data } = await cloud.auth.getSession();
            syncCloudUser(data);
            return data || null;
        } catch (_) {
            // 网络问题不应该让人退出登录：保持当前（可能是缓存来的）状态
            return null;
        }
    };

    const cloudSignIn = async (provider) => {
        state.message = { type: '', text: '正在加载登录组件…' };
        try {
            // 首次点登录才去拉 SDK，之后走缓存
            const ready = await ensureCloudSdk();
            if (!ready) {
                setMessage('error', '登录组件加载失败，检查网络后再试，或改用 GitHub 通道');
                return;
            }
            state.message = { type: '', text: '' };
            const cloud = getClient();
            const back = new URL(location.href);
            back.pathname = '/';
            ['code', 'state', 'provider'].forEach(key => back.searchParams.delete(key));
            // 记下这次用的是哪种登录方式。中继把 code 送回来时不保证带 provider，
            // 只靠地址栏判断会让「扫码回来什么都没发生」。
            try { localStorage.setItem(OAUTH_PENDING_KEY, provider); } catch (_) { /* 无痕模式忽略 */ }
            const { data, error } = await cloud.auth.signInWithOAuth({
                provider,
                redirectTo: back.toString()
            });
            if (error) {
                setMessage('error', formatAuthError(error, provider));
                return;
            }
            if (!data?.url) {
                setMessage('error', '登录服务没有返回跳转地址，请稍后重试');
                return;
            }
            // 微信内置浏览器扫不了自己屏幕上的二维码，先把话说明白
            if (provider === 'wechat' && /MicroMessenger/i.test(navigator.userAgent || '')) {
                state.message = { type: 'info', text: '若页面只有一张二维码：长按识别即可，或点右上角「…」在浏览器中打开' };
            }
            location.assign(data.url);
        } catch (error) {
            setMessage('error', error.message || '登录失败');
        }
    };

    const formatAuthError = (error, provider) => {
        const text = String(error?.message || error || '登录失败');
        if (text.includes('未打开')) {
            return provider === 'wechat'
                ? '这个应用还没打开微信登录，请换「WorkBuddy 账号登录」再试'
                : '这个应用还没打开 WorkBuddy 登录，请换「微信扫码登录」再试';
        }
        // 中继对过期/已用过的 code 一律回 401，原文「微信登录失败，请重新尝试」
        // 看不出该做什么，等于把人卡在原地。
        if (provider === 'wechat' && (Number(error?.status) === 401 || /微信登录失败/.test(text))) {
            return '微信没完成授权：二维码可能已过期（5 分钟内有效），或这次扫码已经在别处用过。点「微信登录」重新扫一次';
        }
        if (/PKCE|sessionStorage/i.test(text)) {
            return '登录状态没法存在这台设备上（浏览器禁用了会话存储）。关掉无痕模式，或在同一标签页里重新登录';
        }
        if (/requires state/.test(text)) {
            return '回调缺少校验参数，通常是授权链接被截断。重新点一次登录';
        }
        return text;
    };

    // 把 code/state/provider 从地址栏摘掉，但保留 sharecode
    const cleanAuthParams = () => {
        const url = new URL(location.href);
        ['code', 'state', 'provider'].forEach(key => url.searchParams.delete(key));
        history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    };

    // 登录结果要让人一眼看见：设置页深处那一行字，扫码回来的人不会去看
    const reportAuth = (type, text) => {
        setMessage(type, text);
        try {
            if (typeof window.__rphubToast === 'function') {
                window.__rphubToast(text, type, type === 'error' ? 8000 : 5000);
            } else {
                // app.js 还没挂载，等它起来自己取
                window.__rphubPendingToast = { type, text };
            }
        } catch (_) { /* 忽略 */ }
    };

    const readUsedCodes = () => {
        try {
            const list = JSON.parse(sessionStorage.getItem(OAUTH_USED_KEY) || '[]');
            return Array.isArray(list) ? list.filter(item => typeof item === 'string') : [];
        } catch (_) { return []; }
    };

    const markCodeUsed = (code) => {
        if (!code) return;
        try {
            const list = readUsedCodes();
            list.push(code);
            sessionStorage.setItem(OAUTH_USED_KEY, JSON.stringify(list.slice(-10)));
        } catch (_) { /* 无痕模式忽略 */ }
    };

    // OAuth 回调：必须在任何路由/守卫之前处理，成功后清掉 code/state/provider
    const cloudHandleCallback = async () => {
        if (!CLOUD_HOST_OK) return false;
        const url = new URL(location.href);
        if (!url.searchParams.has('code') && !url.searchParams.has('error')) return false;
        let pendingProvider = '';
        try { pendingProvider = localStorage.getItem(OAUTH_PENDING_KEY) || ''; } catch (_) { /* 忽略 */ }
        // 中继不一定把 provider 带回来；缺了就用发起登录时记下的那个
        const provider = url.searchParams.get('provider') || pendingProvider;
        if (provider !== 'workbuddy' && provider !== 'wechat') return false;

        const code = url.searchParams.get('code') || '';
        // 一个 code 只换一次会话。刷新页面时再拿它去换必然 401，
        // 屏幕上就一直挂着「登录失败」，看着像登录功能坏了。
        if (code && readUsedCodes().includes(code)) {
            cleanAuthParams();
            reportAuth('info', '这次扫码已经处理过了。如果还没登上，重新点一次登录');
            return false;
        }

        state.cloudLoading = true;
        try {
            // 回调这一页是全新加载，按需加载的 SDK 此刻一定还没到。
            // 以前这里直接 getClient()，每次必抛「组件还没加载」，
            // 于是扫码回来永远登不上——微信和 WorkBuddy 两条路都是这样。
            const sdk = await ensureCloudSdk();
            if (!sdk) {
                // 组件没下来时先别清地址，刷新一下还能重试
                reportAuth('error', '登录组件没能加载（可能是网络或 CDN 被拦），检查网络后刷新本页重试');
                return false;
            }
            const cloud = getClient();
            const handler = provider === 'workbuddy' ? cloud.auth.handleWorkBuddyCallback : cloud.auth.handleWechatWebCallback;
            if (typeof handler !== 'function') {
                reportAuth('error', '当前环境不支持这种登录方式，请换一种再试');
                cleanAuthParams();
                return false;
            }
            const { data: session, error } = await handler.call(cloud.auth);
            // 走到这里中继已经给过明确答复：这个 code 不论成败都作废，别留在地址里反复重试
            markCodeUsed(code);
            cleanAuthParams();
            if (error) {
                reportAuth('error', formatAuthError(error, provider));
                return false;
            }
            if (!session) return false;
            try { localStorage.removeItem(OAUTH_PENDING_KEY); } catch (_) { /* 忽略 */ }
            syncCloudUser(session);
            reportAuth('success', `已登录${state.cloudUserName ? '：' + state.cloudUserName : ''}，正在检查云端数据…`);
            await afterCloudSignIn({ auto: true });
            return true;
        } catch (error) {
            reportAuth('error', error.message || '登录回调处理失败');
            cleanAuthParams();
            return false;
        } finally {
            state.cloudLoading = false;
        }
    };

    const fetchCloudRow = async () => {
        const cloud = getClient();
        const { data, error } = await cloud.database
            .from(CLOUD_TABLE)
            .select('id, payload, device, key_count, updated_at')
            .order('updated_at', { ascending: false })
            .limit(1);
        if (error) {
            if (error.code === '42P01') throw new Error('云端同步表还没建好，请稍后重试');
            if (error.code === '42501') throw new Error('没有权限读写云端同步数据，请重新登录');
            throw new Error(`读取云端数据失败：${error.message || error.code || '未知错误'}`);
        }
        const row = Array.isArray(data) && data.length ? data[0] : null;
        if (!row) {
            state.cloudHasRemote = false;
            state.cloudUpdatedAt = 0;
            state.cloudDevice = '';
            state.cloudKeyCount = 0;
            return null;
        }
        state.cloudHasRemote = true;
        state.cloudUpdatedAt = Date.parse(row.updated_at) || 0;
        state.cloudDevice = row.device || '';
        state.cloudKeyCount = Number(row.key_count) || 0;
        refreshGroupStatusFromRow(row);
        return row;
    };

    // 云端 payload 现在是一个分组容器：{ v:2, groups:{ chat:信封, settings:信封 } }
    // 老数据是一整个信封，读的时候当成「全部数据」处理。
    const cloudGroupsOf = (row) => {
        const payload = row?.payload;
        if (!payload || typeof payload !== 'object') return {};
        if (payload.v === 2 && payload.groups && typeof payload.groups === 'object') return { ...payload.groups };
        if (payload.alg || payload.snapshot) return { all: payload };
        return {};
    };
    const fillGroupStatus = (group, envelope, row) => {
        const status = state.groups[group];
        if (!status) return;
        status.hasRemote = !!envelope;
        status.updatedAt = envelope
            ? (Date.parse(envelope.uploadedAt) || Date.parse(row?.updated_at) || 0)
            : 0;
        status.device = envelope?.device || row?.device || '';
        status.keyCount = Number(envelope?.keys) || 0;
        status.size = envelope?.size || 0;
    };
    const refreshGroupStatusFromRow = (row) => {
        const groups = cloudGroupsOf(row);
        SYNC_GROUPS.forEach(group => fillGroupStatus(group, groups[group] || groups.all, row));
    };

    const writeCloudRow = async (envelope, snapshot, group = 'all') => {
        const cloud = getClient();
        const existing = await fetchCloudRow();
        const groups = cloudGroupsOf(existing);
        if (group === 'all') {
            Object.keys(groups).forEach(key => delete groups[key]);
            groups.all = envelope;
        } else {
            delete groups.all;
            groups[group] = envelope;
        }
        const nextPayload = { v: 2, groups };
        const payloadText = JSON.stringify(nextPayload);
        if (payloadText.length > MAX_PAYLOAD_BYTES) {
            throw new Error(`同步数据有 ${(payloadText.length / 1024 / 1024).toFixed(1)}MB，超过这一通道的单次上限。换成「同步码」通道可以自动分片上传，不用清理聊天记录`);
        }
        const body = {
            payload: nextPayload,
            device: state.deviceName,
            key_count: Object.values(groups).reduce((sum, env) => sum + (Number(env?.keys) || 0), 0),
            updated_at: new Date().toISOString()
        };
        const row = existing;
        if (row?.id) {
            const { data, error } = await cloud.database.from(CLOUD_TABLE).update(body).eq('id', row.id).select('id');
            if (error) throw new Error(`上传失败：${error.message || error.code}`);
            if (!Array.isArray(data) || !data.length) throw new Error('上传被拒绝（云端数据不属于当前账号）');
        } else {
            const { error } = await cloud.database.from(CLOUD_TABLE).insert(body).select('id');
            if (error) {
                if (error.code === '23505') {
                    // 并发下另一个标签页刚插入，退化成更新
                    const retry = await fetchCloudRow();
                    if (retry?.id) {
                        const { error: updateError } = await cloud.database.from(CLOUD_TABLE).update(body).eq('id', retry.id);
                        if (updateError) throw new Error(`上传失败：${updateError.message || updateError.code}`);
                        return;
                    }
                }
                throw new Error(`上传失败：${error.message || error.code}`);
            }
        }
    };

    const buildEnvelope = async (snapshot) => {
        const password = currentPassword();
        if (password) return encryptSnapshot(snapshot, password);
        // 平台云不走 Git，数据存在当前登录账号名下，RLS 已做账号隔离。
        // 但原文 JSON 里角色卡头像是大头，先 gzip 再存：几 MB 通常能压到几分之一，
        // 上传慢、传不完的问题大半出在这里。
        const plain = new TextEncoder().encode(JSON.stringify(snapshot));
        const packed = await gzipBytes(plain);
        const base = {
            v: SNAPSHOT_VERSION,
            keys: Array.isArray(snapshot.entries) ? snapshot.entries.length : 0,
            device: snapshot.device || '',
            createdAt: snapshot.createdAt || Date.now()
        };
        if (!packed) return { ...base, alg: 'none', snapshot };
        return { ...base, alg: 'gzip', compressed: true, data: toBase64(new Uint8Array(packed)) };
    };

    const openEnvelope = async (envelope) => {
        if (!envelope) throw new Error('云端还没有同步数据');
        if (envelope.alg === 'none') {
            if (!envelope.snapshot) throw new Error('云端数据不完整');
            return envelope.snapshot;
        }
        // 无密码通道现在也会压一层；老数据仍是 alg:'none'，两条路都留着
        if (envelope.alg === 'gzip') {
            if (!envelope.data) throw new Error('云端数据不完整');
            const unpacked = await gunzipBytes(fromBase64(envelope.data));
            return JSON.parse(new TextDecoder().decode(unpacked));
        }
        const password = currentPassword();
        if (!password) throw new Error('这份云端数据设了同步密码，请先在上面的输入框填入密码');
        return decryptSnapshot(envelope, password);
    };

    const cloudUpload = async ({ silent = false, group = 'all' } = {}) => {
        if (!state.cloudSignedIn) throw new Error('请先登录再上传');
        state.lastSyncError = '';
        let uploaded = null;
        const label = group === 'all' ? '正在上传' : `正在上传 ${GROUP_LABEL[group]}`;
        try {
            uploaded = await runBusy(label, async (report) => {
                if (!state.cloudSignedIn) throw new Error('请先登录再上传');
                const snapshot = await collectSnapshot(report, group);
                if (!snapshot.entries.length) throw new Error('本地没有任何数据可同步');
                const envelope = await buildEnvelope(snapshot);
                envelope.device = state.deviceName;
                envelope.group = group;
                envelope.uploadedAt = new Date().toISOString();
                envelope.size = JSON.stringify(envelope).length;

                // 另一台设备在这一包上次同步之后传过，先拦一次，避免无声覆盖那边的进度
                const proceedDespiteRemote = overwriteApproved;
                overwriteApproved = false;
                if (!proceedDespiteRemote) {
                    const row = await fetchCloudRow();
                    const remoteEnvelope = cloudGroupsOf(row)[group] || cloudGroupsOf(row).all;
                    const remoteAt = Date.parse(remoteEnvelope?.uploadedAt) || Date.parse(row?.updated_at) || 0;
                    const lastAt = groupSyncAt(group);
                    if (remoteEnvelope?.device && remoteEnvelope.device !== state.deviceName && remoteAt > lastAt) {
                        overwriteApproved = true;
                        throw new Error(`另一台设备（${remoteEnvelope.device}）在 ${new Date(remoteAt).toLocaleString()} 上传过${GROUP_LABEL[group]}。若确认要用本机覆盖它，请再点一次。`);
                    }
                }

                await writeCloudRow(envelope, snapshot, group);
                window.__rphubSyncPassword = currentPassword();
                const config = loadConfig() || {};
                saveConfig({ ...stampGroupSync(config, group, 'upload'), provider: 'cloud' });
                state.cloudHasRemote = true;
                state.cloudKeyCount = snapshot.entries.length;
                state.cloudUpdatedAt = Date.now();
                state.cloudDevice = state.deviceName;
                markGroup(group, {
                    hasRemote: true, updatedAt: Date.now(), device: state.deviceName,
                    keyCount: snapshot.entries.length, at: Date.now(), direction: 'upload',
                    dirty: false, error: ''
                });
                state.lastSyncError = '';
                if (!silent) setMessage('success', `已上传${GROUP_LABEL[group]} ${snapshot.entries.length} 项（${(JSON.stringify(envelope).length / 1024).toFixed(0)} KB）`);
                return { uploaded: snapshot.entries.length };
            });
            // 上一次还没传完，这一趟被挡下了：把这批改动记回去，等下一轮
            if (!uploaded) markGroup(group, { dirty: true });
            return uploaded;
        } catch (error) {
            markGroup(group, { dirty: true, error: error?.message || '上传失败' });
            state.lastSyncError = error?.message || '上传失败';
            throw error;
        }
    };

    const cloudPull = async (group = 'all', { reload = true } = {}) => runBusy('正在恢复', async (report) => {
        if (!state.cloudSignedIn) throw new Error('请先登录再恢复');
        report(0.02, '正在读取云端');
        const row = await fetchCloudRow();
        if (!row) throw new Error('云端还没有这个账号的同步数据');
        const groups = cloudGroupsOf(row);
        // 老版本的云端只有一整个包，没拆分组：这时点任何一包的「恢复」都拿它。
        const envelope = groups[group] || groups.all;
        if (!envelope) throw new Error(`云端还没有「${GROUP_LABEL[group]}」这一包，先在这台设备上传一次`);
        const snapshot = await openEnvelope(envelope);
        window.__rphubSyncPassword = currentPassword();
        report(0.08, '正在写回本机');
        const result = await applySnapshot(snapshot, fraction => report(0.08 + fraction * 0.9, '正在写回本机'), groups[group] ? group : 'all');
        const config = loadConfig() || {};
        saveConfig({ ...stampGroupSync(config, group, 'download'), provider: 'cloud' });
        markGroup(group, { dirty: false, at: Date.now(), direction: 'download', error: '' });
        state.pendingChanges = SYNC_GROUPS.some(name => state.groups[name].dirty);
        setMessage('success', `已恢复${GROUP_LABEL[group]} ${result.written} 项数据${reload ? '，页面即将刷新…' : ''}`);
        if (!reload) return result;
        await new Promise(resolve => setTimeout(resolve, 1200));
        location.reload();
        return result;
    });

    const afterCloudSignIn = async ({ auto = false } = {}) => {
        try {
            const row = await fetchCloudRow();
            const groups = cloudGroupsOf(row);
            const hasAny = !!groups.all || SYNC_GROUPS.some(group => groups[group]);
            const characters = (await storage().getStoredValue('characters')) || [];
            const localEmpty = !Array.isArray(characters) || !characters.length;
            if (!hasAny) {
                setMessage('info', '云端还没有数据，先把本机数据传上去…');
                if (auto !== false) await cloudUpload({ silent: true, group: 'all' });
                setMessage('success', '同步已就绪。换设备只要登录同一账号，点「从云端恢复」即可接着玩。');
                return;
            }
            if (localEmpty && auto) {
                setMessage('info', '本机没有角色，正在从云端恢复…');
                if (groups.settings) await cloudPull('settings', { reload: false });
                if (groups.chat) await cloudPull('chat', { reload: false });
                else if (groups.all) await cloudPull('all', { reload: false });
                location.reload();
                return;
            }
            const parts = SYNC_GROUPS.filter(group => groups[group]).map(group => GROUP_LABEL[group]);
            setMessage('info', `云端已有${parts.length ? parts.join('、') : '数据'}（${new Date(state.cloudUpdatedAt).toLocaleString()} 上传）。要接着玩就点对应那一包的「恢复」；要把本机覆盖上去就点「上传」。`);
        } catch (error) {
            setMessage('error', error.message);
        }
    };

    const cloudSignOut = async () => {
        try {
            const cloud = getClient();
            await cloud.auth.signOut();
        } catch (_) { /* 忽略 */ }
        syncCloudUser(null);
        state.cloudHasRemote = false;
        state.pendingChanges = false;
        state.lastSyncError = '';
        stopDirtyTimer();
        state.message = { type: 'info', text: '已退出登录，本地数据不受影响' };
    };

    const cloudRefreshStatus = async () => {
        if (!state.cloudSignedIn) return;
        try {
            await fetchCloudRow();
        } catch (_) { /* 沉默 */ }
    };

    // ══════════════════ 同步码保管箱（免登录）══════════════════
    // 用一张独立表：行键是「码的哈希 + 分组」，内容是 AES-GCM 密文。
    // 不给 delete 权限，写只能 upsert，读只能按 hash 查（表里也没法按码反查）。
    const vaultHash = async () => vaultCodeHash(normalizeVaultCode(state.vaultCode));

    // 聊天记录一大就装不进一行，所以按「分组 # 序号」拆成多片：chat、chat#2、chat#3…
    // 读取时按序号拼回来，上层拿到的还是一个完整的包。
    const parseVaultRowName = (name) => {
        const raw = String(name || '');
        const at = raw.indexOf('#');
        if (at < 0) return { base: raw, index: 1 };
        return { base: raw.slice(0, at), index: Number(raw.slice(at + 1)) || 1 };
    };
    const vaultRowName = (group, index) => (index <= 1 ? group : `${group}#${index}`);

    const vaultRows = async () => {
        const cloud = getClient();
        const hash = await vaultHash();
        const { data, error } = await cloud.database.from(VAULT_TABLE)
            .select('group_name, payload, device, key_count, size_bytes, updated_at')
            .eq('code_hash', hash);
        if (error) throw new Error(`读取云端失败：${error.message || error.code}`);
        const grouped = {};
        (Array.isArray(data) ? data : []).forEach((row) => {
            const { base, index } = parseVaultRowName(row.group_name);
            if (!SYNC_GROUPS.includes(base)) return;
            (grouped[base] || (grouped[base] = [])).push({ ...row, _index: index });
        });
        const map = {};
        Object.entries(grouped).forEach(([base, list]) => {
            list.sort((a, b) => a._index - b._index);
            const first = list[0];
            // 片数写在第一片的明文头里：万一上次片更多、收尾没删干净，也不会把旧片拼进来
            const total = Math.max(1, Number(first?.payload?.parts) || list.length);
            map[base] = {
                ...first,
                parts: list,
                partTotal: total,
                partCount: Math.min(total, list.length),
                key_count: list.reduce((sum, row) => sum + (Number(row.key_count) || 0), 0),
                size_bytes: list.reduce((sum, row) => sum + (Number(row.size_bytes) || 0), 0),
                updated_at: list.map(row => row.updated_at).sort().slice(-1)[0]
            };
        });
        return map;
    };

    // 写一片：先更新，更新不到行才插入。分片多时网络偶发失败很常见，交给外面重试。
    const vaultWritePart = async (cloud, hash, name, body) => {
        const { data, error } = await cloud.database.from(VAULT_TABLE)
            .update(body).eq('code_hash', hash).eq('group_name', name).select('code_hash');
        if (error) throw new Error(`上传失败：${error.message || error.code}`);
        if (Array.isArray(data) && data.length) return;
        const inserted = await cloud.database.from(VAULT_TABLE)
            .insert({ code_hash: hash, group_name: name, ...body }).select('code_hash');
        if (inserted.error) throw new Error(`上传失败：${inserted.error.message || inserted.error.code}`);
    };

    // 一片失败不整体放弃，隔一会儿再试两次：手机切网、后台被挂起都会抖一下
    const vaultRetry = async (job, times = 3) => {
        let last = null;
        for (let attempt = 0; attempt < times; attempt += 1) {
            try {
                return await job(attempt);
            } catch (error) {
                last = error;
                if (attempt < times - 1) await new Promise(resolve => setTimeout(resolve, 700 * (attempt + 1)));
            }
        }
        throw last;
    };

    // 把一片一片解回来拼成整包。缺片就明确报错，不拿半包去覆盖本机。
    const vaultReadSnapshot = async (rows, group, password) => {
        const entry = rows[group];
        if (!entry) throw new Error(`云端还没有「${GROUP_LABEL[group]}」这一包，先在那台设备上传一次`);
        const total = Math.max(1, entry.partTotal || 1);
        const usable = entry.parts.filter(row => (Number(row.payload?.part) || 1) <= total);
        if (usable.length < total) {
            throw new Error(`云端${GROUP_LABEL[group]}分成 ${total} 片，只读到 ${usable.length} 片。在那台设备重新点一次上传。`);
        }
        // 只拼同一批的分片：上一次传到一半断掉时，云端会新旧混着，拼起来会把两轮的内容搅在一起
        const batch = usable[0]?.payload?.batch || '';
        const list = batch ? usable.filter(row => (row.payload?.batch || '') === batch) : usable;
        if (batch && list.length < total) {
            throw new Error(`云端${GROUP_LABEL[group]}正在更新（这批只写到 ${list.length}/${total} 片），过一会儿再点恢复。`);
        }
        const snapshots = [];
        for (const row of list) {
            snapshots.push(await decryptSnapshot(row.payload, password));
        }
        const merged = { ...snapshots[0], entries: [], owners: [] };
        const seen = new Set();
        snapshots.forEach((snapshot) => {
            (snapshot.entries || []).forEach(item => merged.entries.push(item));
            (snapshot.owners || []).forEach((owner) => {
                if (seen.has(owner)) return;
                seen.add(owner);
                merged.owners.push(owner);
            });
        });
        merged.entries = joinSlicedEntries(merged.entries);
        return merged;
    };

    const fillVaultStatus = (rows) => {
        SYNC_GROUPS.forEach((group) => {
            const row = rows[group];
            markGroup(group, {
                hasRemote: !!row,
                updatedAt: row ? (Date.parse(row.updated_at) || 0) : 0,
                device: row?.device || '',
                keyCount: Number(row?.key_count) || 0,
                size: Number(row?.size_bytes) || 0,
                error: ''
            });
        });
        state.cloudHasRemote = SYNC_GROUPS.some(group => !!rows[group]);
        const newest = SYNC_GROUPS.map(group => rows[group]).filter(Boolean)
            .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0];
        state.cloudUpdatedAt = newest ? (Date.parse(newest.updated_at) || 0) : 0;
        state.cloudDevice = newest?.device || '';
        state.cloudKeyCount = SYNC_GROUPS.reduce((sum, group) => sum + (Number(rows[group]?.key_count) || 0), 0);
    };

    // 已经在提示里拦过一次了：用户再点一次才真覆盖
    let vaultOverwriteApproved = false;

    const vaultUpload = async ({ silent = false, group, allowEmpty = false } = {}) => {
        if (!state.vaultConfigured) throw new Error('先在一台设备上生成同步码');
        const code = normalizeVaultCode(state.vaultCode);
        return runBusy(`正在上传 ${GROUP_LABEL[group]}`, async (report) => {
            const snapshot = await collectSnapshot(report, group);
            if (!snapshot.entries.length) {
                // 刚生成码的设备，某包本来可能就是空的（比如新装的应用还没聊过天），跳过就好
                if (allowEmpty) return { uploaded: 0, skipped: true };
                throw new Error('本地没有任何数据可同步');
            }
            report(0.5, '正在切分');
            const itemCount = snapshot.entries.length;
            const sliced = { ...snapshot, entries: sliceEntries(snapshot.entries) };
            const chunks = chunkSnapshot(sliced);
            const total = chunks.length;
            // 这批分片的共同标记：中途断网时云端会新旧片混在一起，靠它认出「这不是一批」
            const batch = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
            const cipher = await prepareCipher(vaultPassword(code));
            const envelopes = [];
            let totalBytes = 0;
            for (let index = 0; index < chunks.length; index += 1) {
                const envelope = await encryptSnapshot(chunks[index], '', cipher);
                envelope.device = state.deviceName;
                envelope.group = group;
                envelope.part = index + 1;
                envelope.parts = total;
                envelope.batch = batch;
                envelope.uploadedAt = new Date().toISOString();
                const text = JSON.stringify(envelope);
                if (text.length > MAX_PAYLOAD_BYTES) {
                    throw new Error(`${GROUP_LABEL[group]}第 ${index + 1} 片就有 ${(text.length / 1024 / 1024).toFixed(1)}MB，还是超过云端单次上限。这一片里应该有一项特别大（世界书或某条超长记录），先在数据管理里处理掉那一条。`);
                }
                totalBytes += text.length;
                envelopes.push({ envelope, text, keys: chunks[index].entries.length });
                report(0.5 + ((index + 1) / total) * 0.2, `正在加密 ${index + 1}/${total}`);
            }
            report(0.72, total > 1 ? `正在上传第 1/${total} 片` : '正在写入云端');
            const cloud = getClient();
            const hash = await vaultHash();
            const rows = await vaultRows();

            // 两台手机轮流用时最容易踩的坑：这台还拿着三天前的进度，
            // 悄悄传上去就把另一台的新内容盖掉了。所以先看一眼云端那一包有多新。
            const proceedDespiteRemote = vaultOverwriteApproved;
            vaultOverwriteApproved = false;
            const remoteRow = rows[group];
            if (!proceedDespiteRemote && remoteRow) {
                const remoteAt = Date.parse(remoteRow.updated_at) || 0;
                const remoteDevice = String(remoteRow.device || '');
                const advance = remoteAt - (groupSyncAt(group) + 1500);
                if (remoteDevice && remoteDevice !== state.deviceName && advance > 0) {
                    const text = `另一台设备（${remoteDevice}）在 ${new Date(remoteAt).toLocaleString()} 上传过${GROUP_LABEL[group]}，比这台记的更新。要用本机覆盖它，再点一次「上传本机」。`;
                    markGroup(group, {
                        hasRemote: true, updatedAt: remoteAt, device: remoteDevice,
                        keyCount: Number(remoteRow.key_count) || 0,
                        size: Number(remoteRow.size_bytes) || 0, error: text
                    });
                    state.lastSyncError = text;
                    // 自动上传不该弹错误：把话留在这一包的状态里，用户点一次才算确认
                    if (silent) return { uploaded: 0, skipped: true, conflict: true };
                    vaultOverwriteApproved = true;
                    throw new Error(text);
                }
            }

            // 第一片最后写：它带着「这批共几片」和批次号，相当于提交动作。
            // 中途断网时云端还停在上一批，恢复端不会读到半新半旧的数据。
            const writeOrder = [];
            for (let partIndex = total; partIndex >= 2; partIndex -= 1) writeOrder.push(partIndex);
            writeOrder.push(1);
            for (let step = 0; step < writeOrder.length; step += 1) {
                const partIndex = writeOrder[step];
                const item = envelopes[partIndex - 1];
                const name = vaultRowName(group, partIndex);
                await vaultRetry(() => vaultWritePart(cloud, hash, name, {
                    payload: item.envelope,
                    device: state.deviceName,
                    // 项数只在第一片记总数，其余记 0：聚合时一加就是真实条目数，不会被切片放大
                    key_count: partIndex === 1 ? itemCount : 0,
                    size_bytes: item.text.length,
                    updated_at: new Date().toISOString()
                }));
                report(0.72 + ((step + 1) / total) * 0.26, total > 1 ? `正在写入云端 ${step + 1}/${total}` : '正在写入云端');
            }
            // 上次分得比这次多（删过聊天记录），把多出来的旧片清掉。
            // 清理失败也不影响正确性：读取端只认第一片里写明的片数。
            if (Number(rows[group]?.partTotal) > total) {
                try {
                    await cloud.database.rpc('rphub_vault_trim', { p_hash: hash, p_base: group, p_keep: total });
                } catch (_) { /* 旧分片会被读取端忽略，只是占一点空间 */ }
            }
            const config = loadConfig() || {};
            saveConfig({ ...stampGroupSync(config, group, 'upload'), provider: 'vault' });
            markGroup(group, {
                hasRemote: true, updatedAt: Date.now(), device: state.deviceName,
                keyCount: itemCount, size: totalBytes,
                at: Date.now(), direction: 'upload', dirty: false, error: ''
            });
            state.lastSyncError = '';
            if (!silent) {
                const sizeText = `${(totalBytes / 1024).toFixed(0)} KB`;
                setMessage('success', total > 1
                    ? `已上传${GROUP_LABEL[group]} ${itemCount} 项，分成 ${total} 片传完（共 ${sizeText}）`
                    : `已上传${GROUP_LABEL[group]} ${itemCount} 项（${sizeText}）`);
            }
            return { uploaded: itemCount, parts: total };
        });
    };

    const vaultPull = async (group, { reload = true } = {}) => {
        if (!state.vaultConfigured) throw new Error('先输入同步码');
        const code = normalizeVaultCode(state.vaultCode);
        return runBusy(`正在恢复 ${GROUP_LABEL[group]}`, async (report) => {
            report(0.05, '正在读取云端');
            const rows = await vaultRows();
            const snapshot = await vaultReadSnapshot(rows, group, vaultPassword(code));
            report(0.3, '正在写回本机');
            const result = await applySnapshot(snapshot, fraction => report(0.3 + fraction * 0.65, '正在写回本机'), group);
            const config = loadConfig() || {};
            saveConfig({ ...stampGroupSync(config, group, 'download'), provider: 'vault' });
            // 刚恢复过，本机已经是最新的了：之前那次「确认覆盖」的口头允许作废
            vaultOverwriteApproved = false;
            markGroup(group, { dirty: false, at: Date.now(), direction: 'download', error: '' });
            state.pendingChanges = SYNC_GROUPS.some(name => state.groups[name].dirty);
            setMessage('success', `已恢复${GROUP_LABEL[group]} ${result.written} 项数据${reload ? '，页面即将刷新…' : ''}`);
            if (!reload) return result;
            await new Promise(resolve => setTimeout(resolve, 1200));
            location.reload();
            return result;
        });
    };

    // 第一台设备：生成码 → 记住 → 立刻把两包传上去
    const vaultCreate = async () => {
        const code = makeVaultCode();
        state.vaultCode = formatVaultCode(code);
        state.vaultConfigured = true;
        const config = loadConfig() || {};
        saveConfig({
            ...config, provider: 'vault', vaultCode: code,
            deviceName: ensureDeviceName(),
            scope: state.scope
        });
        state.provider = 'vault';
        state.providerTab = 'vault';
        setMessage('info', '同步码已生成，正在上传本机数据…');
        try {
            let uploaded = 0;
            for (const group of SYNC_GROUPS) {
                if (!state.scope[group]) continue;
                const result = await vaultUpload({ silent: true, group, allowEmpty: true });
                uploaded += Number(result?.uploaded) || 0;
            }
            const codeText = formatVaultCode(code);
            setMessage('success', uploaded
                ? `同步码 ${codeText} 已生成。在另一台设备输入同一串码，就能拉到这些数据。这串码请自己存好，丢了取不回来。`
                : `同步码 ${codeText} 已生成，但本机还没有可同步的内容。先聊几句，改动会在停手约 25 秒后自动传上去。这串码请自己存好，丢了取不回来。`);
        } catch (error) {
            setMessage('error', `同步码已生成，但上传没成功：${error.message}`);
        }
    };

    // 第二台设备：输入码 → 检查云端有没有 → 有就拉下来
    const vaultConnect = async () => {
        const raw = state.vaultInput;
        const normalized = normalizeVaultCode(raw);
        if (normalized.length !== 12) {
            setMessage('error', '同步码是 12 位，形如 RPH-XXXX-XXXX-XXXX');
            return;
        }
        const previous = state.vaultCode;
        state.vaultCode = formatVaultCode(normalized);
        state.vaultConfigured = true;
        setMessage('info', '正在检查云端…');
        try {
            const rows = await vaultRows();
            fillVaultStatus(rows);
            const hasAny = SYNC_GROUPS.some(group => rows[group]);
            if (!hasAny) {
                state.vaultCode = previous;
                state.vaultConfigured = !!previous;
                setMessage('error', '这个码在云端还没有数据。如果这是第一台设备，点「生成新同步码」；否则检查有没有输错一位。');
                return;
            }
            const config = loadConfig() || {};
            saveConfig({
                ...config, provider: 'vault', vaultCode: normalized,
                deviceName: config.deviceName || ensureDeviceName(),
                scope: state.scope
            });
            state.provider = 'vault';
            state.vaultInput = '';
            const parts = SYNC_GROUPS.filter(group => rows[group]).map(group => GROUP_LABEL[group]);
            setMessage('success', `已连接。云端有${parts.join('、')}，点对应那一包的「恢复」就能拉下来。`);
        } catch (error) {
            state.vaultCode = previous;
            state.vaultConfigured = !!previous;
            setMessage('error', error.message);
        }
    };

    const vaultRefreshStatus = async () => {
        if (!state.vaultConfigured) return;
        try {
            fillVaultStatus(await vaultRows());
        } catch (_) { /* 网络问题沉默处理 */ }
    };

    const vaultDisconnect = () => {
        if (!confirm('解除这台设备的同步码绑定吗？本地数据不受影响，云端那两包也还在。')) return;
        const config = loadConfig() || {};
        saveConfig({ ...config, provider: 'vault', vaultCode: '', groupSync: {} });
        state.vaultCode = '';
        state.vaultConfigured = false;
        state.vaultInput = '';
        SYNC_GROUPS.forEach(group => markGroup(group, { dirty: false, hasRemote: false, error: '' }));
        state.pendingChanges = false;
        stopDirtyTimer();
        setMessage('info', '已解除同步码绑定，本地数据不受影响');
    };

    // 云端那两包只有码的主人才删得掉（服务端按码的哈希定位）。删完码就废了，本地数据不受影响。
    const vaultPurge = async () => {
        if (!state.vaultConfigured) return;
        if (!confirm('删除云端保存的这两包数据吗？删掉之后这串码就作废了，本地数据不受影响。')) return;
        try {
            const cloud = getClient();
            const hash = await vaultHash();
            const { error } = await cloud.database.rpc('rphub_vault_drop', { p_hash: hash });
            if (error) throw new Error(error.message || error.code);
            SYNC_GROUPS.forEach(group => markGroup(group, { hasRemote: false, keyCount: 0, updatedAt: 0, dirty: false }));
            state.cloudHasRemote = false;
            state.pendingChanges = false;
            setMessage('success', '云端数据已删除，本地数据还在');
        } catch (error) {
            setMessage('error', `删除失败：${error.message}`);
        }
    };

    // ══════════════════ GitHub Gist ══════════════════
    // 手机复制令牌时常混进零宽空格之类看不见的字符，.trim() 不会去掉它们，
    // GitHub 收到就回 401，而界面上显示的还是「干干净净的 40 位」。这里按白名单洗一遍。
    const cleanToken = (value) => String(value || '').replace(/[^A-Za-z0-9_]/g, '');
    const ghRequest = async (path, options = {}) => {
        let response;
        try {
            response = await fetch(`${GIST_API}${path}`, {
                cache: 'no-store',
                headers: {
                    Accept: 'application/vnd.github+json',
                    Authorization: `Bearer ${cleanToken(state.tokenInput || loadConfig()?.token || '')}`,
                    ...(options.headers || {})
                },
                ...options
            });
        } catch (_) {
            throw new Error('连不上 GitHub，请检查网络后重试');
        }
        if (response.ok) return response;
        let detail = '';
        try { detail = JSON.parse(await response.text()).message; } catch (_) { /* 非 JSON */ }
        if (response.status === 401) {
            const sent = String(state.tokenInput || loadConfig()?.token || '').trim();
            if (!sent) throw new Error('还没有填写 GitHub Token：请在令牌框里粘贴 ghp_ 开头的整串（40 位）');
            const mark = sent.length > 12 ? `${sent.slice(0, 7)}…${sent.slice(-4)}` : sent;
            if (sent.length !== 40 && sent.startsWith('ghp_')) throw new Error(`Token 长度不对：收到 ${sent.length} 位（${mark}），正品应为 40 位，复制时少了几位`);
            throw new Error(`GitHub 拒绝了这串 Token：收到 ${sent.length} 位 ${mark}。请确认它没被删除、没过期，且是「经典令牌」并勾了 gist`);
        }
        if (response.status === 403) throw new Error('GitHub 拒绝访问（可能是 Token 权限不足或触发限流）');
        if (response.status === 404) throw new Error('找不到对应的同步库，请检查同步码');
        throw new Error(`GitHub 返回错误（${response.status}）${detail ? '：' + detail : ''}`);
    };

    // 分组后一个同步库放两个文件：-chat.json / -settings.json
    // 老的单文件（没有后缀）仍然认，读的时候当成「全部数据」。
    const gistFileName = (code, group = 'all') => (
        group === 'all' ? `${FILE_PREFIX}${code}.json` : `${FILE_PREFIX}${code}-${group}.json`
    );

    const findGistByCode = async (code) => {
        const normalized = String(code || '').trim().toLowerCase();
        if (!/^[0-9a-z]{6}$/.test(normalized)) throw new Error('同步码必须是 6 位字母或数字');
        const prefix = `${FILE_PREFIX}${normalized}`;
        for (let page = 1; page <= 3; page += 1) {
            const gists = await (await ghRequest(`/gists?per_page=100&page=${page}`)).json();
            if (!Array.isArray(gists) || !gists.length) break;
            const hit = gists.find(gist => Object.keys(gist.files || {})
                .some(name => name.toLowerCase().startsWith(prefix)));
            if (hit) return hit;
            if (gists.length < 100) break;
        }
        throw new Error('没有找到这个同步码对应的同步库，请确认 Token 属于同一个 GitHub 账号');
    };

    const readRemoteEnvelope = async (gist, group = 'all') => {
        const files = gist.files || {};
        const names = Object.keys(files);
        const code = String(state.syncCode || '').toLowerCase();
        let fileName = null;
        if (group === 'all') {
            fileName = names.find(name => name.startsWith(FILE_PREFIX) && !/-(chat|settings)\.json$/i.test(name))
                || names.find(name => name.startsWith(FILE_PREFIX))
                || null;
        } else if (code) {
            fileName = names.find(name => name.toLowerCase() === gistFileName(code, group)) || null;
        } else {
            fileName = names.find(name => name.startsWith(FILE_PREFIX) && name.toLowerCase().endsWith(`-${group}.json`)) || null;
        }
        // 老的单文件（没有 -chat / -settings 后缀）：任何一包的恢复都用它
        const legacyName = names.find(name => name.startsWith(FILE_PREFIX) && !/-(chat|settings)\.json$/i.test(name));
        if (!fileName && group !== 'all') fileName = legacyName || null;
        if (!fileName || !files[fileName]) return null;
        const file = files[fileName];
        const url = file.truncated || String(file.content || '').length > 900000 ? file.raw_url : null;
        let text;
        if (url) {
            const response = await fetch(url, { cache: 'no-store' });
            if (!response.ok) throw new Error('读取云端同步数据失败');
            text = await response.text();
        } else {
            text = file.content || '';
        }
        const envelope = JSON.parse(text);
        return {
            envelope,
            legacy: !/-(chat|settings)\.json$/i.test(fileName),
            meta: {
                updatedAt: Date.parse(envelope.uploadedAt) || Date.parse(gist.updated_at) || 0,
                device: envelope.device || '',
                keyCount: Number(envelope.keys) || 0,
                size: text.length
            }
        };
    };

    const writeRemoteEnvelope = async (gistId, code, envelope, group = 'all') => {
        const payload = JSON.stringify(envelope);
        if (payload.length > MAX_PAYLOAD_BYTES) {
            throw new Error(`同步数据压缩后仍有 ${(payload.length / 1024 / 1024).toFixed(1)}MB，超出同步库单文件上限。换成「同步码」通道可以自动分片上传，不用清理聊天记录`);
        }
        await ghRequest(`/gists/${gistId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                description: 'RP-Hub 云同步（端到端加密，仅本账号可读）',
                files: { [gistFileName(code, group)]: { content: payload } }
            })
        });
    };

    // 用户在一次冲突提示后再次点上传，视为确认覆盖
    let overwriteApproved = false;

    const gistEnable = async () => {
        const hadConfigBefore = !!loadConfig()?.gistId;
        const token = cleanToken(state.tokenInput);
        const password = state.passwordInput;
        if (!token) { setMessage('error', '请填写 GitHub Token'); return; }
        if (password.length < 6) { setMessage('error', '同步密码至少 6 位'); return; }
        if (password !== state.confirmInput) { setMessage('error', '两次输入的同步密码不一致'); return; }

        const code = Array.from(crypto.getRandomValues(new Uint8Array(6)))
            .map(byte => '0123456789abcdefghijklmnopqrstuvwxyz'[byte % 36]).join('');
        const deviceName = ensureDeviceName();
        state.tokenInput = token;
        setMessage('info', '正在创建同步库…');
        try {
            const placeholder = JSON.stringify({
                v: SNAPSHOT_VERSION, alg: 'AES-GCM-256', keys: 0, device: deviceName, createdAt: Date.now()
            });
            const response = await ghRequest('/gists', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    description: 'RP-Hub 云同步（端到端加密，仅本账号可读）',
                    public: false,
                    files: { [gistFileName(code, 'settings')]: { content: placeholder } }
                })
            });
            const gist = await response.json();
            if (!gist?.id) throw new Error('创建同步库失败，请重试');
            const config = {
                provider: 'gist',
                token, gistId: gist.id, syncCode: code, gistUrl: gist.html_url || '',
                autoInterval: state.autoInterval, syncOnHide: state.syncOnHide,
                lastSyncAt: 0, lastSyncDirection: '', deviceName
            };
            applyConfig(config);
            saveConfig(config);
            state.passwordInput = password;
            for (const group of SYNC_GROUPS) {
                if (!state.scope[group]) continue;
                await gistUpload({ silent: true, group });
            }
            window.__rphubSyncPassword = password;
            state.passwordInput = '';
            state.confirmInput = '';
            state.providerTab = 'gist';
            setMessage('success', `GitHub 通道已开启，同步码 ${code}。在其它设备上用它即可拉取。`);
        } catch (error) {
            // 只在本次是「首次开启」时回滚；已有配置不能被一次失败抹掉
            if (!hadConfigBefore) {
                localStorage.removeItem(CONFIG_KEY);
                applyConfig(null);
            }
            setMessage('error', error.message);
        }
    };

    const gistUpload = async ({ silent = false, group = 'all' } = {}) => runBusy(`正在上传 ${GROUP_LABEL[group]}`, async (report) => {
        const config = loadConfig();
        if (!config?.gistId) throw new Error('尚未绑定同步库，请先开启云同步');
        const password = currentPassword();
        if (!password) throw new Error('请输入同步密码');
        state.tokenInput = state.tokenInput || config.token;

        const snapshot = await collectSnapshot(report, group);
        if (!snapshot.entries.length) throw new Error('本地没有任何数据可同步');
        const envelope = await encryptSnapshot(snapshot, password);
        envelope.device = config.deviceName;
        envelope.group = group;
        envelope.uploadedAt = new Date().toISOString();

        const proceedDespiteRemote = overwriteApproved;
        overwriteApproved = false;
        if (!proceedDespiteRemote) {
            try {
                const gist = await (await ghRequest(`/gists/${config.gistId}`)).json();
                const remote = await readRemoteEnvelope(gist, group);
                if (remote) {
                    markGroup(group, {
                        hasRemote: true, updatedAt: remote.meta.updatedAt,
                        device: remote.meta.device, keyCount: remote.meta.keyCount, size: remote.meta.size
                    });
                    if (remote.meta.updatedAt > groupSyncAt(group) && remote.meta.device !== config.deviceName) {
                        overwriteApproved = true;
                        throw new Error(`另一台设备（${remote.meta.device || '未知'}）在 ${new Date(remote.meta.updatedAt).toLocaleString()} 上传过${GROUP_LABEL[group]}。若确认要用本机覆盖它，请再点一次。`);
                    }
                }
            } catch (error) {
                if (String(error.message).includes('另一台设备')) throw error;
            }
        }

        await writeRemoteEnvelope(config.gistId, config.syncCode, envelope, group);
        window.__rphubSyncPassword = password;
        saveConfig({ ...stampGroupSync(config, group, 'upload'), provider: 'gist' });
        markGroup(group, {
            hasRemote: true, updatedAt: Date.now(), device: config.deviceName,
            keyCount: snapshot.entries.length, at: Date.now(), direction: 'upload', dirty: false, error: ''
        });
        state.pendingChanges = SYNC_GROUPS.some(name => state.groups[name].dirty);
        if (!silent) setMessage('success', `已上传${GROUP_LABEL[group]} ${snapshot.entries.length} 项（${(JSON.stringify(envelope).length / 1024).toFixed(0)} KB）`);
        return { uploaded: snapshot.entries.length };
    });

    const gistDownload = async (group = 'all', { reload = true } = {}) => runBusy(`正在下载 ${GROUP_LABEL[group]}`, async (report) => {
        const config = loadConfig();
        if (!config) throw new Error('尚未绑定同步库，请先开启云同步');
        const password = currentPassword();
        if (!password) throw new Error('请输入同步密码');
        state.tokenInput = state.tokenInput || config.token;

        let gist;
        if (config.gistId) {
            gist = await (await ghRequest(`/gists/${config.gistId}`)).json();
        } else {
            gist = await findGistByCode(config.syncCode || state.codeInput);
        }
        const remote = await readRemoteEnvelope(gist, group);
        if (!remote) throw new Error(`同步库里还没有「${GROUP_LABEL[group]}」这一包`);
        const snapshot = await decryptSnapshot(remote.envelope, password);
        window.__rphubSyncPassword = password;
        report(0.1, '正在写入本机');
        const result = await applySnapshot(snapshot, fraction => report(0.1 + fraction * 0.9, '正在写回本机'), remote.legacy ? 'all' : group);
        saveConfig(stampGroupSync({
            ...config,
            provider: 'gist',
            gistId: gist.id,
            gistUrl: gist.html_url,
            syncCode: config.syncCode || (Object.keys(gist.files || {})[0] || '')
                .replace(FILE_PREFIX, '').replace(/-(chat|settings)\.json$|\.json$/, '')
        }, group, 'download'));
        markGroup(group, { dirty: false, at: Date.now(), direction: 'download', error: '' });
        state.pendingChanges = SYNC_GROUPS.some(name => state.groups[name].dirty);
        setMessage('success', `已恢复${GROUP_LABEL[group]} ${result.written} 项数据${reload ? '，页面即将刷新…' : ''}`);
        if (!reload) return result;
        await new Promise(resolve => setTimeout(resolve, 1200));
        location.reload();
        return result;
    });

    const gistBindByCode = async () => {
        const token = cleanToken(state.tokenInput);
        const code = state.codeInput.trim().toLowerCase();
        if (!token) { setMessage('error', '请填写 GitHub Token'); return; }
        if (!/^[0-9a-z]{6}$/.test(code)) { setMessage('error', '同步码必须是 6 位字母或数字'); return; }
        await runBusy('正在查找同步库', async () => {
            state.tokenInput = token;
            const gist = await findGistByCode(code);
            const config = loadConfig() || {};
            saveConfig({
                ...config,
                provider: 'gist',
                token,
                gistId: gist.id,
                gistUrl: gist.html_url,
                syncCode: code,
                deviceName: config.deviceName || ensureDeviceName()
            });
            const found = [];
            for (const group of SYNC_GROUPS) {
                const remote = await readRemoteEnvelope(gist, group);
                if (!remote) continue;
                found.push(GROUP_LABEL[group]);
                markGroup(group, {
                    hasRemote: true, updatedAt: remote.meta.updatedAt, device: remote.meta.device,
                    keyCount: remote.meta.keyCount, size: remote.meta.size
                });
            }
            setMessage('success', found.length
                ? `已找到同步库（${found.join('、')}）。输入同步密码即可恢复。`
                : '找到同步库，但里面还没有分组数据。输入同步密码后先上传一次。');
        }).catch(error => setMessage('error', error.message));
    };

    // ══════════════════ 对外统一入口 ══════════════════
    const scopedGroups = () => SYNC_GROUPS.filter(group => state.scope[group]);

    const uploadGroup = (group, options = {}) => {
        if (state.provider === 'cloud') return cloudUpload({ ...options, group });
        if (state.provider === 'vault') return vaultUpload({ ...options, group });
        return gistUpload({ ...options, group });
    };
    const downloadGroup = (group, options = {}) => {
        if (state.provider === 'cloud') return cloudPull(group, options);
        if (state.provider === 'vault') return vaultPull(group, options);
        return gistDownload(group, options);
    };

    const uploadNow = (options = {}) => {
        if (options.group) return uploadGroup(options.group, options);
        return (async () => {
            const groups = scopedGroups();
            if (!groups.length) throw new Error('没有勾选要同步的内容');
            const results = [];
            for (const group of groups) results.push(await uploadGroup(group, options));
            return results;
        })();
    };
    const downloadNow = (group) => {
        if (group) return downloadGroup(group);
        return (async () => {
            const groups = scopedGroups();
            if (!groups.length) throw new Error('没有勾选要同步的内容');
            for (const name of groups) await downloadGroup(name, { reload: false });
            location.reload();
        })();
    };

    const switchProvider = (name) => {
        state.providerTab = name === 'gist' || name === 'cloud' ? name : 'vault';
        state.message = { type: '', text: '' };
        if (state.providerTab === 'vault') {
            if (state.vaultConfigured) {
                state.provider = 'vault';
                vaultRefreshStatus();
            }
        } else if (state.providerTab === 'cloud') {
            state.provider = 'cloud';
            if (state.cloudSignedIn) cloudRefreshStatus();
        } else if (state.configured && loadConfig()?.gistId) {
            state.provider = 'gist';
        }
    };

    const setScope = (group, value) => {
        state.scope[group] = value !== false;
        const config = loadConfig();
        if (config) saveConfig({ ...config, scope: state.scope });
    };

    const disconnect = () => {
        if (!confirm('确定解除同步绑定吗？本地数据不受影响，只是不再自动同步。')) return;
        localStorage.removeItem(CONFIG_KEY);
        applyConfig(null);
        state.tokenInput = '';
        state.passwordInput = '';
        state.codeInput = '';
        state.syncCode = '';
        state.gistId = '';
        state.gistUrl = '';
        state.vaultCode = '';
        state.vaultConfigured = false;
        state.pendingChanges = false;
        state.lastSyncError = '';
        stopDirtyTimer();
        setMessage('info', '已解除绑定');
    };

    // 每轮对话保存都会走到这里。以前只打一个脏标记，等固定间隔（默认还是关的）或切后台才传；
    // 手机上切后台的异步上传基本发不出去，表现就是「最近十几条同步不上」。
    // 现在改成：安静下来 25 秒就传一次——人在读正文的时候数据已经推上去了；
    // 同时最多拖 3 分钟，连续玩不停也不会一直重置计时器。
    const AUTO_UPLOAD_IDLE_MS = 25000;
    const AUTO_UPLOAD_MAX_WAIT_MS = 180000;
    let dirtyTimer = null;
    let dirtySince = 0;

    const syncActive = () => {
        if (state.provider === 'cloud') return state.cloudSignedIn;
        if (state.provider === 'vault') return state.vaultConfigured;
        return state.configured && !!window.__rphubSyncPassword;
    };
    const dirtyGroups = () => SYNC_GROUPS.filter(group => state.groups[group].dirty && state.scope[group]);

    const runAutoUpload = () => {
        const targets = dirtyGroups();
        if (!targets.length || !syncActive()) return;
        // 正在传：等它结束再补一次，别把这批改动晾着没人管
        if (state.busy) {
            if (dirtyTimer) clearTimeout(dirtyTimer);
            dirtyTimer = setTimeout(() => { dirtyTimer = null; runAutoUpload(); }, 5000);
            return;
        }
        (async () => {
            for (const group of targets) {
                try { await uploadGroup(group, { silent: true }); } catch (_) { /* 原因已写进各组状态 */ }
            }
        })();
    };

    function stopDirtyTimer() {
        if (dirtyTimer) { clearTimeout(dirtyTimer); dirtyTimer = null; }
        dirtySince = 0;
    }

    const scheduleDirtyUpload = () => {
        if (!dirtySince) dirtySince = Date.now();
        if (dirtyTimer) clearTimeout(dirtyTimer);
        const waited = Date.now() - dirtySince;
        const delay = waited + AUTO_UPLOAD_IDLE_MS > AUTO_UPLOAD_MAX_WAIT_MS ? 0 : AUTO_UPLOAD_IDLE_MS;
        dirtyTimer = setTimeout(() => {
            dirtyTimer = null;
            dirtySince = 0;
            runAutoUpload();
        }, delay);
    };

    // 本地有任何保存就标记待同步，自动同步只在有改动时才上传
    const markDirty = (group = 'all') => {
        if (!syncActive()) return;
        (group === 'all' ? SYNC_GROUPS : [group]).forEach((name) => {
            if (state.groups[name]) state.groups[name].dirty = true;
        });
        state.pendingChanges = true;
        scheduleDirtyUpload();
    };

    const canAutoSync = () => {
        if (state.busy) return false;
        if (!syncActive()) return false;
        return !!state.autoInterval;
    };

    let autoTimer = null;
    const restartAutoSync = () => {
        if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
        const minutes = Number(state.autoInterval) || 0;
        if (!minutes) return;
        autoTimer = setInterval(() => {
            if (!canAutoSync() || !dirtyGroups().length) return;
            runAutoUpload();
        }, minutes * 60 * 1000);
    };

    const onHide = () => {
        if (document.visibilityState !== 'hidden') return;
        if (!state.syncOnHide || state.busy) return;
        if (!syncActive() || !dirtyGroups().length) return;
        runAutoUpload();
    };

    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', () => {
        if (!state.syncOnHide || state.busy) return;
        if (!syncActive() || !dirtyGroups().length) return;
        runAutoUpload();
    });

    applyConfig(loadConfig());
    restartAutoSync();

    // 设置页用的派生绑定
    Object.defineProperties(state, {
        autoEnabled: {
            get: () => state.autoInterval > 0,
            set: (value) => {
                state.autoInterval = value ? (Number(state.autoInterval) || 5) : 0;
                const config = loadConfig();
                if (config) saveConfig({ ...config, autoInterval: state.autoInterval });
                restartAutoSync();
            }
        },
        autoMinutes: {
            get: () => Number(state.autoInterval) || 5,
            set: (value) => {
                state.autoInterval = Number(value) || 5;
                const config = loadConfig();
                if (config) saveConfig({ ...config, autoInterval: state.autoInterval });
                restartAutoSync();
            }
        },
        syncOnHideInput: {
            get: () => state.syncOnHide,
            set: (value) => {
                state.syncOnHide = value !== false;
                const config = loadConfig();
                if (config) saveConfig({ ...config, syncOnHide: state.syncOnHide });
            }
        },
        cloudStatusText: {
            get: () => {
                if (!state.cloudSignedIn) return '';
                if (!state.cloudHasRemote) return '云端还没有数据';
                return `云端 ${state.cloudKeyCount} 项 · ${new Date(state.cloudUpdatedAt).toLocaleString()} · 来自 ${state.cloudDevice || '未知设备'}`;
            }
        }
    });

    // 启动：先处理 OAuth 回调，再恢复已有会话
    (async () => {
        if (!CLOUD_HOST_OK) return;
        const handled = await cloudHandleCallback();
        if (handled) return;
        // 先用本地缓存把「已登录」点亮，否则要等 SDK 下载 + 一次网络往返才敢显示
        applyCachedCloudUser();
        const restore = async () => {
            const session = await cloudRestoreSession();
            const config = loadConfig();
            if (session && config?.provider === 'cloud') {
                state.provider = 'cloud';
                cloudRefreshStatus();
            } else if (state.vaultConfigured) {
                vaultRefreshStatus();
            }
        };
        // 恢复会话不占首屏：SDK 19KB，犯不着跟正文抢带宽
        if (typeof requestIdleCallback === 'function') requestIdleCallback(() => { restore(); }, { timeout: 3000 });
        else setTimeout(() => { restore(); }, 1500);
    })();

    window.RPHubCloudSync = {
        ensureCloudSdk,
        applyCachedCloudUser,
        state,
        // 同步码（免登录）
        vaultCreate,
        vaultConnect,
        vaultUpload,
        vaultPull,
        vaultRefreshStatus,
        vaultDisconnect,
        vaultPurge,
        // 平台云
        cloudSignIn,
        cloudSignOut,
        cloudUpload,
        cloudPull,
        cloudRefreshStatus,
        // GitHub
        enableSync: gistEnable,
        bindByCode: gistBindByCode,
        // 统一
        switchProvider,
        uploadNow,
        downloadNow,
        uploadGroup,
        downloadGroup,
        setScope,
        disconnect,
        markDirty,
        collectSnapshot,
        chunkSnapshot,
        sliceEntries,
        joinSlicedEntries,
        vaultRows,
        vaultReadSnapshot,
        applySnapshot,
        buildEnvelope,
        openEnvelope,
        encryptSnapshot,
        decryptSnapshot,
        prepareCipher,
        restartAutoSync,
        makeDeviceName
    };
})();
