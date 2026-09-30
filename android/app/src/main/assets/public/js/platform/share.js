/**
 * Platform adapter for Sharing.
 */
export async function share(data) {
    const Plugins = (window.Capacitor && window.Capacitor.Plugins) || {};
    if (Plugins.Share && typeof Plugins.Share.share === 'function') {
        try {
            await Plugins.Share.share({
                title: data.title,
                text: data.text,
                url: data.url,
                dialogTitle: 'Share LiphtUp'
            });
            return { ok: true };
        } catch (error) {
            if (error?.name === 'AbortError' || error?.message?.includes('canceled')) {
                return { ok: false, reason: 'aborted' };
            }
            console.warn("[platform/share] Capacitor native share failed:", error);
        }
    }

    if (typeof navigator.share === 'function') {
        try {
            await navigator.share(data);
            return { ok: true };
        } catch (error) {
            if (error.name === 'AbortError') return { ok: false, reason: 'aborted' };
            console.warn("[platform/share] native share failed:", error);
            return { ok: false, reason: 'error', error };
        }
    }
    return { ok: false, reason: 'unsupported' };
}

export async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        const temporaryInput = document.createElement('textarea');
        temporaryInput.value = text;
        temporaryInput.setAttribute('readonly', '');
        temporaryInput.style.position = 'fixed';
        temporaryInput.style.opacity = '0';
        document.body.appendChild(temporaryInput);
        temporaryInput.select();
        const copied = document.execCommand('copy');
        temporaryInput.remove();
        return copied;
    }
}
