const DB_NAME = "fotostock";
const STORE = "kv";
const DATA_KEY = "data";
const BACKUP_REMINDER_DAYS = 7;

// Base categories ship with the app; users add their own (state.categories) and can
// delete any (base ones are hidden via state.hiddenCategories).
const baseCategories = [
  { id: "camaras", label: "Cámaras" },
  { id: "lentes", label: "Lentes" },
  { id: "flashes", label: "Flashes" },
  { id: "tripodes", label: "Trípodes" },
  { id: "filtros", label: "Filtros" },
  { id: "triggers", label: "Triggers" },
  { id: "memorias", label: "Memorias" },
  { id: "luces", label: "Luces continuas" },
  { id: "modificadores", label: "Modificadores" },
  { id: "microfonos", label: "Micrófonos" },
  { id: "estabilizadores", label: "Estabilizadores" },
  { id: "baterias", label: "Baterías" },
  { id: "gadgets", label: "Gadgets" },
];

// Where items land when their category is deleted. Never offered in the form.
const UNCATEGORIZED = { id: "sin-categoria", label: "Sin categoría" };

// Only these are stored; "paquete" and "prestado" are derived (see displayStatus).
const manualStatuses = ["disponible", "mantenimiento", "perdido"];
const conditions = ["Excelente", "Muy bueno", "Bueno", "Revision"];

const statusLabels = {
  disponible: "Disponible",
  paquete: "En paquete",
  prestado: "Prestado",
  mantenimiento: "Mantenimiento",
  perdido: "Extraviado",
};

const statusClass = {
  disponible: "success",
  paquete: "blue",
  prestado: "loan",
  mantenimiento: "purple",
  perdido: "danger",
};

const icons = {
  dashboard: '<path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"/>',
  inventory: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  packages: '<path d="M10 6h10M10 12h10M10 18h10M3.5 6l1.5 1.5L7.5 5M3.5 12l1.5 1.5 2.5-2.5M3.5 18l1.5 1.5 2.5-2.5"/>',
  backup: '<path d="M12 3v12M8 11l4 4 4-4M4 17v3h16v-3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16zM13 7l4 4"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  back: '<path d="M9 14l-4-4 4-4M5 10h10a4 4 0 010 8h-3"/>',
};

const state = {
  inventory: [],
  packages: [],
  categories: [],
  hiddenCategories: [],
  meta: { lastBackupAt: "", changedAt: "" },
  persisted: false,
  ui: {
    view: "dashboard",
    category: "todos",
    packageId: null,
    checklistMode: "salida",
    loading: true,
    error: "",
    search: "",
    statusFilter: "todos",
    conditionFilter: "todos",
  },
};

let modal = null;
let toastTimer = null;
let installPrompt = null;
const dbPromise = openDb();

init();

async function init() {
  render();
  try {
    Object.assign(state, normalizeData((await idb("readonly", (store) => store.get(DATA_KEY))) || {}));
  } catch (error) {
    state.ui.error = `No se pudo abrir el almacenamiento de este navegador (${error?.message || error}). Si estás en modo incógnito, abre la app en una ventana normal.`;
  }
  state.ui.loading = false;
  render();

  navigator.storage?.persist?.().then((granted) => (state.persisted = granted)).catch(() => {});
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  if (state.ui.view === "backup") render();
});

// ---------- Local storage (IndexedDB) ----------

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idb(mode, fn) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// shortcut: whole dataset saved as one record, last write wins across tabs; fine for a personal gear list.
async function commit(message, { touch = true } = {}) {
  if (touch) state.meta.changedAt = new Date().toISOString();
  try {
    await idb("readwrite", (store) =>
      store.put(
        {
          inventory: state.inventory,
          packages: state.packages,
          categories: state.categories,
          hiddenCategories: state.hiddenCategories,
          meta: state.meta,
        },
        DATA_KEY,
      ),
    );
  } catch (error) {
    render();
    showToast(`No se pudo guardar en el dispositivo: ${error?.message || error}`, "danger");
    return false;
  }
  render();
  if (message) showToast(message);
  return true;
}

// Used both for stored data and for imported backups (untrusted input).
function normalizeData(raw) {
  const now = new Date().toISOString();
  const str = (value, max = 300) => (value == null ? "" : String(value)).trim().slice(0, max);
  const isoDate = (value) => (/^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "");
  const baseIds = baseCategories.map((category) => category.id);
  const hiddenCategories = baseIds.filter((id) => Array.isArray(raw.hiddenCategories) && raw.hiddenCategories.includes(id));
  const categoryIds = new Set(baseIds);
  const customCategories = (Array.isArray(raw.categories) ? raw.categories : [])
    .filter((category) => category && typeof category === "object" && str(category.label))
    .map((category) => {
      let id = str(category.id, 64);
      if (!id || categoryIds.has(id)) id = uid();
      categoryIds.add(id);
      return { id, label: str(category.label, 40) };
    });
  hiddenCategories.forEach((id) => categoryIds.delete(id));
  const seen = new Set();

  const inventory = (Array.isArray(raw.inventory) ? raw.inventory : [])
    .filter((item) => item && typeof item === "object" && str(item.name))
    .map((item) => {
      let id = str(item.id, 64);
      if (!id || seen.has(id)) id = uid();
      seen.add(id);
      return {
        id,
        name: str(item.name, 120),
        category: categoryIds.has(item.category) ? item.category : UNCATEGORIZED.id,
        description: str(item.description, 2000),
        quantity: Math.min(Math.max(Math.trunc(Number(item.quantity)) || 1, 1), 9999),
        serial: str(item.serial, 80),
        location: str(item.location, 120),
        status: manualStatuses.includes(item.status) ? item.status : "disponible",
        condition: conditions.includes(item.condition) ? item.condition : "Bueno",
        notes: str(item.notes, 2000),
        loan_to: str(item.loan_to, 120),
        loan_since: isoDate(item.loan_since),
        created_at: str(item.created_at, 40) || now,
        updated_at: str(item.updated_at, 40) || now,
      };
    });

  const packages = (Array.isArray(raw.packages) ? raw.packages : [])
    .filter((pkg) => pkg && typeof pkg === "object" && str(pkg.name))
    .map((pkg) => {
      const items = [...new Set((Array.isArray(pkg.items) ? pkg.items : []).map(String))].filter((id) =>
        seen.has(id),
      );
      const checks = (mode) =>
        Object.fromEntries(items.filter((id) => pkg.checklist?.[mode]?.[id] === true).map((id) => [id, true]));
      return {
        id: str(pkg.id, 64) || uid(),
        name: str(pkg.name, 120),
        client: str(pkg.client, 120),
        date: isoDate(pkg.date || pkg.session_date),
        notes: str(pkg.notes, 2000),
        items,
        units: Object.fromEntries(
          items.filter((id) => Number(pkg.units?.[id]) >= 1).map((id) => [id, Math.min(Math.trunc(Number(pkg.units[id])), 9999)]),
        ),
        checklist: { salida: checks("salida"), regreso: checks("regreso") },
        closed_at: str(pkg.closed_at, 40) || null,
        created_at: str(pkg.created_at, 40) || now,
      };
    });

  return {
    inventory,
    packages,
    categories: customCategories,
    hiddenCategories,
    meta: { lastBackupAt: str(raw.meta?.lastBackupAt, 40), changedAt: str(raw.meta?.changedAt, 40) },
  };
}

// ---------- Derived data ----------

function displayStatus(item) {
  if (item.loan_to) return "prestado";
  if (item.status !== "disponible") return item.status;
  return openPackages().some((pkg) => pkg.items.includes(item.id)) ? "paquete" : "disponible";
}

function openPackages() {
  return state.packages.filter((pkg) => !pkg.closed_at);
}

function getPackage() {
  return (
    state.packages.find((pkg) => pkg.id === state.ui.packageId) || openPackages()[0] || state.packages[0] || null
  );
}

// Return checklist only covers what actually left at salida.
function checklistItems(pkg, mode) {
  return mode === "salida" ? pkg.items : pkg.items.filter((id) => pkg.checklist.salida[id]);
}

function packageProgress(pkg, mode) {
  const items = checklistItems(pkg, mode);
  if (!items.length) return 0;
  return Math.round((items.filter((id) => pkg.checklist[mode][id]).length / items.length) * 100);
}

function needsBackup() {
  if (!state.inventory.length) return false;
  if (!state.meta.lastBackupAt) return true;
  const stale = Date.now() - Date.parse(state.meta.lastBackupAt) > BACKUP_REMINDER_DAYS * 864e5;
  return stale && state.meta.changedAt > state.meta.lastBackupAt;
}

function inventoryById(id) {
  return state.inventory.find((item) => item.id === id);
}

// Units taken to a production; defaults to all of them and never exceeds what exists.
function unitsIn(pkg, item) {
  return Math.min(pkg.units[item.id] || item.quantity, item.quantity);
}

function qty(item) {
  return item.quantity > 1 ? ` <span class="small">×${item.quantity}</span>` : "";
}

function categoryById(id) {
  return allCategories().find((category) => category.id === id) || UNCATEGORIZED;
}

function allCategories() {
  return [...baseCategories.filter((c) => !state.hiddenCategories.includes(c.id)), ...state.categories];
}

// "Sin categoría" only shows up while some item is in it.
function listedCategories() {
  const orphans = state.inventory.some((item) => item.category === UNCATEGORIZED.id);
  return orphans ? [...allCategories(), UNCATEGORIZED] : allCategories();
}

// ---------- Rendering ----------

function render() {
  document.querySelector("#app").innerHTML = renderShell();
}

function renderShell() {
  const nav = [
    ["dashboard", "Panel"],
    ["inventory", "Inventario"],
    ["packages", "Producciones"],
    ["backup", "Respaldo"],
  ];

  return `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <span class="brand-mark"></span>
          <div>
            <h1>FotoStock</h1>
            <span>Inventario fotográfico</span>
          </div>
        </div>
        <nav class="nav">
          ${nav
            .map(
              ([id, label]) => `
                <button class="nav-button ${state.ui.view === id ? "is-active" : ""}" data-view="${id}">
                  ${icon(id)}
                  <span>${label}</span>
                </button>
              `,
            )
            .join("")}
        </nav>
        <div class="sidebar-footer">Tus datos se guardan solo en este dispositivo.</div>
      </aside>
      <main class="main">
        ${renderActiveView()}
      </main>
    </div>
    ${modal ? renderModal() : ""}
  `;
}

function renderActiveView() {
  if (state.ui.loading) return `<section class="card empty">Cargando inventario...</section>`;
  if (state.ui.error) {
    return `
      ${renderTopbar("No se pudo cargar", "", `<button class="button primary" data-reload>Reintentar</button>`)}
      <section class="card empty">${esc(state.ui.error)}</section>
    `;
  }
  if (state.ui.view === "inventory") return renderInventoryView();
  if (state.ui.view === "packages") return renderPackagesView();
  if (state.ui.view === "backup") return renderBackupView();
  return renderDashboard();
}

function renderTopbar(title, subtitle, actions = "") {
  return `
    <header class="topbar">
      <div class="page-title">
        <h2>${title}</h2>
        ${subtitle ? `<p>${subtitle}</p>` : ""}
      </div>
      <div class="actions">${actions}</div>
    </header>
  `;
}

function renderBackupBanner() {
  if (!needsBackup()) return "";
  const last = state.meta.lastBackupAt ? `Último respaldo: ${formatDate(state.meta.lastBackupAt)}.` : "Aún no has hecho ningún respaldo.";
  return `
    <div class="notice warning banner">
      <span><strong>Tu inventario solo vive en este dispositivo.</strong> ${last} Si borras el navegador o cambias de teléfono lo perderías.</span>
      <button class="button primary" data-export>Respaldar ahora</button>
    </div>
  `;
}

function renderDashboard() {
  const counts = state.inventory.reduce((acc, item) => {
    const status = displayStatus(item);
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  const loaned = state.inventory.filter((item) => item.loan_to);
  const pkg = openPackages()[0];

  return `
    ${renderTopbar(
      "Panel",
      "",
      `<button class="button primary" data-open-modal="item">+ Material</button>
       <button class="button" data-open-modal="package">+ Producción</button>`,
    )}
    ${renderBackupBanner()}
    <section class="grid stats-grid">
      ${renderMetric("Total", state.inventory.length, "todos")}
      ${renderMetric("Disponible", counts.disponible || 0, "disponible")}
      ${renderMetric("En paquete", counts.paquete || 0, "paquete")}
      ${renderMetric("Prestado", counts.prestado || 0, "prestado")}
      ${renderMetric("Mantenimiento", counts.mantenimiento || 0, "mantenimiento")}
      ${counts.perdido ? renderMetric("Extraviado", counts.perdido, "perdido") : ""}
    </section>
    ${
      loaned.length
        ? `
          <section class="section card loan-panel">
            <div class="section-header"><h3>Equipo prestado</h3></div>
            <div class="list-compact">${loaned.map(renderLoanRow).join("")}</div>
          </section>
        `
        : ""
    }
    <section class="section grid content-grid">
      <div>
        <div class="section-header"><h3>Categorías</h3></div>
        <div class="category-strip">
          ${listedCategories()
            .map((category) => {
              const count = state.inventory.filter((item) => item.category === category.id).length;
              return `<button class="chip" data-category-jump="${esc(category.id)}">${esc(category.label)} <b>${count}</b></button>`;
            })
            .join("")}
        </div>
        <div class="section-header section">
          <h3>Material reciente</h3>
          <button class="button ghost" data-view="inventory">Ver todo</button>
        </div>
        <div class="inventory-list">
          ${
            state.inventory.length
              ? state.inventory.slice(0, 5).map(renderItemRow).join("")
              : `<div class="card empty">Aún no hay material. Agrega el primer equipo con "+ Material".</div>`
          }
        </div>
      </div>
      <aside class="side-panel card">
        <div class="section-header">
          <div>
            <h3>Producción activa</h3>
            <p>${pkg ? esc(pkg.name) : "Ninguna en curso"}</p>
          </div>
        </div>
        ${
          pkg
            ? `
              <div class="list-compact">
                ${renderProgress("Salida", pkg, "salida")}
                ${renderProgress("Regreso", pkg, "regreso")}
                <button class="button primary" data-select-package="${esc(pkg.id)}">Abrir checklist</button>
              </div>
            `
            : `<div class="empty small-empty">Crea una producción para preparar el material.</div>`
        }
      </aside>
    </section>
  `;
}

function renderMetric(label, value, status) {
  return `
    <button class="card metric ${status === "prestado" && value ? "is-loan" : ""}" data-status-jump="${status}">
      <span>${label}</span>
      <b>${value}</b>
    </button>
  `;
}

function renderLoanRow(item) {
  return `
    <div class="compact-row loan-row">
      <span>
        <strong>${esc(item.name)}</strong>
        <div class="small">${esc(item.loan_to)}${item.loan_since ? ` · ${daysAgo(item.loan_since)}` : ""}</div>
      </span>
      <button class="button" data-return-loan="${esc(item.id)}">Devuelto</button>
    </div>
  `;
}

function renderInventoryView() {
  const chip = (id, label) =>
    `<button class="chip ${state.ui.category === id ? "is-active" : ""}" data-category="${esc(id)}">${esc(label)}</button>`;

  return `
    ${renderTopbar("Inventario", "", `<button class="button primary" data-open-modal="item">+ Nuevo material</button>`)}
    <section>
      <div class="category-strip">${chip("todos", "Todos")}${listedCategories().map((c) => chip(c.id, c.label)).join("")}
        <button class="chip" data-add-category>+ Categoría</button>
        ${state.categories.some((c) => c.id === state.ui.category) ? `<button class="chip" data-rename-category>${icon("edit")} Renombrar</button>` : ""}
        ${allCategories().some((c) => c.id === state.ui.category) ? `<button class="chip danger" data-delete-category>${icon("trash")} Borrar</button>` : ""}
      </div>
      <div class="toolbar">
        <input type="search" data-search placeholder="Buscar nombre, serial, ubicación o persona" value="${esc(state.ui.search)}" />
        <select data-status-filter aria-label="Filtrar por estado">
          <option value="todos">Todos los estados</option>
          ${Object.entries(statusLabels)
            .map(([value, label]) => `<option value="${value}" ${state.ui.statusFilter === value ? "selected" : ""}>${label}</option>`)
            .join("")}
        </select>
        <select data-condition-filter aria-label="Filtrar por condición">
          <option value="todos">Todas las condiciones</option>
          ${conditions.map((value) => `<option ${state.ui.conditionFilter === value ? "selected" : ""}>${value}</option>`).join("")}
        </select>
      </div>
      <div class="inventory-list" data-rows>${renderInventoryRows()}</div>
    </section>
  `;
}

function renderInventoryRows() {
  const search = state.ui.search.trim().toLowerCase();
  const rows = state.inventory.filter((item) => {
    const matchesCategory = state.ui.category === "todos" || item.category === state.ui.category;
    const matchesSearch =
      !search ||
      [item.name, item.description, item.serial, item.location, item.notes, item.loan_to].some((value) =>
        value.toLowerCase().includes(search),
      );
    const matchesStatus = state.ui.statusFilter === "todos" || displayStatus(item) === state.ui.statusFilter;
    const matchesCondition = state.ui.conditionFilter === "todos" || item.condition === state.ui.conditionFilter;
    return matchesCategory && matchesSearch && matchesStatus && matchesCondition;
  });

  if (!state.inventory.length) return `<div class="card empty">Aún no hay material registrado.</div>`;
  if (!rows.length) return `<div class="card empty">No hay material con esos filtros.</div>`;
  return rows.map(renderItemRow).join("");
}

function renderItemRow(item) {
  const status = displayStatus(item);
  const details = [categoryById(item.category).label, item.serial, item.location].filter(Boolean).map(esc).join(" · ");
  return `
    <article class="card item-row ${item.loan_to ? "is-loaned" : ""}" data-peek-item="${esc(item.id)}">
      <div class="item-title">
        <strong>${esc(item.name)}${qty(item)}</strong>
        <span>${details}</span>
        ${item.loan_to ? `<span class="loan-line">Prestado a ${esc(item.loan_to)}${item.loan_since ? ` · ${daysAgo(item.loan_since)}` : ""}</span>` : ""}
      </div>
      <div class="item-tags">
        <span class="tag ${statusClass[status]}">${statusLabels[status]}</span>
        <span class="tag">${esc(item.condition)}</span>
        ${item.loan_to ? `<button class="button compact" data-return-loan="${esc(item.id)}">${icon("back")} Devuelto</button>` : ""}
      </div>
      <div class="actions">
        <button class="button icon-only" aria-label="Editar ${esc(item.name)}" data-edit-item="${esc(item.id)}">${icon("edit")}</button>
        <button class="button icon-only danger" aria-label="Eliminar ${esc(item.name)}" data-delete-item="${esc(item.id)}">${icon("trash")}</button>
      </div>
    </article>
  `;
}

function renderPeek(item) {
  const details = [
    ["Categoría", categoryById(item.category).label],
    ["Unidades", item.quantity],
    ["Serial", item.serial],
    ["Ubicación", item.location],
    ["Estado", statusLabels[displayStatus(item)]],
    ["Condición", item.condition],
    ["Prestado a", item.loan_to],
  ].filter(([, value]) => value);
  return `
    <strong>${esc(item.name)}</strong>
    <p>${item.description ? esc(item.description) : `<span class="small">Sin descripción.</span>`}</p>
    <dl>${details.map(([label, value]) => `<dt>${label}</dt><dd>${esc(value)}</dd>`).join("")}</dl>
    ${item.notes ? `<p class="small"><b>Notas:</b> ${esc(item.notes)}</p>` : ""}
  `;
}

function renderPackagesView() {
  const pkg = getPackage();
  const sorted = [...openPackages(), ...state.packages.filter((entry) => entry.closed_at)];
  return `
    ${renderTopbar("Producciones", "", `<button class="button primary" data-open-modal="package">+ Nueva producción</button>`)}
    <section class="package-layout">
      <aside class="card side-panel">
        <div class="list-compact package-list">
          ${
            sorted.length
              ? sorted
                  .map(
                    (entry) => `
                      <button class="compact-row ${entry.id === pkg?.id ? "is-active" : ""}" data-select-package="${esc(entry.id)}">
                        <span>
                          <strong>${esc(entry.name)}</strong>
                          <div class="small">${entry.date ? formatDate(entry.date) : "Sin fecha"} · ${entry.items.length} equipos</div>
                        </span>
                        ${entry.closed_at ? `<span class="tag">Finalizada</span>` : `<span class="small">${packageProgress(entry, "salida")}% / ${packageProgress(entry, "regreso")}%</span>`}
                      </button>
                    `,
                  )
                  .join("")
              : `<div class="empty small-empty">Aún no hay producciones.</div>`
          }
        </div>
      </aside>
      <div>${pkg ? renderPackageDetail(pkg) : `<div class="card empty">Crea una producción para armar el checklist.</div>`}</div>
    </section>
  `;
}

function renderPackageDetail(pkg) {
  const mode = state.ui.checklistMode;
  const closed = Boolean(pkg.closed_at);
  const items = checklistItems(pkg, mode);
  const done = items.filter((id) => pkg.checklist[mode][id]).length;
  const meta = [pkg.client, pkg.date && formatDate(pkg.date)].filter(Boolean).map(esc).join(" · ");

  return `
    <section class="card package-card">
      <div class="section-header">
        <div>
          <h3>${esc(pkg.name)} ${closed ? `<span class="tag">Finalizada</span>` : ""}</h3>
          ${meta ? `<p>${meta}</p>` : ""}
          ${pkg.notes ? `<p>${esc(pkg.notes)}</p>` : ""}
        </div>
        <div class="actions">
          ${closed ? "" : `<button class="button" data-open-modal="package-items">Elegir material</button>`}
          <button class="button" data-duplicate-package="${esc(pkg.id)}">Duplicar</button>
          <button class="button icon-only danger" aria-label="Eliminar producción" data-delete-package="${esc(pkg.id)}">${icon("trash")}</button>
        </div>
      </div>
      <div class="split">
        ${renderProgress("Salida", pkg, "salida")}
        ${renderProgress("Regreso", pkg, "regreso")}
      </div>
      <div class="section-header section">
        <div class="tabs">
          <button class="tab ${mode === "salida" ? "is-active" : ""}" data-check-mode="salida">Salida</button>
          <button class="tab ${mode === "regreso" ? "is-active" : ""}" data-check-mode="regreso">Regreso</button>
        </div>
        <span class="small">${done} de ${items.length} marcados</span>
      </div>
      <div class="checklist">
        ${
          items.length
            ? items
                .map((id) => {
                  const item = inventoryById(id);
                  if (!item) return "";
                  const checked = Boolean(pkg.checklist[mode][id]);
                  return `
                    <label class="check-row ${checked ? "is-checked" : ""}">
                      <input type="checkbox" data-check-item="${esc(item.id)}" ${checked ? "checked" : ""} ${closed ? "disabled" : ""} />
                      <span>
                        <strong>${esc(item.name)}${item.quantity > 1 ? ` <span class="small">×${unitsIn(pkg, item)}</span>` : ""}</strong>
                        <div class="small">${[categoryById(item.category).label, item.serial].filter(Boolean).map(esc).join(" · ")}</div>
                      </span>
                    </label>
                  `;
                })
                .join("")
            : `<div class="empty small-empty">${
                mode === "salida" ? "Elige el material que vas a llevar." : "Marca primero el material que salió."
              }</div>`
        }
      </div>
      ${closed ? "" : `<button class="button primary finish" data-finish-package="${esc(pkg.id)}">Finalizar producción</button>`}
    </section>
  `;
}

function renderProgress(label, pkg, mode) {
  const value = packageProgress(pkg, mode);
  return `
    <div>
      <div class="small progress-label"><span>${label}</span><span>${value}%</span></div>
      <div class="progress ${value === 100 ? "is-complete" : ""}" style="--value: ${value}%"><span></span></div>
    </div>
  `;
}

function renderBackupView() {
  return `
    ${renderTopbar("Respaldo", "Tu inventario se guarda solo en este dispositivo. Exporta un respaldo de vez en cuando y guárdalo en Drive, iCloud o WhatsApp.")}
    <section class="grid backup-grid">
      <article class="card pad">
        <h3>Copia de seguridad</h3>
        <p class="small">${state.inventory.length} equipos · ${state.packages.length} producciones</p>
        <p class="small">Último respaldo: ${state.meta.lastBackupAt ? formatDate(state.meta.lastBackupAt) : "nunca"}</p>
        <p class="small">Almacenamiento protegido: ${state.persisted ? "sí" : "no garantizado (instala la app para protegerlo)"}</p>
        <div class="actions start">
          <button class="button primary" data-export>${icon("backup")} Exportar respaldo</button>
          <label class="button">
            Importar respaldo
            <input type="file" accept="application/json,.json" data-import hidden />
          </label>
        </div>
      </article>
      <article class="card pad">
        <h3>Instalar en el teléfono</h3>
        <p class="small"><strong>Android (Chrome):</strong> menú ⋮ → "Instalar app" o "Agregar a pantalla principal".</p>
        <p class="small"><strong>iPhone (Safari):</strong> botón Compartir → "Agregar a inicio".</p>
        <p class="small">Una vez instalada funciona sin internet.</p>
        ${installPrompt ? `<button class="button primary" data-install>Instalar ahora</button>` : ""}
      </article>
    </section>
  `;
}

function renderModal() {
  if (modal.type === "item") return renderItemModal(modal.itemId && inventoryById(modal.itemId));
  if (modal.type === "package") return renderPackageModal();
  if (modal.type === "package-items") return renderPackageItemsModal();
  return "";
}

function renderModalFrame(title, subtitle, body, formAttrs) {
  return `
    <div class="modal-backdrop" data-close-modal>
      <form class="modal card" ${formAttrs}>
        <div class="modal-header">
          <div>
            <h3>${title}</h3>
            ${subtitle ? `<p class="small">${subtitle}</p>` : ""}
          </div>
          <button class="button icon-only" type="button" aria-label="Cerrar" data-close-modal>✕</button>
        </div>
        ${body}
      </form>
    </div>
  `;
}

function renderItemModal(item) {
  const isEdit = Boolean(item);
  const category = item?.category || modal.category;
  const options = (values, current) =>
    values.map(([value, label]) => `<option value="${value}" ${current === value ? "selected" : ""}>${label}</option>`).join("");

  return renderModalFrame(
    isEdit ? "Editar material" : "Nuevo material",
    "Solo el nombre es obligatorio.",
    `
      <div class="form-stack">
        <div class="split">
          <div class="field">
            <label for="f-name">Nombre</label>
            <input id="f-name" name="name" required maxlength="120" placeholder="Ej. Sony A7 III" value="${esc(item?.name || "")}" />
          </div>
          <div class="field">
            <label for="f-category">Categoría</label>
            <select id="f-category" name="category">
              ${category === UNCATEGORIZED.id ? `<option value="" disabled selected>${UNCATEGORIZED.label}</option>` : ""}
              ${options(allCategories().map((c) => [esc(c.id), esc(c.label)]), category)}
            </select>
          </div>
        </div>
        <div class="field">
          <label for="f-description">Descripción</label>
          <textarea id="f-description" name="description" maxlength="2000" placeholder="Qué es: modelo, specs, accesorios incluidos">${esc(item?.description || "")}</textarea>
        </div>
        <div class="split">
          <div class="field">
            <label for="f-quantity">Unidades</label>
            <input id="f-quantity" name="quantity" type="number" min="1" max="9999" step="1" required value="${item?.quantity || 1}" />
          </div>
          <div class="field">
            <label for="f-serial">Serial / placa</label>
            <input id="f-serial" name="serial" maxlength="80" value="${esc(item?.serial || "")}" />
          </div>
        </div>
        <div class="field">
          <label for="f-location">Ubicación</label>
          <input id="f-location" name="location" maxlength="120" placeholder="Ej. Maleta 1" value="${esc(item?.location || "")}" />
        </div>
        <div class="split">
          <div class="field">
            <label for="f-status">Estado</label>
            <select id="f-status" name="status">${options(manualStatuses.map((s) => [s, statusLabels[s]]), item?.status)}</select>
          </div>
          <div class="field">
            <label for="f-condition">Condición</label>
            <select id="f-condition" name="condition">${options(conditions.map((c) => [c, c]), item?.condition || "Bueno")}</select>
          </div>
        </div>
        <fieldset class="loan-fields">
          <legend>Préstamo</legend>
          <div class="split">
            <div class="field">
              <label for="f-loan-to">Prestado a</label>
              <input id="f-loan-to" name="loan_to" maxlength="120" placeholder="Vacío si lo tienes tú" value="${esc(item?.loan_to || "")}" />
            </div>
            <div class="field">
              <label for="f-loan-since">Desde</label>
              <input id="f-loan-since" name="loan_since" type="date" value="${esc(item?.loan_since || "")}" />
            </div>
          </div>
        </fieldset>
        <div class="field">
          <label for="f-notes">Notas</label>
          <textarea id="f-notes" name="notes" maxlength="2000" placeholder="Observaciones: golpes, fallas, a quién se le compró...">${esc(item?.notes || "")}</textarea>
        </div>
        <div class="actions">
          <button class="button primary" type="submit">${isEdit ? "Guardar cambios" : "Guardar"}</button>
          ${isEdit ? "" : `<button class="button" type="submit" value="again">Guardar y agregar otro</button>`}
        </div>
      </div>
    `,
    `data-item-form data-id="${esc(item?.id || "")}"`,
  );
}

function renderPackageModal() {
  return renderModalFrame(
    "Nueva producción",
    "Luego eliges el material que vas a llevar.",
    `
      <div class="form-stack">
        <div class="field">
          <label for="p-name">Nombre</label>
          <input id="p-name" name="name" required maxlength="120" placeholder="Ej. Boda campestre" />
        </div>
        <div class="split">
          <div class="field">
            <label for="p-client">Cliente</label>
            <input id="p-client" name="client" maxlength="120" />
          </div>
          <div class="field">
            <label for="p-date">Fecha</label>
            <input id="p-date" name="date" type="date" />
          </div>
        </div>
        <div class="field">
          <label for="p-notes">Notas</label>
          <textarea id="p-notes" name="notes" maxlength="2000" placeholder="Lugar, responsable, necesidades especiales..."></textarea>
        </div>
        <button class="button primary" type="submit">Crear y elegir material</button>
      </div>
    `,
    "data-package-form",
  );
}

function renderPackageItemsModal() {
  const pkg = getPackage();
  if (!pkg) return "";
  const selected = new Set(pkg.items);

  return renderModalFrame(
    "Material de la producción",
    esc(pkg.name),
    `
      <input type="search" class="pick-search" data-pick-search placeholder="Filtrar material" />
      <div class="selector-list">
        ${
          state.inventory.length
            ? state.inventory
                .map((item) => {
                  const status = displayStatus(item);
                  const blocked = !selected.has(item.id) && !["disponible", "paquete"].includes(status);
                  return `
                    <label class="selectable ${blocked ? "is-blocked" : ""}" data-pick-text="${esc(`${item.name} ${item.serial} ${categoryById(item.category).label}`.toLowerCase())}">
                      <input type="checkbox" name="items" value="${esc(item.id)}" ${selected.has(item.id) ? "checked" : ""} ${blocked ? "disabled" : ""} />
                      <span>
                        <strong>${esc(item.name)}${qty(item)}</strong>
                        <div class="small">${[categoryById(item.category).label, item.serial].filter(Boolean).map(esc).join(" · ")}</div>
                        ${
                          item.quantity > 1
                            ? `<div class="small units-pick">Llevar <input type="number" name="units-${esc(item.id)}" min="1" max="${item.quantity}" step="1" value="${unitsIn(pkg, item)}" aria-label="Unidades de ${esc(item.name)}" ${blocked ? "disabled" : ""} /> de ${item.quantity}</div>`
                            : ""
                        }
                      </span>
                      <span class="tag ${statusClass[status]}">${statusLabels[status]}</span>
                    </label>
                  `;
                })
                .join("")
            : `<div class="empty small-empty">Agrega material al inventario primero.</div>`
        }
      </div>
      <div class="modal-actions">
        <button class="button primary" type="submit">Guardar material</button>
      </div>
    `,
    "data-package-items-form",
  );
}

// ---------- Events (delegated once, so re-rendering never loses listeners) ----------

const clickActions = [
  ["data-view", (el) => setView(el.dataset.view)],
  ["data-reload", () => location.reload()],
  ["data-open-modal", (el) => openModal({ type: el.dataset.openModal, category: state.ui.category })],
  ["data-category", (el) => ((state.ui.category = el.dataset.category), render())],
  ["data-category-jump", (el) => ((state.ui.category = el.dataset.categoryJump), (state.ui.statusFilter = "todos"), setView("inventory"))],
  ["data-status-jump", (el) => ((state.ui.statusFilter = el.dataset.statusJump), (state.ui.category = "todos"), setView("inventory"))],
  ["data-add-category", () => saveCategory()],
  ["data-rename-category", () => saveCategory(state.categories.find((c) => c.id === state.ui.category))],
  ["data-delete-category", () => deleteCategory(state.ui.category)],
  ["data-edit-item", (el) => openModal({ type: "item", itemId: el.dataset.editItem })],
  ["data-delete-item", (el) => deleteInventoryItem(el.dataset.deleteItem)],
  ["data-return-loan", (el) => returnLoan(el.dataset.returnLoan)],
  ["data-select-package", (el) => ((state.ui.packageId = el.dataset.selectPackage), setView("packages"))],
  ["data-check-mode", (el) => ((state.ui.checklistMode = el.dataset.checkMode), render())],
  ["data-duplicate-package", (el) => duplicatePackage(el.dataset.duplicatePackage)],
  ["data-delete-package", (el) => deletePackage(el.dataset.deletePackage)],
  ["data-finish-package", (el) => finishPackage(el.dataset.finishPackage)],
  ["data-export", () => exportBackup()],
  ["data-install", () => installPrompt?.prompt()],
  // Last: the backdrop wraps every modal button, so it must not shadow them.
  ["data-close-modal", (el, event) => (event.target === el || el.tagName === "BUTTON") && closeModal()],
];

document.addEventListener("click", (event) => {
  for (const [attr, action] of clickActions) {
    const el = event.target.closest(`[${attr}]`);
    if (el) return action(el, event);
  }
});

document.addEventListener("input", (event) => {
  const el = event.target;
  if (el.matches("[data-search]")) {
    state.ui.search = el.value;
    refreshRows();
  }
  if (el.matches("[data-pick-search]")) {
    const query = el.value.trim().toLowerCase();
    document.querySelectorAll("[data-pick-text]").forEach((row) => {
      row.hidden = !row.dataset.pickText.includes(query);
    });
  }
});

document.addEventListener("change", (event) => {
  const el = event.target;
  if (el.matches("[data-status-filter]")) (state.ui.statusFilter = el.value), refreshRows();
  if (el.matches("[data-condition-filter]")) (state.ui.conditionFilter = el.value), refreshRows();
  if (el.matches("[data-check-item]")) updateCheck(el.dataset.checkItem, el.checked);
  if (el.matches("[data-import]")) importBackup(el);
});

document.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.target;
  if (form.matches("[data-item-form]")) saveItemFromForm(form, event.submitter?.value === "again");
  if (form.matches("[data-package-form]")) savePackageFromForm(form);
  if (form.matches("[data-package-items-form]")) savePackageItemsFromForm(form);
});

// Press and hold an inventory row (finger or mouse) to preview its details; release to hide.
const peek = Object.assign(document.createElement("div"), { className: "peek card", hidden: true });
document.body.append(peek);
let peekTimer = null;

document.addEventListener("pointerdown", (event) => {
  const row = event.target.closest("[data-peek-item]");
  if (!row || event.button > 0 || event.target.closest("button")) return;
  peekTimer = setTimeout(() => {
    const item = inventoryById(row.dataset.peekItem);
    if (item) (peek.innerHTML = renderPeek(item)), (peek.hidden = false);
  }, 400);
});
["pointerup", "pointercancel", "scroll"].forEach((type) =>
  document.addEventListener(type, () => (clearTimeout(peekTimer), (peek.hidden = true)), true),
);
// Otherwise a long press opens the phone's context menu instead of the preview.
document.addEventListener("contextmenu", (event) => event.target.closest("[data-peek-item]") && event.preventDefault());

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && modal) closeModal();
});

function refreshRows() {
  const list = document.querySelector("[data-rows]");
  if (list) list.innerHTML = renderInventoryRows();
}

function setView(view) {
  state.ui.view = view;
  modal = null;
  render();
  window.scrollTo(0, 0);
}

function openModal(next) {
  modal = next;
  render();
  document.querySelector(".modal input:not([type=checkbox])")?.focus();
}

function closeModal() {
  modal = null;
  render();
}

// ---------- Actions ----------

async function saveItemFromForm(form, again) {
  const data = Object.fromEntries(new FormData(form));
  const id = form.dataset.id;
  const payload = {
    name: data.name.trim(),
    // Empty when the item sits in "Sin categoría" and the user didn't pick a new one.
    category: data.category || UNCATEGORIZED.id,
    description: data.description.trim(),
    quantity: Math.min(Math.max(Math.trunc(Number(data.quantity)) || 1, 1), 9999),
    serial: data.serial.trim(),
    location: data.location.trim(),
    status: manualStatuses.includes(data.status) ? data.status : "disponible",
    condition: data.condition,
    notes: data.notes.trim(),
    loan_to: data.loan_to.trim(),
    loan_since: data.loan_to.trim() ? data.loan_since || today() : "",
    updated_at: new Date().toISOString(),
  };

  if (!payload.name) return showToast("El nombre es obligatorio.", "danger");
  const serial = payload.serial.toLowerCase();
  const duplicate = serial && state.inventory.find((item) => item.id !== id && item.serial.toLowerCase() === serial);
  if (duplicate) return showToast(`El serial ${payload.serial} ya está registrado en "${duplicate.name}".`, "danger");

  if (id) {
    state.inventory = state.inventory.map((item) => (item.id === id ? { ...item, ...payload } : item));
  } else {
    state.inventory.unshift({ id: uid(), created_at: payload.updated_at, ...payload });
  }
  modal = again ? { type: "item", category: payload.category } : null;
  if (await commit(id ? "Material actualizado." : `"${payload.name}" guardado.`)) {
    if (again) document.querySelector("#f-name")?.focus();
  }
}

async function saveCategory(existing) {
  const label = prompt(existing ? "Nuevo nombre de la categoría" : "Nombre de la nueva categoría", existing?.label || "")?.trim().slice(0, 40);
  if (!label || label === existing?.label) return;
  const clash = allCategories().find((c) => c !== existing && c.label.toLowerCase() === label.toLowerCase());
  if (clash) return showToast(`Ya existe la categoría "${clash.label}".`, "danger");
  if (existing) existing.label = label;
  else state.categories.push({ id: (state.ui.category = uid()), label });
  await commit(existing ? "Categoría renombrada." : `Categoría "${label}" creada.`);
}

async function deleteCategory(id) {
  const category = allCategories().find((c) => c.id === id);
  if (!category) return;
  const items = state.inventory.filter((item) => item.category === id);
  const warning = items.length ? `\n\n${items.length} equipos quedarán en "${UNCATEGORIZED.label}".` : "";
  if (!confirm(`¿Borrar la categoría "${category.label}"?${warning}`)) return;
  items.forEach((item) => (item.category = UNCATEGORIZED.id));
  if (state.categories.includes(category)) state.categories = state.categories.filter((c) => c !== category);
  else state.hiddenCategories.push(id);
  state.ui.category = "todos";
  await commit("Categoría borrada.");
}

async function deleteInventoryItem(id) {
  const item = inventoryById(id);
  if (!item) return;
  const inUse = openPackages().filter((pkg) => pkg.items.includes(id));
  const warning = inUse.length ? `\n\nEstá en: ${inUse.map((pkg) => pkg.name).join(", ")}.` : "";
  if (!confirm(`¿Eliminar "${item.name}"? Esta acción no se puede deshacer.${warning}`)) return;

  state.inventory = state.inventory.filter((entry) => entry.id !== id);
  state.packages.forEach((pkg) => {
    pkg.items = pkg.items.filter((itemId) => itemId !== id);
    delete pkg.checklist.salida[id];
    delete pkg.checklist.regreso[id];
  });
  await commit("Material eliminado.");
}

async function returnLoan(id) {
  const item = inventoryById(id);
  if (!item) return;
  Object.assign(item, { loan_to: "", loan_since: "", updated_at: new Date().toISOString() });
  await commit(`"${item.name}" marcado como devuelto.`);
}

async function savePackageFromForm(form) {
  const data = Object.fromEntries(new FormData(form));
  if (!data.name.trim()) return showToast("El nombre es obligatorio.", "danger");
  const pkg = {
    id: uid(),
    name: data.name.trim(),
    client: data.client.trim(),
    date: data.date,
    notes: data.notes.trim(),
    items: [],
    units: {},
    checklist: { salida: {}, regreso: {} },
    closed_at: null,
    created_at: new Date().toISOString(),
  };
  state.packages.unshift(pkg);
  state.ui.packageId = pkg.id;
  state.ui.view = "packages";
  state.ui.checklistMode = "salida";
  modal = { type: "package-items" };
  await commit("Producción creada.");
}

async function savePackageItemsFromForm(form) {
  const pkg = getPackage();
  if (!pkg) return;
  const data = new FormData(form);
  const items = data.getAll("items").filter((id) => inventoryById(id));
  const keep = (checks) => Object.fromEntries(Object.entries(checks).filter(([id]) => items.includes(id)));
  pkg.items = items;
  pkg.units = Object.fromEntries(
    items.map((id) => [id, Math.min(Math.max(Math.trunc(Number(data.get(`units-${id}`))) || 1, 1), inventoryById(id).quantity)]),
  );
  pkg.checklist = { salida: keep(pkg.checklist.salida), regreso: keep(pkg.checklist.regreso) };
  modal = null;
  await commit("Material actualizado.");
}

async function updateCheck(itemId, checked) {
  const pkg = getPackage();
  if (!pkg || pkg.closed_at) return;
  const mode = state.ui.checklistMode;
  if (checked) pkg.checklist[mode][itemId] = true;
  else delete pkg.checklist[mode][itemId];
  // Unchecking salida means it never left, so it can't be pending on regreso.
  if (mode === "salida" && !checked) delete pkg.checklist.regreso[itemId];
  await commit();
}

async function finishPackage(id) {
  const pkg = state.packages.find((entry) => entry.id === id);
  if (!pkg) return;
  const missing = checklistItems(pkg, "regreso").filter((itemId) => !pkg.checklist.regreso[itemId]);
  const names = missing
    .map((itemId) => inventoryById(itemId))
    .filter(Boolean)
    .map((item) => (item.quantity > 1 ? `${item.name} ×${unitsIn(pkg, item)}` : item.name));
  const message = names.length
    ? `Faltan por regresar ${names.length} equipos:\n\n- ${names.join("\n- ")}\n\nQuedarán marcados como "Extraviado" para que los busques. ¿Finalizar?`
    : "¿Finalizar la producción? El material quedará disponible otra vez.";
  if (!confirm(message)) return;

  const now = new Date().toISOString();
  // shortcut: a missing multi-unit item marks the whole item as lost; split units if partial losses get common.
  missing.forEach((itemId) => {
    const item = inventoryById(itemId);
    if (item) Object.assign(item, { status: "perdido", updated_at: now });
  });
  pkg.closed_at = now;
  await commit(names.length ? `Producción finalizada. ${names.length} equipos por revisar.` : "Producción finalizada. Todo regresó.");
}

async function duplicatePackage(id) {
  const source = state.packages.find((entry) => entry.id === id);
  if (!source) return;
  const copy = {
    ...source,
    id: uid(),
    name: `${source.name} (copia)`,
    date: "",
    items: source.items.filter((itemId) => inventoryById(itemId)),
    units: { ...source.units },
    checklist: { salida: {}, regreso: {} },
    closed_at: null,
    created_at: new Date().toISOString(),
  };
  state.packages.unshift(copy);
  state.ui.packageId = copy.id;
  state.ui.checklistMode = "salida";
  await commit("Producción duplicada con el mismo material.");
}

async function deletePackage(id) {
  const pkg = state.packages.find((entry) => entry.id === id);
  if (!pkg || !confirm(`¿Eliminar la producción "${pkg.name}"? El material no se borra.`)) return;
  state.packages = state.packages.filter((entry) => entry.id !== id);
  state.ui.packageId = null;
  await commit("Producción eliminada.");
}

async function exportBackup() {
  const stamp = today();
  const json = JSON.stringify(
    { app: "fotostock", version: 1, exportedAt: new Date().toISOString(), inventory: state.inventory,
      packages: state.packages,
      categories: state.categories,
      hiddenCategories: state.hiddenCategories,
    },
    null,
    2,
  );
  const file = new File([json], `fotostock-respaldo-${stamp}.json`, { type: "application/json" });

  let shared = false;
  // On phones the share sheet lets the user drop the file straight into Drive/iCloud/WhatsApp.
  if (matchMedia("(pointer: coarse)").matches && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "Respaldo FotoStock" });
      shared = true;
    } catch (error) {
      if (error?.name === "AbortError") return;
    }
  }

  try {
    if (!shared) {
      const url = URL.createObjectURL(file);
      const link = Object.assign(document.createElement("a"), { href: url, download: file.name });
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  } catch (error) {
    if (error?.name !== "AbortError") showToast(`No se pudo exportar: ${error?.message || error}`, "danger");
    return;
  }

  state.meta.lastBackupAt = new Date().toISOString();
  await commit("Respaldo exportado. Guárdalo fuera del teléfono.", { touch: false });
}

async function importBackup(input) {
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) return showToast("El archivo es demasiado grande para ser un respaldo.", "danger");

  let raw;
  try {
    raw = JSON.parse(await file.text());
  } catch {
    return showToast("El archivo no es un JSON válido.", "danger");
  }
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.inventory)) {
    return showToast("Este archivo no es un respaldo de FotoStock.", "danger");
  }

  const data = normalizeData({ ...raw, meta: state.meta });
  const skipped = raw.inventory.length - data.inventory.length;
  const summary = `El respaldo tiene ${data.inventory.length} equipos y ${data.packages.length} producciones${
    skipped ? ` (${skipped} registros inválidos se omitirán)` : ""
  }.`;
  const current = state.inventory.length ? `\n\nEsto REEMPLAZA los ${state.inventory.length} equipos actuales.` : "";
  if (!confirm(`${summary}${current}\n\n¿Importar?`)) return;

  state.inventory = data.inventory;
  state.packages = data.packages;
  state.categories = data.categories;
  state.hiddenCategories = data.hiddenCategories;
  state.ui.packageId = null;
  await commit("Respaldo importado.");
}

// ---------- Helpers ----------

function showToast(message, type = "") {
  clearTimeout(toastTimer);
  document.querySelector(".toast")?.remove();
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.setAttribute("role", "status");
  toast.textContent = message;
  document.body.appendChild(toast);
  toastTimer = setTimeout(() => toast.remove(), type === "danger" ? 5000 : 2800);
}

function icon(name) {
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${icons[name]}</svg>`;
}

function uid() {
  return crypto.randomUUID();
}

function today() {
  return new Date().toLocaleDateString("en-CA");
}

function formatDate(value) {
  const date = new Date(value.length === 10 ? `${value}T00:00` : value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("es-CO", { day: "numeric", month: "short", year: "numeric" });
}

function daysAgo(isoDay) {
  const days = Math.floor((Date.now() - Date.parse(`${isoDay}T00:00`)) / 864e5);
  if (days <= 0) return "desde hoy";
  if (days === 1) return "desde ayer";
  return `hace ${days} días`;
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
