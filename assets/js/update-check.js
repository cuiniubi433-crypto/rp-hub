// Remote version check. Configure the API URL in index.html.
(function () {
    const { onBeforeUnmount, onMounted } = Vue;
    const apiUrl = String(document.querySelector('meta[name="rphub-update-api"]')?.content || '')
        .trim()
        .replace(/\/+$/, '');
    const parseVersionId = value => /^\d{5}$/.test(String(value ?? '').trim())
        ? Number(value)
        : null;
    const currentVersionId = parseVersionId(window.RPHubLatestUpdate.id);
    let notifiedVersionId = 0;

    const useUpdateCheck = () => {
        let timer = null;
        const check = async () => {
            if (!apiUrl || currentVersionId === null || document.hidden) return;
            try {
                const response = await fetch(`${apiUrl}/v1/version?current=${currentVersionId}`, {
                    cache: 'no-store'
                });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const data = await response.json();
                const latestVersionId = parseVersionId(data.latestVersionId);
                if (data.updateAvailable && latestVersionId > currentVersionId && latestVersionId > notifiedVersionId) {
                    notifiedVersionId = latestVersionId;
                    window.dispatchEvent(new CustomEvent('rphub:update-available', {
                        detail: { versionId: latestVersionId }
                    }));
                }
            } catch {
                // A failed check must not affect normal RP-Hub use.
            }
        };
        const handleVisibility = () => {
            // 切回页面时也要等一下，别和正在恢复的界面抢
            if (document.hidden) return;
            if (typeof requestIdleCallback === 'function') requestIdleCallback(check, { timeout: 4000 });
            else check();
        };
        onMounted(() => {
            // 别在挂载瞬间就发请求：那正好跟首屏渲染、模型列表抢带宽。
            // 用 requestIdleCallback 等浏览器闲下来，最多等 6 秒。
            const kick = () => {
                check();
                timer = setInterval(check, 20_000);
            };
            if (typeof requestIdleCallback === 'function') {
                requestIdleCallback(kick, { timeout: 6000 });
            } else {
                setTimeout(kick, 3000);
            }
            document.addEventListener('visibilitychange', handleVisibility);
        });
        onBeforeUnmount(() => {
            clearInterval(timer);
            document.removeEventListener('visibilitychange', handleVisibility);
        });
    };

    window.RPHubUpdateCheck = Object.freeze({ useUpdateCheck });
})();
