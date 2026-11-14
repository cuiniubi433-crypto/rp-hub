// 场外：场景之外的世界，会不会闯进来。
//
// 设计要点（2026-10-30 重写，砍掉原来那套「世界演化」）：
// 1) 不建任何状态。没有势力、没有线、没有编年史、没有数值、没有时间累积。
//    每一轮重新判断一次，判断完就忘——现实里你本来也不知道别处发生了什么。
// 2) 产出只有两种：什么都不发生（绝大多数），或者「此刻发生在你眼前的一件事」。
// 3) 绝不写旁白。不许出现「与此同时，某地……」这种句子。别处的战争只有打到门口才算数。
// 4) 三档来路：闯进来 / 余波 / 偶然。偶然那档不需要任何前因，小孩撞过来就是撞过来。
(function () {
    const { reactive } = Vue;
    const storage = () => window.RPHubStorage;

    const STATE_KEY = 'world_sim';
    const KINDS = ['intrusion', 'aftermath', 'accident'];

    const ROLE_PRESETS = {
        world: {
            name: '场外',
            prompt: [
                '你负责这个场景之外的世界。你不写正文，不写旁白，不解释背景。',
                '你每一轮只回答一个问题：此刻，有没有东西真的闯进来了？',
                '绝大多数时候，答案是没有。别处发生的战争、灾难、别人的日子，这个房间里的人根本不知道，也不该被提起。',
                '只有三种情况你会让它发生：',
                '一、闯进来：外面的东西已经冲进这个空间——有人闯门、一声巨响、街上突然乱起来、一个陌生人贴到跟前。',
                '二、余波：外面的事已经在身边显形——东西贵了、人流变了、气氛变了、有人带来了消息。',
                '三、偶然：生活本来就有的意外——一个小孩撞过来、停电、下雨、有人敲门。',
                '判断依据只有三条：这段日子有多安稳、玩家做过什么会招来后果的事、这个世界是什么类型。安稳越久越可能出事，但不要为了推动剧情而制造。',
                '你要给的是「此刻发生在这个空间里的一件事」，一句话，二十到五十字，看得见或听得见。不写心理，不写原因，不写玩家的反应。',
                '最后只输出约定的 JSON，不要解释。'
            ].join('\n')
        }
    };

    // 历史上出厂过的几版文案。老档里存的如果是这些原文，算「没改过」，
    // 升级后直接换成新口径，而不是当成用户自定义永远沿用。
    const LEGACY_WORLD_PROMPTS = [
        [
            '你是这个势力本身的决策者，不是叙事者，也不是旁白。',
            '只从这个势力的立场、目标、资源和恩怨出发做决定，不要为了配合玩家而行动。',
            '优先执行与你自己的长期目标相关的事；如果这阵子无事可做，就什么都不做。',
            '只输出一个 JSON：《契约见下方》。'
        ].join('\n'),
        [
            '你负责当前场景之外的那条线，不是叙事者，也不是旁白。',
            '这条线可以是势力、机构、地方、某个不在场的人，也可以是一桩正在发生的事——按它自己的逻辑走。',
            '只从它自身的立场、处境和目标出发做决定，不要为了配合玩家而行动，也不要让世界围着玩家转。',
            '这阵子没有可推进的就什么都不做；无事发生本身也是世界的样子。',
            '不要凭空创造新的名字，只能围绕已有的线行动。只输出一个 JSON（契约见下方）。'
        ].join('\n'),
        [
            '你负责这个世界的背面：所有不在当前场景里的人和事，此刻都在照常运转。',
            '不是只推某一条线。你自己判断此刻最该被推进的是哪一部分——远方的人在过日子，机构在按章程办事，天气在变，消息在路上传，有的事在发酵，有的事在无声地结束。',
            '不需要谁来指定类别和处境，你按它在世界里的位置去推。',
            '只从它自身的处境和利益出发，不要为了配合玩家而行动，也不要为了戏剧性制造巧合。',
            '大部分时候什么都没有；无事发生本身也是世界的样子。',
            '输出只用约定的 JSON，不写正文，不写解释。'
        ].join('\n')
    ];
    const isLegacyWorldPrompt = (text) => LEGACY_WORLD_PROMPTS.includes(String(text || '').trim());

    const defaultState = () => ({
        enabled: false,
        everyFloors: 3,
        lastRunFloor: 0,
        lastRunAt: 0,
        running: false,
        // 下一轮要注入正文的那件事。只服务一轮，用完即清。
        pendingEvent: '',
        pendingKind: '',
        // 离线事件：玩家关掉页面这段时间，外面有没有事闯进来。
        leftAt: 0,
        lastError: '',
        lastNote: ''
    });

    const state = reactive(defaultState());

    // ── 持久化 ──
    let saveTimer = null;
    const scheduleSave = () => {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => { saveTimer = null; persist(); }, 400);
    };
    const persist = async () => {
        try {
            const { setStoredValue } = storage();
            await setStoredValue(STATE_KEY, JSON.parse(JSON.stringify({
                enabled: state.enabled,
                everyFloors: state.everyFloors,
                lastRunFloor: state.lastRunFloor,
                lastRunAt: state.lastRunAt,
                pendingEvent: state.pendingEvent,
                pendingKind: state.pendingKind,
                leftAt: state.leftAt
            })), { clone: false });
        } catch (error) {
            console.warn('[场外] 保存失败', error);
        }
    };

    // 老档在世界面板里改过的职责，迁到快捷面板那份（那边才是现在的唯一入口）。
    // 只在那边还是空的时候迁，而且必须不是历史出厂文案——否则等于把新预设锁死。
    const migrateLegacyPrompt = (savedRoles) => {
        try {
            const legacy = (Array.isArray(savedRoles) ? savedRoles : []).find(role => role && role.kind === 'world');
            const text = String(legacy?.prompt || '').trim();
            if (!text || isLegacyWorldPrompt(text) || text === ROLE_PRESETS.world.prompt) return;
            const settingsRef = window.__rphubSettingsRef;
            const slots = window.RPHubRoleSlots;
            if (!settingsRef || !slots?.normalize) return;
            settingsRef.roleSlots = slots.normalize(settingsRef.roleSlots);
            if (String(settingsRef.roleSlots.world?.prompt || '').trim()) return;
            settingsRef.roleSlots.world.prompt = text;
        } catch (_) { /* 迁移失败不影响使用 */ }
    };

    const load = async () => {
        try {
            const { getStoredValue } = storage();
            const saved = await getStoredValue(STATE_KEY);
            if (!saved || typeof saved !== 'object') return;
            // 旧版存了一大堆东西（势力、编年史、公开事件），这里一概丢弃：
            // 新架构下没有状态，留着只会让老数据在新逻辑里变成脏输入。
            Object.assign(state, defaultState(), {
                enabled: !!saved.enabled,
                everyFloors: Number(saved.everyFloors) || 3,
                lastRunFloor: Number(saved.lastRunFloor) || 0,
                lastRunAt: Number(saved.lastRunAt) || 0
            });
            migrateLegacyPrompt(saved.roles);
        } catch (error) {
            console.warn('[场外] 读取失败', error);
        }
    };

    // ── 与宿主的桥 ──
    let bridge = {
        callModel: null,
        getHistory: () => [],
        getCharacter: () => null,
        // 上一轮主模型召回的旧事摘要。没有就算了，判断不依赖它。
        getRecallDigest: () => ''
    };
    const attach = (hooks = {}) => {
        bridge = { ...bridge, ...hooks };
    };

    const extractJson = (text) => {
        if (!text) return null;
        const source = String(text).trim();
        const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
        const body = fenced ? fenced[1] : source;
        const start = body.indexOf('{');
        const end = body.lastIndexOf('}');
        if (start === -1 || end === -1 || end <= start) return null;
        try {
            return JSON.parse(body.slice(start, end + 1));
        } catch (_) {
            return null;
        }
    };

    const recentHistoryText = (limit = 8) => {
        const history = bridge.getHistory?.() || [];
        const tail = history.slice(-limit * 2);
        return tail.map(message => {
            const who = message.role === 'user' ? '玩家' : '叙事';
            const text = String(message.content || '').replace(/\s+/g, ' ').slice(0, 220);
            return `${who}：${text}`;
        }).join('\n');
    };

    const characterProfileText = () => {
        const raw = bridge.getCharacter?.() || {};
        const card = raw.data && typeof raw.data === 'object' ? raw.data : raw;
        const name = String(card.name || card.char_name || '').trim();
        const intro = String(card.description || card.char_persona || '').replace(/\s+/g, ' ').slice(0, 800);
        const opening = String(card.first_mes || '').replace(/\s+/g, ' ').slice(0, 300);
        const parts = [];
        if (name) parts.push(`【角色卡】${name}`);
        if (intro) parts.push(`【设定摘要】${intro}`);
        if (opening) parts.push(`【开场】${opening}`);
        return parts.join('\n');
    };

    // 职责的唯一解析规则（优先级从高到低）：
    // 1. 快捷面板填的自定义（settings.roleSlots.world.prompt）——全局，不绑卡
    // 2. 出厂预设
    const resolveWorldPrompt = () => {
        try {
            const slots = window.RPHubRoleSlots;
            const settingsRef = window.__rphubSettingsRef;
            if (slots && settingsRef) {
                const custom = String(slots.normalize(settingsRef.roleSlots).world?.prompt || '').trim();
                if (custom && !isLegacyWorldPrompt(custom)) return custom;
            }
        } catch (_) { /* 快捷面板未加载时忽略 */ }
        try {
            const builtin = window.RPHubRoleSlots?.builtinPrompt?.('world');
            if (builtin) return builtin;
        } catch (_) { /* 忽略 */ }
        return ROLE_PRESETS.world.prompt;
    };

    // 场外槽位的实际配置：模型 / 通道 / 频率以快捷面板（settings.roleSlots）为准。
    const worldSlot = () => {
        const fallback = { enabled: false, model: '', channel: 'uiTemplate', every: 3 };
        try {
            const slots = window.RPHubRoleSlots;
            const settingsRef = window.__rphubSettingsRef;
            if (!slots || !settingsRef) return fallback;
            const slot = slots.normalize(settingsRef.roleSlots).world || fallback;
            return {
                enabled: !!slot.enabled,
                model: String(slot.model || ''),
                channel: String(slot.channel || 'uiTemplate'),
                every: Number(slot.every) || 3
            };
        } catch (_) {
            return fallback;
        }
    };

    const buildEventPrompt = () => {
        const lines = [resolveWorldPrompt(), ''];
        const profile = characterProfileText();
        if (profile) lines.push(profile, '');
        lines.push(`【最近的对话】\n${recentHistoryText(8) || '（还没有对话）'}`);
        // 玩家做过的事不能随楼层数稀释：把上一轮召回的旧事也给它看
        const recall = String(bridge.getRecallDigest?.() || '').trim();
        if (recall) {
            lines.push('');
            lines.push(`【以前发生过、和现在有关的事】\n${recall.slice(0, 900)}`);
            lines.push('这些是之前真正发生过的事。如果其中某件该有后果了，就让它在此刻显形。');
        }
        lines.push('');
        lines.push('输出格式（只输出这个 JSON，不要解释、不要代码块）：');
        lines.push('{"hit":false}');
        lines.push('或');
        lines.push('{"hit":true,"kind":"intrusion|aftermath|accident","event":"此刻发生在这个空间里的一件事，二十到五十字"}');
        lines.push('规则：');
        lines.push('- 绝大多数时候应该是 {"hit":false}。不要为了显得有用而制造事件。');
        lines.push('- event 必须是此刻发生在这个空间里的，不是别处正在发生的事。');
        lines.push('- 不许写「与此同时」「另一边」「此时此刻在某地」这类句子。');
        lines.push('- 不解释原因，不写心理活动，不写玩家的反应。');
        lines.push('- 一件事就够，不要连写三件。');
        return lines.join('\n');
    };

    const currentFloor = () => (bridge.getHistory?.() || []).filter(m => m.role === 'assistant').length;

    // 删消息、删到最后一楼、换档串档，都会让 currentFloor 变小。
    // 这时候 lastRunFloor 还停在旧楼层，差值恒为负，场外就再也不动，
    // 要等新楼层把这个洞填回来才会再触发——看着像坏了。
    // 夹回当前楼层即可：当作「刚在现在这一层跑过」，节拍照旧往下走。
    const clampRunFloor = (floor) => {
        const last = Number(state.lastRunFloor) || 0;
        if (last > floor) {
            state.lastRunFloor = floor;
            scheduleSave();
            return true;
        }
        return false;
    };

    const runTurn = async ({ manual = false } = {}) => {
        if (state.running) return { skipped: true, reason: '上一轮还没跑完' };
        const slot = worldSlot();
        if (!slot.enabled && !state.enabled && !manual) {
            state.lastError = '快捷面板里的「场外」没打开。';
            return { skipped: true, reason: state.lastError };
        }
        if (!bridge.callModel) {
            state.lastError = '模型通道还没就绪，请稍后再试。';
            return { skipped: true, reason: state.lastError };
        }
        state.running = true;
        state.lastError = '';
        state.lastNote = '';
        try {
            const text = await bridge.callModel({
                messages: [
                    { role: 'system', content: buildEventPrompt() },
                    { role: 'user', content: '现在，有没有东西闯进来？只输出 JSON。' }
                ],
                model: slot.model || '',
                channel: slot.channel || 'uiTemplate',
                temperature: 0.9,
                maxTokens: 260
            });
            const parsed = extractJson(text);
            const event = parsed && parsed.hit === true ? String(parsed.event || '').trim().slice(0, 160) : '';
            state.lastRunFloor = Math.round(currentFloor());
            state.lastRunAt = Date.now();
            if (!event) {
                // 没有事情发生，就是没有。不记录、不暗示、不留痕。
                state.pendingEvent = '';
                state.pendingKind = '';
                state.lastNote = '这一轮外面什么也没发生。';
                scheduleSave();
                return { hit: false };
            }
            state.pendingEvent = event;
            state.pendingKind = KINDS.includes(parsed.kind) ? parsed.kind : '';
            scheduleSave();
            return { hit: true, event, kind: state.pendingKind };
        } catch (error) {
            state.lastError = error.message;
            return { error: error.message };
        } finally {
            state.running = false;
        }
    };

    // 主笔注入：只在真有事的时候给一句。没有就一个字都不加。
    const buildSceneEventPrompt = () => {
        const slot = worldSlot();
        if (!(slot.enabled || state.enabled)) return '';
        const event = String(state.pendingEvent || '').trim();
        if (!event) return '';
        return [
            '[这一轮发生在你眼前的事]',
            event,
            '（这件事必须真的发生。不要改写它，不要解释它从哪来，也不要替玩家决定反应。）'
        ].join('\n');
    };

    const noteAssistantTurn = async () => {
        const floor = currentFloor();
        clampRunFloor(floor);
        // 上一轮的事件只服务一轮，用完即清，避免反复强调
        if (state.pendingEvent && floor > 0) {
            state.pendingEvent = '';
            state.pendingKind = '';
        }
        const slot = worldSlot();
        if (!(slot.enabled || state.enabled)) return;
        const every = Math.max(1, Number(slot.every) || Number(state.everyFloors) || 3);
        if (floor - (Number(state.lastRunFloor) || 0) >= every) {
            const result = await runTurn({ manual: false });
            if (result?.skipped && result.reason && !state.lastError) state.lastNote = result.reason;
        } else {
            scheduleSave();
        }
    };

    window.RPHubWorldSim = {
        state,
        attach,
        load,
        persist: scheduleSave,
        ROLE_PRESETS,
        resolveWorldPrompt,
        worldSlot,
        buildEventPrompt,
        buildSceneEventPrompt,
        runTurn,
        noteAssistantTurn,
        currentFloor,
        extractJson
    };
})();
