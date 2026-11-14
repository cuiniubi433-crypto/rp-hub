// 副任务调度器：把散落的副模型请求排成一条线。
//
// 起因（2026-11-13）：一轮正文落地后，模板变量更新、行动建议、认知扫描、
// 场外这几个请求会同时飞出去。中转站按 key 限并发，主对话只能排在它们后面，
// 于是「点了发送半天不开始」。串成一条线之后，任何时刻只有一个副请求在路上。
//
// 三条规则：
// 1) 串行。副任务之间不并发，主对话永远只面对一个对手。
// 2) 主对话优先。主请求一开始装配就暂停队列；正在跑的超过 8 秒的一律停掉。
// 3) 副任务可以被主对话插队，插队后按原顺序继续，不丢结果。
(function () {
    const { reactive } = Vue;

    const state = reactive({
        queued: 0,          // 排着还没跑的数量
        running: '',       // 正在跑的任务名
        paused: false,     // 主对话在路上时为 true
        totalDone: 0,
        totalFailed: 0,
        lastLabel: '',     // 最近跑完的任务名
        lastMs: 0,         // 最近一次耗时
        lastError: ''
    });

    const queue = [];
    const controllers = new Set();
    let running = false;
    let mainDepth = 0;

    const pump = () => {
        if (running || mainDepth > 0) return;
        const task = queue.shift();
        if (!task) return;
        running = true;
        state.queued = queue.length;
        state.running = task.label;
        const startedAt = Date.now();
        task.controller.__startedAt = startedAt;
        controllers.add(task.controller);
        let timer = null;
        if (task.timeoutMs > 0) {
            timer = setTimeout(() => {
                try { task.controller.abort('timeout'); } catch (_) { }
            }, task.timeoutMs);
        }
        const settle = () => {
            if (timer) clearTimeout(timer);
            controllers.delete(task.controller);
            running = false;
            state.running = '';
            state.lastLabel = task.label;
            state.lastMs = Date.now() - startedAt;
            setTimeout(pump, 0);
        };
        (async () => {
            try {
                const value = await task.fn(task.controller.signal);
                task.resolve(value);
            } catch (error) {
                state.totalFailed += 1;
                state.lastError = String(error?.message || error);
                task.reject(error);
            } finally {
                settle();
            }
        })();
    };

    // 副任务入队。fn 收到一个 AbortSignal，主对话插队时可以把它掐掉。
    // crucial: 直接影响界面的任务（模板变量），主对话插队时不轻易掐。
    const enqueue = (label, fn, options = {}) => {
        const controller = new AbortController();
        controller.__crucial = !!options.crucial;
        const timeoutMs = Math.max(0, Number(options.timeoutMs) || 0);
        const promise = new Promise((resolve, reject) => {
            queue.push({
                label: String(label || '副任务'),
                fn,
                controller,
                resolve,
                reject,
                timeoutMs
            });
        });
        state.queued = queue.length;
        pump();
        return promise;
    };

    // 主对话占用通道期间，副任务先别起跑。用计数，嵌套也不会提前解锁。
    const beginMain = () => {
        mainDepth += 1;
        state.paused = true;
    };
    const endMain = () => {
        mainDepth = Math.max(0, mainDepth - 1);
        state.paused = mainDepth > 0;
        if (mainDepth === 0) pump();
    };

    // 主对话插队：跑得太久的副任务直接停掉，短的不动（免得丢一轮变量）。
    // 模板变量是「关键任务」：跑十几秒很正常，掐了面板就不动，所以给它更长的容忍。
    const abortOlderThan = (minAgeMs = 8000, options = {}) => {
        const now = Date.now();
        const crucialLimit = Math.max(minAgeMs, Number(options.crucialAgeMs) || 30000);
        let dropped = 0;
        controllers.forEach(controller => {
            const limit = controller.__crucial ? crucialLimit : minAgeMs;
            if (now - Number(controller.__startedAt || 0) < limit) return;
            try { controller.abort('main-request'); } catch (_) { }
            controllers.delete(controller);
            dropped += 1;
        });
        return dropped;
    };

    // 换档、换角色、切分支时把没跑的副任务清掉，避免它们拿着上一段世界的状态跑。
    const clear = (reason = 'cleared') => {
        const dropped = queue.splice(0, queue.length);
        // 注意：splice 之后 queue 已经空了，必须遍历 dropped，
        // 否则等待方永远等不到 resolve/reject，界面会一直停在「分析中」。
        dropped.forEach(task => {
            try { task.reject(new Error(reason)); } catch (_) { }
        });
        state.queued = 0;
        return dropped.length;
    };

    // 给界面看的一句话结论，不给指标名。
    const describe = () => {
        if (state.running) {
            const tail = state.queued > 0 ? `，还有 ${state.queued} 个在等` : '';
            return `副任务正在跑「${state.running}」${tail}`;
        }
        if (state.queued > 0) return `副任务排队中，${state.queued} 个在等`;
        if (state.lastLabel) return `副任务空闲，上一个「${state.lastLabel}」用了 ${(state.lastMs / 1000).toFixed(1)} 秒`;
        return '副任务空闲';
    };

    window.RPHubSideTasks = {
        state,
        enqueue,
        beginMain,
        endMain,
        abortOlderThan,
        clear,
        describe,
        pending: () => queue.length
    };
})();
