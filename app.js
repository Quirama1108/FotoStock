const TOKEN_KEY = "fotostock-token";
const API_BASE_URL = (window.FOTOSTOCK_CONFIG?.API_BASE_URL || "").replace(/\/$/, "");

const categories = [
  { id: "camaras", label: "Camaras" },
  { id: "lentes", label: "Lentes" },
  { id: "flashes", label: "Flashes" },
  { id: "tripodes", label: "Tripodes" },
  { id: "filtros", label: "Filtros" },
  { id: "triggers", label: "Triggers" },
  { id: "memorias", label: "Memorias" },
  { id: "gadgets", label: "Gadgets" },
];

const statusLabels = {
  disponible: "Disponible",
  paquete: "En paquete",
  mantenimiento: "Mantenimiento",
  perdido: "No disponible",
};

const statusClass = {
  disponible: "success",
  paquete: "blue",
  mantenimiento: "warning",
  perdido: "danger",
};

const state = {
  inventory: [],
  packages: [],
  ui: {
    view: "dashboard",
    category: "todos",
    packageId: null,
    checklistMode: "salida",
    authMode: "login",
    loading: false,
    error: "",
    search: "",
    statusFilter: "todos",
    conditionFilter: "todos",
  },
};

let session = loadSession();
let modal = null;
let toastTimer = null;

render();
if (session) refreshData();

function loadSession() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return null;

  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    if (payload.exp * 1000 < Date.now()) {
      localStorage.removeItem(TOKEN_KEY);
      return null;
    }
    return {
      token,
      id: payload.sub,
      cedula: payload.cedula,
      name: payload.name,
      role: payload.role,
    };
  } catch {
    localStorage.removeItem(TOKEN_KEY);
    return null;
  }
}

async function api(path, options = {}) {
  if (!API_BASE_URL) throw new Error("No se pudo preparar la conexión. Intenta de nuevo más tarde.");

  const headers = {
    "content-type": "application/json",
    ...(options.headers || {}),
  };

  if (session?.token) headers.authorization = `Bearer ${session.token}`;

  let res;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new Error(
      "No se pudo conectar con el servicio. Revisa tu conexión e intenta de nuevo.",
    );
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error || "La API no pudo completar la acción.");
  return data;
}

async function refreshData() {
  if (!session) return;
  state.ui.loading = true;
  state.ui.error = "";
  render();

  try {
    const [inventoryData, packageData] = await Promise.all([api("/inventory"), api("/packages")]);
    state.inventory = inventoryData.inventory || [];
    state.packages = normalizePackages(packageData.packages || []);
    if (!state.ui.packageId || !state.packages.some((pkg) => pkg.id === state.ui.packageId)) {
      state.ui.packageId = state.packages[0]?.id || null;
    }
  } catch (error) {
    state.ui.error = error.message;
  } finally {
    state.ui.loading = false;
    render();
  }
}

function normalizePackages(packages) {
  return packages.map((pkg) => ({
    ...pkg,
    date: pkg.date || pkg.session_date || "",
    items: pkg.items || [],
    checklist: pkg.checklist || { salida: {}, regreso: {} },
  }));
}

function render() {
  document.querySelector("#app").innerHTML = session ? renderShell() : renderAuth();
  bindEvents();
}

function renderAuth() {
  const isRegister = state.ui.authMode === "register";
  return `
    <main class="auth-page">
      <section class="auth-art">
        <div class="auth-copy">
          <div class="eyebrow">Inventario fotográfico</div>
          <h2>Material listo antes y después de cada producción.</h2>
          <p>Controla camaras, lentes, luces y accesorios con paquetes de salida y checklist de regreso.</p>
        </div>
      </section>
      <section class="auth-panel">
        <form class="auth-card card" data-auth-form>
          <div class="auth-brand">
            <span class="brand-mark"></span>
            <div>
              <h1>FotoStock</h1>
              <span>${isRegister ? "Crear cuenta" : "Inventario de producción"}</span>
            </div>
          </div>
          <h3>${isRegister ? "Crear cuenta" : "Iniciar sesion"}</h3>
          <p>${isRegister ? "Crea tu perfil para administrar tu propio material." : "Ingresa con tu cédula y contraseña para continuar."}</p>
          <div class="form-stack">
            ${
              isRegister
                ? `
                  <div class="field">
                    <label for="name">Nombre</label>
                    <input id="name" name="name" autocomplete="name" placeholder="Ej. Laura Perez" required minlength="3" />
                  </div>
                `
                : ""
            }
            <div class="field">
              <label for="cedula">Cédula</label>
              <input id="cedula" name="cedula" inputmode="numeric" autocomplete="username" placeholder="Ej. 1037654321" required minlength="6" />
            </div>
            <div class="field">
              <label for="password">Contraseña</label>
              <input id="password" name="password" type="password" autocomplete="${isRegister ? "new-password" : "current-password"}" placeholder="Minimo 6 caracteres" required minlength="6" />
            </div>
            <button class="button primary" type="submit">${isRegister ? "Crear cuenta" : "Entrar"}</button>
            <button class="button ghost" type="button" data-toggle-auth>
              ${isRegister ? "Ya tengo cuenta" : "Crear una cuenta"}
            </button>
          </div>
          ${state.ui.error ? `<div class="notice danger">${state.ui.error}</div>` : ""}
        </form>
      </section>
    </main>
  `;
}

function renderShell() {
  const nav = [
    ["dashboard", "Panel", "DB"],
    ["inventory", "Inventario", "IN"],
    ["packages", "Paquetes", "OK"],
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
              ([id, label, icon]) => `
                <button class="nav-button ${state.ui.view === id ? "is-active" : ""}" data-view="${id}">
                  <span class="icon">${icon}</span>
                  <span>${label}</span>
                </button>
              `,
            )
            .join("")}
        </nav>
        <div class="sidebar-footer">
          <div class="user-pill">
            <span class="avatar">${(session.name || session.cedula).slice(0, 2).toUpperCase()}</span>
            <div>
              <strong>${session.name}</strong>
              <div>C.C. ${session.cedula}</div>
            </div>
          </div>
          <button class="button ghost" data-logout>Cerrar sesion</button>
        </div>
      </aside>
      <main class="main">
        ${renderActiveView()}
      </main>
    </div>
    ${modal ? renderModal() : ""}
  `;
}

function renderActiveView() {
  if (state.ui.loading) return renderLoading();
  if (state.ui.error) return renderError();
  if (state.ui.view === "inventory") return renderInventoryView();
  if (state.ui.view === "packages") return renderPackagesView();
  return renderDashboard();
}

function renderLoading() {
  return `
    ${renderTopbar("Cargando", "Preparando tu inventario y paquetes de producción.")}
    <section class="card empty">Cargando información...</section>
  `;
}

function renderError() {
  return `
    ${renderTopbar("No se pudo cargar", "Algo impidió traer tu información. Puedes intentar nuevamente.", `<button class="button primary" data-refresh>Reintentar</button>`)}
    <section class="card empty">${state.ui.error}</section>
  `;
}

function renderTopbar(title, subtitle, actions = "") {
  return `
    <header class="topbar">
      <div class="page-title">
        <h2>${title}</h2>
        <p>${subtitle}</p>
      </div>
      <div class="actions">${actions}</div>
    </header>
  `;
}

function renderDashboard() {
  const total = state.inventory.length;
  const available = state.inventory.filter((item) => item.status === "disponible").length;
  const inPackage = state.inventory.filter((item) => item.status === "paquete").length;
  const maintenance = state.inventory.filter((item) => item.status === "mantenimiento").length;
  const pkg = getPackage();

  return `
    ${renderTopbar(
      "Panel de control",
      "Resumen del material disponible, reservado y pendiente de revisión.",
      `<button class="button primary" data-open-modal="item">+ Material</button>
       <button class="button" data-open-modal="package">+ Paquete</button>`,
    )}
    <section class="grid stats-grid">
      ${renderMetric("Material total", total, "Registros en BD")}
      ${renderMetric("Disponible", available, "Listo para asignar")}
      ${renderMetric("En paquete", inPackage, "Reservado")}
      ${renderMetric("Revision", maintenance, "Requiere atencion")}
    </section>
    <section class="section grid content-grid">
      <div>
        <div class="section-header">
          <div>
            <h3>Categorias</h3>
            <p>Distribucion actual por tipo de equipo.</p>
          </div>
        </div>
        <div class="grid stats-grid">${categories.map(renderCategoryMetric).join("")}</div>
        <div class="section-header section">
          <div>
            <h3>Material reciente</h3>
            <p>Ultimos elementos registrados.</p>
          </div>
          <button class="button ghost" data-view="inventory">Ver inventario</button>
        </div>
        <div class="inventory-list">
          ${state.inventory.length ? state.inventory.slice(0, 5).map(renderItemRow).join("") : `<div class="card empty">Aun no hay material. Agrega el primer elemento.</div>`}
        </div>
      </div>
      <aside class="side-panel card">
        <div class="section-header">
          <div>
            <h3>Paquete activo</h3>
            <p>${pkg ? pkg.name : "Sin paquetes creados"}</p>
          </div>
        </div>
        ${
          pkg
            ? `
              <div class="list-compact">
                ${renderProgress("Salida", packageProgress(pkg, "salida"))}
                ${renderProgress("Regreso", packageProgress(pkg, "regreso"))}
                ${pkg.items
                  .slice(0, 4)
                  .map((id) => {
                    const item = inventoryById(id);
                    return item
                      ? `<div class="compact-row"><span>${item.name}</span><span class="tag">${categoryById(item.category).label}</span></div>`
                      : "";
                  })
                  .join("")}
                <button class="button primary" data-view="packages">Abrir checklist</button>
              </div>
            `
            : `<div class="empty">Crea un paquete para preparar una producción.</div>`
        }
      </aside>
    </section>
  `;
}

function renderMetric(label, value, trend) {
  return `
    <article class="card metric">
      <span>${label}</span>
      <b>${value}</b>
      <div class="trend">${trend}</div>
    </article>
  `;
}

function renderCategoryMetric(category) {
  const count = state.inventory.filter((item) => item.category === category.id).length;
  return `
    <button class="card metric" data-category-jump="${category.id}">
      <span>${category.label}</span>
      <b>${count}</b>
      <div class="trend">Material registrado</div>
    </button>
  `;
}

function renderInventoryView() {
  const categoryOptions = [
    `<button class="chip ${state.ui.category === "todos" ? "is-active" : ""}" data-category="todos">Todos</button>`,
    ...categories.map(
      (category) => `
        <button class="chip ${state.ui.category === category.id ? "is-active" : ""}" data-category="${category.id}">
          ${category.label}
        </button>
      `,
    ),
  ].join("");

  return `
    ${renderTopbar(
      "Inventario",
      "Administra el material fotográfico y mantenlo listo para cada producción.",
      `<button class="button primary" data-open-modal="item">+ Nuevo material</button>`,
    )}
    <section class="section">
      <div class="category-strip">${categoryOptions}</div>
      <div class="toolbar">
        <input data-search placeholder="Buscar por nombre, serial o ubicacion" value="${escapeAttr(state.ui.search)}" />
        <select data-status-filter>
          <option value="todos">Todos los estados</option>
          ${Object.entries(statusLabels)
            .map(([value, label]) => `<option value="${value}" ${state.ui.statusFilter === value ? "selected" : ""}>${label}</option>`)
            .join("")}
        </select>
        <select data-condition-filter>
          <option value="todos">Todas las condiciones</option>
          ${["Excelente", "Muy bueno", "Bueno", "Revision"].map((value) => `<option ${state.ui.conditionFilter === value ? "selected" : ""}>${value}</option>`).join("")}
        </select>
      </div>
      <div class="inventory-list">${renderInventoryRows()}</div>
    </section>
  `;
}

function renderInventoryRows() {
  const search = state.ui.search.toLowerCase();
  const rows = state.inventory.filter((item) => {
    const matchesCategory = state.ui.category === "todos" || item.category === state.ui.category;
    const matchesSearch =
      !search ||
      [item.name, item.serial, item.location, item.notes || ""].some((value) =>
        String(value).toLowerCase().includes(search),
      );
    const matchesStatus = state.ui.statusFilter === "todos" || item.status === state.ui.statusFilter;
    const matchesCondition =
      state.ui.conditionFilter === "todos" || item.condition === state.ui.conditionFilter;
    return matchesCategory && matchesSearch && matchesStatus && matchesCondition;
  });

  if (!rows.length) return `<div class="card empty">No hay material con esos filtros.</div>`;
  return rows.map(renderItemRow).join("");
}

function renderItemRow(item) {
  const category = categoryById(item.category);
  return `
    <article class="card item-row">
      <div class="item-main">
        <span class="item-icon" aria-hidden="true"></span>
        <div class="item-title">
          <strong>${item.name}</strong>
          <span>${item.serial} - ${category.label}</span>
        </div>
      </div>
      <span class="meta">${item.location}</span>
      <span class="tag ${statusClass[item.status]}">${statusLabels[item.status]}</span>
      <span class="tag">${item.condition}</span>
      <div class="actions">
        <button class="button icon-only" title="Editar" data-edit-item="${item.id}">Ed</button>
        <button class="button icon-only danger" title="Eliminar" data-delete-item="${item.id}">X</button>
      </div>
    </article>
  `;
}

function renderPackagesView() {
  const pkg = getPackage();
  return `
    ${renderTopbar(
      "Paquetes",
      "Prepara el material de una sesion y verifica salida y regreso.",
      `<button class="button primary" data-open-modal="package">+ Nuevo paquete</button>`,
    )}
    <section class="package-layout">
      <aside class="card side-panel">
        <div class="section-header">
          <div>
            <h3>Producciones</h3>
            <p>Selecciona el paquete activo.</p>
          </div>
        </div>
        <div class="list-compact">
          ${
            state.packages.length
              ? state.packages
                  .map(
                    (entry) => `
                      <button class="compact-row ${entry.id === state.ui.packageId ? "chip is-active" : ""}" data-select-package="${entry.id}">
                        <span>
                          <strong>${entry.name}</strong>
                          <div class="small">${entry.date || "Sin fecha"} - ${entry.items.length} elementos</div>
                        </span>
                        <span>${packageProgress(entry, "regreso")}%</span>
                      </button>
                    `,
                  )
                  .join("")
              : `<div class="empty">Aun no hay paquetes.</div>`
          }
        </div>
      </aside>
      <div>${pkg ? renderPackageDetail(pkg) : `<div class="card empty">Crea un paquete para empezar.</div>`}</div>
    </section>
  `;
}

function renderPackageDetail(pkg) {
  const mode = state.ui.checklistMode;
  return `
    <section class="card package-card">
      <div class="section-header">
        <div>
          <h3>${pkg.name}</h3>
          <p>${pkg.client || "Sin cliente"} - ${pkg.date || "Sin fecha"}</p>
        </div>
        <div class="actions">
          <button class="button" data-open-modal="package-items">Material</button>
          <button class="button danger" data-delete-package="${pkg.id}">Eliminar</button>
        </div>
      </div>
      <div class="split">
        ${renderProgress("Checklist de salida", packageProgress(pkg, "salida"))}
        ${renderProgress("Checklist de regreso", packageProgress(pkg, "regreso"))}
      </div>
      <div class="section-header section">
        <div>
          <h3>Verificacion</h3>
          <p>${pkg.notes || "Sin notas adicionales."}</p>
        </div>
        <div class="tabs">
          <button class="tab ${mode === "salida" ? "is-active" : ""}" data-check-mode="salida">Salida</button>
          <button class="tab ${mode === "regreso" ? "is-active" : ""}" data-check-mode="regreso">Regreso</button>
        </div>
      </div>
      <div class="checklist">
        ${
          pkg.items.length
            ? pkg.items
                .map((id) => {
                  const item = inventoryById(id);
                  if (!item) return "";
                  return `
                    <label class="check-row">
                      <input type="checkbox" data-check-item="${item.id}" ${pkg.checklist?.[mode]?.[item.id] ? "checked" : ""} />
                      <span>
                        <strong>${item.name}</strong>
                        <div class="small">${categoryById(item.category).label} - ${item.serial} - ${item.location}</div>
                      </span>
                      <span class="tag ${statusClass[item.status]}">${statusLabels[item.status]}</span>
                    </label>
                  `;
                })
                .join("")
            : `<div class="empty">Agrega material al paquete.</div>`
        }
      </div>
    </section>
  `;
}

function renderProgress(label, value) {
  return `
    <div>
      <div class="small">${label}</div>
      <div class="progress" style="--value: ${value}%"><span></span></div>
    </div>
  `;
}

function renderModal() {
  if (modal.type === "item") return renderItemModal(modal.itemId && inventoryById(modal.itemId));
  if (modal.type === "package") return renderPackageModal();
  if (modal.type === "package-items") return renderPackageItemsModal();
  return "";
}

function renderItemModal(item) {
  const isEdit = Boolean(item);
  return `
    <div class="modal-backdrop" data-close-modal>
      <form class="modal card" data-item-form data-id="${item?.id || ""}">
        <div class="modal-header">
          <div>
            <h3>${isEdit ? "Editar material" : "Nuevo material"}</h3>
            <p class="small">Registra la información necesaria para ubicar y preparar el equipo.</p>
          </div>
          <button class="button icon-only" type="button" data-close-modal>X</button>
        </div>
        <div class="form-stack">
          <div class="split">
            <div class="field">
              <label>Nombre</label>
              <input name="name" required value="${escapeAttr(item?.name || "")}" />
            </div>
            <div class="field">
              <label>Categoria</label>
              <select name="category" required>
                ${categories.map((category) => `<option value="${category.id}" ${item?.category === category.id ? "selected" : ""}>${category.label}</option>`).join("")}
              </select>
            </div>
          </div>
          <div class="split">
            <div class="field">
              <label>Serial / placa</label>
              <input name="serial" required value="${escapeAttr(item?.serial || "")}" />
            </div>
            <div class="field">
              <label>Ubicacion fisica</label>
              <input name="location" required placeholder="Ej. Bodega A / Estante 2" value="${escapeAttr(item?.location || "")}" />
            </div>
          </div>
          <div class="split">
            <div class="field">
              <label>Estado</label>
              <select name="status">
                ${Object.entries(statusLabels).map(([value, label]) => `<option value="${value}" ${item?.status === value ? "selected" : ""}>${label}</option>`).join("")}
              </select>
            </div>
            <div class="field">
              <label>Condicion</label>
              <select name="condition">
                ${["Excelente", "Muy bueno", "Bueno", "Revision"].map((value) => `<option ${item?.condition === value ? "selected" : ""}>${value}</option>`).join("")}
              </select>
            </div>
          </div>
          <div class="field">
            <label>Notas</label>
            <textarea name="notes">${escapeHtml(item?.notes || "")}</textarea>
          </div>
          <button class="button primary" type="submit">${isEdit ? "Guardar cambios" : "Crear material"}</button>
        </div>
      </form>
    </div>
  `;
}

function renderPackageModal() {
  return `
    <div class="modal-backdrop" data-close-modal>
      <form class="modal card" data-package-form>
        <div class="modal-header">
          <div>
            <h3>Nuevo paquete</h3>
            <p class="small">Crea una producción y luego asigna material.</p>
          </div>
          <button class="button icon-only" type="button" data-close-modal>X</button>
        </div>
        <div class="form-stack">
          <div class="field">
            <label>Nombre de la sesion</label>
            <input name="name" required placeholder="Ej. Boda campestre" />
          </div>
          <div class="split">
            <div class="field">
              <label>Cliente</label>
              <input name="client" placeholder="Cliente o proyecto" />
            </div>
            <div class="field">
              <label>Fecha</label>
              <input name="date" type="date" />
            </div>
          </div>
          <div class="field">
            <label>Notas</label>
            <textarea name="notes" placeholder="Necesidades especiales, responsable, lugar..."></textarea>
          </div>
          <button class="button primary" type="submit">Crear paquete</button>
        </div>
      </form>
    </div>
  `;
}

function renderPackageItemsModal() {
  const pkg = getPackage();
  if (!pkg) return "";
  const selected = new Set(pkg.items);
  const usableInventory = state.inventory.filter((item) => item.status !== "perdido");

  return `
    <div class="modal-backdrop" data-close-modal>
      <form class="modal card" data-package-items-form>
        <div class="modal-header">
          <div>
            <h3>Material del paquete</h3>
            <p class="small">${pkg.name}</p>
          </div>
          <button class="button icon-only" type="button" data-close-modal>X</button>
        </div>
        <div class="selector-list">
          ${
            usableInventory.length
              ? usableInventory
                  .map(
                    (item) => `
                      <label class="selectable">
                        <input type="checkbox" name="items" value="${item.id}" ${selected.has(item.id) ? "checked" : ""} />
                        <span>
                          <strong>${item.name}</strong>
                          <div class="small">${categoryById(item.category).label} - ${item.serial} - ${item.location}</div>
                        </span>
                        <span class="tag ${statusClass[item.status]}">${statusLabels[item.status]}</span>
                      </label>
                    `,
                  )
                  .join("")
              : `<div class="empty">Agrega material al inventario primero.</div>`
          }
        </div>
        <div class="modal-actions">
          <button class="button primary" type="submit">Guardar material</button>
        </div>
      </form>
    </div>
  `;
}

function bindEvents() {
  document.querySelector("[data-auth-form]")?.addEventListener("submit", submitAuth);
  document.querySelector("[data-toggle-auth]")?.addEventListener("click", () => {
    state.ui.authMode = state.ui.authMode === "login" ? "register" : "login";
    state.ui.error = "";
    render();
  });

  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.ui.view = button.dataset.view;
      render();
    });
  });

  document.querySelector("[data-logout]")?.addEventListener("click", logout);
  document.querySelectorAll("[data-refresh]").forEach((button) => {
    button.addEventListener("click", refreshData);
  });

  document.querySelectorAll("[data-open-modal]").forEach((button) => {
    button.addEventListener("click", () => {
      modal = { type: button.dataset.openModal };
      render();
    });
  });

  document.querySelectorAll("[data-close-modal]").forEach((node) => {
    node.addEventListener("click", (event) => {
      if (event.target === node || event.target.dataset.closeModal !== undefined) {
        modal = null;
        render();
      }
    });
  });

  document.querySelectorAll("[data-category]").forEach((button) => {
    button.addEventListener("click", () => {
      state.ui.category = button.dataset.category;
      render();
    });
  });

  document.querySelectorAll("[data-category-jump]").forEach((button) => {
    button.addEventListener("click", () => {
      state.ui.category = button.dataset.categoryJump;
      state.ui.view = "inventory";
      render();
    });
  });

  document.querySelector("[data-search]")?.addEventListener("input", (event) => {
    state.ui.search = event.target.value;
    render();
  });
  document.querySelector("[data-status-filter]")?.addEventListener("input", (event) => {
    state.ui.statusFilter = event.target.value;
    render();
  });
  document.querySelector("[data-condition-filter]")?.addEventListener("input", (event) => {
    state.ui.conditionFilter = event.target.value;
    render();
  });

  document.querySelectorAll("[data-edit-item]").forEach((button) => {
    button.addEventListener("click", () => {
      modal = { type: "item", itemId: button.dataset.editItem };
      render();
    });
  });

  document.querySelectorAll("[data-delete-item]").forEach((button) => {
    button.addEventListener("click", () => deleteInventoryItem(button.dataset.deleteItem));
  });

  document.querySelector("[data-item-form]")?.addEventListener("submit", saveItemFromForm);
  document.querySelector("[data-package-form]")?.addEventListener("submit", savePackageFromForm);
  document.querySelector("[data-package-items-form]")?.addEventListener("submit", savePackageItemsFromForm);

  document.querySelectorAll("[data-select-package]").forEach((button) => {
    button.addEventListener("click", () => {
      state.ui.packageId = button.dataset.selectPackage;
      render();
    });
  });

  document.querySelectorAll("[data-check-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.ui.checklistMode = button.dataset.checkMode;
      render();
    });
  });

  document.querySelectorAll("[data-check-item]").forEach((checkbox) => {
    checkbox.addEventListener("change", () =>
      updateCheck(checkbox.dataset.checkItem, checkbox.checked),
    );
  });

  document.querySelectorAll("[data-delete-package]").forEach((button) => {
    button.addEventListener("click", () => deletePackage(button.dataset.deletePackage));
  });
}

async function submitAuth(event) {
  event.preventDefault();
  state.ui.error = "";
  const form = Object.fromEntries(new FormData(event.currentTarget));
  const endpoint = state.ui.authMode === "register" ? "/auth/register" : "/auth/login";

  try {
    const data = await api(endpoint, {
      method: "POST",
      body: {
        cedula: String(form.cedula).trim(),
        password: String(form.password),
        name: String(form.name || "").trim(),
      },
    });
    localStorage.setItem(TOKEN_KEY, data.token);
    session = loadSession();
    state.ui.view = "dashboard";
    await refreshData();
    showToast(state.ui.authMode === "register" ? "Cuenta creada." : "Sesion iniciada.");
  } catch (error) {
    state.ui.error = error.message;
    render();
  }
}

function logout() {
  localStorage.removeItem(TOKEN_KEY);
  session = null;
  state.inventory = [];
  state.packages = [];
  render();
}

async function saveItemFromForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  const payload = {
    name: data.name.trim(),
    category: data.category,
    serial: data.serial.trim(),
    location: data.location.trim(),
    status: data.status,
    condition: data.condition,
    notes: data.notes.trim(),
  };

  try {
    const result = await api(form.dataset.id ? `/inventory/${form.dataset.id}` : "/inventory", {
      method: form.dataset.id ? "PUT" : "POST",
      body: payload,
    });

    if (form.dataset.id) {
      state.inventory = state.inventory.map((item) => (item.id === result.item.id ? result.item : item));
    } else {
      state.inventory.unshift(result.item);
    }
    modal = null;
    render();
    showToast(form.dataset.id ? "Material actualizado." : "Material creado.");
  } catch (error) {
    showToast(error.message);
  }
}

async function deleteInventoryItem(id) {
  try {
    await api(`/inventory/${id}`, { method: "DELETE" });
    state.inventory = state.inventory.filter((item) => item.id !== id);
    state.packages = state.packages.map((pkg) => ({
      ...pkg,
      items: pkg.items.filter((itemId) => itemId !== id),
    }));
    render();
    showToast("Material eliminado.");
  } catch (error) {
    showToast(error.message);
  }
}

async function savePackageFromForm(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  try {
    const result = await api("/packages", {
      method: "POST",
      body: {
        name: data.name.trim(),
        client: data.client.trim(),
        date: data.date,
        notes: data.notes.trim(),
      },
    });
    state.packages.unshift(normalizePackages([result.package])[0]);
    state.ui.packageId = result.package.id;
    state.ui.view = "packages";
    modal = { type: "package-items" };
    render();
    showToast("Paquete creado.");
  } catch (error) {
    showToast(error.message);
  }
}

async function savePackageItemsFromForm(event) {
  event.preventDefault();
  const pkg = getPackage();
  if (!pkg) return;
  const items = new FormData(event.currentTarget).getAll("items");

  try {
    await api(`/packages/${pkg.id}/items`, {
      method: "PUT",
      body: { items },
    });
    modal = null;
    await refreshData();
    showToast("Material del paquete actualizado.");
  } catch (error) {
    showToast(error.message);
  }
}

async function updateCheck(itemId, checked) {
  const pkg = getPackage();
  if (!pkg) return;
  const mode = state.ui.checklistMode;
  pkg.checklist[mode][itemId] = checked;
  render();

  try {
    await api(`/packages/${pkg.id}/checks`, {
      method: "PATCH",
      body: { itemId, mode, checked },
    });
  } catch (error) {
    pkg.checklist[mode][itemId] = !checked;
    render();
    showToast(error.message);
  }
}

async function deletePackage(id) {
  try {
    await api(`/packages/${id}`, { method: "DELETE" });
    state.packages = state.packages.filter((pkg) => pkg.id !== id);
    state.ui.packageId = state.packages[0]?.id || null;
    render();
    showToast("Paquete eliminado.");
  } catch (error) {
    showToast(error.message);
  }
}

function getPackage() {
  return (
    state.packages.find((pkg) => pkg.id === state.ui.packageId) ||
    state.packages[0] ||
    null
  );
}

function inventoryById(id) {
  return state.inventory.find((item) => item.id === id);
}

function categoryById(id) {
  return categories.find((category) => category.id === id) || categories[0];
}

function packageProgress(pkg, mode) {
  if (!pkg || pkg.items.length === 0) return 0;
  const checked = pkg.items.filter((id) => pkg.checklist?.[mode]?.[id]).length;
  return Math.round((checked / pkg.items.length) * 100);
}

function showToast(message) {
  clearTimeout(toastTimer);
  document.querySelector(".toast")?.remove();
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  toastTimer = setTimeout(() => toast.remove(), 2800);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("'", "&#039;");
}
