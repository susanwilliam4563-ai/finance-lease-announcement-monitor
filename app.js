const sampleRecords = [
  {
    id: "sample:official",
    subject_name: "威龙股份",
    subject_type: "A股上市公司",
    stock_code: "603779",
    bond_code: "",
    region: "山东",
    industry: "食品饮料",
    announcement_date: "2026-06-30",
    title: "威龙葡萄酒股份有限公司关于公司开展融资租赁暨关联交易的公告",
    source: "巨潮资讯",
    source_url: "https://www.cninfo.com.cn/new/disclosure/detail?stockCode=603779&announcementId=1225394107",
    pdf_url: "https://static.cninfo.com.cn/finalpage/2026-06-30/1225394107.PDF",
    matched_keywords: ["融资租赁", "售后回租", "关联交易"],
    matched_position: "标题+正文",
    announcement_type: "售后回租",
    lease_role: "承租人",
    amount: "2000万元",
    term: "12个月",
    counterparty: "齐信融资租赁",
    leased_asset: "固定资产",
    related_party: "是",
    guarantee_or_collateral: "未披露",
    summary: "威龙股份拟开展售后回租融资租赁，构成关联交易。",
    risk_labels: ["售后回租", "关联交易", "期限较短", "利率未披露"],
    review_status: "已复核官方公告",
    snippets: ["融资方式为售后回租，融资总额不超过2000万元，融资期限为12个月。"],
    attention_level: "B",
    notes: ""
  },
  {
    id: "sample:web",
    subject_name: "某城投集团",
    subject_type: "发债主体",
    stock_code: "",
    bond_code: "25某城投MTN001",
    region: "江苏",
    industry: "城投",
    announcement_date: "2026-07-02",
    title: "关于子公司开展售后回租融资事项的公告",
    source: "预警通",
    source_url: "#",
    pdf_url: "",
    matched_keywords: ["售后回租", "融资"],
    matched_position: "标题+摘要",
    announcement_type: "售后回租",
    lease_role: "承租人",
    amount: "2亿元",
    term: "3年",
    counterparty: "某金融租赁公司",
    leased_asset: "市政设备",
    related_party: "未披露",
    guarantee_or_collateral: "资产抵押",
    summary: "预警通线索显示发债主体子公司开展售后回租。",
    risk_labels: ["售后回租", "资产抵押", "大额融资", "待复核"],
    review_status: "已复核预警通",
    snippets: ["预警通摘要显示子公司以市政设备开展售后回租融资。"],
    attention_level: "A",
    notes: "演示数据"
  }
];

let allRecords = sampleRecords.map(normalizeRecord);
let filteredRecords = [...allRecords];
let selectedId = "";
let liveSyncTimer = null;
let lastServerRevision = "";
let displayLimit = 200;
let dataMode = "unknown";

const els = {
  globalSearch: document.getElementById("globalSearch"),
  datePreset: document.getElementById("datePreset"),
  yearFilter: document.getElementById("yearFilter"),
  quarterFilter: document.getElementById("quarterFilter"),
  startDate: document.getElementById("startDate"),
  endDate: document.getElementById("endDate"),
  subjectType: document.getElementById("subjectType"),
  region: document.getElementById("region"),
  industry: document.getElementById("industry"),
  sourceClass: document.getElementById("sourceClass"),
  source: document.getElementById("source"),
  risk: document.getElementById("risk"),
  reviewStatus: document.getElementById("reviewStatus"),
  level: document.getElementById("level"),
  onlyHigh: document.getElementById("onlyHigh"),
  onlyUnverified: document.getElementById("onlyUnverified"),
  resetFilters: document.getElementById("resetFilters"),
  exportCsv: document.getElementById("exportCsv"),
  dataUpload: document.getElementById("dataUpload"),
  leadQuery: document.getElementById("leadQuery"),
  buildLeadLinks: document.getElementById("buildLeadLinks"),
  leadLinks: document.getElementById("leadLinks"),
  recordsBody: document.getElementById("recordsBody"),
  tableFooter: document.getElementById("tableFooter"),
  visibleCount: document.getElementById("visibleCount"),
  loadMore: document.getElementById("loadMore"),
  resultCount: document.getElementById("resultCount"),
  datasetStatus: document.getElementById("datasetStatus"),
  refreshStatus: document.getElementById("refreshStatus"),
  nextRefresh: document.getElementById("nextRefresh"),
  dataAsOf: document.getElementById("dataAsOf"),
  syncState: document.getElementById("syncState"),
  healthBanner: document.getElementById("healthBanner"),
  healthTitle: document.getElementById("healthTitle"),
  healthDetail: document.getElementById("healthDetail"),
  updatedAt: document.getElementById("updatedAt"),
  detailContent: document.getElementById("detailContent"),
  detailLevel: document.getElementById("detailLevel")
};

init();

async function init() {
  setDefaultDates();
  bindEvents();
  await loadServerRecords();
  const status = await loadServerStatus();
  populateFilters();
  applyFilters();
  buildLeadLinks();
  restoreSelectionFromLocation();
  startLiveSync(status?.page_poll_interval_seconds || 60);
}

function bindEvents() {
  const filterIds = [
    "globalSearch", "datePreset", "yearFilter", "quarterFilter", "startDate", "endDate", "subjectType",
    "region", "industry", "sourceClass", "source", "risk", "reviewStatus", "level", "onlyHigh", "onlyUnverified"
  ];
  filterIds.forEach((id) => {
    const eventName = ["globalSearch", "startDate", "endDate"].includes(id) ? "input" : "change";
    els[id].addEventListener(eventName, applyFilters);
  });
  els.datePreset.addEventListener("change", syncPresetDates);
  els.resetFilters.addEventListener("click", resetFilters);
  els.exportCsv.addEventListener("click", exportCsv);
  els.loadMore.addEventListener("click", () => {
    displayLimit += 200;
    renderTable();
  });
  els.dataUpload.addEventListener("change", handleUpload);
  els.buildLeadLinks.addEventListener("click", buildLeadLinks);
  els.leadQuery.addEventListener("keydown", (event) => {
    if (event.key === "Enter") buildLeadLinks();
  });
  window.addEventListener("hashchange", restoreSelectionFromLocation);
}

function setDefaultDates() {
  els.startDate.value = "";
  els.endDate.value = "";
}

async function loadServerRecords() {
  try {
    const response = await fetch("/api/records", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (Array.isArray(payload.records) && payload.records.length) {
      allRecords = payload.records.map(normalizeRecord);
      dataMode = "api";
      els.datasetStatus.textContent = `${(payload.count || allRecords.length).toLocaleString("zh-CN")} 条`;
      return true;
    }
    els.datasetStatus.textContent = "数据为空";
    dataMode = "api";
    return true;
  } catch (error) {
    try {
      const response = await fetch(cacheBustUrl("./data/records.json"), { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (!Array.isArray(payload.records)) throw new Error("记录格式无效");
      allRecords = payload.records.map(normalizeRecord);
      dataMode = "static";
      els.datasetStatus.textContent = `${(payload.count || allRecords.length).toLocaleString("zh-CN")} 条`;
      return false;
    } catch (staticError) {
      if (window.FINANCE_LEASE_RECORDS?.records?.length) {
        allRecords = window.FINANCE_LEASE_RECORDS.records.map(normalizeRecord);
        dataMode = "snapshot";
        els.datasetStatus.textContent = `快照 ${(window.FINANCE_LEASE_RECORDS.count || allRecords.length).toLocaleString("zh-CN")} 条`;
        setOfflineHealth("当前为本地快照", "静态文件不会自动获取新公告，请使用在线网址访问。");
        return false;
      }
    }
    els.datasetStatus.textContent = "样例数据";
    setOfflineHealth("未连接数据服务", "当前只显示样例，自动更新不可用。");
    return false;
  }
}

async function loadServerStatus() {
  if (!location.origin.startsWith("http")) return null;
  if (dataMode !== "static") {
    try {
      const response = await fetch("/api/status", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      dataMode = "api";
      updateServerHealth(payload);
      lastServerRevision = serverRevision(payload);
      return payload;
    } catch (error) {
      // A static deployment has no API and falls through to status.json.
    }
  }
  try {
    const response = await fetch(cacheBustUrl("./data/status.json"), { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    dataMode = "static";
    updateServerHealth(payload);
    lastServerRevision = serverRevision(payload);
    return payload;
  } catch (error) {
    setOfflineHealth("数据服务暂时不可达", "页面会继续显示最近一次成功载入的数据。");
    return null;
  }
}

function updateServerHealth(payload) {
  const auto = payload.auto_refresh || {};
  const isStatic = payload.deployment_mode === "static";
  const state = auto.running ? "checking" : !auto.enabled ? "warning" : payload.latest_run?.status === "failed" ? "error" : "ok";
  const pollSeconds = payload.page_poll_interval_seconds || 60;
  const sourceCount = Object.keys(payload.source_counts || {}).length;
  els.syncState.dataset.state = state;
  els.healthBanner.dataset.state = state;
  els.dataAsOf.textContent = payload.data_as_of || payload.latest_announcement_date || "--";
  els.datasetStatus.textContent = `${Number(payload.record_count || allRecords.length).toLocaleString("zh-CN")} 条`;

  if (isStatic && payload.latest_run?.status !== "failed") {
    els.refreshStatus.textContent = `每${auto.interval_minutes || 60}分钟云端更新`;
    els.healthTitle.textContent = `公告已核对至 ${payload.data_as_of || "--"}`;
  } else if (auto.running) {
    els.refreshStatus.textContent = "正在抓取新公告";
    els.healthTitle.textContent = "后台正在核对最新公告";
  } else if (!auto.enabled) {
    els.refreshStatus.textContent = "自动采集未开启";
    els.healthTitle.textContent = "自动采集未开启";
  } else if (payload.latest_run?.status === "failed") {
    els.refreshStatus.textContent = "最近一次采集失败";
    els.healthTitle.textContent = "最近一次采集需要检查";
  } else {
    els.refreshStatus.textContent = `每${auto.interval_minutes || 60}分钟自动采集`;
    els.healthTitle.textContent = `公告已核对至 ${payload.data_as_of || "--"}`;
  }

  els.nextRefresh.textContent = auto.next_run_at ? `下次 ${formatDateTime(auto.next_run_at)}` : isStatic ? `最近 ${formatDateTime(payload.generated_at || auto.last_finished_at || "")}` : "等待后台任务";
  els.healthDetail.textContent = isStatic
    ? `已接入 ${sourceCount} 类数据来源；云端按小时更新，访客页面每 ${pollSeconds} 秒检查一次新版本。`
    : `已接入 ${sourceCount} 类数据来源；访客页面每 ${pollSeconds} 秒检查一次，有新记录时自动同步。`;
}

function setOfflineHealth(title, detail) {
  els.syncState.dataset.state = "offline";
  els.healthBanner.dataset.state = "offline";
  els.refreshStatus.textContent = title;
  els.nextRefresh.textContent = "自动更新不可用";
  els.healthTitle.textContent = title;
  els.healthDetail.textContent = detail;
}

function serverRevision(payload) {
  const run = payload.latest_successful_run || {};
  return payload.revision || `${payload.record_count || 0}|${run.id || 0}|${run.finished_at || payload.generated_at || ""}`;
}

function cacheBustUrl(path) {
  const url = new URL(path, location.href);
  url.searchParams.set("_", Date.now().toString());
  return url.toString();
}

function startLiveSync(intervalSeconds) {
  if (liveSyncTimer) clearInterval(liveSyncTimer);
  if (!location.origin.startsWith("http")) return;
  liveSyncTimer = setInterval(syncFromServer, Math.max(30, intervalSeconds) * 1000);
}

async function syncFromServer() {
  const previousRevision = lastServerRevision;
  const status = await loadServerStatus();
  if (!status || !previousRevision || serverRevision(status) === previousRevision) return;
  await loadServerRecords();
  populateFilters();
  applyFilters();
}

function populateFilters() {
  fillSelect(els.yearFilter, unique(allRecords.map((item) => item.announcement_date.slice(0, 4)).filter(Boolean)).reverse());
  fillSelect(els.subjectType, unique(allRecords.map((item) => item.subject_type)));
  fillSelect(els.region, unique(allRecords.map((item) => item.region)));
  fillSelect(els.industry, unique(allRecords.map((item) => item.industry)));
  fillSelect(els.sourceClass, unique(allRecords.map((item) => item.source_class)));
  fillSelect(els.source, unique(allRecords.map((item) => item.source)));
  fillSelect(els.risk, unique(allRecords.flatMap((item) => item.risk_labels)));
  fillSelect(els.reviewStatus, unique(allRecords.map((item) => item.review_status)));
  fillSelect(els.level, unique(allRecords.map((item) => item.attention_level)));
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

function syncPresetDates() {
  if (els.datePreset.value !== "custom") {
    els.startDate.value = "";
    els.endDate.value = "";
  }
}

function applyFilters() {
  const query = els.globalSearch.value.trim().toLowerCase();
  const range = resolveDateRange();
  filteredRecords = allRecords.filter((item) => {
    if (query && !searchBlob(item).includes(query)) return false;
    if (range.start && item.announcement_date < range.start) return false;
    if (range.end && item.announcement_date > range.end) return false;
    if (els.yearFilter.value && item.announcement_date.slice(0, 4) !== els.yearFilter.value) return false;
    if (els.quarterFilter.value && quarterOf(item.announcement_date) !== els.quarterFilter.value) return false;
    if (els.subjectType.value && item.subject_type !== els.subjectType.value) return false;
    if (els.region.value && item.region !== els.region.value) return false;
    if (els.industry.value && item.industry !== els.industry.value) return false;
    if (els.sourceClass.value && item.source_class !== els.sourceClass.value) return false;
    if (els.source.value && item.source !== els.source.value) return false;
    if (els.risk.value && !item.risk_labels.includes(els.risk.value)) return false;
    if (els.reviewStatus.value && item.review_status !== els.reviewStatus.value) return false;
    if (els.level.value && item.attention_level !== els.level.value) return false;
    if (els.onlyHigh.checked && !["A", "B"].includes(item.attention_level)) return false;
    if (els.onlyUnverified.checked && !isPending(item)) return false;
    return true;
  });
  displayLimit = 200;
  render();
}

function resolveDateRange() {
  const maxDate = allRecords.reduce((max, item) => item.announcement_date > max ? item.announcement_date : max, "1900-01-01");
  const today = new Date().toISOString().slice(0, 10);
  if (els.datePreset.value === "all") return { start: "", end: "" };
  if (els.datePreset.value === "custom") return { start: els.startDate.value, end: els.endDate.value };
  if (els.datePreset.value === "today") return { start: maxDate, end: maxDate };
  if (els.datePreset.value === "ytd") return { start: `${today.slice(0, 4)}-01-01`, end: today };
  const date = new Date(`${today}T00:00:00`);
  date.setDate(date.getDate() - Number(els.datePreset.value) + 1);
  return { start: date.toISOString().slice(0, 10), end: today };
}

function render() {
  renderMetrics();
  renderSourceStrip();
  renderCharts();
  renderTable();
  els.resultCount.textContent = `${filteredRecords.length} 条结果`;
  els.updatedAt.textContent = `页面同步 ${new Date().toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" })}`;
}

function renderMetrics() {
  const coverage = profileCoverage(filteredRecords);
  setText("metricTotal", filteredRecords.length);
  setText("metricHigh", filteredRecords.filter((item) => item.attention_level === "A").length);
  setText("metricRelated", filteredRecords.filter((item) => item.related_party === "是").length);
  setText("metricGuarantee", filteredRecords.filter((item) => /担保|抵押|质押|保证/.test(item.guarantee_or_collateral + item.risk_labels.join(""))).length);
  setText("metricPending", filteredRecords.filter(isPending).length);
  setText("metricProfile", `${coverage}%`);
  document.getElementById("metricRange").textContent = dateRangeText(filteredRecords);
}

function renderSourceStrip() {
  const counts = countBy(filteredRecords, "source_class");
  setText("sourceOfficial", counts["官方公告"] || 0);
  setText("sourceBond", counts["发债披露"] || 0);
  setText("sourceCompany", counts["公司官网"] || 0);
  setText("sourceWarning", counts["预警通"] || 0);
  setText("sourceWeb", counts["互联网/公众号"] || 0);
}

function renderCharts() {
  renderTrend();
  renderRank("regionChart", countBy(filteredRecords, "region"), 8);
  renderRank("industryChart", countBy(filteredRecords, "industry"), 8);
  renderRank("counterpartyChart", countBy(filteredRecords.filter((item) => item.counterparty !== "未披露"), "counterparty"), 8);
  renderRank("subjectChart", countBy(filteredRecords, "subject_name"), 8);
  renderRiskTags();
}

function renderTrend() {
  const range = resolveDateRange();
  const groupByMonth = !range.start || dateDiff(range.start, range.end || maxRecordDate()) > 120;
  const counts = {};
  filteredRecords.forEach((item) => {
    const key = groupByMonth ? item.announcement_date.slice(0, 7) : item.announcement_date;
    counts[key] = (counts[key] || 0) + 1;
  });
  const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)).slice(-18);
  const max = Math.max(1, ...entries.map(([, count]) => count));
  document.getElementById("trendChart").innerHTML = entries.map(([date, count]) => `
    <div class="bar" title="${escapeHtml(date)}: ${count}条">
      <div style="height:${Math.max(4, Math.round((count / max) * 126))}px"></div>
      <span>${escapeHtml(groupByMonth ? date.slice(2) : date.slice(5))}</span>
    </div>
  `).join("");
}

function renderRank(id, counts, limit) {
  const entries = Object.entries(counts)
    .filter(([key]) => key && key !== "未披露")
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
  const max = Math.max(1, ...entries.map(([, count]) => count));
  document.getElementById(id).innerHTML = entries.length ? entries.map(([key, count]) => `
    <div class="rank-row">
      <span title="${escapeHtml(key)}">${escapeHtml(shorten(key, 9))}</span>
      <div class="track"><span style="width:${Math.round((count / max) * 100)}%"></span></div>
      <strong>${count}</strong>
    </div>
  `).join("") : '<p class="muted">暂无数据</p>';
}

function renderRiskTags() {
  const counts = {};
  filteredRecords.forEach((item) => item.risk_labels.forEach((tag) => counts[tag] = (counts[tag] || 0) + 1));
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 20);
  document.getElementById("riskChart").innerHTML = entries.map(([tag, count]) => {
    const klass = /关联|担保|抵押|大额|连续/.test(tag) ? "high" : /待|未披露|期限/.test(tag) ? "warn" : "ok";
    return `<span class="tag ${klass}">${escapeHtml(tag)} ${count}</span>`;
  }).join("");
}

function renderTable() {
  const visibleRecords = filteredRecords.slice(0, displayLimit);
  els.recordsBody.innerHTML = visibleRecords.map((item) => `
    <tr data-id="${escapeHtml(item.id)}" class="${item.id === selectedId ? "active" : ""}">
      <td class="subject-cell">
        <time>${escapeHtml(item.announcement_date)}</time>
        <strong>${escapeHtml(item.subject_name)}</strong>
        <div class="muted">${escapeHtml(item.subject_type)} ${escapeHtml(item.stock_code || item.bond_code || "")}</div>
        <div class="muted">${escapeHtml(item.region || "待补充")} · ${escapeHtml(shorten(item.industry || "待补充", 12))}</div>
      </td>
      <td class="event-cell">
        <div class="event-title">${escapeHtml(item.title)}</div>
        <div class="judgement-line">${escapeHtml(judgementText(item))}</div>
        <div class="muted match-line">${escapeHtml(hitReason(item))}</div>
        <div class="muted">${sourceBadge(item)} ${escapeHtml(item.source)}</div>
        <div class="row-links">
          <a class="evidence-link" href="${eventHref(item.id)}">查看证据</a>
          ${item.source_url ? `<a href="${escapeAttribute(item.source_url)}" target="_blank" rel="noreferrer">公告页面</a>` : ""}
          ${item.pdf_url ? `<a href="${escapeAttribute(item.pdf_url)}" target="_blank" rel="noreferrer">PDF</a>` : ""}
        </div>
      </td>
      <td>
        <div class="field-list">
          <span>金额：${escapeHtml(item.amount || "未披露")}</span>
          <span>期限：${escapeHtml(item.term || "未披露")}</span>
          <span>对手：${escapeHtml(shorten(item.counterparty || "未披露", 16))}</span>
        </div>
      </td>
      <td class="risk-cell">
        <span class="tag ${levelClass(item.attention_level)}">${escapeHtml(item.attention_level)}级</span>
        <div class="muted">${escapeHtml(item.review_status)}</div>
        <div class="match-line">${item.risk_labels.slice(0, 3).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join(" ")}</div>
      </td>
    </tr>
  `).join("");
  els.recordsBody.querySelectorAll("tr").forEach((row) => row.addEventListener("click", (event) => {
    if (event.target.closest("a[target='_blank']")) return;
    selectRecord(row.dataset.id, true);
  }));
  els.visibleCount.textContent = `已显示 ${visibleRecords.length.toLocaleString("zh-CN")} / ${filteredRecords.length.toLocaleString("zh-CN")} 条`;
  els.loadMore.hidden = visibleRecords.length >= filteredRecords.length;
  els.tableFooter.hidden = filteredRecords.length === 0;
  if (selectedId && !filteredRecords.some((item) => item.id === selectedId)) clearDetail();
}

function selectRecord(id, updateUrl = false) {
  selectedId = id;
  const item = allRecords.find((recordItem) => recordItem.id === id);
  if (!item) return;
  const completeness = completenessInfo(item);
  els.detailLevel.textContent = `${item.attention_level}级`;
  els.detailLevel.className = `level-badge ${levelClass(item.attention_level)}`;
  els.detailContent.className = "";
  els.detailContent.innerHTML = `
    <div class="detail-title-block">
      <span>${escapeHtml(item.announcement_date)} · ${escapeHtml(item.source)}</span>
      <h3>${escapeHtml(item.subject_name)}</h3>
      <p>${escapeHtml(item.title)}</p>
      <div class="detail-actions">
        ${item.source_url ? `<a class="primary-link" href="${escapeAttribute(item.source_url)}" target="_blank" rel="noreferrer">打开公告原文</a>` : ""}
        ${item.pdf_url ? `<a href="${escapeAttribute(item.pdf_url)}" target="_blank" rel="noreferrer">查看 PDF</a>` : ""}
        <a href="${eventHref(item.id)}">事件链接</a>
      </div>
    </div>
    <div class="detail-section evidence-section"><h3>命中证据</h3><p class="muted">${escapeHtml(hitReason(item))}</p>${unique(item.snippets).slice(0, 3).map((snippet) => `<blockquote>${highlightKeywords(snippet, item.matched_keywords)}</blockquote>`).join("") || "<p>当前仅有公告元数据，正文待补充。</p>"}</div>
    <div class="detail-section"><h3>关键业务要素</h3><dl class="field-grid"><div><dt>金额</dt><dd>${escapeHtml(item.amount || "未披露")}</dd></div><div><dt>期限</dt><dd>${escapeHtml(item.term || "未披露")}</dd></div><div><dt>交易对手</dt><dd>${escapeHtml(item.counterparty || "未披露")}</dd></div><div><dt>租赁物</dt><dd>${escapeHtml(item.leased_asset || "未披露")}</dd></div><div><dt>业务角色</dt><dd>${escapeHtml(item.lease_role || "未披露")}</dd></div><div><dt>担保/抵押</dt><dd>${escapeHtml(item.guarantee_or_collateral || "未披露")}</dd></div></dl></div>
    <div class="detail-section judgement-card"><h3>智能研判</h3><p>${escapeHtml(judgementText(item))}</p><p class="muted">${escapeHtml(nextActionText(item, completeness))}</p></div>
    <div class="detail-section">
      <h3>业务要素完整度</h3>
      <div class="completeness">
        <p>${completeness.filled}/${completeness.total} 项已披露</p>
        <div class="completeness-bar"><span style="width:${completeness.percent}%"></span></div>
        <div class="field-tags">${completeness.fields.map((field) => `<span class="tag ${field.ok ? "ok" : "missing"}">${escapeHtml(field.label)}</span>`).join("")}</div>
      </div>
    </div>
    <div class="detail-section"><h3>画像、来源与风险</h3><p>注册地：${escapeHtml(item.region)}；证监会行业：${escapeHtml(item.industry)}；来源层级：${escapeHtml(item.source_class)}；可信度：${escapeHtml(item.source_reliability)}</p><p class="tag-row">${item.risk_labels.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join(" ")}</p><p class="muted">${escapeHtml(item.review_status)} ${escapeHtml(item.notes || "")}</p></div>
    <div class="detail-section"><h3>外部复核</h3><p>${externalLinksFor(item).map((link) => `<a href="${escapeAttribute(link.url)}" target="_blank" rel="noreferrer">${escapeHtml(link.label)}</a>`).join(" · ")}</p></div>
  `;
  if (updateUrl) history.replaceState(null, "", eventHref(item.id));
  els.leadQuery.value = `${item.subject_name} ${item.title.includes("售后回租") ? "售后回租" : "融资租赁"}`;
  buildLeadLinks();
  renderTable();
  if (updateUrl && window.matchMedia("(max-width: 1080px)").matches) {
    document.getElementById("eventDetail").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function handleUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      const records = Array.isArray(parsed) ? parsed : (parsed.records || parsed.rows || []);
      if (!Array.isArray(records) || records.length === 0) throw new Error("没有找到记录数组");
      allRecords = records.map(normalizeRecord);
      selectedId = "";
      els.datasetStatus.textContent = file.name;
      populateFilters();
      applyFilters();
    } catch (error) {
      alert(`导入失败：${error.message}`);
    }
  };
  reader.readAsText(file, "utf-8");
}

function resetFilters() {
  els.globalSearch.value = "";
  els.datePreset.value = "all";
  els.yearFilter.value = "";
  els.quarterFilter.value = "";
  els.startDate.value = "";
  els.endDate.value = "";
  [els.subjectType, els.region, els.industry, els.sourceClass, els.source, els.risk, els.reviewStatus, els.level].forEach((el) => el.value = "");
  els.onlyHigh.checked = false;
  els.onlyUnverified.checked = false;
  applyFilters();
}

function buildLeadLinks() {
  const query = (els.leadQuery.value || els.globalSearch.value || "融资租赁 售后回租").trim();
  const links = [
    { label: "Bing 全网", url: `https://www.bing.com/search?q=${encodeURIComponent(query)}` },
    { label: "公众号线索", url: `https://weixin.sogou.com/weixin?type=2&query=${encodeURIComponent(query)}` },
    { label: "公司官网线索", url: `https://www.bing.com/search?q=${encodeURIComponent(query + " site:*.com.cn")}` },
    { label: "交易所/公告线索", url: `https://www.bing.com/search?q=${encodeURIComponent(query + " 公告 PDF")}` }
  ];
  els.leadLinks.innerHTML = links.map((link) => `<a href="${escapeAttribute(link.url)}" target="_blank" rel="noreferrer">${escapeHtml(link.label)}</a>`).join("");
}

function exportCsv() {
  const headers = ["主体名称", "主体类型", "证券代码", "债券代码", "地区", "行业", "公告日期", "公告标题", "来源层级", "公告来源", "公告链接", "金额", "期限", "交易对手", "是否关联交易", "风险标签", "复核状态", "关注等级"];
  const rows = filteredRecords.map((item) => [
    item.subject_name, item.subject_type, item.stock_code, item.bond_code, item.region, item.industry, item.announcement_date, item.title, item.source_class, item.source, item.source_url, item.amount, item.term, item.counterparty, item.related_party, item.risk_labels.join("、"), item.review_status, item.attention_level
  ]);
  const csv = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
  const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `融资租赁业务情报_${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function normalizeRecord(item, index) {
  const record = {
    id: item.id || `import:${index}`,
    subject_name: item.subject_name || item.stock_name || item.company_name || item.主体名称 || "未命名主体",
    subject_type: item.subject_type || item.主体类型 || "待识别",
    stock_code: item.stock_code || item.证券代码 || "",
    bond_code: item.bond_code || item.债券代码 || "",
    region: item.region || item.地区 || "待补充",
    industry: item.industry || item.行业 || "待补充",
    announcement_date: item.announcement_date || item.publish_date || item.公告日期 || "",
    title: item.title || item.公告标题 || "",
    source: item.source || item.公告来源 || "",
    source_url: item.source_url || item.original_url || item.公告链接 || "#",
    pdf_url: item.pdf_url || item.PDF链接 || "",
    matched_keywords: arrayValue(item.matched_keywords || item.命中关键词),
    matched_position: item.matched_position || item.matched_fields || item.命中位置 || "",
    announcement_type: item.announcement_type || item.公告类型 || "",
    lease_role: item.lease_role || item.融资租赁角色 || "",
    amount: item.amount || item.金额 || "未披露",
    term: item.term || item.期限 || "未披露",
    counterparty: item.counterparty || item.交易对手 || "未披露",
    leased_asset: item.leased_asset || item.租赁物 || "未披露",
    related_party: item.related_party || item.是否关联交易 || "未披露",
    guarantee_or_collateral: item.guarantee_or_collateral || item.担保抵押 || item["担保/抵押"] || "未披露",
    summary: item.summary || item.摘要 || "",
    risk_labels: arrayValue(item.risk_labels || item.风险标签),
    review_status: item.review_status || item.复核状态 || "待复核",
    snippets: arrayValue(item.snippets || item.matched_snippets || item.命中片段),
    attention_level: item.attention_level || scoreLevel(item),
    notes: item.notes || item.备注 || ""
  };
  record.source_class = item.source_class || classifySource(record.source);
  record.source_reliability = item.source_reliability || reliabilityFor(record.source_class);
  return record;
}

function classifySource(source) {
  if (/巨潮|交易所|上交所|深交所|北交所|SSE|SZSE|BSE|CNINFO/i.test(source)) return "官方公告";
  if (/债券|上清所|中债|北金所|交易商协会|募集说明书/.test(source)) return "发债披露";
  if (/预警通/.test(source)) return "预警通";
  if (/官网|公司网站|投资者关系/.test(source)) return "公司官网";
  if (/公众号|微信|互联网|新闻|媒体|搜索/.test(source)) return "互联网/公众号";
  return source ? "其他来源" : "待识别来源";
}

function reliabilityFor(sourceClass) {
  return {
    "官方公告": "高",
    "发债披露": "高",
    "公司官网": "中高",
    "预警通": "中",
    "互联网/公众号": "线索",
    "其他来源": "待复核",
    "待识别来源": "待复核"
  }[sourceClass] || "待复核";
}

function scoreLevel(item) {
  const text = `${item.title || ""}${item.summary || ""}${arrayValue(item.risk_labels || item.风险标签).join("")}`;
  let score = 0;
  if (/售后回租|融资性售后回租/.test(text)) score += 2;
  if (/关联交易/.test(text) || item.related_party === "是") score += 2;
  if (/担保|抵押|质押/.test(text)) score += 2;
  if (/大额|亿元/.test(text)) score += 2;
  if (/待复核|未披露/.test(text)) score += 1;
  return score >= 5 ? "A" : score >= 3 ? "B" : "C";
}

function searchBlob(item) {
  return [
    item.subject_name, item.stock_code, item.bond_code, item.title, item.counterparty, item.summary,
    item.region, item.industry, item.source, item.source_class, item.risk_labels.join(" "), item.snippets.join(" ")
  ].join(" ").toLowerCase();
}

function quarterOf(dateText) {
  const month = Number(dateText.slice(5, 7));
  if (!month) return "";
  return `Q${Math.ceil(month / 3)}`;
}

function countBy(records, key) {
  return records.reduce((acc, item) => {
    const value = item[key] || "待补充";
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function profileCoverage(records) {
  if (!records.length) return 0;
  const filled = records.filter((item) => item.region !== "待补充" || item.industry !== "待补充").length;
  return Math.round((filled / records.length) * 100);
}

function dateRangeText(records) {
  if (!records.length) return "--";
  const dates = records.map((item) => item.announcement_date).filter(Boolean).sort();
  return `${dates[0]} 至 ${dates[dates.length - 1]}`;
}

function maxRecordDate() {
  return allRecords.reduce((max, item) => item.announcement_date > max ? item.announcement_date : max, "1900-01-01");
}

function dateDiff(start, end) {
  return Math.round((new Date(`${end}T00:00:00`) - new Date(`${start}T00:00:00`)) / 86400000);
}

function isPending(item) {
  return /待|不可打开|仅|线索/.test(item.review_status + item.source_reliability);
}

function sourceBadge(item) {
  const klass = item.source_class === "官方公告" || item.source_class === "发债披露" ? "info" : item.source_class === "互联网/公众号" ? "warn" : "source";
  return `<span class="tag ${klass}">${escapeHtml(item.source_class)}</span>`;
}

function judgementText(item) {
  const eventType = item.announcement_type || (item.title.includes("售后回租") ? "售后回租" : "融资租赁相关事项");
  const subject = item.subject_name || "该主体";
  const role = item.lease_role && item.lease_role !== "未披露" ? `，角色为${item.lease_role}` : "";
  const amount = item.amount && item.amount !== "未披露" ? `，金额${item.amount}` : "，金额未披露";
  const counterparty = item.counterparty && item.counterparty !== "未披露" ? `，交易对手为${item.counterparty}` : "，交易对手未披露";
  const source = item.source_class ? `，来源为${item.source_class}` : "";
  return `${subject}涉及${eventType}${role}${amount}${counterparty}${source}。`;
}

function hitReason(item) {
  const keywords = item.matched_keywords.length ? item.matched_keywords.join("、") : "融资租赁相关词";
  const position = item.matched_position || "标题/正文";
  return `命中：${keywords}；位置：${position}`;
}

function completenessInfo(item) {
  const fields = [
    { label: "金额", value: item.amount },
    { label: "期限", value: item.term },
    { label: "交易对手", value: item.counterparty },
    { label: "租赁物", value: item.leased_asset },
    { label: "角色", value: item.lease_role },
    { label: "担保/抵押", value: item.guarantee_or_collateral },
    { label: "关联交易", value: item.related_party }
  ].map((field) => ({ ...field, ok: isDisclosed(field.value) }));
  const filled = fields.filter((field) => field.ok).length;
  return {
    fields,
    filled,
    total: fields.length,
    percent: Math.round((filled / fields.length) * 100)
  };
}

function isDisclosed(value) {
  return Boolean(value) && !/未披露|待补充|待识别|暂无/.test(String(value));
}

function nextActionText(item, completeness) {
  if (item.source_reliability === "线索" || item.source_reliability === "待复核") return "建议先复核公告原文或公司官网，再进入正式跟进清单。";
  if (completeness.percent < 60) return "建议优先补齐金额、期限、交易对手、租赁物等关键字段。";
  if (item.attention_level === "A") return "建议列为重点跟进，核验是否存在连续融资、关联担保或短期偿债压力。";
  return "可作为已识别事项留痕，必要时结合主体历史记录继续跟踪。";
}

function levelClass(level) {
  return level === "A" ? "high" : level === "B" ? "warn" : "ok";
}

function externalLinksFor(item) {
  const query = `${item.subject_name} ${item.title.includes("售后回租") ? "售后回租" : "融资租赁"}`;
  return [
    { label: "Bing", url: `https://www.bing.com/search?q=${encodeURIComponent(query)}` },
    { label: "公众号", url: `https://weixin.sogou.com/weixin?type=2&query=${encodeURIComponent(query)}` },
    { label: "官网线索", url: `https://www.bing.com/search?q=${encodeURIComponent(query + " 官网 公告")}` }
  ];
}

function eventHref(id) {
  return `#event=${encodeURIComponent(id)}`;
}

function restoreSelectionFromLocation() {
  if (!location.hash.startsWith("#event=")) return;
  const id = decodeURIComponent(location.hash.slice(7));
  if (allRecords.some((item) => item.id === id)) selectRecord(id, false);
}

function highlightKeywords(value, keywords) {
  let html = escapeHtml(value);
  [...keywords].sort((a, b) => b.length - a.length).forEach((keyword) => {
    const safeKeyword = escapeHtml(keyword);
    const pattern = safeKeyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    html = html.replace(new RegExp(pattern, "g"), `<mark>${safeKeyword}</mark>`);
  });
  return html;
}

function formatDateTime(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), "zh-CN"));
}

function arrayValue(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (!value) return [];
  return String(value).split(/[、,，;；\n]/).map((item) => item.trim()).filter(Boolean);
}

function clearDetail() {
  selectedId = "";
  els.detailLevel.textContent = "未选择";
  els.detailLevel.className = "level-badge";
  els.detailContent.className = "detail-empty";
  els.detailContent.innerHTML = "<strong>选择一条事件开始复核</strong><p>公告原文、命中片段、业务要素和研判建议会在这里集中显示。</p>";
  if (location.hash.startsWith("#event=")) history.replaceState(null, "", `${location.pathname}${location.search}`);
}

function setText(id, value) {
  document.getElementById(id).textContent = value;
}

function shorten(value, length) {
  const text = String(value || "");
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function escapeAttribute(value) {
  const text = String(value || "#");
  return /^https?:\/\//.test(text) || text === "#" ? escapeHtml(text) : "#";
}
