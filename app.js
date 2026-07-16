const PAGE_SIZE = 50;
const WORKSPACE_KEY = "financeLeaseIntelligenceWorkspaceV2";
const AMOUNT_BANDS = ["5000万元以下", "5000万元至1亿元", "1亿元至3亿元", "3亿元至5亿元", "5亿元至10亿元", "10亿元以上", "未披露"];
const TERM_BANDS = ["1年以内", "1年至2年", "2年至3年", "3年至5年", "5年以上", "未披露"];
const OPPORTUNITY_LABELS = ["高价值业务线索", "建议重点跟进", "一般业务信息", "已落地同业项目", "谨慎关注项目", "高风险监测事项"];
const WORK_STATUSES = ["未读", "已读", "重点关注", "待联系", "已联系", "已拜访", "已立项", "暂不跟进", "排除"];
const MARKET_OPTIONS = ["沪市主板", "深市主板", "创业板", "科创板", "北交所", "港股主板", "其他上市市场", "发债主体"];
const NATURE_OPTIONS = ["中央国企", "地方国企", "民营企业", "公众企业", "外资企业", "其他", "待补充"];
const RELATION_OPTIONS = ["上市公司本体", "全资子公司", "控股子公司", "参股公司", "上市公司担保主体", "集团其他关联方", "待识别"];
const BUSINESS_TYPE_OPTIONS = ["直接租赁", "售后回租", "经营租赁", "联合租赁", "转租赁", "厂商租赁", "融资租赁授信", "融资租赁担保", "融资租赁增资", "融资租赁业务合作", "其他"];
const STAGE_OPTIONS = ["拟议中", "已审议", "已签约", "已投放", "存续中", "展期中", "已终止", "公告未明确"];
const LESSOR_TYPE_OPTIONS = ["金融租赁公司", "商租公司", "央企租赁公司", "地方国企租赁公司", "银行系租赁公司", "产业系租赁公司", "外资租赁公司", "其他", "未披露"];
const ASSET_OPTIONS = ["生产设备", "能源设备", "交通运输工具", "工程机械", "医疗设备", "船舶", "飞机", "数据中心设备", "不动产", "其他资产", "未披露"];
const GUARANTEE_OPTIONS = ["上市公司担保", "集团担保", "子公司担保", "关联方担保", "资产抵押", "股权质押", "应收账款质押", "保证金", "信用", "其他", "未披露"];
const SAMPLE_RECORDS = [{
  id: "sample:1", subject_name: "示例上市公司", subject_type: "A股上市公司", stock_code: "600000",
  region: "待补充", industry: "待补充", announcement_date: "2026-07-01", title: "融资租赁示例公告",
  source: "样例", source_url: "#", matched_keywords: ["融资租赁"], matched_position: "标题", amount: "未披露",
  term: "未披露", counterparty: "未披露", leased_asset: "未披露", related_party: "未披露",
  guarantee_or_collateral: "未披露", risk_labels: [], review_status: "待复核", snippets: [], attention_level: "C"
}];

let allRecords = [];
let matchingRecords = [];
let filteredRecords = [];
let selectedId = "";
let currentPage = 1;
let currentView = "today";
let dataMode = "unknown";
let manifest = null;
let statusPayload = null;
let liveSyncTimer = null;
let lastServerRevision = "";
let filterRunId = 0;
let inputTimer = null;
const recordStore = new Map();
const profileStore = new Map();
const loadedYears = new Set();
const projectGroups = new Map();
let subjectFrequency = new Map();
let workspace = loadWorkspace();

const els = Object.fromEntries([
  "globalSearch", "datePreset", "marketFilter", "natureFilter", "relationFilter", "region", "industry",
  "businessTypeFilter", "stageFilter", "amountBandFilter", "termBandFilter", "counterpartyFilter",
  "lessorTypeFilter", "startDate", "endDate", "yearFilter", "assetFilter", "guaranteeFilter",
  "opportunityFilter", "source", "reviewStatus", "onlyHigh", "onlyUnverified", "mergeProjects",
  "resetFilters", "toggleFilters", "savedFilterList", "savedFilterName", "saveFilter", "sortBy", "compactMode",
  "standardMode", "exportCsv", "recordsBody", "prevPage", "nextPage", "pageInfo", "visibleCount",
  "resultCount", "leadList", "companyBody", "lessorBody", "workspaceBody", "reminderList",
  "sourceStatusBody", "datasetStatus", "refreshStatus", "lastSuccessAt", "dataAsOf", "syncState",
  "healthBanner", "healthTitle", "healthDetail", "updatedAt", "detailContent", "detailLevel"
].map((id) => [id, document.getElementById(id)]));

init();

async function init() {
  bindEvents();
  if (window.matchMedia("(max-width: 780px)").matches) toggleMobileFilters();
  await loadProfiles();
  await loadInitialRecords();
  statusPayload = await loadServerStatus();
  reindexRecords();
  populateFilters();
  renderSavedFilters();
  await applyFilters();
  restoreSelectionFromLocation();
  startLiveSync(statusPayload?.page_poll_interval_seconds || 60);
}

async function loadProfiles() {
  try {
    const response = await fetch(cacheBustUrl("./data/profiles.json"), { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    profileStore.clear();
    (payload.profiles || []).forEach((profile) => {
      if (profile.stock_code) profileStore.set(String(profile.stock_code), profile);
    });
  } catch (error) {
    profileStore.clear();
  }
}

function bindEvents() {
  document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
  document.querySelectorAll("[data-jump-view]").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.jumpView)));

  const filterIds = [
    "datePreset", "marketFilter", "natureFilter", "relationFilter", "region", "industry", "businessTypeFilter",
    "stageFilter", "amountBandFilter", "termBandFilter", "counterpartyFilter", "lessorTypeFilter", "startDate",
    "endDate", "yearFilter", "assetFilter", "guaranteeFilter", "opportunityFilter", "source", "reviewStatus",
    "onlyHigh", "onlyUnverified", "mergeProjects"
  ];
  filterIds.forEach((id) => els[id].addEventListener(["startDate", "endDate"].includes(id) ? "input" : "change", () => void applyFilters()));
  els.globalSearch.addEventListener("input", () => {
    clearTimeout(inputTimer);
    inputTimer = setTimeout(() => void applyFilters(), 180);
  });
  els.datePreset.addEventListener("change", () => {
    if (els.datePreset.value !== "custom") {
      els.startDate.value = "";
      els.endDate.value = "";
    }
  });
  els.resetFilters.addEventListener("click", resetFilters);
  els.toggleFilters.addEventListener("click", toggleMobileFilters);
  els.sortBy.addEventListener("change", () => { currentPage = 1; sortFilteredRecords(); renderSearchTable(); });
  els.prevPage.addEventListener("click", () => changePage(-1));
  els.nextPage.addEventListener("click", () => changePage(1));
  els.compactMode.addEventListener("click", () => setDensity("compact"));
  els.standardMode.addEventListener("click", () => setDensity("standard"));
  els.exportCsv.addEventListener("click", exportCsv);
  els.saveFilter.addEventListener("click", saveCurrentFilter);
  els.savedFilterList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-filter-index]");
    if (button) applySavedFilter(Number(button.dataset.filterIndex));
  });
  els.recordsBody.addEventListener("click", handleRecordClick);
  els.leadList.addEventListener("click", handleRecordClick);
  els.companyBody.addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-company]");
    if (row) selectCompany(row.dataset.company);
  });
  els.lessorBody.addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-lessor]");
    if (row) selectLessor(row.dataset.lessor);
  });
  els.workspaceBody.addEventListener("click", handleRecordClick);
  els.detailContent.addEventListener("click", handleDetailAction);
  window.addEventListener("hashchange", restoreSelectionFromLocation);
}

function toggleMobileFilters() {
  const sidebar = document.querySelector(".filter-sidebar");
  const collapsed = sidebar.classList.toggle("mobile-collapsed");
  els.toggleFilters.textContent = collapsed ? "展开条件" : "收起条件";
  els.toggleFilters.setAttribute("aria-expanded", String(!collapsed));
}

async function loadInitialRecords() {
  try {
    const response = await fetch("/api/records", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload.records)) throw new Error("记录格式无效");
    dataMode = "api";
    mergeRecords(payload.records);
    els.datasetStatus.textContent = `${Number(payload.count || recordStore.size).toLocaleString("zh-CN")} 条`;
    return;
  } catch (error) {
    // GitHub Pages and static hosting use the manifest and data shards below.
  }

  try {
    const manifestResponse = await fetch(cacheBustUrl("./data/manifest.json"), { cache: "no-store" });
    if (!manifestResponse.ok) throw new Error(`HTTP ${manifestResponse.status}`);
    manifest = await manifestResponse.json();
    const recentResponse = await fetch(cacheBustUrl(`./data/${manifest.recent.file}`), { cache: "no-store" });
    if (!recentResponse.ok) throw new Error(`HTTP ${recentResponse.status}`);
    const recentPayload = await recentResponse.json();
    if (!Array.isArray(recentPayload.records)) throw new Error("近90天数据格式无效");
    dataMode = "static";
    mergeRecords(recentPayload.records);
    els.datasetStatus.textContent = `${Number(manifest.total_count || recordStore.size).toLocaleString("zh-CN")} 条`;
    return;
  } catch (error) {
    try {
      const response = await fetch(cacheBustUrl("./data/records.json"), { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (!Array.isArray(payload.records)) throw new Error("记录格式无效");
      dataMode = "static-full";
      mergeRecords(payload.records);
      els.datasetStatus.textContent = `${Number(payload.count || recordStore.size).toLocaleString("zh-CN")} 条`;
      return;
    } catch (fallbackError) {
      dataMode = "sample";
      mergeRecords(SAMPLE_RECORDS);
      els.datasetStatus.textContent = "样例数据";
      setOfflineHealth("数据未连接", "当前仅显示样例数据。");
    }
  }
}

function mergeRecords(records) {
  records.forEach((item, index) => {
    const record = normalizeRecord(item, index);
    recordStore.set(record.id, record);
  });
  allRecords = [...recordStore.values()].sort(sortByDateDesc);
}

async function loadYearShard(year) {
  if (dataMode !== "static" || !year || loadedYears.has(year)) return;
  const descriptor = manifest?.years?.find((item) => item.year === year);
  if (!descriptor) return;
  const response = await fetch(cacheBustUrl(`./data/${descriptor.file}`), { cache: "no-store" });
  if (!response.ok) throw new Error(`加载 ${year} 年数据失败`);
  const payload = await response.json();
  mergeRecords(payload.records || []);
  loadedYears.add(year);
}

async function ensureDataScope() {
  if (dataMode !== "static" || !manifest?.years?.length) return;
  const years = manifest.years.map((item) => item.year);
  let needed = [];
  if (els.yearFilter.value) {
    needed = [els.yearFilter.value];
  } else if (els.datePreset.value === "all") {
    needed = years;
  } else if (els.datePreset.value === "ytd") {
    needed = [todayText().slice(0, 4)];
  } else if (els.datePreset.value === "custom") {
    needed = yearsBetween(els.startDate.value, els.endDate.value || todayText());
  } else if (Number(els.datePreset.value) > 90) {
    const end = todayText();
    const start = addDays(end, -Number(els.datePreset.value) + 1);
    needed = yearsBetween(start, end);
  }
  const missing = needed.filter((year) => !loadedYears.has(year));
  if (!missing.length) return;
  els.datasetStatus.textContent = `加载 ${missing.join("、")} 年`;
  await Promise.all(missing.map(loadYearShard));
  reindexRecords();
  populateFilters();
  els.datasetStatus.textContent = `${Number(manifest.total_count || allRecords.length).toLocaleString("zh-CN")} 条`;
}

async function ensureAllHistory() {
  if (dataMode !== "static" || !manifest?.years?.length) return;
  const missing = manifest.years.map((item) => item.year).filter((year) => !loadedYears.has(year));
  if (!missing.length) return;
  els.datasetStatus.textContent = "加载历史数据";
  await Promise.all(missing.map(loadYearShard));
  reindexRecords();
  populateFilters();
  els.datasetStatus.textContent = `${Number(manifest.total_count || allRecords.length).toLocaleString("zh-CN")} 条`;
}

async function loadServerStatus() {
  if (!location.origin.startsWith("http")) return null;
  if (dataMode === "api") {
    try {
      const response = await fetch("/api/status", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      updateServerHealth(payload);
      lastServerRevision = serverRevision(payload);
      return payload;
    } catch (error) {
      // Static status remains available when the API is not present.
    }
  }
  try {
    const response = await fetch(cacheBustUrl("./data/status.json"), { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    updateServerHealth(payload);
    lastServerRevision = serverRevision(payload);
    return payload;
  } catch (error) {
    setOfflineHealth("数据状态不可达", "页面继续显示最近一次成功载入的数据。");
    return null;
  }
}

function updateServerHealth(payload) {
  const auto = payload.auto_refresh || {};
  const state = payload.freshness_state || (payload.latest_run?.status === "failed" ? "red" : Number(payload.days_since_check || 0) > 1 ? "yellow" : "green");
  const uiState = state === "green" ? "ok" : state === "yellow" ? "warning" : "error";
  const success = payload.latest_successful_run || {};
  els.syncState.dataset.state = uiState;
  els.healthBanner.dataset.state = uiState;
  els.dataAsOf.textContent = payload.latest_announcement_date || payload.data_as_of || "--";
  els.datasetStatus.textContent = `${Number(payload.record_count || allRecords.length).toLocaleString("zh-CN")} 条`;
  els.lastSuccessAt.textContent = success.finished_at ? formatDateTime(success.finished_at) : "--";
  if (uiState === "ok") {
    els.refreshStatus.textContent = `每${auto.interval_minutes || 60}分钟云端更新`;
    els.healthTitle.textContent = "数据正常";
  } else if (uiState === "warning") {
    els.refreshStatus.textContent = "数据更新延迟";
    els.healthTitle.textContent = "超过24小时未成功更新";
  } else {
    els.refreshStatus.textContent = "数据更新异常";
    els.healthTitle.textContent = payload.latest_run?.status === "failed" ? "最近一次采集失败" : "超过48小时未更新";
  }
  const connected = Object.keys(payload.source_counts || {}).length;
  els.healthDetail.textContent = `最近成功 ${success.finished_at ? formatDateTime(success.finished_at) : "--"}；已自动接入 ${connected} 个数据源。`;
  setText("metricLastSuccess", success.finished_at ? formatShortDateTime(success.finished_at) : "--");
  renderStatus();
}

function setOfflineHealth(title, detail) {
  els.syncState.dataset.state = "error";
  els.healthBanner.dataset.state = "error";
  els.refreshStatus.textContent = title;
  els.lastSuccessAt.textContent = "--";
  els.healthTitle.textContent = title;
  els.healthDetail.textContent = detail;
}

function serverRevision(payload) {
  const run = payload.latest_successful_run || {};
  return payload.revision || `${payload.record_count || 0}|${run.id || 0}|${run.finished_at || payload.generated_at || ""}`;
}

function startLiveSync(intervalSeconds) {
  clearInterval(liveSyncTimer);
  if (!location.origin.startsWith("http")) return;
  liveSyncTimer = setInterval(syncFromServer, Math.max(30, intervalSeconds) * 1000);
}

async function syncFromServer() {
  const previous = lastServerRevision;
  const next = await loadServerStatus();
  if (!next || !previous || serverRevision(next) === previous) return;
  recordStore.clear();
  loadedYears.clear();
  await loadProfiles();
  await loadInitialRecords();
  reindexRecords();
  populateFilters();
  await applyFilters();
}

function reindexRecords() {
  allRecords = [...recordStore.values()].sort(sortByDateDesc);
  const oneYearAgo = addDays(todayText(), -364);
  subjectFrequency = new Map();
  allRecords.forEach((item) => {
    if (item.announcement_date >= oneYearAgo) subjectFrequency.set(item.subject_name, (subjectFrequency.get(item.subject_name) || 0) + 1);
  });
  buildProjectGroups();
  allRecords.forEach((item) => {
    item.recent_frequency = subjectFrequency.get(item.subject_name) || 0;
    const scores = calculateScores(item);
    Object.assign(item, scores);
    item.opportunity_label = opportunityLabel(item);
    item.one_liner = buildOneLiner(item);
    recordStore.set(item.id, item);
  });
}

function buildProjectGroups() {
  projectGroups.clear();
  const candidates = new Map();
  allRecords.forEach((item) => {
    const key = projectBaseKey(item);
    if (!candidates.has(key)) candidates.set(key, []);
    candidates.get(key).push(item);
  });
  candidates.forEach((items, base) => {
    const sorted = items.sort((a, b) => a.announcement_date.localeCompare(b.announcement_date));
    let cluster = 1;
    let previousDate = "";
    sorted.forEach((item) => {
      if (previousDate && dateDiff(previousDate, item.announcement_date) > 540) cluster += 1;
      const id = `${base}:${cluster}`;
      item.project_id = id;
      if (!projectGroups.has(id)) projectGroups.set(id, []);
      projectGroups.get(id).push(item);
      previousDate = item.announcement_date;
    });
  });
  projectGroups.forEach((items) => items.sort(sortByDateDesc));
}

function projectBaseKey(item) {
  if (!item.amount_numeric || !isDisclosed(item.counterparty)) return item.id;
  return [item.subject_name, item.actual_lessee, item.amount_numeric, normalizeName(item.counterparty), item.asset_category].join("|");
}

function populateFilters() {
  const years = manifest?.years?.map((item) => item.year) || unique(allRecords.map((item) => item.announcement_date.slice(0, 4))).reverse();
  fillSelect(els.yearFilter, years);
  fillSelect(els.marketFilter, unique([...MARKET_OPTIONS, ...allRecords.map((item) => item.market)]));
  fillSelect(els.natureFilter, unique([...NATURE_OPTIONS, ...allRecords.map((item) => item.enterprise_nature)]));
  fillSelect(els.relationFilter, unique([...RELATION_OPTIONS, ...allRecords.map((item) => item.lessee_relation)]));
  fillSelect(els.region, unique(allRecords.map((item) => item.region)));
  fillSelect(els.industry, unique(allRecords.map((item) => item.industry)));
  fillSelect(els.businessTypeFilter, unique([...BUSINESS_TYPE_OPTIONS, ...allRecords.flatMap((item) => item.business_types)]));
  fillSelect(els.stageFilter, unique([...STAGE_OPTIONS, ...allRecords.map((item) => item.business_stage)]));
  fillSelect(els.amountBandFilter, AMOUNT_BANDS);
  fillSelect(els.termBandFilter, TERM_BANDS);
  fillSelect(els.counterpartyFilter, unique(allRecords.map((item) => item.counterparty).filter(isDisclosed)));
  fillSelect(els.lessorTypeFilter, unique([...LESSOR_TYPE_OPTIONS, ...allRecords.map((item) => item.lessor_type)]));
  fillSelect(els.assetFilter, unique([...ASSET_OPTIONS, ...allRecords.map((item) => item.asset_category)]));
  fillSelect(els.guaranteeFilter, unique([...GUARANTEE_OPTIONS, ...allRecords.flatMap((item) => item.guarantee_methods)]));
  fillSelect(els.opportunityFilter, OPPORTUNITY_LABELS);
  fillSelect(els.source, unique(allRecords.map((item) => item.source)));
  fillSelect(els.reviewStatus, unique(allRecords.map((item) => item.review_status)));
}

function fillSelect(select, values) {
  const current = select.value;
  const first = select.querySelector("option")?.outerHTML || '<option value="">全部</option>';
  select.innerHTML = first;
  values.filter(Boolean).forEach((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  });
  select.value = values.includes(current) ? current : "";
}

async function applyFilters() {
  const runId = ++filterRunId;
  try {
    await ensureDataScope();
  } catch (error) {
    els.healthBanner.dataset.state = "warning";
    els.healthTitle.textContent = "部分历史数据未加载";
    els.healthDetail.textContent = error.message;
  }
  if (runId !== filterRunId) return;
  const query = els.globalSearch.value.trim().toLowerCase();
  const range = resolveDateRange();
  matchingRecords = allRecords.filter((item) => {
    if (query && !item.search_blob.includes(query)) return false;
    if (range.start && item.announcement_date < range.start) return false;
    if (range.end && item.announcement_date > range.end) return false;
    if (els.yearFilter.value && item.announcement_date.slice(0, 4) !== els.yearFilter.value) return false;
    if (els.marketFilter.value && item.market !== els.marketFilter.value) return false;
    if (els.natureFilter.value && item.enterprise_nature !== els.natureFilter.value) return false;
    if (els.relationFilter.value && item.lessee_relation !== els.relationFilter.value) return false;
    if (els.region.value && item.region !== els.region.value) return false;
    if (els.industry.value && item.industry !== els.industry.value) return false;
    if (els.businessTypeFilter.value && !item.business_types.includes(els.businessTypeFilter.value)) return false;
    if (els.stageFilter.value && item.business_stage !== els.stageFilter.value) return false;
    if (els.amountBandFilter.value && item.amount_band !== els.amountBandFilter.value) return false;
    if (els.termBandFilter.value && item.term_band !== els.termBandFilter.value) return false;
    if (els.counterpartyFilter.value && item.counterparty !== els.counterpartyFilter.value) return false;
    if (els.lessorTypeFilter.value && item.lessor_type !== els.lessorTypeFilter.value) return false;
    if (els.assetFilter.value && item.asset_category !== els.assetFilter.value) return false;
    if (els.guaranteeFilter.value && !item.guarantee_methods.includes(els.guaranteeFilter.value)) return false;
    if (els.opportunityFilter.value && item.opportunity_label !== els.opportunityFilter.value) return false;
    if (els.source.value && item.source !== els.source.value) return false;
    if (els.reviewStatus.value && item.review_status !== els.reviewStatus.value) return false;
    if (els.onlyHigh.checked && item.opportunity_score < 75) return false;
    if (els.onlyUnverified.checked && !isPending(item)) return false;
    return true;
  });
  filteredRecords = els.mergeProjects.checked ? collapseProjects(matchingRecords) : [...matchingRecords];
  currentPage = 1;
  sortFilteredRecords();
  renderAll();
}

function collapseProjects(records) {
  const groups = new Map();
  records.forEach((item) => {
    const current = groups.get(item.project_id);
    if (!current || item.announcement_date > current.announcement_date) groups.set(item.project_id, item);
  });
  return [...groups.values()];
}

function resolveDateRange() {
  const today = todayText();
  if (els.datePreset.value === "all") return { start: "", end: "" };
  if (els.datePreset.value === "custom") return { start: els.startDate.value, end: els.endDate.value };
  if (els.datePreset.value === "today") return { start: today, end: today };
  if (els.datePreset.value === "ytd") return { start: `${today.slice(0, 4)}-01-01`, end: today };
  return { start: addDays(today, -Number(els.datePreset.value) + 1), end: today };
}

function sortFilteredRecords() {
  const mode = els.sortBy.value;
  filteredRecords.sort((a, b) => {
    if (mode === "date") return sortByDateDesc(a, b);
    if (mode === "amount") return b.amount_numeric - a.amount_numeric || sortByDateDesc(a, b);
    if (mode === "level") return b.opportunity_score - a.opportunity_score || sortByDateDesc(a, b);
    if (mode === "frequency") return b.recent_frequency - a.recent_frequency || sortByDateDesc(a, b);
    if (mode === "completeness") return b.completeness_score - a.completeness_score || sortByDateDesc(a, b);
    if (mode === "marketCap") return b.market_cap - a.market_cap || sortByDateDesc(a, b);
    return b.opportunity_score - a.opportunity_score || sortByDateDesc(a, b);
  });
}

function renderAll() {
  renderMetrics();
  renderToday();
  renderSearchTable();
  renderCompanies();
  renderLessors();
  renderAnalytics();
  renderWorkspace();
  renderStatus();
  els.updatedAt.textContent = `页面同步 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
}

function renderMetrics() {
  const today = todayText();
  const weekStart = addDays(today, -6);
  const weekRecords = allRecords.filter((item) => item.announcement_date >= weekStart && item.announcement_date <= today);
  const weekProjects = collapseProjects(weekRecords);
  setText("metricToday", allRecords.filter((item) => item.announcement_date === today).length);
  setText("metricWeek", weekProjects.length);
  setText("metricCompanies", new Set(weekRecords.map((item) => item.subject_name)).size);
  setText("metricSubsidiaries", new Set(weekRecords.filter((item) => item.lessee_relation !== "上市公司本部").map((item) => item.actual_lessee)).size);
  setText("metricHigh", weekProjects.filter((item) => item.opportunity_score >= 75).length);
  setText("metricPending", weekProjects.filter(isPending).length);
}

function renderToday() {
  const leads = [...filteredRecords].sort((a, b) => b.opportunity_score - a.opportunity_score || sortByDateDesc(a, b)).slice(0, 12);
  els.leadList.innerHTML = leads.length ? leads.map((item) => `
    <article class="lead-item ${item.id === selectedId ? "active" : ""}" data-id="${escapeAttribute(item.id)}">
      <div class="lead-score"><strong>${item.opportunity_score}</strong><span>机会分</span></div>
      <div class="lead-company"><strong>${escapeHtml(item.subject_name)}</strong><span class="stock-code">${escapeHtml(item.stock_code || item.bond_code || "--")}</span><small>${escapeHtml(item.market)}</small></div>
      <div class="lead-summary"><strong>${escapeHtml(item.business_stage)} · ${escapeHtml(item.business_type)}</strong><p>${escapeHtml(item.one_liner)}</p></div>
      <div class="lead-amount">${escapeHtml(item.amount_original)}<small>${escapeHtml(item.counterparty)}</small></div>
      <span class="score-badge ${opportunityClass(item)}">${escapeHtml(shortOpportunityLabel(item.opportunity_label))}</span>
    </article>`).join("") : '<div class="empty-state">当前筛选范围内没有线索</div>';
}

function renderSearchTable() {
  const totalPages = Math.max(1, Math.ceil(filteredRecords.length / PAGE_SIZE));
  currentPage = Math.min(currentPage, totalPages);
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageRecords = filteredRecords.slice(start, start + PAGE_SIZE);
  els.recordsBody.innerHTML = pageRecords.map((item) => {
    const work = workspace.records[item.id] || {};
    const projectCount = projectGroups.get(item.project_id)?.length || 1;
    return `<tr class="clickable ${item.id === selectedId ? "active" : ""}" data-id="${escapeAttribute(item.id)}">
      <td><time>${escapeHtml(item.announcement_date)}</time>${projectCount > 1 ? `<span class="subline">项目时间线 ${projectCount}条</span>` : ""}</td>
      <td><strong class="company-name">${escapeHtml(item.subject_name)}</strong><span class="stock-code">${escapeHtml(item.stock_code || item.bond_code || "--")}</span><span class="subline">${escapeHtml(item.region)} · ${escapeHtml(shorten(item.industry, 12))}</span></td>
      <td><span class="tag blue">${escapeHtml(item.market)}</span><span class="subline">${escapeHtml(item.enterprise_nature)}</span></td>
      <td><span class="entity-badge ${item.lessee_relation === "上市公司本部" ? "" : "subsidiary"}">${escapeHtml(item.lessee_relation)}</span><span class="subline truncate" title="${escapeAttribute(item.actual_lessee)}">${escapeHtml(item.actual_lessee)}</span></td>
      <td><strong>${escapeHtml(item.business_type)}</strong><span class="subline">${escapeHtml(item.amount_type)}</span></td>
      <td><span class="tag ${isDevelopmentStage(item.business_stage) ? "green" : "blue"}">${escapeHtml(item.business_stage)}</span></td>
      <td><span class="amount-value">${escapeHtml(item.amount_original)}</span><span class="subline">${escapeHtml(item.amount_band)}</span></td>
      <td>${escapeHtml(item.term_original)}<span class="subline">${escapeHtml(item.term_band)}</span></td>
      <td><span class="lessor-name truncate" title="${escapeAttribute(item.counterparty)}">${escapeHtml(item.counterparty)}</span><span class="subline">${escapeHtml(item.lessor_type)}</span></td>
      <td><span class="truncate">${escapeHtml(item.asset_category)}</span><span class="subline truncate">${escapeHtml(item.guarantee_method)}</span></td>
      <td><span class="score-number">${item.opportunity_score}</span><span class="score-badge ${opportunityClass(item)}">${escapeHtml(shortOpportunityLabel(item.opportunity_label))}</span></td>
      <td><span class="state-label ${workStateClass(work.status)}">${escapeHtml(work.status || (isPending(item) ? "待复核" : "未读"))}</span>${work.favorite ? '<span class="subline">已收藏</span>' : ""}</td>
    </tr>`;
  }).join("");
  els.resultCount.textContent = `${filteredRecords.length.toLocaleString("zh-CN")} 个项目，${matchingRecords.length.toLocaleString("zh-CN")} 条公告`;
  els.visibleCount.textContent = pageRecords.length ? `显示 ${start + 1}-${start + pageRecords.length} / ${filteredRecords.length}` : "显示 0 条";
  els.pageInfo.textContent = `${currentPage} / ${totalPages}`;
  els.prevPage.disabled = currentPage <= 1;
  els.nextPage.disabled = currentPage >= totalPages;
}

function renderCompanies() {
  const source = companyRadarRecords();
  const groups = new Map();
  source.forEach((item) => {
    if (!groups.has(item.subject_name)) groups.set(item.subject_name, []);
    groups.get(item.subject_name).push(item);
  });
  const rows = [...groups.entries()].map(([name, records]) => companyAggregate(name, records)).sort((a, b) => b.recent_count - a.recent_count || b.total_amount - a.total_amount).slice(0, 300);
  els.companyBody.innerHTML = rows.length ? rows.map((item) => `<tr class="clickable" data-company="${escapeAttribute(item.name)}"><td><strong class="company-name">${escapeHtml(item.name)}</strong><span class="stock-code">${escapeHtml(item.stock_code)}</span></td><td>${escapeHtml(item.market)}</td><td>${escapeHtml(item.nature)}</td><td>${escapeHtml(item.region)}<span class="subline">${escapeHtml(shorten(item.industry, 18))}</span></td><td>${formatMarketCap(item.market_cap, "")}</td><td>${item.count}</td><td>${item.recent_count}</td><td class="amount-value">${formatAmount(item.total_amount)}</td><td>${item.lessors}</td><td>${escapeHtml(item.latest_date)}</td></tr>`).join("") : '<tr><td colspan="10" class="empty-state">暂无数据</td></tr>';
}

function renderLessors() {
  const groups = new Map();
  companyRadarRecords().filter((item) => isDisclosed(item.counterparty)).forEach((item) => {
    if (!groups.has(item.counterparty)) groups.set(item.counterparty, []);
    groups.get(item.counterparty).push(item);
  });
  const rows = [...groups.entries()].map(([name, records]) => lessorAggregate(name, records)).sort((a, b) => b.recent_count - a.recent_count || b.total_amount - a.total_amount).slice(0, 300);
  els.lessorBody.innerHTML = rows.length ? rows.map((item) => `<tr class="clickable" data-lessor="${escapeAttribute(item.name)}"><td><strong class="lessor-name">${escapeHtml(item.name)}</strong></td><td>${escapeHtml(item.type)}</td><td>${item.company_count}</td><td>${item.recent_count}</td><td class="amount-value">${formatAmount(item.total_amount)}</td><td>${formatAmount(item.average_amount)}</td><td>${escapeHtml(item.top_industry)}</td><td>${escapeHtml(item.common_term)}</td><td>${escapeHtml(item.latest_date)}</td></tr>`).join("") : '<tr><td colspan="9" class="empty-state">当前数据未披露出租人</td></tr>';
}

function renderAnalytics() {
  renderTrend();
  renderRank("regionChart", countBy(filteredRecords, "region"), 10);
  renderRank("industryChart", countBy(filteredRecords, "industry"), 10);
  renderRank("stageChart", countBy(filteredRecords, "business_stage"), 10);
  renderRank("counterpartyChart", countBy(filteredRecords.filter((item) => isDisclosed(item.counterparty)), "counterparty"), 10);
  const opportunities = countBy(filteredRecords, "opportunity_label");
  setHtml("opportunityChart", Object.entries(opportunities).sort((a, b) => b[1] - a[1]).map(([label, count]) => `<span class="tag ${opportunityTagClass(label)}">${escapeHtml(label)} ${count}</span>`).join(""));
}

function renderTrend() {
  const counts = {};
  const useMonth = !resolveDateRange().start || dateDiff(resolveDateRange().start, resolveDateRange().end || todayText()) > 120;
  filteredRecords.forEach((item) => {
    const key = useMonth ? item.announcement_date.slice(0, 7) : item.announcement_date;
    counts[key] = (counts[key] || 0) + 1;
  });
  const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)).slice(-24);
  const max = Math.max(1, ...entries.map(([, count]) => count));
  setHtml("trendChart", entries.length ? entries.map(([key, count]) => `<div class="bar" title="${escapeAttribute(key)}: ${count}"><div style="height:${Math.max(4, Math.round((count / max) * 180))}px"></div><span>${escapeHtml(useMonth ? key.slice(2) : key.slice(5))}</span></div>`).join("") : '<p class="muted">暂无数据</p>');
}

function renderRank(id, counts, limit) {
  const entries = Object.entries(counts).filter(([key]) => isDisclosed(key)).sort((a, b) => b[1] - a[1]).slice(0, limit);
  const max = Math.max(1, ...entries.map(([, count]) => count));
  setHtml(id, entries.length ? entries.map(([key, count]) => `<div class="rank-row"><span title="${escapeAttribute(key)}">${escapeHtml(key)}</span><div class="track"><span style="width:${Math.round(count / max * 100)}%"></span></div><strong>${count}</strong></div>`).join("") : '<p class="muted">暂无数据</p>');
}

function renderWorkspace() {
  const entries = Object.entries(workspace.records).filter(([id, state]) => recordStore.has(id) && (state.favorite || state.status || state.note || state.owner || state.next_follow_up));
  setText("workFavoriteCount", entries.filter(([, state]) => state.favorite).length);
  setText("workContactCount", entries.filter(([, state]) => state.status === "待联系").length);
  setText("workFollowCount", entries.filter(([, state]) => ["已联系", "已拜访", "重点关注"].includes(state.status)).length);
  setText("workProjectCount", entries.filter(([, state]) => state.status === "已立项").length);
  els.workspaceBody.innerHTML = entries.length ? entries.map(([id, state]) => {
    const item = recordStore.get(id);
    return `<tr class="clickable" data-id="${escapeAttribute(id)}"><td><strong>${escapeHtml(item.subject_name)}</strong><span class="subline">${escapeHtml(item.stock_code)}</span></td><td><span class="truncate">${escapeHtml(item.title)}</span><span class="subline">${escapeHtml(item.announcement_date)}</span></td><td>${item.opportunity_score}<span class="subline">${escapeHtml(shortOpportunityLabel(item.opportunity_label))}</span></td><td>${escapeHtml(state.status || "已读")}</td><td>${escapeHtml(state.owner || "--")}</td><td>${escapeHtml(state.next_follow_up || "--")}</td><td><span class="truncate">${escapeHtml(state.note || "--")}</span></td></tr>`;
  }).join("") : '<tr><td colspan="7" class="empty-state">暂无收藏或跟进事项</td></tr>';
  renderReminders(entries);
}

function renderReminders(workEntries) {
  const reminders = [];
  const today = todayText();
  workEntries.forEach(([id, state]) => {
    if (state.next_follow_up && state.next_follow_up <= addDays(today, 7) && state.next_follow_up >= today) {
      reminders.push({ level: "warning", text: `${recordStore.get(id).subject_name} 将于 ${state.next_follow_up} 跟进`, id });
    }
  });
  const weekStart = addDays(today, -6);
  allRecords.filter((item) => item.announcement_date >= weekStart && item.opportunity_score >= 80).slice(0, 5).forEach((item) => reminders.push({ level: "success", text: `${item.subject_name}：${item.one_liner}`, id: item.id }));
  workspace.watchlist.forEach((company) => {
    const latest = allRecords.find((item) => item.subject_name === company && item.announcement_date >= weekStart);
    if (latest) reminders.push({ level: "info", text: `重点公司 ${company} 有新公告`, id: latest.id });
  });
  els.reminderList.innerHTML = reminders.slice(0, 10).map((item) => `<button type="button" class="reminder-item" data-id="${escapeAttribute(item.id)}"><span class="state-dot ${item.level === "success" ? "green" : item.level === "warning" ? "yellow" : "gray"}"></span><span>${escapeHtml(item.text)}</span><span>查看</span></button>`).join("") || '<div class="empty-state">暂无待处理提醒</div>';
  els.reminderList.querySelectorAll("[data-id]").forEach((button) => button.addEventListener("click", () => selectRecord(button.dataset.id, true)));
}

function renderStatus() {
  if (!statusPayload) return;
  const latest = statusPayload.latest_run || {};
  const success = statusPayload.latest_successful_run || {};
  setText("statusLastRun", latest.finished_at ? formatDateTime(latest.finished_at) : "--");
  setText("statusLastSuccess", success.finished_at ? formatDateTime(success.finished_at) : "--");
  setText("statusLatestDate", statusPayload.latest_announcement_date || "--");
  setText("statusFailures", statusPayload.consecutive_failures || 0);
  const statuses = statusPayload.source_statuses || buildFallbackSourceStatuses(statusPayload);
  els.sourceStatusBody.innerHTML = statuses.map((item) => `<tr><td><strong>${escapeHtml(item.source)}</strong></td><td>${escapeHtml(sourceModeText(item.mode))}</td><td><span class="state-label ${sourceStateClass(item.state)}">${escapeHtml(sourceStateText(item))}</span></td><td>${Number(item.record_count || 0).toLocaleString("zh-CN")}</td><td>${escapeHtml(formatDateTime(item.last_checked_at || "--"))}</td><td>${escapeHtml(formatDateTime(item.last_success_at || "--"))}</td><td>${escapeHtml(item.latest_announcement_date || "--")}</td></tr>`).join("");
}

function switchView(view) {
  currentView = view;
  document.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  document.querySelectorAll("[data-page]").forEach((panel) => panel.classList.toggle("active", panel.dataset.page === view));
  if (["companies", "lessors", "workspace"].includes(view)) {
    void ensureAllHistory().then(() => { renderCompanies(); renderLessors(); renderWorkspace(); });
  }
  document.querySelector(".main-stage")?.scrollTo({ top: 0, behavior: "smooth" });
}

function changePage(delta) {
  const totalPages = Math.max(1, Math.ceil(filteredRecords.length / PAGE_SIZE));
  currentPage = Math.max(1, Math.min(totalPages, currentPage + delta));
  renderSearchTable();
  document.querySelector(".main-stage")?.scrollTo({ top: 0, behavior: "smooth" });
}

function setDensity(value) {
  document.querySelector(".app-shell").dataset.density = value;
  els.compactMode.classList.toggle("active", value === "compact");
  els.standardMode.classList.toggle("active", value === "standard");
}

function handleRecordClick(event) {
  if (event.target.closest("a[target='_blank']")) return;
  const target = event.target.closest("[data-id]");
  if (target) selectRecord(target.dataset.id, true);
}

function selectRecord(id, updateUrl = false) {
  const item = recordStore.get(id);
  if (!item) return;
  selectedId = id;
  const work = workspace.records[id] || {};
  if (!work.status) {
    workspace.records[id] = { ...work, status: "已读" };
    persistWorkspace();
  }
  renderRecordDetail(item);
  renderToday();
  renderSearchTable();
  if (updateUrl) history.replaceState(null, "", eventHref(id));
  if (window.matchMedia("(max-width: 1220px)").matches) document.getElementById("eventDetail").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderRecordDetail(item) {
  const project = projectGroups.get(item.project_id) || [item];
  const companyHistory = allRecords.filter((record) => record.subject_name === item.subject_name);
  const lesseeHistory = allRecords.filter((record) => record.actual_lessee === item.actual_lessee);
  const lessors = unique(companyHistory.map((record) => record.counterparty).filter(isDisclosed));
  const work = workspace.records[item.id] || {};
  els.detailLevel.textContent = `${item.opportunity_score}分`;
  els.detailLevel.className = `score-badge ${opportunityClass(item)}`;
  els.detailContent.className = "detail-body";
  els.detailContent.innerHTML = `
    <div class="detail-title-block"><span>${escapeHtml(item.announcement_date)} · ${escapeHtml(item.source)}</span><h3>${escapeHtml(item.subject_name)}</h3><p>${escapeHtml(item.title)}</p><div class="detail-actions">${item.source_url && item.source_url !== "#" ? `<a class="primary-link" href="${escapeAttribute(item.source_url)}" target="_blank" rel="noreferrer">公告原文</a>` : ""}${item.pdf_url && item.pdf_url !== item.source_url ? `<a href="${escapeAttribute(item.pdf_url)}" target="_blank" rel="noreferrer">PDF</a>` : ""}${item.exchange_verification_url ? `<a href="${escapeAttribute(item.exchange_verification_url)}" target="_blank" rel="noreferrer">交易所复核</a>` : ""}${item.company_website ? `<a href="${escapeAttribute(item.company_website)}" target="_blank" rel="noreferrer">公司官网</a>` : ""}<button type="button" data-detail-action="watch-company">${workspace.watchlist.includes(item.subject_name) ? "取消重点公司" : "加入重点公司"}</button><button type="button" data-detail-action="toggle-favorite">${work.favorite ? "取消收藏" : "收藏"}</button></div></div>
    <section class="detail-section"><h3>机会与风险评估</h3><div class="score-grid"><div><span>业务机会</span><strong>${item.opportunity_score}</strong></div><div><span>风险关注</span><strong>${item.risk_score}</strong></div><div><span>信息完整度</span><strong>${item.completeness_score}%</strong></div></div><p><span class="score-badge ${opportunityClass(item)}">${escapeHtml(item.opportunity_label)}</span></p><p>${escapeHtml(item.one_liner)}</p><p class="muted">${escapeHtml(riskAdvice(item))}</p></section>
    <section class="detail-section"><h3>上市公司属性</h3><dl class="field-grid"><div><dt>股票代码</dt><dd>${escapeHtml(item.stock_code || "待补充")}</dd></div><div><dt>上市市场</dt><dd>${escapeHtml(item.market)}</dd></div><div><dt>企业性质</dt><dd>${escapeHtml(item.enterprise_nature)}</dd></div><div><dt>性质依据</dt><dd>${escapeHtml(item.enterprise_nature_basis || "待补充")}</dd></div><div><dt>实际控制人</dt><dd>${escapeHtml(item.actual_controller)}</dd></div><div><dt>注册地</dt><dd>${escapeHtml(item.region)}</dd></div><div><dt>证监会行业</dt><dd>${escapeHtml(item.industry)}</dd></div><div><dt>总市值</dt><dd>${formatMarketCap(item.market_cap, item.market_cap_date)}</dd></div><div><dt>市值来源</dt><dd>${escapeHtml(item.market_cap_source || "待补充")}</dd></div><div><dt>画像来源</dt><dd>${escapeHtml(item.profile_source || "待补充")}</dd></div></dl></section>
    <section class="detail-section"><h3>融资租赁要素</h3><dl class="field-grid"><div><dt>实际承租人</dt><dd>${escapeHtml(item.actual_lessee)}</dd></div><div><dt>与上市公司关系</dt><dd>${escapeHtml(item.lessee_relation)}</dd></div><div><dt>出租人</dt><dd>${escapeHtml(item.counterparty)}</dd></div><div><dt>出租人类型</dt><dd>${escapeHtml(item.lessor_type)}</dd></div><div><dt>融资金额</dt><dd>${escapeHtml(item.amount_original)}</dd></div><div><dt>金额口径</dt><dd>${escapeHtml(item.amount_type)}</dd></div><div><dt>融资期限</dt><dd>${escapeHtml(item.term_original)}</dd></div><div><dt>利率/综合成本</dt><dd>${escapeHtml(item.financing_cost)}</dd></div><div><dt>租赁物</dt><dd>${escapeHtml(item.leased_asset)}</dd></div><div><dt>标准分类</dt><dd>${escapeHtml(item.asset_category)}</dd></div><div><dt>资金用途</dt><dd>${escapeHtml(item.capital_use)}</dd></div><div><dt>担保/增信</dt><dd>${escapeHtml(item.guarantee_method)}</dd></div><div><dt>决策程序</dt><dd>${escapeHtml(item.decision_process)}</dd></div><div><dt>是否关联交易</dt><dd>${escapeHtml(item.related_party)}</dd></div><div><dt>业务类型</dt><dd>${escapeHtml(item.business_types.join("、"))}</dd></div><div><dt>业务阶段</dt><dd>${escapeHtml(item.business_stage)}</dd></div></dl></section>
    <section class="detail-section"><h3>公告证据</h3>${unique(item.snippets).slice(0, 4).map((snippet) => `<blockquote>${highlightKeywords(snippet, item.matched_keywords)}</blockquote>`).join("") || '<p class="muted">当前仅有公告元数据，正文待补充。</p>'}</section>
    <section class="detail-section"><h3>同一项目时间线</h3><div class="timeline">${project.map((record) => `<div class="timeline-item"><strong>${escapeHtml(record.announcement_date)} · ${escapeHtml(record.business_stage)}</strong><span>${escapeHtml(record.title)}</span></div>`).join("")}</div></section>
    <section class="detail-section"><h3>历史合作</h3><p>${escapeHtml(item.subject_name)}：${companyHistory.length} 条历史记录；${escapeHtml(item.actual_lessee)}：${lesseeHistory.length} 条记录。</p><p class="muted">已披露合作出租人：${escapeHtml(lessors.join("、") || "未披露")}</p></section>
    <section class="detail-section"><h3>个人跟进</h3><div class="work-form"><label>工作状态<select id="detailWorkStatus">${WORK_STATUSES.map((status) => `<option value="${status}" ${status === (work.status || "已读") ? "selected" : ""}>${status}</option>`).join("")}</select></label><label>负责人<input id="detailOwner" value="${escapeAttribute(work.owner || "")}" /></label><label>下次跟进<input id="detailFollowUp" type="date" value="${escapeAttribute(work.next_follow_up || "")}" /></label><label>个人备注<textarea id="detailNote">${escapeHtml(work.note || "")}</textarea></label><button type="button" class="primary-btn" data-detail-action="save-work">保存跟进信息</button></div></section>`;
}

function selectCompany(name) {
  const records = allRecords.filter((item) => item.subject_name === name);
  if (!records.length) return;
  const summary = companyAggregate(name, records);
  const subsidiaries = unique(records.filter((item) => item.lessee_relation !== "上市公司本部").map((item) => item.actual_lessee));
  const lessors = unique(records.map((item) => item.counterparty).filter(isDisclosed));
  const assets = topKeys(countBy(records, "asset_category"), 5);
  const guarantees = topArrayValues(records, "guarantee_methods", 5);
  els.detailLevel.textContent = `${records.length}次`;
  els.detailLevel.className = "score-badge neutral";
  els.detailContent.className = "detail-body";
  els.detailContent.innerHTML = `<div class="detail-title-block"><span>上市公司集团页</span><h3>${escapeHtml(name)}</h3><p>${escapeHtml(summary.stock_code)} · ${escapeHtml(summary.market)} · ${escapeHtml(summary.nature)}</p><div class="detail-actions">${summary.company_website ? `<a class="primary-link" href="${escapeAttribute(summary.company_website)}" target="_blank" rel="noreferrer">公司官网</a>` : ""}<button type="button" data-detail-action="watch-company" data-company="${escapeAttribute(name)}">${workspace.watchlist.includes(name) ? "取消重点公司" : "加入重点公司"}</button></div></div><section class="detail-section"><h3>公司画像</h3><dl class="field-grid"><div><dt>企业性质</dt><dd>${escapeHtml(summary.nature)}</dd></div><div><dt>性质依据</dt><dd>${escapeHtml(summary.enterprise_nature_basis || "待补充")}</dd></div><div><dt>实际控制人</dt><dd>${escapeHtml(summary.actual_controller)}</dd></div><div><dt>地区</dt><dd>${escapeHtml(summary.region)}</dd></div><div><dt>行业</dt><dd>${escapeHtml(summary.industry)}</dd></div><div><dt>总市值</dt><dd>${formatMarketCap(summary.market_cap, summary.market_cap_date)}</dd></div><div><dt>市值来源</dt><dd>${escapeHtml(summary.market_cap_source || "待补充")}</dd></div><div><dt>历史租赁次数</dt><dd>${records.length}</dd></div><div><dt>历史披露金额</dt><dd>${formatAmount(summary.total_amount)}</dd></div><div><dt>近一年次数</dt><dd>${summary.recent_count}</dd></div><div><dt>最近租赁</dt><dd>${escapeHtml(summary.latest_date)}</dd></div><div><dt>未完成计划</dt><dd>${records.filter((item) => isDevelopmentStage(item.business_stage)).length}</dd></div><div><dt>画像来源</dt><dd>${escapeHtml(summary.profile_source || "待补充")}</dd></div></dl></section><section class="detail-section"><h3>下属承租主体</h3><p>${escapeHtml(subsidiaries.join("、") || "尚未识别子公司承租主体")}</p></section><section class="detail-section"><h3>历史偏好</h3><p>合作出租人：${escapeHtml(lessors.join("、") || "未披露")}</p><p>租赁物：${escapeHtml(assets.join("、") || "未披露")}</p><p>担保结构：${escapeHtml(guarantees.join("、") || "未披露")}</p></section><section class="detail-section"><h3>最近记录</h3><div class="timeline">${records.slice(0, 12).map((item) => `<div class="timeline-item"><strong>${escapeHtml(item.announcement_date)} · ${escapeHtml(item.business_stage)}</strong><span>${escapeHtml(item.title)}</span></div>`).join("")}</div></section>`;
}

function selectLessor(name) {
  const records = allRecords.filter((item) => item.counterparty === name);
  if (!records.length) return;
  const summary = lessorAggregate(name, records);
  const regions = topKeys(countBy(records, "region"), 5);
  const assets = topKeys(countBy(records, "asset_category"), 5);
  const guarantees = topArrayValues(records, "guarantee_methods", 5);
  els.detailLevel.textContent = `${summary.recent_count}个近一年项目`;
  els.detailLevel.className = "score-badge neutral";
  els.detailContent.className = "detail-body";
  els.detailContent.innerHTML = `<div class="detail-title-block"><span>出租人页</span><h3>${escapeHtml(name)}</h3><p>${escapeHtml(summary.type)}</p></div><section class="detail-section"><h3>业务概览</h3><dl class="field-grid"><div><dt>合作上市公司</dt><dd>${summary.company_count}</dd></div><div><dt>历史项目</dt><dd>${records.length}</dd></div><div><dt>累计披露金额</dt><dd>${formatAmount(summary.total_amount)}</dd></div><div><dt>平均单笔</dt><dd>${formatAmount(summary.average_amount)}</dd></div><div><dt>近一年项目</dt><dd>${summary.recent_count}</dd></div><div><dt>常见期限</dt><dd>${escapeHtml(summary.common_term)}</dd></div><div><dt>主要行业</dt><dd>${escapeHtml(summary.top_industry)}</dd></div><div><dt>最近新增</dt><dd>${escapeHtml(summary.latest_date)}</dd></div></dl></section><section class="detail-section"><h3>业务方向</h3><p>主要地区：${escapeHtml(regions.join("、") || "未披露")}</p><p>租赁物：${escapeHtml(assets.join("、") || "未披露")}</p><p>担保方式：${escapeHtml(guarantees.join("、") || "未披露")}</p></section><section class="detail-section"><h3>最近项目</h3><div class="timeline">${records.slice(0, 15).map((item) => `<div class="timeline-item"><strong>${escapeHtml(item.announcement_date)} · ${escapeHtml(item.subject_name)}</strong><span>${escapeHtml(item.title)}</span></div>`).join("")}</div></section>`;
}

function handleDetailAction(event) {
  const action = event.target.closest("[data-detail-action]")?.dataset.detailAction;
  if (!action) return;
  const item = recordStore.get(selectedId);
  if (action === "watch-company") {
    const company = event.target.dataset.company || item?.subject_name;
    if (!company) return;
    workspace.watchlist = workspace.watchlist.includes(company) ? workspace.watchlist.filter((name) => name !== company) : [...workspace.watchlist, company];
    persistWorkspace();
    if (item) renderRecordDetail(item); else selectCompany(company);
  }
  if (!item) return;
  if (action === "toggle-favorite") {
    const work = workspace.records[item.id] || {};
    workspace.records[item.id] = { ...work, favorite: !work.favorite, status: work.status || "已读" };
    persistWorkspace();
    renderRecordDetail(item);
    renderWorkspace();
    renderSearchTable();
  }
  if (action === "save-work") {
    workspace.records[item.id] = {
      ...(workspace.records[item.id] || {}),
      status: document.getElementById("detailWorkStatus").value,
      owner: document.getElementById("detailOwner").value.trim(),
      next_follow_up: document.getElementById("detailFollowUp").value,
      note: document.getElementById("detailNote").value.trim()
    };
    persistWorkspace();
    renderWorkspace();
    renderSearchTable();
    renderRecordDetail(item);
  }
}

function saveCurrentFilter() {
  const name = els.savedFilterName.value.trim();
  if (!name) return;
  workspace.filters.push({ name, values: currentFilterValues() });
  workspace.filters = workspace.filters.slice(-12);
  els.savedFilterName.value = "";
  persistWorkspace();
  renderSavedFilters();
}

function renderSavedFilters() {
  els.savedFilterList.innerHTML = workspace.filters.map((filter, index) => `<button type="button" class="saved-filter-chip" data-filter-index="${index}">${escapeHtml(filter.name)}</button>`).join("");
}

function currentFilterValues() {
  return Object.fromEntries(["datePreset", "marketFilter", "natureFilter", "relationFilter", "region", "industry", "businessTypeFilter", "stageFilter", "amountBandFilter", "termBandFilter", "counterpartyFilter", "lessorTypeFilter", "assetFilter", "guaranteeFilter", "opportunityFilter", "source", "reviewStatus"].map((id) => [id, els[id].value]));
}

function applySavedFilter(index) {
  const filter = workspace.filters[index];
  if (!filter) return;
  Object.entries(filter.values).forEach(([id, value]) => { if (els[id]) els[id].value = value; });
  void applyFilters();
}

function resetFilters() {
  els.globalSearch.value = "";
  els.datePreset.value = "7";
  ["marketFilter", "natureFilter", "relationFilter", "region", "industry", "businessTypeFilter", "stageFilter", "amountBandFilter", "termBandFilter", "counterpartyFilter", "lessorTypeFilter", "startDate", "endDate", "yearFilter", "assetFilter", "guaranteeFilter", "opportunityFilter", "source", "reviewStatus"].forEach((id) => { els[id].value = ""; });
  els.onlyHigh.checked = false;
  els.onlyUnverified.checked = false;
  els.mergeProjects.checked = true;
  void applyFilters();
}

function exportCsv() {
  const headers = ["公告日期", "股票代码", "上市公司", "上市市场", "企业性质", "实际承租人", "承租关系", "地区", "行业", "业务类型", "业务阶段", "融资金额原文", "标准金额(元)", "金额口径", "期限原文", "标准期限(月)", "出租人", "出租人类型", "租赁物", "担保方式", "业务机会分", "风险分", "完整度", "机会分类", "复核状态", "公告标题", "公告链接"];
  const rows = filteredRecords.map((item) => [item.announcement_date, item.stock_code, item.subject_name, item.market, item.enterprise_nature, item.actual_lessee, item.lessee_relation, item.region, item.industry, item.business_types.join("、"), item.business_stage, item.amount_original, item.amount_numeric, item.amount_type, item.term_original, item.term_months || "", item.counterparty, item.lessor_type, item.leased_asset, item.guarantee_methods.join("、"), item.opportunity_score, item.risk_score, item.completeness_score, item.opportunity_label, item.review_status, item.title, item.source_url]);
  const csv = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
  const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `上市公司融资租赁情报_${todayText()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function normalizeRecord(item, index) {
  const stockCode = String(item.stock_code || item["证券代码"] || "");
  const profile = profileStore.get(stockCode) || {};
  const baseText = [item.title, item.summary, ...arrayValue(item.snippets)].filter(Boolean).join(" ");
  const amountOriginal = item.amount || item["金额"] || "未披露";
  const termOriginal = item.term || item["期限"] || "未披露";
  const rawCounterparty = item.counterparty || item["交易对手"] || "未披露";
  const record = {
    id: item.id || `import:${index}`,
    subject_name: item.subject_name || item.stock_name || item.company_name || item["主体名称"] || "未命名主体",
    subject_type: item.subject_type || item["主体类型"] || "待识别",
    stock_code: stockCode,
    bond_code: item.bond_code || item["债券代码"] || "",
    region: disclosedOr(item.region || item["地区"], profile.province, "待补充"),
    industry: disclosedOr(item.industry || item["行业"], profile.csrc_industry, "待补充"),
    announcement_date: item.announcement_date || item.publish_date || item["公告日期"] || "",
    title: item.title || item["公告标题"] || "",
    source: item.source || item["公告来源"] || "",
    source_url: item.source_url || item.original_url || item["公告链接"] || "#",
    pdf_url: item.pdf_url || item["PDF链接"] || "",
    matched_keywords: arrayValue(item.matched_keywords || item["命中关键词"]),
    matched_position: item.matched_position || item.matched_fields || item["命中位置"] || "",
    announcement_type: item.announcement_type || item["公告类型"] || "",
    lease_role: item.lease_role || item["融资租赁角色"] || "未披露",
    amount_original: amountOriginal,
    amount: amountOriginal,
    term_original: termOriginal,
    term: termOriginal,
    counterparty: cleanCounterparty(rawCounterparty),
    leased_asset: item.leased_asset || item["租赁物"] || "未披露",
    related_party: item.related_party || item["是否关联交易"] || "未披露",
    guarantee_or_collateral: item.guarantee_or_collateral || item["担保抵押"] || item["担保/抵押"] || "未披露",
    summary: item.summary || item["摘要"] || "",
    risk_labels: arrayValue(item.risk_labels || item["风险标签"]),
    review_status: item.review_status || item["复核状态"] || "待复核",
    snippets: arrayValue(item.snippets || item.matched_snippets || item["命中片段"]),
    attention_level: item.attention_level || "C",
    notes: item.notes || item["备注"] || "",
    enterprise_nature: disclosedOr(item.enterprise_nature || item.company_nature || item["企业性质"], profile.enterprise_nature, "待补充"),
    enterprise_nature_basis: item.enterprise_nature_basis || profile.enterprise_nature_basis || "",
    actual_controller: disclosedOr(item.actual_controller || item["实际控制人"], profile.actual_controller, "待补充"),
    market_cap: parseNumber(item.market_cap || item["市值"] || profile.market_cap),
    market_cap_date: item.market_cap_date || profile.market_cap_date || "",
    market_cap_source: item.market_cap_source || profile.market_cap_source || "",
    company_website: item.company_website || profile.website || "",
    profile_source: item.profile_source || profile.profile_source || "",
    publication_entity: item.publication_entity || item.subject_name || "待补充"
  };
  record.market = item.market || item.listing_market || inferMarket(record.stock_code, record.subject_type);
  record.exchange_verification_url = exchangeVerificationUrl(record.market, record.stock_code);
  record.source_class = item.source_class || classifySource(record.source);
  record.source_reliability = item.source_reliability || reliabilityFor(record.source_class);
  record.lessee_relation = item.lessee_relation || item["承租关系"] || inferLesseeRelation(baseText, record.lease_role);
  record.actual_lessee = item.actual_lessee || item["实际承租人"] || inferActualLessee(baseText, record.subject_name, record.lessee_relation);
  record.group_name = item.group_name || `${record.subject_name}体系`;
  record.business_types = item.business_types || inferBusinessTypes(baseText, record.announcement_type, record.related_party);
  record.business_type = record.business_types[0] || "融资租赁事项";
  record.business_stage = item.business_stage || inferBusinessStage(baseText, record.counterparty);
  record.amount_numeric = parseAmount(amountOriginal);
  record.amount_type = item.amount_type || inferAmountType(baseText);
  record.amount_band = amountBand(record.amount_numeric);
  record.term_months = parseTermMonths(termOriginal);
  record.term_band = termBand(record.term_months);
  record.lessor_type = item.lessor_type || inferLessorType(record.counterparty);
  record.asset_category = item.asset_category || inferAssetCategory(`${record.leased_asset} ${baseText}`);
  record.guarantee_methods = item.guarantee_methods || inferGuaranteeMethods(`${record.guarantee_or_collateral} ${baseText}`);
  record.guarantee_method = record.guarantee_methods.join("、") || "未披露";
  record.decision_process = item.decision_process || inferDecisionProcess(baseText);
  record.financing_cost = item.financing_cost || extractLabeledValue(baseText, ["综合融资成本", "租赁利率", "利率"]) || "未披露";
  record.capital_use = item.capital_use || extractLabeledValue(baseText, ["资金用途", "融资用途"]) || "未披露";
  record.search_blob = [record.subject_name, record.stock_code, record.bond_code, record.actual_lessee, record.group_name, record.title, record.counterparty, record.summary, record.region, record.industry, record.market, record.enterprise_nature, record.business_types.join(" "), record.business_stage, record.risk_labels.join(" "), record.snippets.join(" ")].join(" ").toLowerCase();
  return record;
}

function calculateScores(item) {
  let opportunity = 28;
  if (["初步计划", "董事会审议", "股东大会审议", "授权融资额度", "出租人待定", "出租人招标"].includes(item.business_stage)) opportunity += 28;
  if (!isDisclosed(item.counterparty)) opportunity += 14;
  if (item.amount_numeric >= 500000000) opportunity += 16;
  else if (item.amount_numeric >= 100000000) opportunity += 12;
  else if (item.amount_numeric >= 50000000) opportunity += 7;
  if (/^授权总额度|年度预计额度|多家子公司共享额度$/.test(item.amount_type)) opportunity += 10;
  if (item.lessee_relation !== "上市公司本部") opportunity += 5;
  if (/(制造|电力|新能源|交通|采矿|医药|公用事业|数据|通信)/.test(item.industry + item.asset_category)) opportunity += 6;
  if ((subjectFrequency.get(item.subject_name) || 0) >= 3) opportunity += 6;
  if (["项目实施中", "已完成提款", "提前还款", "合同终止"].includes(item.business_stage)) opportunity -= 14;

  let risk = 12;
  const riskText = `${item.risk_labels.join(" ")} ${item.title} ${item.summary}`;
  if (/关联交易|关联担保/.test(riskText) || item.related_party === "是") risk += 18;
  if (/担保|抵押|质押|差额补足|回购承诺/.test(riskText)) risk += 14;
  if (/偿还债务|流动性|逾期|诉讼|问询|亏损/.test(riskText)) risk += 22;
  if (item.term_months && item.term_months <= 12) risk += 8;
  if ((subjectFrequency.get(item.subject_name) || 0) >= 4) risk += 12;
  if (item.business_type === "售后回租") risk += 8;
  if (!isDisclosed(item.leased_asset)) risk += 5;

  const completenessFields = [item.stock_code, item.market, item.enterprise_nature, item.actual_lessee, item.lessee_relation, item.counterparty, item.amount_original, item.term_original, item.leased_asset, item.guarantee_method, item.business_stage, item.snippets.length ? "有证据" : ""];
  const completeness = Math.round(completenessFields.filter(isDisclosed).length / completenessFields.length * 100);
  return { opportunity_score: clamp(opportunity, 0, 100), risk_score: clamp(risk, 0, 100), completeness_score: completeness };
}

function opportunityLabel(item) {
  if (item.risk_score >= 75) return "高风险监测事项";
  if (item.risk_score >= 58 && item.opportunity_score < 70) return "谨慎关注项目";
  if (["已完成提款", "项目实施中", "提前还款", "合同终止"].includes(item.business_stage)) return "已落地同业项目";
  if (item.opportunity_score >= 80) return "高价值业务线索";
  if (item.opportunity_score >= 65) return "建议重点跟进";
  return "一般业务信息";
}

function buildOneLiner(item) {
  const parts = [];
  if (isDisclosed(item.enterprise_nature)) parts.push(item.enterprise_nature);
  parts.push(item.lessee_relation === "上市公司本部" ? item.subject_name : `${item.subject_name}${item.lessee_relation.replace("上市公司", "")}`);
  parts.push(`${item.business_stage}${item.business_type}`);
  if (item.amount_numeric) parts.push(item.amount_original);
  if (!isDisclosed(item.counterparty)) parts.push("出租人尚未确定");
  parts.push(item.opportunity_score >= 75 ? "建议优先联系" : item.opportunity_label);
  return `${parts.join("，")}。`;
}

function inferMarket(code, subjectType) {
  if (/港股|H股/.test(subjectType)) return "港股主板";
  if (/^(688|689)/.test(code)) return "科创板";
  if (/^(300|301)/.test(code)) return "创业板";
  if (/^(4|8|92)/.test(code)) return "北交所";
  if (/^(600|601|603|605)/.test(code)) return "沪市主板";
  if (/^(000|001|002|003)/.test(code)) return "深市主板";
  return code ? "其他上市市场" : "待补充";
}

function inferLesseeRelation(text, role) {
  if (/间接控股子公司/.test(text)) return "间接控股子公司";
  if (/全资子公司/.test(text)) return "全资子公司";
  if (/控股子公司|子公司/.test(text)) return "控股子公司";
  if (/参股公司/.test(text)) return "重要参股公司";
  if (role === "担保方" || /为.*融资租赁提供担保/.test(text)) return "上市公司为担保人";
  return "上市公司本部";
}

function inferActualLessee(text, subject, relation) {
  const patterns = [
    /(?:间接控股子公司|全资子公司|控股子公司|参股公司)[\s：:]*(?:为)?([^\s，。；（）()]{2,42}(?:有限公司|股份公司|公司))/,
    /被担保人名称[\s：:]*([^\n●，。；]{2,48})/,
    /为([^\s，。；（）()]{2,42}(?:有限公司|股份公司|公司))(?:申请|办理|开展|提供)/
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return cleanEntityName(match[1]);
  }
  return relation === "上市公司本部" ? subject : `${subject}下属企业（名称待补充）`;
}

function inferBusinessTypes(text, announcedType, relatedParty) {
  const types = [];
  const rules = [[/提前还款|提前清偿/, "提前还款"], [/终止|解除/, "合同终止"], [/应收租赁款.*转让|應收租賃款.*轉讓/, "应收租赁款转让"], [/租赁资产.*转让|租賃資產.*轉讓/, "租赁资产转让"], [/售后回租|售後回租|售後租回|融资性售后回租/, "售后回租"], [/直接租赁|直接租賃|直租/, "直接租赁"], [/经营租赁|經營租賃/, "经营租赁"], [/跨境.*租赁|境外.*租赁|跨境.*租賃|境外.*租賃/, "跨境融资租赁"], [/厂商租赁|廠商租賃/, "厂商租赁"], [/联合租赁|聯合租賃/, "联合租赁"], [/框架协议|框架協議/, "融资租赁框架协议"], [/额度|授信|額度/, "融资租赁额度"], [/担保|擔保/, "担保公告"], [/关联交易|關連交易/, "关联交易公告"], [/签署|簽署|訂立|融资租赁合同|融資租賃合同/, "合同签署公告"], [/进展|進展/, "项目进展公告"]];
  rules.forEach(([pattern, label]) => { if (pattern.test(text)) types.push(label); });
  if (relatedParty === "是" && !types.includes("关联交易公告")) types.push("关联融资租赁");
  if (announcedType && !types.length) types.push(announcedType);
  if (!types.length) types.push("融资租赁事项");
  return unique(types);
}

function inferBusinessStage(text, counterparty) {
  if (/提前还款|提前清偿/.test(text)) return "提前还款";
  if (/终止|解除/.test(text)) return "合同终止";
  if (/招标|遴选|征集出租人/.test(text)) return "出租人招标";
  if (!isDisclosed(counterparty) && /拟|计划|申请|授权|额度/.test(text)) return "出租人待定";
  if (/股东大会.*(?:审议|议案)|提交股东大会/.test(text)) return "股东大会审议";
  if (/董事会.*(?:审议|议案)/.test(text)) return "董事会审议";
  if (/授权.*额度|融资额度|年度预计/.test(text)) return "授权融资额度";
  if (/框架协议/.test(text)) return "签署框架协议";
  if (/已提款|完成提款|租金支付/.test(text)) return "已完成提款";
  if (/进展|实施中/.test(text)) return "项目实施中";
  if (/签订|簽訂|签署|簽署|訂立|融资租赁合同|融資租賃合同/.test(text)) return "签署正式合同";
  if (/拟|计划|意向/.test(text)) return "初步计划";
  return "待识别";
}

function inferAmountType(text) {
  if (/多家子公司|共享额度/.test(text)) return "多家子公司共享额度";
  if (/剩余额度|尚未使用/.test(text)) return "剩余额度";
  if (/已使用|实际使用|已提款/.test(text)) return "已实际使用金额";
  if (/年度预计|年度额度/.test(text)) return "年度预计额度";
  if (/授权.*额度|总额度|融资额度/.test(text)) return "授权总额度";
  return "单笔融资金额";
}

function inferLessorType(name) {
  if (!isDisclosed(name)) return "出租人待定";
  if (/(工银|建信|交银|农银|招银|兴业|光大|民生|华夏|浙银|苏银|徽银).*金融租赁/.test(name)) return "银行系融资租赁公司";
  if (/金融租赁|金租/.test(name)) return "金融租赁公司";
  if (/国际|境外|Hong Kong|Singapore/i.test(name)) return "境外融资租赁公司";
  if (/融资租赁|租赁/.test(name)) return "融资租赁公司（性质待补充）";
  return "待分类";
}

function inferAssetCategory(text) {
  const rules = [[/医疗|医院/, "医疗设备"], [/光伏|组件/, "光伏设备"], [/风电|风机/, "风电设备"], [/储能|电池/, "储能设备"], [/矿山|采矿|煤矿/, "矿山设备"], [/工程机械|挖掘机|起重机/, "工程机械"], [/船舶|船舰/, "船舶"], [/车辆|汽车|公交车/, "车辆"], [/飞机|航空器/, "飞机"], [/数据中心|机房/, "数据中心设备"], [/算力|服务器|GPU/, "算力设备"], [/通信|基站/, "通信设备"], [/管网|管道/, "管网及基础设施"], [/房屋|建筑物|厂房/, "房屋建筑物"], [/在建工程/, "在建工程"], [/公用事业|供水|供热|燃气|电力设备/, "公用事业设备"], [/生产线|生产设备|机器设备|核心设备/, "工业生产设备"]];
  return rules.find(([pattern]) => pattern.test(text))?.[1] || (isDisclosed(text.trim()) ? "其他资产" : "未披露");
}

function inferGuaranteeMethods(text) {
  const methods = [];
  [[/无担保|无增信/, "无担保"], [/上市公司.*担保|公司为.*提供.*担保/, "上市公司担保"], [/控股股东.*担保/, "控股股东担保"], [/实际控制人.*担保/, "实际控制人担保"], [/母公司.*担保|集团.*担保/, "集团母公司担保"], [/子公司.*担保/, "上市公司子公司担保"], [/互保/, "子公司之间互保"], [/抵押/, "抵押"], [/质押|质权/, "质押"], [/保证金/, "保证金"], [/回购承诺/, "回购承诺"], [/差额补足/, "差额补足"]].forEach(([pattern, label]) => { if (pattern.test(text)) methods.push(label); });
  if (methods.length > 1) methods.push("多种增信组合");
  return unique(methods.length ? methods : ["未披露"]);
}

function inferDecisionProcess(text) {
  if (/股东大会/.test(text)) return "需股东大会审议";
  if (/董事会/.test(text)) return "董事会审议";
  if (/总经理|经营层/.test(text)) return "经营层决策";
  return "未披露";
}

function parseAmount(value) {
  if (!isDisclosed(value)) return 0;
  const text = String(value).replaceAll(",", "").replace(/\s/g, "");
  const match = text.match(/(?:不超过|不超過|上限为|上限為|金额为|金額為|融资额度为|融資額度為|人民币|港币|港幣)?([0-9]+(?:\.[0-9]+)?)(万亿|萬億|亿港元|億港元|百萬港元|万港元|萬港元|亿|億|万|萬|港元|元)?/);
  if (!match) return 0;
  const number = Number(match[1]);
  const unit = match[2] || (/[万萬]元/.test(text) ? "万" : /[亿億]元/.test(text) ? "亿" : "元");
  return Math.round(number * ({ "万亿": 1e12, "萬億": 1e12, "亿港元": 1e8, "億港元": 1e8, "百萬港元": 1e6, "万港元": 1e4, "萬港元": 1e4, "亿": 1e8, "億": 1e8, "万": 1e4, "萬": 1e4, "港元": 1, "元": 1 }[unit] || 1));
}

function parseTermMonths(value) {
  if (!isDisclosed(value)) return 0;
  const text = String(value);
  const year = text.match(/([0-9]+(?:\.[0-9]+)?)\s*年/);
  if (year) return Math.round(Number(year[1]) * 12);
  const month = text.match(/([0-9]+(?:\.[0-9]+)?)\s*个?月/);
  if (month) return Math.round(Number(month[1]));
  const day = text.match(/([0-9]+)\s*天/);
  if (day) return Math.round(Number(day[1]) / 30);
  return 0;
}

function amountBand(value) {
  if (!value) return "未披露";
  if (value < 50000000) return "5000万元以下";
  if (value < 100000000) return "5000万元至1亿元";
  if (value < 300000000) return "1亿元至3亿元";
  if (value < 500000000) return "3亿元至5亿元";
  if (value < 1000000000) return "5亿元至10亿元";
  return "10亿元以上";
}

function termBand(months) {
  if (!months) return "未披露";
  if (months <= 12) return "1年以内";
  if (months <= 24) return "1年至2年";
  if (months <= 36) return "2年至3年";
  if (months <= 60) return "3年至5年";
  return "5年以上";
}

function companyRadarRecords() {
  const query = els.globalSearch.value.trim().toLowerCase();
  return allRecords.filter((item) => {
    if (query && !item.search_blob.includes(query)) return false;
    if (els.marketFilter.value && item.market !== els.marketFilter.value) return false;
    if (els.natureFilter.value && item.enterprise_nature !== els.natureFilter.value) return false;
    if (els.region.value && item.region !== els.region.value) return false;
    if (els.industry.value && item.industry !== els.industry.value) return false;
    return true;
  });
}

function companyAggregate(name, records) {
  const latest = [...records].sort(sortByDateDesc)[0];
  const oneYearAgo = addDays(todayText(), -364);
  return { name, stock_code: latest.stock_code, market: latest.market, nature: latest.enterprise_nature, enterprise_nature_basis: latest.enterprise_nature_basis, actual_controller: latest.actual_controller, region: latest.region, industry: latest.industry, market_cap: latest.market_cap, market_cap_date: latest.market_cap_date, market_cap_source: latest.market_cap_source, company_website: latest.company_website, profile_source: latest.profile_source, count: records.length, recent_count: records.filter((item) => item.announcement_date >= oneYearAgo).length, total_amount: sumAmount(records), lessors: new Set(records.map((item) => item.counterparty).filter(isDisclosed)).size, latest_date: latest.announcement_date };
}

function lessorAggregate(name, records) {
  const disclosedAmounts = records.filter((item) => item.amount_numeric > 0);
  const latest = [...records].sort(sortByDateDesc)[0];
  const oneYearAgo = addDays(todayText(), -364);
  return { name, type: latest.lessor_type, company_count: new Set(records.map((item) => item.subject_name)).size, recent_count: records.filter((item) => item.announcement_date >= oneYearAgo).length, total_amount: sumAmount(records), average_amount: disclosedAmounts.length ? sumAmount(disclosedAmounts) / disclosedAmounts.length : 0, top_industry: topKeys(countBy(records, "industry"), 1)[0] || "未披露", common_term: topKeys(countBy(records, "term_band"), 1)[0] || "未披露", latest_date: latest.announcement_date };
}

function loadWorkspace() {
  try {
    const parsed = JSON.parse(localStorage.getItem(WORKSPACE_KEY) || "{}");
    return { records: parsed.records || {}, watchlist: parsed.watchlist || [], filters: parsed.filters || [] };
  } catch (error) {
    return { records: {}, watchlist: [], filters: [] };
  }
}

function persistWorkspace() { localStorage.setItem(WORKSPACE_KEY, JSON.stringify(workspace)); }
function cacheBustUrl(path) { const url = new URL(path, location.href); url.searchParams.set("_", Date.now().toString()); return url.toString(); }
function todayText() { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`; }
function addDays(dateText, days) { const date = new Date(`${dateText}T12:00:00`); date.setDate(date.getDate() + days); return date.toISOString().slice(0, 10); }
function yearsBetween(start, end) { if (!start || !end) return []; const years = []; for (let year = Number(start.slice(0, 4)); year <= Number(end.slice(0, 4)); year += 1) years.push(String(year)); return years; }
function dateDiff(start, end) { return Math.round((new Date(`${end}T12:00:00`) - new Date(`${start}T12:00:00`)) / 86400000); }
function sortByDateDesc(a, b) { return b.announcement_date.localeCompare(a.announcement_date) || a.subject_name.localeCompare(b.subject_name, "zh-CN"); }
function sumAmount(records) { return records.reduce((sum, item) => sum + (item.amount_numeric || 0), 0); }
function formatAmount(value) { if (!value) return "未披露"; if (value >= 1e8) return `${(value / 1e8).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}亿元`; return `${(value / 1e4).toLocaleString("zh-CN", { maximumFractionDigits: 0 })}万元`; }
function formatMarketCap(value, asOf) { if (!value) return "待补充"; const amount = formatAmount(value); return asOf ? `${amount}（${asOf}）` : amount; }
function parseNumber(value) { const number = Number(String(value || "").replace(/[^0-9.]/g, "")); return Number.isFinite(number) ? number : 0; }
function disclosedOr(primary, fallback, emptyValue) { return isDisclosed(primary) ? primary : isDisclosed(fallback) ? fallback : emptyValue; }
function clamp(value, min, max) { return Math.max(min, Math.min(max, Math.round(value))); }
function isDevelopmentStage(stage) { return ["初步计划", "董事会审议", "股东大会审议", "授权融资额度", "出租人待定", "出租人招标"].includes(stage); }
function isPending(item) { return /\u5f85|\u4ec5\u516c\u544a\u5143\u6570\u636e|\u7ebf\u7d22/.test(`${item.review_status}${item.source_reliability}`); }
function isDisclosed(value) { return Boolean(value) && !/\u672a\u62ab\u9732|\u5f85\u8865\u5145|\u5f85\u8bc6\u522b|\u5f85\u5b9a|\u6682\u65e0|^--$/.test(String(value)); }
function cleanCounterparty(value) { if (!isDisclosed(value)) return "未披露"; return String(value).split(/(?:（[\u4e00-\u5341\d]+）|\([\u4e00-\u5341\d]+\)|(?:[12][、.．]\s*)?(?:承租人|保证人|保證人|担保人|擔保人)[：:]?|担保方式|担保的本金|融资期限|租赁物|。|；)/)[0].trim().replace(/[，,:：]+$/, "") || "未披露"; }
function cleanEntityName(value) { return String(value).replace(/^(?:为|由)/, "").replace(/[，。；:：]+$/, "").trim(); }
function normalizeName(value) { return String(value).replace(/[（(].*$/, "").replace(/\s/g, "").slice(0, 36); }
function classifySource(source) { if (/巨潮|交易所|上交所|深交所|北交所|披露易/i.test(source)) return "官方公告"; if (/债券|上清所|中债|交易商协会/.test(source)) return "发债披露"; if (/公司官网|投资者关系/.test(source)) return "公司官网"; if (/预警通/.test(source)) return "预警通"; return source ? "其他来源" : "待识别来源"; }
function reliabilityFor(sourceClass) { return { "官方公告": "高", "发债披露": "高", "公司官网": "中高", "预警通": "中" }[sourceClass] || "待复核"; }
function exchangeVerificationUrl(market, code) { if (market === "沪市主板" || market === "科创板") return code ? `https://www.sse.com.cn/assortment/stock/list/info/announcement/index.shtml?productId=${encodeURIComponent(code)}` : "https://www.sse.com.cn/disclosure/listedinfo/announcement/"; if (market === "深市主板" || market === "创业板") return "https://www.szse.cn/disclosure/notice/company/index.html"; if (market === "北交所") return "https://www.bse.cn/disclosure/announcement.html"; if (market === "港股主板") return "https://www1.hkexnews.hk/search/titlesearch.xhtml?lang=zh"; return ""; }
function extractLabeledValue(text, labels) { for (const label of labels) { const match = text.match(new RegExp(`${label}[\\s：:]*([^\\n；。]{2,60})`)); if (match?.[1]) return match[1].trim(); } return ""; }
function topKeys(counts, limit) { return Object.entries(counts).filter(([key]) => isDisclosed(key)).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([key]) => key); }
function topArrayValues(records, key, limit) { const counts = {}; records.flatMap((item) => item[key] || []).filter(isDisclosed).forEach((value) => { counts[value] = (counts[value] || 0) + 1; }); return topKeys(counts, limit); }
function countBy(records, key) { return records.reduce((acc, item) => { const value = item[key] || "待补充"; acc[value] = (acc[value] || 0) + 1; return acc; }, {}); }
function opportunityClass(item) { if (item.opportunity_label === "高风险监测事项") return "risk"; if (item.opportunity_score >= 80) return "high"; if (item.opportunity_score >= 65) return "medium"; return "neutral"; }
function opportunityTagClass(label) { if (label === "高风险监测事项") return "red"; if (label === "高价值业务线索") return "green"; if (label.includes("谨慎") || label.includes("建议")) return "orange"; return "blue"; }
function shortOpportunityLabel(label) { return label.replace("业务线索", "线索").replace("业务信息", "信息").replace("同业项目", "同业").replace("监测事项", "监测"); }
function riskAdvice(item) { if (item.risk_score >= 75) return "风险信号较多，建议同步核查流动性、担保余额、监管问询和债务到期。"; if (item.risk_score >= 55) return "建议核查担保结构、关联交易和近期重复融资情况。"; return "当前公告未见明显高风险信号，仍需以公告原文和财务数据复核。"; }
function workStateClass(status) { if (["已立项", "已拜访", "已联系"].includes(status)) return "success"; if (["待联系", "重点关注"].includes(status)) return "warning"; if (["排除", "暂不跟进"].includes(status)) return "error"; return "info"; }
function sourceStateText(item) { if (!item.connected) return "未接入"; if (item.mode === "covered") return item.state === "green" ? "已覆盖" : item.state === "yellow" ? "覆盖延迟" : "覆盖异常"; if (item.mode === "reference") return "可复核"; return item.state === "green" ? "正常" : item.state === "yellow" ? "延迟" : "异常"; }
function sourceModeText(mode) { return { direct: "直接采集", covered: "巨潮覆盖", reference: "复核入口", unconnected: "未自动接入" }[mode] || "待确认"; }
function sourceStateClass(state) { return state === "green" ? "success" : state === "yellow" ? "warning" : state === "red" ? "error" : "info"; }
function buildFallbackSourceStatuses(payload) { const modes = { "巨潮资讯": "direct", "上海证券交易所": "covered", "深圳证券交易所": "covered", "北京证券交易所": "covered", "港交所披露易": "direct", "上市公司官网": "reference", "互联网/公众号": "unconnected" }; return Object.entries(modes).map(([source, mode]) => ({ source, mode, connected: Boolean(payload.source_counts?.[source]), state: payload.source_counts?.[source] ? (payload.freshness_state || "green") : "unconnected", record_count: payload.source_counts?.[source] || 0, last_checked_at: payload.latest_run?.finished_at, last_success_at: payload.latest_successful_run?.finished_at, latest_announcement_date: payload.source_counts?.[source] ? payload.latest_announcement_date : null })); }
function eventHref(id) { return `#event=${encodeURIComponent(id)}`; }
function restoreSelectionFromLocation() { if (!location.hash.startsWith("#event=")) return; const id = decodeURIComponent(location.hash.slice(7)); if (recordStore.has(id)) selectRecord(id, false); }
function formatDateTime(value) { if (!value || value === "--") return "--"; const parsed = new Date(value.replace(" ", "T")); return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }); }
function formatShortDateTime(value) { const text = formatDateTime(value); return text === "--" ? text : text.replace(" ", "\n"); }
function unique(values) { return [...new Set(values.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), "zh-CN")); }
function arrayValue(value) { if (Array.isArray(value)) return value.filter(Boolean); if (!value) return []; return String(value).split(/[、,，;；\n]/).map((item) => item.trim()).filter(Boolean); }
function highlightKeywords(value, keywords) { let html = escapeHtml(value); [...keywords].sort((a, b) => b.length - a.length).forEach((keyword) => { const safe = escapeHtml(keyword); html = html.replace(new RegExp(safe.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), `<mark>${safe}</mark>`); }); return html; }
function setText(id, value) { const element = document.getElementById(id); if (element) element.textContent = value; }
function setHtml(id, value) { const element = document.getElementById(id); if (element) element.innerHTML = value; }
function shorten(value, length) { const text = String(value || ""); return text.length > length ? `${text.slice(0, length)}…` : text; }
function csvCell(value) { return `"${String(value ?? "").replaceAll('"', '""')}"`; }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }
function escapeAttribute(value) { return escapeHtml(String(value ?? "")); }
