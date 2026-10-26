// End-to-end smoke test in headless Chrome with a phone viewport. Run: npm test
// Set SHOTS=<folder> to also save a screenshot of each screen.
import assert from "node:assert/strict";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { startServer } from "./server.mjs";

const server = await startServer();
const url = `http://localhost:${server.address().port}/`;
const browser = await chromium.launch({ channel: "chrome" });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  acceptDownloads: true,
});
const page = await context.newPage();

const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));

// Each confirm() takes the next answer from this queue (default: accept).
const answers = [];
page.on("dialog", (dialog) => (answers.length ? answers.shift() : true) ? dialog.accept() : dialog.dismiss());

const shotsDir = process.env.SHOTS;
if (shotsDir) await mkdir(shotsDir, { recursive: true });
const shot = (name) => shotsDir && page.screenshot({ path: join(shotsDir, `${name}.png`), fullPage: true });

const nav = (label) => page.locator(".nav-button", { hasText: label }).click();
const expectToast = (re) =>
  page.waitForFunction((source) => new RegExp(source).test(document.querySelector(".toast")?.textContent || ""), re.source, { timeout: 3000 });
const expectCount = async (locator, n) => {
  for (let i = 0; i < 60 && (await locator.count()) !== n; i++) await page.waitForTimeout(50);
  assert.equal(await locator.count(), n);
};
const noHorizontalScroll = async (where) =>
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    `la página se desborda horizontalmente en ${where}`,
  );

async function addItem(fields, { again = false } = {}) {
  if (!(await page.locator("[data-item-form]").count())) await page.getByRole("button", { name: "+ Material" }).first().click();
  for (const [name, value] of Object.entries(fields)) {
    const input = page.locator(`[data-item-form] [name=${name}]`);
    (await input.evaluate((el) => el.tagName)) === "SELECT" ? await input.selectOption(value) : await input.fill(value);
  }
  await page.getByRole("button", { name: again ? "Guardar y agregar otro" : "Guardar", exact: true }).click();
}

const steps = [];
async function step(name, fn) {
  try {
    await fn();
    steps.push(`ok   ${name}`);
  } catch (error) {
    steps.push(`FAIL ${name}\n     ${error.message.split("\n")[0]}`);
    await page.screenshot({ path: join(tmpdir(), "fotostock-fail.png"), fullPage: true }).catch(() => {});
    throw error;
  }
}

try {
  await page.goto(url);

  await step("arranca vacía sin errores ni desborde", async () => {
    await page.getByText("Aún no hay material").waitFor();
    await noHorizontalScroll("panel vacío");
    await shot("01-panel-vacio");
  });

  await step("no ejecuta HTML inyectado en el nombre (XSS)", async () => {
    await addItem({ name: `<img src=x onerror="window.__xss=1">Sony`, category: "camaras", serial: "SN-1" });
    await page.locator(".item-title strong", { hasText: "<img" }).first().waitFor();
    assert.equal(await page.evaluate(() => window.__xss), undefined);
  });

  await step("'Guardar y agregar otro' deja el formulario abierto", async () => {
    await addItem({ name: "Lente 50mm", category: "lentes", serial: "L-50", location: "Maleta 1" }, { again: true });
    await expectToast(/Lente 50mm" guardado/);
    assert.equal(await page.locator("[data-item-form] [name=name]").inputValue(), "");
    assert.equal(await page.locator("[data-item-form] [name=category]").inputValue(), "lentes");
    await addItem({ name: "Flash Godox", category: "flashes" });
    await expectToast(/Flash Godox" guardado/);
  });

  await step("rechaza serial duplicado (sin importar mayúsculas)", async () => {
    await addItem({ name: "Otra cámara", serial: "sn-1" });
    await expectToast(/ya está registrado/);
    await page.keyboard.press("Escape");
    await expectCount(page.locator(".modal"), 0);
  });

  await step("rechaza nombre de solo espacios", async () => {
    await addItem({ name: "   " });
    await expectToast(/obligatorio/);
    await page.keyboard.press("Escape");
  });

  await step("el buscador no pierde el foco al escribir", async () => {
    await nav("Inventario");
    await page.locator("[data-search]").click();
    await page.keyboard.type("lente", { delay: 30 });
    assert.equal(await page.locator("[data-search]").inputValue(), "lente");
    assert.equal(await page.evaluate(() => document.activeElement?.matches("[data-search]")), true);
    await expectCount(page.locator(".item-row"), 1);
    await page.locator("[data-search]").fill("");
    await noHorizontalScroll("inventario");
    await shot("02-inventario");
  });

  await step("préstamo: se resalta y se puede devolver", async () => {
    await page.locator(".item-row", { hasText: "Flash Godox" }).getByRole("button", { name: /Editar/ }).click();
    await page.locator("[name=loan_to]").fill("Juan Pérez");
    await page.getByRole("button", { name: "Guardar cambios" }).click();
    await page.locator(".item-row.is-loaned", { hasText: "Prestado a Juan Pérez" }).waitFor();
    await nav("Panel");
    assert.equal(await page.locator(".metric.is-loan b").textContent(), "1");
    await shot("03-panel-con-prestamo");
    await page.locator(".loan-row").getByRole("button", { name: "Devuelto" }).click();
    await expectCount(page.locator(".loan-row"), 0);
  });

  await step("producción: salida, regreso parcial y finalizar marca faltantes", async () => {
    await page.getByRole("button", { name: "+ Producción" }).click();
    await page.locator("[data-package-form] [name=name]").fill("Boda <b>campestre</b>");
    await page.getByRole("button", { name: "Crear y elegir material" }).click();
    await page.locator("[data-pick-search]").fill("lente");
    await expectCount(page.locator(".selectable:not([hidden])"), 1);
    await page.locator("[data-pick-search]").fill("");
    await page.locator(".selectable", { hasText: "Lente 50mm" }).locator("input").check();
    await page.locator(".selectable", { hasText: "Flash Godox" }).locator("input").check();
    await shot("04-elegir-material");
    await page.getByRole("button", { name: "Guardar material" }).click();

    await page.locator(".check-row", { hasText: "Lente 50mm" }).click();
    await page.locator(".check-row", { hasText: "Flash Godox" }).click();
    await expectCount(page.locator(".check-row.is-checked"), 2);
    await page.getByRole("button", { name: "Regreso" }).click();
    await page.locator(".check-row", { hasText: "Lente 50mm" }).click();
    await shot("05-checklist-regreso");

    await nav("Inventario");
    assert.equal(await page.locator(".item-row", { hasText: "Lente 50mm" }).locator(".tag.blue").textContent(), "En paquete");
    await nav("Producciones");
    await page.getByRole("button", { name: "Finalizar producción" }).click();
    await expectToast(/1 equipos por revisar/);
    await nav("Inventario");
    assert.equal(await page.locator(".item-row", { hasText: "Flash Godox" }).locator(".tag.danger").textContent(), "Extraviado");
    assert.equal(await page.locator(".item-row", { hasText: "Lente 50mm" }).locator(".tag.success").textContent(), "Disponible");
  });

  await step("duplicar producción reutiliza el material con checklist limpio", async () => {
    await nav("Producciones");
    await page.getByRole("button", { name: "Duplicar" }).click();
    await page.getByText("0 de 2 marcados").waitFor();
    await noHorizontalScroll("producciones");
  });

  await step("cancelar el borrado no borra nada", async () => {
    await nav("Inventario");
    answers.push(false);
    await page.locator(".item-row", { hasText: "Lente 50mm" }).getByRole("button", { name: /Eliminar/ }).click();
    await expectCount(page.locator(".item-row"), 3);
  });

  await step("los datos sobreviven a recargar la página", async () => {
    await page.reload();
    await nav("Inventario");
    await expectCount(page.locator(".item-row"), 3);
  });

  let backupPath;
  await step("exportar respaldo descarga un JSON aunque falle 'Compartir'", async () => {
    await page.evaluate(() => {
      navigator.canShare = () => true;
      navigator.share = () => Promise.reject(new DOMException("bloqueado", "NotAllowedError"));
    });
    await nav("Respaldo");
    await shot("06-respaldo");
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /Exportar respaldo/ }).click()]);
    backupPath = await download.path();
    const data = JSON.parse(await readFile(backupPath, "utf8"));
    assert.equal(data.app, "fotostock");
    assert.equal(data.inventory.length, 3);
    assert.match(await page.locator(".pad").first().textContent(), /Último respaldo: (?!nunca)/);
  });

  await step("importar archivo corrupto no toca los datos", async () => {
    const bad = join(tmpdir(), "fotostock-bad.json");
    await writeFile(bad, "{ esto no es json");
    await page.locator("[data-import]").setInputFiles(bad);
    await expectToast(/no es un JSON válido/);
    await writeFile(bad, JSON.stringify({ hola: 1 }));
    await page.locator("[data-import]").setInputFiles(bad);
    await expectToast(/no es un respaldo/);
  });

  await step("importar limpia registros basura y restaura el inventario", async () => {
    const data = JSON.parse(await readFile(backupPath, "utf8"));
    data.inventory.push(null, { name: "" }, { name: 42, category: "inventada", status: "hackeado" }, { ...data.inventory[0] });
    const file = join(tmpdir(), "fotostock-mixed.json");
    await writeFile(file, JSON.stringify(data));

    answers.push(true);
    await page.locator("[data-import]").setInputFiles(file);
    await expectToast(/importado/);
    await nav("Inventario");
    // 3 originales + "42" saneado + copia con id duplicado (recibe id nuevo).
    await expectCount(page.locator(".item-row"), 5);
    assert.equal(await page.locator(".item-row", { hasText: "42" }).locator(".tag.success").textContent(), "Disponible");
  });

  await step("abre sin internet (service worker)", async () => {
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await context.setOffline(true);
    await page.reload();
    await page.locator(".nav-button").first().waitFor();
    await context.setOffline(false);
  });

  await step("sin errores en consola", async () => {
    assert.deepEqual(errors, []);
  });
} finally {
  console.log(steps.join("\n"));
  await browser.close();
  server.close();
}
