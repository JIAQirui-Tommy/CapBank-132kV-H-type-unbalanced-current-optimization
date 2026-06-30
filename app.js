const ARM_ORDER = ["A", "B", "C", "D"];
const ARM_LABELS = {
  A: "A top left",
  B: "B top right",
  C: "C bottom left",
  D: "D bottom right",
};
const GROUPS_PER_ARM = 6;
const CAPS_PER_GROUP = 4;
const CAPS_PER_ARM = GROUPS_PER_ARM * CAPS_PER_GROUP;
const TOTAL_CAPS = ARM_ORDER.length * CAPS_PER_ARM;

const armsEl = document.querySelector("#arms");
const systemVoltageEl = document.querySelector("#systemVoltage");
const voltageBasisEl = document.querySelector("#voltageBasis");
const frequencyEl = document.querySelector("#frequency");
const nominalCapEl = document.querySelector("#nominalCap");
const swapPairsEl = document.querySelector("#swapPairs");
const currentUnbalanceEl = document.querySelector("#currentUnbalance");
const bestUnbalanceEl = document.querySelector("#bestUnbalance");
const improvementEl = document.querySelector("#improvement");
const balanceErrorEl = document.querySelector("#balanceError");
const swapListEl = document.querySelector("#swapList");
const depthTableEl = document.querySelector("#depthTable");
const detailsEl = document.querySelector("#details");
const applyBestEl = document.querySelector("#applyBest");
const exportCsvEl = document.querySelector("#exportCsv");

let capacitors = [];
let lastBest = null;
let lastRecord = null;
let movedIds = new Map();

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
    position: `${arm}-G${groupIndex + 1}-${slotIndex + 1}`,
  };
}

function makeCapId(index) {
  const meta = capMeta(index);
  return `${meta.arm}${String(meta.groupIndex + 1).padStart(2, "0")}-${meta.slotIndex + 1}`;
}

function makeDefaultCaps() {
  const nominal = readNumber(nominalCapEl, 22);
  return Array.from({ length: TOTAL_CAPS }, (_, index) => ({
    id: makeCapId(index),
    uf: nominal,
  }));
}

function formatMA(value) {
  return `${value.toFixed(3)} mA`;
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

function getSystem() {
  const kv = readNumber(systemVoltageEl, 132);
  return {
    sourceVoltage: (voltageBasisEl.value === "phase" ? kv / Math.sqrt(3) : kv) * 1000,
    displayKv: kv,
    basis: voltageBasisEl.value,
    frequency: readNumber(frequencyEl, 50),
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

  const ca = armUf.A;
  const cb = armUf.B;
  const cc = armUf.C;
  const cd = armUf.D;
  const cTop = ca + cb;
  const cBottom = cc + cd;
  const totalUf = cTop > 0 && cBottom > 0 ? (cTop * cBottom) / (cTop + cBottom) : 0;
  const omega = 2 * Math.PI * system.frequency;
  const totalCurrentA = system.sourceVoltage * omega * totalUf * 1e-6;
  const ia = cTop > 0 ? totalCurrentA * (ca / cTop) : 0;
  const ib = cTop > 0 ? totalCurrentA * (cb / cTop) : 0;
  const ic = cBottom > 0 ? totalCurrentA * (cc / cBottom) : 0;
  const id = cBottom > 0 ? totalCurrentA * (cd / cBottom) : 0;
  const unbalanceA = Math.abs(ia - ic);
  const unbalanceMA = unbalanceA * 1000;
  const balanceNumerator = ca * cd - cb * cc;
  const balanceDenominator = ca * cd + cb * cc;
  const balanceErrorPercent =
    balanceDenominator !== 0 ? (balanceNumerator / balanceDenominator) * 100 : 0;
  const bridgeFormulaA =
    ca + cb + cc + cd > 0
      ? omega * system.sourceVoltage * Math.abs(balanceNumerator / (ca + cb + cc + cd)) * 1e-6
      : 0;

  return {
    unbalanceMA,
    unbalanceA,
    armUf,
    armGroups,
    totalUf,
    totalCurrentA,
    ia,
    ib,
    ic,
    id,
    balanceNumerator,
    balanceErrorPercent,
    bridgeFormulaA,
    system,
  };
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
            <span class="cap-position">${capMeta(index).position}</span>
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

function optimizeLayout(original, swapPairs) {
  const system = getSystem();
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
  for (let depth = 1; depth <= swapPairs; depth += 1) {
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
      continue;
    }

    current = bestCandidate;
    bestByDepth[depth] = current;
  }

  return {
    best: current,
    bestByDepth,
  };
}

function renderDetails(result) {
  const rows = [
    ["Effective voltage", `${(result.system.sourceVoltage / 1000).toFixed(6)} kV`],
    ["A / B / C / D", `${formatUf(result.armUf.A)} / ${formatUf(result.armUf.B)} / ${formatUf(result.armUf.C)} / ${formatUf(result.armUf.D)}`],
    ["Top equivalent A+B", formatUf(result.armUf.A + result.armUf.B)],
    ["Bottom equivalent C+D", formatUf(result.armUf.C + result.armUf.D)],
    ["Total equivalent", formatUf(result.totalUf)],
    ["Total current", formatA(result.totalCurrentA)],
    ["IA / IC", `${formatA(result.ia)} / ${formatA(result.ic)}`],
    ["IB / ID", `${formatA(result.ib)} / ${formatA(result.id)}`],
    ["CA*CD - CB*CC", result.balanceNumerator.toExponential(6)],
    ["Formula cross-check", formatMA(result.bridgeFormulaA * 1000)],
  ];

  detailsEl.innerHTML = rows
    .map(([label, value]) => `<div class="detail-row"><span>${label}</span><strong>${value}</strong></div>`)
    .join("");
}

function updateSummary(bestState = lastBest) {
  syncFromInputs();
  const current = calculate(capacitors);
  const best = bestState ? calculate(bestState.layout) : current;
  const improvement =
    current.unbalanceMA > 0
      ? ((current.unbalanceMA - best.unbalanceMA) / current.unbalanceMA) * 100
      : 0;

  currentUnbalanceEl.textContent = formatMA(current.unbalanceMA);
  bestUnbalanceEl.textContent = formatMA(best.unbalanceMA);
  improvementEl.textContent = `${Math.max(0, improvement).toFixed(1)}%`;
  balanceErrorEl.textContent = formatPercent(current.balanceErrorPercent);

  ARM_ORDER.forEach((arm) => {
    const el = document.querySelector(`#arm-${arm}-cap`);
    if (el) el.textContent = formatUf(current.armUf[arm]);
  });

  renderDetails(current);
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

function createRecord(bestState) {
  const initial = capacitors.map((cap) => ({ ...cap }));
  const finalLayout = bestState.layout.map((cap) => ({ ...cap }));
  const before = calculate(initial);
  const after = calculate(finalLayout);
  const swaps = swapsFromState(bestState);
  return {
    title: "132kV H Type 96 Capacitor Bank Unbalanced Current",
    createdAt: new Date().toISOString(),
    voltageKv: readNumber(systemVoltageEl, 132),
    voltageBasis: voltageBasisEl.value,
    frequency: readNumber(frequencyEl, 50),
    beforeMA: before.unbalanceMA,
    afterMA: after.unbalanceMA,
    improvement:
      before.unbalanceMA > 0 ? ((before.unbalanceMA - after.unbalanceMA) / before.unbalanceMA) * 100 : 0,
    rows: buildSwapRows(initial, swaps),
    finalLayout,
    finalResult: after,
  };
}

function renderOptimization(result) {
  lastBest = result.best;
  lastRecord = createRecord(result.best);

  const swaps = swapsFromState(result.best);
  movedIds = new Map();
  swapListEl.innerHTML = "";
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

function exportRecord() {
  if (!lastRecord) return;
  const summary = [
    [lastRecord.title],
    ["Created At", lastRecord.createdAt],
    ["Voltage kV", lastRecord.voltageKv],
    ["Voltage Basis", lastRecord.voltageBasis],
    ["Frequency Hz", lastRecord.frequency],
    ["Before Unbalanced Current mA", lastRecord.beforeMA.toFixed(6)],
    ["After Unbalanced Current mA", lastRecord.afterMA.toFixed(6)],
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
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `132kv-h-type-96cap-unbalanced-current-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function loadExample() {
  const nominal = readNumber(nominalCapEl, 22);
  capacitors = Array.from({ length: TOTAL_CAPS }, (_, index) => {
    const wave = Math.sin(index * 1.73) * 0.018 + Math.cos(index * 0.41) * 0.011;
    const drift = index % 17 === 0 ? 0.035 : 0;
    return {
      id: makeCapId(index),
      uf: Number((nominal * (1 + wave + drift)).toFixed(4)),
    };
  });
  lastBest = null;
  lastRecord = null;
  movedIds = new Map();
  applyBestEl.disabled = true;
  exportCsvEl.disabled = true;
  renderLayout();
  updateSummary();
}

function resetAll() {
  capacitors = makeDefaultCaps();
  lastBest = null;
  lastRecord = null;
  movedIds = new Map();
  applyBestEl.disabled = true;
  exportCsvEl.disabled = true;
  swapListEl.innerHTML = "";
  depthTableEl.innerHTML = "";
  renderLayout();
  updateSummary();
}

armsEl.addEventListener("input", () => {
  lastBest = null;
  lastRecord = null;
  movedIds = new Map();
  applyBestEl.disabled = true;
  exportCsvEl.disabled = true;
  updateSummary();
});

[systemVoltageEl, voltageBasisEl, frequencyEl, nominalCapEl].forEach((el) => {
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
  const swapPairs = Number.parseInt(swapPairsEl.value, 10);
  renderOptimization(optimizeLayout(capacitors, swapPairs));
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
  applyBestEl.disabled = true;
  renderLayout();
  updateSummary();
});

exportCsvEl.addEventListener("click", exportRecord);
document.querySelector("#loadExample").addEventListener("click", loadExample);
document.querySelector("#resetAll").addEventListener("click", resetAll);

resetAll();
