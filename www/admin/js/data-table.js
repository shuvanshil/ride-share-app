// A dependency-light table component shared by every admin list view,
// styled with Tabler UI components and icons.

export class DataTable {
    /**
     * @param {Object} opts
     * @param {HTMLElement} opts.container
     * @param {Array<{key:string, label:string, sortable?:boolean, render?:(row:any)=>string, width?:number}>} opts.columns
     * @param {(row:any)=>string} opts.getRowId
     * @param {(row:any)=>void} [opts.onRowClick]
     * @param {string} [opts.exportFileName]
     * @param {Array<{label:string, onClick:(ids:string[])=>void, variant?:string}>} [opts.bulkActions]
     * @param {()=>Promise<void>} [opts.onLoadMore] - called when the scroll sentinel becomes visible
     */
    constructor({ container, columns, getRowId, onRowClick, exportFileName = "export", bulkActions = [], onLoadMore }) {
        this.container = container;
        this.columns = columns;
        this.getRowId = getRowId;
        this.onRowClick = onRowClick;
        this.exportFileName = exportFileName;
        this.bulkActions = bulkActions;
        this.onLoadMore = onLoadMore;

        this.rows = [];
        this.sortKey = null;
        this.sortDir = 1;
        this.searchTerm = "";
        this.hiddenCols = new Set();
        this.selected = new Set();
        this.hasMore = false;
        this.loadingMore = false;

        this._observer = null;
        this._buildShell();
    }

    setRows(rows, { append = false, hasMore = false } = {}) {
        this.rows = append ? [...this.rows, ...rows] : rows;
        this.hasMore = hasMore;
        this.loadingMore = false;
        if (!append) this.selected.clear();
        this._renderBody();
    }

    getSelectedIds() {
        return [...this.selected];
    }

    // -------------------------------------------------------------
    _buildShell() {
        this.container.innerHTML = "";
        this.container.classList.add("dt-root");
        this.container.classList.toggle("dt-has-row-click", !!this.onRowClick);

        if (this.onRowClick) {
            const hint = document.createElement("div");
            hint.className = "dt-row-click-hint text-secondary";
            hint.innerHTML = `<i class="ti ti-info-circle me-1"></i>Click a row to view full details`;
            this.container.appendChild(hint);
        }

        const toolbar = document.createElement("div");
        toolbar.className = "dt-toolbar gap-2";

        // Search input with Tabler icon
        const searchWrap = document.createElement("div");
        searchWrap.className = "input-icon flex-fill";
        searchWrap.style.maxWidth = "260px";
        searchWrap.innerHTML = `
            <span class="input-icon-addon"><i class="ti ti-search"></i></span>
            <input type="text" class="form-control form-control-sm dt-search" placeholder="Filter loaded rows...">
        `;
        this.searchInput = searchWrap.querySelector("input");
        this.searchInput.addEventListener("input", () => {
            this.searchTerm = this.searchInput.value.trim().toLowerCase();
            this._renderBody();
        });
        toolbar.appendChild(searchWrap);

        // Columns dropdown
        const colBtn = document.createElement("div");
        colBtn.className = "dropdown";
        colBtn.innerHTML = `
            <button type="button" class="btn btn-outline-secondary btn-sm dropdown-toggle" data-bs-toggle="dropdown">
                <i class="ti ti-columns me-1"></i>Columns
            </button>
        `;
        const colMenu = document.createElement("div");
        colMenu.className = "dropdown-menu p-2 shadow-sm d-none";
        colMenu.style.minWidth = "180px";
        this.columns.forEach((col) => {
            const id = `dt-col-${col.key}`;
            const row = document.createElement("label");
            row.className = "dropdown-item form-check m-0 px-2 py-1";
            row.innerHTML = `<input type="checkbox" class="form-check-input me-2" id="${id}" checked> <span class="form-check-label">${col.label}</span>`;
            row.querySelector("input").addEventListener("change", (e) => {
                if (e.target.checked) this.hiddenCols.delete(col.key);
                else this.hiddenCols.add(col.key);
                this._applyColumnVisibility();
            });
            colMenu.appendChild(row);
        });
        colBtn.appendChild(colMenu);
        const toggleBtn = colBtn.querySelector("button");
        toggleBtn.addEventListener("click", () => colMenu.classList.toggle("d-none"));
        document.addEventListener("click", (e) => {
            if (!colBtn.contains(e.target)) colMenu.classList.add("d-none");
        });
        toolbar.appendChild(colBtn);

        // Export CSV button
        const exportCsvBtn = document.createElement("button");
        exportCsvBtn.type = "button";
        exportCsvBtn.className = "btn btn-outline-secondary btn-sm";
        exportCsvBtn.innerHTML = `<i class="ti ti-file-text me-1"></i>CSV`;
        exportCsvBtn.addEventListener("click", () => this._exportCsv());
        toolbar.appendChild(exportCsvBtn);

        // Export Excel button
        const exportXlsxBtn = document.createElement("button");
        exportXlsxBtn.type = "button";
        exportXlsxBtn.className = "btn btn-outline-secondary btn-sm";
        exportXlsxBtn.innerHTML = `<i class="ti ti-file-spreadsheet me-1"></i>Excel`;
        exportXlsxBtn.addEventListener("click", () => this._exportXlsx());
        toolbar.appendChild(exportXlsxBtn);

        // Bulk Actions Bar
        this.bulkBar = document.createElement("div");
        this.bulkBar.className = "dt-bulk-bar d-none ms-auto d-flex align-items-center gap-2";
        toolbar.appendChild(this.bulkBar);

        this.container.appendChild(toolbar);

        const scrollWrap = document.createElement("div");
        scrollWrap.className = "dt-scroll-wrap table-responsive";
        this.table = document.createElement("table");
        this.table.className = "table table-vcenter card-table table-striped table-hover dt-table m-0";
        this.thead = document.createElement("thead");
        this.tbody = document.createElement("tbody");
        this.table.appendChild(this.thead);
        this.table.appendChild(this.tbody);
        scrollWrap.appendChild(this.table);

        this.sentinel = document.createElement("div");
        this.sentinel.className = "dt-sentinel";
        scrollWrap.appendChild(this.sentinel);

        this.container.appendChild(scrollWrap);
        this._renderHead();

        if (this.onLoadMore) {
            this._observer = new IntersectionObserver((entries) => {
                if (entries[0].isIntersecting && this.hasMore && !this.loadingMore) {
                    this.loadingMore = true;
                    this.onLoadMore();
                }
            });
            this._observer.observe(this.sentinel);
        }
    }

    _renderHead() {
        const bulkTh = this.bulkActions.length
            ? `<th class="w-1"><input type="checkbox" class="form-check-input" id="dt-select-all"></th>`
            : "";
        const ths = this.columns
            .map(
                (col) => `<th data-col="${col.key}" class="${col.sortable ? "dt-sortable" : ""}" style="${col.width ? `width:${col.width}px;` : ""}">
                    <span class="dt-th-label">${col.label}</span>
                    ${col.sortable ? `<span class="dt-sort-arrow ms-1 text-muted"></span>` : ""}
                    <span class="dt-resizer"></span>
                </th>`
            )
            .join("");
        this.thead.innerHTML = `<tr>${bulkTh}${ths}</tr>`;

        if (this.bulkActions.length) {
            this.thead.querySelector("#dt-select-all").addEventListener("change", (e) => {
                if (e.target.checked) this.rows.forEach((r) => this.selected.add(this.getRowId(r)));
                else this.selected.clear();
                this._renderBody();
            });
        }

        this.columns
            .filter((c) => c.sortable)
            .forEach((col) => {
                const th = this.thead.querySelector(`th[data-col="${col.key}"]`);
                th.querySelector(".dt-th-label").addEventListener("click", () => {
                    if (this.sortKey === col.key) this.sortDir *= -1;
                    else {
                        this.sortKey = col.key;
                        this.sortDir = 1;
                    }
                    this._renderBody();
                });
            });

        // Column resize drag handling
        this.thead.querySelectorAll(".dt-resizer").forEach((handle) => {
            handle.addEventListener("mousedown", (e) => {
                e.preventDefault();
                const th = handle.closest("th");
                const startX = e.clientX;
                const startWidth = th.offsetWidth;
                const onMove = (ev) => {
                    th.style.width = `${Math.max(60, startWidth + (ev.clientX - startX))}px`;
                };
                const onUp = () => {
                    document.removeEventListener("mousemove", onMove);
                    document.removeEventListener("mouseup", onUp);
                };
                document.addEventListener("mousemove", onMove);
                document.addEventListener("mouseup", onUp);
            });
        });
    }

    _visibleRows() {
        let rows = this.rows;
        if (this.searchTerm) {
            rows = rows.filter((r) =>
                this.columns.some((c) => String(r[c.key] ?? "").toLowerCase().includes(this.searchTerm))
            );
        }
        if (this.sortKey) {
            rows = [...rows].sort((a, b) => {
                const av = a[this.sortKey] ?? "";
                const bv = b[this.sortKey] ?? "";
                if (av < bv) return -1 * this.sortDir;
                if (av > bv) return 1 * this.sortDir;
                return 0;
            });
        }
        return rows;
    }

    _renderBody() {
        const visible = this._visibleRows();
        if (visible.length === 0) {
            const colspan = this.columns.length + (this.bulkActions.length ? 1 : 0);
            this.tbody.innerHTML = `<tr><td colspan="${colspan}" class="text-center text-muted py-4">No matching rows.</td></tr>`;
        } else {
            this.tbody.innerHTML = visible
                .map((row) => {
                    const id = this.getRowId(row);
                    const checked = this.selected.has(id);
                    const bulkTd = this.bulkActions.length
                        ? `<td class="w-1"><input type="checkbox" class="form-check-input" data-row-select="${id}" ${checked ? "checked" : ""}></td>`
                        : "";
                    const tds = this.columns
                        .map((c) => `<td data-col="${c.key}">${c.render ? c.render(row) : escapeHtml(row[c.key])}</td>`)
                        .join("");
                    return `<tr data-row-id="${id}">${bulkTd}${tds}</tr>`;
                })
                .join("");

            if (this.onRowClick) {
                this.tbody.querySelectorAll("tr").forEach((tr) => {
                    tr.addEventListener("click", (e) => {
                        if (e.target.matches("input[type=checkbox]")) return;
                        const row = this.rows.find((r) => this.getRowId(r) === tr.dataset.rowId);
                        if (row) this.onRowClick(row);
                    });
                });
            }
            if (this.bulkActions.length) {
                this.tbody.querySelectorAll("[data-row-select]").forEach((cb) => {
                    cb.addEventListener("click", (e) => e.stopPropagation());
                    cb.addEventListener("change", (e) => {
                        const id = cb.dataset.rowSelect;
                        if (e.target.checked) this.selected.add(id);
                        else this.selected.delete(id);
                        this._renderBulkBar();
                    });
                });
            }
        }
        this._applyColumnVisibility();
        this._renderBulkBar();
        this._updateSortArrows();
    }

    _renderBulkBar() {
        if (!this.bulkActions.length) return;
        if (this.selected.size === 0) {
            this.bulkBar.classList.add("d-none");
            return;
        }
        this.bulkBar.classList.remove("d-none");
        this.bulkBar.innerHTML =
            `<span class="badge bg-secondary-lt me-2">${this.selected.size} selected</span>` +
            this.bulkActions
                .map((a, i) => `<button type="button" class="btn btn-outline-secondary btn-sm" data-bulk="${i}">${a.label}</button>`)
                .join("");
        this.bulkBar.querySelectorAll("[data-bulk]").forEach((btn) => {
            btn.addEventListener("click", () => {
                const action = this.bulkActions[Number(btn.dataset.bulk)];
                action.onClick(this.getSelectedIds());
            });
        });
    }

    _applyColumnVisibility() {
        this.columns.forEach((col) => {
            const hidden = this.hiddenCols.has(col.key);
            this.container.querySelectorAll(`[data-col="${col.key}"]`).forEach((el) => {
                el.classList.toggle("d-none", hidden);
            });
        });
    }

    _updateSortArrows() {
        this.thead.querySelectorAll("th.dt-sortable .dt-sort-arrow").forEach((el) => (el.innerHTML = ""));
        if (!this.sortKey) return;
        const th = this.thead.querySelector(`th[data-col="${this.sortKey}"] .dt-sort-arrow`);
        if (th) th.innerHTML = this.sortDir === 1 ? `<i class="ti ti-chevron-up"></i>` : `<i class="ti ti-chevron-down"></i>`;
    }

    _exportCsv() {
        const rows = this._visibleRows();
        const cols = this.columns.filter((c) => !this.hiddenCols.has(c.key));
        const header = cols.map((c) => csvCell(c.label)).join(",");
        const lines = rows.map((r) => cols.map((c) => csvCell(r[c.key])).join(","));
        const blob = new Blob([[header, ...lines].join("\n")], { type: "text/csv;charset=utf-8;" });
        downloadBlob(blob, `${this.exportFileName}.csv`);
    }

    _exportXlsx() {
        if (typeof XLSX === "undefined") {
            downloadFallbackNotice();
            return;
        }
        const rows = this._visibleRows();
        const cols = this.columns.filter((c) => !this.hiddenCols.has(c.key));
        const data = rows.map((r) => Object.fromEntries(cols.map((c) => [c.label, r[c.key] ?? ""])));
        const ws = XLSX.utils.json_to_sheet(data);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Data");
        XLSX.writeFile(wb, `${this.exportFileName}.xlsx`);
    }
}

function csvCell(value) {
    const s = String(value ?? "").replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

function downloadFallbackNotice() {
    alert("Excel export library did not load. Try again in a moment, or use Export CSV.");
}

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
    }[c]));
}
