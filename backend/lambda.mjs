import crypto from "node:crypto";

const SUPABASE_URL = trimSlash(process.env.SUPABASE_URL || "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const JWT_SECRET = process.env.JWT_SECRET || "";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

const jsonHeaders = {
  "content-type": "application/json",
  "access-control-allow-origin": CORS_ORIGIN,
  "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type,authorization",
};

export async function handler(event) {
  const startedAt = Date.now();
  let requestForLog = null;

  try {
    if (event.requestContext?.http?.method === "OPTIONS" || event.httpMethod === "OPTIONS") {
      return response(204, null);
    }

    assertConfig();

    const request = normalizeEvent(event);
    requestForLog = request;
    const route = `${request.method} ${request.path}`;
    console.log("request", JSON.stringify({ method: request.method, path: request.path }));

    if (route === "POST /auth/register") return await register(request);
    if (route === "POST /auth/login") return await login(request);

    const user = requireUser(request);

    if (route === "GET /me") return response(200, { user });
    if (route === "GET /inventory") return await listInventory(user);
    if (route === "POST /inventory") return await createInventoryItem(request, user);
    if (route.startsWith("PUT /inventory/")) return await updateInventoryItem(request, user);
    if (route.startsWith("DELETE /inventory/")) return await deleteInventoryItem(request, user);
    if (route === "GET /packages") return await listPackages(user);
    if (route === "POST /packages") return await createPackage(request, user);
    if (route.startsWith("DELETE /packages/")) return await deletePackage(request, user);
    if (route.endsWith("/items") && route.startsWith("PUT /packages/")) {
      return await replacePackageItems(request, user);
    }
    if (route.endsWith("/checks") && route.startsWith("PATCH /packages/")) {
      return await updatePackageCheck(request, user);
    }

    return response(404, { error: "Ruta no encontrada." });
  } catch (error) {
    const status = error.status || 500;
    console.error(
      "request_error",
      JSON.stringify({
        method: requestForLog?.method || event.requestContext?.http?.method || event.httpMethod || "unknown",
        path: requestForLog?.path || event.rawPath || event.path || "unknown",
        status,
        message: error.message || "Error interno.",
        durationMs: Date.now() - startedAt,
      }),
    );
    return response(status, { error: error.message || "Error interno." });
  }
}

async function register(request) {
  const body = parseBody(request);
  requireFields(body, ["cedula", "password", "name"]);
  const user = await rpc("register_user", {
    p_cedula: String(body.cedula).trim(),
    p_password: String(body.password),
    p_full_name: String(body.name).trim(),
  });
  return response(201, { user, token: signJwt(user) });
}

async function login(request) {
  const body = parseBody(request);
  requireFields(body, ["cedula", "password"]);
  const user = await rpc("login_user", {
    p_cedula: String(body.cedula).trim(),
    p_password: String(body.password),
  });
  if (!user) throw httpError(401, "Cedula o contrasena incorrecta.");
  return response(200, { user, token: signJwt(user) });
}

async function listInventory(user) {
  const items = await supabaseTable(
    "inventory_items",
    `select=id,name,category,serial,location,status,condition,notes,created_at,updated_at&created_by=eq.${encodeURIComponent(user.id)}&order=created_at.desc`,
  );
  return response(200, { inventory: items });
}

async function createInventoryItem(request, user) {
  const body = parseBody(request);
  requireFields(body, ["name", "category", "serial", "location", "status", "condition"]);
  const rows = await supabaseTable("inventory_items", "select=*", {
    method: "POST",
    body: JSON.stringify({
      name: body.name,
      category: body.category,
      serial: body.serial,
      location: body.location,
      status: body.status,
      condition: body.condition,
      notes: body.notes || "",
      created_by: user.id,
    }),
    headers: { Prefer: "return=representation" },
  });
  return response(201, { item: rows[0] });
}

async function updateInventoryItem(request, user) {
  const id = idFromPath(request.path, 1);
  const body = parseBody(request);
  const rows = await supabaseTable(
    `inventory_items?id=eq.${encodeURIComponent(id)}&created_by=eq.${encodeURIComponent(user.id)}`,
    "select=*",
    {
      method: "PATCH",
      body: JSON.stringify({
        name: body.name,
        category: body.category,
        serial: body.serial,
        location: body.location,
        status: body.status,
        condition: body.condition,
        notes: body.notes || "",
        updated_at: new Date().toISOString(),
      }),
      headers: { Prefer: "return=representation" },
    },
  );
  if (!rows[0]) throw httpError(404, "Material no encontrado.");
  return response(200, { item: rows[0] });
}

async function deleteInventoryItem(request, user) {
  const id = idFromPath(request.path, 1);
  await supabaseTable(
    `inventory_items?id=eq.${encodeURIComponent(id)}&created_by=eq.${encodeURIComponent(user.id)}`,
    "",
    { method: "DELETE" },
  );
  return response(204, null);
}

async function listPackages(user) {
  const [packages, packageItems, packageChecks] = await Promise.all([
    supabaseTable(
      "production_packages",
      `select=*&created_by=eq.${encodeURIComponent(user.id)}&order=created_at.desc`,
    ),
    supabaseTable("package_items", "select=*"),
    supabaseTable("package_checks", "select=*"),
  ]);

  const checksByItem = packageChecks.reduce((acc, check) => {
    acc[`${check.package_id}:${check.inventory_item_id}:${check.mode}`] = check.checked;
    return acc;
  }, {});

  const result = packages.map((pkg) => {
    const items = packageItems
      .filter((entry) => entry.package_id === pkg.id)
      .map((entry) => entry.inventory_item_id);
    return {
      ...pkg,
      items,
      checklist: {
        salida: Object.fromEntries(
          items.map((id) => [id, Boolean(checksByItem[`${pkg.id}:${id}:salida`])]),
        ),
        regreso: Object.fromEntries(
          items.map((id) => [id, Boolean(checksByItem[`${pkg.id}:${id}:regreso`])]),
        ),
      },
    };
  });

  return response(200, { packages: result });
}

async function createPackage(request, user) {
  const body = parseBody(request);
  requireFields(body, ["name"]);
  const rows = await supabaseTable("production_packages", "select=*", {
    method: "POST",
    body: JSON.stringify({
      name: body.name,
      client: body.client || "",
      session_date: body.date || null,
      notes: body.notes || "",
      created_by: user.id,
    }),
    headers: { Prefer: "return=representation" },
  });
  return response(201, { package: { ...rows[0], items: [], checklist: { salida: {}, regreso: {} } } });
}

async function deletePackage(request, user) {
  const id = idFromPath(request.path, 1);
  await getOwnedPackage(id, user);
  const previous = await supabaseTable(
    "package_items",
    `select=inventory_item_id&package_id=eq.${encodeURIComponent(id)}`,
  );
  await supabaseTable(
    `production_packages?id=eq.${encodeURIComponent(id)}&created_by=eq.${encodeURIComponent(user.id)}`,
    "",
    { method: "DELETE" },
  );
  await updateInventoryStatus(
    previous.map((entry) => entry.inventory_item_id),
    "disponible",
    "paquete",
  );
  return response(204, null);
}

async function replacePackageItems(request, user) {
  const packageId = idFromPath(request.path, 1);
  const body = parseBody(request);
  const items = Array.isArray(body.items) ? body.items : [];
  await getOwnedPackage(packageId, user);
  await assertOwnedInventoryItems(items, user);

  const previous = await supabaseTable(
    "package_items",
    `select=inventory_item_id&package_id=eq.${encodeURIComponent(packageId)}`,
  );
  const previousItems = previous.map((entry) => entry.inventory_item_id);

  await supabaseTable(`package_items?package_id=eq.${encodeURIComponent(packageId)}`, "", {
    method: "DELETE",
  });

  if (items.length) {
    await supabaseTable("package_items", "", {
      method: "POST",
      body: JSON.stringify(items.map((itemId) => ({ package_id: packageId, inventory_item_id: itemId }))),
    });
  }

  const removed = previousItems.filter((id) => !items.includes(id));
  await updateInventoryStatus(items, "paquete", "disponible");
  await updateInventoryStatus(removed, "disponible", "paquete");

  return response(200, { items });
}

async function updatePackageCheck(request, user) {
  const packageId = idFromPath(request.path, 1);
  const body = parseBody(request);
  requireFields(body, ["itemId", "mode"]);
  if (!["salida", "regreso"].includes(body.mode)) throw httpError(400, "Modo de checklist invalido.");
  await getOwnedPackage(packageId, user);
  await assertOwnedInventoryItems([body.itemId], user);

  const rows = await supabaseTable(
    "package_checks",
    "select=*&on_conflict=package_id,inventory_item_id,mode",
    {
    method: "POST",
    body: JSON.stringify({
      package_id: packageId,
      inventory_item_id: body.itemId,
      mode: body.mode,
      checked: Boolean(body.checked),
      checked_by: user.id,
      checked_at: new Date().toISOString(),
    }),
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    },
  );
  return response(200, { check: rows[0] });
}

async function getOwnedPackage(packageId, user) {
  const rows = await supabaseTable(
    "production_packages",
    `select=id&created_by=eq.${encodeURIComponent(user.id)}&id=eq.${encodeURIComponent(packageId)}&limit=1`,
  );
  if (!rows[0]) throw httpError(404, "Paquete no encontrado.");
  return rows[0];
}

async function assertOwnedInventoryItems(itemIds, user) {
  if (!itemIds.length) return;

  const uniqueIds = [...new Set(itemIds)];
  const filter = uniqueIds.map((id) => encodeURIComponent(id)).join(",");
  const rows = await supabaseTable(
    "inventory_items",
    `select=id&created_by=eq.${encodeURIComponent(user.id)}&id=in.(${filter})`,
  );
  if (rows.length !== uniqueIds.length) {
    throw httpError(403, "No puedes usar material de otro usuario.");
  }
}

async function updateInventoryStatus(ids, nextStatus, currentStatus) {
  if (!ids.length) return;
  const filter = ids.map((id) => encodeURIComponent(id)).join(",");
  await supabaseTable(
    `inventory_items?id=in.(${filter})&status=eq.${encodeURIComponent(currentStatus)}`,
    "",
    {
      method: "PATCH",
      body: JSON.stringify({ status: nextStatus, updated_at: new Date().toISOString() }),
    },
  );
}

async function rpc(name, body) {
  const url = `${SUPABASE_URL}/rest/v1/rpc/${name}`;
  const res = await fetch(url, {
    method: "POST",
    headers: supabaseHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  return parseSupabaseResponse(res);
}

async function supabaseTable(table, query = "", options = {}) {
  const [baseTable, inlineQuery = ""] = table.split("?");
  const qs = [inlineQuery, query].filter(Boolean).join(inlineQuery && query ? "&" : "");
  const url = `${SUPABASE_URL}/rest/v1/${baseTable}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, {
    method: options.method || "GET",
    headers: supabaseHeaders(options.headers),
    body: options.body,
  });
  return parseSupabaseResponse(res);
}

function supabaseHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "content-type": "application/json",
    ...extra,
  };
}

async function parseSupabaseResponse(res) {
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw httpError(res.status, body?.message || body?.hint || "Error consultando Supabase.");
  }
  return body;
}

function requireUser(request) {
  const auth = request.headers.authorization || request.headers.Authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) throw httpError(401, "Sesion requerida.");
  return verifyJwt(token);
}

function signJwt(user) {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      sub: user.id,
      cedula: user.cedula,
      name: user.full_name,
      role: user.role,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60 * 60 * 8,
    }),
  );
  const signature = crypto.createHmac("sha256", JWT_SECRET).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function verifyJwt(token) {
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) throw httpError(401, "Token invalido.");
  const expected = crypto.createHmac("sha256", JWT_SECRET).update(`${header}.${payload}`).digest("base64url");
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    throw httpError(401, "Token invalido.");
  }
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (claims.exp < Math.floor(Date.now() / 1000)) throw httpError(401, "Sesion expirada.");
  return {
    id: claims.sub,
    cedula: claims.cedula,
    full_name: claims.name,
    role: claims.role,
  };
}

function normalizeEvent(event) {
  const method = event.requestContext?.http?.method || event.httpMethod || "GET";
  const rawPath = event.rawPath || event.path || "/";
  return {
    method,
    path: rawPath.replace(/\/+$/, "") || "/",
    headers: event.headers || {},
    body: event.body || "",
    isBase64Encoded: event.isBase64Encoded,
  };
}

function parseBody(request) {
  if (!request.body) return {};
  const text = request.isBase64Encoded
    ? Buffer.from(request.body, "base64").toString("utf8")
    : request.body;
  return typeof text === "string" ? JSON.parse(text) : text;
}

function requireFields(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) throw httpError(400, `Faltan campos: ${missing.join(", ")}.`);
}

function idFromPath(path, index) {
  const parts = path.split("/").filter(Boolean);
  const id = parts[index];
  if (!id) throw httpError(400, "Id requerido.");
  return id;
}

function response(statusCode, body) {
  return {
    statusCode,
    headers: jsonHeaders,
    body: body === null ? "" : JSON.stringify(body),
  };
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function assertConfig() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !JWT_SECRET) {
    throw httpError(500, "Faltan variables de entorno del backend.");
  }

  const unsafeKeyRole = getSupabaseJwtRole(SUPABASE_SERVICE_ROLE_KEY);
  if (unsafeKeyRole === "anon" || SUPABASE_SERVICE_ROLE_KEY.startsWith("sb_publishable_")) {
    throw httpError(
      500,
      "SUPABASE_SERVICE_ROLE_KEY debe ser la service_role/secret key, no la anon/publishable key.",
    );
  }
}

function trimSlash(value) {
  return value.replace(/\/$/, "");
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function getSupabaseJwtRole(key) {
  const parts = key.split(".");
  if (parts.length < 2) return "";

  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload.role || "";
  } catch {
    return "";
  }
}
