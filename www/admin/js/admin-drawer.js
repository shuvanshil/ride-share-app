// A single reusable drawer shell used for the driver profile, ride detail,
// and any future detail view. Two modes:
//   - readOnlyHtml(title, html)               -> plain detail view
//   - form(title, {fields, initialValues, onSave}) -> editable form with
//     dirty-tracking and Save / Save & Close / Discard

const root = document.getElementById("admin-drawer-root");
const panel = document.getElementById("admin-drawer-panel");
const backdrop = document.getElementById("admin-drawer-backdrop");
const titleEl = document.getElementById("admin-drawer-title");
const bodyEl = document.getElementById("admin-drawer-body");
const footerEl = document.getElementById("admin-drawer-footer");
const closeBtn = document.getElementById("admin-drawer-close");

let dirty = false;
let closeGuard = null;

function open() {
    root.classList.remove("d-none");
    requestAnimationFrame(() => panel.classList.add("is-open"));
}

export function closeDrawer(force = false) {
    if (!force && dirty) {
        if (!confirm("Discard unsaved changes?")) return;
    }
    dirty = false;
    closeGuard = null;
    panel.classList.remove("is-open");
    setTimeout(() => root.classList.add("d-none"), 200);
}

closeBtn.addEventListener("click", () => closeDrawer());
backdrop.addEventListener("click", () => closeDrawer());

export function showReadOnlyDrawer(title, html) {
    dirty = false;
    titleEl.textContent = title;
    bodyEl.innerHTML = html;
    footerEl.innerHTML = "";
    open();
    return { bodyEl, footerEl };
}

/**
 * @param {string} title
 * @param {Object} opts
 * @param {Array<{key:string, label:string, type?:string, options?:Array<{value:string,label:string}>, required?:boolean, readOnly?:boolean}>} opts.fields
 * @param {Object} opts.initialValues
 * @param {(values:Object)=>Promise<void>} opts.onSave
 * @param {string} [opts.extraHtml] - rendered above the form (read-only summary block)
 */
export function showFormDrawer(title, { fields, initialValues, onSave, extraHtml = "" }) {
    dirty = false;
    titleEl.textContent = title;

    const fieldsHtml = fields
        .map((f) => {
            const value = initialValues[f.key] ?? "";
            if (f.readOnly) {
                return `<div class="admin-detail-row"><span>${f.label}</span><span>${escapeHtml(value)}</span></div>`;
            }
            if (f.type === "select") {
                const opts = (f.options || [])
                    .map((o) => `<option value="${o.value}" ${o.value === value ? "selected" : ""}>${o.label}</option>`)
                    .join("");
                return `<div class="mb-3">
                    <label class="form-label">${f.label}${f.required ? " *" : ""}</label>
                    <select class="form-select gy-input" data-field="${f.key}">${opts}</select>
                </div>`;
            }
            return `<div class="mb-3">
                <label class="form-label">${f.label}${f.required ? " *" : ""}</label>
                <input type="${f.type || "text"}" class="form-control gy-input" data-field="${f.key}" value="${escapeAttr(value)}">
                <div class="dt-field-error d-none" data-error-for="${f.key}"></div>
            </div>`;
        })
        .join("");

    bodyEl.innerHTML = `${extraHtml}<form id="drawer-form" novalidate>${fieldsHtml}</form>`;
    footerEl.innerHTML = `
        <button type="button" class="admin-btn-outline" data-drawer-action="discard">Discard</button>
        <button type="button" class="gy-btn admin-btn-outline" data-drawer-action="save">Save</button>
        <button type="button" class="gy-btn gy-btn-primary" data-drawer-action="save-close">Save &amp; Close</button>
    `;

    const inputs = bodyEl.querySelectorAll("[data-field]");
    inputs.forEach((el) => {
        el.addEventListener("input", () => {
            dirty = true;
        });
    });

    function collectValues() {
        const values = { ...initialValues };
        inputs.forEach((el) => {
            values[el.dataset.field] = el.value;
        });
        return values;
    }

    function validate(values) {
        let ok = true;
        bodyEl.querySelectorAll(".dt-field-error").forEach((el) => el.classList.add("d-none"));
        fields
            .filter((f) => f.required && !f.readOnly)
            .forEach((f) => {
                if (!String(values[f.key] || "").trim()) {
                    ok = false;
                    const err = bodyEl.querySelector(`[data-error-for="${f.key}"]`);
                    if (err) {
                        err.textContent = `${f.label} is required.`;
                        err.classList.remove("d-none");
                    }
                }
            });
        return ok;
    }

    async function doSave(closeAfter) {
        const values = collectValues();
        if (!validate(values)) return;
        const saveBtn = footerEl.querySelector('[data-drawer-action="save"]');
        const saveCloseBtn = footerEl.querySelector('[data-drawer-action="save-close"]');
        saveBtn.disabled = true;
        saveCloseBtn.disabled = true;
        try {
            await onSave(values);
            dirty = false;
            if (closeAfter) closeDrawer(true);
        } finally {
            saveBtn.disabled = false;
            saveCloseBtn.disabled = false;
        }
    }

    footerEl.querySelector('[data-drawer-action="discard"]').addEventListener("click", () => {
        dirty = false;
        closeDrawer(true);
    });
    footerEl.querySelector('[data-drawer-action="save"]').addEventListener("click", () => doSave(false));
    footerEl.querySelector('[data-drawer-action="save-close"]').addEventListener("click", () => doSave(true));

    open();
}

window.addEventListener("beforeunload", (e) => {
    if (dirty) {
        e.preventDefault();
        e.returnValue = "";
    }
});

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
}
function escapeAttr(value) {
    return escapeHtml(value);
}
