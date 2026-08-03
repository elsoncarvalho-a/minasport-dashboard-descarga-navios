const SHEETS = {
  cadastro: "Cadastro_Navio",
  base: "Base_Porao_Turno",
  paradas: "Paradas_Detalhadas",
  poroes: "Poroes_Resumo",
  kpis: "KPI_Resumo",
};

export const REQUIRED_SHEETS = [
  SHEETS.cadastro,
  SHEETS.base,
  SHEETS.paradas,
  SHEETS.poroes,
];

function normalize(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function records(rows = []) {
  if (!rows.length) return [];
  const headers = rows[0].map(normalize);
  return rows.slice(1).map((row, index) => {
    const record = { __row: index + 2 };
    headers.forEach((header, column) => {
      if (header) record[header] = row?.[column] ?? null;
    });
    return record;
  });
}

function value(record, ...aliases) {
  for (const alias of aliases) {
    const key = normalize(alias);
    if (Object.prototype.hasOwnProperty.call(record, key)) return record[key];
  }
  return null;
}

function text(valueToRead) {
  return valueToRead === null || valueToRead === undefined ? "" : String(valueToRead).trim();
}

function number(valueToRead) {
  if (typeof valueToRead === "number" && Number.isFinite(valueToRead)) return valueToRead;
  if (valueToRead === null || valueToRead === undefined || valueToRead === "") return 0;
  const normalized = String(valueToRead).trim().replace(/\s/g, "").replace(/\.(?=\d{3}(?:\D|$))/g, "").replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function hasValue(valueToRead) {
  return valueToRead !== null && valueToRead !== undefined && valueToRead !== "";
}

function divide(numerator, denominator) {
  return denominator ? numerator / denominator : 0;
}

function operationId(record) {
  return text(value(record, "Operacao ID", "Operação ID"));
}

function holdId(record) {
  return text(value(record, "Porao", "Porão"));
}

function rowKey(record) {
  const date = value(record, "Data");
  const normalizedDate = date instanceof Date ? date.toISOString().slice(0, 10) : text(date);
  return [normalizedDate, text(value(record, "Turno")), holdId(record)].join("|");
}

function pauseHours(record) {
  const explicit = value(record, "Horas Paradas");
  if (hasValue(explicit)) return Math.max(number(explicit), 0);
  const start = value(record, "Inicio", "Início");
  const end = value(record, "Fim");
  if (!hasValue(start) || !hasValue(end)) return 0;
  const delta = ((number(end) - number(start)) % 1 + 1) % 1;
  return delta * 24;
}

function addToMap(map, key, amount) {
  map.set(key, (map.get(key) || 0) + amount);
}

function excelDate(valueToRead) {
  if (valueToRead instanceof Date && !Number.isNaN(valueToRead.getTime())) return valueToRead;
  if (typeof valueToRead !== "number" || !Number.isFinite(valueToRead) || valueToRead <= 0) return null;
  const date = new Date(Date.UTC(1899, 11, 30));
  date.setUTCDate(date.getUTCDate() + Math.floor(valueToRead));
  return date;
}

export function listOperations(rowsBySheet) {
  const ids = new Set();
  records(rowsBySheet[SHEETS.cadastro]).forEach((record) => {
    if (operationId(record)) ids.add(operationId(record));
  });
  records(rowsBySheet[SHEETS.base]).forEach((record) => {
    if (operationId(record)) ids.add(operationId(record));
  });
  return [...ids].sort((left, right) => left.localeCompare(right, "pt-BR", { numeric: true }));
}

export function operationCatalog(rowsBySheet) {
  const cadastro = records(rowsBySheet[SHEETS.cadastro]);
  const namesByOperation = new Map();
  cadastro.forEach((record) => {
    const id = operationId(record);
    if (id) namesByOperation.set(id, text(value(record, "Navio")) || "Navio não informado");
  });
  return listOperations(rowsBySheet).map((id) => ({
    operationId: id,
    shipName: namesByOperation.get(id) || "Navio não informado",
  }));
}

export function preferredOperation(rowsBySheet, operations) {
  const kpiRows = rowsBySheet[SHEETS.kpis] || [];
  const selected = text(kpiRows?.[1]?.[1]);
  if (operations.includes(selected)) return selected;
  return operations.at(-1) || "";
}

export function calculateDashboard(rowsBySheet, selectedOperation) {
  const cadastro = records(rowsBySheet[SHEETS.cadastro]);
  const base = records(rowsBySheet[SHEETS.base]);
  const paradas = records(rowsBySheet[SHEETS.paradas]);
  const poroes = records(rowsBySheet[SHEETS.poroes]);

  const vessel = cadastro.find((record) => operationId(record) === selectedOperation) || {};
  const baseRows = base.filter((record) => operationId(record) === selectedOperation);
  const pauseRows = paradas.filter((record) => operationId(record) === selectedOperation);
  const holdRows = poroes.filter((record) => operationId(record) === selectedOperation);

  if (!baseRows.length && !Object.keys(vessel).length) {
    throw new Error(`A operação ${selectedOperation} não possui cadastro ou lançamentos operacionais.`);
  }

  const pauseByRow = new Map();
  const pauseByCategory = new Map();
  const pauseByReason = new Map();
  let longestPause = null;
  pauseRows.forEach((record) => {
    const hours = pauseHours(record);
    addToMap(pauseByRow, rowKey(record), hours);
    const category = text(value(record, "Categoria")) || "Sem categoria";
    const reason = text(value(record, "Motivo")) || "Sem motivo informado";
    const categoryStats = pauseByCategory.get(category) || { category, hours: 0, count: 0 };
    categoryStats.hours += hours;
    categoryStats.count += 1;
    pauseByCategory.set(category, categoryStats);
    const reasonStats = pauseByReason.get(reason) || { reason, hours: 0, count: 0 };
    reasonStats.hours += hours;
    reasonStats.count += 1;
    pauseByReason.set(reason, reasonStats);
    if (!longestPause || hours > longestPause.hours) longestPause = { category, reason, hours };
  });

  let volume = 0;
  let volumeTerminal = 0;
  let volumeDireto = 0;
  let calendarHours = 0;
  let stoppedHours = 0;
  let workedHours = 0;
  let terminalWorkedHours = 0;
  let directWorkedHours = 0;
  const shifts = new Map();
  const holds = new Map();
  const days = new Map();
  const operationDates = [];

  baseRows.forEach((record) => {
    const terminal = number(value(record, "Volume Terminal t", "Volume Terminal (t)"));
    const direct = number(value(record, "Volume Direto t", "Volume Direto (t)"));
    const totalCell = value(record, "Volume Total t", "Volume Total (t)");
    const total = hasValue(totalCell) ? number(totalCell) : terminal + direct;
    const calendar = Math.max(number(value(record, "Horas Calendario", "Horas Calendário")), 0);
    const rowPause = pauseByRow.has(rowKey(record))
      ? pauseByRow.get(rowKey(record))
      : Math.max(number(value(record, "Horas Paradas")), 0);
    const worked = Math.max(calendar - Math.min(rowPause, calendar), 0);
    const shift = text(value(record, "Turno")) || "—";
    const hold = holdId(record) || "—";
    const parsedDate = excelDate(value(record, "Data"));
    if (parsedDate) operationDates.push(parsedDate);

    volume += total;
    volumeTerminal += terminal;
    volumeDireto += direct;
    calendarHours += calendar;
    stoppedHours += rowPause;
    workedHours += worked;
    if (terminal > 0) terminalWorkedHours += worked;
    if (direct > 0) directWorkedHours += worked;

    if (!shifts.has(shift)) shifts.set(shift, { shift, volume: 0, workedHours: 0, stoppedHours: 0 });
    const shiftSummary = shifts.get(shift);
    shiftSummary.volume += total;
    shiftSummary.workedHours += worked;
    shiftSummary.stoppedHours += rowPause;

    if (!holds.has(hold)) holds.set(hold, { hold, manifested: 0, volume: 0, workedHours: 0 });
    const holdSummary = holds.get(hold);
    holdSummary.volume += total;
    holdSummary.workedHours += worked;

    const dayKey = parsedDate ? parsedDate.toISOString().slice(0, 10) : text(value(record, "Data")) || "Sem data";
    if (!days.has(dayKey)) {
      days.set(dayKey, { key: dayKey, date: parsedDate, volume: 0, calendarHours: 0, stoppedHours: 0, workedHours: 0 });
    }
    const daySummary = days.get(dayKey);
    daySummary.volume += total;
    daySummary.calendarHours += calendar;
    daySummary.stoppedHours += rowPause;
    daySummary.workedHours += worked;

    if (!pauseRows.length && rowPause > 0) {
      const category = text(value(record, "Categoria Parada Principal")) || "Sem categoria";
      const categoryStats = pauseByCategory.get(category) || { category, hours: 0, count: 0 };
      categoryStats.hours += rowPause;
      categoryStats.count += 1;
      pauseByCategory.set(category, categoryStats);
    }
  });

  holdRows.forEach((record) => {
    const hold = holdId(record);
    if (!hold) return;
    if (!holds.has(hold)) holds.set(hold, { hold, manifested: 0, volume: 0, workedHours: 0 });
    holds.get(hold).manifested += number(value(record, "Volume Manifestado t", "Volume Manifestado (t)"));
  });

  const manifestedFromCadastro = number(value(vessel, "Volume Manifestado t", "Volume Manifestado (t)"));
  const manifestedFromHolds = [...holds.values()].reduce((sum, item) => sum + item.manifested, 0);
  const manifested = manifestedFromCadastro || manifestedFromHolds;
  const targetProductivity = number(value(vessel, "Meta Produtividade t h", "Meta Produtividade (t/h)"));
  const targetDaily = number(value(vessel, "Meta Descarga t dia", "Meta Descarga (t/dia)"));
  const productivity = divide(volume, workedHours);
  const dailyRate = divide(volume, calendarHours / 24);
  const efficiency = divide(workedHours, calendarHours);
  const stoppageRate = divide(stoppedHours, calendarHours);
  const adherence = divide(volume, manifested);
  const ets = value(vessel, "ETS");
  const targetReached = manifested > 0 && volume + 0.001 >= manifested;
  // Quando existe uma carga informada, somente o atingimento desse volume
  // caracteriza o fechamento. A ETS permanece como fallback apenas para
  // cadastros antigos sem volume manifestado.
  const concluded = manifested > 0 ? targetReached : hasValue(ets);
  const difference = volume - manifested;

  const holdSummaries = [...holds.values()]
    .filter((item) => item.hold !== "—" && (item.volume || item.manifested))
    .map((item) => ({
      ...item,
      productivity: divide(item.volume, item.workedHours),
      progress: divide(item.volume, item.manifested),
    }))
    .sort((left, right) => left.hold.localeCompare(right.hold, "pt-BR", { numeric: true }));

  const shiftOrder = new Map([["A", 1], ["B", 2], ["C", 3], ["D", 4]]);
  const shiftSummaries = [...shifts.values()]
    .map((item) => ({
      ...item,
      productivity: divide(item.volume, item.workedHours),
      efficiency: divide(item.workedHours, item.workedHours + item.stoppedHours),
      volumeShare: divide(item.volume, volume),
    }))
    .sort((left, right) => (shiftOrder.get(left.shift) || 99) - (shiftOrder.get(right.shift) || 99));

  const stopSummaries = [...pauseByCategory.values()]
    .map((item) => ({ ...item, share: divide(item.hours, stoppedHours) }))
    .filter((item) => item.hours > 0)
    .sort((left, right) => right.hours - left.hours);

  const reasonSummaries = [...pauseByReason.values()]
    .map((item) => ({ ...item, share: divide(item.hours, stoppedHours) }))
    .filter((item) => item.hours > 0)
    .sort((left, right) => right.hours - left.hours);

  const dailySummaries = [...days.values()]
    .map((item) => ({
      ...item,
      productivity: divide(item.volume, item.workedHours),
      efficiency: divide(item.workedHours, item.calendarHours),
    }))
    .sort((left, right) => {
      if (left.date && right.date) return left.date - right.date;
      return left.key.localeCompare(right.key);
    });

  operationDates.sort((left, right) => left - right);
  const startDate = operationDates[0] || excelDate(value(vessel, "ETB"));
  const endDate = operationDates.at(-1) || excelDate(ets);
  const shipName = text(value(vessel, "Navio")) || "Navio não informado";
  const terminal = text(value(vessel, "Terminal")) || "Terminal não informado";
  const berth = text(value(vessel, "Berco", "Berço"));
  const product = text(value(vessel, "Produto"));
  const client = text(value(vessel, "Cliente"));
  const etbDate = excelDate(value(vessel, "ETB"));
  const etsDate = excelDate(ets);
  const operatedHolds = holdSummaries.filter((item) => item.volume > 0);
  const averageHoldHours = operatedHolds.length
    ? operatedHolds.reduce((sum, item) => sum + item.workedHours, 0) / operatedHolds.length
    : 0;
  const bestShift = [...shiftSummaries].sort((left, right) => right.productivity - left.productivity)[0] || null;
  const worstShift = [...shiftSummaries].filter((item) => item.workedHours > 0).sort((left, right) => left.productivity - right.productivity)[0] || null;
  const bestHold = [...operatedHolds].sort((left, right) => right.productivity - left.productivity)[0] || null;
  const worstHold = [...operatedHolds].sort((left, right) => left.productivity - right.productivity)[0] || null;
  const pauseCount = pauseRows.length || stopSummaries.reduce((sum, item) => sum + item.count, 0);
  const averagePause = pauseCount ? stoppedHours / pauseCount : 0;

  let executiveReading;
  if (concluded && difference >= 0) {
    executiveReading = `Descarga concluída; diferença de +${formatTons(difference)} frente ao manifesto para reconciliação final.`;
  } else if (concluded) {
    executiveReading = `Descarga concluída com saldo de ${formatTons(Math.abs(difference))} abaixo do manifesto; validar reconciliação final.`;
  } else {
    executiveReading = `Resultado parcial da descarga; restam ${formatTons(Math.max(manifested - volume, 0))} para atingir o volume manifestado.`;
  }

  return {
    operationId: selectedOperation,
    shipName,
    terminal,
    berth,
    product,
    client,
    imo: text(value(vessel, "IMO")),
    flag: text(value(vessel, "Bandeira")),
    operationType: text(value(vessel, "Tipo Operacao", "Tipo Operação")),
    etbDate,
    etsDate,
    concluded,
    status: concluded ? "CONCLUÍDO" : "PARCIAL",
    closingLabel: concluded ? "CONCLUÍDA" : "PARCIAL",
    volume,
    volumeTerminal,
    volumeDireto,
    manifested,
    difference,
    calendarHours,
    stoppedHours,
    workedHours,
    productivity,
    targetProductivity,
    productivityAchievement: divide(productivity, targetProductivity),
    dailyRate,
    targetDaily,
    dailyAchievement: divide(dailyRate, targetDaily),
    efficiency,
    stoppageRate,
    adherence,
    terminalProductivity: divide(volumeTerminal, terminalWorkedHours),
    directProductivity: divide(volumeDireto, directWorkedHours),
    terminalShare: divide(volumeTerminal, volume),
    directShare: divide(volumeDireto, volume),
    operatedHoldCount: operatedHolds.length,
    averageHoldHours,
    averagePause,
    pauseCount,
    longestPause,
    bestShift,
    worstShift,
    bestHold,
    worstHold,
    stopHoursPerThousandTons: divide(stoppedHours * 1000, volume),
    operationDays: divide(calendarHours, 24),
    holds: holdSummaries,
    shifts: shiftSummaries,
    stops: stopSummaries,
    reasons: reasonSummaries,
    daily: dailySummaries,
    executiveReading,
    startDate,
    endDate,
    rowCounts: { base: baseRows.length, stops: pauseRows.length },
  };
}

const ptNumber = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
const ptOneDecimal = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const ptDate = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });

export function formatTons(valueToFormat) {
  return `${ptNumber.format(Math.round(number(valueToFormat)))} t`;
}

export function formatRate(valueToFormat, suffix = "t/h") {
  return `${ptOneDecimal.format(number(valueToFormat))} ${suffix}`;
}

export function formatPercent(valueToFormat) {
  return `${ptOneDecimal.format(number(valueToFormat) * 100)}%`;
}

export function formatDuration(hours) {
  const totalMinutes = Math.max(0, Math.round(number(hours) * 60));
  const wholeHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${wholeHours}h${String(minutes).padStart(2, "0")}`;
}

export function formatDate(valueToFormat) {
  return valueToFormat instanceof Date && !Number.isNaN(valueToFormat.getTime()) ? ptDate.format(valueToFormat) : "—";
}

export function periodLabel(startDate, endDate) {
  if (!startDate && !endDate) return "Período não informado";
  if (startDate && endDate && startDate.getTime() !== endDate.getTime()) {
    return `${formatDate(startDate)} a ${formatDate(endDate)}`;
  }
  return formatDate(startDate || endDate);
}
