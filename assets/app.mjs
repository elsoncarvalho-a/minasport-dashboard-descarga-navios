import {
  REQUIRED_SHEETS,
  calculateDashboard,
  formatDate,
  formatDuration,
  formatPercent,
  formatRate,
  formatTons,
  listOperations,
  operationCatalog,
  periodLabel,
  preferredOperation,
} from "./dashboard-core.mjs?v=9";

const DEFAULT_WORKBOOK = "./data/Torre_Controle_Produtividade_Descarga_Navios.xlsx";
const CACHE_DATABASE = "minasport-dashboard-cache";
const CACHE_STORE = "workbooks";
const CACHE_KEY = "last-uploaded-workbook";
const state = {
  rowsBySheet: null,
  operations: [],
  catalog: [],
  selectedOperation: "",
  fileName: "",
  source: "",
  currentData: null,
};

const elements = {
  app: document.querySelector(".dashboard-app"),
  fileInput: document.getElementById("file-input"),
  vesselSelect: document.getElementById("vessel-select"),
  operationSelect: document.getElementById("operation-select"),
  restoreButton: document.getElementById("restore-button"),
  pdfButton: document.getElementById("pdf-button"),
  sourceLine: document.getElementById("source-line"),
  dataState: document.getElementById("data-state"),
  errorBox: document.getElementById("error-box"),
  toast: document.getElementById("toast"),
  holds: document.getElementById("holds-list"),
  shifts: document.getElementById("shifts-list"),
  stops: document.getElementById("stops-list"),
  secondaryKpis: document.getElementById("secondary-kpis"),
  profile: document.getElementById("operation-profile"),
  dailyChart: document.getElementById("daily-chart"),
  flowLegend: document.getElementById("flow-legend"),
};

const decimal = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const timestamp = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });

function openWorkbookCache() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      resolve(null);
      return;
    }
    const request = window.indexedDB.open(CACHE_DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(CACHE_STORE)) {
        request.result.createObjectStore(CACHE_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Não foi possível abrir o armazenamento local."));
    request.onblocked = () => reject(new Error("O armazenamento local está bloqueado por outra aba."));
  });
}

async function saveCachedWorkbook(buffer, fileName) {
  const database = await openWorkbookCache();
  if (!database) return null;
  const savedAt = Date.now();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(CACHE_STORE, "readwrite");
    transaction.objectStore(CACHE_STORE).put({
      id: CACHE_KEY,
      fileName,
      savedAt,
      buffer,
    });
    transaction.oncomplete = () => {
      database.close();
      resolve(savedAt);
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error || new Error("Não foi possível salvar a planilha neste navegador."));
    };
    transaction.onabort = transaction.onerror;
  });
}

async function readCachedWorkbook() {
  const database = await openWorkbookCache();
  if (!database) return null;
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(CACHE_STORE, "readonly");
    const request = transaction.objectStore(CACHE_STORE).get(CACHE_KEY);
    request.onsuccess = () => {
      database.close();
      resolve(request.result || null);
    };
    request.onerror = () => {
      database.close();
      reject(request.error || new Error("Não foi possível recuperar a planilha salva."));
    };
  });
}

async function clearCachedWorkbook() {
  const database = await openWorkbookCache();
  if (!database) return;
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(CACHE_STORE, "readwrite");
    transaction.objectStore(CACHE_STORE).delete(CACHE_KEY);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error || new Error("Não foi possível remover a planilha salva."));
    };
    transaction.onabort = transaction.onerror;
  });
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function setTone(id, tone) {
  const element = document.getElementById(id);
  if (element) element.dataset.tone = tone;
}

function toneForRatio(ratio, warningThreshold = 0.9) {
  if (ratio >= 1) return "positive";
  if (ratio >= warningThreshold) return "warning";
  return "negative";
}

function comparisonText(ratio, targetLabel) {
  const direction = ratio >= 1 ? "ACIMA" : "ABAIXO";
  return `${formatPercent(ratio)} ${targetLabel} | ${direction}`;
}

function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function renderHolds(data) {
  elements.holds.replaceChildren();
  if (!data.holds.length) {
    elements.holds.append(el("p", "empty-state", "Nenhum porão operado para esta operação."));
    return;
  }

  data.holds.forEach((hold) => {
    const row = el("div", "hold-row");
    const label = el("strong", "hold-label", `Porão ${hold.hold}`);
    const track = el("div", "progress-track");
    const fill = el("div", "progress-fill");
    const progressPercent = hold.progress * 100;
    fill.style.width = `${Math.min(Math.max(progressPercent, 0), 100)}%`;
    if (hold.progress >= 1) fill.classList.add("is-over");
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-label", `Progresso do porão ${hold.hold}`);
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", "100");
    track.setAttribute("aria-valuenow", String(Math.round(progressPercent)));
    track.append(fill);

    const volume = el("strong", "hold-volume", `${formatTons(hold.volume).replace(" t", "")} / ${formatTons(hold.manifested)}`);
    const stats = el("div", "hold-stats");
    stats.append(
      el("strong", "hold-percent", formatPercent(hold.progress)),
      el("span", "hold-productivity", formatRate(hold.productivity)),
    );
    row.append(label, track, volume, stats);
    elements.holds.append(row);
  });
}

function renderShifts(data) {
  elements.shifts.replaceChildren();
  if (!data.shifts.length) {
    elements.shifts.append(el("p", "empty-state", "Nenhum turno registrado."));
    return;
  }
  const maxVolume = Math.max(...data.shifts.map((shift) => shift.volume), 1);
  data.shifts.forEach((shift) => {
    const item = el("div", "shift-item");
    const label = el("strong", "shift-label", shift.shift);
    const chart = el("div", "shift-chart");
    const bar = el("div", "shift-bar");
    bar.style.height = `${Math.max((shift.volume / maxVolume) * 100, 8)}%`;
    chart.append(bar);
    item.append(
      label,
      chart,
      el("strong", "shift-volume", formatTons(shift.volume)),
      el("span", "shift-productivity", formatRate(shift.productivity)),
    );
    elements.shifts.append(item);
  });
}

function renderStops(data) {
  elements.stops.replaceChildren();
  if (!data.stops.length) {
    elements.stops.append(el("p", "empty-state", "Nenhuma parada detalhada registrada."));
    return;
  }
  const visibleStops = data.stops.slice(0, 5);
  const maxHours = Math.max(...visibleStops.map((stop) => stop.hours), 1);
  visibleStops.forEach((stop, index) => {
    const row = el("div", "stop-row");
    const label = el("strong", "stop-label", stop.category);
    const track = el("div", "stop-track");
    const fill = el("div", "stop-fill");
    fill.style.width = `${Math.max((stop.hours / maxHours) * 100, 4)}%`;
    fill.dataset.rank = String(index + 1);
    track.append(fill);
    const duration = el("strong", "stop-duration", formatDuration(stop.hours));
    row.append(label, track, duration);
    elements.stops.append(row);
  });
}

function renderProfile(data) {
  const fields = [
    ["Operação", data.operationId],
    ["Navio", data.shipName],
    ["IMO", data.imo || "—"],
    ["Bandeira", data.flag || "—"],
    ["Terminal / berço", [data.terminal, data.berth].filter(Boolean).join(" / ") || "—"],
    ["Produto", data.product || "—"],
    ["Cliente", data.client || "—"],
    ["Tipo de operação", data.operationType || "—"],
    ["ETB", formatDate(data.etbDate)],
    ["ETS", formatDate(data.etsDate)],
  ];
  elements.profile.replaceChildren();
  fields.forEach(([label, content]) => {
    const wrapper = el("div", "profile-item");
    wrapper.append(el("dt", "", label), el("dd", "", content));
    elements.profile.append(wrapper);
  });
}

function renderSecondaryKpis(data) {
  const longestPause = data.longestPause
    ? `${formatDuration(data.longestPause.hours)} · ${data.longestPause.reason}`
    : "Sem registro";
  const metrics = [
    ["Volume manifestado", formatTons(data.manifested), "Referência cadastrada"],
    ["Saldo vs. manifesto", `${data.difference >= 0 ? "+" : "−"}${formatTons(Math.abs(data.difference))}`, formatPercent(data.adherence)],
    ["Tempo total da operação", formatDuration(data.calendarHours), `${decimal.format(data.operationDays)} dias equivalentes`],
    ["Total de paradas", formatDuration(data.stoppedHours), formatPercent(data.stoppageRate)],
    ["Eventos de parada", String(data.pauseCount), `Média de ${formatDuration(data.averagePause)}`],
    ["Maior parada", longestPause, data.longestPause?.category || "—"],
    ["Paradas por 1.000 t", `${decimal.format(data.stopHoursPerThousandTons)} h`, "Intensidade de perda"],
    ["Porões operados", String(data.operatedHoldCount), `Média de ${formatDuration(data.averageHoldHours)} por porão`],
    ["Volume direto", formatTons(data.volumeDireto), `${formatPercent(data.directShare)} do total`],
    ["Produtividade direta", formatRate(data.directProductivity), "Linhas com volume direto"],
    ["Volume via terminal", formatTons(data.volumeTerminal), `${formatPercent(data.terminalShare)} do total`],
    ["Produtividade terminal", formatRate(data.terminalProductivity), "Linhas com volume terminal"],
    ["Meta de produtividade", formatRate(data.targetProductivity), `Realizado: ${formatPercent(data.productivityAchievement)}`],
    ["Meta de descarga diária", formatRate(data.targetDaily, "t/dia"), `Realizado: ${formatPercent(data.dailyAchievement)}`],
    ["Melhor turno", data.bestShift ? `Turno ${data.bestShift.shift}` : "—", data.bestShift ? formatRate(data.bestShift.productivity) : "Sem dados"],
    ["Turno de menor TPH", data.worstShift ? `Turno ${data.worstShift.shift}` : "—", data.worstShift ? formatRate(data.worstShift.productivity) : "Sem dados"],
    ["Melhor porão", data.bestHold ? `Porão ${data.bestHold.hold}` : "—", data.bestHold ? formatRate(data.bestHold.productivity) : "Sem dados"],
    ["Porão de menor TPH", data.worstHold ? `Porão ${data.worstHold.hold}` : "—", data.worstHold ? formatRate(data.worstHold.productivity) : "Sem dados"],
  ];
  elements.secondaryKpis.replaceChildren();
  metrics.forEach(([label, metricValue, detail]) => {
    const card = el("article", "secondary-kpi pdf-keep");
    card.append(el("p", "", label), el("strong", "", metricValue), el("span", "", detail));
    elements.secondaryKpis.append(card);
  });
}

function renderFlow(data) {
  const terminalPercent = Math.max(0, Math.min(data.terminalShare * 100, 100));
  const donut = document.getElementById("flow-donut");
  donut.style.setProperty("--terminal-share", `${terminalPercent}%`);
  donut.setAttribute(
    "aria-label",
    `Volume via terminal ${formatPercent(data.terminalShare)}; volume direto ${formatPercent(data.directShare)}.`,
  );
  setText("flow-total", formatTons(data.volume));
  elements.flowLegend.replaceChildren();
  [
    ["Direto", data.volumeDireto, data.directShare, "direct"],
    ["Terminal", data.volumeTerminal, data.terminalShare, "terminal"],
  ].forEach(([label, flowVolume, share, style]) => {
    const row = el("div", "flow-legend-row");
    const swatch = el("span", `flow-swatch ${style}`);
    swatch.setAttribute("aria-hidden", "true");
    const copy = el("div", "");
    copy.append(el("strong", "", label), el("span", "", `${formatTons(flowVolume)} · ${formatPercent(share)}`));
    row.append(swatch, copy);
    elements.flowLegend.append(row);
  });
}

function renderDaily(data) {
  elements.dailyChart.replaceChildren();
  if (!data.daily.length) {
    elements.dailyChart.append(el("p", "empty-state", "Nenhuma data operacional registrada."));
    return;
  }
  const maxVolume = Math.max(...data.daily.map((day) => day.volume), 1);
  data.daily.forEach((day) => {
    const item = el("div", "daily-item");
    const chart = el("div", "daily-bar-area");
    const volumeBar = el("div", "daily-volume-bar");
    volumeBar.style.height = `${Math.max((day.volume / maxVolume) * 100, 5)}%`;
    const efficiencyMarker = el("span", "daily-efficiency-marker", formatPercent(day.efficiency));
    chart.append(volumeBar, efficiencyMarker);
    item.append(
      chart,
      el("strong", "daily-date", day.date ? formatDate(day.date).slice(0, 5) : day.key),
      el("span", "daily-volume", formatTons(day.volume)),
      el("span", "daily-tph", formatRate(day.productivity)),
    );
    elements.dailyChart.append(item);
  });
}

function renderTable(tableId, headers, rows) {
  const table = document.getElementById(tableId);
  table.replaceChildren();
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  headers.forEach((header) => headerRow.append(el("th", "", header)));
  thead.append(headerRow);
  const tbody = document.createElement("tbody");
  if (!rows.length) {
    const row = document.createElement("tr");
    const cell = el("td", "empty-cell", "Sem dados para esta operação.");
    cell.colSpan = headers.length;
    row.append(cell);
    tbody.append(row);
  } else {
    rows.forEach((values) => {
      const row = document.createElement("tr");
      values.forEach((cellValue, index) => row.append(el("td", index ? "numeric" : "", cellValue)));
      tbody.append(row);
    });
  }
  table.append(thead, tbody);
}

function renderTables(data) {
  renderTable(
    "holds-table",
    ["Porão", "Manifestado", "Descarregado", "Saldo", "Aderência", "Horas", "TPH"],
    data.holds.map((hold) => [
      `Porão ${hold.hold}`,
      formatTons(hold.manifested),
      formatTons(hold.volume),
      `${hold.manifested - hold.volume >= 0 ? "" : "−"}${formatTons(Math.abs(hold.manifested - hold.volume))}`,
      formatPercent(hold.progress),
      formatDuration(hold.workedHours),
      formatRate(hold.productivity),
    ]),
  );
  renderTable(
    "shifts-table",
    ["Turno", "Volume", "Participação", "Trabalhado", "Paradas", "Eficiência", "TPH"],
    data.shifts.map((shift) => [
      `Turno ${shift.shift}`,
      formatTons(shift.volume),
      formatPercent(shift.volumeShare),
      formatDuration(shift.workedHours),
      formatDuration(shift.stoppedHours),
      formatPercent(shift.efficiency),
      formatRate(shift.productivity),
    ]),
  );
  renderTable(
    "stops-table",
    ["Categoria", "Eventos", "Horas", "Participação", "Média/evento"],
    data.stops.map((stop) => [
      stop.category,
      String(stop.count),
      formatDuration(stop.hours),
      formatPercent(stop.share),
      formatDuration(stop.hours / stop.count),
    ]),
  );
  renderTable(
    "reasons-table",
    ["Motivo", "Eventos", "Horas", "Participação"],
    data.reasons.slice(0, 12).map((reason) => [
      reason.reason,
      String(reason.count),
      formatDuration(reason.hours),
      formatPercent(reason.share),
    ]),
  );
}

function renderAnalytics(data) {
  renderProfile(data);
  renderSecondaryKpis(data);
  renderFlow(data);
  renderDaily(data);
  renderTables(data);
}

function render(data) {
  state.currentData = data;
  setText("eyebrow", "TORRE DE CONTROLE | DESCARGA DE NAVIOS");
  setText("hero-title", `${data.shipName} | ${data.concluded ? "fechamento final da descarga" : "resultado parcial da descarga"}`);
  setText("hero-meta", [
    data.operationId,
    [data.terminal, data.berth].filter(Boolean).join(" / "),
    data.product,
    data.client ? `Cliente: ${data.client}` : "",
  ].filter(Boolean).join(" · "));
  setText("status-text", `STATUS: ${data.status}`);
  setTone("status-badge", data.concluded ? "positive" : "warning");

  setText("kpi-volume", formatTons(data.volume));
  setText("kpi-volume-detail", comparisonText(data.adherence, "DO TARGET"));
  setTone("kpi-volume-detail", toneForRatio(data.adherence));

  setText("kpi-closing", data.closingLabel);
  const differencePrefix = data.difference >= 0 ? "+" : "−";
  setText("kpi-closing-detail", `DIFERENÇA: ${differencePrefix}${formatTons(Math.abs(data.difference))}`);
  setTone("kpi-closing-detail", data.concluded ? "positive" : "warning");

  setText("kpi-productivity", formatRate(data.productivity));
  setText("kpi-productivity-detail", comparisonText(data.productivityAchievement, "DA META"));
  setTone("kpi-productivity-detail", toneForRatio(data.productivityAchievement));

  setText("kpi-daily", formatRate(data.dailyRate, "t/dia"));
  setText("kpi-daily-detail", comparisonText(data.dailyAchievement, "DA META"));
  setTone("kpi-daily-detail", toneForRatio(data.dailyAchievement, 0.75));

  setText("kpi-worked", formatDuration(data.workedHours));
  setText("kpi-window", `JANELA TOTAL: ${formatDuration(data.calendarHours)}`);
  setText("kpi-worked-detail", comparisonText(data.efficiency, "DA JANELA"));
  setTone("kpi-worked-detail", toneForRatio(data.efficiency, 0.85));

  setText("kpi-efficiency", formatPercent(data.efficiency));
  setText("kpi-efficiency-detail", comparisonText(data.efficiency, "DO IDEAL"));
  setTone("kpi-efficiency-detail", toneForRatio(data.efficiency, 0.85));

  renderHolds(data);
  renderShifts(data);
  renderStops(data);
  renderAnalytics(data);
  setText("executive-reading", data.executiveReading);
  setText("period-line", `Período operacional: ${periodLabel(data.startDate, data.endDate)}`);
  setText("record-line", `${data.rowCounts.base} lançamentos operacionais · ${data.rowCounts.stops} registros de parada`);
  setText("footer-date", `Último dia da operação: ${formatDate(data.endDate)}`);
}

async function exportPdf() {
  if (!state.currentData) {
    showError("Aguarde o carregamento dos indicadores antes de gerar o PDF.");
    return;
  }
  if (!window.html2canvas || !window.jspdf?.jsPDF) {
    window.print();
    return;
  }
  const originalMarkup = elements.pdfButton.innerHTML;
  elements.pdfButton.disabled = true;
  elements.pdfButton.textContent = "Gerando PDF…";
  document.body.classList.add("pdf-export");
  try {
    const filename = `Dashboard_${state.selectedOperation}_${state.currentData.shipName.replace(/[^a-z0-9]+/gi, "_")}.pdf`;
    const report = document.getElementById("pdf-report");
    await document.fonts.ready;
    await Promise.all(
      [...report.querySelectorAll("img")].map((img) =>
        img.complete
          ? Promise.resolve()
          : new Promise((resolve) => {
              img.addEventListener("load", resolve, { once: true });
              img.addEventListener("error", resolve, { once: true });
            }),
      ),
    );

    const analytics = report.querySelector(".analytics-section");
    const tables = analytics.querySelector(".tables-grid");
    const reportRect = report.getBoundingClientRect();
    const sectionOffsets = [
      0,
      analytics.getBoundingClientRect().top - reportRect.top + 32,
      tables.getBoundingClientRect().top - reportRect.top + 140,
      report.scrollHeight,
    ];
    const fullCanvas = await window.html2canvas(report, {
      scale: 1,
      backgroundColor: "#020904",
      useCORS: true,
      logging: false,
      width: report.scrollWidth,
      height: report.scrollHeight,
      windowWidth: 2100,
      scrollX: 0,
      scrollY: 0,
    });
    const scaleY = 1;
    const canvasBreaks = sectionOffsets.map((offset, index) =>
      index === sectionOffsets.length - 1
        ? fullCanvas.height
        : Math.max(0, Math.min(fullCanvas.height, Math.round(offset * scaleY))),
    );
    const canvases = canvasBreaks.slice(0, -1).map((start, index) => {
      const end = canvasBreaks[index + 1];
      const pageCanvas = document.createElement("canvas");
      pageCanvas.width = fullCanvas.width;
      pageCanvas.height = Math.max(1, end - start);
      const context = pageCanvas.getContext("2d", { alpha: false });
      context.fillStyle = "#020904";
      context.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
      context.drawImage(
        fullCanvas,
        0,
        start,
        fullCanvas.width,
        pageCanvas.height,
        0,
        0,
        fullCanvas.width,
        pageCanvas.height,
      );
      return pageCanvas;
    });
    const pdf = new window.jspdf.jsPDF({
      unit: "mm",
      format: "a3",
      orientation: "landscape",
      compress: true,
    });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const marginX = 6;
    const marginY = 6;
    const usableWidth = pageWidth - marginX * 2;
    const usableHeight = pageHeight - marginY * 2;
    canvases.forEach((canvas, pageIndex) => {
      if (pageIndex > 0) pdf.addPage();
      pdf.setFillColor(2, 9, 4);
      pdf.rect(0, 0, pageWidth, pageHeight, "F");
      const scale = Math.min(usableWidth / canvas.width, usableHeight / canvas.height);
      const renderedWidth = canvas.width * scale;
      const renderedHeight = canvas.height * scale;
      const offsetX = (pageWidth - renderedWidth) / 2;
      pdf.addImage(
        canvas.toDataURL("image/jpeg", 0.94),
        "JPEG",
        offsetX,
        marginY,
        renderedWidth,
        renderedHeight,
        undefined,
        "FAST",
      );
    });

    pdf.save(filename);
    showToast("PDF gerado com os indicadores da operação selecionada.");
  } catch (error) {
    showError(`Não foi possível gerar o PDF: ${error.message}`);
  } finally {
    document.body.classList.remove("pdf-export");
    elements.pdfButton.disabled = false;
    elements.pdfButton.innerHTML = originalMarkup;
  }
}

function renderSelectedOperation() {
  if (!state.rowsBySheet || !state.selectedOperation) return;
  try {
    const data = calculateDashboard(state.rowsBySheet, state.selectedOperation);
    render(data);
    clearError();
  } catch (error) {
    showError(error.message);
  }
}

function populateOperationsForVessel(vesselName, preferred) {
  const availableOperations = state.catalog
    .filter((item) => item.shipName === vesselName)
    .map((item) => item.operationId);
  elements.operationSelect.replaceChildren();
  availableOperations.forEach((operation) => {
    const option = document.createElement("option");
    option.value = operation;
    option.textContent = operation;
    elements.operationSelect.append(option);
  });
  state.selectedOperation = availableOperations.includes(preferred) ? preferred : availableOperations.at(-1);
  elements.operationSelect.value = state.selectedOperation;
  elements.operationSelect.disabled = availableOperations.length < 2;
}

function populateSelectors(preferred) {
  const vesselNames = [...new Set(state.catalog.map((item) => item.shipName))]
    .sort((left, right) => left.localeCompare(right, "pt-BR"));
  elements.vesselSelect.replaceChildren();
  vesselNames.forEach((shipName) => {
    const option = document.createElement("option");
    option.value = shipName;
    option.textContent = shipName;
    elements.vesselSelect.append(option);
  });
  const preferredVessel = state.catalog.find((item) => item.operationId === preferred)?.shipName || vesselNames[0];
  elements.vesselSelect.value = preferredVessel;
  elements.vesselSelect.disabled = vesselNames.length < 2;
  populateOperationsForVessel(preferredVessel, preferred);
}

function rowsFromWorkbook(workbook) {
  const missing = REQUIRED_SHEETS.filter((name) => !workbook.Sheets[name]);
  if (missing.length) {
    throw new Error(`Planilha incompatível. Abas obrigatórias ausentes: ${missing.join(", ")}.`);
  }
  const rowsBySheet = {};
  workbook.SheetNames.forEach((name) => {
    rowsBySheet[name] = window.XLSX.utils.sheet_to_json(workbook.Sheets[name], {
      header: 1,
      raw: true,
      defval: null,
      blankrows: false,
    });
  });
  return rowsBySheet;
}

async function loadBuffer(buffer, fileName, source, updatedAt = Date.now()) {
  if (!window.XLSX) throw new Error("O leitor de Excel não foi carregado.");
  setLoading(true, "Processando a planilha…");
  try {
    const workbook = window.XLSX.read(buffer, { type: "array", cellDates: false });
    const rowsBySheet = rowsFromWorkbook(workbook);
    const operations = listOperations(rowsBySheet);
    if (!operations.length) throw new Error("Nenhuma operação foi encontrada na planilha.");
    state.rowsBySheet = rowsBySheet;
    state.operations = operations;
    state.catalog = operationCatalog(rowsBySheet);
    state.fileName = fileName;
    state.source = source;
    populateSelectors(preferredOperation(rowsBySheet, operations));
    renderSelectedOperation();
    elements.sourceLine.textContent = `${source}: ${fileName}`;
    elements.dataState.textContent = `Atualizado em ${timestamp.format(new Date(updatedAt))}`;
    elements.restoreButton.hidden = source === "Base do repositório";
    showToast("Indicadores atualizados com sucesso.");
  } finally {
    setLoading(false);
  }
}

async function loadDefaultWorkbook() {
  setLoading(true, "Carregando a base do repositório…");
  try {
    const response = await fetch(`${DEFAULT_WORKBOOK}?v=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Não foi possível carregar a base padrão (${response.status}).`);
    await loadBuffer(await response.arrayBuffer(), "Torre_Controle_Produtividade_Descarga_Navios.xlsx", "Base do repositório");
  } catch (error) {
    showError(`${error.message} Use “Atualizar dados” para selecionar a planilha manualmente.`);
  } finally {
    setLoading(false);
  }
}

async function loadInitialWorkbook() {
  try {
    const cachedWorkbook = await readCachedWorkbook();
    if (cachedWorkbook?.buffer) {
      await loadBuffer(
        cachedWorkbook.buffer,
        cachedWorkbook.fileName || "Planilha salva.xlsx",
        "Base salva neste navegador",
        cachedWorkbook.savedAt,
      );
      showToast("Última planilha salva restaurada automaticamente.");
      return;
    }
  } catch (error) {
    try {
      await clearCachedWorkbook();
    } catch {
      // A base do repositório ainda pode ser utilizada mesmo sem armazenamento local.
    }
  }
  await loadDefaultWorkbook();
}

async function restoreDefaultWorkbook() {
  try {
    await clearCachedWorkbook();
    await loadDefaultWorkbook();
    showToast("Cópia local removida. Base do repositório restaurada.");
  } catch (error) {
    showError(error.message);
  }
}

function setLoading(isLoading, message = "") {
  elements.app.setAttribute("aria-busy", String(isLoading));
  document.body.classList.toggle("is-loading", isLoading);
  if (message) elements.dataState.textContent = message;
}

function showError(message) {
  elements.errorBox.hidden = false;
  elements.errorBox.textContent = message;
}

function clearError() {
  elements.errorBox.hidden = true;
  elements.errorBox.textContent = "";
}

let toastTimer;
function showToast(message) {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("is-visible");
  toastTimer = window.setTimeout(() => elements.toast.classList.remove("is-visible"), 3200);
}

elements.operationSelect.addEventListener("change", (event) => {
  state.selectedOperation = event.target.value;
  renderSelectedOperation();
});

elements.vesselSelect.addEventListener("change", (event) => {
  populateOperationsForVessel(event.target.value);
  renderSelectedOperation();
});

elements.fileInput.addEventListener("change", async (event) => {
  const [file] = event.target.files;
  if (!file) return;
  try {
    const buffer = await file.arrayBuffer();
    await loadBuffer(buffer, file.name, "Arquivo local");
    const savedAt = await saveCachedWorkbook(buffer, file.name);
    if (savedAt) {
      state.source = "Base salva neste navegador";
      elements.sourceLine.textContent = `${state.source}: ${file.name}`;
      elements.dataState.textContent = `Atualizado em ${timestamp.format(new Date(savedAt))}`;
      elements.restoreButton.hidden = false;
      showToast("Planilha atualizada e salva neste navegador.");
    } else {
      showToast("Planilha atualizada apenas nesta sessão; o navegador não oferece armazenamento local.");
    }
  } catch (error) {
    showError(error.message);
  } finally {
    event.target.value = "";
  }
});

elements.restoreButton.addEventListener("click", restoreDefaultWorkbook);
elements.pdfButton.addEventListener("click", exportPdf);

window.addEventListener("error", (event) => {
  if (!elements.errorBox.hidden) return;
  showError(`Falha inesperada ao montar o painel: ${event.message}`);
});

loadInitialWorkbook();
