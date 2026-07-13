const ARM_ORDER = ["C1", "C2", "C3", "C4"];
const PHASE_ORDER = ["L1", "L2", "L3"];
const ARM_LABELS = {
  C1: "C1 top left",
  C2: "C2 bottom left",
  C3: "C3 top right",
  C4: "C4 bottom right",
};
const GROUPS_PER_ARM = 6;
const CAPS_PER_GROUP = 4;
const CAPS_PER_ARM = GROUPS_PER_ARM * CAPS_PER_GROUP;
const TOTAL_CAPS = ARM_ORDER.length * CAPS_PER_ARM;
const MIN_USEFUL_IMPROVEMENT_MA = 0.001;

const armsEl = document.querySelector("#arms");
const phaseOverviewEl = document.querySelector("#phaseOverview");
const activePhaseLabelEls = document.querySelectorAll(".activePhaseLabel");
const systemVoltageEl = document.querySelector("#systemVoltage");
const voltageBasisEl = document.querySelector("#voltageBasis");
const frequencyEl = document.querySelector("#frequency");
const nominalCapEl = document.querySelector("#nominalCap");
const ctRatioEl = document.querySelector("#ctRatio");
const swapPairsEl = document.querySelector("#swapPairs");
const fileInputEl = document.querySelector("#fileInput");
const fileStatusEl = document.querySelector("#fileStatus");
const downloadTemplateEl = document.querySelector("#downloadTemplate");
const primaryUnbalanceEl = document.querySelector("#primaryUnbalance");
const secondaryUnbalanceEl = document.querySelector("#secondaryUnbalance");
const bestPrimaryUnbalanceEl = document.querySelector("#bestPrimaryUnbalance");
const bestSecondaryUnbalanceEl = document.querySelector("#bestSecondaryUnbalance");
const swapListEl = document.querySelector("#swapList");
const depthTableEl = document.querySelector("#depthTable");
const detailsEl = document.querySelector("#details");
const applyBestEl = document.querySelector("#applyBest");
const exportCsvEl = document.querySelector("#exportCsv");

let capacitors = [];
let lastBest = null;
let lastRecord = null;
let lastOptimizationResult = null;
let movedIds = new Map();
let currentPhase = "L1";
let phaseStates = {};
let isPhaseSwitching = false;

function readNumber(el, fallback) {
  const value = Number.parseFloat(el.value);
  return Number.isFinite(value) ? value : fallback;
}

function capMeta(index) {
  const armIndex = Math.floor(index / CAPS_PER_ARM);
  const inArm = index % CAPS_PER_ARM;
  const groupIndex = Math.floor(inArm / CAPS_PER_GROUP);
  const slotIndex = inArm % CAPS_PER_GROUP;
  const arm = ARM_ORDER[armIndex];
  return {
    arm,
    armIndex,
    groupIndex,
    slotIndex,
    position: `${arm} G${groupIndex + 1} slot ${slotIndex + 1}`,
  };
}

function makeCapId(index) {
  return `${index + 1}`;
}

function makeDefaultCaps() {
  const nominal = readNumber(nominalCapEl, 21.89);
  return Array.from({ length: TOTAL_CAPS }, (_, index) => ({
    id: makeCapId(index),
    uf: nominal,
  }));
}

function makePhaseState() {
  return {
    capacitors: makeDefaultCaps(),
    lastBest: null,
    lastRecord: null,
    lastOptimizationResult: null,
    movedIds: new Map(),
  };
}

function saveCurrentPhaseState({ readInputs = true } = {}) {
  if (!phaseStates[currentPhase]) return;
  if (readInputs && capacitors.length === TOTAL_CAPS && armsEl.children.length > 0) {
    syncFromInputs();
  }
  phaseStates[currentPhase] = {
    capacitors: capacitors.map((cap) => ({ ...cap })),
    lastBest,
    lastRecord,
    lastOptimizationResult,
    movedIds: new Map(movedIds),
  };
}

function loadPhaseState(phase) {
  const state = phaseStates[phase] || makePhaseState();
  phaseStates[phase] = state;
  capacitors = state.capacitors.map((cap) => ({ ...cap }));
  lastBest = state.lastBest;
  lastRecord = state.lastRecord;
  lastOptimizationResult = state.lastOptimizationResult;
  movedIds = new Map(state.movedIds);
  currentPhase = phase;
}

function resetCurrentPhaseResult() {
  lastBest = null;
  lastRecord = null;
  lastOptimizationResult = null;
  movedIds = new Map();
  applyBestEl.disabled = true;
  exportCsvEl.disabled = true;
  swapListEl.innerHTML = "";
  depthTableEl.innerHTML = "";
}

function restorePhaseResult() {
  if (lastOptimizationResult) {
    renderOptimization(lastOptimizationResult);
    return;
  }
  swapListEl.innerHTML = "";
  depthTableEl.innerHTML = "";
  applyBestEl.disabled = true;
  exportCsvEl.disabled = true;
  renderLayout();
  updateSummary();
}

function setPhaseUi() {
  document.querySelectorAll(".phase-tab").forEach((button) => {
    const isActive = button.dataset.phase === currentPhase;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-selected", String(isActive));
  });
  activePhaseLabelEls.forEach((el) => {
    el.textContent = currentPhase;
  });
}

function formatMA(value) {
  return `${value.toFixed(3)} mA`;
}

function isDisplayedZeroMA(value) {
  return value.toFixed(3) === "0.000";
}

function formatA(value) {
  return `${value.toFixed(6)} A`;
}

function formatUf(value) {
  return `${value.toFixed(6)} uF`;
}

function formatPercent(value) {
  return `${value.toFixed(4)}%`;
}

function setFileStatus(message, isError = false) {
  if (!fileStatusEl) return;
  fileStatusEl.textContent = message;
  fileStatusEl.classList.toggle("is-error", isError);
}

function getSystem() {
  const kv = readNumber(systemVoltageEl, 132);
  const ctRatio = Math.max(readNumber(ctRatioEl, 1), 0.000001);
  return {
    sourceVoltage: (voltageBasisEl.value === "phase" ? kv / Math.sqrt(3) : kv) * 1000,
    displayKv: kv,
    basis: voltageBasisEl.value,
    frequency: readNumber(frequencyEl, 50),
    ctRatio,
  };
}

function equivalentSeries(groups) {
  if (groups.some((value) => value <= 0)) return 0;
  const inverse = groups.reduce((sum, value) => sum + 1 / value, 0);
  return inverse > 0 ? 1 / inverse : 0;
}

function calculate(layout, system = getSystem()) {
  const groupUf = {};
  const armGroups = {};
  const armUf = {};

  ARM_ORDER.forEach((arm) => {
    armGroups[arm] = Array.from({ length: GROUPS_PER_ARM }, () => 0);
  });

  layout.forEach((cap, index) => {
    const meta = capMeta(index);
    armGroups[meta.arm][meta.groupIndex] += cap.uf;
  });

  ARM_ORDER.forEach((arm) => {
    armUf[arm] = equivalentSeries(armGroups[arm]);
    armGroups[arm].forEach((value, groupIndex) => {
      groupUf[`${arm}${groupIndex + 1}`] = value;
    });
  });

  const c1 = armUf.C1;
  const c2 = armUf.C2;
  const c3 = armUf.C3;
  const c4 = armUf.C4;
  const cTop = c1 + c3;
  const cBottom = c2 + c4;
  const totalUf = cTop > 0 && cBottom > 0 ? (cTop * cBottom) / (cTop + cBottom) : 0;
  const omega = 2 * Math.PI * system.frequency;
  const totalCurrentA = system.sourceVoltage * omega * totalUf * 1e-6;
  const i1 = cTop > 0 ? totalCurrentA * (c1 / cTop) : 0;
  const i3 = cTop > 0 ? totalCurrentA * (c3 / cTop) : 0;
  const i2 = cBottom > 0 ? totalCurrentA * (c2 / cBottom) : 0;
  const i4 = cBottom > 0 ? totalCurrentA * (c4 / cBottom) : 0;
  const unbalanceA = Math.abs(i1 - i2);
  const unbalanceMA = unbalanceA * 1000;
  const secondaryUnbalanceMA = unbalanceMA / system.ctRatio;
  const secondaryUnbalanceA = unbalanceA / system.ctRatio;
  const balanceNumerator = c1 * c4 - c3 * c2;
  const balanceDenominator = c1 * c4 + c3 * c2;
  const balanceErrorPercent =
    balanceDenominator !== 0 ? (balanceNumerator / balanceDenominator) * 100 : 0;
  const bridgeFormulaA =
    c1 + c2 + c3 + c4 > 0
      ? omega * system.sourceVoltage * Math.abs(balanceNumerator / (c1 + c2 + c3 + c4)) * 1e-6
      : 0;

  return {
    unbalanceMA,
    unbalanceA,
    secondaryUnbalanceMA,
    secondaryUnbalanceA,
    armUf,
    armGroups,
    totalUf,
    totalCurrentA,
    i1,
    i2,
    i3,
    i4,
    balanceNumerator,
    balanceErrorPercent,
    bridgeFormulaA,
    system,
  };
}

function renderPhaseOverview() {
  if (!phaseOverviewEl) return;
  const system = getSystem();
  phaseOverviewEl.innerHTML = PHASE_ORDER.map((phase) => {
    const state = phase === currentPhase
      ? { capacitors, lastBest }
      : phaseStates[phase] || makePhaseState();
    const current = calculate(state.capacitors, system);
    const best = state.lastBest ? calculate(state.lastBest.layout, system) : current;
    const isActive = phase === currentPhase ? " is-active" : "";
    return `
      <button class="phase-summary${isActive}" type="button" data-phase-jump="${phase}">
        <span>${phase}</span>
        <strong>${formatMA(current.unbalanceMA)}</strong>
        <small>sec ${formatMA(current.secondaryUnbalanceMA)}</small>
      </button>
    `;
  }).join("");
}

function switchPhase(phase) {
  if (!PHASE_ORDER.includes(phase) || phase === currentPhase) return;
  isPhaseSwitching = true;
  saveCurrentPhaseState();
  loadPhaseState(phase);
  setPhaseUi();
  restorePhaseResult();
  setFileStatus(`Showing ${currentPhase}. Load Excel/CSV will fill ${currentPhase} only.`);
  isPhaseSwitching = false;
}

function renderLayout() {
  armsEl.innerHTML = "";
  ARM_ORDER.forEach((arm) => {
    const section = document.createElement("section");
    section.className = "arm";
    section.dataset.arm = arm;
    section.innerHTML = `
      <div class="arm-head">
        <span>${ARM_LABELS[arm]}</span>
        <small id="arm-${arm}-cap">0.000000 uF</small>
      </div>
      <div class="group-grid"></div>
    `;

    const groupGrid = section.querySelector(".group-grid");
    for (let groupIndex = 0; groupIndex < GROUPS_PER_ARM; groupIndex += 1) {
      const group = document.createElement("div");
      group.className = "group";
      group.innerHTML = `<div class="group-label">G${groupIndex + 1}</div>`;

      for (let slotIndex = 0; slotIndex < CAPS_PER_GROUP; slotIndex += 1) {
        const index =
          ARM_ORDER.indexOf(arm) * CAPS_PER_ARM + groupIndex * CAPS_PER_GROUP + slotIndex;
        const cap = capacitors[index];
        const moveClass = movedIds.get(cap.id);
        const label = document.createElement("label");
        label.className = `cap-slot ${moveClass ? `is-moved ${moveClass}` : ""}`;
        label.innerHTML = `
          <div class="cap-top">
            <span class="cap-id">${cap.id}</span>
          </div>
          <input data-index="${index}" type="number" min="0" step="0.001" value="${cap.uf}" />
        `;
        group.appendChild(label);
      }

      groupGrid.appendChild(group);
    }

    armsEl.appendChild(section);
  });
}

function syncFromInputs() {
  document.querySelectorAll("[data-index]").forEach((input) => {
    const index = Number.parseInt(input.dataset.index, 10);
    capacitors[index].uf = readNumber(input, capacitors[index].uf);
  });
}

function swapLayout(layout, a, b) {
  const next = layout.map((cap) => ({ ...cap }));
  [next[a], next[b]] = [next[b], next[a]];
  return next;
}

function movedCount(layout, original) {
  return layout.reduce((count, cap, index) => count + (cap.id === original[index].id ? 0 : 1), 0);
}

function swapsFromState(state) {
  const swaps = [];
  let cursor = state;
  while (cursor && cursor.swap) {
    swaps.push(cursor.swap);
    cursor = cursor.parent;
  }
  return swaps.reverse();
}

function optimizeLayout(original, swapPairsOption) {
  const system = getSystem();
  const isAuto = swapPairsOption === "auto";
  const maxPairs = isAuto ? 6 : Number.parseInt(swapPairsOption, 10);
  const initial = {
    layout: original.map((cap) => ({ ...cap })),
    score: calculate(original, system).unbalanceMA,
    depth: 0,
    parent: null,
    swap: null,
    used: new Set(),
  };
  const bestByDepth = [initial];
  const pairs = [];

  for (let a = 0; a < TOTAL_CAPS - 1; a += 1) {
    for (let b = a + 1; b < TOTAL_CAPS; b += 1) {
      pairs.push([a, b]);
    }
  }

  let current = initial;
  for (let depth = 1; depth <= maxPairs; depth += 1) {
    let bestCandidate = null;

    for (const [a, b] of pairs) {
      if (current.used.has(a) || current.used.has(b)) continue;
      const layout = swapLayout(current.layout, a, b);
      const score = calculate(layout, system).unbalanceMA;

      if (
        !bestCandidate ||
        score < bestCandidate.score ||
        (score === bestCandidate.score && movedCount(layout, original) < movedCount(bestCandidate.layout, original))
      ) {
        const used = new Set(current.used);
        used.add(a);
        used.add(b);
        bestCandidate = {
          layout,
          score,
          depth,
          parent: current,
          swap: [a, b],
          used,
        };
      }
    }

    if (!bestCandidate || bestCandidate.score >= current.score) {
      bestByDepth[depth] = current;
      if (isAuto) break;
      continue;
    }

    const improvement = current.score - bestCandidate.score;
    current = bestCandidate;
    bestByDepth[depth] = current;

    if (isAuto && (isDisplayedZeroMA(current.score) || improvement < MIN_USEFUL_IMPROVEMENT_MA)) {
      break;
    }
  }

  const best = current;

  return {
    best,
    bestByDepth,
    isAuto,
    recommendedPairs: swapsFromState(best).length,
    autoStopReason:
      isAuto && isDisplayedZeroMA(current.score)
        ? "Reached displayed 0.000 mA."
        : isAuto
          ? `Stopped when extra improvement was below ${MIN_USEFUL_IMPROVEMENT_MA.toFixed(3)} mA.`
          : "",
  };
}

function renderDetails(result) {
  const rows = [
    ["Effective voltage", `${(result.system.sourceVoltage / 1000).toFixed(6)} kV`],
    ["C1 / C2 / C3 / C4", `${formatUf(result.armUf.C1)} / ${formatUf(result.armUf.C2)} / ${formatUf(result.armUf.C3)} / ${formatUf(result.armUf.C4)}`],
  ];

  detailsEl.innerHTML = rows
    .map(([label, value]) => `<div class="detail-row"><span>${label}</span><strong>${value}</strong></div>`)
    .join("");
}

function updateSummary(bestState = lastBest) {
  syncFromInputs();
  const current = calculate(capacitors);
  const best = bestState ? calculate(bestState.layout) : current;

  primaryUnbalanceEl.textContent = formatMA(current.unbalanceMA);
  secondaryUnbalanceEl.textContent = formatMA(current.secondaryUnbalanceMA);
  bestPrimaryUnbalanceEl.textContent = formatMA(best.unbalanceMA);
  bestSecondaryUnbalanceEl.textContent = formatMA(best.secondaryUnbalanceMA);

  ARM_ORDER.forEach((arm) => {
    const el = document.querySelector(`#arm-${arm}-cap`);
    if (el) el.textContent = formatUf(current.armUf[arm]);
  });

  renderDetails(current);
  if (!isPhaseSwitching) {
    saveCurrentPhaseState({ readInputs: false });
  }
  renderPhaseOverview();
}

function buildSwapRows(initial, swaps) {
  const rows = [];
  let cursor = initial.map((cap) => ({ ...cap }));
  swaps.forEach(([a, b], index) => {
    const capA = cursor[a];
    const capB = cursor[b];
    rows.push({
      pair: index + 1,
      capA: capA.id,
      fromA: capMeta(a).position,
      toA: capMeta(b).position,
      ufA: capA.uf,
      capB: capB.id,
      fromB: capMeta(b).position,
      toB: capMeta(a).position,
      ufB: capB.uf,
    });
    cursor = swapLayout(cursor, a, b);
  });
  return rows;
}

function parseNumericCell(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return NaN;
  const cleaned = value.trim().replace(/,/g, "");
  if (!cleaned) return NaN;
  const number = Number.parseFloat(cleaned);
  return Number.isFinite(number) ? number : NaN;
}

function extractCapacitanceValues(rows) {
  const paired = [];

  rows.forEach((row) => {
    const numericCells = row
      .map((cell, column) => ({ column, value: parseNumericCell(cell) }))
      .filter((cell) => Number.isFinite(cell.value));
    if (numericCells.length < 2) return;
    const id = numericCells[0].value;
    if (!Number.isInteger(id) || id < 1 || id > TOTAL_CAPS) return;
    const valueCell = [...numericCells].reverse().find((cell) => cell.column !== numericCells[0].column);
    if (valueCell) paired.push({ id, value: valueCell.value });
  });

  const uniqueIds = new Set(paired.map((item) => item.id));
  if (uniqueIds.size >= TOTAL_CAPS) {
    return Array.from({ length: TOTAL_CAPS }, (_, index) => {
      const row = paired.find((item) => item.id === index + 1);
      return row ? row.value : NaN;
    });
  }

  return rows
    .flatMap((row) => row.map(parseNumericCell))
    .filter((value) => Number.isFinite(value))
    .slice(0, TOTAL_CAPS);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  row.push(cell);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  return rows;
}

function applyLoadedValues(values, sourceName) {
  if (values.length < TOTAL_CAPS || values.some((value) => !Number.isFinite(value))) {
    setFileStatus(`Could not find 96 capacitance values in ${sourceName}.`, true);
    return;
  }

  capacitors = values.slice(0, TOTAL_CAPS).map((uf, index) => ({
    id: makeCapId(index),
    uf: Number(uf),
  }));
  resetCurrentPhaseResult();
  swapListEl.innerHTML = "";
  depthTableEl.innerHTML = "";
  renderLayout();
  updateSummary();
  setFileStatus(`Loaded 96 capacitance values from ${sourceName} into ${currentPhase}.`);
}

async function loadDataFile(file) {
  const extension = file.name.split(".").pop().toLowerCase();
  if (extension === "csv" || extension === "txt") {
    const text = await file.text();
    applyLoadedValues(extractCapacitanceValues(parseCsv(text)), file.name);
    return;
  }

  if (!window.XLSX) {
    setFileStatus("Excel parser is not available. Try CSV, or check the network connection.", true);
    return;
  }

  const buffer = await file.arrayBuffer();
  const workbook = window.XLSX.read(buffer, { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = window.XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false });
  applyLoadedValues(extractCapacitanceValues(rows), file.name);
}

function createRecord(bestState) {
  const initial = capacitors.map((cap) => ({ ...cap }));
  const finalLayout = bestState.layout.map((cap) => ({ ...cap }));
  const before = calculate(initial);
  const after = calculate(finalLayout);
  const swaps = swapsFromState(bestState);
  return {
    title: `132kV H Type 96 Capacitor Bank Unbalanced Current - ${currentPhase}`,
    phase: currentPhase,
    createdAt: new Date().toISOString(),
    voltageKv: readNumber(systemVoltageEl, 132),
    voltageBasis: voltageBasisEl.value,
    frequency: readNumber(frequencyEl, 50),
    ctRatio: getSystem().ctRatio,
    swapMode: swapPairsEl.value,
    recommendedPairs: swaps.length,
    beforeMA: before.unbalanceMA,
    beforeSecondaryMA: before.secondaryUnbalanceMA,
    afterMA: after.unbalanceMA,
    afterSecondaryMA: after.secondaryUnbalanceMA,
    improvement:
      before.unbalanceMA > 0 ? ((before.unbalanceMA - after.unbalanceMA) / before.unbalanceMA) * 100 : 0,
    rows: buildSwapRows(initial, swaps),
    finalLayout,
    finalResult: after,
  };
}

function renderOptimization(result) {
  lastOptimizationResult = result;
  lastBest = result.best;
  lastRecord = createRecord(result.best);

  const swaps = swapsFromState(result.best);
  movedIds = new Map();
  swapListEl.innerHTML = "";
  if (result.isAuto) {
    const li = document.createElement("li");
    li.className = "swap-card";
    li.innerHTML = `
      <div class="swap-title">
        <span>Auto recommendation</span>
        <span>${result.recommendedPairs} pair${result.recommendedPairs === 1 ? "" : "s"}</span>
      </div>
      <div class="swap-line">
        <strong>Rule</strong>
        <span>${result.autoStopReason || "Fewest useful swap pairs."}</span>
      </div>
    `;
    swapListEl.appendChild(li);
  }
  let cursor = capacitors.map((cap) => ({ ...cap }));
  swaps.forEach(([a, b], index) => {
    const moveClass = `move-${(index % 6) + 1}`;
    const capA = cursor[a];
    const capB = cursor[b];
    movedIds.set(capA.id, moveClass);
    movedIds.set(capB.id, moveClass);
    const li = document.createElement("li");
    li.className = `swap-card ${moveClass}`;
    li.innerHTML = `
      <div class="swap-title">
        <span>Pair ${index + 1}</span>
        <span>${formatMA(calculate(swapLayout(cursor, a, b)).unbalanceMA)}</span>
      </div>
      <div class="swap-line">
        <strong>${capA.id}</strong>
        <span>${capMeta(a).position} to ${capMeta(b).position} | ${capA.uf.toFixed(6)} uF</span>
      </div>
      <div class="swap-line">
        <strong>${capB.id}</strong>
        <span>${capMeta(b).position} to ${capMeta(a).position} | ${capB.uf.toFixed(6)} uF</span>
      </div>
    `;
    swapListEl.appendChild(li);
    cursor = swapLayout(cursor, a, b);
  });

  renderLayout();
  updateSummary(result.best);
  saveCurrentPhaseState({ readInputs: false });

  applyBestEl.disabled = swaps.length === 0;
  exportCsvEl.disabled = false;

  const baseline = result.bestByDepth[0].score || 1;
  depthTableEl.innerHTML = "";
  result.bestByDepth.forEach((state, depth) => {
    if (!state) return;
    const width = baseline > 0 ? Math.max(2, (state.score / baseline) * 100) : 2;
    const row = document.createElement("div");
    row.className = "depth-row";
    row.innerHTML = `
      <span>${depth} pair${depth === 1 ? "" : "s"}</span>
      <div class="bar"><span style="width:${Math.min(100, width)}%"></span></div>
      <strong>${formatMA(state.score)}</strong>
    `;
    depthTableEl.appendChild(row);
  });
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function buildTemplateRows() {
  const nominal = readNumber(nominalCapEl, 21.89);
  const rows = [["ID", "Section", "Group", "Slot", "Capacitance_uF"]];
  for (let index = 0; index < TOTAL_CAPS; index += 1) {
    const meta = capMeta(index);
    rows.push([
      index + 1,
      meta.arm,
      `G${meta.groupIndex + 1}`,
      meta.slotIndex + 1,
      Number(nominal.toFixed(6)),
    ]);
  }
  return rows;
}

function downloadTemplate() {
  const rows = buildTemplateRows();
  const stamp = new Date().toISOString().slice(0, 10);
  const baseName = `132kv-h-type-96cap-${currentPhase.toLowerCase()}-template-${stamp}`;

  if (window.XLSX) {
    const workbook = window.XLSX.utils.book_new();
    const worksheet = window.XLSX.utils.aoa_to_sheet(rows);
    worksheet["!cols"] = [{ wch: 8 }, { wch: 12 }, { wch: 10 }, { wch: 8 }, { wch: 18 }];
    window.XLSX.utils.book_append_sheet(workbook, worksheet, `${currentPhase} Template`);
    window.XLSX.writeFile(workbook, `${baseName}.xlsx`);
    setFileStatus(`Downloaded ${currentPhase} Excel template.`);
    return;
  }

  const csv = rows.map((row) => row.map(csvEscape).join(",")).join("\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  downloadBlob(blob, `${baseName}.csv`);
  setFileStatus(`Downloaded ${currentPhase} CSV template because Excel support is not available.`);
}

function exportRecord() {
  if (!lastRecord) return;
  const summary = [
    [lastRecord.title],
    ["Phase", lastRecord.phase],
    ["Created At", lastRecord.createdAt],
    ["Voltage kV", lastRecord.voltageKv],
    ["Voltage Basis", lastRecord.voltageBasis],
    ["Frequency Hz", lastRecord.frequency],
    ["CT Ratio X:1", lastRecord.ctRatio],
    ["Swap Mode", lastRecord.swapMode],
    ["Recommended Swap Pairs", lastRecord.recommendedPairs],
    ["Before Primary Unbalanced Current mA", lastRecord.beforeMA.toFixed(6)],
    ["Before Secondary Relay Current mA", lastRecord.beforeSecondaryMA.toFixed(6)],
    ["After Primary Unbalanced Current mA", lastRecord.afterMA.toFixed(6)],
    ["After Secondary Relay Current mA", lastRecord.afterSecondaryMA.toFixed(6)],
    ["Improvement %", lastRecord.improvement.toFixed(4)],
    [],
    ["Swap Pair", "Capacitor A", "A From", "A To", "A uF", "Capacitor B", "B From", "B To", "B uF"],
  ];
  const swapRows = lastRecord.rows.map((row) => [
    row.pair,
    row.capA,
    row.fromA,
    row.toA,
    row.ufA.toFixed(6),
    row.capB,
    row.fromB,
    row.toB,
    row.ufB.toFixed(6),
  ]);
  const layoutHeader = [
    [],
    ["Final Layout"],
    ["Position", "Capacitor ID", "Capacitance uF"],
  ];
  const layoutRows = lastRecord.finalLayout.map((cap, index) => [
    capMeta(index).position,
    cap.id,
    cap.uf.toFixed(6),
  ]);
  const csv = [...summary, ...swapRows, ...layoutHeader, ...layoutRows]
    .map((row) => row.map(csvEscape).join(","))
    .join("\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  downloadBlob(
    blob,
    `132kv-h-type-96cap-${lastRecord.phase.toLowerCase()}-unbalanced-current-${new Date().toISOString().slice(0, 10)}.csv`,
  );
}

function loadExample() {
  const nominal = readNumber(nominalCapEl, 21.89);
  capacitors = Array.from({ length: TOTAL_CAPS }, (_, index) => {
    const wave = Math.sin(index * 1.73) * 0.018 + Math.cos(index * 0.41) * 0.011;
    const drift = index % 17 === 0 ? 0.035 : 0;
    return {
      id: makeCapId(index),
      uf: Number((nominal * (1 + wave + drift)).toFixed(4)),
    };
  });
  resetCurrentPhaseResult();
  renderLayout();
  updateSummary();
  setFileStatus(`Example data loaded into ${currentPhase}.`);
}

function resetAll() {
  capacitors = makeDefaultCaps();
  resetCurrentPhaseResult();
  renderLayout();
  updateSummary();
  setFileStatus(`${currentPhase} reset to nominal capacitance.`);
}

armsEl.addEventListener("input", () => {
  resetCurrentPhaseResult();
  updateSummary();
});

[systemVoltageEl, voltageBasisEl, frequencyEl, nominalCapEl, ctRatioEl].forEach((el) => {
  el.addEventListener("input", () => updateSummary(lastBest));
  el.addEventListener("change", () => updateSummary(lastBest));
});

swapPairsEl.addEventListener("change", () => {
  lastBest = null;
  lastRecord = null;
  applyBestEl.disabled = true;
  exportCsvEl.disabled = true;
  updateSummary();
});

document.querySelector("#optimize").addEventListener("click", () => {
  syncFromInputs();
  renderOptimization(optimizeLayout(capacitors, swapPairsEl.value));
});

document.querySelectorAll(".phase-tab").forEach((button) => {
  button.addEventListener("click", () => switchPhase(button.dataset.phase));
});

phaseOverviewEl.addEventListener("click", (event) => {
  const button = event.target.closest("[data-phase-jump]");
  if (!button) return;
  switchPhase(button.dataset.phaseJump);
});

document.querySelector("#loadFile").addEventListener("click", () => {
  fileInputEl.click();
});

downloadTemplateEl.addEventListener("click", downloadTemplate);

fileInputEl.addEventListener("change", async () => {
  const file = fileInputEl.files?.[0];
  if (!file) return;
  setFileStatus(`Loading ${file.name}...`);
  try {
    await loadDataFile(file);
  } catch (error) {
    setFileStatus(`Could not load ${file.name}: ${error.message}`, true);
  } finally {
    fileInputEl.value = "";
  }
});

applyBestEl.addEventListener("click", () => {
  if (!lastBest) return;
  const swaps = swapsFromState(lastBest);
  let cursor = capacitors.map((cap) => ({ ...cap }));
  movedIds = new Map();
  swaps.forEach(([a, b], index) => {
    const moveClass = `move-${(index % 6) + 1}`;
    movedIds.set(cursor[a].id, moveClass);
    movedIds.set(cursor[b].id, moveClass);
    cursor = swapLayout(cursor, a, b);
  });
  capacitors = lastBest.layout.map((cap) => ({ ...cap }));
  lastBest = null;
  lastOptimizationResult = null;
  applyBestEl.disabled = true;
  renderLayout();
  updateSummary();
  saveCurrentPhaseState({ readInputs: false });
});

exportCsvEl.addEventListener("click", exportRecord);
document.querySelector("#loadExample").addEventListener("click", loadExample);
document.querySelector("#resetAll").addEventListener("click", resetAll);

phaseStates = Object.fromEntries(PHASE_ORDER.map((phase) => [phase, makePhaseState()]));
loadPhaseState(currentPhase);
setPhaseUi();
renderLayout();
updateSummary();
setFileStatus(`Showing ${currentPhase}. Load Excel/CSV will fill ${currentPhase} only.`);
