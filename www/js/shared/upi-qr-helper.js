/**
 * upi-qr-helper.js
 * High-performance, offline-capable UPI QR code generator for LiphtUp.
 * Formats standard NPCI UPI payment URIs with remaining ride fares
 * and renders high-definition QR codes in milliseconds.
 */

export function buildUpiUri({ upiId, name = 'Driver', amount = 0, note = 'LiphtUp Ride Fare' }) {
    if (!upiId || typeof upiId !== 'string') return '';
    const cleanUpi = upiId.trim();
    if (!cleanUpi) return '';
    const cleanName = encodeURIComponent((name || 'Driver').trim());
    const cleanNote = encodeURIComponent((note || 'LiphtUp Ride Fare').trim());
    const num = Math.max(0, Number(amount) || 0);
    // NPCI UPI spec accepts 2 decimal places
    const formattedAmount = num.toFixed(2);
    return `upi://pay?pa=${cleanUpi}&pn=${cleanName}&am=${formattedAmount}&cu=INR&tn=${cleanNote}`;
}

export async function generateUpiQrDataUrl(upiUri) {
    if (!upiUri) return '';
    
    // 1. Try local client-side QRCode engine (0ms network latency)
    try {
        if (window.QRCode && typeof window.QRCode.toDataURL === 'function') {
            return await new Promise((resolve) => {
                window.QRCode.toDataURL(
                    upiUri,
                    {
                        width: 240,
                        margin: 1,
                        color: {
                            dark: '#0F172A',
                            light: '#FFFFFF'
                        },
                        errorCorrectionLevel: 'M'
                    },
                    (err, url) => {
                        if (!err && url) {
                            resolve(url);
                        } else {
                            resolve('');
                        }
                    }
                );
            });
        }
    } catch (err) {
        console.warn('[upi-qr] Client-side QR generation failed, using API:', err);
    }

    // 2. High-reliability online fallback
    return `https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=6&data=${encodeURIComponent(upiUri)}`;
}

/**
 * Attaches or updates the QR code & details inside the fare collection modal.
 */
export async function renderDriverFareQr({
    containerSelector = '.driver-fare-qr-box',
    imgElementId = 'upi-qr-image',
    driverUpi = '',
    driverName = 'Driver',
    remainingFare = 0,
    walletPaidAmount = 0,
    couponDiscountAmount = 0
}) {
    const qrImg = document.getElementById(imgElementId);
    const qrBox = qrImg ? (qrImg.closest(containerSelector) || qrImg.parentElement) : document.querySelector(containerSelector);
    if (!qrBox) return;

    // Remove any previously injected note/badge elements
    const existingMeta = qrBox.querySelector('.driver-qr-meta-wrap');
    if (existingMeta) existingMeta.remove();

    const roundedFare = Math.round(remainingFare);

    // Scenario 1: Ride fully covered by wallet or platform promo
    if (roundedFare <= 0 && (walletPaidAmount > 0 || couponDiscountAmount > 0)) {
        if (qrImg) {
            qrImg.src = '';
            qrImg.style.display = 'none';
        }
        qrBox.classList.remove('d-none');
        qrBox.innerHTML = `
            <div class="driver-qr-meta-wrap text-center py-2">
                <div class="qr-success-icon" style="width:48px;height:48px;border-radius:50%;background:#DCFCE7;color:#16A34A;display:grid;place-items:center;margin:0 auto 8px;font-size:24px;">✓</div>
                <strong style="display:block;color:#15803D;font-size:14px;font-weight:700;">Ride Fully Covered</strong>
                <span style="display:block;color:#64748B;font-size:12px;margin-top:2px;">Paid via wallet / platform promotion. No cash needed.</span>
            </div>
        `;
        return;
    }

    // Scenario 2: Fare is 0 and no wallet/coupon
    if (roundedFare <= 0) {
        if (qrImg) {
            qrImg.src = '';
            qrImg.style.display = 'none';
        }
        qrBox.classList.add('d-none');
        return;
    }

    // Scenario 3: Fare > 0 and Driver has a registered UPI ID
    if (driverUpi) {
        const upiUri = buildUpiUri({
            upiId: driverUpi,
            name: driverName || 'Driver',
            amount: remainingFare,
            note: 'Ride Fare'
        });

        const qrSrc = await generateUpiQrDataUrl(upiUri);

        qrBox.classList.remove('d-none');
        qrBox.innerHTML = `
            <div class="driver-qr-meta-wrap text-center" style="width:100%;">
                <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:12px;padding:8px;display:inline-block;margin:0 auto 8px;">
                    <img id="${imgElementId}" src="${qrSrc}" alt="UPI QR Code" width="190" height="190" style="display:block;margin:0 auto;border-radius:8px;">
                </div>
                <div style="margin-top:4px;">
                    <div style="display:inline-flex;align-items:center;gap:6px;background:#F1F5F9;padding:4px 10px;border-radius:20px;font-size:11.5px;color:#334155;font-weight:600;">
                        <span>UPI:</span>
                        <span style="font-family:monospace;color:#0F172A;">${driverUpi}</span>
                    </div>
                </div>
                <div style="font-size:11px;color:#64748B;margin-top:5px;font-weight:500;">
                    Scan with Google Pay, PhonePe, Paytm, or BHIM
                </div>
            </div>
        `;
        return;
    }

    // Scenario 4: Fare > 0 but NO UPI ID configured in driver profile
    qrBox.classList.remove('d-none');
    qrBox.innerHTML = `
        <div class="driver-qr-meta-wrap text-center py-3" style="width:100%;">
            <div style="width:48px;height:48px;border-radius:50%;background:#FEF3C7;color:#D97706;display:grid;place-items:center;margin:0 auto 8px;font-size:22px;">💵</div>
            <strong style="display:block;color:#92400E;font-size:13.5px;font-weight:700;">Collect ₹${roundedFare} in Cash</strong>
            <span style="display:block;color:#64748B;font-size:11.5px;margin-top:2px;">UPI ID not added in your profile. Collect cash for this trip.</span>
        </div>
    `;
}
