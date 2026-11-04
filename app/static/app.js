const state = {
  user: null,
  view: "dashboard",
  products: [],
  categories: [],
  suppliers: [],
  sales: [],
  losses: [],
  expenses: [],
  notifications: [],
  profile: null,
  offline: false,
  chartPeriod: "8days",
  search: "",
};

const page = document.querySelector("#page-content");
const dialog = document.querySelector("#app-dialog");
const authScreen = document.querySelector("#auth-screen");
const appShell = document.querySelector("#app-shell");
const titles = {
  dashboard: "Visão geral",
  products: "Produtos",
  sales: "Vendas",
  suppliers: "Fornecedores",
  categories: "Categorias",
  losses: "Perdas",
  expenses: "Gastos",
  profile: "Meu negócio",
};

function storageKey(name, userId = state.user?.id || "guest") {
  return `microgestao:${userId}:${name}`;
}

function cachedValues(name, fallback = [], userId = state.user?.id || "guest") {
  try {
    const stored = localStorage.getItem(storageKey(name, userId));
    return stored ? JSON.parse(stored) : fallback;
  } catch (error) {
    console.error(`Não foi possível ler ${name} do armazenamento local:`, error);
    return fallback;
  }
}

function storeValues(name, value) {
  localStorage.setItem(storageKey(name), JSON.stringify(value));
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function money(value) {
  return Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function dateTime(value) {
  const parsed = new Date(`${String(value).replace(" ", "T")}Z`);
  return Number.isNaN(parsed.getTime())
    ? String(value)
    : parsed.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

async function api(path, options = {}) {
  if (state.offline) return offlineApi(path, options);
  try {
    const response = await fetch(path, {
      ...options,
      headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
    });
    if (response.status === 204) return null;
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Não foi possível concluir a operação.");
    if (state.user && (!options.method || options.method === "GET")) {
      storeValues(`cache:${path}`, payload);
    }
    return payload;
  } catch (error) {
    if (error instanceof TypeError && state.user && options.method !== "POST" && options.method !== "PUT" && options.method !== "DELETE") {
      const cached = cachedValues(`cache:${path}`, null);
      if (cached !== null) {
        state.offline = true;
        updateConnectivity();
        return cached;
      }
    }
    throw error;
  }
}

function offlineCollections() {
  return {
    products: cachedValues("cache:/api/products"),
    categories: cachedValues("cache:/api/categories"),
    suppliers: cachedValues("cache:/api/suppliers"),
    sales: cachedValues("cache:/api/sales"),
    losses: cachedValues("cache:/api/losses"),
    expenses: cachedValues("cache:/api/expenses"),
    notifications: cachedValues("cache:/api/notifications", { items: [], unread_count: 0 }),
    profile: cachedValues("cache:/api/profile", state.profile),
  };
}

function persistOfflineCollections(data) {
  for (const [name, value] of Object.entries(data)) {
    const path = name === "profile" ? "/api/profile"
      : name === "notifications" ? "/api/notifications"
        : `/api/${name}`;
    storeValues(`cache:${path}`, value);
  }
}

function formatLocalDate(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function dashboardFromCache(data, period = "8days") {
  const today = formatLocalDate(new Date());
  const yesterdayDate = new Date();
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterday = formatLocalDate(yesterdayDate);
  const month = today.slice(0, 7);
  const lastMonthDate = new Date();
  lastMonthDate.setMonth(lastMonthDate.getMonth() - 1);
  const lastMonth = formatLocalDate(lastMonthDate).slice(0, 7);
  const sales = data.sales || [];
  const expenses = data.expenses || [];
  const salesFor = (date) => sales.filter((sale) => String(sale.created_at).slice(0, 10) === date);
  const total = (rows, key) => rows.reduce((sum, row) => sum + Number(row[key] || 0), 0);
  const chartDays = period === "today" || period === "yesterday" ? 1 : period === "30days" ? 30 : 8;
  const start = new Date();
  start.setDate(start.getDate() - (period === "yesterday" ? 1 : period === "today" ? 0 : chartDays - 1));
  const salesChart = [];
  for (let index = 0; index < chartDays; index += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const key = formatLocalDate(date);
    salesChart.push({ day: key, total: total(sales.filter((sale) => String(sale.created_at).slice(0, 10) === key), "total") });
  }
  const expenseCategories = new Map();
  expenses.filter((expense) => expense.expense_date.startsWith(month)).forEach((expense) => {
    expenseCategories.set(expense.category, (expenseCategories.get(expense.category) || 0) + Number(expense.amount));
  });
  const lowStock = (data.products || []).filter((product) => product.quantity <= product.min_stock);
  return {
    profile: data.profile,
    product_count: data.products.length,
    stock_units: data.products.reduce((sum, product) => sum + Number(product.quantity), 0),
    stock_value: data.products.reduce((sum, product) => sum + Number(product.quantity) * Number(product.cost_price), 0),
    low_stock_count: lowStock.length,
    low_stock: lowStock.slice(0, 6).map((product) => ({
      id: product.id, nome: product.name, quantidade: product.quantity,
      estoque_minimo: product.min_stock, categoria: product.category_name,
    })),
    sales_today: { count: salesFor(today).length, total: total(salesFor(today), "total") },
    sales_yesterday: { count: salesFor(yesterday).length, total: total(salesFor(yesterday), "total") },
    expenses_this_month: total(expenses.filter((item) => item.expense_date.startsWith(month)), "amount"),
    expenses_last_month: total(expenses.filter((item) => item.expense_date.startsWith(lastMonth)), "amount"),
    expense_categories: [...expenseCategories].map(([category, amount]) => ({ category, total: amount })),
    losses_this_month: {
      count: data.losses.filter((item) => String(item.created_at).startsWith(month)).length,
      quantity: data.losses.filter((item) => String(item.created_at).startsWith(month)).reduce((sum, item) => sum + Number(item.quantity), 0),
      total: total(data.losses.filter((item) => String(item.created_at).startsWith(month)), "amount"),
    },
    sales_chart: salesChart,
    expense_chart: [],
    recent_sales: sales.slice(0, 5).map((sale) => ({
      id: sale.id, data_venda: sale.created_at, valor_total: sale.total, forma_pagamento: sale.payment_method,
    })),
    weekly_sales: salesChart.slice(-7),
  };
}

function queueOfflineMutation(path, method, payload, id = null) {
  const queue = cachedValues("pending-queue");
  queue.push({ path, method, payload, temporary_id: id });
  storeValues("pending-queue", queue);
}

async function offlineApi(path, options = {}) {
  const method = options.method || "GET";
  const payload = options.body ? JSON.parse(options.body) : {};
  const data = offlineCollections();
  if (method === "GET") {
    if (path.startsWith("/api/dashboard")) {
      return dashboardFromCache(data, new URLSearchParams(path.split("?")[1]).get("period") || "8days");
    }
    if (path === "/api/session") return { authenticated: true, user: state.user };
    if (path === "/api/notifications") {
      const items = data.notifications.items || [];
      return { items, unread_count: items.filter((item) => !item.is_read).length };
    }
    const resource = path.split("/")[2];
    if (resource && Object.hasOwn(data, resource)) return data[resource];
    throw new Error("Este conteúdo ainda não foi salvo para consulta offline.");
  }

  if ((method === "POST" && path === "/api/notifications/read-all")) {
    data.notifications.items = (data.notifications.items || []).map((item) => ({ ...item, is_read: 1 }));
    queueOfflineMutation(path, method, payload);
  } else if ((method === "POST" || method === "PUT") && path === "/api/profile") {
    data.profile = { ...data.profile, ...payload };
    queueOfflineMutation(path, method, payload);
  } else {
    const parts = path.split("/").filter(Boolean);
    const resource = parts[1];
    const id = parts[2] ? Number(parts[2]) : null;
    const collection = data[resource];
    if (!Array.isArray(collection)) throw new Error("Não é possível alterar este conteúdo offline.");
    if (method === "POST") {
      const temporaryId = -Math.floor(performance.timeOrigin + performance.now());
      const now = new Date().toISOString();
      let record;
      if (resource === "products") {
        const category = data.categories.find((item) => item.id === Number(payload.category_id));
        record = {
          id: temporaryId, ...payload, category_id: payload.category_id ? Number(payload.category_id) : null,
          category_name: category?.name || null, updated_at: now,
        };
      } else if (resource === "suppliers") {
        record = {
          id: temporaryId, company_name: payload.company_name, category: payload.category || "",
          contact_name: payload.contact_name || "", phone: payload.phone || "",
          email: payload.email || "", notes: payload.notes || "",
        };
      } else if (resource === "categories") record = { id: temporaryId, name: payload.name };
      else if (resource === "expenses") record = { id: temporaryId, ...payload, amount: Number(payload.amount) };
      else if (resource === "losses") {
        record = {
          id: temporaryId, ...payload, product_id: payload.product_id ? Number(payload.product_id) : null,
          amount: Number(payload.amount), created_at: now,
        };
        const product = data.products.find((item) => item.id === record.product_id);
        if (product && product.quantity < record.quantity) throw new Error(`Estoque insuficiente para ${product.name}.`);
        if (product) {
          record.product_name = product.name;
          product.quantity -= Number(record.quantity);
        }
      } else if (resource === "sales") {
        let total = Number(payload.amount || 0);
        let items = [];
        if (payload.items) {
          items = payload.items.map((line) => {
            const product = data.products.find((item) => item.id === Number(line.product_id));
            if (!product || product.quantity < Number(line.quantity)) throw new Error("Estoque insuficiente para um dos produtos.");
            product.quantity -= Number(line.quantity);
            return { product_id: product.id, quantity: Number(line.quantity) };
          });
          total = items.reduce((sum, line) => sum + Number(data.products.find((item) => item.id === line.product_id).sale_price) * line.quantity, 0);
        }
        record = {
          id: temporaryId, description: payload.description || "Venda", total,
          payment_method: payload.payment_method || "PIX", created_at: payload.sale_date || now,
          item_count: items.length, items,
        };
      } else throw new Error("Não é possível criar esse tipo de registro offline.");
      collection.push(record);
      queueOfflineMutation(path, method, payload, temporaryId);
      persistOfflineCollections(data);
      return { id: temporaryId, total: record.total };
    } else if (method === "PUT") {
      const index = collection.findIndex((item) => Number(item.id) === id);
      if (index < 0) throw new Error("Cadastro não encontrado.");
      if (resource === "losses") {
        const previous = collection[index];
        const previousProduct = data.products.find((product) => product.id === previous.product_id);
        if (previousProduct) previousProduct.quantity += Number(previous.quantity);
        const nextProduct = data.products.find((product) => product.id === Number(payload.product_id));
        if (!nextProduct || nextProduct.quantity < Number(payload.quantity)) throw new Error("Estoque insuficiente para atualizar essa perda.");
        nextProduct.quantity -= Number(payload.quantity);
        payload.product_id = Number(payload.product_id);
        payload.product_name = nextProduct.name;
      }
      collection[index] = { ...collection[index], ...payload, amount: payload.amount === undefined ? collection[index].amount : Number(payload.amount) };
      queueOfflineMutation(path, method, payload);
    } else if (method === "DELETE") {
      const record = collection.find((item) => Number(item.id) === id);
      if (!record) throw new Error("Cadastro não encontrado.");
      if (resource === "sales" && record.items) {
        record.items.forEach((line) => {
          const product = data.products.find((item) => item.id === line.product_id);
          if (product) product.quantity += line.quantity;
        });
      }
      if (resource === "losses" && record.product_id) {
        const product = data.products.find((item) => item.id === record.product_id);
        if (product) product.quantity += record.quantity;
      }
      data[resource] = collection.filter((item) => Number(item.id) !== id);
      queueOfflineMutation(path, method, payload);
    }
  }
  persistOfflineCollections(data);
  return null;
}

function updateConnectivity() {
  const offline = state.offline || !navigator.onLine;
  const indicator = document.querySelector("#sync-status");
  indicator.classList.toggle("offline", offline);
  document.querySelector("#sync-label").textContent = offline ? "Offline" : "Sincronizado";
  document.querySelector("#business-plan").textContent = offline ? "Modo offline" : "Plano gratuito";
}

async function synchronizeOfflineChanges() {
  if (!state.user || !navigator.onLine || state.offline) return;
  const queue = cachedValues("pending-queue");
  if (!queue.length) return;
  const idMap = new Map();
  for (const [index, operation] of queue.entries()) {
    const path = operation.path.replace(/\/(-\d+)(?=\/?$)/, (match, id) => `/${idMap.get(Number(id)) ?? id}`);
    const payload = structuredClone(operation.payload);
    const remapReferences = (value) => {
      if (Array.isArray(value)) return value.map(remapReferences);
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [
        key,
        ["product_id", "category_id"].includes(key) && idMap.has(Number(child))
          ? idMap.get(Number(child))
          : remapReferences(child),
      ]));
    };
    const mappedPayload = remapReferences(payload);
    try {
      const response = await api(path, {
        method: operation.method,
        body: operation.method === "DELETE" ? undefined : JSON.stringify(mappedPayload),
      });
      if (operation.temporary_id && response?.id) idMap.set(operation.temporary_id, response.id);
      const remaining = queue.slice(index + 1);
      for (const pending of remaining) {
        pending.path = pending.path.replace(/\/(-\d+)(?=\/?$)/, (match, id) => `/${idMap.get(Number(id)) ?? id}`);
        pending.payload = remapReferences(pending.payload);
      }
      storeValues("pending-queue", remaining);
    } catch (error) {
      toast(`Alterações offline aguardam sincronização: ${error.message}`, true);
      return;
    }
  }
  toast("Alterações offline sincronizadas.");
  await Promise.all(["products", "categories", "suppliers", "sales", "losses", "expenses", "notifications", "profile"].map((resource) =>
    api(resource === "profile" ? "/api/profile" : `/api/${resource}`).then((value) => storeValues(`cache:${resource === "profile" ? "/api/profile" : `/api/${resource}`}`, value))
  ));
  await navigate(state.view);
}

function toast(message, isError = false) {
  const element = document.createElement("div");
  element.className = `toast${isError ? " error" : ""}`;
  element.textContent = message;
  document.querySelector("#toast-region").append(element);
  window.setTimeout(() => element.remove(), 4000);
}

function setAuthError(message, success = false) {
  const target = document.querySelector("#auth-error");
  if (target) {
    target.textContent = message;
    target.classList.toggle("success", success);
  }
}

function renderAuth(mode = "login", notice = "") {
  const registering = mode === "register";
  const recovering = mode === "forgot";
  const resetting = mode === "reset";
  const login = !registering && !recovering && !resetting;
  const title = registering ? "Crie sua conta"
    : recovering ? "Recupere sua senha"
      : resetting ? "Escolha uma nova senha"
        : "Que bom ter você aqui.";
  const subtitle = registering ? "Organize seu negócio com leveza. É rapidinho."
    : recovering ? "Informe seu e-mail e enviaremos um link para redefinir sua senha."
      : resetting ? "Crie uma senha nova para voltar a acessar sua conta."
        : "Entre para acompanhar seu negócio de perto.";
  const footer = registering
    ? `Já tem uma conta? <button class="text-button" id="auth-switch" type="button">Entrar</button>`
    : login
      ? `Ainda não tem uma conta? <button class="text-button" id="auth-switch" type="button">Criar conta</button>`
      : `Lembrou sua senha? <button class="text-button" id="auth-switch" type="button">Voltar para entrar</button>`;
  document.querySelector("#auth-content").innerHTML = `
    <p class="auth-kicker">${registering ? "UM BOM COMEÇO" : recovering ? "RECUPERAÇÃO DE ACESSO" : resetting ? "NOVA SENHA" : "BEM-VINDA(O) DE VOLTA"}</p>
    <h2 class="auth-title">${title}</h2>
    <p class="auth-subtitle">${subtitle}</p>
    <form class="auth-form" id="auth-form">
      ${registering ? `<div class="field"><label for="auth-name">Seu nome</label><input id="auth-name" name="name" autocomplete="name" maxlength="100" placeholder="Como podemos te chamar?" required></div>` : ""}
      ${registering ? `<div class="field"><label for="auth-business-name">Nome do negócio</label><input id="auth-business-name" name="business_name" autocomplete="organization" maxlength="120" placeholder="Ex.: Meu pequeno negócio"></div>` : ""}
      ${!resetting ? `<div class="field"><label for="auth-email">E-mail</label><input id="auth-email" name="email" type="email" autocomplete="email" maxlength="150" placeholder="voce@exemplo.com" required></div>` : ""}
      ${!recovering ? `<div class="field"><label for="auth-password">${resetting ? "Nova senha" : "Senha"}</label><input id="auth-password" name="password" type="password" autocomplete="${registering || resetting ? "new-password" : "current-password"}" minlength="${registering || resetting ? "8" : "1"}" maxlength="128" placeholder="${registering || resetting ? "Pelo menos 8 caracteres" : "Sua senha"}" required></div>` : ""}
      ${resetting ? `<div class="field"><label for="auth-confirm-password">Confirme a nova senha</label><input id="auth-confirm-password" name="confirm_password" type="password" autocomplete="new-password" minlength="8" maxlength="128" placeholder="Digite a senha novamente" required></div>` : ""}
      ${login ? `<div class="auth-forgot-row"><button class="auth-forgot-button" id="forgot-password" type="button">Esqueceu a senha?</button></div>` : ""}
      <p class="auth-error${notice ? " success" : ""}" id="auth-error" role="alert">${escapeHtml(notice)}</p>
      <button class="primary-button auth-submit" type="submit">${registering ? "Criar minha conta" : recovering ? "Enviar link de recuperação" : resetting ? "Salvar nova senha" : "Entrar na minha conta"} <span aria-hidden="true">→</span></button>
    </form>
    ${login ? `<button class="offline-login" id="offline-login" type="button">↯ &nbsp; Entrar em Modo OFFLINE</button>` : ""}
    <p class="auth-switch">${footer}</p>`;

  const authSwitch = document.querySelector("#auth-switch");
  if (authSwitch) {
    authSwitch.addEventListener("click", () => renderAuth(registering ? "login" : login ? "register" : "login"));
  }
  const forgotButton = document.querySelector("#forgot-password");
  if (forgotButton) forgotButton.addEventListener("click", () => renderAuth("forgot"));
  const offlineButton = document.querySelector("#offline-login");
  if (offlineButton) offlineButton.addEventListener("click", enterOffline);
  document.querySelector("#auth-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    setAuthError("");
    const values = Object.fromEntries(new FormData(event.currentTarget));
    if (resetting && values.password !== values.confirm_password) {
      setAuthError("As senhas não conferem.");
      return;
    }
    const button = event.currentTarget.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      const endpoint = registering ? "register"
        : recovering ? "password-reset-request"
          : resetting ? "password-reset"
            : "login";
      if (resetting) values.token = new URLSearchParams(window.location.search).get("reset") || "";
      delete values.confirm_password;
      const result = await api(`/api/${endpoint}`, {
        method: "POST",
        body: JSON.stringify(values),
      });
      if (registering || login) {
        if (result.user) storeValues("last-user", result.user);
        enterApp(result.user);
      } else if (recovering) {
        setAuthError(result.message, true);
        event.currentTarget.reset();
      } else {
        window.history.replaceState({}, "", window.location.pathname);
        renderAuth("login", result.message);
      }
    } catch (error) {
      setAuthError(error.message);
    } finally {
      button.disabled = false;
    }
  });
}

function enterApp(user, offline = false) {
  state.user = user;
  state.offline = offline;
  state.profile = user.profile || null;
  authScreen.classList.add("hidden");
  appShell.classList.remove("hidden");
  localStorage.setItem(storageKey("last-user", "guest"), JSON.stringify(user));
  const profile = state.profile || {};
  const ownerName = profile.owner_name || user.name || "Minha conta";
  const initials = profile.initials || initialsFor(ownerName);
  document.querySelector("#user-avatar").textContent = initials;
  document.querySelector("#top-avatar").textContent = initials;
  document.querySelector("#business-avatar").textContent = initials;
  document.querySelector("#business-name").textContent = profile.business_name || `Negócio de ${ownerName.split(" ")[0]}`;
  document.querySelector("#sidebar-name").textContent = ownerName;
  document.querySelector("#sidebar-role").textContent = profile.role || "Proprietário(a)";
  document.querySelector("#low-stock-badge").classList.add("hidden");
  document.querySelector("#today-label").textContent = new Date().toLocaleDateString("pt-BR", {
    weekday: "long", day: "numeric", month: "long",
  });
  updateConnectivity();
  Promise.resolve(state.profile ? state.profile : api("/api/profile")).then((freshProfile) => {
    if (freshProfile) {
      state.profile = freshProfile;
      storeValues("cache:/api/profile", freshProfile);
      applyProfile(freshProfile);
    }
  }).catch((error) => console.error("Não foi possível carregar o perfil do negócio:", error));
  navigate("dashboard");
  if (!offline) {
    warmOfflineCache().then(() => synchronizeOfflineChanges()).catch((error) => {
      console.error("Não foi possível sincronizar os dados locais:", error);
    });
  }
}

function initialsFor(name) {
  return String(name || "").trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toLocaleUpperCase("pt-BR") || "MG";
}

function applyProfile(profile) {
  const ownerName = profile.owner_name || state.user?.name || "Minha conta";
  const initials = profile.initials || initialsFor(ownerName);
  document.querySelector("#user-avatar").textContent = initials;
  document.querySelector("#top-avatar").textContent = initials;
  document.querySelector("#business-avatar").textContent = initials;
  document.querySelector("#business-name").textContent = profile.business_name;
  document.querySelector("#sidebar-name").textContent = ownerName;
  document.querySelector("#sidebar-role").textContent = profile.role || "Proprietário(a)";
}

function enterOffline() {
  const user = cachedValues("last-user", null, "guest");
  if (!user || (!cachedValues(`cache:/api/dashboard?period=${state.chartPeriod}`, null, user.id)
    && !cachedValues("cache:/api/products", null, user.id))) {
    setAuthError("Entre com internet ao menos uma vez para preparar seus dados para uso offline.");
    return;
  }
  user.profile = user.profile || cachedValues("cache:/api/profile", null);
  enterApp(user, true);
  updateConnectivity();
  toast("Modo offline: alterações serão guardadas neste dispositivo.");
}

async function navigate(view) {
  if (!titles[view]) return;
  state.view = view;
  document.querySelector("#breadcrumb-current").textContent = titles[view];
  document.querySelectorAll("[data-nav]").forEach((button) => {
    button.classList.toggle("active", button.dataset.nav === view);
  });
  document.querySelector(".sidebar").classList.remove("open");
  try {
    if (view === "dashboard") await renderDashboard();
    if (view === "products") await renderProducts();
    if (view === "sales") await renderSales();
    if (view === "suppliers") await renderSuppliers();
    if (view === "categories") await renderCategories();
    if (view === "losses") await renderLosses();
    if (view === "expenses") await renderExpenses();
    if (view === "profile") await renderProfile();
  } catch (error) {
    toast(error.message, true);
  }
}

function heading(title, subtitle, action = "") {
  return `<div class="page-heading"><div><h1>${title}</h1><p>${subtitle}</p></div>${action ? `<div class="heading-actions">${action}</div>` : ""}</div>`;
}

function emptyState(title, description) {
  return `<div class="empty-state"><strong>${title}</strong><span>${description}</span></div>`;
}

async function renderDashboard() {
  const [data, notifications] = await Promise.all([
    api(`/api/dashboard?period=${state.chartPeriod}`),
    api("/api/notifications").catch((error) => {
      console.error("Não foi possível carregar as notificações:", error);
      return { items: [], unread_count: 0 };
    }),
  ]);
  state.profile = data.profile || state.profile;
  state.notifications = notifications.items;
  applyProfile(state.profile || {});
  const lowStock = data.low_stock || [];
  const lowStockBadge = document.querySelector("#low-stock-badge");
  lowStockBadge.textContent = data.low_stock_count || 0;
  lowStockBadge.classList.toggle("hidden", !data.low_stock_count);
  setNotificationCount(notifications.unread_count || 0);
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Bom dia" : hour < 18 ? "Boa tarde" : "Boa noite";
  const ownerName = (state.profile?.owner_name || state.user.name || "").split(" ")[0];
  const chart = buildLineChart(data.sales_chart || [], state.chartPeriod);
  const expenseChange = Number(data.expenses_this_month) - Number(data.expenses_last_month);
  const salesChange = Number(data.sales_today.total) - Number(data.sales_yesterday.total);
  page.innerHTML = `
    <section class="welcome-banner">
      <div class="welcome-copy"><span class="eyebrow">UM NOVO DIA, NOVAS CONQUISTAS</span><h1>${greeting}, ${escapeHtml(ownerName)}</h1><p>Tenha uma visão clara do que importa hoje.</p><span class="welcome-stamp">✦ &nbsp;Tudo sob controle</span></div>
      <div class="welcome-art" aria-hidden="true"><span class="sun"></span><span class="hill hill-back"></span><span class="hill hill-front"></span></div>
    </section>
    <div class="stats-grid">
      <button class="stat-card stat-link" data-nav="sales"><div class="stat-top"><span>Vendas de hoje</span><span class="stat-icon">↗</span></div><strong class="stat-value">${money(data.sales_today.total)}</strong><span class="stat-foot">${data.sales_today.count} venda(s) · ${salesChange >= 0 ? "+" : ""}${money(salesChange)} vs. ontem</span></button>
      <button class="stat-card stat-link" data-nav="products"><div class="stat-top"><span>Itens em estoque</span><span class="stat-icon">▦</span></div><strong class="stat-value">${data.stock_units}</strong><span class="stat-foot">${data.low_stock_count} produto(s) pedindo atenção</span></button>
      <button class="stat-card stat-link" data-nav="expenses"><div class="stat-top"><span>Gastos no mês</span><span class="stat-icon">↘</span></div><strong class="stat-value">${money(data.expenses_this_month)}</strong><span class="stat-foot">${expenseChange <= 0 ? "↓" : "↑"} ${money(Math.abs(expenseChange))} vs. mês anterior</span></button>
    </div>
    <div class="dashboard-grid">
      <section class="panel chart-panel">
        <div class="panel-header"><div><h2>Movimento de vendas</h2><div class="panel-subtitle">Acompanhe seu faturamento no período</div></div>
          <label class="sr-only" for="chart-period">Período do gráfico</label><select class="period-select" id="chart-period"><option value="today">Hoje</option><option value="yesterday">Ontem</option><option value="8days">8 dias</option><option value="30days">30 dias</option></select></div>
        <div class="panel-body">${chart}</div>
      </section>
      <section class="panel">
        <div class="panel-header"><div><h2>Alertas rápidos</h2><div class="panel-subtitle">O que precisa da sua atenção</div></div><button class="link-button" id="open-notifications">Ver tudo →</button></div>
        <div class="panel-body">${lowStock.length ? `<div class="stock-list">${lowStock.slice(0, 4).map((item) => `<div class="stock-row"><span class="stock-dot${item.quantidade === 0 ? " out" : ""}"></span><span class="stock-copy"><strong>${escapeHtml(item.nome)}</strong><small>${escapeHtml(item.categoria || "Sem categoria")} · mínimo ${item.estoque_minimo}</small></span><span class="stock-number">${item.quantidade === 0 ? "Esgotado" : `${item.quantidade} un.`}</span></div>`).join("")}</div>` : emptyState("Tudo sob controle!", "Não há pendências de estoque no momento.")}</div>
      </section>
      <section class="panel">
        <div class="panel-header"><div><h2>Vendas recentes</h2><div class="panel-subtitle">Suas últimas movimentações</div></div><button class="link-button" data-nav="sales">Ver todas →</button></div>
        <div class="panel-body">${data.recent_sales.length ? `<div class="sales-list">${data.recent_sales.map((sale) => `<div class="sale-row"><div><strong>${escapeHtml(sale.description || `Venda #${sale.id}`)}</strong><br><small>${dateTime(sale.data_venda)} · ${escapeHtml(sale.forma_pagamento)}</small></div><span class="sale-amount">${money(sale.valor_total)}</span></div>`).join("")}</div>` : emptyState("Sua primeira venda começa aqui", "Registre uma venda para acompanhar seu movimento.")}</div>
      </section>
      <section class="panel">
        <div class="panel-header"><div><h2>Gastos por categoria</h2><div class="panel-subtitle">Despesas deste mês</div></div><button class="link-button" data-nav="expenses">Ver gastos →</button></div>
        <div class="panel-body">${data.expense_categories.length ? `<div class="expense-category-list">${data.expense_categories.map((item) => `<div class="expense-category-row"><span>${escapeHtml(item.category)}</span><strong>${money(item.total)}</strong></div>`).join("")}</div>` : emptyState("Nenhum gasto registrado", "Seus gastos do mês aparecerão aqui.")}</div>
      </section>
    </div>`;
  document.querySelector("#chart-period").value = state.chartPeriod;
  document.querySelector("#chart-period").addEventListener("change", (event) => {
    state.chartPeriod = event.target.value;
    navigate("dashboard");
  });
  document.querySelector("#open-notifications").addEventListener("click", openNotifications);
}

function buildLineChart(rows, period, metric = "vendas") {
  const count = period === "today" || period === "yesterday" ? 1 : period === "30days" ? 30 : 8;
  const start = new Date();
  start.setDate(start.getDate() - (period === "yesterday" ? 1 : period === "today" ? 0 : count - 1));
  const values = Array.from({ length: count }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const key = formatLocalDate(date);
    const item = rows.find((row) => row.day === key);
    return { day: key, total: Number(item?.total || 0) };
  });
  const max = Math.max(1, ...values.map((item) => item.total));
  const points = values.map((item, index) => ({
    ...item,
    x: count === 1 ? 320 : 24 + index * 592 / (count - 1),
    y: 170 - item.total / max * 138,
  }));
  const path = points.map((point, index) => `${index ? "L" : "M"}${point.x},${point.y}`).join(" ");
  const fill = `${path} L${points.at(-1).x},182 L${points[0].x},182 Z`;
  const labels = period === "30days" ? points.filter((_, index) => index % 5 === 0 || index === points.length - 1) : points;
  return `<div class="line-chart"><svg viewBox="0 0 640 220" role="img" aria-label="Gráfico de ${metric} em reais nos últimos ${count} dias">
    <defs><linearGradient id="sales-gradient" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#1d75b9" stop-opacity=".2"/><stop offset="100%" stop-color="#1d75b9" stop-opacity="0"/></linearGradient></defs>
    <path d="M24 32 H616 M24 101 H616 M24 170 H616" stroke="#eaf0f4" stroke-dasharray="4 5" fill="none"/>
    <path d="${fill}" fill="url(#sales-gradient)"/><path d="${path}" fill="none" stroke="#1d75b9" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
    ${points.map((point) => `<circle cx="${point.x}" cy="${point.y}" r="5" fill="#fff" stroke="#1d75b9" stroke-width="3"><title>${new Date(`${point.day}T12:00:00`).toLocaleDateString("pt-BR")}: ${money(point.total)}</title></circle>`).join("")}
    ${labels.map((point) => `<text x="${point.x}" y="205" text-anchor="middle" fill="#8a9aab" font-size="10">${new Date(`${point.day}T12:00:00`).toLocaleDateString("pt-BR", { day: "2-digit", month: count > 8 ? "2-digit" : undefined })}</text>`).join("")}
  </svg><div class="chart-summary"><span>${metric === "vendas" ? "Faturamento" : "Total de gastos"} no período</span><strong>${money(values.reduce((sum, item) => sum + item.total, 0))}</strong></div></div>`;
}

async function renderProducts(search = "", reload = true) {
  if (reload) [state.products, state.categories] = await Promise.all([api("/api/products"), api("/api/categories")]);
  const query = search.trim().toLocaleLowerCase("pt-BR");
  const rows = state.products.filter((item) => `${item.name} ${item.category_name || ""}`.toLocaleLowerCase("pt-BR").includes(query));
  const totalUnits = state.products.reduce((sum, product) => sum + Number(product.quantity), 0);
  const lowProducts = state.products.filter((product) => product.quantity <= product.min_stock).length;
  const stockValue = state.products.reduce((sum, product) => sum + Number(product.quantity) * Number(product.cost_price), 0);
  page.innerHTML = `
    ${heading("Seu estoque", "Veja o que está disponível e reponha antes de acabar.", `<button class="primary-button" data-action="add-product">＋ Novo produto</button>`)}
    <div class="stats-grid compact-stats">
      <article class="stat-card"><div class="stat-top"><span>Itens em estoque</span><span class="stat-icon">▦</span></div><strong class="stat-value">${totalUnits}</strong><span class="stat-foot">${state.products.length} produtos diferentes</span></article>
      <article class="stat-card"><div class="stat-top"><span>Estoque baixo</span><span class="stat-icon">!</span></div><strong class="stat-value">${lowProducts}</strong><span class="stat-foot">Produtos no mínimo ou abaixo</span></article>
      <article class="stat-card"><div class="stat-top"><span>Valor estimado</span><span class="stat-icon">◈</span></div><strong class="stat-value">${money(stockValue)}</strong><span class="stat-foot">Calculado pelo preço de custo</span></article>
    </div>
    <section class="panel">
      <div class="panel-header"><h2>Produtos <span class="badge">${state.products.length}</span></h2><div class="toolbar"><input class="search-input" id="product-search" type="search" placeholder="Buscar produto..." value="${escapeHtml(search)}" aria-label="Buscar produto"></div></div>
      <div class="table-wrap"><table class="data-table"><thead><tr><th>Produto</th><th>Categoria</th><th>Quantidade</th><th>Mínimo</th><th>Preço de venda</th><th>Status</th><th></th></tr></thead><tbody>
      ${rows.length ? rows.map((product) => {
    const soldOut = Number(product.quantity) === 0;
    const low = Number(product.quantity) <= Number(product.min_stock);
    return `<tr><td><span class="product-icon">${escapeHtml(product.icon || "▦")}</span>${escapeHtml(product.name)}</td><td>${escapeHtml(product.category_name || "Sem categoria")}</td><td>${product.quantity} un.</td><td>${product.min_stock} un.</td><td>${money(product.sale_price)}</td><td><span class="badge${low ? " low" : ""}">${soldOut ? "Esgotado" : low ? "Estoque baixo" : "Em dia"}</span></td><td><div class="table-actions"><button class="table-action" data-action="edit-product" data-id="${product.id}" aria-label="Editar ${escapeHtml(product.name)}">Editar</button><button class="table-action delete" data-action="delete-product" data-id="${product.id}" aria-label="Excluir ${escapeHtml(product.name)}">Excluir</button></div></td></tr>`;
  }).join("") : `<tr><td class="table-empty" colspan="7">${query ? "Nenhum produto encontrado." : "Ainda não há produtos. Cadastre o primeiro para começar."}</td></tr>`}
      </tbody></table></div>
    </section>`;
  document.querySelector("#product-search").addEventListener("input", (event) => renderProducts(event.target.value, false));
}

async function renderSales() {
  [state.sales, state.products] = await Promise.all([api("/api/sales"), api("/api/products")]);
  const today = formatLocalDate(new Date());
  const salesToday = state.sales.filter((sale) => String(sale.created_at).slice(0, 10) === today);
  const rangeTotal = state.sales.reduce((sum, sale) => sum + Number(sale.total), 0);
  const hourTotals = new Map();
  state.sales.forEach((sale) => {
    const hour = String(sale.created_at).slice(11, 13);
    if (hour) hourTotals.set(hour, (hourTotals.get(hour) || 0) + Number(sale.total));
  });
  const bestHour = [...hourTotals.entries()].sort((first, second) => second[1] - first[1])[0];
  page.innerHTML = `
    ${heading("Suas vendas", "Acompanhe o movimento do seu negócio e registre cada venda.", `<button class="primary-button" data-action="add-manual-sale">＋ Nova venda</button><button class="secondary-button" data-action="add-sale">Venda com produtos</button>`)}
    <div class="stats-grid compact-stats">
      <article class="stat-card"><div class="stat-top"><span>Total vendido</span><span class="stat-icon">↗</span></div><strong class="stat-value">${money(rangeTotal)}</strong><span class="stat-foot">${state.sales.length} venda(s) no histórico</span></article>
      <article class="stat-card"><div class="stat-top"><span>Vendas de hoje</span><span class="stat-icon">◷</span></div><strong class="stat-value">${money(salesToday.reduce((sum, sale) => sum + Number(sale.total), 0))}</strong><span class="stat-foot">${salesToday.length} venda(s) hoje</span></article>
      <article class="stat-card"><div class="stat-top"><span>Melhor horário</span><span class="stat-icon">✦</span></div><strong class="stat-value">${bestHour ? `${bestHour[0]}h` : "—"}</strong><span class="stat-foot">${bestHour ? money(bestHour[1]) + " em vendas" : "Registre vendas para ver insights"}</span></article>
    </div>
    <section class="panel">
      <div class="panel-header"><h2>Histórico de vendas <span class="badge">${state.sales.length}</span></h2></div>
      <div class="table-wrap"><table class="data-table"><thead><tr><th>Descrição</th><th>Data e horário</th><th>Itens</th><th>Pagamento</th><th>Total</th><th></th></tr></thead><tbody>
      ${state.sales.length ? state.sales.map((sale) => `<tr><td>${escapeHtml(sale.description || `Venda #${sale.id}`)}</td><td>${dateTime(sale.created_at)}</td><td>${sale.item_count}</td><td>${escapeHtml(sale.payment_method)}</td><td>${money(sale.total)}</td><td><div class="table-actions"><button class="table-action" data-action="edit-sale" data-id="${sale.id}">Editar</button><button class="table-action delete" data-action="delete-sale" data-id="${sale.id}">Excluir</button></div></td></tr>`).join("") : `<tr><td class="table-empty" colspan="6">Nenhuma venda registrada. Que tal registrar a primeira?</td></tr>`}
      </tbody></table></div>
    </section>`;
}

async function renderSuppliers(search = "", reload = true) {
  if (reload) state.suppliers = await api("/api/suppliers");
  const query = search.trim().toLocaleLowerCase("pt-BR");
  const suppliers = state.suppliers.filter((supplier) =>
    `${supplier.company_name} ${supplier.category || ""}`.toLocaleLowerCase("pt-BR").includes(query));
  page.innerHTML = `
    ${heading("Fornecedores", "Mantenha seus contatos importantes sempre por perto.", `<button class="primary-button" data-action="add-supplier">＋ Novo fornecedor</button>`)}
    <section class="panel">
      <div class="panel-header"><h2>Contatos cadastrados <span class="badge">${state.suppliers.length}</span></h2><input class="search-input" id="supplier-search" type="search" aria-label="Buscar fornecedor por nome ou categoria" placeholder="Buscar por nome ou categoria" value="${escapeHtml(search)}"></div>
      <div class="table-wrap"><table class="data-table"><thead><tr><th>Fornecedor</th><th>Categoria</th><th>Contato</th><th>Telefone / WhatsApp</th><th>E-mail</th><th></th></tr></thead><tbody>
      ${suppliers.length ? suppliers.map((supplier) => {
    const phone = String(supplier.phone || "").replace(/\D/g, "");
    const waPhone = phone ? (phone.startsWith("55") ? phone : `55${phone}`) : "";
    return `<tr><td>${escapeHtml(supplier.company_name)}</td><td>${escapeHtml(supplier.category || "—")}</td><td>${escapeHtml(supplier.contact_name || "—")}</td><td>${waPhone ? `<a class="table-link" href="https://wa.me/${escapeHtml(waPhone)}" target="_blank" rel="noopener noreferrer">${escapeHtml(supplier.phone)} ↗</a>` : escapeHtml(supplier.phone || "—")}</td><td>${escapeHtml(supplier.email || "—")}</td><td><div class="table-actions"><button class="table-action" data-action="edit-supplier" data-id="${supplier.id}">Editar</button><button class="table-action delete" data-action="delete-supplier" data-id="${supplier.id}">Excluir</button></div></td></tr>`;
  }).join("") : `<tr><td class="table-empty" colspan="6">${query ? "Nenhum fornecedor encontrado." : "Nenhum fornecedor cadastrado."}</td></tr>`}
      </tbody></table></div>
    </section>`;
  document.querySelector("#supplier-search").addEventListener("input", (event) => renderSuppliers(event.target.value, false));
}

async function renderCategories() {
  [state.categories, state.products] = await Promise.all([api("/api/categories"), api("/api/products")]);
  const productCounts = new Map();
  state.products.forEach((product) => {
    if (product.category_id) productCounts.set(product.category_id, (productCounts.get(product.category_id) || 0) + 1);
  });
  page.innerHTML = `
    ${heading("Categorias", "Organize seus produtos do seu jeito.", `<button class="primary-button" data-action="add-category">＋ Nova categoria</button>`)}
    <div class="category-grid">${state.categories.length ? state.categories.map((category) => `<article class="category-card"><span class="category-symbol">☷</span><span class="category-copy"><strong>${escapeHtml(category.name)}</strong><small>${productCounts.get(category.id) || 0} produto(s)</small></span><button class="icon-button" data-action="edit-category" data-id="${category.id}" aria-label="Editar ${escapeHtml(category.name)}">✎</button><button class="icon-button" data-action="delete-category" data-id="${category.id}" aria-label="Excluir ${escapeHtml(category.name)}">×</button></article>`).join("") : `<section class="panel empty-panel">${emptyState("Suas categorias começam aqui", "Crie categorias para deixar os produtos mais organizados.")}</section>`}</div>`;
}

async function renderLosses() {
  [state.losses, state.products] = await Promise.all([api("/api/losses"), api("/api/products")]);
  const total = state.losses.reduce((sum, loss) => sum + Number(loss.amount), 0);
  const quantity = state.losses.reduce((sum, loss) => sum + Number(loss.quantity), 0);
  page.innerHTML = `
    ${heading("Perdas", "Registre avarias e outras perdas para acompanhar o impacto no negócio.", `<button class="primary-button" data-action="add-loss">＋ Registrar perda</button>`)}
    <div class="stats-grid compact-stats">
      <article class="stat-card"><div class="stat-top"><span>Prejuízo acumulado</span><span class="stat-icon">↘</span></div><strong class="stat-value">${money(total)}</strong><span class="stat-foot">Valor dos registros cadastrados</span></article>
      <article class="stat-card"><div class="stat-top"><span>Itens perdidos</span><span class="stat-icon">◇</span></div><strong class="stat-value">${quantity}</strong><span class="stat-foot">Unidades registradas</span></article>
      <article class="stat-card"><div class="stat-top"><span>Ocorrências</span><span class="stat-icon">!</span></div><strong class="stat-value">${state.losses.length}</strong><span class="stat-foot">Registros de perdas</span></article>
    </div>
    <section class="panel"><div class="panel-header"><h2>Histórico de perdas</h2></div>
      <div class="table-wrap"><table class="data-table"><thead><tr><th>Produto</th><th>Motivo</th><th>Quantidade</th><th>Prejuízo</th><th>Data</th><th></th></tr></thead><tbody>
      ${state.losses.length ? state.losses.map((loss) => `<tr><td>${escapeHtml(loss.product_name)}</td><td>${escapeHtml(loss.reason)}</td><td>${loss.quantity} un.</td><td>${money(loss.amount)}</td><td>${dateTime(loss.created_at)}</td><td><div class="table-actions"><button class="table-action" data-action="edit-loss" data-id="${loss.id}">Editar</button><button class="table-action delete" data-action="delete-loss" data-id="${loss.id}">Excluir</button></div></td></tr>`).join("") : `<tr><td class="table-empty" colspan="6">Nenhuma perda registrada. Esperamos que continue assim!</td></tr>`}
      </tbody></table></div>
    </section>`;
}

async function renderExpenses() {
  state.expenses = await api("/api/expenses");
  const now = new Date();
  const currentMonth = formatLocalDate(now).slice(0, 7);
  const monthExpenses = state.expenses.filter((item) => item.expense_date.startsWith(currentMonth));
  const total = monthExpenses.reduce((sum, item) => sum + Number(item.amount), 0);
  const grouped = new Map();
  monthExpenses.forEach((item) => grouped.set(item.category, (grouped.get(item.category) || 0) + Number(item.amount)));
  page.innerHTML = `
    ${heading("Gastos do negócio", "Acompanhe para onde vai o dinheiro e mantenha seu caixa organizado.", `<button class="primary-button" data-action="add-expense">＋ Novo gasto</button>`)}
    <div class="stats-grid compact-stats">
      <article class="stat-card"><div class="stat-top"><span>Gastos neste mês</span><span class="stat-icon">↘</span></div><strong class="stat-value">${money(total)}</strong><span class="stat-foot">${monthExpenses.length} despesa(s) registradas</span></article>
      <article class="stat-card"><div class="stat-top"><span>Média por gasto</span><span class="stat-icon">◈</span></div><strong class="stat-value">${money(monthExpenses.length ? total / monthExpenses.length : 0)}</strong><span class="stat-foot">Neste mês</span></article>
      <article class="stat-card"><div class="stat-top"><span>Categorias usadas</span><span class="stat-icon">☷</span></div><strong class="stat-value">${grouped.size}</strong><span class="stat-foot">Tipos de despesas no mês</span></article>
    </div>
    <div class="dashboard-grid">
      <section class="panel"><div class="panel-header"><div><h2>Gastos por categoria</h2><div class="panel-subtitle">Total deste mês</div></div></div><div class="panel-body">${grouped.size ? `<div class="expense-category-list">${[...grouped].sort((a, b) => b[1] - a[1]).map(([category, amount]) => `<div class="expense-category-row"><span>${escapeHtml(category)}<span class="expense-meter"><i style="width:${Math.max(4, amount / Math.max(...grouped.values()) * 100)}%"></i></span></span><strong>${money(amount)}</strong></div>`).join("")}</div>` : emptyState("Sem gastos por enquanto", "Quando registrar despesas, o resumo aparecerá aqui.")}</div></section>
      <section class="panel"><div class="panel-header"><div><h2>Evolução dos gastos</h2><div class="panel-subtitle">Últimos 30 dias</div></div></div><div class="panel-body">${buildLineChart((await api("/api/dashboard?period=30days")).expense_chart || [], "30days", "gastos")}</div></section>
    </div>
    <section class="panel expense-table-panel"><div class="panel-header"><h2>Despesas registradas <span class="badge">${state.expenses.length}</span></h2></div>
      <div class="table-wrap"><table class="data-table"><thead><tr><th>Descrição</th><th>Categoria</th><th>Data</th><th>Valor</th><th></th></tr></thead><tbody>
      ${state.expenses.length ? state.expenses.map((expense) => `<tr><td>${escapeHtml(expense.description)}</td><td>${escapeHtml(expense.category)}</td><td>${new Date(`${expense.expense_date}T12:00:00`).toLocaleDateString("pt-BR")}</td><td>${money(expense.amount)}</td><td><div class="table-actions"><button class="table-action" data-action="edit-expense" data-id="${expense.id}">Editar</button><button class="table-action delete" data-action="delete-expense" data-id="${expense.id}">Excluir</button></div></td></tr>`).join("") : `<tr><td class="table-empty" colspan="5">Nenhuma despesa cadastrada.</td></tr>`}
      </tbody></table></div>
    </section>`;
}

async function renderProfile() {
  state.profile = await api("/api/profile");
  applyProfile(state.profile);
  page.innerHTML = `
    ${heading("Meu negócio", "Mantenha os dados do perfil e as preferências atualizados.")}
    <section class="panel profile-panel"><div class="panel-header"><div><h2>Perfil do negócio</h2><div class="panel-subtitle">Este perfil pertence somente à sua conta.</div></div></div>
      <form class="dialog-body profile-form" id="profile-form">
        <div class="form-grid">
          <div class="field wide"><label for="profile-business">Nome do negócio</label><input id="profile-business" name="business_name" maxlength="120" value="${escapeHtml(state.profile.business_name)}" required></div>
          <div class="field"><label for="profile-owner">Seu nome</label><input id="profile-owner" name="owner_name" maxlength="100" value="${escapeHtml(state.profile.owner_name)}" required></div>
          <div class="field"><label for="profile-role">Cargo ou função</label><input id="profile-role" name="role" maxlength="80" value="${escapeHtml(state.profile.role)}" required></div>
        </div>
        <p class="dialog-error" id="profile-error" role="alert"></p>
        <div class="dialog-footer"><button class="primary-button" type="submit">Salvar perfil</button></div>
      </form>
    </section>
    <section class="panel profile-info"><div class="panel-header"><h2>Seu acesso</h2></div><div class="panel-body"><p><strong>E-mail:</strong> ${escapeHtml(state.user.email)}</p><p><strong>Iniciais do avatar:</strong> ${escapeHtml(state.profile.initials)}</p><p><strong>Plano:</strong> ${state.offline ? "Modo offline" : "Plano gratuito"}</p></div></section>`;
  document.querySelector("#profile-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget));
    try {
      state.profile = await api("/api/profile", { method: "PUT", body: JSON.stringify({ ...form, preferences: state.profile.preferences || {} }) });
      applyProfile(state.profile);
      toast("Perfil atualizado com sucesso.");
      await navigate("profile");
    } catch (error) {
      document.querySelector("#profile-error").textContent = error.message;
    }
  });
}

function setNotificationCount(count) {
  const badge = document.querySelector("#notification-count");
  badge.textContent = count > 99 ? "99+" : count;
  badge.classList.toggle("hidden", count === 0);
}

async function openNotifications() {
  const notificationsDialog = document.querySelector("#notifications-dialog");
  const result = await api("/api/notifications");
  state.notifications = result.items;
  setNotificationCount(result.unread_count);
  notificationsDialog.innerHTML = `
    <div class="dialog-header"><div><h2 id="notifications-title">Notificações</h2><p>Alertas e novidades do seu negócio.</p></div><button class="icon-button" type="button" data-notifications-close aria-label="Fechar">×</button></div>
    <div class="notification-list">${result.items.length ? result.items.map((item) => `<article class="notification-item${item.is_read ? "" : " unread"}"><span class="notification-symbol">${item.kind === "out_of_stock" ? "!" : item.kind === "low_stock" ? "▦" : "✦"}</span><div class="notification-copy"><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.description)}</p><small>${dateTime(item.created_at)} · ${item.is_read ? "Lida" : "Nova"}</small></div></article>`).join("") : emptyState("Tudo tranquilo por aqui", "Novas notificações aparecerão nesta lista.")}</div>
    <div class="notification-footer"><button class="secondary-button" id="mark-notifications-read" ${result.unread_count ? "" : "disabled"}>Marcar como lidas</button></div>`;
  notificationsDialog.querySelector("[data-notifications-close]").addEventListener("click", () => notificationsDialog.close());
  notificationsDialog.querySelector("#mark-notifications-read").addEventListener("click", async () => {
    try {
      await api("/api/notifications/read-all", { method: "POST", body: "{}" });
      await openNotifications();
      toast("Notificações marcadas como lidas.");
    } catch (error) {
      toast(error.message, true);
    }
  });
  if (!notificationsDialog.open) notificationsDialog.showModal();
}

function openForm(title, subtitle, content, submitLabel, onSubmit) {
  dialog.innerHTML = `
    <div class="dialog-header"><div><h2>${title}</h2><p>${subtitle}</p></div><button class="icon-button" type="button" data-dialog-close aria-label="Fechar">×</button></div>
    <form class="dialog-body" id="dialog-form">${content}
      <p class="dialog-error" id="dialog-error" role="alert"></p>
      <div class="dialog-footer"><button class="secondary-button" type="button" data-dialog-close>Cancelar</button><button class="primary-button" type="submit">${submitLabel}</button></div>
    </form>`;
  dialog.querySelectorAll("[data-dialog-close]").forEach((button) => button.addEventListener("click", () => dialog.close()));
  dialog.querySelector("#dialog-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("[type=submit]");
    button.disabled = true;
    const error = dialog.querySelector("#dialog-error");
    error.textContent = "";
    try {
      await onSubmit(new FormData(event.currentTarget));
      dialog.close();
      toast("Prontinho! As informações foram salvas.");
      await navigate(state.view);
    } catch (failure) {
      error.textContent = failure.message;
    } finally {
      button.disabled = false;
    }
  });
  dialog.showModal();
}

function productFields(product = {}) {
  const options = state.categories.map((category) => `<option value="${category.id}"${Number(product.category_id) === category.id ? " selected" : ""}>${escapeHtml(category.name)}</option>`).join("");
  return `<div class="form-grid">
    <div class="field wide"><label for="product-name">Nome do produto</label><input id="product-name" name="name" maxlength="100" value="${escapeHtml(product.name || "")}" placeholder="Ex.: Caderno artesanal" required></div>
    <div class="field"><label for="product-icon">Ícone do produto</label><select id="product-icon" name="icon">${[["▦", "Caixa"], ["✿", "Flor"], ["☕", "Alimento"], ["♧", "Natural"], ["◈", "Acessório"], ["✎", "Papelaria"]].map(([icon, label]) => `<option value="${icon}"${(product.icon || "▦") === icon ? " selected" : ""}>${icon} ${label}</option>`).join("")}</select></div>
    <div class="field"><label for="product-category">Categoria</label><select id="product-category" name="category_id"><option value="">Sem categoria</option>${options}</select></div>
    <div class="field"><label for="product-quantity">Quantidade em estoque</label><input id="product-quantity" name="quantity" type="number" min="0" step="1" value="${product.quantity ?? 0}" required></div>
    <div class="field"><label for="product-cost">Preço de custo (R$)</label><input id="product-cost" name="cost_price" type="number" min="0" step="0.01" value="${product.cost_price ?? 0}" required></div>
    <div class="field"><label for="product-price">Preço de venda (R$)</label><input id="product-price" name="sale_price" type="number" min="0" step="0.01" value="${product.sale_price ?? 0}" required></div>
    <div class="field"><label for="product-min">Avisar quando chegar a</label><input id="product-min" name="min_stock" type="number" min="0" step="1" value="${product.min_stock ?? 5}" required></div>
  </div>`;
}

function openProductForm(product = null) {
  const editing = Boolean(product);
  openForm(editing ? "Editar produto" : "Novo produto", "Os campos com asterisco ajudam a manter seu estoque em dia.", productFields(product || {}), "Salvar produto", async (form) => {
    const values = Object.fromEntries(form);
    values.quantity = Number(values.quantity);
    values.cost_price = Number(values.cost_price);
    values.sale_price = Number(values.sale_price);
    values.min_stock = Number(values.min_stock);
    values.category_id = values.category_id || null;
    await api(editing ? `/api/products/${product.id}` : "/api/products", { method: editing ? "PUT" : "POST", body: JSON.stringify(values) });
  });
}

function openCategoryForm(category = null) {
  const editing = Boolean(category);
  openForm(editing ? "Editar categoria" : "Nova categoria", "Uma boa categoria deixa tudo mais fácil de encontrar.", `
    <div class="field"><label for="category-name">Nome da categoria</label><input id="category-name" name="name" maxlength="50" value="${escapeHtml(category?.name || "")}" placeholder="Ex.: Papelaria" required></div>`,
  "Salvar categoria", async (form) => {
    const body = JSON.stringify({ name: form.get("name") });
    await api(editing ? `/api/categories/${category.id}` : "/api/categories", { method: editing ? "PUT" : "POST", body });
  });
}

function openSupplierForm(supplier = null) {
  const editing = Boolean(supplier);
  const fields = [
    ["company_name", "Empresa", "Ex.: Atacado Central", 120, true],
    ["category", "Categoria", "Ex.: Alimentos", 60, false],
    ["contact_name", "Pessoa de contato", "Nome do contato", 100, false],
    ["phone", "Telefone", "(00) 00000-0000", 20, false],
    ["email", "E-mail", "contato@empresa.com", 100, false],
  ];
  openForm(editing ? "Editar fornecedor" : "Novo fornecedor", "Guarde os contatos de quem ajuda seu negócio a crescer.", `
    <div class="form-grid">${fields.map(([name, label, placeholder, max, required]) => `<div class="field${name === "company_name" || name === "email" ? " wide" : ""}"><label for="supplier-${name}">${label}</label><input id="supplier-${name}" name="${name}" maxlength="${max}" value="${escapeHtml(supplier?.[name] || "")}" placeholder="${placeholder}" ${required ? "required" : ""}></div>`).join("")}
    <div class="field wide"><label for="supplier-notes">Observações</label><textarea id="supplier-notes" name="notes" maxlength="2000" placeholder="Prazo de entrega, condições...">${escapeHtml(supplier?.notes || "")}</textarea></div></div>`,
  "Salvar fornecedor", async (form) => {
    const body = JSON.stringify(Object.fromEntries(form));
    await api(editing ? `/api/suppliers/${supplier.id}` : "/api/suppliers", { method: editing ? "PUT" : "POST", body });
  });
}

function saleLine(products) {
  const productOptions = products.map((product) => `<option value="${product.id}" data-price="${Number(product.sale_price)}" data-stock="${product.quantity}">${escapeHtml(product.name)} — ${product.quantity} un. · ${money(product.sale_price)}</option>`).join("");
  return `<div class="sale-line"><div class="field"><label>Produto</label><select class="sale-product" required><option value="">Escolha um produto</option>${productOptions}</select></div><div class="field"><label>Unidades</label><input class="sale-quantity" type="number" min="1" step="1" value="1" required></div><button class="sale-line-remove" type="button" aria-label="Remover item">×</button></div>`;
}

function openSaleForm() {
  const available = state.products.filter((product) => product.quantity > 0);
  if (!available.length) {
    toast("Cadastre produtos com estoque para registrar uma venda.", true);
    return;
  }
  const paymentMethods = ["PIX", "Dinheiro", "Cartão de débito", "Cartão de crédito", "Transferência"];
  openForm("Registrar venda", "Ao salvar, o estoque dos produtos será atualizado.", `
    <div id="sale-lines">${saleLine(available)}</div>
    <button class="secondary-button" id="add-sale-line" type="button">＋ Adicionar produto</button>
    <div class="field"><label for="sale-payment">Forma de pagamento</label><select id="sale-payment" name="payment_method">${paymentMethods.map((method) => `<option>${method}</option>`).join("")}</select></div>
    <div class="sale-total"><span>Total da venda</span><strong id="sale-total">R$ 0,00</strong></div>`,
  "Confirmar venda", async (form) => {
    const items = [...dialog.querySelectorAll(".sale-line")].map((line) => ({
      product_id: Number(line.querySelector(".sale-product").value),
      quantity: Number(line.querySelector(".sale-quantity").value),
    }));
    await api("/api/sales", { method: "POST", body: JSON.stringify({ items, payment_method: form.get("payment_method") }) });
  });
  const lines = dialog.querySelector("#sale-lines");
  const updateTotal = () => {
    const total = [...lines.querySelectorAll(".sale-line")].reduce((sum, line) => {
      const select = line.querySelector(".sale-product");
      const selected = select.selectedOptions[0];
      const quantity = Number(line.querySelector(".sale-quantity").value || 0);
      return sum + Number(selected?.dataset.price || 0) * quantity;
    }, 0);
    dialog.querySelector("#sale-total").textContent = money(total);
  };
  lines.addEventListener("change", (event) => {
    if (event.target.matches(".sale-product")) {
      const option = event.target.selectedOptions[0];
      const quantity = event.target.closest(".sale-line").querySelector(".sale-quantity");
      quantity.max = option?.dataset.stock || "";
      if (Number(quantity.value) > Number(quantity.max)) quantity.value = quantity.max || 1;
    }
    updateTotal();
  });
  lines.addEventListener("input", updateTotal);
  lines.addEventListener("click", (event) => {
    if (event.target.matches(".sale-line-remove")) {
      if (lines.querySelectorAll(".sale-line").length > 1) event.target.closest(".sale-line").remove();
      else {
        lines.querySelector(".sale-product").value = "";
        lines.querySelector(".sale-quantity").value = "1";
      }
      updateTotal();
    }
  });
  dialog.querySelector("#add-sale-line").addEventListener("click", () => {
    lines.insertAdjacentHTML("beforeend", saleLine(available));
  });
}

function saleFormFields(sale = {}) {
  const date = String(sale.created_at || formatLocalDate(new Date())).slice(0, 10);
  return `<div class="form-grid">
    <div class="field wide"><label for="manual-sale-description">Descrição</label><input id="manual-sale-description" name="description" maxlength="160" value="${escapeHtml(sale.description || "")}" placeholder="Ex.: Venda no balcão" required></div>
    <div class="field"><label for="manual-sale-amount">Valor (R$)</label><input id="manual-sale-amount" name="amount" type="number" min="0" step="0.01" value="${sale.total ?? ""}" required></div>
    <div class="field"><label for="manual-sale-date">Data da venda</label><input id="manual-sale-date" name="sale_date" type="date" value="${date}" required></div>
    <div class="field wide"><label for="manual-sale-payment">Forma de pagamento</label><select id="manual-sale-payment" name="payment_method">${["PIX", "Dinheiro", "Cartão de débito", "Cartão de crédito", "Transferência"].map((method) => `<option${sale.payment_method === method ? " selected" : ""}>${method}</option>`).join("")}</select></div>
  </div>`;
}

function openManualSaleForm(sale = null) {
  const editing = Boolean(sale);
  openForm(editing ? "Editar venda" : "Nova venda", "Os valores ficam vinculados somente ao seu negócio.", saleFormFields(sale || {}), "Salvar venda", async (form) => {
    const values = Object.fromEntries(form);
    values.amount = Number(values.amount);
    await api(editing ? `/api/sales/${sale.id}` : "/api/sales", {
      method: editing ? "PUT" : "POST",
      body: JSON.stringify(values),
    });
  });
}

function openLossForm(loss = null) {
  const editing = Boolean(loss);
  const options = state.products.map((product) => `<option value="${product.id}"${Number(loss?.product_id) === product.id ? " selected" : ""}>${escapeHtml(product.name)} (${product.quantity} un.)</option>`).join("");
  openForm(editing ? "Editar perda" : "Registrar perda", "O estoque será atualizado junto com o registro.", `
    <div class="form-grid">
      <div class="field wide"><label for="loss-product">Produto</label><select id="loss-product" name="product_id" required><option value="">Selecione um produto</option>${options}</select></div>
      <div class="field"><label for="loss-quantity">Quantidade</label><input id="loss-quantity" name="quantity" type="number" min="1" step="1" value="${loss?.quantity || 1}" required></div>
      <div class="field"><label for="loss-amount">Prejuízo (R$)</label><input id="loss-amount" name="amount" type="number" min="0" step="0.01" value="${loss?.amount ?? ""}" required></div>
      <div class="field wide"><label for="loss-reason">Motivo</label><select id="loss-reason" name="reason" required>${["Avaria", "Vencido", "Furto", "Erro de armazenamento"].map((reason) => `<option${loss?.reason === reason ? " selected" : ""}>${reason}</option>`).join("")}</select></div>
    </div>`,
  "Salvar perda", async (form) => {
    const values = Object.fromEntries(form);
    values.product_id = Number(values.product_id);
    values.quantity = Number(values.quantity);
    values.amount = Number(values.amount);
    await api(editing ? `/api/losses/${loss.id}` : "/api/losses", {
      method: editing ? "PUT" : "POST",
      body: JSON.stringify(values),
    });
  });
}

function openExpenseForm(expense = null) {
  const editing = Boolean(expense);
  const categories = ["Mercadorias", "Mercado", "Aluguel", "Contas", "Operação", "Outros"];
  openForm(editing ? "Editar gasto" : "Novo gasto", "Registre a despesa para manter seu caixa organizado.", `
    <div class="form-grid">
      <div class="field wide"><label for="expense-description">Descrição</label><input id="expense-description" name="description" maxlength="160" value="${escapeHtml(expense?.description || "")}" placeholder="Ex.: Conta de energia" required></div>
      <div class="field"><label for="expense-category">Categoria</label><select id="expense-category" name="category">${categories.map((category) => `<option${expense?.category === category ? " selected" : ""}>${category}</option>`).join("")}</select></div>
      <div class="field"><label for="expense-amount">Valor (R$)</label><input id="expense-amount" name="amount" type="number" min="0" step="0.01" value="${expense?.amount ?? ""}" required></div>
      <div class="field wide"><label for="expense-date">Data</label><input id="expense-date" name="expense_date" type="date" value="${expense?.expense_date || formatLocalDate(new Date())}" required></div>
    </div>`,
  "Salvar gasto", async (form) => {
    const values = Object.fromEntries(form);
    values.amount = Number(values.amount);
    await api(editing ? `/api/expenses/${expense.id}` : "/api/expenses", {
      method: editing ? "PUT" : "POST",
      body: JSON.stringify(values),
    });
  });
}

async function removeRecord(resource, id, label, view) {
  if (!window.confirm(`Deseja mesmo excluir ${label}?`)) return;
  try {
    await api(`/api/${resource}/${id}`, { method: "DELETE" });
    toast("Cadastro excluído.");
    await navigate(view);
  } catch (error) {
    toast(error.message, true);
  }
}

page.addEventListener("click", (event) => {
  const navButton = event.target.closest("[data-nav]");
  if (navButton) {
    navigate(navButton.dataset.nav);
    return;
  }
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const id = Number(button.dataset.id);
  switch (button.dataset.action) {
    case "add-product": openProductForm(); break;
    case "edit-product": { const item = state.products.find((record) => record.id === id); if (item) openProductForm(item); break; }
    case "delete-product": { const item = state.products.find((record) => record.id === id); if (item) removeRecord("products", item.id, `o produto "${item.name}"`, "products"); break; }
    case "add-category": openCategoryForm(); break;
    case "edit-category": { const item = state.categories.find((record) => record.id === id); if (item) openCategoryForm(item); break; }
    case "delete-category": { const item = state.categories.find((record) => record.id === id); if (item) removeRecord("categories", item.id, `a categoria "${item.name}"`, "categories"); break; }
    case "add-supplier": openSupplierForm(); break;
    case "edit-supplier": { const item = state.suppliers.find((record) => record.id === id); if (item) openSupplierForm(item); break; }
    case "delete-supplier": { const item = state.suppliers.find((record) => record.id === id); if (item) removeRecord("suppliers", item.id, `o fornecedor "${item.company_name}"`, "suppliers"); break; }
    case "add-sale": openSaleForm(); break;
    case "add-manual-sale": openManualSaleForm(); break;
    case "edit-sale": { const item = state.sales.find((record) => record.id === id); if (item) openManualSaleForm(item); break; }
    case "delete-sale": { const item = state.sales.find((record) => record.id === id); if (item) removeRecord("sales", item.id, `a venda "${item.description || `#${item.id}`}"`, "sales"); break; }
    case "add-expense": openExpenseForm(); break;
    case "edit-expense": { const item = state.expenses.find((record) => record.id === id); if (item) openExpenseForm(item); break; }
    case "delete-expense": { const item = state.expenses.find((record) => record.id === id); if (item) removeRecord("expenses", item.id, `o gasto "${item.description}"`, "expenses"); break; }
    case "add-loss": openLossForm(); break;
    case "edit-loss": { const item = state.losses.find((record) => record.id === id); if (item) openLossForm(item); break; }
    case "delete-loss": { const item = state.losses.find((record) => record.id === id); if (item) removeRecord("losses", item.id, `a perda de "${item.product_name}"`, "losses"); break; }
  }
});

document.querySelectorAll("[data-nav]").forEach((button) => {
  button.addEventListener("click", () => {
    if (button.closest(".sidebar")) navigate(button.dataset.nav);
  });
});

document.querySelector("#mobile-menu").addEventListener("click", () => {
  document.querySelector(".sidebar").classList.toggle("open");
});

async function logout() {
  try {
    if (!state.offline) await api("/api/logout", { method: "POST", body: "{}" });
    appShell.classList.add("hidden");
    authScreen.classList.remove("hidden");
    state.user = null;
    state.profile = null;
    state.offline = false;
    updateConnectivity();
    renderAuth("login");
  } catch (error) {
    toast(error.message, true);
  }
}

document.querySelector("#logout-button").addEventListener("click", logout);
document.querySelector("#sidebar-logout").addEventListener("click", logout);
document.querySelector("#notifications-button").addEventListener("click", () => {
  openNotifications().catch((error) => toast(error.message, true));
});
window.addEventListener("online", () => {
  state.offline = false;
  updateConnectivity();
  synchronizeOfflineChanges().catch((error) => toast(error.message, true));
});
window.addEventListener("offline", () => {
  updateConnectivity();
  if (state.user) {
    state.offline = true;
    toast("Sem conexão. O app está usando os dados salvos neste dispositivo.");
    navigate(state.view);
  }
});

dialog.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
});

async function start() {
  const resetToken = new URLSearchParams(window.location.search).get("reset");
  renderAuth(resetToken ? "reset" : "login");
  if ("serviceWorker" in navigator) {
    let refreshing = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });
    navigator.serviceWorker.register("/service-worker.js").catch((error) => console.error("Não foi possível ativar o modo instalável:", error));
  }
  try {
    const session = await api("/api/session");
    if (session.authenticated) {
      enterApp(session.user);
      warmOfflineCache().catch((error) => console.error("Não foi possível preparar todos os dados offline:", error));
    }
  } catch (error) {
    console.error("Não foi possível verificar a sessão:", error);
    const savedUser = cachedValues("last-user", null, "guest");
    if (savedUser && cachedValues(`cache:/api/dashboard?period=${state.chartPeriod}`, null, savedUser.id)) {
      enterApp(savedUser, true);
    }
  }
}

async function warmOfflineCache() {
  await Promise.all([
    "/api/profile", "/api/products", "/api/categories", "/api/suppliers",
    "/api/sales", "/api/losses", "/api/expenses", "/api/notifications",
  ].map(async (path) => {
    try {
      const data = await api(path);
      storeValues(`cache:${path}`, data);
    } catch (error) {
      console.error(`Não foi possível preparar ${path} para uso offline:`, error);
    }
  }));
}

start();
