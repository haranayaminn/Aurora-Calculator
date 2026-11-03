"use strict";

/* =========================
   1. 共通設定・保存
   ========================= */
const STORAGE_KEYS = {
  history: "aurora-calculator-history-v2",
  theme: "aurora-calculator-theme-v2",
  angle: "aurora-calculator-angle-v2",
  memory: "aurora-calculator-memory-v2",
  answer: "aurora-calculator-answer-v2"
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const CUSTOM_FUNCTIONS_KEY = "aurora-calculator-custom-functions-v1";
let customFunctions = readSaved(CUSTOM_FUNCTIONS_KEY, []);
if (!Array.isArray(customFunctions)) customFunctions = [];

function readSaved(key, fallback) {
  try {
    const stored = localStorage.getItem(key);
    return stored === null ? fallback : JSON.parse(stored);
  } catch (error) {
    return fallback;
  }
}

function saveValue(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    return false;
  }
}

// 履歴の保存データは古い版・途中で壊れたデータも想定して検証する。
// 不正な要素があっても、履歴描画で例外が起きない形へ正規化する。
function normalizeHistoryEntries(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry)
      && typeof entry.expression === "string"
      && typeof entry.result === "string")
    .slice(0, 100)
    .map((entry) => {
      const parsedDate = typeof entry.createdAt === "string" ? Date.parse(entry.createdAt) : NaN;
      return {
        expression: entry.expression.slice(0, 1000),
        result: entry.result.slice(0, 1000),
        kind: typeof entry.kind === "string" ? entry.kind.slice(0, 100) : "通常計算",
        favorite: entry.favorite === true,
        createdAt: Number.isFinite(parsedDate) ? new Date(parsedDate).toISOString() : new Date(0).toISOString()
      };
    });
}

function showMessage(selector, message, isError = false) {
  const target = $(selector);
  if (!target) return;
  target.textContent = message;
  target.classList.toggle("error-message", isError);
}

// 入力欄へフォーカスを戻す際、ブラウザーがその位置まで画面を
// 自動スクロールしないようにする。特に下部のテンキー操作で重要。
function focusWithoutScroll(element) {
  if (!element || typeof element.focus !== "function") return;
  const x = window.scrollX;
  const y = window.scrollY;
  try {
    element.focus({ preventScroll: true });
  } catch (error) {
    element.focus();
    window.scrollTo(x, y);
  }
}

function formatNumber(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("有限の数値として計算できません。");
  }
  if (Object.is(value, -0)) value = 0;
  const rounded = Number(value.toPrecision(12));
  return String(rounded);
}

function parseRequiredNumber(selector, label) {
  const raw = $(selector).value.trim();
  if (raw === "") throw new Error(`${label}を入力してください。`);
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${label}には有効な数値を入力してください。`);
  return value;
}

function downloadText(filename, contents, mimeType) {
  const blob = new Blob([contents], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function timestampForFile() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/* =========================
   2. 計算式パーサー
   eval() は使わず、対応する文法だけを解析する
   ========================= */
class ExpressionParser {
  constructor(source, options = {}) {
    this.complexMode = options.complexMode === true;
    this.customDepth = Number(options.customDepth || 0);
    this.piValue = Number.isFinite(options.piValue) ? options.piValue : Math.PI;
    if (String(source).length > 500) throw new Error("計算式が長すぎます（500文字以内にしてください）。");
    this.source = String(source)
      .replace(/[×✕]/g, "*").replace(/[÷]/g, "/").replace(/[−–]/g, "-")
      .replace(/π/g, "pi").replace(/√/g, "sqrt").replace(/θ/g, "x")
      .replace(/\bAns\b/gi, "ans");
    this.tokens = this.tokenize(this.source);
    this.position = 0;
    this.angleMode = options.angleMode || "DEG";
    this.ans = Number(options.ans ?? 0);
    this.x = Number(options.x ?? 0);
    this.y = Number(options.y ?? 0);
  }
  tokenize(source) {
    const tokens = [];
    let index = 0;
    while (index < source.length) {
      const char = source[index];
      if (/\s/.test(char)) { index += 1; continue; }
      const rest = source.slice(index);
      const numberMatch = rest.match(/^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i);
      if (numberMatch) { tokens.push({ type: "number", value: Number(numberMatch[0]) }); index += numberMatch[0].length; if (tokens.length > 300) throw new Error("計算式の要素が多すぎます。"); continue; }
      const identifierMatch = rest.match(/^[a-zA-Z_][a-zA-Z_0-9]*/);
      if (identifierMatch) { tokens.push({ type: "identifier", value: identifierMatch[0].toLowerCase() }); index += identifierMatch[0].length; if (tokens.length > 300) throw new Error("計算式の要素が多すぎます。"); continue; }
      if ("+-*/^()%!,".includes(char)) { tokens.push({ type: "symbol", value: char }); index += 1; if (tokens.length > 300) throw new Error("計算式の要素が多すぎます。"); continue; }
      throw new Error(`使えない文字「${char}」があります。`);
    }
    // 暗黙の乗算：2pi、2(3+4)、(a+b)(c+d)、2sin(30) などを * と同じに扱う。
    const functionNames = new Set(["sqrt","abs","sin","cos","tan","asin","acos","atan","log","ln","exp","floor","ceil","round", ...customFunctions.map(item => item.name)]);
    const expanded = [];
    const endsValue = (t) => t && (t.type === "number" || t.value === ")" || (t.type === "identifier" && !functionNames.has(t.value)));
    const startsValue = (t) => t && (t.type === "number" || t.value === "(" || t.type === "identifier");
    for (let i = 0; i < tokens.length; i++) {
      const current = tokens[i], previous = expanded[expanded.length - 1];
      const isFunctionCall = previous?.type === "identifier" && functionNames.has(previous.value) && current.value === "(";
      if (endsValue(previous) && startsValue(current) && !isFunctionCall) expanded.push({ type: "symbol", value: "*" });
      expanded.push(current);
    }
    return expanded;
  }
  peek(value = null) { const token = this.tokens[this.position]; return value === null ? token : token?.value === value; }
  take(value = null) { const token = this.peek(); if (!token || (value !== null && token.value !== value)) return null; this.position += 1; return token; }
  expect(value) { if (!this.take(value)) throw new Error(`「${value}」が必要です。`); }
  parse() {
    if (!this.tokens.length) throw new Error("計算式を入力してください。");
    const result = this.parseExpression();
    if (this.position < this.tokens.length) throw new Error(`「${this.peek().value}」の前後を確認してください。`);
    if (this.complexMode && isComplexValue(result)) {
      if (![result.re, result.im].every(Number.isFinite)) throw new Error("結果が有限の複素数になりません。");
      if (Math.abs(result.im) < 1e-12) return Object.is(result.re, -0) ? 0 : result.re;
      return Math.abs(result.re) < 1e-14 ? complex(0, result.im) : result;
    }
    if (!Number.isFinite(result)) throw new Error("結果が有限の数値になりません。");
    return Object.is(result, -0) ? 0 : result;
  }
  parseExpression() {
    let value = this.parseTerm();
    while (this.peek("+") || this.peek("-")) {
      const op = this.take().value, right = this.parseTerm();
      value = this.complexMode ? (op === "+" ? cAdd(value, right) : cSub(value, right)) : (op === "+" ? value + right : value - right);
    }
    return value;
  }
  parseTerm() {
    let value = this.parseUnary();
    while (this.peek("*") || this.peek("/")) {
      const op = this.take().value;
      const right = this.parseUnary();
      if (!this.complexMode && op === "/" && right === 0) throw new Error("0では割れません。");
      value = this.complexMode ? (op === "*" ? cMul(value, right) : cDiv(value, right)) : (op === "*" ? value * right : value / right);
    }
    return value;
  }
  parseUnary() {
    if (this.take("+")) return this.parseUnary();
    if (this.take("-")) { const v = this.parseUnary(); return this.complexMode ? cScale(v, -1) : -v; }
    return this.parsePower();
  }
  parsePower() {
    let value = this.parsePostfix();
    if (this.take("^")) {
      const exponent = this.parseUnary();
      value = this.complexMode ? cPow(value, exponent) : Math.pow(value, exponent);
    }
    return value;
  }
  parsePostfix() {
    let value = this.parsePrimary();
    while (this.peek("!") || this.peek("%")) {
      const suffix = this.take().value;
      if (suffix === "!") {
        if (this.complexMode && isComplexValue(value) && Math.abs(value.im) > 1e-12) throw new Error("複素数の階乗には対応していません。");
        value = this.factorial(realPart(value));
      } else value = this.complexMode ? cScale(value, 0.01) : value / 100;
    }
    return value;
  }
  parsePrimary() {
    const token = this.peek();
    if (!token) throw new Error("数値や括弧が足りません。");
    if (token.type === "number") { this.position += 1; return token.value; }
    if (this.take("(")) { const v = this.parseExpression(); this.expect(")"); return v; }
    if (token.type === "identifier") {
      this.position += 1; const name = token.value;
      if (name === "pi") return this.piValue;
      if (name === "e") return Math.E;
      if (name === "i" && this.complexMode) return complex(0, 1);
      if (name === "ans") return this.ans;
      if (name === "x" || name === "theta") return this.x;
      if (name === "y") return this.y;
      if (this.take("(")) { const arg = this.parseExpression(); this.expect(")"); return this.callFunction(name, arg); }
      throw new Error(`定数または関数「${name}」を認識できません。関数には括弧を付けてください。`);
    }
    throw new Error(`「${token.value}」の使い方を確認してください。`);
  }
  factorial(value) {
    if (!Number.isInteger(value) || value < 0) throw new Error("階乗は0以上の整数で計算します。");
    if (value > 170) throw new Error("階乗の入力が大きすぎます（170以下にしてください）。");
    let result = 1; for (let n = 2; n <= value; n += 1) result *= n; return result;
  }
  callFunction(name, value) {
    const toRad = (v) => this.angleMode === "DEG" ? v * Math.PI / 180 : v;
    const fromRad = (v) => this.angleMode === "DEG" ? v * 180 / Math.PI : v;
    if (this.complexMode) {
      const z = toComplex(value), a = z.re, b = z.im, r = Math.hypot(a, b), arg = Math.atan2(b, a);
      const trigArg = this.angleMode === "DEG" ? Math.PI / 180 : 1;
      if (name === "sqrt") return b === 0 && a >= 0 ? Math.sqrt(a) : complex(Math.sqrt(Math.max(0,(r+a)/2)), Math.sign(b || 1)*Math.sqrt(Math.max(0,(r-a)/2)));
      if (name === "abs") return r;
      if (name === "exp") return complex(Math.exp(a)*Math.cos(b), Math.exp(a)*Math.sin(b));
      if (name === "ln") { if (r === 0) throw new Error("ln(0)は定義できません。"); return complex(Math.log(r), Math.abs(Math.abs(arg) - Math.PI) < 1e-14 ? Math.PI : arg); }
      if (name === "log") { if (r === 0) throw new Error("log(0)は定義できません。"); return cScale(complex(Math.log(r), Math.abs(Math.abs(arg) - Math.PI) < 1e-14 ? Math.PI : arg), 1/Math.LN10); }
      if (name === "sin") return complex(Math.sin(a*trigArg)*Math.cosh(b*trigArg), Math.cos(a*trigArg)*Math.sinh(b*trigArg));
      if (name === "cos") return complex(Math.cos(a*trigArg)*Math.cosh(b*trigArg), -Math.sin(a*trigArg)*Math.sinh(b*trigArg));
      if (name === "tan") return cDiv(this.callFunction("sin", value), this.callFunction("cos", value));
      if (["asin","acos","atan","floor","ceil","round"].includes(name) && Math.abs(b) > 1e-12) throw new Error(`${name}は実数入力にのみ対応しています。`);
      if (name === "asin") return fromRad(Math.asin(a));
      if (name === "acos") return fromRad(Math.acos(a));
      if (name === "atan") return fromRad(Math.atan(a));
      if (name === "floor") return Math.floor(a);
      if (name === "ceil") return Math.ceil(a);
      if (name === "round") return Math.round(a);
    }
    const n = Number(value);
    const funcs = {
      sqrt: v => { if (v < 0) throw new Error("負の数の平方根には、メイン電卓で i を使ってください。"); return Math.sqrt(v); },
      abs: Math.abs, sin: v => Math.sin(toRad(v)), cos: v => Math.cos(toRad(v)),
      tan: v => { const rad=toRad(v); if(Math.abs(Math.cos(rad))<1e-12) throw new Error("この角度のtanは定義できません。"); return Math.tan(rad); },
      asin: v => fromRad(Math.asin(v)), acos: v => fromRad(Math.acos(v)), atan: v => fromRad(Math.atan(v)),
      log: v => { if(v<=0) throw new Error("logの入力は0より大きくしてください。"); return Math.log10(v); },
      ln: v => { if(v<=0) throw new Error("lnの入力は0より大きくしてください。"); return Math.log(v); },
      exp: Math.exp, floor: Math.floor, ceil: Math.ceil, round: Math.round
    };
    if (Object.hasOwn(funcs,name)) return funcs[name](n);
    const custom = customFunctions.find(item => item.name === name);
    if (custom) {
      if (this.customDepth >= 8) throw new Error("自作関数の呼び出しが深すぎます（再帰を確認してください）。");
      return evaluateExpression(custom.expression, { angleMode: this.angleMode, ans: this.ans, x: n, y: this.y, customDepth: this.customDepth + 1 });
    }
    throw new Error(`関数「${name}」には対応していません。`);
  }
}

function isComplexValue(v) { return Boolean(v && typeof v === "object" && Number.isFinite(v.re) && Number.isFinite(v.im)); }
function toComplex(v) { return isComplexValue(v) ? v : complex(Number(v), 0); }
function realPart(v) { return isComplexValue(v) ? v.re : Number(v); }
function cAdd(a,b) { a=toComplex(a); b=toComplex(b); return complex(a.re+b.re,a.im+b.im); }
function cSub(a,b) { a=toComplex(a); b=toComplex(b); return complex(a.re-b.re,a.im-b.im); }
function cScale(a,s) { a=toComplex(a); return complex(a.re*s,a.im*s); }
function cMul(a,b) { a=toComplex(a); b=toComplex(b); return complex(a.re*b.re-a.im*b.im,a.re*b.im+a.im*b.re); }
function cDiv(a,b) { a=toComplex(a); b=toComplex(b); const d=b.re*b.re+b.im*b.im; if(d===0) throw new Error("0では割れません。"); return complex((a.re*b.re+a.im*b.im)/d,(a.im*b.re-a.re*b.im)/d); }
function cPow(a,b) {
  a=toComplex(a); b=toComplex(b);
  if (Math.abs(b.im)<1e-14 && Math.abs(a.im)<1e-14 && (a.re>=0 || Number.isInteger(b.re))) return Math.pow(a.re,b.re);
  const r=Math.hypot(a.re,a.im); if(r===0 && b.re>0 && Math.abs(b.im)<1e-14) return 0;
  if(r===0) throw new Error("0のこの複素数べき乗は定義できません。");
  const logz=complex(Math.log(r),Math.atan2(a.im,a.re));
  const w=cMul(b,logz), scale=Math.exp(w.re);
  return complex(scale*Math.cos(w.im),scale*Math.sin(w.im));
}

function evaluateExpression(source, options = {}) {
  const parser = new ExpressionParser(source, options);
  const result = parser.parse();
  if (isComplexValue(result) || !Number.isFinite(result)) throw new Error("この計算では実数の結果が必要です。");
  return result;
}
function evaluateMainExpression(source, options = {}) {
  return new ExpressionParser(source, { ...options, complexMode: true }).parse();
}

/* =========================
   3. メイン電卓・履歴・メモリー
   ========================= */
const storedHistory = readSaved(STORAGE_KEYS.history, []);
let history = normalizeHistoryEntries(storedHistory);
// 正規化で除外・修復した要素をブラウザー内にも保存し直す。
if (JSON.stringify(storedHistory) !== JSON.stringify(history)) {
  saveValue(STORAGE_KEYS.history, history);
}
let angleMode = readSaved(STORAGE_KEYS.angle, "DEG");
if (!['DEG', 'RAD'].includes(angleMode)) angleMode = "DEG";
let memoryValue = Number(readSaved(STORAGE_KEYS.memory, 0)) || 0;
let answerValue = Number(readSaved(STORAGE_KEYS.answer, 0)) || 0;

$("#angleMode").value = angleMode;
$("#memoryStatus").textContent = `メモリー: ${formatNumber(memoryValue)}`;

function currentExpressionResult() {
  return evaluateExpression($("#expressionInput").value, { angleMode, ans: answerValue });
}

function renderHistory() {
  const list = $("#historyList");
  list.replaceChildren();
  if (history.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "まだ計算履歴はありません。";
    list.appendChild(empty);
    return;
  }
  const search = (document.querySelector("#historySearch")?.value || "").trim().toLowerCase();
  const filter = document.querySelector("#historyFilter")?.value || "all";
  const visible = history.filter((entry) => {
    const matchesSearch = !search || `${entry.expression} ${entry.result} ${entry.kind || ""}`.toLowerCase().includes(search);
    const matchesFilter = filter !== "favorite" || entry.favorite === true;
    return matchesSearch && matchesFilter;
  }).slice(0, 200);
  visible.forEach((entry) => {
    const article = document.createElement("article");
    article.className = "history-entry";
    const expression = document.createElement("p");
    expression.className = "history-expression";
    expression.textContent = entry.expression;
    const result = document.createElement("p");
    result.className = "history-result";
    result.textContent = `= ${entry.result}`;
    const meta = document.createElement("p");
    meta.className = "history-meta";
    meta.textContent = `${entry.kind || "通常計算"} · ${new Date(entry.createdAt).toLocaleString()}`;
    const actions = document.createElement("div");
    actions.className = "history-actions";
    const reuseButton = document.createElement("button");
    reuseButton.type = "button";
    reuseButton.textContent = "式を再利用";
    reuseButton.disabled = Boolean(entry.kind && entry.kind !== "通常計算");
    if(reuseButton.disabled) reuseButton.title = "この履歴は通常の計算式ではありません。";
    reuseButton.addEventListener("click", () => {
      $("#expressionInput").value = entry.expression;
      focusWithoutScroll($("#expressionInput"));
    });
    const answerButton = document.createElement("button");
    answerButton.type = "button";
    answerButton.textContent = "結果をAnsへ";
    const historyNumber = Number(entry.result);
    const historyIsNumeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(entry.result.trim());
    answerButton.disabled = !historyIsNumeric;
    if(answerButton.disabled) answerButton.title = "数値だけの結果ではないためAnsに設定できません。";
    answerButton.addEventListener("click", () => {
      if(!historyIsNumeric) return;
      answerValue = Number.isFinite(historyNumber) ? historyNumber : 0;
      saveValue(STORAGE_KEYS.answer, answerValue);
      auroraAnswerText = entry.result;
      saveValue(AURORA_EXT_KEYS.answerText, auroraAnswerText);
      $("#expressionInput").value = "Ans";
      focusWithoutScroll($("#expressionInput"));
      showMessage("#calculatorMessage", "履歴の結果をAnsに設定しました。");
    });
    const favoriteButton = document.createElement("button");
    favoriteButton.type = "button";
    favoriteButton.className = "history-favorite";
    favoriteButton.textContent = entry.favorite ? "★ お気に入り解除" : "☆ お気に入り";
    favoriteButton.addEventListener("click", () => {
      entry.favorite = !entry.favorite;
      saveValue(STORAGE_KEYS.history, history);
      renderHistory();
    });
    actions.append(reuseButton, answerButton, favoriteButton);
    article.append(expression, result, meta, actions);
    list.appendChild(article);
  });
}

function addHistory(expression, result, kind = "通常計算") {
  const resultText = typeof result === "number" ? formatNumber(result) : String(result);
  history.unshift({ expression, result: resultText, kind, favorite: false, createdAt: new Date().toISOString() });
  history = history.slice(0, 100);
  const saved = saveValue(STORAGE_KEYS.history, history);
  renderHistory();
  if (!saved) showMessage("#backupMessage", "ブラウザーの保存領域に書き込めません。JSONバックアップを保存してください。", true);
}

function calculateMain() {
  const expression = $("#expressionInput").value.trim();
  try {
    const result = evaluateMainExpression(expression, { angleMode, ans: answerValue });
    const formatted = isComplexValue(result) ? formatComplex(result) : formatNumber(result);
    $("#mainResult").textContent = formatted;
    renderPiAlternatives(expression, result);
    if (typeof result === "number") {
      answerValue = result;
      saveValue(STORAGE_KEYS.answer, answerValue);
    } else {
      showMessage("#calculatorMessage", "複素数で計算しました。Ans・メモリーは実数の前回値を保持しています。");
    }
    addHistory(expression, formatted);
    if (typeof result === "number") showMessage("#calculatorMessage", "計算できました。");
    return result;
  } catch (error) {
    showMessage("#calculatorMessage", error.message || "計算できませんでした。", true);
    return null;
  }
}

const expressionInputElement = $("#expressionInput");
let rememberedExpressionValue = expressionInputElement?.value || "";
let rememberedExpressionSelection = {
  start: expressionInputElement?.selectionStart ?? rememberedExpressionValue.length,
  end: expressionInputElement?.selectionEnd ?? rememberedExpressionValue.length
};

function rememberExpressionSelection(force = false) {
  const input = expressionInputElement;
  if (!input || (!force && document.activeElement !== input)) return;
  rememberedExpressionValue = input.value;
  rememberedExpressionSelection = {
    start: input.selectionStart ?? input.value.length,
    end: input.selectionEnd ?? input.value.length
  };
}

function getExpressionSelection() {
  const input = expressionInputElement;
  if (!input) return { start: 0, end: 0 };
  if (document.activeElement === input) rememberExpressionSelection();
  // A different feature may have replaced the expression directly. In that
  // case, start new button input at the end rather than reusing a stale range.
  if (rememberedExpressionValue !== input.value) {
    rememberedExpressionValue = input.value;
    rememberedExpressionSelection = { start: input.value.length, end: input.value.length };
  }
  const start = Math.max(0, Math.min(input.value.length, rememberedExpressionSelection.start));
  const end = Math.max(start, Math.min(input.value.length, rememberedExpressionSelection.end));
  return { start, end };
}

function setExpressionSelection(start, end = start) {
  const input = expressionInputElement;
  if (!input) return;
  const safeStart = Math.max(0, Math.min(input.value.length, start));
  const safeEnd = Math.max(safeStart, Math.min(input.value.length, end));
  rememberedExpressionValue = input.value;
  rememberedExpressionSelection = { start: safeStart, end: safeEnd };
  try { input.setSelectionRange(safeStart, safeEnd); } catch (error) { /* Keep the remembered range for unsupported input types. */ }
}

if (expressionInputElement) {
  ["input", "keyup", "click", "select"].forEach(type => {
    expressionInputElement.addEventListener(type, () => rememberExpressionSelection());
  });
  expressionInputElement.addEventListener("blur", () => rememberExpressionSelection(true));
  document.addEventListener("selectionchange", () => {
    if (document.activeElement === expressionInputElement) rememberExpressionSelection();
  });
}

function insertAtCursor(text, options = {}) {
  const input = expressionInputElement;
  if (!input) return;
  const { start, end } = getExpressionSelection();
  input.value = input.value.slice(0, start) + text + input.value.slice(end);
  const next = start + text.length;
  setExpressionSelection(next);
  // The on-screen keypad deliberately does not refocus the input. This avoids
  // browser auto-scrolling while still tracking the caret across button taps.
  if (options.focus === true) focusWithoutScroll(input);
}

function toggleSign(options = {}) {
  const input = expressionInputElement;
  if (!input) return;
  const value = input.value.trim();
  if (!value) {
    input.value = "-";
  } else if (value.startsWith("- (") && value.endsWith(")")) {
    input.value = value.slice(3, -1);
  } else if (value.startsWith("-(") && value.endsWith(")")) {
    input.value = value.slice(2, -1);
  } else {
    input.value = `-(${value})`;
  }
  setExpressionSelection(input.value.length);
  if (options.focus === true) focusWithoutScroll(input);
}

function handleCalculatorInsertButton(event) {
  const button = event.target.closest("button[data-insert]");
  if (!button) return;
  insertAtCursor(button.dataset.insert);
}

$("#keypad").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.insert !== undefined) {
    insertAtCursor(button.dataset.insert);
    return;
  }
  const action = button.dataset.action;
  if (action === "clear") {
    $("#expressionInput").value = "";
    setExpressionSelection(0);
    $("#mainResult").textContent = "0";
    showMessage("#calculatorMessage", "");
  } else if (action === "backspace") {
    const input = expressionInputElement;
    const { start, end } = getExpressionSelection();
    if (start !== end) {
      input.value = input.value.slice(0, start) + input.value.slice(end);
      setExpressionSelection(start);
    } else if (start > 0) {
      input.value = input.value.slice(0, start - 1) + input.value.slice(start);
      setExpressionSelection(start - 1);
    }
  } else if (action === "equals") {
    calculateMain();
  } else if (action === "sign") {
    toggleSign();
  }
});

// Quick-function chips are also physical calculator buttons. Keep their
// insertion behavior identical to the main keypad without moving page focus.
$(".quick-functions")?.addEventListener("click", handleCalculatorInsertButton);

$("#expressionInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    calculateMain();
  } else if (event.key === "Escape") {
    $("#expressionInput").value = "";
    $("#mainResult").textContent = "0";
    showMessage("#calculatorMessage", "");
  }
});

$("#clearHistory").addEventListener("click", () => {
  if (!confirm("計算履歴をすべて消去しますか？この操作は元に戻せません。")) return;
  history = [];
  saveValue(STORAGE_KEYS.history, history);
  renderHistory();
});

["#historySearch", "#historyFilter"].forEach((selector) => {
  const field = $(selector);
  if (field) field.addEventListener(selector === "#historySearch" ? "input" : "change", renderHistory);
});

$("#angleMode").addEventListener("change", (event) => {
  angleMode = event.target.value;
  saveValue(STORAGE_KEYS.angle, angleMode);
  showMessage("#calculatorMessage", `角度単位を${angleMode}に変更しました。`);
  if ($("#graphTab").classList.contains("active")) drawGraph();
});

function updateMemoryStatus() {
  $("#memoryStatus").textContent = `メモリー: ${formatNumber(memoryValue)}`;
  saveValue(STORAGE_KEYS.memory, memoryValue);
}

$("#memoryClear").addEventListener("click", () => {
  memoryValue = 0;
  updateMemoryStatus();
  showMessage("#calculatorMessage", "メモリーを消去しました。");
});
$("#memoryRecall").addEventListener("click", () => {
  insertAtCursor(formatNumber(memoryValue));
  showMessage("#calculatorMessage", "メモリーの値を式に入力しました。");
});
$("#memoryAdd").addEventListener("click", () => {
  try { memoryValue += currentExpressionResult(); updateMemoryStatus(); showMessage("#calculatorMessage", "計算値をメモリーに加算しました。"); }
  catch (error) { showMessage("#calculatorMessage", error.message, true); }
});
$("#memorySubtract").addEventListener("click", () => {
  try { memoryValue -= currentExpressionResult(); updateMemoryStatus(); showMessage("#calculatorMessage", "計算値をメモリーから減算しました。"); }
  catch (error) { showMessage("#calculatorMessage", error.message, true); }
});
$("#memoryStore").addEventListener("click", () => {
  try { memoryValue = currentExpressionResult(); updateMemoryStatus(); showMessage("#calculatorMessage", "計算値をメモリーに保存しました。"); }
  catch (error) { showMessage("#calculatorMessage", error.message, true); }
});

/* =========================
   4. テーマ・タブ切り替え
   ========================= */
function setTheme(theme) {
  const isDark = theme === "dark";
  document.body.classList.toggle("dark", isDark);
  const appearance = readSaved("aurora-calculator-ui-settings-v1", {});
  document.body.style.setProperty("--ui-page", isDark ? "#111827" : (appearance.pageColor || "#eef3fb"));
  $("#themeToggle").textContent = isDark ? "☀️ ライトモード" : "🌙 ダークモード";
  $("#themeToggle").setAttribute("aria-pressed", String(isDark));
  saveValue(STORAGE_KEYS.theme, theme);
  if ($("#graphTab").classList.contains("active")) drawGraph();
}

$("#themeToggle").addEventListener("click", () => {
  setTheme(document.body.classList.contains("dark") ? "light" : "dark");
});
setTheme(readSaved(STORAGE_KEYS.theme, "light"));

$$(".tab-button").forEach((button) => {
  button.addEventListener("click", () => {
    $$(".tab-button").forEach((item) => item.classList.toggle("active", item === button));
    $$(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.id === button.dataset.tab));
    if (button.dataset.tab === "graphTab") drawGraph();
  });
});

/* =========================
   5. バックアップ・CSV
   ========================= */
$("#exportBackup").addEventListener("click", () => {
  const backup = {
    format: "aurora-calculator-backup",
    version: 5,
    exportedAt: new Date().toISOString(),
    history,
    memoryValue,
    answerValue,
    angleMode,
    theme: document.body.classList.contains("dark") ? "dark" : "light",
    uiSettings: readSaved("aurora-calculator-ui-settings-v1", { skin: "aurora", scale: 1, pageColor: "#eef3fb" }),
    ...getAuroraDatabaseBackup()
  };
  downloadText(`aurora-calculator-backup-${timestampForFile()}.json`, JSON.stringify(backup, null, 2), "application/json");
  showMessage("#backupMessage", "JSONバックアップを保存しました。");
});

$("#importBackupButton").addEventListener("click", () => $("#importBackupFile").click());
$("#importBackupFile").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    if (file.size > 5 * 1024 * 1024) throw new Error("バックアップは5MB以下のファイルを選択してください。");
    const data = JSON.parse(await file.text());
    if (!data || data.format !== "aurora-calculator-backup" || !Array.isArray(data.history)) {
      throw new Error("このアプリのバックアップファイルではありません。");
    }
    if (!confirm("現在の履歴とメモリーを、バックアップの内容で置き換えますか？")) return;
    history = normalizeHistoryEntries(data.history);
    memoryValue = Number.isFinite(Number(data.memoryValue)) ? Number(data.memoryValue) : 0;
    answerValue = Number.isFinite(Number(data.answerValue)) ? Number(data.answerValue) : 0;
    angleMode = data.angleMode === "RAD" ? "RAD" : "DEG";
    saveValue(STORAGE_KEYS.history, history);
    saveValue(STORAGE_KEYS.memory, memoryValue);
    saveValue(STORAGE_KEYS.answer, answerValue);
    saveValue(STORAGE_KEYS.angle, angleMode);
    $("#angleMode").value = angleMode;
    updateMemoryStatus();
    renderHistory();
    if (data.theme === "dark" || data.theme === "light") setTheme(data.theme);
    if (data.uiSettings) { const saved = { skin: data.uiSettings.skin, scale: data.uiSettings.scale, pageColor: data.uiSettings.pageColor }; saveValue("aurora-calculator-ui-settings-v1", saved); if (typeof applyUiSettings === "function") applyUiSettings(saved); }
    applyAuroraDatabaseBackup(data.auroraDatabase);
    showMessage("#backupMessage", "バックアップを復元しました。");
  } catch (error) {
    showMessage("#backupMessage", error.message || "バックアップを読み込めませんでした。", true);
  } finally {
    event.target.value = "";
  }
});

function csvEscape(value) {
  const stringValue = String(value ?? "");
  return `"${stringValue.replace(/"/g, '""')}"`;
}

$("#exportCsv").addEventListener("click", () => {
  if (history.length === 0) {
    showMessage("#backupMessage", "CSVに出力する履歴がありません。", true);
    return;
  }
  const rows = [["計算式", "結果", "日時"], ...history.map((item) => [item.expression, item.result, item.createdAt])];
  const csv = "\uFEFF" + rows.map((row) => row.map(csvEscape).join(",")).join("\r\n");
  downloadText(`aurora-calculator-history-${timestampForFile()}.csv`, csv, "text/csv");
  showMessage("#backupMessage", "CSVファイルを保存しました。");
});

/* =========================
   6. 進数変換
   ========================= */
$("#convertBase").addEventListener("click", () => {
  const raw = $("#baseInput").value.trim().replaceAll("_", "");
  const base = Number($("#baseFrom").value);
  const resultBox = $("#baseResults");
  if (!raw) { resultBox.textContent = "数値を入力してください。"; return; }
  const value = Number.parseInt(raw, base);
  if (!Number.isSafeInteger(value) || Number(value).toString(base) !== raw.toLowerCase().replace(/^0+(?=\w)/, "")) {
    resultBox.textContent = "選択した進数の整数を入力してください（安全に扱える整数の範囲内）。";
    return;
  }
  resultBox.textContent = `10進数：${value}\n2進数：${value.toString(2)}\n8進数：${value.toString(8)}\n16進数：${value.toString(16).toUpperCase()}`;
});

/* =========================
   7. 税込・割引・割合計算
   ========================= */
function readPercentValues() {
  const amount = parseRequiredNumber("#priceInput", "元の金額・数値");
  const percent = parseRequiredNumber("#percentInput", "税率・割合");
  if (percent < 0) throw new Error("税率・割合は0以上にしてください。");
  return { amount, percent };
}

$("#calcTax").addEventListener("click", () => {
  try {
    const { amount, percent } = readPercentValues();
    $("#percentResults").textContent = `税額：${formatNumber(amount * percent / 100)}\n税込金額：${formatNumber(amount * (1 + percent / 100))}`;
  } catch (error) { $("#percentResults").textContent = error.message; }
});
$("#calcDiscount").addEventListener("click", () => {
  try {
    const { amount, percent } = readPercentValues();
    if (percent > 100) throw new Error("割引率は100%以下にしてください。");
    $("#percentResults").textContent = `割引額：${formatNumber(amount * percent / 100)}\n割引後の金額：${formatNumber(amount * (1 - percent / 100))}`;
  } catch (error) { $("#percentResults").textContent = error.message; }
});
$("#calcPercentOf").addEventListener("click", () => {
  try {
    const { amount, percent } = readPercentValues();
    $("#percentResults").textContent = `${formatNumber(amount)} の ${formatNumber(percent)}%：${formatNumber(amount * percent / 100)}`;
  } catch (error) { $("#percentResults").textContent = error.message; }
});
$("#calcPercentReverse").addEventListener("click", () => {
  try {
    const amount = parseRequiredNumber("#priceInput", "割合を調べる数値");
    const base = parseRequiredNumber("#percentBaseInput", "比較対象");
    if (base === 0) throw new Error("比較対象が0の場合、割合は計算できません。");
    $("#percentResults").textContent = `${formatNumber(amount)} は ${formatNumber(base)} の ${formatNumber(amount / base * 100)}%`;
  } catch (error) { $("#percentResults").textContent = error.message; }
});

/* =========================
   8. 総合単位変換エンジン V10
   ========================= */
const DIM = {
  dimensionless:[0,0,0,0,0,0,0], length:[0,1,0,0,0,0,0], mass:[1,0,0,0,0,0,0], time:[0,0,1,0,0,0,0],
  area:[0,2,0,0,0,0,0], volume:[0,3,0,0,0,0,0], speed:[0,1,-1,0,0,0,0], acceleration:[0,1,-2,0,0,0,0],
  angularSpeed:[0,0,-1,0,0,0,0], force:[1,1,-2,0,0,0,0], energy:[1,2,-2,0,0,0,0], power:[1,2,-3,0,0,0,0],
  pressure:[1,-1,-2,0,0,0,0], density:[1,-3,0,0,0,0,0], dynamicViscosity:[1,-1,-1,0,0,0,0],
  kinematicViscosity:[0,2,-1,0,0,0,0], flowVolume:[0,3,-1,0,0,0,0], flowMass:[1,0,-1,0,0,0,0],
  temperature:[0,0,0,0,1,0,0], thermalConductivity:[1,1,-3,0,-1,0,0], specificHeat:[0,2,-2,0,-1,0,0], specificPower:[0,2,-3,0,0,0,0],
  thermalResistance:[-1,0,3,0,1,0,0], molarMass:[1,0,0,0,0,-1,0], data:[0,0,0,0,0,0,0,1], dataRate:[0,0,-1,0,0,0,0,1],
  voltage:[1,2,-3,-1,0,0,0], current:[0,0,0,1,0,0,0], resistance:[1,2,-3,-2,0,0,0], charge:[0,0,1,1,0,0,0],
  capacitance:[-1,-2,4,2,0,0,0], inductance:[1,2,-2,-2,0,0,0], conductance:[-1,-2,3,2,0,0,0],
  magneticFlux:[1,2,-2,-1,0,0,0], magneticFluxDensity:[1,0,-2,-1,0,0,0], magneticField:[0,-1,0,1,0,0,0],
  amount:[0,0,0,0,0,1,0], molarity:[0,-3,0,0,0,1,0], massConcentration:[1,-3,0,0,0,0,0],
  enzymeActivity:[0,0,-1,0,0,1,0], cellConcentration:[0,-3,0,0,0,0,0], osmolality:[0,0,0,0,0,1,0],
  luminousIntensity:[0,0,0,0,0,0,1], luminousFlux:[0,0,0,0,0,0,1], illuminance:[0,-2,0,0,0,0,1],
  luminance:[0,-2,0,0,0,0,1], radioactivity:[0,0,-1,0,0,0,0], dose:[0,2,-2,0,0,0,0],
  doseEquivalent:[0,2,-2,0,0,0,0], pace:[0,-1,1,0,0,0,0], textileLinearDensity:[1,-1,0,0,0,0,0],
  fabricMass:[1,-2,0,0,0,0,0], threadDensity:[0,-1,0,0,0,0,0], resolution:[0,-1,0,0,0,0,0],
  frequency:[0,0,-1,0,0,0,0], container:[0,0,0,0,0,0,0], rainfall:[0,1,0,0,0,0,0],
  soilConductivity:[-1,-3,3,2,0,0,0], airConcentration:[1,-3,0,0,0,0,0]
};
const U=(id,label,symbol,factor=1,extra={})=>({id,label,symbol,factor,...extra});
const C=(id,label,group,base,dimension,units,note="",extra={})=>({id,label,group,base,dimension,units,note,...extra});
const unitCategories = [
  C("length","長さ・距離","基本・日常","m","length",[
    U("m","メートル (m)","m"),U("km","キロメートル (km)","km",1000),U("cm","センチメートル (cm)","cm",.01),U("mm","ミリメートル (mm)","mm",.001),U("um","マイクロメートル (µm)","µm",1e-6),U("nm","ナノメートル (nm)","nm",1e-9),U("in","インチ (in)","in",.0254),U("ft","フィート (ft)","ft",.3048),U("yd","ヤード (yd)","yd",.9144),U("mi","マイル (mi)","mi",1609.344),U("nmi","海里 (nmi)","nmi",1852),U("ly","光年 (ly)","ly",9.4607304725808e15),U("au","天文単位 (au)","au",149597870700),U("pc","パーセク (pc)","pc",3.085677581491367e16),U("kpc","キロパーセク (kpc)","kpc",3.085677581491367e19),U("Mpc","メガパーセク (Mpc)","Mpc",3.085677581491367e22),U("fathom","ファゾム (fathom)","fathom",1.8288),U("chain","チェーン (ch)","ch",20.1168),U("furlong","ハロン (fur)","fur",201.168),U("rod","ロッド (rd)","rd",5.0292),U("league","リーグ (league)","league",4828.032),U("buTrad","分 (尺貫法)","分",.00303),U("sun","寸","寸",.0303),U("shaku","尺","尺",.303),U("ken","間","間",1.818),U("choTrad","町（長さ・代表値）","町",109.09),U("ri","里（代表値）","里",3927.27)
  ],"国際フィート・海里などの代表的定義。測量用旧フィートは別定義です。"),
  C("mass","質量・重さ","基本・日常","kg","mass",[
    U("kg","キログラム (kg)","kg"),U("g","グラム (g)","g",.001),U("mg","ミリグラム (mg)","mg",1e-6),U("ug","マイクログラム (µg)","µg",1e-9),U("t","トン (t)","t",1000),U("lb","ポンド (lb)","lb",.45359237),U("oz","常用オンス (oz)","oz",.028349523125),U("stone","ストーン (st)","st",6.35029318),U("grain","グレーン (gr)","gr",0.00006479891),U("carat","カラット (ct)","ct",.0002),U("troyOz","トロイオンス (ozt)","ozt",.0311034768),U("shortTon","米ショートトン","short ton",907.18474),U("longTon","英ロングトン","long ton",1016.0469088),U("slug","スラグ (slug)","slug",14.59390294),U("amu","原子質量単位 (u)","u",1.66053906660e-27),U("earthMass","地球質量 (M⊕)","M⊕",5.9722e24),U("moonMass","月質量 (M☾)","M☾",7.342e22),U("solarMass","太陽質量 (M☉)","M☉",1.98847e30),U("monme","匁","匁",.00375),U("kinTrad","斤（尺貫法・160匁）","斤",.6),U("kanTrad","貫","貫",3.75),U("hyoTrad","俵（標準参考値）","俵",60)
  ],"トロイオンスは貴金属等の質量単位で、常用オンスとは異なります。"),
  C("time","時間","基本・日常","s","time",[
    U("s","秒 (s)","s"),U("ms","ミリ秒 (ms)","ms",.001),U("us","マイクロ秒 (µs)","µs",1e-6),U("ns","ナノ秒 (ns)","ns",1e-9),U("min","分 (min)","min",60),U("h","時間 (h)","h",3600),U("day","日 (d)","d",86400),U("week","週","week",604800),U("julianYear","ユリウス年","yr",31557600),U("tropicalYear","平均回帰年 (概算)","tropical yr",31556925.2),U("siderealYear","恒星年 (概算)","sidereal yr",31558149.8)
  ],"月・暦年は長さが一定でないため、固定換算単位としては扱いません。"),
  C("temperature","温度・温度差","基本・日常","℃","temperature",[
    U("C","摂氏 (°C)","°C",1,{offset:0}),U("F","華氏 (°F)","°F",5/9,{offset:-32*5/9}),U("K","ケルビン (K)","K",1,{offset:-273.15}),U("R","ランキン (°R)","°R",5/9,{offset:-491.67*5/9})
  ],"温度はオフセット変換です。温度差と絶対温度は意味が異なります。"),
  C("temperatureDifference","温度差","科学","K","temperature",[U("dK","ケルビン差 (ΔK)","ΔK"),U("dC","摂氏温度差 (Δ°C)","Δ°C"),U("dF","華氏温度差 (Δ°F)","Δ°F",5/9)],"温度差専用です。絶対温度の℃・℉変換と異なり、オフセットを加えません。"),
  C("angle","角度","科学","rad","dimensionless",[
    U("rad","ラジアン (rad)","rad"),U("deg","度 (°)","°",Math.PI/180),U("gon","グラード (gon)","gon",Math.PI/200),U("arcmin","分角 (′)","′",Math.PI/10800),U("arcsec","秒角 (″)","″",Math.PI/648000),U("turn","回転 (turn)","turn",2*Math.PI),U("mil","ミル (6400分割回転)","mil",2*Math.PI/6400)
  ]),
  C("area","面積","基本・日常","m²","area",[
    U("m2","平方メートル (m²)","m²"),U("cm2","平方センチメートル (cm²)","cm²",1e-4),U("mm2","平方ミリメートル (mm²)","mm²",1e-6),U("km2","平方キロメートル (km²)","km²",1e6),U("ha","ヘクタール (ha)","ha",1e4),U("a","アール (a)","a",100),U("acre","エーカー (ac)","ac",4046.8564224),U("ft2","平方フィート (ft²)","ft²",.09290304),U("in2","平方インチ (in²)","in²",.00064516),U("mi2","平方マイル (mi²)","mi²",2589988.110336),U("tsubo","坪","坪",3.305785),U("tatami","畳（標準参考値）","畳",1.62),U("seTrad","畝（30坪）","畝",99.17355),U("tanTrad","反・段（300坪）","反",991.7355),U("choTrad","町歩（3000坪）","町歩",9917.355)
  ],"畳の面積は地域・建物規格（京間・江戸間等）で異なるため、ここでは約1.62m²の参考値です。"),
  C("volume","体積・容量","基本・日常","m³","volume",[
    U("m3","立方メートル (m³)","m³"),U("L","リットル (L)","L",.001),U("mL","ミリリットル (mL)","mL",1e-6),U("cm3","立方センチメートル (cm³)","cm³",1e-6),U("in3","立方インチ (in³)","in³",1.6387064e-5),U("ft3","立方フィート (ft³)","ft³",.028316846592),U("yd3","立方ヤード (yd³)","yd³",.764554857984),U("galUS","米ガロン (US gal)","US gal",.003785411784),U("galImp","英ガロン (Imp gal)","Imp gal",.00454609),U("qtUS","米クォート（液量）","US liquid qt",.000946352946),U("ptUS","米パイント（液量）","US liquid pt",.000473176473),U("qtDry","米クォート（乾量）","US dry qt",.001101221),U("ptDry","米パイント（乾量）","US dry pt",.0005506105),U("gillUS","米ジル","US gill",.0001182941),U("gillImp","英ジル","Imp gill",.0001420653),U("flOzUS","米液量オンス","US fl oz",2.95735295625e-5),U("cupUS","米カップ","US cup",.0002365882365),U("cupMetric","メートル法カップ (250mL)","metric cup",.00025),U("tbsp","計量大さじ","tbsp",15e-6),U("tsp","計量小さじ","tsp",5e-6),U("go","合","合",.00018039),U("sho","升","升",.0018039),U("to","斗","斗",.018039),U("koku","石","石",.18039),U("shakuVol","立方尺 (換算値)","立方尺",.027818)
  ],"US/Imperial容量は異なります。日本の合・升等は代表的な尺貫法換算値です。"),
  C("speed","速度","基本・日常","m/s","speed",[
    U("mps","メートル毎秒 (m/s)","m/s"),U("kmh","キロメートル毎時 (km/h)","km/h",1/3.6),U("mph","マイル毎時 (mph)","mph",.44704),U("knot","ノット (kn)","kn",.514444444444),U("fps","フィート毎秒 (ft/s)","ft/s",.3048),U("mach15","マッハ (15°C標準大気近似)","Mach",340.293988/1),U("c","光速比 (c)","c",299792458)
  ],"Machは気温・気圧・気体組成で音速が変わります。ここでは乾燥空気15°Cの近似値340.294m/sを使用。"),
  C("acceleration","加速度","科学","m/s²","acceleration",[
    U("mps2","m/s²","m/s²"),U("g0","標準重力加速度 (g₀)","g₀",9.80665),U("ftps2","ft/s²","ft/s²",.3048),U("gal","ガル (Gal)","Gal",.01)
  ]),
  C("angularSpeed","角速度・回転速度","工学","rad/s","angularSpeed",[
    U("radps","ラジアン毎秒","rad/s"),U("rpm","回転毎分 (rpm)","rpm",2*Math.PI/60),U("rps","回転毎秒 (rps)","rps",2*Math.PI),U("degps","度毎秒 (°/s)","°/s",Math.PI/180),U("degpm","度毎分","°/min",Math.PI/10800)
  ]),
  C("torque","トルク","工学","N·m","energy",[
    U("Nm","ニュートンメートル (N·m)","N·m"),U("kgfm","kgf·m","kgf·m",9.80665),U("lbfft","lbf·ft","lbf·ft",1.3558179483314),U("lbfin","lbf·in","lbf·in",.1129848290276),U("Ncm","N·cm","N·cm",.01)
  ],"トルクとエネルギーは同じ次元ですが、用途・意味は異なります。"),
  C("force","力","科学","N","force",[
    U("N","ニュートン (N)","N"),U("kN","キロニュートン (kN)","kN",1000),U("dyn","ダイン (dyn)","dyn",1e-5),U("kgf","重量キログラム (kgf)","kgf",9.80665),U("lbf","重量ポンド (lbf)","lbf",4.4482216152605),U("tonf","ショートトン重","tonf",8896.443230521)
  ]),
  C("energy","エネルギー・熱量","科学","J","energy",[
    U("J","ジュール (J)","J"),U("kJ","キロジュール (kJ)","kJ",1000),U("MJ","メガジュール (MJ)","MJ",1e6),U("cal","熱化学カロリー (cal)","cal",4.184),U("kcal","キロカロリー (kcal)","kcal",4184),U("Wh","ワット時 (Wh)","Wh",3600),U("kWh","キロワット時 (kWh)","kWh",3.6e6),U("eV","電子ボルト (eV)","eV",1.602176634e-19),U("BTU","BTU (IT)","BTU",1055.05585262),U("thermUS","米サーム","therm",1.054804e8),U("TNTton","TNT換算トン","t TNT",4.184e9)
  ]),
  C("power","仕事率・電力","工学","W","power",[
    U("W","ワット (W)","W"),U("mW","ミリワット (mW)","mW",.001),U("kW","キロワット (kW)","kW",1000),U("MW","メガワット (MW)","MW",1e6),U("GW","ギガワット (GW)","GW",1e9),U("hp","機械馬力 (hp)","hp",745.699871582),U("PS","仏馬力 (PS)","PS",735.49875),U("tonRef","冷凍トン (US refrigeration ton)","RT",3516.8528420667)
  ]),
  C("pressure","圧力・応力","科学","Pa","pressure",[
    U("Pa","パスカル (Pa)","Pa"),U("kPa","キロパスカル (kPa)","kPa",1000),U("MPa","メガパスカル (MPa)","MPa",1e6),U("GPa","ギガパスカル (GPa)","GPa",1e9),U("bar","バール (bar)","bar",1e5),U("mbar","ミリバール (mbar)","mbar",100),U("atm","標準気圧 (atm)","atm",101325),U("psi","psi (lbf/in²)","psi",6894.757293168),U("mmHg","水銀柱ミリメートル (mmHg)","mmHg",133.322387415),U("torr","トル (Torr)","Torr",101325/760),U("cmH2O","水柱cm","cmH₂O",98.0665),U("inH2O","水柱inch","inH₂O",249.08891),U("kgfcm2","kgf/cm²","kgf/cm²",98066.5)
  ]),
  C("density","密度","科学","kg/m³","density",[
    U("kgm3","kg/m³","kg/m³"),U("gcm3","g/cm³","g/cm³",1000),U("kgL","kg/L","kg/L",1000),U("gL","g/L","g/L",1),U("lbft3","lb/ft³","lb/ft³",16.01846337),U("lbgalUS","lb/US gal","lb/US gal",119.8264273)
  ]),
  C("dynamicViscosity","粘度（動粘度ではない）","科学","Pa·s","dynamicViscosity",[
    U("Pas","パスカル秒 (Pa·s)","Pa·s"),U("mPas","ミリパスカル秒 (mPa·s)","mPa·s",.001),U("cP","センチポアズ (cP)","cP",.001),U("P","ポアズ (P)","P",.1),U("lbfts","lb/(ft·s)","lb/(ft·s)",1.48816394)
  ]),
  C("kinematicViscosity","動粘度","科学","m²/s","kinematicViscosity",[
    U("m2s","m²/s","m²/s"),U("St","ストークス (St)","St",1e-4),U("cSt","センチストークス (cSt)","cSt",1e-6),U("mm2s","mm²/s","mm²/s",1e-6)
  ]),
  C("flowVolume","体積流量・風量","工学","m³/s","flowVolume",[
    U("m3s","m³/s","m³/s"),U("Ls","L/s","L/s",.001),U("Lmin","L/min","L/min",1/60000),U("m3h","m³/h","m³/h",1/3600),U("CFM","立方フィート毎分 (CFM)","CFM",.028316846592/60),U("GPM","米ガロン毎分 (gpm)","gpm",.003785411784/60),U("ft3s","ft³/s","ft³/s",.028316846592)
  ]),
  C("flowMass","質量流量","工学","kg/s","flowMass",[
    U("kgs","kg/s","kg/s"),U("kgh","kg/h","kg/h",1/3600),U("th","t/h","t/h",1000/3600),U("lbmin","lb/min","lb/min",.45359237/60),U("lbs","lb/s","lb/s",.45359237)
  ]),
  C("thermalConductivity","熱伝導率","工学","W/(m·K)","thermalConductivity",[
    U("WmK","W/(m·K)","W/(m·K)"),U("kcalmhC","kcal/(m·h·°C)","kcal/(m·h·°C)",1.162222),U("BTUhrftF","BTU/(h·ft·°F)","BTU/(h·ft·°F)",1.730735)
  ]),
  C("specificHeat","比熱容量","工学","J/(kg·K)","specificHeat",[
    U("JkgK","J/(kg·K)","J/(kg·K)"),U("kJkgK","kJ/(kg·K)","kJ/(kg·K)",1000),U("calgC","cal/(g·°C)","cal/(g·°C)",4184),U("BTUlbF","BTU/(lb·°F)","BTU/(lb·°F)",4186.8)
  ]),
  C("thermalResistance","熱抵抗（面積基準）","工学","m²·K/W","thermalResistance",[
    U("m2KW","m²·K/W","m²·K/W"),U("hrft2FBtu","h·ft²·°F/BTU","h·ft²·°F/BTU",.1761101838)
  ]),
  C("temperatureGradient","温度勾配","科学","K/m","temperatureGradient",[
    U("Kpm","K/m","K/m"),U("Cperm","°C/m","°C/m"),U("Fperft","°F/ft","°F/ft",5/9/.3048),U("Kperkm","K/km","K/km",.001)
  ],"温度差の勾配なので、絶対温度のオフセットは使いません。"),
  C("frequency","周波数","科学","Hz","frequency",[
    U("Hz","ヘルツ (Hz)","Hz"),U("kHz","キロヘルツ (kHz)","kHz",1e3),U("MHz","メガヘルツ (MHz)","MHz",1e6),U("GHz","ギガヘルツ (GHz)","GHz",1e9),U("THz","テラヘルツ (THz)","THz",1e12),U("rpmFreq","回転毎分 (rpm)","rpm",1/60)
  ]),
  C("dataStorage","データ容量（10進・2進）","コンピューター","bit","data",[
    U("bit","ビット (bit)","bit"),U("B","バイト (B)","B",8),U("kB","キロバイト (kB)","kB",8000),U("MB","メガバイト (MB)","MB",8e6),U("GB","ギガバイト (GB)","GB",8e9),U("TB","テラバイト (TB)","TB",8e12),U("KiB","キビバイト (KiB)","KiB",8192),U("MiB","メビバイト (MiB)","MiB",8388608),U("GiB","ギビバイト (GiB)","GiB",8589934592),U("TiB","テビバイト (TiB)","TiB",8796093022208)
  ],"kB/MB/GBは1000進、KiB/MiB/GiBは1024進です。"),
  C("dataRate","通信速度・ビットレート","コンピューター","bit/s","dataRate",[
    U("bps","bit/s","bit/s"),U("kbps","kbit/s","kbit/s",1e3),U("Mbps","Mbit/s","Mbit/s",1e6),U("Gbps","Gbit/s","Gbit/s",1e9),U("Bps","byte/s","B/s",8),U("kBps","kB/s","kB/s",8000),U("MBps","MB/s","MB/s",8e6)
  ]),
  C("voltage","電圧","工学","V","voltage",[
    U("V","ボルト (V)","V"),U("mV","ミリボルト (mV)","mV",1e-3),U("uV","マイクロボルト (µV)","µV",1e-6),U("kV","キロボルト (kV)","kV",1e3),U("MV","メガボルト (MV)","MV",1e6)
  ]),
  C("current","電流","工学","A","current",[
    U("A","アンペア (A)","A"),U("mA","ミリアンペア (mA)","mA",1e-3),U("uA","マイクロアンペア (µA)","µA",1e-6),U("nA","ナノアンペア (nA)","nA",1e-9),U("kA","キロアンペア (kA)","kA",1e3)
  ]),
  C("resistance","電気抵抗","工学","Ω","resistance",[
    U("ohm","オーム (Ω)","Ω"),U("mohm","ミリオーム (mΩ)","mΩ",1e-3),U("kohm","キロオーム (kΩ)","kΩ",1e3),U("Mohm","メガオーム (MΩ)","MΩ",1e6)
  ]),
  C("charge","電荷・電気量","工学","C","charge",[
    U("C","クーロン (C)","C"),U("mC","ミリクーロン (mC)","mC",1e-3),U("uC","マイクロクーロン (µC)","µC",1e-6),U("Ah","アンペア時 (Ah)","Ah",3600),U("mAh","ミリアンペア時 (mAh)","mAh",3.6),U("eCharge","電気素量 (e)","e",1.602176634e-19)
  ]),
  C("capacitance","静電容量","工学","F","capacitance",[
    U("F","ファラド (F)","F"),U("mF","ミリファラド (mF)","mF",1e-3),U("uF","マイクロファラド (µF)","µF",1e-6),U("nF","ナノファラド (nF)","nF",1e-9),U("pF","ピコファラド (pF)","pF",1e-12)
  ]),
  C("inductance","インダクタンス","工学","H","inductance",[
    U("H","ヘンリー (H)","H"),U("mH","ミリヘンリー (mH)","mH",1e-3),U("uH","マイクロヘンリー (µH)","µH",1e-6),U("nH","ナノヘンリー (nH)","nH",1e-9)
  ]),
  C("conductance","コンダクタンス","工学","S","conductance",[
    U("S","ジーメンス (S)","S"),U("mS","ミリジーメンス (mS)","mS",1e-3),U("uS","マイクロジーメンス (µS)","µS",1e-6),U("mho","モー (℧)","℧",1)
  ]),
  C("magneticFlux","磁束","工学","Wb","magneticFlux",[
    U("Wb","ウェーバ (Wb)","Wb"),U("mWb","ミリウェーバ (mWb)","mWb",1e-3),U("uWb","マイクロウェーバ (µWb)","µWb",1e-6),U("Mx","マクスウェル (Mx)","Mx",1e-8)
  ]),
  C("magneticFluxDensity","磁束密度","工学","T","magneticFluxDensity",[
    U("T","テスラ (T)","T"),U("mT","ミリテスラ (mT)","mT",1e-3),U("uT","マイクロテスラ (µT)","µT",1e-6),U("G","ガウス (G)","G",1e-4),U("nT","ナノテスラ (nT)","nT",1e-9)
  ]),
  C("magneticField","磁場の強さ","工学","A/m","magneticField",[
    U("Apm","アンペア毎メートル (A/m)","A/m"),U("Oe","エルステッド (Oe)","Oe",1000/(4*Math.PI)),U("kApm","kA/m","kA/m",1000)
  ]),
  C("amount","物質量","化学","mol","amount",[
    U("mol","モル (mol)","mol"),U("kmol","キロモル (kmol)","kmol",1000),U("mmol","ミリモル (mmol)","mmol",1e-3),U("umol","マイクロモル (µmol)","µmol",1e-6),U("nmol","ナノモル (nmol)","nmol",1e-9)
  ]),
  C("molarity","物質量濃度","化学","mol/m³","molarity",[
    U("molL","モル毎リットル (mol/L)","mol/L",1000),U("mmolL","ミリモル毎リットル (mmol/L)","mmol/L",1),U("umolL","マイクロモル毎リットル (µmol/L)","µmol/L",.001),U("molm3","モル毎立方メートル (mol/m³)","mol/m³",1),U("kmolm3","kmol/m³","kmol/m³",1000)
  ],"質量濃度との換算には物質ごとのモル質量が必要です。"),
  C("massConcentration","質量濃度","科学","kg/m³","massConcentration",[
    U("kgm3","kg/m³","kg/m³"),U("gm3","g/m³","g/m³",.001),U("mgm3","mg/m³","mg/m³",1e-6),U("gL","g/L","g/L",1),U("mgL","mg/L","mg/L",.001),U("mgdL","mg/dL","mg/dL",.01),U("ugmL","µg/mL","µg/mL",.001),U("ppmMass","ppm (mg/kg相当・希薄水溶液近似)","ppm",.001)
  ],"ppmは質量比か体積比かで意味が異なります。希薄水溶液近似の項目には条件があります。"),
  C("enzymeActivity","酵素活性濃度","医学・検査","kat/m³","enzymeActivity",[
    U("katm3","kat/m³","kat/m³"),U("nkatL","nkat/L","nkat/L",1e-6),U("UL","U/L","U/L",1.6666666666666667e-5),U("ukatL","µkat/L","µkat/L",.001)
  ],"1 U = 1 µmol/min。検査項目・測定法の解釈は別途確認してください。"),
  C("cellConcentration","細胞数濃度","医学・検査","cells/m³","cellConcentration",[
    U("cellsM3","cells/m³","cells/m³"),U("cellsL","cells/L","cells/L",1000),U("cellsuL","cells/µL","cells/µL",1e9),U("10e9L","10⁹ cells/L","10⁹/L",1e12),U("10e12L","10¹² cells/L","10¹²/L",1e15)
  ]),
  C("osmolality","浸透圧濃度（質量モル濃度）","医学・化学","Osm/kg","osmolality",[
    U("Osmkg","Osm/kg","Osm/kg"),U("mOsmkg","mOsm/kg","mOsm/kg",.001),U("uOsmkg","µOsm/kg","µOsm/kg",1e-6)
  ]),
  C("luminousIntensity","光度","光学","cd","luminousIntensity",[
    U("cd","カンデラ (cd)","cd"),U("kcd","キロカンデラ (kcd)","kcd",1000),U("cp","キャンドルパワー（近似）","cp",.981)
  ]),
  C("luminousFlux","光束","光学","lm","luminousFlux",[
    U("lm","ルーメン (lm)","lm"),U("klm","キロルーメン (klm)","klm",1000)
  ]),
  C("illuminance","照度","光学","lx","illuminance",[
    U("lx","ルクス (lx)","lx"),U("klx","キロルクス (klx)","klx",1000),U("fc","フートキャンドル (fc)","fc",10.7639104167),U("phot","フォト (ph)","ph",10000)
  ]),
  C("luminance","輝度","光学","cd/m²","luminance",[
    U("nit","ニト (cd/m²)","nit"),U("stilb","スチルブ (sb)","sb",10000),U("fL","フートランバート (fL)","fL",3.4262591)
  ]),
  C("radioactivity","放射能","放射線","Bq","radioactivity",[
    U("Bq","ベクレル (Bq)","Bq"),U("kBq","キロベクレル (kBq)","kBq",1000),U("MBq","メガベクレル (MBq)","MBq",1e6),U("Ci","キュリー (Ci)","Ci",3.7e10),U("mCi","ミリキュリー (mCi)","mCi",3.7e7),U("uCi","マイクロキュリー (µCi)","µCi",37000)
  ]),
  C("absorbedDose","吸収線量","放射線","Gy","dose",[
    U("Gy","グレイ (Gy)","Gy"),U("mGy","ミリグレイ (mGy)","mGy",1e-3),U("uGy","マイクログレイ (µGy)","µGy",1e-6),U("rad","ラド (rad)","rad",.01)
  ]),
  C("doseEquivalent","線量当量","放射線","Sv","doseEquivalent",[
    U("Sv","シーベルト (Sv)","Sv"),U("mSv","ミリシーベルト (mSv)","mSv",1e-3),U("uSv","マイクロシーベルト (µSv)","µSv",1e-6),U("rem","レム (rem)","rem",.01)
  ],"吸収線量Gyと線量当量Svは同じ量ではありません。相互換算には放射線の種類・エネルギー等が関わります。"),
  C("pace","ランニング・競歩ペース","スポーツ","s/m","pace",[
    U("minPerKm","分/km","min/km",60/1000),U("secPerKm","秒/km","s/km",1/1000),U("minPerMi","分/マイル","min/mi",60/1609.344),U("secPer100m","秒/100m","s/100m",.01),U("minPer100m","分/100m","min/100m",60/100)
  ],"値が小さいほど速いペースです。速度とは逆数関係になります。"),
  C("cadence","テンポ・ケイデンス","スポーツ・音楽","1/s","frequency",[
    U("bpm","拍・回転毎分 (bpm)","bpm",1/60),U("Hz","毎秒 (Hz)","Hz"),U("stepsMin","歩/分","steps/min",1/60),U("rpm","回転毎分 (rpm)","rpm",1/60)
  ]),
  C("textileLinearDensity","糸の太さ（線密度）","繊維・服飾","kg/m","textileLinearDensity",[
    U("tex","テックス (tex)","tex",1e-6),U("dtex","デシテックス (dtex)","dtex",1e-7),U("denier","デニール (den)","den",1e-6/9),U("kgm","kg/m","kg/m",1)
  ],"tex・denierは長さ当たりの質量です。大きいほど太い糸です。"),
  C("fabricMass","生地の面積質量","繊維・服飾","kg/m²","fabricMass",[
    U("gm2","g/m²","g/m²",.001),U("kgm2","kg/m²","kg/m²"),U("ozyd2","oz/yd²","oz/yd²",.033905747),U("ozft2","oz/ft²","oz/ft²",.3051517)
  ]),
  C("threadDensity","織物・メッシュの本数密度","繊維・服飾","count/m","threadDensity",[
    U("perM","本/m","本/m"),U("perCm","本/cm","本/cm",100),U("TPI","本/in (TPI)","TPI",1/.0254),U("per10cm","本/10cm","本/10cm",10)
  ]),
  C("typography","文字・組版寸法","印刷・出版","m","length",[
    U("pt","ポイント (1/72in)","pt",.0254/72),U("printerPt","DTPポイント (約1/72.27in)","printer pt",.0254/72.27),U("pica","パイカ (12pt)","pica",.0254/6),U("Q","級 (Q=0.25mm)","Q",.00025),U("H","歯 (H=0.25mm)","H",.00025),U("mm","ミリメートル (mm)","mm",.001),U("in","インチ (in)","in",.0254),U("csspx","CSS px (96/in)","CSS px",.0254/96)
  ],"印刷ポイントには定義差があります。画面のpxはデバイスの実ピクセルと同じとは限りません。"),
  C("printResolution","印刷・画像解像度","印刷・出版","px/m","resolution",[
    U("ppi","pixels per inch (ppi)","ppi",1/.0254),U("dpi","dots per inch (dpi)","dpi",1/.0254),U("lpi","lines per inch (lpi)","lpi",1/.0254),U("pxcm","pixels/cm","px/cm",100)
  ],"ppi・dpi・lpiは用途が異なります。数値を換算できても同じ品質指標ではありません。"),
  C("frameRate","フレームレート","写真・映像","Hz","frequency",[
    U("fps","フレーム毎秒 (fps)","fps"),U("kfps","千fps (kfps)","kfps",1000),U("Hz","Hz","Hz",1)
  ]),
  C("exposureRatio","露出段数・光量比","写真・映像","ratio","dimensionless",[
    U("ratio","光量比","ratio",1),U("EV","露出値 (EV・段数)","EV",1,{special:"log2"}),U("stop","段 (stop)","stop",1,{special:"log2"})
  ],"EV/stopは2を底とする対数尺度です。1段上がるごとに光量比は2倍になります。",{special:"exposure"}),
  C("fuelEconomy","燃費","自動車・輸送","km/L","dimensionless",[
    U("kmL","km/L","km/L"),U("L100km","L/100km","L/100km"),U("mpgUS","米 mpg","US mpg"),U("mpgImp","英 mpg","Imp mpg")
  ],"燃費は逆数型です。L/100kmとkm/Lの変換は単純な倍率ではありません。",{special:"fuel"}),
  C("slope","勾配・傾斜","地理・測量","rise/run","dimensionless",[
    U("ratio","勾配比 (rise/run)","ratio"),U("percent","パーセント (%)","%"),U("permille","パーミル (‰)","‰"),U("degree","角度 (°)","°"),U("gon","グラード (gon)","gon")
  ],"角度はtan(θ)で勾配比へ変換します。",{special:"slope"}),
  C("mapScale","地図縮尺","地理・測量","ratio","dimensionless",[
    U("1_100","1:100","1:100",1/100),U("1_500","1:500","1:500",1/500),U("1_1000","1:1,000","1:1,000",1/1000),U("1_2500","1:2,500","1:2,500",1/2500),U("1_5000","1:5,000","1:5,000",1/5000),U("1_10000","1:10,000","1:10,000",1/10000),U("1_25000","1:25,000","1:25,000",1/25000),U("1_50000","1:50,000","1:50,000",1/50000),U("1_100000","1:100,000","1:100,000",1/100000),U("1_200000","1:200,000","1:200,000",1/200000)
  ],"縮尺の分母を用いた比率換算です。図上距離と実距離の計算は別の計算機能です。"),
  C("flightLevel","航空高度・フライトレベル","航空","m","length",[
    U("m","メートル (m)","m"),U("ft","フィート (ft)","ft",.3048),U("FL","フライトレベル (FL; 数値×100ft)","FL",30.48)
  ],"FLは標準気圧面に基づく高度表現で、地上からの実高度と同じではありません。"),
  C("verticalSpeed","上昇・降下率","航空","m/s","speed",[
    U("mps","m/s","m/s"),U("mmin","m/min","m/min",1/60),U("ftmin","ft/min","ft/min",.3048/60),U("fpm100","100 ft/min","100 ft/min",.3048*100/60)
  ]),
  C("containerCapacity","コンテナ輸送容量単位","物流・輸送","TEU","container",[
    U("TEU","20フィート換算単位 (TEU)","TEU"),U("FEU","40フィート換算単位 (FEU)","FEU",2)
  ],"FEU=2 TEUは容量換算上の標準的な呼び方です。実際の積載量や容積・重量制限を示しません。"),
  C("rainfall","降水量・水深","農業・環境","m","rainfall",[
    U("mm","ミリメートル (mm)","mm",.001),U("cm","センチメートル (cm)","cm",.01),U("m","メートル (m)","m"),U("inch","インチ (in)","in",.0254)
  ],"降水量1mmは水平面1m²あたり水1Lに相当します。"),
  C("soilConductivity","土壌・水の電気伝導率","農業・環境","S/m","soilConductivity",[
    U("Sm","S/m","S/m"),U("mScm","mS/cm","mS/cm",.1),U("uScm","µS/cm","µS/cm",1e-4),U("dSm","dS/m","dS/m",.1)
  ]),
  C("airConcentration","大気・粉じん質量濃度","環境・医学","kg/m³","airConcentration",[
    U("kgm3","kg/m³","kg/m³"),U("mgm3","mg/m³","mg/m³",1e-6),U("ugm3","µg/m³","µg/m³",1e-9),U("ngm3","ng/m³","ng/m³",1e-12)
  ],"気体のppmvと質量濃度の変換には分子量・温度・圧力が必要です。"),
  C("powerLevel","電力レベル（対数）","音響・無線","W","power",[
    U("W","ワット (W)","W"),U("mW","ミリワット (mW)","mW",.001),U("dBW","dBW","dBW",1,{special:"dBW"}),U("dBm","dBm","dBm",1,{special:"dBm"})
  ],"dBWは1W基準、dBmは1mW基準の電力レベルです。対数変換します。",{special:"powerLevel"}),
  C("soundPressureLevel","音圧・音圧レベル","音響","Pa","pressure",[
    U("Pa","パスカル (Pa)","Pa"),U("mPa","ミリパスカル (mPa)","mPa",.001),U("uPa","マイクロパスカル (µPa)","µPa",1e-6),U("dBSPL","dB SPL (20µPa基準)","dB SPL",1,{special:"dBSPL"})
  ],"dB SPLは空気中の基準音圧20µPaを使用します。測定条件・周波数重み付けは別途です。",{special:"sound"}),
  C("pitchInterval","音程比・音程差","音楽・音響","ratio","dimensionless",[
    U("ratio","周波数比","ratio"),U("semitone","半音","半音",1,{special:"semitone"}),U("cent","セント (cent)","cent",1,{special:"cent"})
  ],"半音・セントは周波数比の対数尺度です。基準音からの比率を扱います。",{special:"pitch"}),
  C("julianDate","天文時刻・ユリウス日","天文学・時刻","Unix秒","time",[
    U("unixs","Unix時刻 (秒)","Unix s"),U("unixms","Unix時刻 (ms)","Unix ms",.001),U("JD","ユリウス日 (JD)","JD",86400,{offset:-2440587.5*86400}),U("MJD","修正ユリウス日 (MJD)","MJD",86400,{offset:(2400000.5-2440587.5)*86400})
  ],"Unix秒とJD/MJDの暦基準オフセットを扱います。閏秒などの時系差は別途考慮が必要です。"),
  C("ratioConcentration","比率・微量濃度","科学・環境","fraction","dimensionless",[
    U("fraction","比率 (1)","1"),U("percent","パーセント (%)","%",.01),U("permille","パーミル (‰)","‰",.001),U("ppm","ppm","ppm",1e-6),U("ppb","ppb","ppb",1e-9),U("ppt","ppt","ppt",1e-12),U("ppmv","ppmv","ppmv",1e-6)
  ],"ppm/ppb/pptは比率としての換算です。質量濃度・体積濃度への変換には条件が必要です。"),
  C("meteorologicalPressure","気象・気圧（気象観測）","農業・環境","Pa","pressure",[U("Pa","Pa","Pa"),U("hPa","ヘクトパスカル (hPa)","hPa",100),U("kPa","kPa","kPa",1000),U("mbar","ミリバール (mbar)","mbar",100),U("inHg","水銀柱インチ (inHg)","inHg",3386.389),U("mmHg","mmHg","mmHg",133.322387415)],"気圧の換算です。海面更正や高度補正は別途です。"),
  C("humidity","相対湿度","農業・環境","fraction","dimensionless",[U("fraction","比率 (0〜1)","1"),U("percent","相対湿度 (%)","%",.01)],"相対湿度は同じ定義の比率です。絶対湿度とは異なります。"),
  C("altitude","標高・深度","地理・測量","m","length",[U("m","メートル (m)","m"),U("km","キロメートル (km)","km",1000),U("ft","フィート (ft)","ft",.3048),U("fathom","ファゾム (fathom)","fathom",1.8288),U("yd","ヤード (yd)","yd",.9144)],"標高基準面の違いは換算されません。"),
  C("ancientLength","古代・歴史的長さ","伝統単位","m","length",[U("romanFoot","ローマ・ペス（概算）","pes",.296),U("romanMile","ローマ・ミッレ（概算）","mille passus",1480),U("cubit18","キュビット（18inの参考定義）","cubit",.4572),U("fathom","ファゾム (fathom)","fathom",1.8288)],"古代単位は地域・時代で差があります。ローマ・ペス等は歴史的代表値としての概算です。"),
  C("astronomicalTime","天文年・暦年","天文学","s","time",[U("julianYear","ユリウス年 (365.25日)","Julian yr",31557600),U("tropicalYear","回帰年（平均値）","tropical yr",31556925.2),U("siderealYear","恒星年（平均値）","sidereal yr",31558149.8),U("synodicMonth","朔望月（平均値）","synodic month",2551442.88),U("siderealDay","恒星日（平均値）","sidereal day",86164.0905),U("solarDay","平均太陽日","mean solar day",86400)],"平均値を使った近似です。実際の暦・天体運行は変動します。"),
  C("astronomicalLuminosity","天体光度","天文学","W","power",[U("W","ワット (W)","W"),U("solarL","太陽光度 (L☉)","L☉",3.828e26)],"太陽光度は代表的な公称値を使用。"),
  C("coordinateAngle","測量角度・方位","地理・測量","rad","dimensionless",[U("deg","度 (°)","°",Math.PI/180),U("rad","ラジアン (rad)","rad"),U("gon","グラード (gon)","gon",Math.PI/200),U("arcmin","分角 (′)","′",Math.PI/10800),U("arcsec","秒角 (″)","″",Math.PI/648000)],"方位角・座標系の北方向基準（真北・磁北等）は別設定です。"),
  C("molarMass","モル質量","化学","kg/mol","molarMass",[U("kgmol","kg/mol","kg/mol"),U("gmol","g/mol","g/mol",.001),U("mgmol","mg/mol","mg/mol",1e-6)],"密度・質量濃度と物質量濃度を相互変換する際に使います。"),
  C("thermalExpansion","線膨張係数","工学","1/K","dimensionless",[U("perK","1/K","1/K"),U("perC","1/°C","1/°C"),U("perF","1/°F","1/°F",1.8)],"温度差あたりの係数です。温度のオフセットはありません。"),
  C("airVelocity","風速・空気流速","農業・環境","m/s","speed",[U("mps","m/s","m/s"),U("kmh","km/h","km/h",1/3.6),U("knot","ノット (kn)","kn",.514444444444),U("mph","mph","mph",.44704),U("ftmin","ft/min","ft/min",.3048/60)],"風力階級（ビューフォート）は速度の単純な等間隔尺度ではありません。"),
  C("fuelVolumeEconomy","燃料消費率","自動車・輸送","L/100km","dimensionless",[U("L100km","L/100km","L/100km"),U("kmL","km/L","km/L")],"燃費カテゴリと同じ逆数関係です。",{special:"fuel"}),
  C("antennaGain","アンテナ利得","無線・通信","dBi","dimensionless",[U("dBi","dBi（等方性基準）","dBi"),U("dBd","dBd（半波長ダイポール基準）","dBd",1,{offset:2.15})],"dBdとdBiの代表的な差は約2.15dBです。アンテナ条件による実測差ではありません。"),
  C("voltageLevel","電圧レベル（対数）","音響・無線","V RMS","voltage",[U("Vrms","実効電圧 (V RMS)","V RMS"),U("dBV","dBV（1V基準）","dBV",1,{special:"dBV"}),U("dBu","dBu（0.775V基準）","dBu",1,{special:"dBu"})],"dBV/dBuは実効電圧を基準とする対数レベルです。",{special:"voltageLevel"}),
  C("specificPower","比出力・重量出力","工学・スポーツ","W/kg","specificPower",[U("Wkg","ワット毎キログラム (W/kg)","W/kg"),U("kWkg","キロワット毎キログラム (kW/kg)","kW/kg",1000),U("hpLb","hp/lb","hp/lb",745.699871582/0.45359237)],"機械出力を質量で割った量です。"),
  C("humidityRatio","湿り空気・混合比","空調・環境","kg/kg","dimensionless",[U("kgkg","kg/kg","kg/kg"),U("gkg","g/kg","g/kg",.001),U("grlb","gr/lb","gr/lb",.0001428571429)],"湿度比は乾き空気質量に対する水蒸気質量の比です。相対湿度とは別物です。"),
  C("soundIntensity","音響インテンシティ","音響","W/m²","power",[U("Wm2","W/m²","W/m²"),U("mWm2","mW/m²","mW/m²",.001),U("uWm2","µW/m²","µW/m²",1e-6)],"音響パワー・音圧レベルとは別の物理量です。"),
  C("radiantFlux","放射束・放射パワー","光学・放射測定","W","power",[U("W","ワット (W)","W"),U("mW","ミリワット (mW)","mW",.001),U("kW","キロワット (kW)","kW",1000)]),
  C("pH","pH・水素イオン活量（理想近似）","化学・環境","mol/L","molarity",[
    U("pH","pH値","pH",1,{special:"pH"}),U("molL","mol/L","mol/L"),U("mmolL","mmol/L","mmol/L",.001),U("umolL","µmol/L","µmol/L",1e-6)
  ],"pHは水素イオン活量の対数尺度です。濃度への換算は活量係数を1とみなす理想近似です。",{special:"pH"})
];
const unitDefinitionMap = Object.fromEntries(unitCategories.map(c=>[c.id,c]));
const unitCategoryGroups = [...new Set(unitCategories.map(c=>c.group))];
const UNIT_CUSTOM_KEY="aurora_unit_custom_v2", UNIT_FAVORITE_KEY="aurora_unit_favorites_v2", UNIT_HISTORY_KEY="aurora_unit_history_v2";
let unitCustomUnits=readSaved(UNIT_CUSTOM_KEY,[]); if(!Array.isArray(unitCustomUnits)) unitCustomUnits=[];
let unitFavorites=readSaved(UNIT_FAVORITE_KEY,[]); if(!Array.isArray(unitFavorites)) unitFavorites=[];
let unitHistory=readSaved(UNIT_HISTORY_KEY,[]); if(!Array.isArray(unitHistory)) unitHistory=[];
function allUnitsFor(categoryId){const c=unitDefinitionMap[categoryId];return c?[...c.units,...unitCustomUnits.filter(u=>u.category===categoryId).map(u=>u.unit)]:[];}
function formatUnitValue(v){if(!Number.isFinite(v))return String(v);if(Object.is(v,-0))v=0;const p=Number($("#unitPrecision")?.value||12);return Number(v.toPrecision(p)).toLocaleString("ja-JP",{maximumSignificantDigits:p});}
function unitMachSpeed(){const t=Number($("#unitMachTemp")?.value??15);if(!Number.isFinite(t)||t<=-273.15)throw new Error("Mach換算の気温は−273.15°Cより高い値にしてください。");return Math.sqrt(1.4*287.05287*(t+273.15));}
function unitToBase(category,value,unit){
  if(category.id==="speed"&&unit.id==="mach15")return value*unitMachSpeed();
  if(category.special==="voltageLevel"){
    if(unit.id==="Vrms")return value;if(unit.id==="dBV")return 10**(value/20);if(unit.id==="dBu")return .775*10**(value/20);
  }
  if(category.special==="fuel"){
    if(unit.id==="kmL")return value;
    if(unit.id==="L100km"){if(value===0)throw new Error("0 L/100kmは変換できません。");return 100/value;}
    if(unit.id==="mpgUS")return value*(1.609344/3.785411784);
    if(unit.id==="mpgImp")return value*(1.609344/4.54609);
  }
  if(category.special==="slope"){
    if(unit.id==="ratio")return value;
    if(unit.id==="percent")return value/100;
    if(unit.id==="permille")return value/1000;
    if(unit.id==="degree"){if(Math.abs(Math.cos(value*Math.PI/180))<1e-12)throw new Error("垂直（90°）の勾配は有限の比率にできません。");return Math.tan(value*Math.PI/180);}
    if(unit.id==="gon"){if(Math.abs(Math.cos(value*Math.PI/200))<1e-12)throw new Error("垂直（100gon）の勾配は有限の比率にできません。");return Math.tan(value*Math.PI/200);}
  }
  if(category.special==="powerLevel"){
    if(unit.id==="W")return value;if(unit.id==="mW")return value*.001;if(unit.id==="dBW")return 10**(value/10);if(unit.id==="dBm")return .001*10**(value/10);
  }
  if(category.special==="sound"){
    if(unit.id==="Pa")return value;if(unit.id==="mPa")return value*.001;if(unit.id==="uPa")return value*1e-6;if(unit.id==="dBSPL")return 20e-6*10**(value/20);
  }
  if(category.special==="pitch"){
    if(unit.id==="ratio")return value;if(unit.id==="semitone")return 2**(value/12);if(unit.id==="cent")return 2**(value/1200);
  }
  if(category.special==="pH"){
    if(unit.id==="pH")return 10**(-value);if(unit.id==="molL")return value;if(unit.id==="mmolL")return value*.001;if(unit.id==="umolL")return value*1e-6;
  }
  if(category.special==="exposure"){
    if(unit.id==="ratio")return value;if(unit.id==="EV"||unit.id==="stop")return 2**value;
  }
  return value*(unit.factor??1)+(unit.offset??0);
}
function unitFromBase(category,base,unit){
  if(category.id==="speed"&&unit.id==="mach15")return base/unitMachSpeed();
  if(category.special==="voltageLevel"){
    if(base<=0)throw new Error("dBV/dBuへ変換するには正の実効電圧が必要です。");if(unit.id==="Vrms")return base;if(unit.id==="dBV")return 20*Math.log10(base);if(unit.id==="dBu")return 20*Math.log10(base/.775);
  }
  if(category.special==="fuel"){
    if(unit.id==="kmL")return base;if(unit.id==="L100km"){if(base<=0)throw new Error("0以下のkm/LからL/100kmは計算できません。");return 100/base;}if(unit.id==="mpgUS")return base/(1.609344/3.785411784);if(unit.id==="mpgImp")return base/(1.609344/4.54609);
  }
  if(category.special==="slope"){
    if(unit.id==="ratio")return base;if(unit.id==="percent")return base*100;if(unit.id==="permille")return base*1000;if(unit.id==="degree")return Math.atan(base)*180/Math.PI;if(unit.id==="gon")return Math.atan(base)*200/Math.PI;
  }
  if(category.special==="powerLevel"){
    if(base<=0)throw new Error("dBW/dBmへ変換するには正の電力が必要です。");if(unit.id==="W")return base;if(unit.id==="mW")return base*1000;if(unit.id==="dBW")return 10*Math.log10(base);if(unit.id==="dBm")return 10*Math.log10(base/.001);
  }
  if(category.special==="sound"){
    if(base<0)throw new Error("音圧は0以上で入力してください。");if(unit.id==="Pa")return base;if(unit.id==="mPa")return base*1000;if(unit.id==="uPa")return base*1e6;if(unit.id==="dBSPL"){if(base===0)return -Infinity;return 20*Math.log10(base/(20e-6));}
  }
  if(category.special==="pitch"){
    if(base<=0)throw new Error("周波数比は0より大きい値が必要です。");if(unit.id==="ratio")return base;if(unit.id==="semitone")return 12*Math.log2(base);if(unit.id==="cent")return 1200*Math.log2(base);
  }
  if(category.special==="pH"){
    if(base<=0)throw new Error("水素イオン濃度は0より大きい値が必要です。");if(unit.id==="pH")return -Math.log10(base);if(unit.id==="molL")return base;if(unit.id==="mmolL")return base*1000;if(unit.id==="umolL")return base*1e6;
  }
  if(category.special==="exposure"){
    if(base<=0)throw new Error("光量比は0より大きい値が必要です。");if(unit.id==="ratio")return base;if(unit.id==="EV"||unit.id==="stop")return Math.log2(base);
  }
  return (base-(unit.offset??0))/(unit.factor??1);
}
function unitConvertValue(category,value,from,to){return unitFromBase(category,unitToBase(category,value,from),to);}
function refreshUnitCategories(filter=""){
  const select=$("#unitCategory"),old=select.value,query=filter.trim().toLowerCase();select.replaceChildren();
  unitCategoryGroups.forEach(group=>{const matching=unitCategories.filter(c=>c.group===group&&(`${c.label} ${c.id} ${c.group}`.toLowerCase().includes(query)));if(!matching.length)return;const og=document.createElement("optgroup");og.label=group;matching.forEach(c=>og.appendChild(new Option(c.label,c.id)));select.add(og);});
  select.value=unitDefinitionMap[old]&&[...select.options].some(o=>o.value===old)?old:(select.options[0]?.value||"");
}
function refreshUnitOptions(){
  const category=unitDefinitionMap[$("#unitCategory").value];if(!category)return;
  const from=$("#unitFrom"),to=$("#unitTo"),oldFrom=from.value,oldTo=to.value,query=( $("#unitSearch")?.value||"").trim().toLowerCase(),units=allUnitsFor(category.id).filter(u=>`${u.label} ${u.symbol} ${u.id}`.toLowerCase().includes(query));
  from.replaceChildren();to.replaceChildren();units.forEach(u=>{from.add(new Option(u.label,u.id));to.add(new Option(u.label,u.id));});
  from.value=units.some(u=>u.id===oldFrom)?oldFrom:(units[0]?.id||"");to.value=units.some(u=>u.id===oldTo)?oldTo:(units[1]?.id||units[0]?.id||"");
  $("#unitBaseLabel").textContent=`基準単位：${category.base}`;$("#unitCategoryNote").textContent=category.note||"SI基準値を使って換算します。";
  refreshUnitFavoriteButton();
}
function unitSelected(){const category=unitDefinitionMap[$("#unitCategory").value],units=allUnitsFor(category.id);return{category,from:units.find(u=>u.id===$("#unitFrom").value),to:units.find(u=>u.id===$("#unitTo").value)};}
function renderUnitHistory(){const target=$("#unitHistory");if(!target)return;target.replaceChildren();if(!unitHistory.length){target.textContent="変換履歴はまだありません。";return;}unitHistory.slice(0,12).forEach(item=>{const p=document.createElement("p");p.className="unit-history-item";p.textContent=`${item.input} ${item.from} → ${item.output} ${item.to}（${item.category}）`;target.appendChild(p);});}
function addUnitHistory(item){unitHistory.unshift({ ...item,at:new Date().toISOString() });unitHistory=unitHistory.slice(0,50);saveValue(UNIT_HISTORY_KEY,unitHistory);renderUnitHistory();}
function renderUnitFavorites(){const select=$("#unitFavoriteSelect");if(!select)return;select.replaceChildren(new Option("お気に入り変換を選択", ""));unitFavorites.forEach(key=>{const [categoryId,fromId,toId]=key.split(":");const c=unitDefinitionMap[categoryId],f=allUnitsFor(categoryId).find(u=>u.id===fromId),t=allUnitsFor(categoryId).find(u=>u.id===toId);if(c&&f&&t)select.add(new Option(`${c.label}: ${f.symbol} → ${t.symbol}`,key));});}
function refreshUnitFavoriteButton(){const b=$("#unitFavoriteToggle");if(!b)return;const key=`${$("#unitCategory").value}:${$("#unitFrom").value}:${$("#unitTo").value}`;const active=unitFavorites.includes(key);b.textContent=active?"★ お気に入り解除":"☆ この変換をお気に入り";renderUnitFavorites();}
function renderUnitResult(value,result,category,from,to,uncertainty=0){
  const box=$("#unitResults");let uncertaintyText="";if(uncertainty>0){try{const upper=unitConvertValue(category,value+uncertainty,from,to),lower=unitConvertValue(category,value-uncertainty,from,to);const spread=Math.max(Math.abs(upper-result),Math.abs(result-lower));if(Number.isFinite(spread))uncertaintyText=` ± ${formatUnitValue(spread)} ${to.symbol}`;}catch(e){}}
  box.textContent=`${formatUnitValue(value)} ${from.label}\n= ${formatUnitValue(result)} ${to.label}${uncertaintyText}`;
  const base=unitToBase(category,value,from),formula=$("#unitFormula");
  const f=category.special?"専用の変換式（対数・逆数・基準値など）":"基準値 = 入力値 × 変換係数 + オフセット";
  formula.textContent=`変換方法：${f}\n基準単位：${category.base}\n基準値：${formatUnitValue(base)}\n変換先：${category.special?"専用式で基準値から変換":`(基準値 − ${to.offset??0}) ÷ ${to.factor??1}`}\nカテゴリ：${category.label}`;
  const table=$("#unitAllResults");table.replaceChildren();
  const title=document.createElement("strong");title.textContent="同じ値をこのカテゴリの全単位へ変換";table.appendChild(title);
  allUnitsFor(category.id).forEach(u=>{try{const line=document.createElement("div");line.className="unit-result-row";const name=document.createElement("span");name.textContent=u.label;const val=document.createElement("strong");val.textContent=formatUnitValue(unitFromBase(category,base,u));line.append(name,val);table.appendChild(line);}catch(e){}});
  addUnitHistory({category:category.label,input:value,from:from.symbol,output:result,to:to.symbol});
}
$("#unitCategorySearch")?.addEventListener("input",e=>{refreshUnitCategories(e.target.value);refreshUnitOptions();});
$("#unitCategory")?.addEventListener("change",refreshUnitOptions);
$("#unitSearch")?.addEventListener("input",refreshUnitOptions);
$("#unitFrom")?.addEventListener("change",refreshUnitFavoriteButton);
$("#unitTo")?.addEventListener("change",refreshUnitFavoriteButton);
$("#convertUnit")?.addEventListener("click",()=>{try{const value=parseRequiredNumber("#unitValue","変換する値"),{category,from,to}=unitSelected();if(!from||!to)throw new Error("変換元・変換先の単位を選んでください。");const result=unitConvertValue(category,value,from,to);if(!Number.isFinite(result))throw new Error("この条件では有限の変換結果を得られません。");const uncertainty=Number($("#unitUncertainty")?.value||0);if(uncertainty<0)throw new Error("不確かさは0以上にしてください。");renderUnitResult(value,result,category,from,to,uncertainty);}catch(error){$("#unitResults").textContent=error.message;$("#unitFormula").textContent="";$("#unitAllResults").replaceChildren();}});
$("#unitSwap")?.addEventListener("click",()=>{const f=$("#unitFrom"),t=$("#unitTo"),x=f.value;f.value=t.value;t.value=x;refreshUnitFavoriteButton();});
$("#unitFavoriteToggle")?.addEventListener("click",()=>{const key=`${$("#unitCategory").value}:${$("#unitFrom").value}:${$("#unitTo").value}`;if(unitFavorites.includes(key))unitFavorites=unitFavorites.filter(x=>x!==key);else unitFavorites.unshift(key);saveValue(UNIT_FAVORITE_KEY,unitFavorites);refreshUnitFavoriteButton();});
$("#unitApplyFavorite")?.addEventListener("click",()=>{const key=$("#unitFavoriteSelect").value;if(!key)return;const [c,f,t]=key.split(":");$("#unitCategory").value=c;refreshUnitOptions();$("#unitFrom").value=f;$("#unitTo").value=t;refreshUnitFavoriteButton();});
$("#unitHistoryClear")?.addEventListener("click",()=>{unitHistory=[];saveValue(UNIT_HISTORY_KEY,unitHistory);renderUnitHistory();});
$("#unitExportJson")?.addEventListener("click",()=>downloadText("aurora-unit-data.json",JSON.stringify({format:"AuroraUnitData",version:2,customUnits:unitCustomUnits,favorites:unitFavorites,history:unitHistory},null,2),"application/json"));
$("#unitExportCsv")?.addEventListener("click",()=>{const rows=[["分野","入力値","変換元","変換後","変換先","日時"],...unitHistory.map(h=>[h.category,h.input,h.from,h.output,h.to,h.at])];downloadText("aurora-unit-history.csv","\uFEFF"+rows.map(r=>r.map(csvEscape).join(",")).join("\r\n"),"text/csv;charset=utf-8");});
$("#unitAddCustom")?.addEventListener("click",()=>{try{const cat=unitDefinitionMap[$("#unitCategory").value];if(cat.special||["temperature","julianDate"].includes(cat.id))throw new Error("対数・逆数・オフセット換算のカテゴリには独自の倍率単位を追加できません。");const label=$("#unitCustomName").value.trim(),symbol=$("#unitCustomSymbol").value.trim(),factor=parseRequiredNumber("#unitCustomFactor","基準単位に対する係数");if(!label||!symbol)throw new Error("単位名と記号を入力してください。");if(factor<=0)throw new Error("係数は0より大きくしてください。");if(allUnitsFor(cat.id).some(u=>u.id===`custom_${symbol}`||u.symbol===symbol))throw new Error("同じ記号の単位がすでにあります。");unitCustomUnits.push({category:cat.id,unit:U(`custom_${symbol}`,`${label} (${symbol})`,symbol,factor)});saveValue(UNIT_CUSTOM_KEY,unitCustomUnits);$("#unitCustomName").value="";$("#unitCustomSymbol").value="";$("#unitCustomFactor").value="";refreshUnitOptions();$("#unitResults").textContent=`独自単位「${label}」を追加しました。係数は ${factor} ${cat.base}/${symbol} です。`;}catch(e){$("#unitResults").textContent=e.message;}});
$("#unitImportJson")?.addEventListener("change",async e=>{try{const file=e.target.files?.[0];if(!file)return;if(file.size>2*1024*1024)throw new Error("ファイルは2MB以下にしてください。");const data=JSON.parse(await file.text());if(data.format!=="AuroraUnitData"||!Array.isArray(data.customUnits))throw new Error("Aurora単位データではありません。");const valid=data.customUnits.filter(x=>unitDefinitionMap[x.category]&&!unitDefinitionMap[x.category].special&&!["temperature","julianDate"].includes(x.category)&&x.unit&&typeof x.unit.label==="string"&&typeof x.unit.symbol==="string"&&Number.isFinite(x.unit.factor)&&x.unit.factor>0);unitCustomUnits=valid;unitFavorites=Array.isArray(data.favorites)?data.favorites:[];unitHistory=Array.isArray(data.history)?data.history.slice(0,50):[];saveValue(UNIT_CUSTOM_KEY,unitCustomUnits);saveValue(UNIT_FAVORITE_KEY,unitFavorites);saveValue(UNIT_HISTORY_KEY,unitHistory);refreshUnitOptions();renderUnitHistory();$("#unitResults").textContent=`独自単位 ${valid.length} 件を読み込みました。`;}catch(err){$("#unitResults").textContent=err.message;}finally{e.target.value="";}});
$("#unitImportButton")?.addEventListener("click",()=>$("#unitImportJson")?.click());

/* 単位付き式の解析：SI基本次元へ展開する教育・技術計算向けミニパーサー */
const unitExpressionAtoms={
  kg:{factor:1,dim:[1,0,0,0,0,0,0]},g:{factor:.001,dim:[1,0,0,0,0,0,0]},mg:{factor:1e-6,dim:[1,0,0,0,0,0,0]},
  m:{factor:1,dim:[0,1,0,0,0,0,0]},cm:{factor:.01,dim:[0,1,0,0,0,0,0]},mm:{factor:.001,dim:[0,1,0,0,0,0,0]},km:{factor:1000,dim:[0,1,0,0,0,0,0]},
  s:{factor:1,dim:[0,0,1,0,0,0,0]},min:{factor:60,dim:[0,0,1,0,0,0,0]},h:{factor:3600,dim:[0,0,1,0,0,0,0]},
  N:{factor:1,dim:[1,1,-2,0,0,0,0]},J:{factor:1,dim:[1,2,-2,0,0,0,0]},W:{factor:1,dim:[1,2,-3,0,0,0,0]},Pa:{factor:1,dim:[1,-1,-2,0,0,0,0]},
  V:{factor:1,dim:[1,2,-3,-1,0,0,0]},A:{factor:1,dim:[0,0,0,1,0,0,0]},ohm:{factor:1,dim:[1,2,-3,-2,0,0,0]},F:{factor:1,dim:[-1,-2,4,2,0,0,0]},H:{factor:1,dim:[1,2,-2,-2,0,0,0]},
  S:{factor:1,dim:[-1,-2,3,2,0,0,0]},C:{factor:1,dim:[0,0,1,1,0,0,0]},Hz:{factor:1,dim:[0,0,-1,0,0,0,0]},mol:{factor:1,dim:[0,0,0,0,0,1,0]},K:{factor:1,dim:[0,0,0,0,1,0,0]},rad:{factor:1,dim:[0,0,0,0,0,0,0]},L:{factor:.001,dim:[0,3,0,0,0,0,0]},
  T:{factor:1,dim:[1,0,-2,-1,0,0,0]},Wb:{factor:1,dim:[1,2,-2,-1,0,0,0]}
};
function parseUnitDimensionalExpression(source){
  const tokens=[];const re=/\s*([*/^()+-]|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|[A-Za-zµμΩ]+)\s*/gy;let pos=0;
  while(pos<source.length){re.lastIndex=pos;const m=re.exec(source);if(!m)throw new Error(`解釈できない文字があります：${source.slice(pos,pos+8)}`);tokens.push(m[1]);pos=re.lastIndex;if(tokens.length>200)throw new Error("式が長すぎます。");}
  let i=0;const zero=()=>Array(7).fill(0),combine=(a,b,sgn)=>a.map((v,k)=>v+sgn*b[k]);
  function factor(){let value,dim=zero(),tok=tokens[i++];if(tok===undefined)throw new Error("式が途中で終わっています。");if(tok==="("){const r=expr();if(tokens[i++]!==")")throw new Error("閉じ括弧 ) がありません。");value=r.value;dim=r.dim;}else if(/^\d/.test(tok)||/^\.\d/.test(tok)){value=Number(tok);if(!Number.isFinite(value))throw new Error("数値が不正です。");}else{const atom=unitExpressionAtoms[tok];if(!atom)throw new Error(`未登録の単位記号「${tok}」です。基本単位記号（m, kg, s, N, J, W, Paなど）を使ってください。`);value=atom.factor;dim=[...atom.dim];}
    if(tokens[i]==="^"){i++;let sign=1;if(tokens[i]==="-"){sign=-1;i++;}else if(tokens[i]==="+")i++;const power=Number(tokens[i++])*sign;if(!Number.isInteger(power)||Math.abs(power)>12)throw new Error("指数は−12〜12の整数にしてください。");value=value**power;dim=dim.map(x=>x*power);}
    return{value,dim};}
  function expr(){let left=factor();while(i<tokens.length&&tokens[i]!==")"){let op="*";if(tokens[i]==="*"||tokens[i]==="/")op=tokens[i++];const right=factor();left={value:op==="*"?left.value*right.value:left.value/right.value,dim:combine(left.dim,right.dim,op==="*"?1:-1)};}return left;}
  if(!tokens.length)throw new Error("式を入力してください。");const result=expr();if(i!==tokens.length)throw new Error("式を最後まで解析できませんでした。");if(!Number.isFinite(result.value))throw new Error("計算結果が有限値ではありません。");return result;
}
$("#runUnitDimensionalExpression")?.addEventListener("click",()=>{try{const raw=$("#unitDimensionalExpression").value.trim();const r=parseUnitDimensionalExpression(raw);const names=["kg","m","s","A","K","mol","cd"];const labels=r.dim.map((v,i)=>v?`${names[i]}${v===1?"":`^${v}`}`:null).filter(Boolean);$("#unitDimensionalResults").textContent=`入力式：${raw}\nSI基本単位へ展開した係数：${formatUnitValue(r.value)}\n次元：${labels.join(" · ")||"無次元"}\n\n※単位記号の積・商・整数乗に対応します。演算の意味や式全体の物理的妥当性は別途確認してください。`;}catch(e){$("#unitDimensionalResults").textContent=e.message;}});


/* SI接頭辞の自動選択 */
const siPrefixList=[{e:24,s:"Y"},{e:21,s:"Z"},{e:18,s:"E"},{e:15,s:"P"},{e:12,s:"T"},{e:9,s:"G"},{e:6,s:"M"},{e:3,s:"k"},{e:0,s:""},{e:-3,s:"m"},{e:-6,s:"µ"},{e:-9,s:"n"},{e:-12,s:"p"},{e:-15,s:"f"},{e:-18,s:"a"},{e:-21,s:"z"},{e:-24,s:"y"}];
$("#unitPrefixConvert")?.addEventListener("click",()=>{try{const v=parseRequiredNumber("#unitPrefixValue","数値"),base=$("#unitPrefixBase").value;if(v===0){$("#unitPrefixResults").textContent=`0 ${base} = 0 ${base}`;return;}const e=Math.max(-24,Math.min(24,Math.floor(Math.log10(Math.abs(v))/3)*3)),prefix=siPrefixList.find(x=>x.e===e)||siPrefixList.find(x=>x.e===0),scaled=v/10**prefix.e;$("#unitPrefixResults").textContent=`${formatUnitValue(v)} ${base} = ${formatUnitValue(scaled)} ${prefix.s}${base}\n使用したSI接頭辞：${prefix.s||"なし"}（10^${prefix.e}）`; }catch(e){$("#unitPrefixResults").textContent=e.message;}});

/* 条件を指定する専門換算ツール */
$("#unitMolarConvert")?.addEventListener("click",()=>{try{const v=parseRequiredNumber("#unitMolarValue","濃度"),m=parseRequiredNumber("#unitMolarMass","モル質量");if(v<0||m<=0)throw new Error("濃度は0以上、モル質量は0より大きくしてください。");const dir=$("#unitMolarDirection").value;const out=dir==="mgdlToMmol"?v*10/m:v*m/10;$("#unitMolarResults").textContent=dir==="mgdlToMmol"?`${formatUnitValue(v)} mg/dL ÷ ${formatUnitValue(m)} g/mol × 10 = ${formatUnitValue(out)} mmol/L`:`${formatUnitValue(v)} mmol/L × ${formatUnitValue(m)} g/mol ÷ 10 = ${formatUnitValue(out)} mg/dL`; }catch(e){$("#unitMolarResults").textContent=e.message;}});
$("#unitDecimalToDms")?.addEventListener("click",()=>{try{const v=parseRequiredNumber("#unitDecimalDegrees","十進角度");if(Math.abs(v)>360)throw new Error("角度は−360°〜360°の範囲で入力してください。");const sign=v<0?"−":"",a=Math.abs(v),d=Math.floor(a),mFloat=(a-d)*60,m=Math.floor(mFloat),sec=(mFloat-m)*60;$("#unitDmsResults").textContent=`${v}° = ${sign}${d}° ${m}′ ${formatUnitValue(sec)}″`;$("#unitDmsDeg").value=String(Math.sign(v)*d);$("#unitDmsMin").value=String(m);$("#unitDmsSec").value=String(sec);}catch(e){$("#unitDmsResults").textContent=e.message;}});
$("#unitDmsToDecimal")?.addEventListener("click",()=>{try{const d=parseRequiredNumber("#unitDmsDeg","度"),m=parseRequiredNumber("#unitDmsMin","分"),sec=parseRequiredNumber("#unitDmsSec","秒");if(m<0||m>=60||sec<0||sec>=60)throw new Error("分・秒は0以上60未満にしてください。");if(d<0&&(m>0||sec>0)){}const sign=d<0?-1:1,decimal=sign*(Math.abs(d)+m/60+sec/3600);$("#unitDmsResults").textContent=`${d}° ${m}′ ${sec}″ = ${formatUnitValue(decimal)}°`;$("#unitDecimalDegrees").value=String(decimal);}catch(e){$("#unitDmsResults").textContent=e.message;}});
const colorWhite={x:95.047,y:100,z:108.883},colorEpsilon=216/24389,colorKappa=24389/27;
function cieF(t){return t>colorEpsilon?Math.cbrt(t):(colorKappa*t+16)/116;}
function cieFInv(t){const t3=t*t*t;return t3>colorEpsilon?t3:(116*t-16)/colorKappa;}
$("#unitXyzToLab")?.addEventListener("click",()=>{try{const X=parseRequiredNumber("#unitColorX","X"),Y=parseRequiredNumber("#unitColorY","Y"),Z=parseRequiredNumber("#unitColorZ","Z");if(X<0||Y<0||Z<0)throw new Error("XYZは0以上で入力してください。");const fx=cieF(X/colorWhite.x),fy=cieF(Y/colorWhite.y),fz=cieF(Z/colorWhite.z),L=116*fy-16,a=500*(fx-fy),b=200*(fy-fz);$("#unitColorResults").textContent=`CIE L*a*b*（D65/2°）\nL* = ${formatUnitValue(L)}\na* = ${formatUnitValue(a)}\nb* = ${formatUnitValue(b)}`;$("#unitColorL").value=String(L);$("#unitColorA").value=String(a);$("#unitColorB").value=String(b);}catch(e){$("#unitColorResults").textContent=e.message;}});
$("#unitLabToXyz")?.addEventListener("click",()=>{try{const L=parseRequiredNumber("#unitColorL","L*"),a=parseRequiredNumber("#unitColorA","a*"),b=parseRequiredNumber("#unitColorB","b*");const fy=(L+16)/116,fx=fy+a/500,fz=fy-b/200,X=colorWhite.x*cieFInv(fx),Y=colorWhite.y*cieFInv(fy),Z=colorWhite.z*cieFInv(fz);$("#unitColorResults").textContent=`CIE XYZ（D65/2°）\nX = ${formatUnitValue(X)}\nY = ${formatUnitValue(Y)}\nZ = ${formatUnitValue(Z)}`;$("#unitColorX").value=String(X);$("#unitColorY").value=String(Y);$("#unitColorZ").value=String(Z);}catch(e){$("#unitColorResults").textContent=e.message;}});
$("#unitDeltaE76")?.addEventListener("click",()=>{try{const a=[parseRequiredNumber("#unitLabA_L","A L*"),parseRequiredNumber("#unitLabA_a","A a*"),parseRequiredNumber("#unitLabA_b","A b*")],b=[parseRequiredNumber("#unitLabB_L","B L*"),parseRequiredNumber("#unitLabB_a","B a*"),parseRequiredNumber("#unitLabB_b","B b*")];const d=Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);$("#unitDeltaEResults").textContent=`ΔE*ab（CIE76）= ${formatUnitValue(d)}\n※CIEDE2000とは異なる簡易色差です。`; }catch(e){$("#unitDeltaEResults").textContent=e.message;}});


refreshUnitCategories();refreshUnitOptions();renderUnitHistory();renderUnitFavorites();$("#unitCountBadge").textContent=`${unitCategories.length}カテゴリ・${unitCategories.reduce((n,c)=>n+c.units.length,0)}単位以上`;


/* =========================
   9. 行列計算
   ========================= */
function parseMatrix(selector, label) {
  const source = $(selector).value.trim();
  if (!source) throw new Error(`${label}を入力してください。`);
  const matrix = source.split(/\n+/).map((line) => line.trim().split(/[\s,;]+/).filter(Boolean).map(Number));
  if (matrix.some((row) => row.length === 0 || row.some((number) => !Number.isFinite(number)))) {
    throw new Error(`${label}は数字をカンマ区切りで入力してください。`);
  }
  const columns = matrix[0].length;
  if (matrix.some((row) => row.length !== columns)) throw new Error(`${label}の各行の列数をそろえてください。`);
  return matrix;
}

function addMatrices(a, b, sign = 1) {
  if (a.length !== b.length || a[0].length !== b[0].length) throw new Error("加算・減算する行列のサイズをそろえてください。");
  return a.map((row, r) => row.map((value, c) => value + sign * b[r][c]));
}

function multiplyMatrices(a, b) {
  if (a[0].length !== b.length) throw new Error("Aの列数とBの行数を一致させてください。");
  return a.map((row, r) => b[0].map((_, c) => row.reduce((sum, value, k) => sum + value * b[k][c], 0)));
}

function transposeMatrix(matrix) {
  return matrix[0].map((_, col) => matrix.map((row) => row[col]));
}

function determinant(matrix) {
  if (matrix.length !== matrix[0].length) throw new Error("行列式は正方行列で計算します。");
  const copy = matrix.map((row) => [...row]);
  let det = 1;
  for (let col = 0; col < copy.length; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < copy.length; row += 1) {
      if (Math.abs(copy[row][col]) > Math.abs(copy[pivot][col])) pivot = row;
    }
    if (Math.abs(copy[pivot][col]) < 1e-12) return 0;
    if (pivot !== col) {
      [copy[pivot], copy[col]] = [copy[col], copy[pivot]];
      det *= -1;
    }
    const pivotValue = copy[col][col];
    det *= pivotValue;
    for (let row = col + 1; row < copy.length; row += 1) {
      const factor = copy[row][col] / pivotValue;
      for (let c = col + 1; c < copy.length; c += 1) copy[row][c] -= factor * copy[col][c];
    }
  }
  return det;
}

function matrixIdentity(size) { return Array.from({length:size},(_,r)=>Array.from({length:size},(_,c)=>r===c?1:0)); }
function inverseMatrix(matrix) {
  const n=matrix.length;
  if(n!==matrix[0].length) throw new Error("逆行列は正方行列で計算します。");
  const a=matrix.map((row,i)=>[...row,...matrixIdentity(n)[i]]);
  for(let col=0;col<n;col++){
    let pivot=col;
    for(let row=col+1;row<n;row++) if(Math.abs(a[row][col])>Math.abs(a[pivot][col])) pivot=row;
    if(Math.abs(a[pivot][col])<1e-12) throw new Error("行列式が0のため逆行列は存在しません。");
    [a[col],a[pivot]]=[a[pivot],a[col]];
    const divisor=a[col][col]; a[col]=a[col].map(v=>v/divisor);
    for(let row=0;row<n;row++) if(row!==col){ const factor=a[row][col]; for(let c=0;c<2*n;c++) a[row][c]-=factor*a[col][c]; }
  }
  return a.map(row=>row.slice(n));
}
function matrixRank(matrix) {
  const a=matrix.map(row=>[...row]); let rank=0, row=0;
  const rows=a.length, cols=a[0].length;
  for(let col=0;col<cols && row<rows;col++){
    let pivot=row; for(let r=row+1;r<rows;r++) if(Math.abs(a[r][col])>Math.abs(a[pivot][col])) pivot=r;
    if(Math.abs(a[pivot][col])<1e-10) continue;
    [a[row],a[pivot]]=[a[pivot],a[row]];
    const d=a[row][col]; for(let c=col;c<cols;c++) a[row][c]/=d;
    for(let r=0;r<rows;r++) if(r!==row){const f=a[r][col];for(let c=col;c<cols;c++)a[r][c]-=f*a[row][c];}
    row++;rank++;
  }
  return rank;
}
function matrixTrace(matrix){ if(matrix.length!==matrix[0].length) throw new Error("トレースは正方行列で計算します。"); return matrix.reduce((s,row,i)=>s+row[i],0); }
function eigenvalues2x2(matrix){
  if(matrix.length!==2||matrix[0].length!==2) throw new Error("固有値は現在2×2行列のみ対応しています。");
  const tr=matrixTrace(matrix), det=determinant(matrix), d=tr*tr-4*det;
  if(d>=0){const q=Math.sqrt(d);return [`λ₁ = ${formatNumber((tr+q)/2)}`,`λ₂ = ${formatNumber((tr-q)/2)}`].join("\n");}
  return `λ₁ = ${formatNumber(tr/2)} + ${formatNumber(Math.sqrt(-d)/2)}i\nλ₂ = ${formatNumber(tr/2)} - ${formatNumber(Math.sqrt(-d)/2)}i`;
}
function solveMatrixSystem(a,b){
  if(a.length!==a[0].length) throw new Error("Aは正方行列にしてください。");
  const n=a.length;
  const rhs=b.every(row=>row.length===1)?b.map(row=>row[0]):(b.length===1&&b[0].length===n?b[0]:null);
  if(!rhs||rhs.length!==n) throw new Error("BはAの行数と同じ長さの列ベクトル（1列）で入力してください。");
  const aug=a.map((row,i)=>[...row,rhs[i]]);
  for(let c=0;c<n;c++){
    let p=c;for(let r=c+1;r<n;r++)if(Math.abs(aug[r][c])>Math.abs(aug[p][c]))p=r;
    if(Math.abs(aug[p][c])<1e-12)throw new Error("一意な解がありません（Aが正則ではありません）。");
    [aug[c],aug[p]]=[aug[p],aug[c]];const d=aug[c][c];for(let j=c;j<=n;j++)aug[c][j]/=d;
    for(let r=0;r<n;r++)if(r!==c){const f=aug[r][c];for(let j=c;j<=n;j++)aug[r][j]-=f*aug[c][j];}
  }
  return aug.map(row=>row[n]);
}

$("#calculateMatrix").addEventListener("click", () => {
  try {
    const operation = $("#matrixOperation").value;
    const a = parseMatrix("#matrixA", "行列A");
    let result; let label="行列計算";
    if (operation === "add" || operation === "subtract" || operation === "multiply" || operation === "solveAxB") {
      const b = parseMatrix("#matrixB", "行列B");
      if(operation === "add") result = addMatrices(a,b);
      else if(operation === "subtract") result = addMatrices(a,b,-1);
      else if(operation === "multiply") result = multiplyMatrices(a,b);
      else { result=solveMatrixSystem(a,b).map(v=>[v]); label="連立一次方程式"; }
    } else if(operation === "transpose") result=transposeMatrix(a);
    else if(operation === "determinantA") result=determinant(a);
    else if(operation === "determinantB") result=determinant(parseMatrix("#matrixB","行列B"));
    else if(operation === "inverseA") result=inverseMatrix(a);
    else if(operation === "inverseB") result=inverseMatrix(parseMatrix("#matrixB","行列B"));
    else if(operation === "rankA") result=`rank(A) = ${matrixRank(a)}`;
    else if(operation === "rankB") result=`rank(B) = ${matrixRank(parseMatrix("#matrixB","行列B"))}`;
    else if(operation === "traceA") result=`tr(A) = ${formatNumber(matrixTrace(a))}`;
    else if(operation === "traceB") result=`tr(B) = ${formatNumber(matrixTrace(parseMatrix("#matrixB","行列B")))}`;
    else if(operation === "eigenA") result=eigenvalues2x2(a);
    const output = typeof result === "string" ? result : Array.isArray(result) ? result.map(row=>Array.isArray(row)?row.map(formatNumber).join("  "):formatNumber(row)).join("\n") : `結果 = ${formatNumber(result)}`;
    $("#matrixResults").textContent=output;
    addHistory(`行列: ${operation}`,output,"行列");
  } catch (error) { $("#matrixResults").textContent=error.message; }
});

/* =========================
   10. 複素数計算
   ========================= */
function complex(real, imaginary) { return { re: real, im: imaginary }; }
function complexAdd(a, b) { return complex(a.re + b.re, a.im + b.im); }
function complexSubtract(a, b) { return complex(a.re - b.re, a.im - b.im); }
function complexMultiply(a, b) { return complex(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re); }
function complexDivide(a, b) {
  const denominator = b.re * b.re + b.im * b.im;
  if (denominator === 0) throw new Error("0で複素数を割ることはできません。");
  return complex((a.re * b.re + a.im * b.im) / denominator, (a.im * b.re - a.re * b.im) / denominator);
}
function formatComplex(value) {
  const re = formatNumber(value.re);
  const im = formatNumber(Math.abs(value.im));
  if (Math.abs(value.im) < 1e-12) return re;
  if (Math.abs(value.re) < 1e-12) return `${value.im < 0 ? "-" : ""}${im}i`;
  return `${re} ${value.im < 0 ? "-" : "+"} ${im}i`;
}

$("#calculateComplex").addEventListener("click", () => {
  try {
    const a = complex(parseRequiredNumber("#complexAr", "Aの実部"), parseRequiredNumber("#complexAi", "Aの虚部"));
    const b = complex(parseRequiredNumber("#complexBr", "Bの実部"), parseRequiredNumber("#complexBi", "Bの虚部"));
    const op = $("#complexOperation").value;
    let result;
    const selected = op.endsWith("A") ? a : b;
    const power = (v,n)=>{let r=complex(1,0);for(let i=0;i<n;i++)r=complexMultiply(r,v);return r;};
    if (op === "add") result = complexAdd(a, b);
    else if (op === "subtract") result = complexSubtract(a, b);
    else if (op === "multiply") result = complexMultiply(a, b);
    else if (op === "divide") result = complexDivide(a, b);
    else if (op === "absA" || op === "absB") result = Math.hypot(selected.re, selected.im);
    else if (op === "conjA" || op === "conjB") result = complex(selected.re,-selected.im);
    else if (op === "argA" || op === "argB") { const angle=Math.atan2(selected.im,selected.re); result=angleMode==="DEG"?angle*180/Math.PI:angle; }
    else if (op === "polarA" || op === "polarB") { const radius=Math.hypot(selected.re,selected.im); const angle=Math.atan2(selected.im,selected.re); result=`r = ${formatNumber(radius)}\nθ = ${formatNumber(angleMode==="DEG"?angle*180/Math.PI:angle)} ${angleMode}`; }
    else if (op === "squareA" || op === "squareB") result=power(selected,2);
    $("#complexResults").textContent = typeof result === "number" ? formatNumber(result) : typeof result === "string" ? result : formatComplex(result);
    addHistory(`複素数: ${op}`,$("#complexResults").textContent,"複素数");
  } catch (error) { $("#complexResults").textContent = error.message; }
});

/* =========================
   11. 一次・二次方程式
   ========================= */
function refreshEquationFields() {
  const type=$("#equationType").value;
  $("#coefCGroup").hidden = type === "linear";
  const dGroup=$("#coefDGroup"); if(dGroup) dGroup.hidden = type !== "cubic";
}
$("#equationType").addEventListener("change", refreshEquationFields);
refreshEquationFields();

$("#solveEquation").addEventListener("click", () => {
  try {
    const a = parseRequiredNumber("#coefA", "係数a");
    const b = parseRequiredNumber("#coefB", "係数b");
    const type = $("#equationType").value;
    if (type === "linear") {
      if (a === 0 && b === 0) $("#equationResults").textContent = "解はすべての実数です（0x + 0 = 0）。";
      else if (a === 0) $("#equationResults").textContent = "解はありません（0x + b = 0、bが0ではありません）。";
      else $("#equationResults").textContent = `x = ${formatNumber(-b / a)}`;
      addHistory("一次方程式",$("#equationResults").textContent,"方程式"); return;
    }
    const c = parseRequiredNumber("#coefC", "係数c");
    if(type === "cubic") {
      const d=parseRequiredNumber("#coefD","係数d");
      if(Math.abs(a)<1e-14) throw new Error("三次の係数aは0以外にしてください。");
      const f=x=>((a*x+b)*x+c)*x+d;
      const bound=Math.max(1,1+Math.abs(b/a),1+Math.abs(c/a),1+Math.abs(d/a));
      const derivativeRoots=[]; const disc=4*b*b-12*a*c;
      if(disc>=0){const sq=Math.sqrt(disc);derivativeRoots.push((-2*b-sq)/(6*a),(-2*b+sq)/(6*a));}
      const cuts=[-bound,...derivativeRoots.filter(x=>x>-bound&&x<bound),bound].sort((u,v)=>u-v);
      const roots=[]; const addRoot=x=>{if(Number.isFinite(x)&&!roots.some(r=>Math.abs(r-x)<1e-7))roots.push(x);};
      for(const x of cuts) if(Math.abs(f(x))<1e-8*Math.max(1,Math.abs(a*x*x*x),Math.abs(b*x*x),Math.abs(c*x),Math.abs(d))) addRoot(x);
      for(let i=0;i<cuts.length-1;i++){
        let lo=cuts[i],hi=cuts[i+1],flo=f(lo),fhi=f(hi); if(flo===0||fhi===0||flo*fhi>0)continue;
        for(let k=0;k<100;k++){const mid=(lo+hi)/2,fm=f(mid);if(Math.abs(fm)<1e-13||Math.abs(hi-lo)<1e-12){lo=hi=mid;break;}if(flo*fm<=0){hi=mid;fhi=fm;}else{lo=mid;flo=fm;}}
        addRoot((lo+hi)/2);
      }
      roots.sort((u,v)=>u-v);
      $("#equationResults").textContent=roots.length?`実数解（数値近似）\n${roots.map((r,i)=>`x${i+1} ≈ ${formatNumber(r)}`).join("\n")}\n検出された実数解：${roots.length}個`:`指定範囲内に実数解を検出できませんでした。`;
      addHistory("三次方程式",`(${a})x^3+(${b})x^2+(${c})x+(${d})=0`,$("#equationResults").textContent,"方程式");return;
    }
    if (a === 0) {
      if (b === 0) $("#equationResults").textContent = c === 0 ? "解はすべての実数です。" : "解はありません。";
      else $("#equationResults").textContent = `二次の係数aが0なので一次方程式です。\nx = ${formatNumber(-c / b)}`;
      return;
    }
    const discriminant = b * b - 4 * a * c;
    if (discriminant > 0) {
      const root1 = (-b + Math.sqrt(discriminant)) / (2 * a);
      const root2 = (-b - Math.sqrt(discriminant)) / (2 * a);
      $("#equationResults").textContent = `判別式 D = ${formatNumber(discriminant)}\nx₁ = ${formatNumber(root1)}\nx₂ = ${formatNumber(root2)}`;
    } else if (Math.abs(discriminant) < 1e-12) {
      $("#equationResults").textContent = `判別式 D = 0\nx = ${formatNumber(-b / (2 * a))}（重解）`;
    } else {
      const real = -b / (2 * a);
      const imaginary = Math.sqrt(-discriminant) / Math.abs(2 * a);
      $("#equationResults").textContent = `判別式 D = ${formatNumber(discriminant)}\nx₁ = ${formatNumber(real)} + ${formatNumber(imaginary)}i\nx₂ = ${formatNumber(real)} - ${formatNumber(imaginary)}i`;
    }
    addHistory("二次方程式",`(${a})x²+(${b})x+(${c})=0`,$("#equationResults").textContent,"方程式");
  } catch (error) { $("#equationResults").textContent = error.message; }
});

/* =========================
   12. 統計計算
   ========================= */
function parseStatistics(source) {
  const parts = source.trim().split(/[\s,;]+/).filter(Boolean);
  if (parts.length === 0) throw new Error("数値を1つ以上入力してください。");
  const numbers = parts.map(Number);
  if (numbers.some((number) => !Number.isFinite(number))) throw new Error("数字以外の値が含まれています。");
  return numbers;
}

function calculateStatistics(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  const count = numbers.length;
  const sum = numbers.reduce((total, value) => total + value, 0);
  const mean = sum / count;
  const middle = Math.floor(count / 2);
  const median = count % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  const lowerHalf = sorted.slice(0, middle);
  const upperHalf = sorted.slice(count % 2 ? middle + 1 : middle);
  const medianOf = (arr) => arr.length ? (arr.length % 2 ? arr[(arr.length-1)/2] : (arr[arr.length/2-1]+arr[arr.length/2])/2) : null;
  const q1=medianOf(lowerHalf), q3=medianOf(upperHalf);
  const sumSquared = numbers.reduce((total, value) => total + (value - mean) ** 2, 0);
  const populationVariance = sumSquared / count;
  const sampleVariance = count > 1 ? sumSquared / (count - 1) : null;
  const modeCounts = new Map();
  numbers.forEach((value) => modeCounts.set(value, (modeCounts.get(value) || 0) + 1));
  const maxFrequency = Math.max(...modeCounts.values());
  const modes = maxFrequency > 1 ? [...modeCounts].filter(([, frequency]) => frequency === maxFrequency).map(([value]) => value) : [];
  return { count, sum, mean, median, q1, q3, iqr: q1===null||q3===null?null:q3-q1, min: sorted[0], max: sorted[sorted.length - 1], range: sorted[sorted.length - 1] - sorted[0], populationStd: Math.sqrt(populationVariance), sampleStd: sampleVariance === null ? null : Math.sqrt(sampleVariance), modes };
}

$("#calculateStats").addEventListener("click", () => {
  try {
    const values = parseStatistics($("#statsInput").value);
    const stats = calculateStatistics(values);
    const items = [
      ["個数 n", stats.count], ["合計", formatNumber(stats.sum)], ["平均", formatNumber(stats.mean)],
      ["中央値", formatNumber(stats.median)], ["第1四分位数 Q1", stats.q1===null?"データ不足":formatNumber(stats.q1)], ["第3四分位数 Q3", stats.q3===null?"データ不足":formatNumber(stats.q3)],
      ["四分位範囲 IQR", stats.iqr===null?"データ不足":formatNumber(stats.iqr)], ["最小値", formatNumber(stats.min)], ["最大値", formatNumber(stats.max)],
      ["範囲", formatNumber(stats.range)], ["母標準偏差", formatNumber(stats.populationStd)],
      ["標本標準偏差", stats.sampleStd === null ? "データが1件のため計算不可" : formatNumber(stats.sampleStd)],
      ["最頻値", stats.modes.length ? stats.modes.map(formatNumber).join(", ") : "なし（重複なし）"]
    ];
    $("#statsResults").replaceChildren();
    items.forEach(([label, value]) => {
      const item = document.createElement("div");
      item.className = "stat-item";
      const name = document.createElement("span");
      name.textContent = label;
      const result = document.createElement("strong");
      result.textContent = String(value);
      item.append(name, result);
      $("#statsResults").appendChild(item);
    });
    drawStatisticsHistogram(values);
    addHistory(`統計: ${values.join(", ")}`,`平均 ${formatNumber(stats.mean)} / 中央値 ${formatNumber(stats.median)}`,"統計");
  } catch (error) { $("#statsResults").textContent = error.message; }
});

/* =========================
   13. 高機能な関数グラフ
   ========================= */
const GRAPH_COLORS = ["#326fd0", "#df7542", "#23956e", "#a052c7"];
let graphView = null;
let graphInitialRange = { xMin: -10, xMax: 10 };
let renderedGraphView = null;
let graphCursor = null;
let graphDrag = null;
let graphIntersections = [];
let graphTangent = null;
let graphIntegral = null;
let graphAnimationTimer = null;
let graphParameter = Number($("#graphParam").value);

function graphFunctionEntries() {
  return [
    { id: 1, expression: $("#graphExpression").value.trim() },
    { id: 2, expression: $("#graphExpression2").value.trim() },
    { id: 3, expression: $("#graphExpression3").value.trim() },
    { id: 4, expression: $("#graphExpression4").value.trim() }
  ].filter((entry) => entry.expression.length > 0).map((entry) => {
    const vertical = entry.expression.match(/^x\\s*=\\s*(.+)$/i);
    if (!vertical) return { ...entry, vertical: false };
    const xValue = evaluateExpression(vertical[1], { angleMode, ans: answerValue });
    if (!Number.isFinite(xValue)) throw new Error(`f${entry.id}: x= の右側は実数の定数式にしてください。`);
    return { ...entry, vertical: true, xValue };
  });
}

function graphFunctionById(id) {
  return graphFunctionEntries().find((entry) => entry.id === Number(id));
}

function evaluateGraphFunction(expression, x, parameter = graphParameter) {
  // 独立した変数 a だけを現在のスライダー値に置き換える。eval() は使用しない。
  const substitutedExpression = expression.replace(/\ba\b/gi, `(${parameter})`);
  return evaluateExpression(substitutedExpression, { angleMode, ans: answerValue, x });
}

function graphFailure(selector, error) {
  const element = $(selector);
  if (element) element.textContent = error.message || String(error);
}

function graphSetMessage(message, isError = false) {
  const target = $("#graphMessage");
  target.textContent = message;
  target.classList.toggle("error-message", isError);
}

function graphFormat(value) {
  if (!Number.isFinite(value)) return "定義されません";
  if (Object.is(value, -0) || Math.abs(value) < 1e-12) value = 0;
  return String(Number(value.toPrecision(7)));
}

function graphSample(entry, xMin, xMax, count = 900) {
  const points = [];
  for (let index = 0; index <= count; index += 1) {
    const x = xMin + (xMax - xMin) * index / count;
    let y = null;
    try {
      const result = evaluateGraphFunction(entry.expression, x);
      if (Number.isFinite(result) && Math.abs(result) < 1e7) y = result;
    } catch (error) {
      y = null;
    }
    points.push({ x, y });
  }
  return points;
}

function graphGetCanvasGeometry() {
  const canvas = $("#graphCanvas");
  const width = canvas.width;
  const height = canvas.height;
  const padding = { left: 68, right: 25, top: 28, bottom: 46 };
  return { canvas, width, height, padding, plotWidth: width - padding.left - padding.right, plotHeight: height - padding.top - padding.bottom };
}

function graphCreateView(entries) {
  const xMin = Number($("#graphMin").value);
  const xMax = Number($("#graphMax").value);
  if (!Number.isFinite(xMin) || !Number.isFinite(xMax) || xMin >= xMax) {
    throw new Error("xの最小値は最大値より小さい有限の数値にしてください。");
  }
  const allSamples = entries.filter((entry) => !entry.vertical).map((entry) => ({ entry, points: graphSample(entry, xMin, xMax, 700) }));
  const values = allSamples.flatMap((series) => series.points.map((point) => point.y).filter((value) => Number.isFinite(value) && Math.abs(value) < 1e5));
  if (values.length === 0 && !entries.some((entry) => entry.vertical)) throw new Error("グラフを描けません。関数式やxの範囲を確認してください。");
  if (values.length === 0) values.push(-5, 5);
  let yMin = Math.min(...values);
  let yMax = Math.max(...values);
  if (Math.abs(yMax - yMin) < 1e-10) {
    const center = (yMax + yMin) / 2;
    yMin = center - Math.max(1, Math.abs(center) * 0.1);
    yMax = center + Math.max(1, Math.abs(center) * 0.1);
  }
  const margin = (yMax - yMin) * 0.09;
  return { xMin, xMax, yMin: yMin - margin, yMax: yMax + margin, autoY: true };
}

function graphSyncRangeInputs(view) {
  $("#graphMin").value = graphFormat(view.xMin);
  $("#graphMax").value = graphFormat(view.xMax);
}

function graphCoordinates(view, geometry) {
  const { padding, plotWidth, plotHeight, height } = geometry;
  return {
    xToPixel: (x) => padding.left + (x - view.xMin) / (view.xMax - view.xMin) * plotWidth,
    yToPixel: (y) => padding.top + (view.yMax - y) / (view.yMax - view.yMin) * plotHeight,
    pixelToX: (px) => view.xMin + (px - padding.left) / plotWidth * (view.xMax - view.xMin),
    pixelToY: (py) => view.yMax - (py - padding.top) / plotHeight * (view.yMax - view.yMin),
    plotRight: padding.left + plotWidth,
    plotBottom: padding.top + plotHeight,
    height
  };
}

function graphDrawGrid(context, view, geometry, coords, dark) {
  const { width, height, padding, plotWidth, plotHeight } = geometry;
  context.strokeStyle = dark ? "#35445b" : "#e5eaf2";
  context.lineWidth = 1;
  context.fillStyle = dark ? "#a8b6ca" : "#6d7b91";
  context.font = "13px sans-serif";
  context.textBaseline = "middle";
  for (let index = 0; index <= 10; index += 1) {
    const xPixel = padding.left + plotWidth * index / 10;
    const xValue = view.xMin + (view.xMax - view.xMin) * index / 10;
    context.beginPath(); context.moveTo(xPixel, padding.top); context.lineTo(xPixel, padding.top + plotHeight); context.stroke();
    context.textAlign = "center";
    context.fillText(graphFormat(xValue), xPixel, height - 19);
  }
  for (let index = 0; index <= 8; index += 1) {
    const yPixel = padding.top + plotHeight * index / 8;
    const yValue = view.yMax - (view.yMax - view.yMin) * index / 8;
    context.beginPath(); context.moveTo(padding.left, yPixel); context.lineTo(padding.left + plotWidth, yPixel); context.stroke();
    context.textAlign = "right";
    context.fillText(graphFormat(yValue), padding.left - 9, yPixel);
  }
  context.strokeStyle = dark ? "#a8b6ca" : "#6d7b91";
  context.lineWidth = 1.7;
  if (view.xMin <= 0 && view.xMax >= 0) {
    const zeroX = coords.xToPixel(0);
    context.beginPath(); context.moveTo(zeroX, padding.top); context.lineTo(zeroX, padding.top + plotHeight); context.stroke();
  }
  if (view.yMin <= 0 && view.yMax >= 0) {
    const zeroY = coords.yToPixel(0);
    context.beginPath(); context.moveTo(padding.left, zeroY); context.lineTo(padding.left + plotWidth, zeroY); context.stroke();
  }
}

function graphDrawIntegral(context, view, geometry, coords) {
  if (!graphIntegral) return;
  const lower = Math.min(graphIntegral.lower, graphIntegral.upper);
  const upper = Math.max(graphIntegral.lower, graphIntegral.upper);
  const start = Math.max(lower, view.xMin);
  const end = Math.min(upper, view.xMax);
  if (start >= end) return;
  context.save();
  context.beginPath();
  context.rect(geometry.padding.left, geometry.padding.top, geometry.plotWidth, geometry.plotHeight);
  context.clip();
  context.fillStyle = "rgba(35, 149, 110, 0.20)";
  context.strokeStyle = "rgba(35, 149, 110, 0.85)";
  context.lineWidth = 1.5;
  context.beginPath();
  context.moveTo(coords.xToPixel(start), coords.yToPixel(0));
  const count = 220;
  for (let index = 0; index <= count; index += 1) {
    const x = start + (end - start) * index / count;
    try {
      const y = evaluateGraphFunction(graphIntegral.expression, x);
      context.lineTo(coords.xToPixel(x), coords.yToPixel(y));
    } catch (error) {
      context.lineTo(coords.xToPixel(x), coords.yToPixel(0));
    }
  }
  context.lineTo(coords.xToPixel(end), coords.yToPixel(0));
  context.closePath();
  context.fill();
  context.stroke();
  context.restore();
}

function graphDrawCurve(context, points, color, view, geometry, coords) {
  context.save();
  context.beginPath();
  context.rect(geometry.padding.left, geometry.padding.top, geometry.plotWidth, geometry.plotHeight);
  context.clip();
  context.strokeStyle = color;
  context.lineWidth = 2.7;
  context.lineJoin = "round";
  context.beginPath();
  let drawing = false;
  let previousY = null;
  for (const point of points) {
    if (point.y === null || !Number.isFinite(point.y)) { drawing = false; previousY = null; continue; }
    const px = coords.xToPixel(point.x);
    const py = coords.yToPixel(point.y);
    if (py < geometry.padding.top - geometry.plotHeight * 2 || py > geometry.padding.top + geometry.plotHeight * 3) { drawing = false; previousY = null; continue; }
    if (!drawing || (previousY !== null && Math.abs(py - previousY) > geometry.plotHeight * 0.6)) context.moveTo(px, py);
    else context.lineTo(px, py);
    drawing = true;
    previousY = py;
  }
  context.stroke();
  context.restore();
}

function graphDrawVerticalLines(context, entries, geometry, coords, dark) {
  const verticals = entries.filter((entry) => entry.vertical);
  if (!verticals.length) return;
  context.save();
  context.beginPath();
  context.rect(geometry.padding.left, geometry.padding.top, geometry.plotWidth, geometry.plotHeight);
  context.clip();
  verticals.forEach((entry) => {
    if (entry.xValue < geometry.view.xMin || entry.xValue > geometry.view.xMax) return;
    const px = coords.xToPixel(entry.xValue);
    context.strokeStyle = GRAPH_COLORS[entry.id - 1];
    context.lineWidth = 2.5;
    context.setLineDash([8, 5]);
    context.beginPath(); context.moveTo(px, geometry.padding.top); context.lineTo(px, coords.plotBottom); context.stroke();
    context.setLineDash([]);
    context.fillStyle = dark ? "#e8eef7" : "#26364d";
    context.font = "12px sans-serif";
    context.fillText(`x = ${graphFormat(entry.xValue)}`, Math.min(px + 5, coords.plotRight - 90), geometry.padding.top + 14);
  });
  context.restore();
}

function graphDrawTangent(context, geometry, coords) {
  if (!graphTangent) return;
  const x1 = coords.xToPixel(geometry.view.xMin);
  const x2 = coords.xToPixel(geometry.view.xMax);
  const y1 = graphTangent.y0 + graphTangent.slope * (geometry.view.xMin - graphTangent.x0);
  const y2 = graphTangent.y0 + graphTangent.slope * (geometry.view.xMax - graphTangent.x0);
  context.save();
  context.beginPath(); context.rect(geometry.padding.left, geometry.padding.top, geometry.plotWidth, geometry.plotHeight); context.clip();
  context.setLineDash([9, 5]); context.strokeStyle = "#db3c73"; context.lineWidth = 2.5;
  context.beginPath(); context.moveTo(x1, coords.yToPixel(y1)); context.lineTo(x2, coords.yToPixel(y2)); context.stroke();
  context.setLineDash([]); context.fillStyle = "#db3c73"; context.beginPath(); context.arc(coords.xToPixel(graphTangent.x0), coords.yToPixel(graphTangent.y0), 5, 0, Math.PI * 2); context.fill();
  context.restore();
}

function graphRenderLegend(entries) {
  const legend = $("#graphLegend");
  legend.replaceChildren();
  entries.forEach((entry, index) => {
    const item = document.createElement("span");
    item.className = "graph-legend-item";
    const swatch = document.createElement("span");
    swatch.className = "graph-legend-swatch";
    swatch.style.background = GRAPH_COLORS[entry.id - 1];
    const label = document.createElement("span");
    label.textContent = entry.vertical ? `f${entry.id}: ${entry.expression}（垂直線）` : `f${entry.id}(x) = ${entry.expression}`;
    item.append(swatch, label);
    legend.appendChild(item);
  });
  if ($( "#graphParam")) $("#graphParamValue").textContent = `a = ${graphFormat(graphParameter)}`;
}

function graphDrawCursor(context, geometry, coords, entries) {
  if (!graphCursor) return;
  const px = coords.xToPixel(graphCursor.x);
  const py = coords.yToPixel(graphCursor.y);
  if (px < geometry.padding.left || px > coords.plotRight || py < geometry.padding.top || py > coords.plotBottom) return;
  context.save();
  context.beginPath(); context.rect(geometry.padding.left, geometry.padding.top, geometry.plotWidth, geometry.plotHeight); context.clip();
  context.strokeStyle = "rgba(110, 125, 149, .75)"; context.setLineDash([4, 4]);
  context.beginPath(); context.moveTo(px, geometry.padding.top); context.lineTo(px, coords.plotBottom); context.moveTo(geometry.padding.left, py); context.lineTo(coords.plotRight, py); context.stroke();
  entries.forEach((entry) => {
    try {
      const y = evaluateGraphFunction(entry.expression, graphCursor.x);
      if (y < renderedGraphView.yMin || y > renderedGraphView.yMax) return;
      context.fillStyle = GRAPH_COLORS[entry.id - 1]; context.beginPath(); context.arc(px, coords.yToPixel(y), 4, 0, Math.PI * 2); context.fill();
    } catch (error) { /* 関数がその場所で定義されない場合は点を描かない */ }
  });
  context.restore();
}

function drawGraph() {
  const canvas = $("#graphCanvas");
  if (!canvas) return;
  const context = canvas.getContext("2d");
  if (!context) return;
  const geometry = graphGetCanvasGeometry();
  const dark = document.body.classList.contains("dark");
  context.clearRect(0, 0, geometry.width, geometry.height);
  context.fillStyle = dark ? "#1b2637" : "#ffffff";
  context.fillRect(0, 0, geometry.width, geometry.height);
  try {
    const entries = graphFunctionEntries();
    if (entries.length === 0) { graphSetMessage("関数式を少なくとも1つ入力してください。", true); return; }
    let view;
    let series;
    if (graphView) {
      view = { ...graphView };
      series = entries.filter((entry) => !entry.vertical).map((entry) => ({ entry, points: graphSample(entry, view.xMin, view.xMax) }));
    } else {
      const auto = graphCreateView(entries);
      view = auto;
      series = entries.filter((entry) => !entry.vertical).map((entry) => ({ entry, points: graphSample(entry, view.xMin, view.xMax) }));
    }
    const coords = graphCoordinates(view, geometry);
    geometry.view = view;
    renderedGraphView = { ...view };
    graphDrawGrid(context, view, geometry, coords, dark);
    graphDrawIntegral(context, view, geometry, coords);
    series.forEach(({ entry, points }) => graphDrawCurve(context, points, GRAPH_COLORS[entry.id - 1], view, geometry, coords));
    graphDrawVerticalLines(context, entries, geometry, coords, dark);
    graphDrawTangent(context, geometry, coords);
    context.save();
    context.beginPath(); context.rect(geometry.padding.left, geometry.padding.top, geometry.plotWidth, geometry.plotHeight); context.clip();
    graphIntersections.forEach((point) => {
      if (point.x < view.xMin || point.x > view.xMax || point.y < view.yMin || point.y > view.yMax) return;
      context.fillStyle = "#b63e9b"; context.strokeStyle = dark ? "#ffffff" : "#ffffff"; context.lineWidth = 2;
      context.beginPath(); context.arc(coords.xToPixel(point.x), coords.yToPixel(point.y), 6, 0, Math.PI * 2); context.fill(); context.stroke();
    });
    context.restore();
    graphDrawCursor(context, geometry, coords, entries);
    graphRenderLegend(entries);
    const viewLabel = graphView ? "手動表示範囲" : "y軸は自動調整";
    graphSetMessage(`${entries.length}個の関数を描画中。x：${graphFormat(view.xMin)} ～ ${graphFormat(view.xMax)} ／ ${viewLabel} ／ 角度：${angleMode}`);
    if (graphCursor) graphUpdateProbe(graphCursor.x, graphCursor.y, entries);
  } catch (error) {
    graphSetMessage(error.message || "グラフを描けません。式やxの範囲を確認してください。", true);
  }
}

function graphUpdateProbe(x, y, entries = graphFunctionEntries()) {
  const details = [`x ≈ ${graphFormat(x)}`, `ポインター位置のy ≈ ${graphFormat(y)}`];
  entries.forEach((entry) => {
    try { details.push(`f${entry.id}(x) ≈ ${graphFormat(evaluateGraphFunction(entry.expression, x))}`); }
    catch (error) { details.push(`f${entry.id}(x)：未定義`); }
  });
  $("#graphProbe").textContent = details.join("　｜　");
}

function graphEvaluateAt(entry, x) {
  if (!entry) throw new Error("選択した関数の式が空です。関数式を入力してグラフを描いてください。");
  if (entry.vertical) throw new Error("x=定数の垂直線は、交点・接線・積分の対象にできません。");
  return evaluateGraphFunction(entry.expression, x);
}

function graphFindIntersections() {
  const idA = Number($("#intersectionFunctionA").value);
  const idB = Number($("#intersectionFunctionB").value);
  if (idA === idB) throw new Error("別々の関数を2つ選んでください。");
  const entryA = graphFunctionById(idA);
  const entryB = graphFunctionById(idB);
  if (!entryA || !entryB) throw new Error("選択した2つの関数の式を入力してください。");
  const xMin = renderedGraphView?.xMin ?? Number($("#graphMin").value);
  const xMax = renderedGraphView?.xMax ?? Number($("#graphMax").value);
  const steps = 3000;
  const roots = [];
  const difference = (x) => graphEvaluateAt(entryA, x) - graphEvaluateAt(entryB, x);
  const samples = [];
  for (let index = 0; index <= steps; index += 1) {
    const x = xMin + (xMax - xMin) * index / steps;
    let value = null;
    try { value = difference(x); } catch (error) { value = null; }
    samples.push({ x, value });
  }
  const normalizedA = entryA.expression.replace(/\s+/g, "").toLowerCase();
  const normalizedB = entryB.expression.replace(/\s+/g, "").toLowerCase();
  const coincident = normalizedA === normalizedB || samples.every((sample) => sample.value !== null && Math.abs(sample.value) < 1e-10);
  if (coincident) {
    graphIntersections = [];
    $("#intersectionResults").textContent = "2つの式は同じ、またはこの範囲で数値的に一致しています。交点は1つに限らず、無数にある可能性があります。";
    drawGraph();
    return;
  }
  function addRoot(candidateX) {
    if (!Number.isFinite(candidateX) || candidateX < xMin - 1e-8 || candidateX > xMax + 1e-8) return;
    let yA, yB;
    try { yA = graphEvaluateAt(entryA, candidateX); yB = graphEvaluateAt(entryB, candidateX); }
    catch (error) { return; }
    const residual = Math.abs(yA - yB);
    const scale = Math.max(1, Math.abs(yA), Math.abs(yB));
    if (!Number.isFinite(yA) || !Number.isFinite(yB) || residual > 1e-6 * scale) return;
    const duplicateTolerance = 1e-6 * Math.max(1, Math.abs(candidateX));
    if (roots.some((root) => Math.abs(root.x - candidateX) <= duplicateTolerance)) return;
    roots.push({ x: candidateX, y: (yA + yB) / 2 });
  }
  // 符号が変わる区間を二分法で絞り込み、交差する交点を探す。
  for (let index = 1; index < samples.length; index += 1) {
    const leftSample = samples[index - 1];
    const rightSample = samples[index];
    const leftValue = leftSample.value;
    const rightValue = rightSample.value;
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) continue;
    if (Math.abs(leftValue) < 1e-10) addRoot(leftSample.x);
    if (Math.sign(leftValue) === Math.sign(rightValue) || leftValue === 0 || rightValue === 0) continue;
    let left = leftSample.x;
    let right = rightSample.x;
    let fLeft = leftValue;
    let usableInterval = true;
    for (let iteration = 0; iteration < 60; iteration += 1) {
      const middle = (left + right) / 2;
      let fMiddle;
      try { fMiddle = difference(middle); } catch (error) { usableInterval = false; break; }
      if (!Number.isFinite(fMiddle)) { usableInterval = false; break; }
      if (Math.abs(fMiddle) < 1e-12 || Math.abs(right - left) < 1e-12) {
        left = middle;
        right = middle;
        break;
      }
      if (Math.sign(fMiddle) === Math.sign(fLeft)) { left = middle; fLeft = fMiddle; }
      else right = middle;
    }
    if (usableInterval) addRoot((left + right) / 2);
  }
  if (Number.isFinite(samples[samples.length - 1].value) && Math.abs(samples[samples.length - 1].value) < 1e-10) addRoot(samples[samples.length - 1].x);

  // 接するだけで符号が変わらない交点も、局所最小値の数値近似で探す。
  for (let index = 1; index < samples.length - 1; index += 1) {
    const before = samples[index - 1];
    const current = samples[index];
    const after = samples[index + 1];
    if (![before.value, current.value, after.value].every(Number.isFinite)) continue;
    if (Math.sign(before.value) !== Math.sign(current.value) || Math.sign(current.value) !== Math.sign(after.value)) continue;
    if (Math.abs(current.value) > Math.abs(before.value) || Math.abs(current.value) > Math.abs(after.value)) continue;
    let left = before.x;
    let right = after.x;
    const ratio = (Math.sqrt(5) - 1) / 2;
    let c = right - ratio * (right - left);
    let d = left + ratio * (right - left);
    let fc, fd;
    try { fc = Math.abs(difference(c)); fd = Math.abs(difference(d)); }
    catch (error) { continue; }
    let usableMinimum = true;
    for (let iteration = 0; iteration < 45; iteration += 1) {
      try {
        if (fc < fd) {
          right = d; d = c; fd = fc; c = right - ratio * (right - left); fc = Math.abs(difference(c));
        } else {
          left = c; c = d; fc = fd; d = left + ratio * (right - left); fd = Math.abs(difference(d));
        }
      } catch (error) { usableMinimum = false; break; }
    }
    if (!usableMinimum) continue;
    const candidate = (left + right) / 2;
    try { if (Math.abs(difference(candidate)) < 1e-7) addRoot(candidate); }
    catch (error) { /* 不連続点では接する交点の探索を諦める */ }
  }
  roots.sort((first, second) => first.x - second.x);
  graphIntersections = roots;
  if (roots.length) {
    $("#intersectionResults").textContent = `${roots.length}個の交点候補（数値近似）\n` + roots.map((root, index) => `${index + 1}. x ≈ ${graphFormat(root.x)}, y ≈ ${graphFormat(root.y)}`).join("\n") + "\n※非常に近い交点や不連続点付近は検出できない場合があります。";
  } else {
    $("#intersectionResults").textContent = "表示範囲内で交点を検出できませんでした。式や範囲を変えて試してください。数値探索では非常に近い交点や不連続点付近を見逃す場合があります。";
  }
  drawGraph();
}

function graphDrawTangentAction() {
  const entry = graphFunctionById($("#tangentFunction").value);
  const x0 = parseRequiredNumber("#tangentX", "接点x₀");
  const y0 = graphEvaluateAt(entry, x0);
  const h = 1e-5 * Math.max(1, Math.abs(x0));
  const yPlus = graphEvaluateAt(entry, x0 + h);
  const yMinus = graphEvaluateAt(entry, x0 - h);
  const slope = (yPlus - yMinus) / (2 * h);
  if (!Number.isFinite(slope)) throw new Error("この位置では微分係数を近似できません。");
  graphTangent = { id: entry.id, expression: entry.expression, x0, y0, slope };
  $("#tangentResults").textContent = `対象：f${entry.id}(x) = ${entry.expression}\nf(x₀) ≈ ${graphFormat(y0)}\nf′(x₀) ≈ ${graphFormat(slope)}\n接線：y ≈ ${graphFormat(y0)} + (${graphFormat(slope)}) * (x - ${graphFormat(x0)})\n※中央差分による数値近似です。`;
  drawGraph();
}

function graphIntegrate(entry, lower, upper) {
  if (lower === upper) return 0;
  if (lower > upper) return -graphIntegrate(entry, upper, lower);
  const intervalCount = 1000;
  const h = (upper - lower) / intervalCount;
  let sum = graphEvaluateAt(entry, lower) + graphEvaluateAt(entry, upper);
  for (let index = 1; index < intervalCount; index += 1) {
    const x = lower + index * h;
    sum += (index % 2 === 0 ? 2 : 4) * graphEvaluateAt(entry, x);
  }
  return sum * h / 3;
}

function graphCalculateIntegralAction() {
  const entry = graphFunctionById($("#integralFunction").value);
  const lower = parseRequiredNumber("#integralLower", "積分の下限");
  const upper = parseRequiredNumber("#integralUpper", "積分の上限");
  const result = graphIntegrate(entry, lower, upper);
  graphIntegral = { id: entry.id, expression: entry.expression, lower, upper, result };
  $("#integralResults").textContent = `対象：f${entry.id}(x) = ${entry.expression}\n区間：${graphFormat(lower)} ～ ${graphFormat(upper)}\n定積分 ≈ ${graphFormat(result)}\n※シンプソン法による数値近似。グラフ上ではy=0との符号付き面積を緑色で表示します。`;
  drawGraph();
}

function graphZoom(factor, anchorX = null, anchorY = null) {
  if (!renderedGraphView) drawGraph();
  if (!renderedGraphView) return;
  const view = graphView ? { ...graphView } : { ...renderedGraphView };
  const centerX = anchorX === null ? (view.xMin + view.xMax) / 2 : anchorX;
  const centerY = anchorY === null ? (view.yMin + view.yMax) / 2 : anchorY;
  graphView = {
    xMin: centerX + (view.xMin - centerX) * factor,
    xMax: centerX + (view.xMax - centerX) * factor,
    yMin: centerY + (view.yMin - centerY) * factor,
    yMax: centerY + (view.yMax - centerY) * factor,
    autoY: false
  };
  graphSyncRangeInputs(graphView);
  drawGraph();
}

function graphResetView() {
  graphView = null;
  $("#graphMin").value = graphInitialRange.xMin;
  $("#graphMax").value = graphInitialRange.xMax;
  graphCursor = null;
  drawGraph();
}

function graphPointerPosition(event) {
  const geometry = graphGetCanvasGeometry();
  const rect = geometry.canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * geometry.width / rect.width,
    y: (event.clientY - rect.top) * geometry.height / rect.height,
    geometry
  };
}

function graphCursorMove(event) {
  if (!renderedGraphView || graphDrag) return;
  const point = graphPointerPosition(event);
  const coords = graphCoordinates(renderedGraphView, point.geometry);
  if (point.x < point.geometry.padding.left || point.x > coords.plotRight || point.y < point.geometry.padding.top || point.y > coords.plotBottom) return;
  graphCursor = { x: coords.pixelToX(point.x), y: coords.pixelToY(point.y) };
  graphUpdateProbe(graphCursor.x, graphCursor.y);
  drawGraph();
}

function graphSavePng() {
  const canvas = $("#graphCanvas");
  if (!canvas) return;
  canvas.toBlob((blob) => {
    if (!blob) { graphSetMessage("PNG画像を作成できませんでした。", true); return; }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `aurora-graph-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    graphSetMessage("現在のグラフをPNG画像として保存しました。");
  }, "image/png");
}

function graphToggleAnimation() {
  if (graphAnimationTimer !== null) {
    window.clearInterval(graphAnimationTimer);
    graphAnimationTimer = null;
    $("#graphAnimate").textContent = "▶ アニメーション開始";
    return;
  }
  $("#graphAnimate").textContent = "■ アニメーション停止";
  const speed = Number($("#graphAnimationSpeed")?.value || 75);
  graphAnimationTimer = window.setInterval(() => {
    const slider = $("#graphParam");
    let next = Number(slider.value) + 0.1;
    if (next > Number(slider.max) + 1e-8) next = Number(slider.min);
    slider.value = next.toFixed(1);
    graphParameter = Number(slider.value);
    $("#graphParamValue").textContent = `a = ${graphFormat(graphParameter)}`;
    drawGraph();
  }, Math.max(20, Math.min(1000, speed)));
}

$("#plotGraph").addEventListener("click", () => {
  graphView = null;
  const nextMin = Number($("#graphMin").value);
  const nextMax = Number($("#graphMax").value);
  if (Number.isFinite(nextMin) && Number.isFinite(nextMax) && nextMin < nextMax) {
    graphInitialRange = { xMin: nextMin, xMax: nextMax };
  }
  graphIntersections = [];
  graphTangent = null;
  graphIntegral = null;
  drawGraph();
});
["#graphExpression", "#graphExpression2", "#graphExpression3", "#graphExpression4", "#graphMin", "#graphMax"].forEach((selector) => {
  $(selector).addEventListener("keydown", (event) => { if (event.key === "Enter") $("#plotGraph").click(); });
});
$("#graphZoomIn").addEventListener("click", () => graphZoom(0.8));
$("#graphZoomOut").addEventListener("click", () => graphZoom(1.25));
$("#graphResetView").addEventListener("click", graphResetView);
$("#graphSavePng").addEventListener("click", graphSavePng);
$("#graphParam").addEventListener("input", () => {
  graphParameter = Number($("#graphParam").value);
  $("#graphParamValue").textContent = `a = ${graphFormat(graphParameter)}`;
  drawGraph();
});
$("#graphAnimate").addEventListener("click", graphToggleAnimation);
$("#findIntersections").addEventListener("click", () => {
  try { graphFindIntersections(); }
  catch (error) { graphFailure("#intersectionResults", error); graphSetMessage(error.message, true); }
});
$("#drawTangent").addEventListener("click", () => {
  try { graphDrawTangentAction(); }
  catch (error) { graphFailure("#tangentResults", error); graphSetMessage(error.message, true); }
});
$("#calculateIntegral").addEventListener("click", () => {
  try { graphCalculateIntegralAction(); }
  catch (error) { graphFailure("#integralResults", error); graphSetMessage(error.message, true); }
});

const graphCanvas = $("#graphCanvas");
graphCanvas.addEventListener("pointerdown", (event) => {
  if (!renderedGraphView) return;
  graphCanvas.setPointerCapture(event.pointerId);
  graphDrag = { pointerId: event.pointerId, start: graphPointerPosition(event), view: graphView ? { ...graphView } : { ...renderedGraphView }, moved: false };
  graphCanvas.classList.add("is-dragging");
});
graphCanvas.addEventListener("pointermove", (event) => {
  if (!graphDrag) { graphCursorMove(event); return; }
  const now = graphPointerPosition(event);
  const geometry = now.geometry;
  const dx = now.x - graphDrag.start.x;
  const dy = now.y - graphDrag.start.y;
  if (Math.hypot(dx, dy) > 5) graphDrag.moved = true;
  const old = graphDrag.view;
  const deltaX = -dx / geometry.plotWidth * (old.xMax - old.xMin);
  const deltaY = dy / geometry.plotHeight * (old.yMax - old.yMin);
  graphView = { xMin: old.xMin + deltaX, xMax: old.xMax + deltaX, yMin: old.yMin + deltaY, yMax: old.yMax + deltaY, autoY: false };
  graphSyncRangeInputs(graphView);
  drawGraph();
});
function graphEndDrag() {
  if (!graphDrag) return;
  graphDrag = null;
  graphCanvas.classList.remove("is-dragging");
}
graphCanvas.addEventListener("pointerup", (event) => {
  if (graphDrag && !graphDrag.moved) {
    const point = graphPointerPosition(event);
    const coords = graphCoordinates(renderedGraphView, point.geometry);
    if (point.x >= point.geometry.padding.left && point.x <= coords.plotRight && point.y >= point.geometry.padding.top && point.y <= coords.plotBottom) {
      graphCursor = { x: coords.pixelToX(point.x), y: coords.pixelToY(point.y) };
      graphUpdateProbe(graphCursor.x, graphCursor.y);
      drawGraph();
    }
  }
  graphEndDrag();
});
graphCanvas.addEventListener("pointercancel", graphEndDrag);
graphCanvas.addEventListener("pointerleave", (event) => { if (!graphDrag && event.pointerType === "mouse") graphCursor = null; });
graphCanvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  if (!renderedGraphView) drawGraph();
  if (!renderedGraphView) return;
  const point = graphPointerPosition(event);
  const coords = graphCoordinates(renderedGraphView, point.geometry);
  const factor = event.deltaY < 0 ? 0.82 : 1.22;
  graphZoom(factor, coords.pixelToX(point.x), coords.pixelToY(point.y));
}, { passive: false });
window.addEventListener("resize", () => {
  if ($("#graphTab").classList.contains("active")) drawGraph();
});

/* =========================
   14. 起動時の初期化
   ========================= */
renderHistory();
$("#mainResult").textContent = "0";
// 起動時は入力欄へ自動フォーカスしない。ブラウザーのスクロール復元を優先する。


/* =========================
   15. Aurora 総合版：追加計算エンジン
   ========================= */
function addToolHistory(kind, expression, result) {
  addHistory(expression, result, kind);
}

// 2元連立一次方程式。各辺は安全な既存式パーサーで係数を評価する。
function linearizeSide(source) {
  const c=evaluateExpression(source,{angleMode,ans:answerValue,x:0,y:0});
  const ax=evaluateExpression(source,{angleMode,ans:answerValue,x:1,y:0})-c;
  const by=evaluateExpression(source,{angleMode,ans:answerValue,x:0,y:1})-c;
  const check=evaluateExpression(source,{angleMode,ans:answerValue,x:2,y:3});
  if(Math.abs(check-(c+2*ax+3*by))>1e-9*Math.max(1,Math.abs(check))) throw new Error("連立ソルバーは一次式（xとyの一次の組み合わせ）のみ対応します。");
  return {c,ax,by};
}
function solveTwoVariableSystem(lines) {
  if(lines.length!==2) throw new Error("方程式は2行入力してください。");
  const rows=lines.map(line=>{
    const parts=line.split("="); if(parts.length!==2) throw new Error("各方程式を「左辺=右辺」で入力してください。");
    const L=linearizeSide(parts[0]),R=linearizeSide(parts[1]);
    return [L.ax-R.ax,L.by-R.by,R.c-L.c];
  });
  const [[a,b,e],[c,d,f]]=rows; const det=a*d-b*c;
  if(Math.abs(det)<1e-12) throw new Error("一意の解がありません。平行・一致または従属する式の可能性があります。");
  return {x:(e*d-b*f)/det,y:(a*f-e*c)/det};
}
const solveSystemButton=document.querySelector("#solveSystem");
if(solveSystemButton) solveSystemButton.addEventListener("click",()=>{
  try{const lines=$("#systemEquations").value.split(/\n+/).map(s=>s.trim()).filter(Boolean);const r=solveTwoVariableSystem(lines);const out=`x = ${formatNumber(r.x)}\ny = ${formatNumber(r.y)}`;$("#systemResults").textContent=out;addToolHistory("連立方程式",lines.join(" ; "),out);}
  catch(e){$("#systemResults").textContent=e.message;}
});

// Central-difference derivative and Simpson integration; both are numerical approximations.
const calculusButton=document.querySelector("#calculateCalculus");
if(calculusButton) calculusButton.addEventListener("click",()=>{
  try{
    const expr=$("#calculusExpression").value.trim(); if(!expr) throw new Error("関数式を入力してください。");
    const x0=parseRequiredNumber("#calculusPoint","微分する位置"), lo=parseRequiredNumber("#calculusLower","積分下限"), hi=parseRequiredNumber("#calculusUpper","積分上限");
    const f=x=>evaluateExpression(expr,{angleMode,ans:answerValue,x});
    const h=1e-5*Math.max(1,Math.abs(x0)); const der=(f(x0+h)-f(x0-h))/(2*h);
    const n=400; const step=(hi-lo)/n; let sum=f(lo)+f(hi);
    for(let i=1;i<n;i++) sum+=(i%2?4:2)*f(lo+i*step);
    const integral=sum*step/3;
    const out=`f(${formatNumber(x0)}) = ${formatNumber(f(x0))}\nf′(${formatNumber(x0)}) ≈ ${formatNumber(der)}\n接線：y = ${formatNumber(f(x0))} + ${formatNumber(der)}(x - ${formatNumber(x0)})\n∫[${formatNumber(lo)}, ${formatNumber(hi)}] f(x) dx ≈ ${formatNumber(integral)}`;
    $("#calculusResults").textContent=out; addToolHistory("数値微積分",`${expr}; x0=${x0}; ${lo}〜${hi}`,out);
  }catch(e){$("#calculusResults").textContent=e.message;}
});

// Programmer bit operations, normalized to a selected unsigned bit width.
function parseBigIntBase(textValue,base){
  let s=String(textValue).trim().replaceAll("_",""); if(!s) throw new Error("整数を入力してください。");
  let sign=1n;if(s[0]==="-"){sign=-1n;s=s.slice(1);}else if(s[0]==="+")s=s.slice(1);
  const alphabet="0123456789abcdef";let value=0n;
  for(const ch of s.toLowerCase()){const digit=alphabet.indexOf(ch);if(digit<0||digit>=base)throw new Error(`${base}進数として正しくありません。`);value=value*BigInt(base)+BigInt(digit);}
  return sign*value;
}
function unsignedAtWidth(value,bits){const mod=1n<<BigInt(bits);return ((value%mod)+mod)%mod;}
const bitsButton=document.querySelector("#calculateBits");
if(bitsButton) bitsButton.addEventListener("click",()=>{
  try{
    const bits=Number($("#programmerBits").value),a=parseBigIntBase($("#programmerA").value,Number($("#programmerBaseA").value)),b=parseBigIntBase($("#programmerB").value,Number($("#programmerBaseB").value));
    const mask=(1n<<BigInt(bits))-1n,ua=unsignedAtWidth(a,bits),ub=unsignedAtWidth(b,bits),op=$("#programmerOperation").value;
    let result;if(op==="and")result=ua&ub;else if(op==="or")result=ua|ub;else if(op==="xor")result=ua^ub;else if(op==="notA")result=(~ua)&mask;else {if(b<0n||b>BigInt(bits-1))throw new Error("シフト量は0〜ビット幅-1にしてください。");result=op==="left"?(ua<<b)&mask:ua>>b;}
    const signed=result>=(1n<<BigInt(bits-1))?result-(1n<<BigInt(bits)):result;
    const out=`符号なし10進数：${result}\n符号付き10進数：${signed}\n2進数：${result.toString(2).padStart(bits,"0")}\n16進数：0x${result.toString(16).toUpperCase().padStart(Math.ceil(bits/4),"0")}\nビット幅：${bits} bit`;
    $("#programmerResults").textContent=out;addToolHistory("ビット演算",`${a} ${op} ${b} (${bits}bit)`,out);
  }catch(e){$("#programmerResults").textContent=e.message;}
});
const convertProgButton=document.querySelector("#convertProgrammerNumber");
if(convertProgButton) convertProgButton.addEventListener("click",()=>{
  try{const base=Number($("#programmerNumberBase").value),n=parseBigIntBase($("#programmerNumber").value,base);const out=`10進数：${n}\n2進数：${n.toString(2)}\n8進数：${n.toString(8)}\n16進数：${n.toString(16).toUpperCase()}`;$("#programmerConvertResults").textContent=out;addToolHistory("進数変換",`${n} (base ${base})`,out);}
  catch(e){$("#programmerConvertResults").textContent=e.message;}
});
const charButton=document.querySelector("#convertCharacter");
if(charButton) charButton.addEventListener("click",()=>{const s=$("#characterInput").value;if(!s){$("#characterResults").textContent="文字を入力してください。";return;}const out=[...s].map(ch=>`${ch}：U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4,"0")} (${ch.codePointAt(0)})`).join("\n");$("#characterResults").textContent=out;addToolHistory("文字コード",s,out);});

// Geometry calculations
const shapeLabels={circle:["半径","",""],triangle:["辺 a","辺 b","辺 c"],rectangle:["縦","横",""],square:["一辺","",""],sphere:["半径","",""],cube:["一辺","",""],cylinder:["底面の半径","高さ",""],cone:["底面の半径","高さ",""]};
function refreshGeometryFields(){const vals=shapeLabels[$("#geometryShape").value];["A","B","C"].forEach((k,i)=>{const wrap=$("#geometry"+k).parentElement;wrap.hidden=!vals[i];$("#geometryLabel"+k).textContent=vals[i]||"";});}
const geometrySelect=document.querySelector("#geometryShape");if(geometrySelect)geometrySelect.addEventListener("change",refreshGeometryFields);if(geometrySelect)refreshGeometryFields();
const geometryButton=document.querySelector("#calculateGeometry");
if(geometryButton)geometryButton.addEventListener("click",()=>{
  try{
    const shape=$("#geometryShape").value,a=parseRequiredNumber("#geometryA","値A"),b=$("#geometryB").parentElement.hidden?0:parseRequiredNumber("#geometryB","値B"),c=$("#geometryC").parentElement.hidden?0:parseRequiredNumber("#geometryC","値C");
    if(a<=0||(!$("#geometryB").parentElement.hidden&&b<=0)||(!$("#geometryC").parentElement.hidden&&c<=0))throw new Error("長さは0より大きい値にしてください。");
    let out="";const f=formatNumber;
    if(shape==="circle")out=`面積：${f(Math.PI*a*a)}\n円周：${f(2*Math.PI*a)}\n直径：${f(2*a)}`;
    if(shape==="triangle"){if(a+b<=c||a+c<=b||b+c<=a)throw new Error("3辺が三角形を作れる長さではありません。");const s=(a+b+c)/2;out=`周囲：${f(a+b+c)}\n面積（ヘロン）：${f(Math.sqrt(s*(s-a)*(s-b)*(s-c)))}`;}
    if(shape==="rectangle")out=`面積：${f(a*b)}\n周囲：${f(2*(a+b))}\n対角線：${f(Math.hypot(a,b))}`;
    if(shape==="square")out=`面積：${f(a*a)}\n周囲：${f(4*a)}\n対角線：${f(a*Math.SQRT2)}`;
    if(shape==="sphere")out=`表面積：${f(4*Math.PI*a*a)}\n体積：${f(4*Math.PI*a*a*a/3)}`;
    if(shape==="cube")out=`表面積：${f(6*a*a)}\n体積：${f(a*a*a)}\n対角線：${f(a*Math.sqrt(3))}`;
    if(shape==="cylinder")out=`側面積：${f(2*Math.PI*a*b)}\n表面積：${f(2*Math.PI*a*(a+b))}\n体積：${f(Math.PI*a*a*b)}`;
    if(shape==="cone"){const slant=Math.hypot(a,b);out=`母線：${f(slant)}\n側面積：${f(Math.PI*a*slant)}\n表面積：${f(Math.PI*a*(a+slant))}\n体積：${f(Math.PI*a*a*b/3)}`;}
    $("#geometryResults").textContent=out;addToolHistory("図形計算",`${shape}: ${a}, ${b}, ${c}`,out);
  }catch(e){$("#geometryResults").textContent=e.message;}
});

// Correlation and linear regression for paired X/Y samples.
function parseNumericList(selector,label){const parts=$(selector).value.trim().split(/[\s,;]+/).filter(Boolean);if(!parts.length)throw new Error(`${label}を入力してください。`);const nums=parts.map(Number);if(nums.some(n=>!Number.isFinite(n)))throw new Error(`${label}に数字以外が含まれています。`);return nums;}
const corrButton=document.querySelector("#calculateCorrelation");
if(corrButton)corrButton.addEventListener("click",()=>{
  try{
    const x=parseNumericList("#pairedXInput","Xデータ"),y=parseNumericList("#pairedYInput","Yデータ");if(x.length!==y.length||x.length<2)throw new Error("XとYは同じ個数で、2組以上入力してください。");
    const n=x.length,mx=x.reduce((a,b)=>a+b,0)/n,my=y.reduce((a,b)=>a+b,0)/n;
    let sxx=0,syy=0,sxy=0;for(let i=0;i<n;i++){sxx+=(x[i]-mx)**2;syy+=(y[i]-my)**2;sxy+=(x[i]-mx)*(y[i]-my);}
    if(sxx===0||syy===0)throw new Error("すべて同じ値のデータがあるため相関係数を計算できません。");
    const r=sxy/Math.sqrt(sxx*syy),slope=sxy/sxx,intercept=my-slope*mx;
    const out=`データ数：${n}\n相関係数 r = ${formatNumber(r)}\n回帰直線：y = ${formatNumber(slope)}x ${intercept<0?"-":"+"} ${formatNumber(Math.abs(intercept))}\n決定係数 R² = ${formatNumber(r*r)}`;
    $("#correlationResults").textContent=out;drawScatterPlot(x,y);addToolHistory("相関・回帰",`X=${x.join(",")}; Y=${y.join(",")}`,out);
  }catch(e){$("#correlationResults").textContent=e.message;}
});
function drawScatterPlot(x,y){const c=$("#statsCanvas");if(!c)return;const ctx=c.getContext("2d"),w=c.width,h=c.height,p=38;ctx.clearRect(0,0,w,h);const minX=Math.min(...x),maxX=Math.max(...x),minY=Math.min(...y),maxY=Math.max(...y),dx=maxX-minX||1,dy=maxY-minY||1;ctx.strokeStyle="#9aa8bb";ctx.beginPath();ctx.moveTo(p,p);ctx.lineTo(p,h-p);ctx.lineTo(w-p,h-p);ctx.stroke();ctx.fillStyle="#326fd0";x.forEach((v,i)=>{ctx.beginPath();ctx.arc(p+(v-minX)/dx*(w-2*p),h-p-(y[i]-minY)/dy*(h-2*p),5,0,Math.PI*2);ctx.fill();});}
function drawStatisticsHistogram(values){const c=document.querySelector("#statsCanvas");if(!c)return;const ctx=c.getContext("2d"),w=c.width,h=c.height,p=38;ctx.clearRect(0,0,w,h);const min=Math.min(...values),max=Math.max(...values),range=max-min||1,bins=Math.min(12,Math.max(4,Math.ceil(Math.sqrt(values.length)))),counts=Array(bins).fill(0);values.forEach(v=>counts[Math.min(bins-1,Math.floor((v-min)/range*bins))]++);const peak=Math.max(...counts,1),bw=(w-2*p)/bins;ctx.strokeStyle="#9aa8bb";ctx.beginPath();ctx.moveTo(p,p);ctx.lineTo(p,h-p);ctx.lineTo(w-p,h-p);ctx.stroke();counts.forEach((n,i)=>{const bh=(h-2*p)*n/peak;ctx.fillStyle="#5888d8";ctx.fillRect(p+i*bw+3,h-p-bh,bw-6,bh);ctx.fillStyle=getComputedStyle(document.body).getPropertyValue("--text").trim()||"#333";ctx.font="12px sans-serif";ctx.textAlign="center";ctx.fillText(String(n),p+i*bw+bw/2,h-p-bh-8);});}

/* =========================
   16. 3Dサーフェス（Canvasによる軽量描画）
   ========================= */
let surfaceRotation={yaw:-0.65,pitch:0.85};let surfaceDrag=null;
function drawSurface(){
  const canvas=$("#surfaceCanvas");if(!canvas)return;const ctx=canvas.getContext("2d"),w=canvas.width,h=canvas.height;
  ctx.clearRect(0,0,w,h);let expression=$("#surfaceExpression").value.trim();expression=expression.replace(/^z\s*=\s*/i,"");if(!expression){$("#surfaceMessage").textContent="式を入力してください。";return;}
  const range=Math.max(2,Math.min(12,Number($("#surfaceRange").value)||5)),n=Number($("#surfaceQuality").value)||20;
  const points=[];let zmin=Infinity,zmax=-Infinity;
  try{for(let i=0;i<=n;i++){const row=[];for(let j=0;j<=n;j++){const x=-range+2*range*i/n,y=-range+2*range*j/n;let z=evaluateExpression(expression,{angleMode,ans:answerValue,x,y});z=Math.max(-1e4,Math.min(1e4,z));zmin=Math.min(zmin,z);zmax=Math.max(zmax,z);row.push({x,y,z});}points.push(row);}}
  catch(e){$("#surfaceMessage").textContent=`式を評価できません：${e.message}`;return;}
  const mid=(zmin+zmax)/2,scaleZ=Math.max(1,zmax-zmin),cy=Math.cos(surfaceRotation.yaw),sy=Math.sin(surfaceRotation.yaw),cp=Math.cos(surfaceRotation.pitch),sp=Math.sin(surfaceRotation.pitch),scale=Math.min(w,h)*0.31/range;
  const project=p=>{const X=p.x*cy-p.y*sy,Y=p.x*sy+p.y*cy,Z=(p.z-mid)/scaleZ*range*0.9;const yy=Y*cp-Z*sp,zz=Y*sp+Z*cp;return{x:w/2+X*scale,y:h/2+yy*scale,z:zz};};
  const quads=[];for(let i=0;i<n;i++)for(let j=0;j<n;j++){const ps=[project(points[i][j]),project(points[i+1][j]),project(points[i+1][j+1]),project(points[i][j+1])];quads.push({ps,depth:ps.reduce((s,p)=>s+p.z,0)/4,mean:ps.reduce((s,p)=>s+p.z,0)/4});}
  quads.sort((a,b)=>a.depth-b.depth);const dark=document.body.classList.contains("dark");
  ctx.strokeStyle=dark?"rgba(220,232,250,.28)":"rgba(40,65,100,.28)";ctx.lineWidth=1;
  for(const q of quads){const t=Math.max(0,Math.min(1,(q.mean+range)/(2*range)));const hue=215-110*t;ctx.fillStyle=`hsla(${hue},65%,${dark?52:62}%,0.88)`;ctx.beginPath();ctx.moveTo(q.ps[0].x,q.ps[0].y);q.ps.slice(1).forEach(p=>ctx.lineTo(p.x,p.y));ctx.closePath();ctx.fill();ctx.stroke();}
  ctx.fillStyle=dark?"#dbe7fa":"#41536d";ctx.font="15px sans-serif";ctx.fillText(`z range: ${formatNumber(zmin)} ～ ${formatNumber(zmax)}`,18,28);
  $("#surfaceMessage").textContent=`z = ${expression} ／ ${n}×${n}メッシュ ／ ドラッグで回転。グラフは軽量な透視投影表示です。`;
}
const surfaceDrawButton=document.querySelector("#drawSurface");if(surfaceDrawButton)surfaceDrawButton.addEventListener("click",drawSurface);
const surfaceResetButton=document.querySelector("#surfaceReset");if(surfaceResetButton)surfaceResetButton.addEventListener("click",()=>{surfaceRotation={yaw:-0.65,pitch:0.85};drawSurface();});
const surfaceSaveButton=document.querySelector("#surfaceSave");if(surfaceSaveButton)surfaceSaveButton.addEventListener("click",()=>{const a=document.createElement("a");a.download="aurora-3d-graph.png";a.href=$("#surfaceCanvas").toDataURL("image/png");a.click();});
const surfaceCanvas=document.querySelector("#surfaceCanvas");if(surfaceCanvas){surfaceCanvas.addEventListener("pointerdown",e=>{surfaceDrag={x:e.clientX,y:e.clientY,yaw:surfaceRotation.yaw,pitch:surfaceRotation.pitch};surfaceCanvas.setPointerCapture(e.pointerId);surfaceCanvas.classList.add("dragging");});surfaceCanvas.addEventListener("pointermove",e=>{if(!surfaceDrag)return;surfaceRotation.yaw=surfaceDrag.yaw+(e.clientX-surfaceDrag.x)*0.008;surfaceRotation.pitch=Math.max(0.15,Math.min(1.45,surfaceDrag.pitch+(e.clientY-surfaceDrag.y)*0.008));drawSurface();});const finish=()=>{surfaceDrag=null;surfaceCanvas.classList.remove("dragging");};surfaceCanvas.addEventListener("pointerup",finish);surfaceCanvas.addEventListener("pointercancel",finish);}

// Re-render the 3D surface in matching theme and when returning to the tab.
const originalSetTheme=setTheme;
setTheme=function(theme){originalSetTheme(theme);if($("#surfaceCanvas"))drawSurface();};
const originalRenderHistory=renderHistory;
renderHistory=function(){originalRenderHistory();};

// Ensure calculations generated in the enhanced tools are also represented in history.
if($("#geometryTab")) drawSurface();


/* =========================
   17. Aurora 追加機能：素数・和算・極限・設定・暗号化
   ========================= */

// 素数表：最大10,000までのエラトステネスのふるい
const primeButton = document.querySelector("#generatePrimes");
if (primeButton) primeButton.addEventListener("click", () => {
  try {
    const limit = parseRequiredNumber("#primeLimit", "上限");
    if (!Number.isInteger(limit) || limit < 2 || limit > 10000) throw new Error("上限は2〜10,000の整数にしてください。");
    const prime = new Uint8Array(limit + 1); prime.fill(1); prime[0] = 0; prime[1] = 0;
    for (let p = 2; p * p <= limit; p++) if (prime[p]) for (let k = p * p; k <= limit; k += p) prime[k] = 0;
    const values = [];
    for (let n = 2; n <= limit; n++) if (prime[n]) values.push(n);
    $("#primeResults").textContent = `${limit}以下の素数：${values.length}個\n\n${values.join(", ")}`;
    addToolHistory("素数表", `2〜${limit}`, `${values.length}個`);
  } catch (error) { $("#primeResults").textContent = error.message; }
});

// 鶴亀算
const wasanButton = document.querySelector("#solveWasan");
if (wasanButton) wasanButton.addEventListener("click", () => {
  try {
    const heads = parseRequiredNumber("#wasanHeads", "頭数");
    const legs = parseRequiredNumber("#wasanLegs", "足の合計");
    if (!Number.isInteger(heads) || !Number.isInteger(legs) || heads < 0 || legs < 0) throw new Error("頭数と足の数は0以上の整数にしてください。");
    const turtle = (legs - 2 * heads) / 2, chicken = heads - turtle;
    if (!Number.isInteger(turtle) || !Number.isInteger(chicken) || turtle < 0 || chicken < 0) throw new Error("その頭数と足の合計では、鶴と亀の組み合わせを作れません。");
    const out = `鶴：${chicken}羽\n亀：${turtle}匹\n確認：${chicken + turtle}頭、${2 * chicken + 4 * turtle}本`;
    $("#wasanResults").textContent = out; addToolHistory("鶴亀算", `頭数=${heads}, 足=${legs}`, out);
  } catch (error) { $("#wasanResults").textContent = error.message; }
});

// 円周率を内接・外接正多角形から近似
const piButton = document.querySelector("#approximatePi");
if (piButton) piButton.addEventListener("click", () => {
  try {
    const n = parseRequiredNumber("#polygonSides", "辺の数");
    if (!Number.isInteger(n) || n < 6 || n > 4096) throw new Error("辺の数は6〜4096の整数にしてください。");
    const lower = n * Math.sin(Math.PI / n) / 2;
    const upper = n * Math.tan(Math.PI / n) / 2;
    const out = `内接多角形による下側 ≈ ${formatNumber(lower)}\n外接多角形による上側 ≈ ${formatNumber(upper)}\n実際の π = ${formatNumber(Math.PI)}\n幅 ≈ ${formatNumber(upper - lower)}\n※半径1の円に対する周長を2で割った値です。`;
    $("#piApproxResults").textContent = out; addToolHistory("円周率近似", `正${n}角形`, out);
  } catch (error) { $("#piApproxResults").textContent = error.message; }
});

// 極限は左右の近傍値を表示する数値実験。証明は行わない。
const limitButton = document.querySelector("#calculateLimit");
if (limitButton) limitButton.addEventListener("click", () => {
  try {
    const expr = $("#limitExpression").value.trim();
    if (!expr) throw new Error("関数式を入力してください。");
    const a = parseRequiredNumber("#limitPoint", "近づく値");
    const offsets = [1e-1, 1e-2, 1e-3, 1e-4, 1e-5, 1e-6];
    const rows = offsets.map((h) => {
      let left = "未定義", right = "未定義";
      try { left = formatNumber(evaluateExpression(expr, { angleMode, ans: answerValue, x: a - h })); } catch (_) {}
      try { right = formatNumber(evaluateExpression(expr, { angleMode, ans: answerValue, x: a + h })); } catch (_) {}
      return { h, left, right };
    });
    const last = rows[rows.length - 1];
    const same = last.left !== "未定義" && last.right !== "未定義" &&
      Math.abs(Number(last.left) - Number(last.right)) <= 1e-4 * Math.max(1, Math.abs(Number(last.left)), Math.abs(Number(last.right)));
    const out = `lim[x→${formatNumber(a)}] ${expr}\n\n距離 h | 左側 f(a−h) | 右側 f(a+h)\n${rows.map(r => `${r.h} | ${r.left} | ${r.right}`).join("\n")}\n\n${same ? "左右の値は近づいているように見えます（数値的な推定）。" : "左右の値が一致するとは確認できませんでした。"}\n※数値近似であり、極限の存在を証明するものではありません。`;
    $("#limitResults").textContent = out; addToolHistory("極限の数値確認", `${expr}; x→${a}`, out);
  } catch (error) { $("#limitResults").textContent = error.message; }
});

// 数列 a_n：式中の x に n を代入して挙動を確認
const sequenceButton = document.querySelector("#checkSequence");
if (sequenceButton) sequenceButton.addEventListener("click", () => {
  try {
    const expr = $("#sequenceExpression").value.trim();
    if (!expr) throw new Error("数列の式を入力してください。");
    const ns = [1, 2, 5, 10, 100, 1000, 10000, 100000];
    const values = ns.map(n => evaluateExpression(expr, { angleMode, ans: answerValue, x: n }));
    const diffs = values.slice(1).map((v, i) => Math.abs(v - values[i]));
    const tail = diffs.slice(-3);
    const stable = tail.every(Number.isFinite) && tail[2] < 1e-4 && tail[2] <= tail[0] * 1.1;
    const out = `aₙ = ${expr}\nn | aₙ\n${ns.map((n, i) => `${n} | ${formatNumber(values[i])}`).join("\n")}\n\n${stable ? "最後の項は数値上、安定しているように見えます。" : "この範囲では収束を判断できません。"}\n※項の一部を調べる簡易チェックです。数学的な収束証明ではありません。`;
    $("#sequenceResults").textContent = out; addToolHistory("数列の収束チェック", expr, out);
  } catch (error) { $("#sequenceResults").textContent = error.message; }
});

// 地形プロフィールは測量データではなく、形状を示す模式モデル
function setGraphPreset(expression, min, max, label) {
  $("#graphExpression").value = expression;
  $("#graphExpression2").value = "";
  $("#graphExpression3").value = "";
  $("#graphExpression4").value = "";
  $("#graphMin").value = String(min);
  $("#graphMax").value = String(max);
  graphView = null; graphIntersections = []; graphTangent = null; graphIntegral = null;
  $("#plotGraph").click();
  graphSetMessage(`${label}を模式モデルで表示しています。実測標高データではありません。`);
}
document.querySelector("#loadFujiProfile")?.addEventListener("click", () =>
  setGraphPreset("3776*(1-(abs(x)/20)^2)^0.7", -20, 20, "富士山の断面"));
document.querySelector("#loadTamaProfile")?.addEventListener("click", () =>
  setGraphPreset("1950*(1-x/138)^1.35", 0, 138, "多摩川の縦断"));

// 見た目の設定を保存。壁紙画像ではなく軽量な配色プリセットを採用。
const UI_SETTINGS_KEY = "aurora-calculator-ui-settings-v1";
const defaultUiSettings = { skin: "aurora", scale: 1, pageColor: "#eef3fb" };
function applyUiSettings(settings = {}) {
  const skin = ["aurora", "sakura", "mint", "sunset", "mono"].includes(settings.skin) ? settings.skin : "aurora";
  const scale = Math.max(0.9, Math.min(1.2, Number(settings.scale) || 1));
  const color = /^#[0-9a-f]{6}$/i.test(settings.pageColor || "") ? settings.pageColor : defaultUiSettings.pageColor;
  document.body.dataset.skin = skin;
  document.body.style.setProperty("--ui-scale", String(scale));
  document.body.style.setProperty("--ui-page", document.body.classList.contains("dark") ? "#111827" : color);
  if ($("#calculatorSkin")) $("#calculatorSkin").value = skin;
  if ($("#uiScale")) $("#uiScale").value = String(scale);
  if ($("#uiScaleValue")) $("#uiScaleValue").textContent = `${Math.round(scale * 100)}%`;
  if ($("#customPageColor")) $("#customPageColor").value = color;
}
let uiSettings = { ...defaultUiSettings, ...readSaved(UI_SETTINGS_KEY, {}) };
applyUiSettings(uiSettings);
function saveUiSettings() {
  uiSettings = {
    skin: $("#calculatorSkin").value,
    scale: Number($("#uiScale").value),
    pageColor: $("#customPageColor").value
  };
  applyUiSettings(uiSettings); saveValue(UI_SETTINGS_KEY, uiSettings);
}
["#calculatorSkin", "#uiScale", "#customPageColor"].forEach(selector => {
  const el = document.querySelector(selector);
  if (el) el.addEventListener("input", saveUiSettings);
});
document.querySelector("#resetAppearance")?.addEventListener("click", () => {
  uiSettings = { ...defaultUiSettings }; applyUiSettings(uiSettings); saveValue(UI_SETTINGS_KEY, uiSettings);
});

// パスワード由来鍵でAES-GCM暗号化。暗号化形式はJSONコンテナ。
function bytesToBase64(bytes) {
  let binary = ""; bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}
function base64ToBytes(value) {
  return Uint8Array.from(atob(value), ch => ch.charCodeAt(0));
}
async function deriveBackupKey(password, salt) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 210000, hash: "SHA-256" }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
function makeBackupObject() {
  return {
    format: "aurora-calculator-backup", version: 5, exportedAt: new Date().toISOString(),
    history, memoryValue, answerValue, angleMode,
    theme: document.body.classList.contains("dark") ? "dark" : "light",
    uiSettings,
    ...getAuroraDatabaseBackup()
  };
}
function restoreBackupObject(data) {
  if (!data || data.format !== "aurora-calculator-backup" || !Array.isArray(data.history)) throw new Error("このアプリのバックアップファイルではありません。");
  if (!confirm("現在の履歴とメモリーをバックアップの内容で置き換えますか？")) return false;
  history = normalizeHistoryEntries(data.history);
  memoryValue = Number.isFinite(Number(data.memoryValue)) ? Number(data.memoryValue) : 0;
  answerValue = Number.isFinite(Number(data.answerValue)) ? Number(data.answerValue) : 0;
  angleMode = data.angleMode === "RAD" ? "RAD" : "DEG";
  saveValue(STORAGE_KEYS.history, history); saveValue(STORAGE_KEYS.memory, memoryValue);
  saveValue(STORAGE_KEYS.answer, answerValue); saveValue(STORAGE_KEYS.angle, angleMode);
  $("#angleMode").value = angleMode; updateMemoryStatus(); renderHistory();
  if (data.theme === "dark" || data.theme === "light") setTheme(data.theme);
  if (data.uiSettings) { uiSettings = { ...defaultUiSettings, ...data.uiSettings }; applyUiSettings(uiSettings); saveValue(UI_SETTINGS_KEY, uiSettings); }
  applyAuroraDatabaseBackup(data.auroraDatabase);
  return true;
}
document.querySelector("#exportEncryptedBackup")?.addEventListener("click", async () => {
  try {
    const password = $("#backupPassword").value;
    if (password.length < 8) throw new Error("パスワードは8文字以上にしてください。");
    if (!crypto?.subtle) throw new Error("このブラウザーでは暗号化APIを利用できません。HTTPSまたは対応ブラウザーで開いてください。");
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveBackupKey(password, salt);
    const plaintext = new TextEncoder().encode(JSON.stringify(makeBackupObject()));
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
    const container = { format: "aurora-encrypted-backup", version: 1, kdf: "PBKDF2-SHA-256", iterations: 210000, cipher: "AES-256-GCM", salt: bytesToBase64(salt), iv: bytesToBase64(iv), data: bytesToBase64(encrypted) };
    downloadText(`aurora-encrypted-${timestampForFile()}.auroraenc`, JSON.stringify(container), "application/octet-stream");
    $("#securityMessage").textContent = "暗号化バックアップを保存しました。パスワードは別の安全な場所に保管してください。";
  } catch (error) { $("#securityMessage").textContent = error.message || "暗号化に失敗しました。"; }
});
document.querySelector("#importEncryptedBackup")?.addEventListener("click", async () => {
  try {
    const file = $("#importEncryptedFile").files?.[0], password = $("#backupPassword").value;
    if (!file) throw new Error("暗号化バックアップファイルを選択してください。");
    if (file.size > 5 * 1024 * 1024) throw new Error("バックアップは5MB以下のファイルを選択してください。");
    if (password.length < 8) throw new Error("保存時のパスワードを入力してください。");
    const container = JSON.parse(await file.text());
    if (container.format !== "aurora-encrypted-backup" || container.version !== 1) throw new Error("対応していない暗号化バックアップです。");
    const key = await deriveBackupKey(password, base64ToBytes(container.salt));
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(container.iv) }, key, base64ToBytes(container.data));
    const data = JSON.parse(new TextDecoder().decode(plaintext));
    if (restoreBackupObject(data)) $("#securityMessage").textContent = "暗号化バックアップを復元しました。";
  } catch (error) {
    $("#securityMessage").textContent = error.name === "OperationError" ? "復号できません。パスワードかファイルを確認してください。" : (error.message || "復元に失敗しました。");
  }
});

// タブ移動時にアニメーションが裏で回り続けないようにする
document.addEventListener("visibilitychange", () => {
  if (document.hidden && graphAnimationTimer !== null) graphToggleAnimation();
});

const recurrenceButton = document.querySelector("#runRecurrence");
if (recurrenceButton) recurrenceButton.addEventListener("click", () => {
  try {
    const expr = $("#recurrenceExpression").value.trim();
    if (!expr) throw new Error("漸化式の右辺を入力してください。");
    let value = parseRequiredNumber("#recurrenceInitial", "初項");
    const count = parseRequiredNumber("#recurrenceCount", "反復回数");
    if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error("反復回数は1〜100の整数にしてください。");
    const values = [value];
    for (let n = 1; n <= count; n++) {
      value = evaluateExpression(expr, { angleMode, ans: answerValue, x: value });
      if (!Number.isFinite(value) || Math.abs(value) > 1e100) throw new Error(`${n}回目で値が大きくなりすぎました。`);
      values.push(value);
    }
    const out = `a₀ = ${formatNumber(values[0])}\naₙ₊₁ = ${expr}\n\n${values.map((v, i) => `a${i} = ${formatNumber(v)}`).join("\n")}\n\n※指定回数までの反復結果です。収束の証明や、すべての初期値での挙動を保証するものではありません。`;
    $("#recurrenceResults").textContent = out; addToolHistory("漸化式の反復", `a0=${values[0]}, f(x)=${expr}`, out);
  } catch (error) { $("#recurrenceResults").textContent = error.message; }
});


/* ============================================================
   20. πの厳密表記・科学計算・数学データベース・自作関数
   ============================================================ */

// πの多項式として、πを含む基本的な代数式を厳密表記にする。
// 対応：加減乗除（除数はπを含まない定数）、整数べき乗、%、階乗。
class PiExactParser {
  constructor(source, options={}) {
    this.tokens = new ExpressionParser(source, { ...options, complexMode:false }).tokens;
    this.pos = 0; this.angleMode = options.angleMode || "DEG"; this.ans = Number(options.ans || 0);
  }
  peek(v=null){const t=this.tokens[this.pos];return v===null?t:t?.value===v;}
  take(v=null){const t=this.peek();if(!t||(v!==null&&t.value!==v))return null;this.pos++;return t;}
  expect(v){if(!this.take(v))throw new Error(`「${v}」が必要です。`);}
  add(a,b,sign=1){if(a===null||b===null)return null;const o={...a};for(const [k,v] of Object.entries(b))o[k]=(o[k]||0)+sign*v;return cleanPi(o);}
  mul(a,b){if(a===null||b===null)return null;const o={};for(const [ka,va] of Object.entries(a))for(const [kb,vb] of Object.entries(b)){const k=Number(ka)+Number(kb);o[k]=(o[k]||0)+va*vb;}return cleanPi(o);}
  div(a,b){if(a===null||b===null)return null;const ks=Object.keys(b).filter(k=>Math.abs(b[k])>1e-13);if(ks.length!==1||Number(ks[0])!==0||b[ks[0]]===0)return null;return Object.fromEntries(Object.entries(a).map(([k,v])=>[k,v/b[ks[0]]]));}
  pow(a,b){if(a===null||b===null)return null;const ks=Object.keys(b).filter(k=>Math.abs(b[k])>1e-13);if(ks.length!==1||Number(ks[0])!==0)return null;const n=b[0]??b["0"];if(!Number.isInteger(n)||n<0||n>8)return null;let r={0:1};for(let i=0;i<n;i++)r=this.mul(r,a);return r;}
  expression(){let v=this.term();while(this.peek("+")||this.peek("-")){const op=this.take().value;v=this.add(v,this.term(),op==="+"?1:-1);}return v;}
  term(){let v=this.unary();while(this.peek("*")||this.peek("/")){const op=this.take().value;const b=this.unary();v=op==="*"?this.mul(v,b):this.div(v,b);}return v;}
  unary(){if(this.take("+"))return this.unary();if(this.take("-")){const v=this.unary();return v===null?null:Object.fromEntries(Object.entries(v).map(([k,n])=>[k,-n]));}return this.power();}
  power(){let v=this.postfix();if(this.take("^"))v=this.pow(v,this.unary());return v;}
  postfix(){let v=this.primary();while(this.peek("!")||this.peek("%")){const op=this.take().value;if(v===null)return null;const n=piPolyNumber(v);if(n===null)return null;if(op==="!"){if(!Number.isInteger(n)||n<0||n>170)return null;let f=1;for(let i=2;i<=n;i++)f*=i;v={0:f};}else v={0:n/100};}return v;}
  primary(){const t=this.peek();if(!t)return null;if(t.type==="number"){this.pos++;return {0:t.value};}if(this.take("(")){const v=this.expression();this.expect(")");return v;}if(t.type==="identifier"){this.pos++;const name=t.value;if(name==="pi")return {1:1};if(name==="e")return {0:Math.E};if(name==="ans")return {0:this.ans};if(name==="i"||name==="x"||name==="y")return null;if(this.take("(")){const a=this.expression();this.expect(")");const n=piPolyNumber(a);if(n===null)return null;const f={sqrt:Math.sqrt,abs:Math.abs,sin:v=>Math.sin(this.angleMode==="DEG"?v*Math.PI/180:v),cos:v=>Math.cos(this.angleMode==="DEG"?v*Math.PI/180:v),tan:v=>Math.tan(this.angleMode==="DEG"?v*Math.PI/180:v),log:Math.log10,ln:Math.log,exp:Math.exp,floor:Math.floor,ceil:Math.ceil,round:Math.round};return Object.hasOwn(f,name)?{0:f[name](n)}:null;}return null;}return null;}
  parse(){const v=this.expression();if(this.pos!==this.tokens.length)return null;return v;}
}
function cleanPi(obj){for(const k of Object.keys(obj))if(Math.abs(obj[k])<1e-12)delete obj[k];return obj;}
function piPolyNumber(obj){if(obj===null)return null;const ks=Object.keys(obj).filter(k=>Math.abs(obj[k])>1e-12);return ks.length===0?0:ks.length===1&&Number(ks[0])===0?obj[0]??obj["0"]:null;}
function formatPiPolynomial(poly){if(!poly||!Object.keys(poly).length)return "0";const terms=Object.entries(poly).map(([k,v])=>[Number(k),v]).filter(([,v])=>Math.abs(v)>1e-11).sort((a,b)=>b[0]-a[0]);let out="";for(const [degree,coef] of terms){const abs=Math.abs(coef),coefText=degree===0?formatNumber(abs):(Math.abs(abs-1)<1e-11?"":formatNumber(abs));const term=degree===0?coefText:`${coefText}π${degree===1?"":`^${degree}`}`;if(!out)out=(coef<0?"-":"")+term;else out+=(coef<0?" - ":" + ")+term;}return out||"0";}
function renderPiAlternatives(expression, numericResult){const panel=$("#piAlternatives");if(!panel)return;try{if(typeof numericResult!=="number"||!/(?:\bpi\b|π)/i.test(expression)){panel.hidden=true;return;}const polynomial=new PiExactParser(expression,{angleMode,ans:answerValue}).parse();if(!polynomial||!Object.keys(polynomial).some(k=>Number(k)>0)){panel.hidden=true;return;}$("#piExactResult").textContent=formatPiPolynomial(polynomial);$("#piDecimalResult").textContent=`${formatNumber(numericResult)}（π = ${Math.PI}）`;const approxExpression=expression.replace(/\bpi\b|π/gi,"(3.14)");const approxValue=evaluateMainExpression(approxExpression,{angleMode,ans:answerValue});$("#piApproxResult").textContent=`${formatNumber(approxValue)}（π = 3.14）`;panel.hidden=false;}catch(e){panel.hidden=true;}}
$("#copyPiExact")?.addEventListener("click",()=>navigator.clipboard?.writeText($("#piExactResult").textContent));
$("#copyPiDecimal")?.addEventListener("click",()=>navigator.clipboard?.writeText($("#piDecimalResult").textContent));
$("#copyPiApprox")?.addEventListener("click",()=>navigator.clipboard?.writeText($("#piApproxResult").textContent));

// Multi-polynomial parser for exact differentiation and integration in x.
class XPolynomialParser {
  constructor(source){this.tokens=new ExpressionParser(source,{angleMode:"RAD"}).tokens;this.i=0;}
  peek(v=null){const t=this.tokens[this.i];return v===null?t:t?.value===v;}
  take(v=null){const t=this.peek();if(!t||(v!==null&&t.value!==v))return null;this.i++;return t;}
  expect(v){if(!this.take(v))throw new Error(`「${v}」が必要です。`);}
  add(a,b,s=1){const o=Array.from({length:Math.max(a.length,b.length)},(_,i)=>(a[i]||0)+s*(b[i]||0));return trimPoly(o);}
  mul(a,b){if(a.length+b.length>40)throw new Error("多項式の次数が高すぎます。");const o=Array(a.length+b.length-1).fill(0);a.forEach((v,i)=>b.forEach((w,j)=>o[i+j]+=v*w));return trimPoly(o);}
  expr(){let v=this.term();while(this.peek("+")||this.peek("-")){const s=this.take().value==="+"?1:-1;v=this.add(v,this.term(),s);}return v;}
  term(){let v=this.unary();while(this.peek("*")||this.peek("/")){const op=this.take().value,b=this.unary();if(op==="*")v=this.mul(v,b);else{if(b.length!==1||Math.abs(b[0])<1e-14)throw new Error("多項式の除数は0以外の定数にしてください。");v=v.map(x=>x/b[0]);}}return v;}
  unary(){if(this.take("+"))return this.unary();if(this.take("-"))return this.unary().map(v=>-v);return this.power();}
  power(){let v=this.postfix();if(this.take("^")){const e=this.unary();if(e.length!==1||!Number.isInteger(e[0])||e[0]<0||e[0]>12)throw new Error("指数は0〜12の整数にしてください。");let r=[1];for(let n=0;n<e[0];n++)r=this.mul(r,v);v=r;}return v;}
  postfix(){let v=this.primary();while(this.peek("%")){this.take("%");v=v.map(x=>x/100);}return v;}
  primary(){const t=this.peek();if(!t)throw new Error("式が途中で終わっています。");if(t.type==="number"){this.i++;return [t.value];}if(this.take("(")){const v=this.expr();this.expect(")");return v;}if(t.type==="identifier"){this.i++;if(t.value==="x")return [0,1];if(t.value==="pi")return [Math.PI];if(t.value==="e")return [Math.E];if(this.take("(")){const arg=this.expr();this.expect(")");if(arg.length!==1)throw new Error("関数は定数引数の場合のみ使えます。");const f={sqrt:Math.sqrt,abs:Math.abs,sin:Math.sin,cos:Math.cos,tan:Math.tan,log:Math.log10,ln:Math.log,exp:Math.exp};if(!Object.hasOwn(f,t.value))throw new Error(`関数${t.value}に未対応です。`);return [f[t.value](arg[0])];}throw new Error(`変数「${t.value}」は使えません。`);}throw new Error(`「${t.value}」を確認してください。`);}
  parse(){const p=this.expr();if(this.i!==this.tokens.length)throw new Error("式の書き方を確認してください。");return trimPoly(p);}
}
function trimPoly(p){while(p.length>1&&Math.abs(p[p.length-1])<1e-12)p.pop();return p;}
function formatXPolynomial(p,integral=false){const terms=[];for(let i=p.length-1;i>=0;i--){const c=p[i];if(Math.abs(c)<1e-11)continue;const power=i+(integral?1:0),abs=Math.abs(c),factor=power===0?formatNumber(abs):(Math.abs(abs-1)<1e-11?"":formatNumber(abs));const term=power===0?factor:`${factor}x${power===1?"":`^${power}`}`;terms.push({sign:c<0?"-":"+",term});}if(!terms.length)return "0";return terms.map((t,i)=>i===0?(t.sign==="-"?"-":"")+t.term:` ${t.sign} ${t.term}`).join("");}
function polynomialAntiderivative(p){return p.map((c,i)=>c/(i+1));}
function polynomialValue(p,x){return p.reduceRight((acc,c)=>acc*x+c,0);}
function getCalculusPoly(){return new XPolynomialParser($("#polynomialCalculusExpression").value).parse();}
$("#differentiatePolynomial")?.addEventListener("click",()=>{try{const p=getCalculusPoly();const d=p.slice(1).map((c,i)=>c*(i+1));$("#polynomialCalculusResults").textContent=`f(x) = ${formatXPolynomial(p)}\nf′(x) = ${formatXPolynomial(d.length?d:[0])}`;}catch(e){$("#polynomialCalculusResults").textContent=e.message;}});
$("#integratePolynomial")?.addEventListener("click",()=>{try{const p=getCalculusPoly(),a=polynomialAntiderivative(p);$("#polynomialCalculusResults").textContent=`f(x) = ${formatXPolynomial(p)}\n∫f(x)dx = ${formatXPolynomial(a,true)} + C`;}catch(e){$("#polynomialCalculusResults").textContent=e.message;}});
$("#definitePolynomial")?.addEventListener("click",()=>{try{const p=getCalculusPoly(),a=polynomialAntiderivative(p),lo=parseRequiredNumber("#polynomialCalculusLower","下限"),hi=parseRequiredNumber("#polynomialCalculusUpper","上限");const v=polynomialValue(a,hi)-polynomialValue(a,lo);$("#polynomialCalculusResults").textContent=`∫[${formatNumber(lo)}, ${formatNumber(hi)}] f(x) dx = ${formatNumber(v)}\n（多項式の原始関数による計算）`;}catch(e){$("#polynomialCalculusResults").textContent=e.message;}});

// Physics and chemistry calculators.
function readOptionalNumber(id){const s=$(id).value.trim();if(!s)return null;const n=Number(s);if(!Number.isFinite(n))throw new Error("入力値を数値にしてください。");return n;}
$("#calculateOhm")?.addEventListener("click",()=>{try{let V=readOptionalNumber("#ohmVoltage"),I=readOptionalNumber("#ohmCurrent"),R=readOptionalNumber("#ohmResistance");let known=[V,I,R].filter(v=>v!==null).length;if(known<2)throw new Error("電圧・電流・抵抗のうち2つ以上を入力してください。");if(V===null){if(R===0)throw new Error("抵抗0Ωから電圧を求められません。");V=I*R;}else if(I===null){if(R===0)throw new Error("抵抗0Ωから電流を求められません。");I=V/R;}else if(R===null){if(I===0)throw new Error("電流0Aから抵抗を求められません。");R=V/I;}const P=V*I;$("#ohmVoltage").value=formatNumber(V);$("#ohmCurrent").value=formatNumber(I);$("#ohmResistance").value=formatNumber(R);$("#ohmResults").textContent=`電圧 V = ${formatNumber(V)} V\n電流 I = ${formatNumber(I)} A\n抵抗 R = ${formatNumber(R)} Ω\n電力 P = VI = ${formatNumber(P)} W`; }catch(e){$("#ohmResults").textContent=e.message;}});
$("#calculateMechanics")?.addEventListener("click",()=>{try{const m=parseRequiredNumber("#mechanicsMass","質量"),a=parseRequiredNumber("#mechanicsAcceleration","加速度"),v=parseRequiredNumber("#mechanicsVelocity","速度"),h=parseRequiredNumber("#mechanicsHeight","高さ");if(m<0)throw new Error("質量は0以上にしてください。");const g=9.80665;$("#mechanicsResults").textContent=`力 F = ma = ${formatNumber(m*a)} N\n運動量 p = mv = ${formatNumber(m*v)} kg·m/s\n運動エネルギー Ek = ½mv² = ${formatNumber(.5*m*v*v)} J\n位置エネルギー Ep = mgh = ${formatNumber(m*g*h)} J\n（g = ${g} m/s²）`;}catch(e){$("#mechanicsResults").textContent=e.message;}});
$("#calculateHeat")?.addEventListener("click",()=>{try{const m=parseRequiredNumber("#heatMass","質量"),c=parseRequiredNumber("#heatSpecific","比熱"),d=parseRequiredNumber("#heatDelta","温度変化");if(m<0||c<0)throw new Error("質量と比熱は0以上にしてください。");$("#heatResults").textContent=`Q = mcΔT = ${formatNumber(m*c*d)} J`;}catch(e){$("#heatResults").textContent=e.message;}});
$("#calculateMoles")?.addEventListener("click",()=>{try{const m=parseRequiredNumber("#moleMass","質量"),M=parseRequiredNumber("#moleMolarMass","モル質量");if(m<0||M<=0)throw new Error("質量は0以上、モル質量は0より大きくしてください。");$("#moleResults").textContent=`n = m / M = ${formatNumber(m/M)} mol`;}catch(e){$("#moleResults").textContent=e.message;}});
$("#calculateConcentration")?.addEventListener("click",()=>{try{const n=parseRequiredNumber("#concentrationMoles","物質量"),v=parseRequiredNumber("#concentrationVolume","体積");if(n<0||v<=0)throw new Error("物質量は0以上、体積は0より大きくしてください。");$("#concentrationResults").textContent=`c = n / V = ${formatNumber(n/v)} mol/L`;}catch(e){$("#concentrationResults").textContent=e.message;}});
$("#calculatePH")?.addEventListener("click",()=>{try{const h=parseRequiredNumber("#hydrogenConcentration","水素イオン濃度");if(h<=0)throw new Error("水素イオン濃度は0より大きくしてください。");$("#phResults").textContent=`pH = −log₁₀[H⁺] = ${formatNumber(-Math.log10(h))}`;}catch(e){$("#phResults").textContent=e.message;}});

// Offline searchable mathematics and science reference database.
const MATH_DATABASE = [
 {c:"代数",t:"二次方程式の解の公式",f:"x = (-b ± sqrt(b^2-4ac))/(2a)",d:"ax²+bx+c=0 の解を求める公式。判別式 D=b²−4ac で実数解の個数を判断する。",e:"x²−5x+6=0 は x=2, 3。a=1,b=-5,c=6。"},
 {c:"幾何",t:"三平方の定理",f:"a^2+b^2=c^2",d:"直角三角形で、直角をはさむ2辺をa,b、斜辺をcとすると成り立つ。",e:"a=3,b=4なら c=sqrt(3^2+4^2)=5。"},
 {c:"幾何",t:"円の面積",f:"pi*r^2",d:"半径rの円の面積。rは半径。",e:"r=2なら 4π ≈ 12.56637。"},
 {c:"幾何",t:"円周",f:"2*pi*r",d:"半径rの円の周の長さ。",e:"r=3なら 6π ≈ 18.84956。"},
 {c:"三角関数",t:"正弦定理",f:"a/sin(A)=b/sin(B)=c/sin(C)",d:"三角形の辺とその対角の正弦の比は等しい。",e:"辺aと角Aが分かれば、他の辺や角を求める手掛かりになる。"},
 {c:"三角関数",t:"余弦定理",f:"c^2=a^2+b^2-2*a*b*cos(C)",d:"三角形の2辺とその間の角から、残りの辺を求める。",e:"a=3,b=4,C=90°なら c=5。"},
 {c:"三角関数",t:"三角関数の基本恒等式",f:"sin(x)^2+cos(x)^2=1",d:"同じ角度xについて常に成り立つ恒等式。",e:"sin(30°)=0.5、cos(30°)=√3/2。"},
 {c:"解析",t:"べき関数の微分",f:"d/dx x^n = n*x^(n-1)",d:"nが実数のとき、定義される範囲で使える基本的な微分公式。",e:"x^3 の導関数は 3x²。"},
 {c:"解析",t:"べき関数の積分",f:"∫x^n dx = x^(n+1)/(n+1)+C",d:"n≠−1 の場合。n=−1は ln|x|+C。",e:"∫x²dx=x³/3+C。"},
 {c:"解析",t:"指数関数の微分",f:"d/dx exp(x)=exp(x)",d:"自然指数関数は微分しても同じ関数になる。",e:"d/dx e^(2x)=2e^(2x)。"},
 {c:"解析",t:"自然対数の微分",f:"d/dx ln(x)=1/x",d:"x>0で成り立つ。",e:"d/dx ln(3x)=1/x。"},
 {c:"解析",t:"微分の積の法則",f:"(u*v)'=u'*v+u*v'",d:"2つの微分可能な関数の積を微分する公式。",e:"(x² sin x)'=2x sin x+x² cos x。"},
 {c:"解析",t:"微分の合成関数の法則",f:"(f(g(x)))'=f'(g(x))*g'(x)",d:"合成関数を微分する連鎖律。",e:"d/dx sin(x²)=2x cos(x²)。"},
 {c:"確率・統計",t:"平均値",f:"mean = (x1+x2+...+xn)/n",d:"データの合計を個数で割った値。外れ値の影響を受けやすい。",e:"2,4,6の平均は4。"},
 {c:"確率・統計",t:"分散（母分散）",f:"variance = sum((x-mean)^2)/n",d:"データの散らばりを表す。標本分散では分母をn−1にする場合がある。",e:"1,2,3の母分散は2/3。"},
 {c:"確率・統計",t:"標準偏差",f:"standardDeviation = sqrt(variance)",d:"分散の平方根。元データと同じ単位で散らばりを表す。",e:"分散が9なら標準偏差は3。"},
 {c:"確率・統計",t:"二項分布",f:"P(X=k)=nCk*p^k*(1-p)^(n-k)",d:"成功確率pの独立な試行をn回行うときの成功回数Xの分布。",e:"コインを5回投げて表が2回の確率は 5C2(1/2)^5=10/32。"},
 {c:"確率・統計",t:"正規分布",f:"f(x)=1/(σ*sqrt(2*pi))*exp(-((x-μ)^2)/(2*σ^2))",d:"平均μ、標準偏差σで特徴づけられる連続確率分布。",e:"標準正規分布は μ=0、σ=1。"},
 {c:"数論",t:"最大公約数と最小公倍数",f:"gcd(a,b)*lcm(a,b)=abs(a*b)",d:"正の整数a,bについて成り立つ関係。",e:"12と18の最大公約数は6、最小公倍数は36。"},
 {c:"数論",t:"素因数分解",f:"n = p1^a1 * p2^a2 * ...",d:"整数を素数の積として表す。1より大きい整数には一意な素因数分解がある。",e:"60=2²×3×5。"},
 {c:"数論",t:"等差数列の和",f:"S_n = n*(a_1+a_n)/2",d:"初項a₁、末項aₙ、項数nの等差数列の和。",e:"1+2+...+100=100×101/2=5050。"},
 {c:"数論",t:"等比数列の和",f:"S_n = a_1*(1-r^n)/(1-r)",d:"公比r≠1の等比数列の和。",e:"1+2+4+8=15。"},
 {c:"物理",t:"運動方程式",f:"F = m*a",d:"質量mの物体に加速度aを生じさせる合力F。SI単位はN。",e:"m=2kg、a=3m/s²なら F=6N。"},
 {c:"物理",t:"運動エネルギー",f:"E_k = 1/2*m*v^2",d:"質量m、速さvの物体が持つ運動エネルギー。",e:"m=2kg、v=3m/sなら9J。"},
 {c:"物理",t:"位置エネルギー",f:"E_p = m*g*h",d:"一様な重力場で基準面から高さhにある物体の重力による位置エネルギー。",e:"m=1kg,h=2m,g=9.80665なら約19.61J。"},
 {c:"物理",t:"オームの法則",f:"V = I*R",d:"電圧V、電流I、抵抗Rの関係。受動符号規約で使う基本式。",e:"I=2A、R=6ΩならV=12V。"},
 {c:"物理",t:"電力",f:"P = V*I",d:"直流回路などで電圧と電流から電力を求める基本式。",e:"12V、2Aなら24W。"},
 {c:"物理",t:"熱量",f:"Q = m*c*ΔT",d:"質量m、比熱c、温度変化ΔTのときの熱量。相変化がない範囲で使う。",e:"水1kgを10K上げると約41860J。"},
 {c:"化学",t:"物質量",f:"n = m/M",d:"質量mをモル質量Mで割って物質量nを求める。",e:"水18g、M=18g/molなら1mol。"},
 {c:"化学",t:"モル濃度",f:"c = n/V",d:"溶液体積V（L）あたりの物質量n（mol）。",e:"0.5molを1Lに溶かすと0.5mol/L。"},
 {c:"化学",t:"pH",f:"pH = -log10([H+])",d:"水溶液の水素イオン活量に関連する指標。希薄溶液では濃度近似を使うことがある。",e:"[H+]=10^-3 mol/Lなら濃度近似でpH=3。"},
 {c:"化学",t:"希釈の式",f:"C1*V1 = C2*V2",d:"溶質の物質量が変わらない希釈操作で使う。",e:"1mol/L溶液10mLを100mLに希釈すると0.1mol/L。"},
 {c:"幾何",t:"球の体積",f:"V = 4/3*pi*r^3",d:"半径rの球の体積。",e:"r=3なら36π。"},
 {c:"幾何",t:"円柱の体積",f:"V = pi*r^2*h",d:"底面半径r、高さhの円柱の体積。",e:"r=2,h=5なら20π。"}
];
function renderDatabaseV6(){const query=( $("#databaseSearch")?.value||"").trim().toLowerCase();const cat=$("#databaseCategory")?.value||"all";const list=MATH_DATABASE.filter(d=>(cat==="all"||d.c===cat)&&`${d.t} ${d.f} ${d.d} ${d.e} ${d.c}`.toLowerCase().includes(query));const host=$("#databaseEntries");if(!host)return;host.replaceChildren();$("#databaseCount").textContent=`${list.length}件を表示（全${MATH_DATABASE.length}件）`;if(!list.length){host.textContent="一致する項目がありません。";return;}list.forEach(d=>{const card=document.createElement("article");card.className="database-entry";const h=document.createElement("h3");h.textContent=d.t;const category=document.createElement("span");category.className="database-category";category.textContent=d.c;const formula=document.createElement("code");formula.className="database-formula";formula.textContent=d.f;const desc=document.createElement("p");desc.textContent=d.d;const example=document.createElement("p");example.className="help-text";example.textContent=`例：${d.e}`;const button=document.createElement("button");button.type="button";button.className="secondary-button";button.textContent="式の一部を電卓に送る";button.addEventListener("click",()=>{const expr=d.f.replace(/^.*?=/,'');const usable=d.f.includes(" = ")?d.f.split(" = ").slice(1).join(" = "):d.f;$("#expressionInput").value=usable.replace(/±/g,"+");document.querySelector('[data-tab="calculatorTab"]')?.click();focusWithoutScroll($("#expressionInput"));});card.append(category,h,formula,desc,example,button);host.append(card);});}
["#databaseSearch","#databaseCategory"].forEach(id=>$(id)?.addEventListener(id.includes("Search")?"input":"change",renderDatabase));

// User-defined functions are stored locally and are part of JSON/encrypted backup.
function renderCustomFunctions(){const host=$("#customFunctionList");if(!host)return;host.replaceChildren();if(!customFunctions.length){host.textContent="まだ登録されていません。";return;}customFunctions.forEach(item=>{const row=document.createElement("div");row.className="custom-function-row";const label=document.createElement("code");label.textContent=`${item.name}(x) = ${item.expression}`;const del=document.createElement("button");del.type="button";del.className="small-button";del.textContent="削除";del.addEventListener("click",()=>{customFunctions=customFunctions.filter(x=>x.name!==item.name);saveValue(CUSTOM_FUNCTIONS_KEY,customFunctions);renderCustomFunctions();});row.append(label,del);host.append(row);});}
$("#saveCustomFunction")?.addEventListener("click",()=>{try{const name=$("#customFunctionName").value.trim().toLowerCase(),expression=$("#customFunctionExpression").value.trim();if(!/^[a-z][a-z0-9_]{0,19}$/.test(name))throw new Error("関数名は英字で始まる英数字・_にしてください。");if(["pi","e","i","ans","x","y","sin","cos","tan","sqrt","log","ln","abs","exp","asin","acos","atan","floor","ceil","round"].includes(name))throw new Error("予約済みの名前は使えません。");if(!expression||expression.length>300)throw new Error("式は1〜300文字で入力してください。");evaluateExpression(expression,{x:2,angleMode});customFunctions=customFunctions.filter(x=>x.name!==name);customFunctions.push({name,expression});customFunctions=customFunctions.slice(-50);saveValue(CUSTOM_FUNCTIONS_KEY,customFunctions);renderCustomFunctions();$("#customFunctionMessage").textContent=`${name}(x) を登録しました。例：${name}(3)`;}catch(e){$("#customFunctionMessage").textContent=e.message;}});renderCustomFunctions();
$$(".calc-template").forEach(button=>button.addEventListener("click",()=>{$("#expressionInput").value=button.dataset.template.replace(/\ba\b/g,"2").replace(/\bb\b/g,"3").replace(/\bc\b/g,"1").replace(/\br\b/g,"2").replace(/\bm\b/g,"2").replace(/\bv\b/g,"5");document.querySelector('[data-tab="calculatorTab"]')?.click();focusWithoutScroll($("#expressionInput"));}));

// Custom functions belong to the same portable backup as history/memory.
const makeBackupObjectOriginal = makeBackupObject;
makeBackupObject = function(){const data=makeBackupObjectOriginal();data.customFunctions=customFunctions;return data;};
const restoreBackupObjectOriginal = restoreBackupObject;
restoreBackupObject = function(data){const ok=restoreBackupObjectOriginal(data);if(ok){if(Array.isArray(data.customFunctions))customFunctions=data.customFunctions.filter(x=>x&&/^[a-z][a-z0-9_]{0,19}$/.test(x.name)&&typeof x.expression==="string").slice(0,50);saveValue(CUSTOM_FUNCTIONS_KEY,customFunctions);renderCustomFunctions();}return ok;};

// Graph extensions: polar, parametric and inequality shading. The normal graph stays unchanged.
function drawAdvancedGraph(){const mode=$("#graphSpecialMode")?.value||"normal";if(mode==="normal"){drawGraphBase();return;}const canvas=$("#graphCanvas"),ctx=canvas?.getContext("2d");if(!ctx)return;const geometry=graphGetCanvasGeometry(),dark=document.body.classList.contains("dark");ctx.clearRect(0,0,geometry.width,geometry.height);ctx.fillStyle=dark?"#1b2637":"#ffffff";ctx.fillRect(0,0,geometry.width,geometry.height);try{const view={xMin:-10,xMax:10,yMin:-10,yMax:10};const coords=graphCoordinates(view,geometry);geometry.view=view;renderedGraphView={...view};graphDrawGrid(ctx,view,geometry,coords,dark);ctx.save();ctx.beginPath();ctx.rect(geometry.padding.left,geometry.padding.top,geometry.plotWidth,geometry.plotHeight);ctx.clip();if(mode==="polar"){const expr=$("#polarExpression").value.trim(),lo=Number($("#polarStart").value),hi=Number($("#polarEnd").value);if(!expr||!Number.isFinite(lo)||!Number.isFinite(hi)||hi<=lo)throw new Error("極座標の式とθ範囲を確認してください。");const points=[];for(let i=0;i<=900;i++){const t=lo+(hi-lo)*i/900;try{const r=evaluateExpression(expr,{angleMode:"RAD",x:t});const x=r*Math.cos(t),y=r*Math.sin(t);points.push({x,y:y,valid:Math.abs(x)<1e7&&Math.abs(y)<1e7});}catch(e){points.push({x:0,y:null});}}graphDrawCurve(ctx,points.map(p=>({x:p.x,y:p.valid?p.y:null})),GRAPH_COLORS[0],view,geometry,coords);graphSetMessage(`極座標 r(θ) = ${expr} を描画しました（θはラジアン）。`);}else if(mode==="parametric"){const ex=$("#parametricX").value.trim(),ey=$("#parametricY").value.trim(),lo=Number($("#parametricStart").value),hi=Number($("#parametricEnd").value);if(!ex||!ey||!Number.isFinite(lo)||!Number.isFinite(hi)||hi<=lo)throw new Error("媒介変数の式と範囲を確認してください。");const points=[];for(let i=0;i<=900;i++){const t=lo+(hi-lo)*i/900;try{const x=evaluateExpression(ex.replace(/\bt\b/g,"x"),{angleMode:"RAD",x:t}),y=evaluateExpression(ey.replace(/\bt\b/g,"x"),{angleMode:"RAD",x:t});points.push({x,y});}catch(e){points.push({x:0,y:null});}}graphDrawCurve(ctx,points,GRAPH_COLORS[1],view,geometry,coords);graphSetMessage(`媒介変数 x(t)=${ex}, y(t)=${ey} を描画しました。`);}else if(mode==="inequality"){const expr=$("#inequalityExpression").value.replace(/≤/g,"<=").replace(/≥/g,">=").trim(),m=expr.match(/(<=|>=|<|>)/);if(!m)throw new Error("不等号 <、<=、>、>= を含めてください。");const parts=expr.split(m[0]);if(parts.length!==2)throw new Error("不等式の形式を確認してください。");const left=parts[0],right=parts[1],step=8;for(let py=geometry.padding.top;py<geometry.padding.top+geometry.plotHeight;py+=step){for(let px=geometry.padding.left;px<geometry.padding.left+geometry.plotWidth;px+=step){const x=coords.pixelToX(px+step/2),y=coords.pixelToY(py+step/2);try{const a=evaluateExpression(left,{angleMode:"RAD",x,y}),b=evaluateExpression(right,{angleMode:"RAD",x,y});const ok=m[0]==="<"?a<b:m[0]==="<="?a<=b:m[0]===">"?a>b:a>=b;if(ok){ctx.fillStyle="rgba(69,142,214,0.28)";ctx.fillRect(px,py,step,step);}}catch(e){}}}graphSetMessage(`不等式 ${expr} の解領域を簡易表示しました。`);}ctx.restore();}catch(e){ctx.restore();graphSetMessage(e.message||"追加グラフを描けません。",true);} }
const drawGraphBase=drawGraph;drawGraph=drawAdvancedGraph;
$("#graphSpecialMode")?.addEventListener("change",()=>{const mode=$("#graphSpecialMode").value;$("#polarControls").hidden=mode!=="polar";$("#parametricControls").hidden=mode!=="parametric";$("#inequalityControls").hidden=mode!=="inequality";});
$("#drawSpecialGraph")?.addEventListener("click",drawGraph);


/* 21. テイラー展開・化学反応式の係数合わせ・快捷キー */
function combination(n,k){let r=1;for(let i=1;i<=k;i++)r=r*(n-i+1)/i;return r;}
function formatTaylorTerms(coeffs,x0){const parts=[];coeffs.forEach((a,k)=>{if(Math.abs(a)<1e-10)return;const factor=Math.abs(a-1)<1e-10&&k>0?"":Math.abs(a+1)<1e-10&&k>0?"":formatNumber(Math.abs(a));const term=k===0?formatNumber(Math.abs(a)):`${factor}${k===1?"":""}(x ${x0>=0?"−":"+"} ${formatNumber(Math.abs(x0))})${k===1?"":`^${k}`}`;parts.push({negative:a<0,term});});if(!parts.length)return "0";return parts.map((p,i)=>i===0?(p.negative?"−":"")+p.term:` ${p.negative?"−":"+"} ${p.term}`).join("");}
$("#taylorPolynomial")?.addEventListener("click",()=>{try{const p=getCalculusPoly(),x0=parseRequiredNumber("#taylorCenter","展開中心"),n=parseRequiredNumber("#taylorOrder","次数");if(!Number.isInteger(n)||n<0||n>8)throw new Error("次数は0〜8の整数にしてください。");const coefficients=Array(n+1).fill(0);for(let j=0;j<=n;j++)for(let k=j;k<p.length;k++)coefficients[j]+=p[k]*combination(k,j)*Math.pow(x0,k-j);const result=formatTaylorTerms(coefficients,x0);$("#polynomialCalculusResults").textContent=`展開中心 x₀ = ${formatNumber(x0)}\nテイラー多項式（${n}次）\nT${n}(x) = ${result}\n\n※入力が多項式なので、この次数が元の多項式の次数以上なら一致します。`; }catch(e){$("#polynomialCalculusResults").textContent=e.message;}});

function parseChemicalFormula(formula){let i=0;const text=formula.trim();function merge(dst,src,m=1){for(const [el,n] of Object.entries(src))dst[el]=(dst[el]||0)+n*m;}function readNumber(){const m=text.slice(i).match(/^\d+/);if(!m)return 1;i+=m[0].length;return Number(m[0]);}function group(){const counts={};while(i<text.length){const ch=text[i];if(ch===")"){i++;return counts;}if(ch==="("){i++;const inner=group();merge(counts,inner,readNumber());continue;}const m=text.slice(i).match(/^([A-Z][a-z]?)/);if(!m)throw new Error(`分子式「${formula}」の「${ch}」を読めません。`);i+=m[0].length;counts[m[1]]=(counts[m[1]]||0)+readNumber();}return counts;}const out=group();if(i!==text.length)throw new Error(`分子式「${formula}」の括弧を確認してください。`);if(!Object.keys(out).length)throw new Error("空の分子式です。");return out;}
function gcdInt(a,b){a=Math.abs(a);b=Math.abs(b);while(b){const t=a%b;a=b;b=t;}return a||1;}
function gcdArray(values){return values.reduce((a,b)=>gcdInt(a,b),0)||1;}
function lcmInt(a,b){return Math.abs(a*b)/gcdInt(a,b);}
function balanceChemicalEquation(raw){const sides=raw.split(/->|→|=/);if(sides.length!==2)throw new Error("矢印（→ または ->）を1つ入力してください。");const left=sides[0].split("+").map(x=>x.trim()).filter(Boolean),right=sides[1].split("+").map(x=>x.trim()).filter(Boolean);if(!left.length||!right.length||left.length+right.length>8)throw new Error("反応物・生成物をそれぞれ入力してください（物質は合計8種類まで）。");const formulas=[...left,...right],counts=formulas.map(parseChemicalFormula),elements=[...new Set(counts.flatMap(x=>Object.keys(x)))];if(elements.length>10)throw new Error("元素の種類が多すぎます（10種類まで）。");const n=formulas.length,mat=elements.map(el=>formulas.map((_,i)=>(counts[i][el]||0)*(i<left.length?1:-1)));let row=0;const pivots=[];for(let col=0;col<n&&row<mat.length;col++){let p=row;for(let r=row+1;r<mat.length;r++)if(Math.abs(mat[r][col])>Math.abs(mat[p][col]))p=r;if(Math.abs(mat[p][col])<1e-10)continue;[mat[row],mat[p]]=[mat[p],mat[row]];const d=mat[row][col];mat[row]=mat[row].map(v=>v/d);for(let r=0;r<mat.length;r++)if(r!==row){const f=mat[r][col];mat[r]=mat[r].map((v,k)=>v-f*mat[row][k]);}pivots.push(col);row++;}const free=Array.from({length:n},(_,i)=>i).filter(i=>!pivots.includes(i));if(!free.length)throw new Error("非自明な係数解が見つかりません。式を確認してください。");if(free.length>3)throw new Error("この式は候補が複雑です。物質の数を減らして入力してください。");let best=null;const assign=Array(free.length).fill(0);function tryAssign(depth){if(depth<free.length){for(let v=-6;v<=6;v++){if(!v)continue;assign[depth]=v;tryAssign(depth+1);}return;}const vec=Array(n).fill(0);free.forEach((col,i)=>vec[col]=assign[i]);pivots.forEach((col,r)=>{let sum=0;free.forEach((fc,i)=>sum+=mat[r][fc]*assign[i]);vec[col]=-sum;});if(vec.some(v=>!Number.isFinite(v)||v<=1e-9))return;const scaled=vec.map(v=>{for(let d=1;d<=120;d++)if(Math.abs(v*d-Math.round(v*d))<1e-7)return {num:Math.round(v*d),den:d};return null;});if(scaled.some(x=>!x))return;let lcm=scaled.reduce((a,x)=>lcmInt(a,x.den),1);let ints=scaled.map(x=>x.num*(lcm/x.den));const g=gcdArray(ints);ints=ints.map(x=>x/g);if(ints.some(x=>x<=0))return;const sum=ints.reduce((a,b)=>a+b,0);if(!best||sum<best.sum)best={coeffs:ints,sum};}tryAssign(0);if(!best)throw new Error("正の整数係数が見つかりません。式が正しいか確認してください。");return `${left.map((f,i)=>`${best.coeffs[i]===1?"":best.coeffs[i]}${f}`).join(" + ")} → ${right.map((f,i)=>`${best.coeffs[i+left.length]===1?"":best.coeffs[i+left.length]}${f}`).join(" + ")}`;}
$("#balanceReaction")?.addEventListener("click",()=>{try{const balanced=balanceChemicalEquation($("#reactionEquation").value);$("#reactionResults").textContent=balanced;addToolHistory("化学反応式",$("#reactionEquation").value,balanced);}catch(e){$("#reactionResults").textContent=e.message;}});

// Ctrl+Alt+1〜9 inserts the corresponding saved custom function call.
document.addEventListener("keydown",event=>{if(!(event.ctrlKey&&event.altKey&&/^[1-9]$/.test(event.key)))return;const item=customFunctions[Number(event.key)-1];if(!item)return;event.preventDefault();const input=$("#expressionInput");if(input){focusWithoutScroll(input);insertAtCursor(`${item.name}(`);}});

// Additional trigonometric reference entries.
MATH_DATABASE.push(
 {c:"三角関数",t:"三角関数の特別な角（30°）",f:"sin(30)=1/2; cos(30)=sqrt(3)/2; tan(30)=1/sqrt(3)",d:"度数法での30°の基本値。角度モードをDEGにして確認します。",e:"sin(30) は 0.5。"},
 {c:"三角関数",t:"三角関数の特別な角（45°）",f:"sin(45)=sqrt(2)/2; cos(45)=sqrt(2)/2; tan(45)=1",d:"度数法での45°の基本値。",e:"tan(45) は 1。"},
 {c:"三角関数",t:"三角関数の特別な角（60°）",f:"sin(60)=sqrt(3)/2; cos(60)=1/2; tan(60)=sqrt(3)",d:"度数法での60°の基本値。",e:"cos(60) は 0.5。"}
);


/* 22. 追加の物理計算・化学式モル質量・素因数分解 */
const ATOMIC_MASSES={H:1.008,He:4.0026,Li:6.94,Be:9.0122,B:10.81,C:12.011,N:14.007,O:15.999,F:18.998,Ne:20.180,Na:22.990,Mg:24.305,Al:26.982,Si:28.085,P:30.974,S:32.06,Cl:35.45,Ar:39.948,K:39.098,Ca:40.078,Sc:44.956,Ti:47.867,V:50.942,Cr:51.996,Mn:54.938,Fe:55.845,Co:58.933,Ni:58.693,Cu:63.546,Zn:65.38,Br:79.904,Ag:107.868,I:126.904,Ba:137.327,Au:196.967,Hg:200.592,Pb:207.2};
$("#calculateMolarFormula")?.addEventListener("click",()=>{try{const formula=$("#molarFormula").value.trim(),counts=parseChemicalFormula(formula);let mass=0,parts=[];for(const [el,n] of Object.entries(counts)){if(!Object.hasOwn(ATOMIC_MASSES,el))throw new Error(`元素${el}の原子量はまだ登録されていません。`);mass+=ATOMIC_MASSES[el]*n;parts.push(`${el}: ${n} × ${ATOMIC_MASSES[el]}`);}$("#molarFormulaResults").textContent=`${formula} のモル質量 ≈ ${formatNumber(mass)} g/mol\n${parts.join("\n")}`;}catch(e){$("#molarFormulaResults").textContent=e.message;}});
$("#calculatePressure")?.addEventListener("click",()=>{try{const F=parseRequiredNumber("#pressureForce","力"),A=parseRequiredNumber("#pressureArea","面積");if(F<0||A<=0)throw new Error("力は0以上、面積は0より大きくしてください。");$("#pressureResults").textContent=`P = F/A = ${formatNumber(F/A)} Pa\n= ${formatNumber(F/A/1000)} kPa`;}catch(e){$("#pressureResults").textContent=e.message;}});
$("#calculateMotion")?.addEventListener("click",()=>{try{const v0=parseRequiredNumber("#motionV0","初速度"),a=parseRequiredNumber("#motionAcceleration","加速度"),t=parseRequiredNumber("#motionTime","時間");if(t<0)throw new Error("時間は0以上にしてください。");const v=v0+a*t,s=v0*t+.5*a*t*t;$("#motionResults").textContent=`最終速度 v = v₀ + at = ${formatNumber(v)} m/s\n変位 s = v₀t + ½at² = ${formatNumber(s)} m`;}catch(e){$("#motionResults").textContent=e.message;}});
$("#factorizeNumber")?.addEventListener("click",()=>{try{let n=BigInt($("#factorInput").value.trim());if(n<2n||n>1000000000000n)throw new Error("2〜1,000,000,000,000の整数を入力してください。");const original=n,factors=[];for(let p=2n;p*p<=n&&p<=1000000n;p=p===2n?3n:p+2n){let count=0;while(n%p===0n){n/=p;count++;}if(count)factors.push(`${p}${count>1?`^${count}`:""}`);}if(n>1n)factors.push(String(n));$("#factorResults").textContent=`${original} = ${factors.join(" × ")}\n素因数の種類：${factors.length}`;}catch(e){$("#factorResults").textContent=e.message;}});



/* =========================================================
   23. Aurora 拡張計算ワークベンチ（追加機能・保存互換レイヤー）
   - 既存STORAGE_KEYSは変更しない
   - 新データは独立キーで保存し、旧バックアップも読み込み可能
   ========================================================= */
const AURORA_EXT_KEYS = {
  variables: "aurora-calculator-variables-v1",
  worksheets: "aurora-calculator-worksheets-v1",
  precision: "aurora-calculator-decimal-precision-v1",
  display: "aurora-calculator-number-display-v1",
  answerText: "aurora-calculator-answer-text-v1"
};
let auroraVariables = readSaved(AURORA_EXT_KEYS.variables, {});
if (!auroraVariables || typeof auroraVariables !== "object" || Array.isArray(auroraVariables)) auroraVariables = {};
let auroraWorksheets = readSaved(AURORA_EXT_KEYS.worksheets, []);
if (!Array.isArray(auroraWorksheets)) auroraWorksheets = [];
let auroraPrecision = Math.max(20, Math.min(500, Number(readSaved(AURORA_EXT_KEYS.precision, 100)) || 100));
let auroraDisplayMode = readSaved(AURORA_EXT_KEYS.display, "all");
let auroraAnswerText = String(readSaved(AURORA_EXT_KEYS.answerText, ""));
let auroraLastTrace = [];
function auroraTraceValue(value){return isComplexValue(value)?formatComplex(value):String(value);}
ExpressionParser.prototype.parseExpression = function(){
  this.trace=this.trace||[];
  let value=this.parseTerm();
  while(this.peek("+")||this.peek("-")){
    const op=this.take().value,right=this.parseTerm(),before=value;
    value=this.complexMode?(op==="+"?cAdd(value,right):cSub(value,right)):(op==="+"?value+right:value-right);
    this.trace.push(`${auroraTraceValue(before)} ${op} ${auroraTraceValue(right)} = ${auroraTraceValue(value)}`);
  }
  return value;
};
ExpressionParser.prototype.parseTerm = function(){
  this.trace=this.trace||[];
  let value=this.parseUnary();
  while(this.peek("*")||this.peek("/")){
    const op=this.take().value,right=this.parseUnary(),before=value;
    if(!this.complexMode&&op==="/"&&right===0)throw new Error("0では割れません。");
    value=this.complexMode?(op==="*"?cMul(value,right):cDiv(value,right)):(op==="*"?value*right:value/right);
    this.trace.push(`${auroraTraceValue(before)} ${op} ${auroraTraceValue(right)} = ${auroraTraceValue(value)}`);
  }
  return value;
};
ExpressionParser.prototype.parsePower = function(){
  this.trace=this.trace||[];
  let value=this.parsePostfix();
  if(this.take("^")){const exponent=this.parseUnary(),before=value;value=this.complexMode?cPow(value,exponent):Math.pow(value,exponent);this.trace.push(`${auroraTraceValue(before)} ^ ${auroraTraceValue(exponent)} = ${auroraTraceValue(value)}`);}
  return value;
};
ExpressionParser.prototype.parsePostfix = function(){
  this.trace=this.trace||[];
  let value=this.parsePrimary();
  while(this.peek("!")||this.peek("%")){const op=this.take().value,before=value;if(op==="!"){if(this.complexMode&&isComplexValue(value)&&Math.abs(value.im)>1e-12)throw new Error("複素数の階乗には対応していません。");value=this.factorial(realPart(value));}else value=this.complexMode?cScale(value,.01):value/100;this.trace.push(`${auroraTraceValue(before)}${op} = ${auroraTraceValue(value)}`);}
  return value;
};
const auroraOriginalEvaluateMainExpression=evaluateMainExpression;
evaluateMainExpression=function(source,options={}){const parser=new ExpressionParser(source,{...options,complexMode:true});parser.trace=[];const result=parser.parse();auroraLastTrace=parser.trace.slice();return result;};

function auroraSaveExtended() {
  const ok = [
    saveValue(AURORA_EXT_KEYS.variables, auroraVariables),
    saveValue(AURORA_EXT_KEYS.worksheets, auroraWorksheets),
    saveValue(AURORA_EXT_KEYS.precision, auroraPrecision),
    saveValue(AURORA_EXT_KEYS.display, auroraDisplayMode),
    saveValue(AURORA_EXT_KEYS.answerText, auroraAnswerText)
  ].every(Boolean);
  if (!ok) showMessage("#backupMessage", "拡張データの保存に失敗しました。JSONバックアップを保存してください。", true);
  return ok;
}

// 任意精度十進数。係数をBigInt、scaleを10の累乗として保持する。
class AuroraDecimal {
  constructor(coefficient, scale = 0) {
    this.c = BigInt(coefficient);
    this.s = Math.max(0, Number(scale) || 0);
    this.normalize();
  }
  normalize() {
    if (this.c === 0n) { this.s = 0; return this; }
    while (this.s > 0 && this.c % 10n === 0n) { this.c /= 10n; this.s -= 1; }
    return this;
  }
  static from(value) {
    if (value instanceof AuroraDecimal) return value;
    const source = String(value).trim();
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(source)) throw new Error(`数値「${source}」を読み取れません。`);
    let [mantissa, exponentText] = source.toLowerCase().split("e");
    const exponent = Number(exponentText || 0);
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 5000) throw new Error("指数が大きすぎます。");
    let sign = 1n;
    if (mantissa.startsWith("-")) { sign = -1n; mantissa = mantissa.slice(1); }
    else if (mantissa.startsWith("+")) mantissa = mantissa.slice(1);
    const pieces = mantissa.split(".");
    const frac = pieces[1] || "";
    let digits = (pieces[0] || "0") + frac;
    if (digits.length > 5000) throw new Error("1つの数値は最大5000桁です。");
    let scale = frac.length - exponent;
    let coefficient = sign * BigInt(digits || "0");
    if (scale < 0) { coefficient *= 10n ** BigInt(-scale); scale = 0; }
    if (scale > 5000) throw new Error("小数の桁数が大きすぎます。");
    return new AuroraDecimal(coefficient, scale);
  }
  static align(a, b) {
    a = AuroraDecimal.from(a); b = AuroraDecimal.from(b);
    const scale = Math.max(a.s, b.s);
    return [a.c * 10n ** BigInt(scale - a.s), b.c * 10n ** BigInt(scale - b.s), scale];
  }
  static add(a,b) { const [x,y,s] = AuroraDecimal.align(a,b); return new AuroraDecimal(x+y,s); }
  static sub(a,b) { const [x,y,s] = AuroraDecimal.align(a,b); return new AuroraDecimal(x-y,s); }
  static mul(a,b) { a=AuroraDecimal.from(a); b=AuroraDecimal.from(b); if(a.c.toString().replace("-","").length+b.c.toString().replace("-","").length>5002) throw new Error("計算結果が大きすぎます（最大約5000桁）。"); return new AuroraDecimal(a.c*b.c,a.s+b.s); }
  static div(a,b,precision=100) {
    a=AuroraDecimal.from(a); b=AuroraDecimal.from(b);
    if (b.c === 0n) throw new Error("0では割れません。");
    const shift = precision + b.s - a.s;
    let numerator=a.c, denominator=b.c;
    if (shift >= 0) numerator *= 10n ** BigInt(shift); else denominator *= 10n ** BigInt(-shift);
    let q=numerator/denominator, r=numerator%denominator;
    if ((r<0n?-r:r)*2n >= (denominator<0n?-denominator:denominator)) q += (numerator<0n) !== (denominator<0n) ? -1n : 1n;
    return new AuroraDecimal(q,precision);
  }
  static pow(a,n,precision=100) {
    a=AuroraDecimal.from(a);
    if (!Number.isInteger(n) || Math.abs(n)>1000) throw new Error("高精度計算の指数は−1000〜1000の整数にしてください。");
    if (n===0) return AuroraDecimal.from(1);
    if (a.c!==0n && a.c.toString().replace("-","").length*Math.abs(n)>5000) throw new Error("累乗の結果が大きすぎます（最大約5000桁）。");
    if (n<0) return AuroraDecimal.div(1,AuroraDecimal.pow(a,-n,precision),precision);
    let base=a, result=AuroraDecimal.from(1), e=n;
    while(e>0){if(e%2)result=AuroraDecimal.mul(result,base);e=Math.floor(e/2);if(e)base=AuroraDecimal.mul(base,base);}
    return result;
  }
  toString() {
    const negative=this.c<0n; let digits=(negative?-this.c:this.c).toString();
    if(this.s===0)return (negative?"-":"")+digits;
    if(digits.length<=this.s)digits="0".repeat(this.s-digits.length+1)+digits;
    const point=digits.length-this.s;
    return (negative?"-":"")+digits.slice(0,point)+"."+digits.slice(point);
  }
}

class AuroraExactParser {
  constructor(source, options={}) {
    this.source=String(source).replace(/[×✕]/g,"*").replace(/[÷]/g,"/").replace(/[−–]/g,"-").replace(/π/g,"pi").replace(/\bAns\b/gi,"ans");
    if(this.source.length>5000)throw new Error("高精度計算式は5000文字以内にしてください。");
    this.precision=options.precision||auroraPrecision;
    this.variables=options.variables||{};
    this.trace=[];
    this.tokens=this.tokenize(this.source); this.pos=0;
  }
  tokenize(s){
    const raw=[];let i=0;
    while(i<s.length){if(/\s/.test(s[i])){i++;continue;}const rest=s.slice(i);
      const nm=rest.match(/^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i);
      if(nm){raw.push({t:"n",v:nm[0]});i+=nm[0].length;continue;}
      const im=rest.match(/^[a-zA-Z_][a-zA-Z_0-9]*/);
      if(im){raw.push({t:"id",v:im[0].toLowerCase()});i+=im[0].length;continue;}
      if("+-*/^()%!,".includes(s[i])){raw.push({t:"s",v:s[i]});i++;continue;}
      throw new Error(`使えない文字「${s[i]}」があります。`);
    }
    const out=[];const ends=t=>t&&(t.t==="n"||t.v===")"||(t.t==="id"&&!(["sin","cos","tan","sqrt","log","ln","abs","exp"].includes(t.v))));
    const starts=t=>t&&(t.t==="n"||t.t==="id"||t.v==="(");
    for(const token of raw){const prev=out[out.length-1];const functionCall=prev?.t==="id"&&["sin","cos","tan","sqrt","log","ln","abs","exp"].includes(prev.v)&&token.v==="(";if(ends(prev)&&starts(token)&&!functionCall)out.push({t:"s",v:"*"});out.push(token);}
    return out;
  }
  peek(v=null){const t=this.tokens[this.pos];return v===null?t:t?.v===v;}
  take(v=null){const t=this.peek();if(!t||(v!==null&&t.v!==v))return null;this.pos++;return t;}
  expect(v){if(!this.take(v))throw new Error(`「${v}」が必要です。`);}
  log(a,op,b,r){this.trace.push(`${a} ${op} ${b} = ${r}`);return r;}
  expr(){let v=this.term();while(this.peek("+")||this.peek("-")){const op=this.take().v,b=this.term(),r=op==="+"?AuroraDecimal.add(v,b):AuroraDecimal.sub(v,b);this.log(v.toString(),op,b.toString(),r.toString());v=r;}return v;}
  term(){let v=this.unary();while(this.peek("*")||this.peek("/")){const op=this.take().v,b=this.unary(),r=op==="*"?AuroraDecimal.mul(v,b):AuroraDecimal.div(v,b,this.precision);this.log(v.toString(),op,b.toString(),r.toString());v=r;}return v;}
  unary(){if(this.take("+"))return this.unary();if(this.take("-"))return AuroraDecimal.mul(-1,this.unary());return this.power();}
  power(){let v=this.postfix();if(this.take("^")){const e=this.unary().toString();if(!/^-?\d+$/.test(e))throw new Error("高精度の累乗では整数の指数を使ってください。");const n=Number(e),r=AuroraDecimal.pow(v,n,this.precision);this.log(v.toString(),"^",e,r.toString());v=r;}return v;}
  postfix(){let v=this.primary();while(this.peek("!")||this.peek("%")){const op=this.take().v;if(op==="!"){const s=v.toString();if(!/^\d+$/.test(s)||Number(s)>1500)throw new Error("高精度階乗は0〜1500の整数に対応します（最大桁数の制限）。");let n=BigInt(s),r=1n;for(let k=2n;k<=n;k++)r*=k;v=AuroraDecimal.from(r.toString());}else v=AuroraDecimal.div(v,100,this.precision);}return v;}
  primary(){const t=this.peek();if(!t)throw new Error("式が途中で終わっています。");if(t.t==="n"){this.pos++;return AuroraDecimal.from(t.v);}if(this.take("(")){const v=this.expr();this.expect(")");return v;}if(t.t==="id") {this.pos++;const name=t.v;if(this.take("("))throw new Error(`関数 ${name} は通常精度の計算モードで計算してください。`);let value;
      if(name==="pi")value="3.1415926535897932384626433832795028841971693993751058209749445923078164062862089986280348253421170679";
      else if(name==="e")value="2.7182818284590452353602874713526624977572470936999595749669676277240766303535475945713821785251664274";
      else if(name==="ans")value=auroraAnswerText||String(answerValue);
      else if(Object.hasOwn(this.variables,name))value=this.variables[name];
      else throw new Error(`変数「${name}」が登録されていません。`);
      return AuroraDecimal.from(value);
    }throw new Error(`「${t.v}」の使い方を確認してください。`);}
  parse(){if(!this.tokens.length)throw new Error("計算式を入力してください。");const result=this.expr();if(this.pos!==this.tokens.length)throw new Error(`「${this.peek().v}」の前後を確認してください。`);return result;}
}

function auroraCanExactEvaluate(expression) {
  const s=String(expression||"").trim();
  if(!s || /\bi\b/i.test(s) || /[a-zA-Z_][a-zA-Z_0-9]*\s*\(/.test(s)) return false;
  if(/[=<>]/.test(s)) return false;
  const hasLongNumber=/(?:\d{16,}|\.\d{13,})/.test(s);
  const hasDecimalLiteral=/(?:\d+\.\d*|\.\d+)(?:e[+-]?\d+)?/i.test(s);
  const hasDivision=s.includes("/");
  const hasIntegerPower=/\^\s*[+-]?\d+\b/.test(s);
  const hasFactorial=/\d\s*!/.test(s);
  const identifiers=[...s.matchAll(/[a-zA-Z_][a-zA-Z_0-9]*/g)].map(m=>m[0].toLowerCase());
  const hasStoredVariable=identifiers.some(n=>Object.hasOwn(auroraVariables,n));
  const hasAnswer=identifiers.includes("ans");
  const hasKanjiNumber=/[零〇一二三四五六七八九壱弐参肆伍陸漆捌玖十拾百佰千阡万億兆京垓秭穣溝澗正載極恒河沙阿僧祇那由他不可思議無量大数]/.test(s);
  return hasLongNumber || hasDecimalLiteral || hasDivision || hasIntegerPower || hasFactorial || hasStoredVariable || hasAnswer || /\bpi\b|π/i.test(s) || hasKanjiNumber || s.length>300;
}
function auroraNumberString(result){return typeof result==="string"?result:String(result);}

// 日本の命数法（万進）
const AURORA_LARGE_UNITS=["","万","億","兆","京","垓","秭","穣","溝","澗","正","載","極","恒河沙","阿僧祇","那由他","不可思議","無量大数"];
const AURORA_KANJI_DIGITS=["零","一","二","三","四","五","六","七","八","九"];
const AURORA_DAIJI_DIGITS=["零","壱","弐","参","肆","伍","陸","漆","捌","玖"];
function auroraGroupKanji(n,daiji=false){
  let v=Number(n);if(!v)return "";const d=daiji?AURORA_DAIJI_DIGITS:AURORA_KANJI_DIGITS,units=daiji?["","拾","佰","阡"]:["","十","百","千"];let out="";
  for(let p=3;p>=0;p--){const digit=Math.floor(v/10**p)%10;if(!digit)continue;const unit=units[p];out+=(digit===1&&p>0?"":d[digit])+unit;}
  return out;
}
function auroraJapaneseInteger(input,daiji=false){
  let n;try{n=BigInt(input);}catch{return "—";}if(n===0n)return "零";const negative=n<0n;if(negative)n=-n;let groups=[],index=0;
  while(n>0n&&index<AURORA_LARGE_UNITS.length){const g=Number(n%10000n);if(g)groups.push({g,index});n/=10000n;index++;}
  if(n>0n)return "桁が大きすぎます（無量大数まで）";
  const out=groups.reverse().map(({g,index})=>auroraGroupKanji(g,daiji)+(daiji?AURORA_LARGE_UNITS[index].replace("万","萬"):AURORA_LARGE_UNITS[index])).join("");return (negative?"マイナス":"")+out;
}
function auroraGroupComma(digits,size=3){return digits.replace(/\B(?=(\d{3})+(?!\d))/g,",");}
function auroraJapaneseDecimalString(value,daiji=false){
  const s=String(value);if(!/^-?\d+(?:\.\d+)?$/.test(s))return "—";const [whole,frac]=s.replace(/^-/,"").split(".");let out=auroraJapaneseInteger(whole,daiji);if(s.startsWith("-"))out="マイナス"+out;
  if(frac){const d=daiji?AURORA_DAIJI_DIGITS:AURORA_KANJI_DIGITS;out+="点"+[...frac].map(ch=>d[Number(ch)]).join("");}return out;
}
// 新しい追加表示：数字は0〜9のまま、4桁ごとの大きな単位だけ漢字にする。
// 例：123456789 -> 1億2345万6789。小数部は通常の数字のまま保持する。
function auroraArabicJapaneseUnitString(value){
  let normalized;
  try { normalized = AuroraDecimal.from(String(value).replace(/,/g, "")).toString(); }
  catch (_) { return "—"; }
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return "—";
  const negative = normalized.startsWith("-");
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [whole, fraction] = unsigned.split(".");
  let n;
  try { n = BigInt(whole || "0"); } catch (_) { return "—"; }
  if (n === 0n) return (negative ? "-" : "") + "0" + (fraction !== undefined ? "." + fraction : "");
  const groups = [];
  let index = 0;
  while (n > 0n && index < AURORA_LARGE_UNITS.length) {
    const group = Number(n % 10000n);
    if (group !== 0) groups.push({ group, index });
    n /= 10000n;
    index += 1;
  }
  if (n > 0n) return "桁数超過（無量大数より大きい値）";
  const body = groups.reverse().map(({ group, index: unitIndex }) => `${group}${AURORA_LARGE_UNITS[unitIndex]}`).join("");
  return (negative ? "-" : "") + (body || "0") + (fraction !== undefined ? "." + fraction : "");
}

function auroraJapaneseUnitString(value){
  const s=String(value);if(!/^-?\d+(?:\.\d+)?$/.test(s))return "—";const [whole,frac]=s.replace(/^-/,"").split(".");let n=BigInt(whole||"0");const groups=[];let i=0;while(n>0n&&i<AURORA_LARGE_UNITS.length){const g=Number(n%10000n);if(g)groups.push({g,index:i});n/=10000n;i++;}if(n>0n)return "桁数超過";let out=groups.reverse().map(x=>auroraGroupKanji(x.g)+AURORA_LARGE_UNITS[x.index]).join("");if(!out&&!frac)out="零";if(s.startsWith("-")&&(out||frac))out="マイナス"+out;
  if(frac){const small=["","分","厘","毛","糸","忽","微","繊","沙","塵","埃"];for(let j=0;j<frac.length&&j<small.length-1;j++){const v=Number(frac[j]);if(v)out+=AURORA_KANJI_DIGITS[v]+small[j+1];}}
  return out||"零";
}
function auroraRenderNumberFormats(value){
  const host=$("#bigNumberFormats");if(!host)return;const s=String(value).replace(/,/g,"");
  if(!/^-?\d+(?:\.\d+)?$/.test(s)){host.hidden=true;return;}host.hidden=false;
  const [whole,frac]=s.replace(/^-/,"").split(".");const comma=(s.startsWith("-")?"-":"")+auroraGroupComma(whole)+(frac!==undefined?"."+frac:"");
  const comma4=(s.startsWith("-")?"-":"")+whole.replace(/\B(?=(\d{4})+(?!\d))/g,",")+(frac!==undefined?"."+frac:"");
  const jp=auroraJapaneseUnitString(s);const kanji=auroraJapaneseDecimalString(s,false);const daiji=auroraJapaneseDecimalString(s,true);
  host.replaceChildren();
  const arabicJapanese=auroraArabicJapaneseUnitString(s);
  const rows=[["group3","3桁区切り",comma],["group4","4桁区切り",comma4],["all","日本語の数の単位（漢字数字）",jp],["arabicJapanese","数字＋漢字単位",arabicJapanese],["kanji","漢数字",kanji],["daiji","大字",daiji]];
  const visible=auroraDisplayMode==="all"?rows:rows.filter(([mode])=>mode===auroraDisplayMode);
  visible.forEach(([,label,text])=>{const row=document.createElement("div");row.className="number-format-row";const l=document.createElement("span");l.textContent=label;const v=document.createElement("strong");v.textContent=text;const b=document.createElement("button");b.type="button";b.className="small-button";b.textContent="コピー";b.addEventListener("click",()=>navigator.clipboard?.writeText(text));row.append(l,v,b);host.append(row);});
}

// 漢数字から整数へ。大きな位は万進、通常位は十・百・千で解析。
function auroraParseKanjiNumber(source){
  const digitMap={"零":"0","〇":"0","一":"1","二":"2","三":"3","四":"4","五":"5","六":"6","七":"7","八":"8","九":"9","壱":"1","弐":"2","参":"3","肆":"4","伍":"5","陸":"6","漆":"7","捌":"8","玖":"9"};
  let text=String(source).trim().replace(/[,，\s]/g,"").replace(/萬/g,"万");if(!text)throw new Error("漢数字を入力してください。");let negative=false;if(text.startsWith("マイナス")||text.startsWith("負")){negative=true;text=text.replace(/^(?:マイナス|負)/,"");}
  let total=0n,section=0n,pending="";const big=[...AURORA_LARGE_UNITS].map((u,i)=>({u,i})).filter(x=>x.u).sort((a,b)=>b.u.length-a.u.length);
  const small={"十":10n,"拾":10n,"百":100n,"佰":100n,"千":1000n,"阡":1000n};
  for(let i=0;i<text.length;){const large=big.find(x=>text.startsWith(x.u,i));if(large){const n=pending?BigInt(pending):0n;section+=n;total+=(section||1n)*(10000n**BigInt(large.i));section=0n;pending="";i+=large.u.length;continue;}
    const ch=text[i];if(Object.hasOwn(digitMap,ch)){pending+=digitMap[ch];i++;continue;}
    if(Object.hasOwn(small,ch)){const n=pending?BigInt(pending):1n;section+=n*small[ch];pending="";i++;continue;}
    if(ch==="点"||ch===".")throw new Error("漢数字入力は整数に対応します。小数は通常の数字で入力してください。");
    throw new Error(`漢数字の「${ch}」を認識できません。`);
  }
  section+=pending?BigInt(pending):0n;total+=section;if(negative)total=-total;return total.toString();
}

function auroraNormalizeKanjiExpression(expression){
  const pattern=/[零〇一二三四五六七八九壱弐参肆伍陸漆捌玖十拾百佰千阡万萬億兆京垓秭穣溝澗正載極恒河沙阿僧祇那由他不可思議無量大数]+/g;
  return String(expression).replace(pattern,token=>auroraParseKanjiNumber(token));
}

// 既存の通常計算を保ちながら、長整数・長小数・π多項式は高精度側へ。
const auroraOriginalCalculateMain=calculateMain;
calculateMain=function(){
  const expression=$("#expressionInput")?.value.trim()||"";
  try{
    const normalized=auroraNormalizeKanjiExpression(expression);
    if(auroraCanExactEvaluate(normalized)){
      const parser=new AuroraExactParser(normalized,{precision:auroraPrecision,variables:auroraVariables});
      const exact=parser.parse().toString();const shown=auroraNumberString(exact);
      $("#mainResult").textContent=shown;$("#mainResult").parentElement?.classList.toggle("long-result",shown.length>28);auroraAnswerText=exact;saveValue(AURORA_EXT_KEYS.answerText,exact);
      const numeric=Number(exact);if(Number.isFinite(numeric)&&Math.abs(numeric)<=Number.MAX_SAFE_INTEGER){answerValue=numeric;saveValue(STORAGE_KEYS.answer,answerValue);}
      renderPiAlternatives(normalized, Number(exact));auroraRenderNumberFormats(exact);
      const explain=$("#mainExplanation");if(explain){explain.replaceChildren();const heading=document.createElement("strong");heading.textContent="計算過程";explain.append(heading);const steps=parser.trace.slice(-80);if(steps.length){const ol=document.createElement("ol");steps.forEach(s=>{const li=document.createElement("li");li.textContent=s;ol.append(li);});explain.append(ol);}else{const p=document.createElement("p");p.textContent="数値を高精度の十進数として読み込みました。";explain.append(p);}const note=document.createElement("p");note.className="help-text";note.textContent=`除算の小数精度：最大${auroraPrecision}桁（結果に応じて末尾の0を整理）。`;explain.append(note);}
      addHistory(expression,shown,"高精度計算");showMessage("#calculatorMessage","高精度で計算しました。");return exact;
    }
    const expanded=auroraExpandVariables(normalized);
    const result=evaluateMainExpression(expanded,{angleMode,ans:answerValue});
    const formatted=isComplexValue(result)?formatComplex(result):formatNumber(result);
    $("#mainResult").textContent=formatted;$("#mainResult").parentElement?.classList.toggle("long-result",formatted.length>28);renderPiAlternatives(normalized,result);auroraRenderNumberFormats(formatted);
    if(typeof result==="number"){answerValue=result;saveValue(STORAGE_KEYS.answer,answerValue);auroraAnswerText=String(result);saveValue(AURORA_EXT_KEYS.answerText,auroraAnswerText);showMessage("#calculatorMessage","計算できました。");}
    else showMessage("#calculatorMessage","複素数で計算しました。Ans・メモリーは実数の前回値を保持しています。");
    addHistory(expression,formatted);const explain=$("#mainExplanation");if(explain){explain.replaceChildren();const heading=document.createElement("strong");heading.textContent="計算過程";explain.append(heading);if(auroraLastTrace.length){const ol=document.createElement("ol");auroraLastTrace.slice(-80).forEach(step=>{const li=document.createElement("li");li.textContent=step;ol.append(li);});explain.append(ol);}else{const p=document.createElement("p");p.textContent=`関数・括弧を評価し、累乗 → 乗除 → 加減の優先順位で計算しました。結果：${formatted}`;explain.append(p);}}
    return result;
  }catch(error){
    const message=error.message||"計算できませんでした。";showMessage("#calculatorMessage",message,true);
    const help=$("#mainExplanation");if(help){let hint="演算子・括弧・関数名・入力値を確認してください。式を短く分けて試すと原因を特定しやすくなります。";if(/括弧|必要です/.test(message))hint="開き括弧と閉じ括弧の数、演算子の前後を確認してください。";if(/0では割れません/.test(message))hint="分母が0になっていないか確認してください。";if(/変数/.test(message))hint="変数の登録名と綴りを確認してください。変数タブから登録できます。";if(/使えない文字/.test(message))hint="対応している演算子に置き換えてください。";help.textContent=`原因：${message}\n修正のヒント：${hint}`;}
    return null;
  }
};

// 高精度π表示：PiExactParserの厳密式＋50桁のπ定数による小数＋3.14概算。
const auroraOriginalRenderPiAlternatives=renderPiAlternatives;
renderPiAlternatives=function(expression,numericResult){
  auroraOriginalRenderPiAlternatives(expression,numericResult);
  const panel=$("#piAlternatives");if(!panel||!/(?:\bpi\b|π)/i.test(expression))return;
  try{
    const poly=new PiExactParser(expression,{angleMode,ans:answerValue}).parse();if(!poly||!Object.keys(poly).some(k=>Number(k)>0))return;
    const p=new AuroraExactParser(expression,{precision:Math.min(auroraPrecision,100)}).parse().toString();
    $("#piDecimalResult").textContent=auroraNumberString(p)+"（πの高精度値を使用）";
    const approxExpr=expression.replace(/\bpi\b|π/gi,"(3.14)");
    const approx=new AuroraExactParser(approxExpr,{precision:Math.min(auroraPrecision,100)}).parse().toString();
    $("#piApproxResult").textContent=approx+"（π = 3.14）";panel.hidden=false;
  }catch(e){}
};

// 変数を既存数値パーサー用に展開（ユーザー定義関数名・予約語を保護）。
function auroraExpandVariables(expr){
  let out=String(expr);const reserved=new Set(["pi","e","i","ans","x","y","sin","cos","tan","asin","acos","atan","sqrt","log","ln","exp","abs","floor","ceil","round"]);
  Object.entries(auroraVariables).sort((a,b)=>b[0].length-a[0].length).forEach(([name,value])=>{if(reserved.has(name))return;const re=new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}\\b`,"gi");out=out.replace(re,`(${String(value)})`);});return out;
}
function auroraEvaluate(expr,opts={}){const expanded=auroraExpandVariables(expr);if(auroraCanExactEvaluate(expr)){const variables={...auroraVariables};if(opts.x!==undefined)variables.x=String(opts.x);if(opts.y!==undefined)variables.y=String(opts.y);return new AuroraExactParser(expr,{precision:auroraPrecision,variables}).parse().toString();}return evaluateExpression(expanded,{angleMode,ans:answerValue,...opts});}

// 変数一覧
function auroraRenderVariables(){const host=$("#variableList");if(!host)return;host.replaceChildren();const entries=Object.entries(auroraVariables);if(!entries.length){host.textContent="登録された変数はありません。";return;}entries.forEach(([name,value])=>{const row=document.createElement("div");row.className="variable-row";const label=document.createElement("code");label.textContent=`${name} = ${value}`;const use=document.createElement("button");use.className="small-button";use.type="button";use.textContent="電卓へ";use.addEventListener("click",()=>{const input=$("#expressionInput");input.value+=name;document.querySelector('[data-tab="calculatorTab"]')?.click();focusWithoutScroll(input);});const del=document.createElement("button");del.className="small-button";del.type="button";del.textContent="削除";del.addEventListener("click",()=>{delete auroraVariables[name];auroraSaveExtended();auroraRenderVariables();});row.append(label,use,del);host.append(row);});}
$("#saveVariable")?.addEventListener("click",()=>{try{const name=$("#variableName").value.trim().toLowerCase(),value=$("#variableValue").value.trim();if(!/^[a-z][a-z0-9_]{0,19}$/.test(name))throw new Error("変数名は英字で始まる英数字・_にしてください。");if(["pi","e","i","ans","x","y","sin","cos","tan","sqrt","log","ln"].includes(name))throw new Error("予約済みの名前は使えません。");if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value))throw new Error("値は数値で入力してください。");AuroraDecimal.from(value);auroraVariables[name]=value;auroraSaveExtended();auroraRenderVariables();$("#variableMessage").textContent=`${name} を保存しました。`;}catch(e){$("#variableMessage").textContent=e.message;}});
auroraRenderVariables();

// 数学・物理の定数辞書（オフライン収録）。
const AURORA_CONSTANTS=[
  ["π","円周率","数学","3.14159265358979323846264338327950288419716939937510","円周÷直径。"],
  ["e","ネイピア数","数学","2.71828182845904523536028747135266249775724709369995","自然対数の底。"],
  ["φ","黄金比","数学","1.61803398874989484820458683436563811772030917980576","(1+√5)/2。"],
  ["√2","2の平方根","数学","1.41421356237309504880168872420969807856967187537694","正方形の対角線と辺の比。"],
  ["c","真空中の光速","物理","299792458","m/s。定義値。"],
  ["g₀","標準重力加速度","物理","9.80665","m/s²。標準値。"],
  ["h","プランク定数","物理","6.62607015e-34","J·s。定義値。"],
  ["Nₐ","アボガドロ定数","化学","6.02214076e23","mol⁻¹。定義値。"],
  ["kB","ボルツマン定数","物理","1.380649e-23","J/K。定義値。"],
  ["R","気体定数","化学","8.31446261815324","J/(mol·K) の近似値。"],
  ["ε₀","真空の誘電率","物理","8.8541878128e-12","F/m の近似値。"],
  ["μ₀","真空の透磁率","物理","1.25663706212e-6","N/A² の近似値。"]
];
function auroraRenderConstants(){const host=$("#constantList");if(!host)return;host.replaceChildren();const q=($("#constantSearch")?.value||"").toLowerCase();const list=AURORA_CONSTANTS.filter(a=>a.join(" ").toLowerCase().includes(q));list.forEach(a=>{const card=document.createElement("article");card.className="constant-card";const title=document.createElement("strong");title.textContent=`${a[0]}：${a[1]}`;const cat=document.createElement("span");cat.className="database-category";cat.textContent=a[2];const value=document.createElement("code");value.textContent=a[3];const desc=document.createElement("p");desc.textContent=a[4];const btn=document.createElement("button");btn.type="button";btn.className="small-button";btn.textContent="値を電卓へ";btn.addEventListener("click",()=>{const input=$("#expressionInput");input.value+=a[0]==="π"?"pi":a[0]==="√2"?"sqrt(2)":a[0]==="φ"?`(${a[3]})`:a[3];document.querySelector('[data-tab="calculatorTab"]')?.click();focusWithoutScroll(input);});card.append(title,cat,value,desc,btn);host.append(card);});}
$("#constantSearch")?.addEventListener("input",auroraRenderConstants);auroraRenderConstants();

// 数値一覧・一括計算（xを変数として評価）。
$("#runBatch")?.addEventListener("click",()=>{const host=$("#batchResults");try{const expr=$("#batchExpression").value.trim(),start=Number($("#batchStart").value),end=Number($("#batchEnd").value),step=Number($("#batchStep").value);if(!expr||![start,end,step].every(Number.isFinite)||step===0||(end-start)*step<0)throw new Error("式・開始・終了・間隔を確認してください。");const count=Math.floor((end-start)/step+1e-10)+1;if(count>1000)throw new Error("一括計算は最大1000行です。");const rows=[];for(let i=0;i<count;i++){const x=start+i*step;const val=auroraEvaluate(expr,{x});rows.push({x,result:String(val)});}host.replaceChildren();const table=document.createElement("table");table.className="workbench-table";const thead=document.createElement("thead");thead.innerHTML="<tr><th>x</th><th>結果</th></tr>";const tbody=document.createElement("tbody");rows.forEach(r=>{const tr=document.createElement("tr");for(const v of [r.x,r.result]){const td=document.createElement("td");td.textContent=String(v);tr.append(td);}tbody.append(tr);});table.append(thead,tbody);host.append(table);const csv=["x,result",...rows.map(r=>`${r.x},${r.result}`)].join("\n");const save=document.createElement("button");save.className="secondary-button";save.type="button";save.textContent="CSVで保存";save.addEventListener("click",()=>downloadText(`aurora-batch-${timestampForFile()}.csv`,"\uFEFF"+csv,"text/csv"));host.append(save);addHistory(`一括計算：${expr} (${start}〜${end} / ${step})`,`${rows.length}件を計算`,"一括計算");}catch(e){host.textContent=e.message;}});

// 有効数字・誤差計算。
function auroraFormatSignificant(value,digits,mode){
  if(!Number.isInteger(digits)||digits<1||digits>100)throw new Error("有効数字は1〜100桁で指定してください。");
  const d=AuroraDecimal.from(value);if(d.c===0n)return "0";
  const negative=d.c<0n;const abs=negative?-d.c:d.c;const raw=abs.toString();
  let exponent=raw.length-1-d.s;const drop=raw.length-digits;let kept;
  if(drop>0){const divisor=10n**BigInt(drop);let q=abs/divisor,r=abs%divisor;
    if(mode==="ceil"&&negative===false&&r>0n)q++;
    else if(mode==="floor"&&negative&&r>0n)q++;
    else if(mode!=="ceil"&&mode!=="floor"&&r*2n>=divisor)q++;
    kept=q.toString();
    if(kept.length>digits){exponent++;kept=kept.slice(0,digits);}
  }else kept=raw+"0".repeat(-drop);
  kept=kept.padEnd(digits,"0").slice(0,digits);
  const mantissa=digits===1?kept:`${kept[0]}.${kept.slice(1)}`;
  return `${negative?"-":""}${mantissa} × 10^${exponent}`;
}
$("#calculateSignificant")?.addEventListener("click",()=>{try{const raw=$("#sigValue").value.trim(),digits=Number($("#sigDigits").value),mode=$("#roundMode").value;if(!raw)throw new Error("数値を入力してください。");const rounded=auroraFormatSignificant(raw,digits,mode);$("#sigResults").textContent=`元の値：${raw}\n有効数字${digits}桁：${rounded}\n丸め方法：${mode==="ceil"?"切り上げ":mode==="floor"?"切り捨て":"四捨五入"}`;}catch(e){$("#sigResults").textContent=e.message;}});
$("#calculateError")?.addEventListener("click",()=>{try{const measured=AuroraDecimal.from($("#errorMeasured").value.trim()),reference=AuroraDecimal.from($("#errorReference").value.trim());if(reference.c===0n)throw new Error("基準値は0以外にしてください。");const delta=AuroraDecimal.sub(measured,reference);const abs=new AuroraDecimal(delta.c<0n?-delta.c:delta.c,delta.s);const refAbs=new AuroraDecimal(reference.c<0n?-reference.c:reference.c,reference.s);const rel=AuroraDecimal.div(abs,refAbs,auroraPrecision);const pct=AuroraDecimal.mul(rel,100);$("#errorResults").textContent=`絶対誤差：${abs.toString()}\n相対誤差：${rel.toString()}\n百分率誤差：${pct.toString()}%\n計算精度：小数点以下最大${auroraPrecision}桁`;}catch(e){$("#errorResults").textContent=e.message;}});

// 日付・時刻計算はUTCの暦日差で算出し、時差や夏時間の影響を避ける。
function auroraParseDate(s){const m=String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);if(!m)throw new Error("日付をYYYY-MM-DDで入力してください。");const d=new Date(Date.UTC(Number(m[1]),Number(m[2])-1,Number(m[3])));if(d.getUTCFullYear()!==Number(m[1])||d.getUTCMonth()!==Number(m[2])-1||d.getUTCDate()!==Number(m[3]))throw new Error("存在する日付を入力してください。");return d;}
function auroraDateText(d){return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;}
$("#calculateDates")?.addEventListener("click",()=>{try{const a=auroraParseDate($("#dateStart").value),b=auroraParseDate($("#dateEnd").value),days=Math.round((b-a)/86400000),add=Number($("#dateAddDays").value||0);if(!Number.isSafeInteger(add))throw new Error("加算日数は整数で入力してください。");const moved=new Date(a.getTime()+add*86400000);const leap=y=>y%4===0&&(y%100!==0||y%400===0);let clockText="";const ts=$("#timeStart")?.value,te=$("#timeEnd")?.value;if(ts&&te){const [sh,sm]=ts.split(":").map(Number),[eh,em]=te.split(":").map(Number);let mins=eh*60+em-(sh*60+sm);if(mins<0)mins+=1440;clockText=`\n時刻の差（終了が翌日になる場合も対応）：${Math.floor(mins/60)}時間${mins%60}分`;}$("#dateResults").textContent=`2つの日付の差：${Math.abs(days)}日（終了−開始：${days}日）\n開始日から${add}日後：${auroraDateText(moved)}\n開始年${a.getUTCFullYear()}年：${leap(a.getUTCFullYear())?"うるう年":"平年"}${clockText}`;}catch(e){$("#dateResults").textContent=e.message;}});

// ワークシートはタイトル・式・結果を独立保存し、既存履歴とは混在させない。
function auroraRenderWorksheets(){const host=$("#worksheetList");if(!host)return;host.replaceChildren();if(!auroraWorksheets.length){host.textContent="保存されたワークシートはありません。";return;}auroraWorksheets.forEach(sheet=>{const row=document.createElement("div");row.className="worksheet-row";const title=document.createElement("strong");title.textContent=sheet.title;const meta=document.createElement("span");meta.textContent=`${(sheet.content||"").split(/\r?\n/).filter(x=>x.trim()).length}行 · ${new Date(sheet.updatedAt||sheet.createdAt).toLocaleString()}`;const load=document.createElement("button");load.type="button";load.className="small-button";load.textContent="開く";load.addEventListener("click",()=>{$("#worksheetTitle").value=sheet.title;$("#worksheetExpressions").value=sheet.content;});const del=document.createElement("button");del.type="button";del.className="small-button";del.textContent="削除";del.addEventListener("click",()=>{auroraWorksheets=auroraWorksheets.filter(x=>x.id!==sheet.id);auroraSaveExtended();auroraRenderWorksheets();});row.append(title,meta,load,del);host.append(row);});}
function auroraRunWorksheet(){const lines=$("#worksheetExpressions").value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);if(lines.length>200)throw new Error("1シート最大200行です。");const out=[];for(const line of lines){const m=line.match(/^(?:([^=]+)=)?(.+)$/);const label=m[1]?.trim()||`計算${out.length+1}`,expr=m[2].trim();const result=auroraEvaluate(expr);out.push({label,expr,result:String(result)});}return out;}
$("#saveWorksheet")?.addEventListener("click",()=>{try{const title=$("#worksheetTitle").value.trim()||`ワークシート ${auroraWorksheets.length+1}`,content=$("#worksheetExpressions").value;if(!content.trim())throw new Error("計算式を1行以上入力してください。");const old=auroraWorksheets.find(x=>x.title===title);if(old){old.content=content;old.updatedAt=new Date().toISOString();}else auroraWorksheets.unshift({id:`ws-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,title,content,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});auroraWorksheets=auroraWorksheets.slice(0,100);auroraSaveExtended();auroraRenderWorksheets();$("#worksheetMessage").textContent="ワークシートを保存しました。";}catch(e){$("#worksheetMessage").textContent=e.message;}});
$("#runWorksheet")?.addEventListener("click",()=>{try{const rows=auroraRunWorksheet(),host=$("#worksheetResults");host.replaceChildren();rows.forEach(r=>{const div=document.createElement("div");div.className="worksheet-result-row";const b=document.createElement("strong");b.textContent=r.label;const code=document.createElement("code");code.textContent=`${r.expr} = ${r.result}`;div.append(b,code);host.append(div);});}catch(e){$("#worksheetResults").textContent=e.message;}});
auroraRenderWorksheets();

// 逆算：f(x)=0を範囲内で走査し、符号変化区間は二分法で解く。
$("#solveInverse")?.addEventListener("click",()=>{const host=$("#inverseResults");try{const equation=$("#inverseEquation").value.trim(),rangeMin=Number($("#inverseMin").value),rangeMax=Number($("#inverseMax").value);if(!equation||!Number.isFinite(rangeMin)||!Number.isFinite(rangeMax)||rangeMax<=rangeMin)throw new Error("式と探索範囲を確認してください。");const sides=equation.split("=");if(sides.length>2)throw new Error("等号は1つまでです。");const lhs=sides[0],rhs=sides[1]||"0";const f=x=>evaluateExpression(auroraExpandVariables(`(${lhs})-(${rhs})`),{angleMode,ans:answerValue,x});const steps=2000,roots=[];let px=rangeMin,pf=f(px);for(let i=1;i<=steps;i++){const x=rangeMin+(rangeMax-rangeMin)*i/steps,fx=f(x);if(Math.abs(pf)<1e-9){if(!roots.some(r=>Math.abs(r-px)<1e-6))roots.push(px);}if(Number.isFinite(pf)&&Number.isFinite(fx)&&pf*fx<0){let lo=px,hi=x,fl=pf;for(let k=0;k<80;k++){const mid=(lo+hi)/2,fm=f(mid);if(Math.abs(fm)<1e-12){lo=hi=mid;break;}if(fl*fm<=0)hi=mid;else{lo=mid;fl=fm;}}const root=(lo+hi)/2;if(!roots.some(r=>Math.abs(r-root)<1e-6))roots.push(root);}px=x;pf=fx;}if(Math.abs(pf)<1e-9&&!roots.some(r=>Math.abs(r-px)<1e-6))roots.push(px);host.textContent=roots.length?`見つかった解（数値近似）\n${roots.sort((a,b)=>a-b).map((r,i)=>`x${i+1} ≈ ${formatNumber(r)}`).join("\n")}\n\n※指定範囲を走査して見つけた解です。接するだけの重解などを見落とす場合があります。` :"指定範囲で解を見つけられませんでした。範囲や式を確認してください。";}catch(e){host.textContent=e.message;}});

// 単位付き加減算。次元が異なる単位はエラーにする。
const AURORA_UNITS={
  mm:["長さ",.001,"m"],cm:["長さ",.01,"m"],m:["長さ",1,"m"],km:["長さ",1000,"m"],inch:["長さ",.0254,"m"],ft:["長さ",.3048,"m"],尺:["長さ",10/33,"m"],寸:["長さ",1/33,"m"],間:["長さ",60/33,"m"],町:["長さ",3600/33,"m"],里:["長さ",12960*10/33,"m"],
  mg:["質量",1e-6,"kg"],g:["質量",.001,"kg"],kg:["質量",1,"kg"],t:["質量",1000,"kg"],匁:["質量",.00375,"kg"],貫:["質量",3.75,"kg"],
  ms:["時間",.001,"s"],s:["時間",1,"s"],min:["時間",60,"s"],h:["時間",3600,"s"],day:["時間",86400,"s"],
  m2:["面積",1,"m²"],cm2:["面積",.0001,"m²"],km2:["面積",1e6,"m²"],坪:["面積",400/121,"m²"],畳:["面積",1.62,"m²"],
  ml:["体積",.001,"L"],l:["体積",1,"L"],合:["体積",.18039,"L"],升:["体積",1.8039,"L"],斗:["体積",18.039,"L"],石:["体積",180.39,"L"],
  pa:["圧力",1,"Pa"],kpa:["圧力",1000,"Pa"],mpa:["圧力",1e6,"Pa"],bar:["圧力",1e5,"Pa"],atm:["圧力",101325,"Pa"],
  j:["エネルギー",1,"J"],kj:["エネルギー",1000,"J"],wh:["エネルギー",3600,"J"],kwh:["エネルギー",3600000,"J"],
  w:["電力",1,"W"],kw:["電力",1000,"W"],v:["電圧",1,"V"],mv:["電圧",.001,"V"],a:["電流",1,"A"],ma:["電流",.001,"A"],ohm:["抵抗",1,"Ω"],"ω":["抵抗",1,"Ω"],
  "m/s":["速度",1,"m/s"],"km/h":["速度",1/3.6,"m/s"]
};
function auroraEvaluateUnitExpression(source){
  let s=String(source).trim().replace(/Ω/g,"ohm").replace(/²/g,"2").replace(/³/g,"3");let pos=0,total=0,category=null,baseUnit=null,terms=0;
  const keys=Object.keys(AURORA_UNITS).sort((a,b)=>b.length-a.length);while(pos<s.length){while(/\s/.test(s[pos]||""))pos++;let sign=1;if(s[pos]==="+"){pos++;}else if(s[pos]==="-"){sign=-1;pos++;}while(/\s/.test(s[pos]||""))pos++;const nm=s.slice(pos).match(/^\d+(?:\.\d+)?|^\.\d+/);if(!nm)throw new Error(`位置${pos+1}：数値が必要です。`);const n=Number(nm[0]);pos+=nm[0].length;while(/\s/.test(s[pos]||""))pos++;const u=keys.find(k=>s.slice(pos).toLowerCase().startsWith(k.toLowerCase()));if(!u)throw new Error(`位置${pos+1}：対応する単位が見つかりません。`);pos+=u.length;const info=AURORA_UNITS[u];if(category&&category!==info[0])throw new Error(`単位の種類が異なります（${category} と ${info[0]}）。`);category=info[0];baseUnit=info[2];total+=sign*n*info[1];terms++;while(/\s/.test(s[pos]||""))pos++;if(pos<s.length&&s[pos]!=="+"&&s[pos]!=="-")throw new Error(`位置${pos+1}：単位の後ろは + または − を使ってください。`);}
  if(!terms)throw new Error("例：5m + 30cm のように入力してください。");return {category,total,unit:baseUnit,terms};
}
$("#runUnitExpression")?.addEventListener("click",()=>{try{const r=auroraEvaluateUnitExpression($("#unitExpression").value);$("#unitExpressionResults").textContent=`単位カテゴリ：${r.category}\n合計：${formatNumber(r.total)} ${r.unit}\n対象単位数：${r.terms}\n\n※加減算に対応。温度の変換や複合単位の乗除算は既存の単位変換ツールを利用してください。`;}catch(e){$("#unitExpressionResults").textContent=e.message;}});

// 計算比較：各行を個別計算し、1行目との差を表示。
$("#compareCalculations")?.addEventListener("click",()=>{const host=$("#comparisonResults");try{const lines=$("#comparisonExpressions").value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);if(lines.length<2||lines.length>20)throw new Error("比較する式を2〜20個入力してください（1行に1式）。");const results=lines.map((expr)=>({expr,value:auroraEvaluate(expr)}));let first=null;try{first=AuroraDecimal.from(results[0].value);}catch{}host.replaceChildren();results.forEach((r,i)=>{const div=document.createElement("div");div.className="comparison-row";const title=document.createElement("strong");title.textContent=`${String.fromCharCode(65+i)}：${r.expr}`;const val=document.createElement("code");val.textContent=`結果：${r.value}`;div.append(title,val);if(i>0&&first){try{const diff=AuroraDecimal.sub(AuroraDecimal.from(r.value),first).toString();const span=document.createElement("span");span.textContent=`基準Aとの差：${diff}`;div.append(span);}catch{}}host.append(div);});}catch(e){host.textContent=e.message;}});

// 文字列の式のエラー診断。
$("#diagnoseExpression")?.addEventListener("click",()=>{const s=$("#diagnosticExpression").value.trim(),host=$("#diagnosticResults");try{if(!s)throw new Error("式を入力してください。");auroraEvaluate(s);host.textContent="構文チェックに成功しました。この式は計算できます。";}catch(e){const m=e.message||"エラー";let hint="括弧・演算子・関数名・数値の位置を確認してください。";if(/括弧|\)/.test(m))hint="開き括弧と閉じ括弧の数、括弧の位置を確認してください。";if(/0では割れません/.test(m))hint="分母が0になっていないか確認してください。";if(/変数/.test(m))hint="変数・定数の登録名を確認してください。変数タブから登録できます。";if(/使えない文字/.test(m))hint="全角記号や入力できない文字を、対応する演算子に置き換えてください。";host.textContent=`診断：${m}\n修正のヒント：${hint}`;}});

// 精度設定と漢数字入力ボタン。
const precisionInput=$("#decimalPrecision");if(precisionInput){precisionInput.value=String(auroraPrecision);precisionInput.addEventListener("change",()=>{auroraPrecision=Math.max(20,Math.min(500,Number(precisionInput.value)||100));precisionInput.value=String(auroraPrecision);saveValue(AURORA_EXT_KEYS.precision,auroraPrecision);});}
const numberDisplayInput=$("#numberDisplayMode");if(numberDisplayInput){if(!["all","group3","group4","arabicJapanese","kanji","daiji"].includes(auroraDisplayMode))auroraDisplayMode="all";numberDisplayInput.value=auroraDisplayMode;numberDisplayInput.addEventListener("change",()=>{auroraDisplayMode=numberDisplayInput.value;saveValue(AURORA_EXT_KEYS.display,auroraDisplayMode);const current=$("#mainResult")?.textContent;if(current)auroraRenderNumberFormats(current);});}
$("#insertKanjiNumber")?.addEventListener("click",()=>{try{const value=auroraParseKanjiNumber($("#kanjiNumberInput").value);$("#kanjiNumberResult").textContent=`数値：${value}\n日本語単位：${auroraJapaneseUnitString(value)}\n漢数字：${auroraJapaneseDecimalString(value)}\n大字：${auroraJapaneseDecimalString(value,true)}`;$("#expressionInput").value=value;document.querySelector('[data-tab="calculatorTab"]')?.click();}catch(e){$("#kanjiNumberResult").textContent=e.message;}});

// 既存バックアップ形式v2〜v4を維持し、拡張データを追加する。旧バックアップの復元では新データを消さない。
const auroraPreviousMakeBackupObject=makeBackupObject;
makeBackupObject=function(){const data=auroraPreviousMakeBackupObject();data.version=5;data.enhancedData={variables:auroraVariables,worksheets:auroraWorksheets,precision:auroraPrecision,displayMode:auroraDisplayMode,answerText:auroraAnswerText};return data;};
const auroraPreviousRestoreBackupObject=restoreBackupObject;
restoreBackupObject=function(data){const ok=auroraPreviousRestoreBackupObject(data);if(!ok)return false;if(data.enhancedData&&typeof data.enhancedData==="object"){
  const ext=data.enhancedData;if(ext.variables&&typeof ext.variables==="object"&&!Array.isArray(ext.variables))auroraVariables=ext.variables;
  if(Array.isArray(ext.worksheets))auroraWorksheets=ext.worksheets.filter(x=>x&&typeof x.title==="string"&&typeof x.content==="string").slice(0,100);
  if(Number.isFinite(Number(ext.precision)))auroraPrecision=Math.max(20,Math.min(500,Number(ext.precision)));
  if(["all","group3","group4","arabicJapanese","kanji","daiji"].includes(ext.displayMode))auroraDisplayMode=ext.displayMode;
  if(typeof ext.answerText==="string")auroraAnswerText=ext.answerText;
}else{
  // 旧バックアップには高精度Ansがないため、復元された従来Ansと同期する。変数・ワークシート等は維持。
  auroraAnswerText=String(answerValue);
}
  auroraSaveExtended();auroraRenderVariables();auroraRenderWorksheets();if(precisionInput)precisionInput.value=String(auroraPrecision);if(numberDisplayInput)numberDisplayInput.value=auroraDisplayMode;const currentResult=$("#mainResult")?.textContent;if(currentResult)auroraRenderNumberFormats(currentResult);
return true;};

// 「追加計算」タブの切替時は表示内容を更新。
document.querySelector('[data-tab="workbenchTab"]')?.addEventListener("click",()=>{auroraRenderVariables();auroraRenderWorksheets();auroraRenderConstants();});

// 分数・比率・順列・組み合わせ（巨大整数はBigIntで正確に処理）。
function auroraParseBigIntInput(selector,label){const raw=$(selector).value.trim().replace(/,/g,"");if(!/^[+-]?\d+$/.test(raw))throw new Error(`${label}は整数で入力してください。`);return BigInt(raw);}
function auroraGcd(a,b){a=a<0n?-a:a;b=b<0n?-b:b;while(b){const t=a%b;a=b;b=t;}return a||1n;}
function auroraFraction(n,d){if(d===0n)throw new Error("分母は0にできません。");if(d<0n){n=-n;d=-d;}const g=auroraGcd(n,d);n/=g;d/=g;if(n.toString().replace("-","").length+d.toString().length>5000)throw new Error("分数の桁数が大きすぎます（最大約5000桁）。");return {n,d};}
function auroraFractionText(f){const sign=f.n<0n?"-":"";const n=f.n<0n?-f.n:f.n;if(n===0n)return "0";const whole=n/f.d,rem=n%f.d;if(rem===0n)return sign+whole.toString();if(whole===0n)return `${sign}${rem}/${f.d}`;return `${sign}${whole} ${rem}/${f.d}`;}
$("#calculateFraction")?.addEventListener("click",()=>{try{const a=auroraFraction(auroraParseBigIntInput("#fractionANum","分数Aの分子"),auroraParseBigIntInput("#fractionADen","分数Aの分母"));const b=auroraFraction(auroraParseBigIntInput("#fractionBNum","分数Bの分子"),auroraParseBigIntInput("#fractionBDen","分数Bの分母"));const op=$("#fractionOperation").value;let out;if(op==="add")out=auroraFraction(a.n*b.d+b.n*a.d,a.d*b.d);else if(op==="subtract")out=auroraFraction(a.n*b.d-b.n*a.d,a.d*b.d);else if(op==="multiply")out=auroraFraction(a.n*b.n,a.d*b.d);else out=auroraFraction(a.n*b.d,a.d*b.n);const decimal=AuroraDecimal.div(AuroraDecimal.from(out.n.toString()),AuroraDecimal.from(out.d.toString()),auroraPrecision).toString();const text=`約分した分数：${auroraFractionText(out)}\n分子：${out.n}\n分母：${out.d}\n小数近似：${decimal}`;$("#fractionResults").textContent=text;addHistory(`分数計算：${auroraFractionText(a)} ${op} ${auroraFractionText(b)}`,text,"分数計算");}catch(e){$("#fractionResults").textContent=e.message;}});
$("#calculateRatio")?.addEventListener("click",()=>{try{const a=auroraParseBigIntInput("#ratioA","比A"),b=auroraParseBigIntInput("#ratioB","比B");if(a===0n||b===0n)throw new Error("比の値は0以外にしてください。");const g=auroraGcd(a,b),sa=a/g,sb=b/g,target=AuroraDecimal.from($("#ratioTargetFirst").value.trim());const scaled=AuroraDecimal.div(AuroraDecimal.mul(target,sb.toString()),sa.toString(),auroraPrecision);const text=`最簡比：${sa}:${sb}\nA = ${target.toString()} のとき\nB = ${scaled.toString()}\n倍率：${target.toString()} ÷ ${sa}`;$("#ratioResults").textContent=text;addHistory(`比率計算：${a}:${b}、A=${target}`,text,"比率計算");}catch(e){$("#ratioResults").textContent=e.message;}});
function auroraCombinatoric(n,r,mode){if(!Number.isInteger(n)||!Number.isInteger(r)||n<0||r<0||n>1500||r>1500)throw new Error("n・rは0〜1500の整数にしてください。");if(mode!=="factorial"&&r>n)throw new Error("rはn以下にしてください。");let result=1n;if(mode==="factorial"){for(let i=2;i<=n;i++)result*=BigInt(i);}else if(mode==="npr"){for(let i=0;i<r;i++)result*=BigInt(n-i);}else{const k=Math.min(r,n-r);for(let i=1;i<=k;i++){result=result*BigInt(n-k+i)/BigInt(i);}}const value=result.toString();if(value.length>5000)throw new Error("結果が5000桁を超えるため表示できません。");return value;}
$("#calculateCombinatorics")?.addEventListener("click",()=>{try{const n=Number($("#combN").value),r=Number($("#combR").value),mode=$("#combOperation").value;const result=auroraCombinatoric(n,r,mode);const symbol=mode==="ncr"?`${n}C${r}`:mode==="npr"?`${n}P${r}`:`${n}!`;$("#combinatoricsResults").textContent=`${symbol} = ${result}`;addHistory(symbol,result,"順列・組み合わせ");}catch(e){$("#combinatoricsResults").textContent=e.message;}});



/* =========================================================
   24. Aurora V7 数式・知識データベース拡張
   - 既存データは残したまま追加
   - ユーザーデータ・お気に入り・閲覧履歴は独立キーに保存
   ========================================================= */
const AURORA_DB_KEYS = {
  mathUser: "aurora-math-user-entries-v1",
  mathFav: "aurora-math-favorites-v1",
  mathHistory: "aurora-math-view-history-v1",
  numericUser: "aurora-numeric-user-entries-v1",
  numericFav: "aurora-numeric-favorites-v1",
  numericHistory: "aurora-numeric-view-history-v1"
};
let auroraMathUserEntries = readSaved(AURORA_DB_KEYS.mathUser, []);
let auroraMathFavorites = readSaved(AURORA_DB_KEYS.mathFav, []);
let auroraMathHistory = readSaved(AURORA_DB_KEYS.mathHistory, []);
let auroraNumericUserEntries = readSaved(AURORA_DB_KEYS.numericUser, []);
let auroraNumericFavorites = readSaved(AURORA_DB_KEYS.numericFav, []);
let auroraNumericHistory = readSaved(AURORA_DB_KEYS.numericHistory, []);
if (!Array.isArray(auroraMathUserEntries)) auroraMathUserEntries = [];
if (!Array.isArray(auroraMathFavorites)) auroraMathFavorites = [];
if (!Array.isArray(auroraMathHistory)) auroraMathHistory = [];
if (!Array.isArray(auroraNumericUserEntries)) auroraNumericUserEntries = [];
if (!Array.isArray(auroraNumericFavorites)) auroraNumericFavorites = [];
if (!Array.isArray(auroraNumericHistory)) auroraNumericHistory = [];
let auroraMathView = "all";
let auroraNumericView = "all";
let editingMathEntryId = null;
let editingNumericEntryId = null;

const EXTRA_MATH_ITEMS = [
 {c:"代数",t:"一次関数",f:"y = a*x + b",calc:"a*x+b",d:"傾きa、切片bの直線。aは変化の割合、bはy切片。",e:"y=2x+3ならx=4のときy=11。",k:"直線,傾き,切片",vars:"x y a b",pattern:"a*x+b",inverse:{x:"x=(y-b)/a",a:"a=(y-b)/x",b:"b=y-a*x",y:"y=a*x+b"}},
 {c:"代数",t:"比例",f:"y = a*x",calc:"a*x",d:"比例定数aを用いて表す。原点を通る直線。",e:"a=3,x=5ならy=15。",k:"比例,比例定数",vars:"x y a",pattern:"a*x",inverse:{x:"x=y/a",a:"a=y/x",y:"y=a*x"}},
 {c:"代数",t:"反比例",f:"y = a/x",calc:"a/x",d:"xとyの積が一定になる関係。x≠0。",e:"a=12,x=3ならy=4。",k:"反比例",vars:"x y a",pattern:"a/x",inverse:{x:"x=a/y",a:"a=x*y",y:"y=a/x"}},
 {c:"代数",t:"二次関数の頂点形式",f:"y = a*(x-p)^2 + q",calc:"a*(x-p)^2+q",d:"頂点(p,q)、軸x=pの放物線。aの符号で開く向きが変わる。",e:"y=2(x-1)^2+3の頂点は(1,3)。",k:"放物線,頂点,二次関数",vars:"x y a p q",pattern:"a*(x-p)^2+q",inverse:{y:"y=a*(x-p)^2+q"}},
 {c:"代数",t:"判別式",f:"D = b^2 - 4*a*c",calc:"b^2-4*a*c",d:"二次方程式ax²+bx+c=0の解の種類を判定する。D>0は異なる2実根、D=0は重解、D<0は実根なし。",e:"x²-5x+6=0ではD=1。",k:"判別式,解の個数",vars:"a b c D",pattern:"b^2-4*a*c"},
 {c:"解析",t:"指数関数の積分",f:"∫e^x dx = e^x + C",d:"自然指数関数の原始関数。",e:"∫2e^(2x)dx=e^(2x)+C。",k:"積分,指数関数"},
 {c:"解析",t:"sinの微分",f:"d/dx sin(x) = cos(x)",d:"角度はラジアンで扱う微分公式。",e:"d/dx sin(3x)=3cos(3x)。",k:"三角関数,微分"},
 {c:"解析",t:"cosの微分",f:"d/dx cos(x) = -sin(x)",d:"角度はラジアンで扱う微分公式。",e:"d/dx cos(2x)=-2sin(2x)。",k:"三角関数,微分"},
 {c:"解析",t:"テイラー級数（指数関数）",f:"e^x = Σ(x^n/n!)",d:"x=0を中心とするマクローリン級数。全ての実数xで収束する。",e:"e^x≈1+x+x²/2+x³/6。",k:"テイラー,マクローリン,級数"},
 {c:"幾何",t:"三角形の面積（2辺とその間の角）",f:"S = (1/2)*a*b*sin(C)",calc:"0.5*a*b*sin(C)",d:"辺a,bとその間の角Cから面積を求める。",e:"a=3,b=4,C=90°ならS=6。",k:"三角形,面積",vars:"S a b C",pattern:"a*b*sin(C)"},
 {c:"幾何",t:"円すいの体積",f:"V = (1/3)*pi*r^2*h",d:"底面半径r、高さhの円すいの体積。",e:"r=3,h=4ならV=12π。",k:"円錐,体積"},
 {c:"幾何",t:"球の表面積",f:"S = 4*pi*r^2",d:"半径rの球の表面積。",e:"r=2なら16π。",k:"球,表面積"},
 {c:"三角関数",t:"正弦の加法定理",f:"sin(A+B)=sin(A)cos(B)+cos(A)sin(B)",d:"角の和の正弦を各角の正弦・余弦で表す。",e:"sin(45°+30°)の展開に使える。",k:"加法定理"},
 {c:"三角関数",t:"余弦の加法定理",f:"cos(A+B)=cos(A)cos(B)-sin(A)sin(B)",d:"角の和の余弦を各角の正弦・余弦で表す。",e:"cos(α+β)の展開に使える。",k:"加法定理"},
 {c:"確率・統計",t:"期待値（離散型）",f:"E(X)=Σx*P(X=x)",d:"各値とその確率の積を合計した平均的な値。",e:"1が1/2、3が1/2なら期待値は2。",k:"期待値,確率"},
 {c:"確率・統計",t:"標本標準偏差",f:"s = sqrt(Σ(x_i-x̄)^2/(n-1))",d:"標本から母集団の分散を推定するときの標準的な不偏分散ベースの標準偏差。定義の流儀に注意。",e:"標本分散が4なら標本標準偏差は2。",k:"標本,標準偏差"},
 {c:"数論",t:"オイラーのφ関数（素数）",f:"φ(p)=p-1（pは素数）",d:"pと互いに素な1からpまでの整数の個数。",e:"φ(7)=6。",k:"オイラー,トーシェント"},
 {c:"数論",t:"フェルマーの小定理",f:"a^(p-1) ≡ 1 (mod p)",d:"pが素数、pがaを割り切らない場合に成り立つ合同式。",e:"2^6≡1 (mod 7)。",k:"合同式,素数,フェルマー"},
 {c:"物理",t:"密度",f:"ρ = m/V",calc:"m/V",d:"質量mを体積Vで割った量。SI単位はkg/m³。",e:"2kg、0.5m³なら4kg/m³。",k:"密度,質量,体積",vars:"rho m V",pattern:"m/V",inverse:{m:"m=rho*V",V:"V=m/rho"}},
 {c:"物理",t:"圧力",f:"p = F/A",calc:"F/A",d:"面に垂直な力Fを面積Aで割った量。SI単位はPa。",e:"100Nを0.5m²に加えると200Pa。",k:"圧力,面積,力",vars:"p F A",pattern:"F/A",inverse:{F:"F=p*A",A:"A=F/p"}},
 {c:"物理",t:"速度と距離",f:"v = s/t",calc:"s/t",d:"一定速度で移動した距離sと時間tの関係。",e:"100mを20sなら5m/s。",k:"速度,距離,時間",vars:"v s t",pattern:"s/t",inverse:{s:"s=v*t",t:"t=s/v"}},
 {c:"物理",t:"電気抵抗と電力",f:"P = I^2*R",calc:"I^2*R",d:"抵抗Rに電流Iを流したときの消費電力。",e:"I=2A,R=5Ωなら20W。",k:"電力,抵抗,電流",vars:"P I R",pattern:"I^2*R",inverse:{I:"I=sqrt(P/R)",R:"R=P/I^2"}},
 {c:"化学",t:"理想気体の状態方程式",f:"P*V = n*R*T",d:"理想気体の圧力P、体積V、物質量n、気体定数R、絶対温度Tの関係。",e:"単位をそろえて未知量を求める。",k:"気体,状態方程式"},
 {c:"化学",t:"質量パーセント濃度",f:"w% = (溶質の質量/溶液の質量)*100",d:"溶液全体の質量に対する溶質質量の割合。",e:"溶質5g、溶液100gなら5%。",k:"濃度,質量パーセント"},
 {c:"工学",t:"効率",f:"η = (有効出力/入力)*100%",d:"入力に対する有効な出力の割合。損失があるため通常100%以下。",e:"入力100W、有効出力80Wなら80%。",k:"効率,エネルギー"},
 {c:"工学",t:"ばねのフックの法則",f:"F = k*x",d:"弾性限界内でのばねの復元力の大きさ。向きを含めるとF=-kx。",e:"k=100N/m、伸び0.02mなら大きさ2N。",k:"ばね,弾性"},
 {c:"和算",t:"鶴亀算",f:"x+y=N; 2*x+4*y=L",d:"二種類の生き物の頭数と脚数などから個数を求める代表的な和算問題。",e:"鶴x匹・亀y匹、合計頭数N、脚数Lなら連立方程式で解く。",k:"和算,鶴亀算,連立方程式"},
 {c:"日本の伝統単位",t:"尺・寸・分",f:"1尺 = 10/33 m ≈ 0.30303 m",d:"尺貫法の長さの換算例。地域・時代・制度上の定義を確認すること。",e:"1尺は約30.303cm、1寸は約3.0303cm。",k:"尺貫法,長さ,寸,分"},
 {c:"漢数字・大数単位",t:"万・億・兆・京",f:"1万=10^4; 1億=10^8; 1兆=10^12; 1京=10^16",d:"日本語で使う大数の位。4桁ごとに単位が変わる。",e:"123456789=1億2345万6789。",k:"大数,漢数字,位取り"},
 {c:"数の読み方",t:"整数の読み方（4桁区切り）",f:"123456789 → 1億2345万6789",d:"一、十、百、千を各まとまりで読み、万・億・兆などを付ける。",e:"100020003=一億二万三。",k:"読み方,位取り,日本語"},
 {c:"暦・時間",t:"グレゴリオ暦の閏年",f:"4で割り切れ、100で割り切れない年、または400で割り切れる年",d:"閏年は2月が29日。通常年は365日、閏年は366日。",e:"2000年は閏年、1900年は平年。",k:"暦,閏年,時間"},
 {c:"天文学",t:"円軌道の速さ",f:"v = 2*pi*r/T",d:"半径rの円軌道を周期Tで1周する場合の平均速さ。",e:"rとTをSI単位でそろえる。",k:"天体,軌道,周期"},
 {c:"逆引き公式",t:"距離・速さ・時間の逆引き",f:"s=v*t; v=s/t; t=s/v",d:"距離s、速さv、時間tのうち2つから残りを求める。",e:"v=60km/h、t=2hならs=120km。",k:"逆引き,速さ,距離,時間",vars:"s v t",inverse:{s:"s=v*t",v:"v=s/t",t:"t=s/v"}},
 {c:"公式パターン",t:"一次式パターン",f:"y = a*x + b",d:"変数に一次、定数項を加える形。比例・切片付き直線の共通パターン。",e:"y=3x+2、P=2V+1など。",k:"パターン,一次式",pattern:"a*x+b"},
 {c:"公式パターン",t:"二乗和パターン",f:"z = sqrt(x^2 + y^2)",d:"2つの直交成分から合成量を求める形。",e:"3と4の合成長さは5。",k:"パターン,平方根,二乗和",pattern:"sqrt(x^2+y^2)"},
 {c:"用語集",t:"極限",f:"lim(x→a) f(x) = L",d:"xをaに近づけたとき、f(x)が近づく値L。関数値f(a)と一致するとは限らない。",e:"lim(x→0) sin(x)/x=1（ラジアン）。",k:"数学用語,解析"},
 {c:"用語集",t:"ベクトル",f:"v = (v1,v2,...,vn)",d:"大きさと向きを持つ量として扱う。位置・速度・力などに使う。",e:"平面ベクトル(3,4)の大きさは5。",k:"数学用語,線形代数"},
 {c:"単位・物理量",t:"ニュートン",f:"1 N = 1 kg*m/s^2",d:"力のSI組立単位。",e:"2kgに3m/s²の加速度なら6N。",k:"単位,力,SI"},
 {c:"単位・物理量",t:"パスカル",f:"1 Pa = 1 N/m^2",d:"圧力・応力のSI組立単位。",e:"200Paは1m²あたり200N。",k:"単位,圧力,SI"},
 {c:"例題",t:"例題：円の半径から面積",f:"S = pi*r^2",d:"半径を2倍にすると面積は4倍になる。",e:"半径5cmなら面積25πcm²（約78.54cm²）。",k:"例題,円,面積"},
 {c:"例題",t:"例題：相対誤差",f:"相対誤差 = |測定値-真値|/|真値|",d:"真値に対する誤差の割合。百分率にするには100を掛ける。",e:"真値10、測定値9.8なら2%。",k:"例題,誤差,統計"},
 {c:"数学史",t:"ピタゴラスの定理の歴史",f:"a^2+b^2=c^2",d:"古代バビロニアなどにも関係する数値例が知られ、ギリシャのピタゴラス学派に結び付けられて伝承された。発見者を一人に断定しない。",e:"3-4-5の整数比は代表的な例。",k:"数学史,古代,定理"},
 {c:"数学史",t:"アル＝フワーリズミーと代数学",f:"al-jabr → algebra",d:"9世紀の数学史において、代数学の発展と名称の由来に深く関係する。",e:"一次・二次方程式の体系的な解法の歴史を調べる入口。",k:"数学史,代数学,歴史"}
];
MATH_DATABASE.push(...EXTRA_MATH_ITEMS);

const V9_MATH_ITEMS = [
 {c:"幾何",t:"ヘロンの公式",f:"S = sqrt(s*(s-a)*(s-b)*(s-c))",calc:"sqrt(s*(s-a)*(s-b)*(s-c))",d:"三角形の3辺a,b,cから面積Sを求める。s=(a+b+c)/2は半周長。三角不等式を満たす必要がある。",e:"a=3,b=4,c=5ならs=6、面積は6。",k:"三角形,面積,3辺,半周長",vars:"S s a b c"},
 {c:"幾何",t:"円すいの体積",f:"V = pi*r^2*h/3",calc:"pi*r^2*h/3",d:"底面半径r、高さhの円すいの体積。",e:"r=3,h=4なら12π。",k:"円錐,体積,立体",vars:"V r h"},
 {c:"幾何",t:"円すいの側面積",f:"A = pi*r*l",calc:"pi*r*l",d:"底面半径r、母線長lの円すいの側面積。全表面積はπr²+πrl。",e:"r=3,l=5なら側面積15π。",k:"円錐,側面積,表面積",vars:"A r l"},
 {c:"幾何",t:"球の表面積",f:"A = 4*pi*r^2",calc:"4*pi*r^2",d:"半径rの球の表面積。",e:"r=2なら16π。",k:"球,表面積",vars:"A r"},
 {c:"幾何",t:"直方体の体積",f:"V = a*b*c",calc:"a*b*c",d:"縦a、横b、高さcの直方体の体積。",e:"2×3×4=24。",k:"直方体,体積",vars:"V a b c"},
 {c:"幾何",t:"多角形の内角の和",f:"S = (n-2)*180",calc:"(n-2)*180",d:"n角形（n≥3）の内角の和。単位は度。",e:"六角形は(6−2)×180=720°。",k:"多角形,内角,角度",vars:"S n"},
 {c:"幾何",t:"正多角形の外角",f:"外角 = 360/n",calc:"360/n",d:"正n角形の1つの外角。",e:"正六角形の外角は60°。",k:"正多角形,外角",vars:"n"},
 {c:"幾何",t:"2点間の距離（平面）",f:"d = sqrt((x2-x1)^2+(y2-y1)^2)",calc:"sqrt((x2-x1)^2+(y2-y1)^2)",d:"座標(x1,y1)と(x2,y2)のユークリッド距離。",e:"(0,0)と(3,4)の距離は5。",k:"座標,距離,ユークリッド",vars:"d x1 y1 x2 y2"},
 {c:"幾何",t:"中点の座標",f:"M = ((x1+x2)/2,(y1+y2)/2)",d:"線分の両端の座標の平均。x座標・y座標それぞれの中点を求める。",e:"(2,4)と(6,8)の中点は(4,6)。",k:"中点,座標,線分"},
 {c:"三角関数",t:"正弦の加法定理",f:"sin(a+b)=sin(a)*cos(b)+cos(a)*sin(b)",d:"角aと角bの和の正弦を、それぞれの正弦・余弦で表す恒等式。角度単位をそろえる。",e:"sin(30°+30°)=sin60°。",k:"加法定理,正弦,恒等式"},
 {c:"三角関数",t:"余弦の加法定理",f:"cos(a+b)=cos(a)*cos(b)-sin(a)*sin(b)",d:"角aと角bの和の余弦を表す恒等式。",e:"cos(45°+45°)=cos90°=0。",k:"加法定理,余弦,恒等式"},
 {c:"三角関数",t:"正弦の倍角公式",f:"sin(2*x)=2*sin(x)*cos(x)",d:"角の2倍の正弦を、元の角の正弦と余弦で表す。",e:"x=30°ならsin60°=2×sin30°×cos30°。",k:"倍角,正弦"},
 {c:"三角関数",t:"余弦の倍角公式",f:"cos(2*x)=cos(x)^2-sin(x)^2",d:"cos(2x)=2cos²x−1=1−2sin²xとも表せる。",e:"x=60°ならcos120°=-1/2。",k:"倍角,余弦"},
 {c:"解析",t:"微分の商の法則",f:"(u/v)'=(u'*v-u*v')/v^2",d:"v≠0の範囲で、2つの関数の商を微分する公式。",e:"(x/ (x+1))' = 1/(x+1)^2。",k:"微分,商の法則"},
 {c:"解析",t:"指数関数の一般底の微分",f:"d/dx a^x = a^x*ln(a)",d:"a>0のとき成り立つ。特にa=eなら微分してもe^x。",e:"d/dx 2^x = 2^x ln2。",k:"指数関数,微分"},
 {c:"解析",t:"置換積分",f:"∫f(g(x))*g'(x) dx = ∫f(u) du",d:"u=g(x)と置くことで積分を簡単にする方法。置換後の積分範囲にも注意する。",e:"∫2x*cos(x²)dx = sin(x²)+C。",k:"置換積分,積分法"},
 {c:"解析",t:"部分積分",f:"∫u*dv = u*v - ∫v*du",d:"積の微分法則を逆向きに使う積分公式。定積分では端点のuvも評価する。",e:"∫x*e^x dx = x*e^x-e^x+C。",k:"部分積分,積分法"},
 {c:"解析",t:"テイラー級数（一般形）",f:"f(x)=Σ(f^(n)(a)/n!)*(x-a)^n",d:"十分な滑らかさ等の条件のもと、関数を中心aのまわりの級数で表す。収束条件を確認する。",e:"e^xはa=0で1+x+x²/2!+...。",k:"テイラー,マクローリン,級数"},
 {c:"数列・級数",t:"等差数列の一般項",f:"a_n = a_1+(n-1)*d",calc:"a1+(n-1)*d",d:"初項a1、公差dの等差数列の第n項。",e:"a1=3,d=2なら第10項は21。",k:"数列,等差,一般項",vars:"a_n a1 n d"},
 {c:"数列・級数",t:"等比数列の一般項",f:"a_n = a_1*r^(n-1)",calc:"a1*r^(n-1)",d:"初項a1、公比rの等比数列の第n項。",e:"a1=2,r=3なら第4項は54。",k:"数列,等比,一般項",vars:"a_n a1 r n"},
 {c:"数列・級数",t:"等比数列の有限和",f:"S_n=a_1*(1-r^n)/(1-r) (r≠1)",d:"初項a1、公比r、項数nの等比数列の和。r=1ならS_n=n*a1。",e:"1+2+4+8+16=31。",k:"数列,等比,和"},
 {c:"数列・級数",t:"無限等比級数",f:"S=a_1/(1-r) (|r|<1)",d:"公比の絶対値が1未満のとき、無限等比級数は収束する。",e:"1+1/2+1/4+...=2。",k:"無限級数,収束,等比"},
 {c:"数列・級数",t:"フィボナッチ数列",f:"F_0=0, F_1=1, F_n=F_(n-1)+F_(n-2)",d:"直前2項の和を次の項とする漸化式で定義される数列。",e:"0,1,1,2,3,5,8,13,...。",k:"フィボナッチ,漸化式"},
 {c:"数列・級数",t:"自然数の平方和",f:"Σ(k^2), k=1..n = n*(n+1)*(2*n+1)/6",calc:"n*(n+1)*(2*n+1)/6",d:"1²+2²+...+n²の公式。",e:"n=3なら1+4+9=14。",k:"平方和,数列"},
 {c:"数列・級数",t:"自然数の立方和",f:"Σ(k^3), k=1..n = (n*(n+1)/2)^2",calc:"(n*(n+1)/2)^2",d:"1³+2³+...+n³は、1からnまでの和の平方に等しい。",e:"n=3なら1+8+27=36。",k:"立方和,数列"},
 {c:"数論",t:"ユークリッドの互除法",f:"gcd(a,b)=gcd(b,a mod b)",d:"余りを使って最大公約数を求める反復法。余りが0になったときの除数が最大公約数。",e:"gcd(48,18)=6。",k:"最大公約数,互除法"},
 {c:"数論",t:"合同式の加法・乗法",f:"a≡b (mod m) ⇒ a+c≡b+c (mod m)",d:"同じ法mで合同な整数に同じ数を足しても合同性が保たれる。積についても同様。",e:"17≡2 (mod 5)。",k:"合同式,整数論"},
 {c:"数論",t:"フェルマーの最終定理",f:"x^n+y^n=z^n は n>2 に正整数解なし",d:"nが2より大きい整数の場合、正整数x,y,zでこの等式を満たすものは存在しない。",e:"n=2の三平方の定理とは異なる。",k:"フェルマー,整数論,定理"},
 {c:"確率・統計",t:"ベイズの定理",f:"P(A|B)=P(B|A)*P(A)/P(B)",d:"P(B)>0のとき、条件付き確率を逆向きに更新する公式。",e:"事前確率と尤度から事後確率を求める。",k:"ベイズ,条件付き確率"},
 {c:"確率・統計",t:"相関係数",f:"r = covariance(X,Y)/(σX*σY)",d:"2変数の線形関係の方向と強さを表す指標。−1〜1。相関は因果関係を意味しない。",e:"rが1に近いと強い正の線形相関。",k:"相関,統計"},
 {c:"確率・統計",t:"ポアソン分布",f:"P(X=k)=exp(-λ)*λ^k/k!",d:"一定区間の発生回数を表す離散分布。λ>0、kは0以上の整数。",e:"平均発生回数λ=2のときP(X=0)=e^-2。",k:"ポアソン,確率分布"},
 {c:"線形代数",t:"ベクトルの内積",f:"a・b=Σ(a_i*b_i)",d:"対応する成分同士を掛けて足す。角度θとの関係はa・b=|a||b|cosθ。",e:"(1,2)・(3,4)=11。",k:"ベクトル,内積"},
 {c:"線形代数",t:"ベクトルの大きさ",f:"|v|=sqrt(Σ(v_i^2))",d:"ユークリッドノルム。各成分の2乗和の平方根。",e:"(3,4)の大きさは5。",k:"ベクトル,ノルム"},
 {c:"線形代数",t:"2×2行列の行列式",f:"det(A)=a*d-b*c",d:"A=[[a,b],[c,d]]の行列式。値が0でなければ逆行列が存在する。",e:"[[1,2],[3,4]]の行列式は−2。",k:"行列式,線形代数"},
 {c:"線形代数",t:"2×2行列の逆行列",f:"A^-1=(1/(a*d-b*c))*[[d,-b],[-c,a]]",d:"行列式ad−bcが0でない場合に限り存在する。",e:"A=[[1,2],[3,4]]ならdet=-2。",k:"逆行列,行列"},
 {c:"線形代数",t:"2次元ベクトルの外積（z成分）",f:"a×b = a_x*b_y-a_y*b_x",d:"2次元ベクトルを平面内で見たときの符号付き面積に対応するz成分。",e:"(1,0)×(0,1)=1。",k:"外積,面積,ベクトル"},
 {c:"離散数学",t:"二項定理",f:"(a+b)^n=Σ(nCk)*a^(n-k)*b^k",d:"nは0以上の整数。二項式の展開係数は二項係数で表される。",e:"(a+b)^2=a²+2ab+b²。",k:"二項定理,展開"},
 {c:"離散数学",t:"包除原理（2集合）",f:"|A∪B|=|A|+|B|-|A∩B|",d:"2つの集合の和集合の要素数を重複分だけ引いて求める。",e:"|A|=10,|B|=8,|A∩B|=3なら15。",k:"集合,包除原理"},
 {c:"集合・論理",t:"ド・モルガンの法則（集合）",f:"(A∪B)^c=A^c∩B^c",d:"和集合の補集合は、それぞれの補集合の共通部分に等しい。",e:"積集合に関する双対式も成り立つ。",k:"集合,補集合,ドモルガン"},
 {c:"集合・論理",t:"ド・モルガンの法則（論理）",f:"¬(P∧Q)=(¬P)∨(¬Q)",d:"「PかつQではない」は「Pではない、またはQではない」と同値。",e:"¬(P∨Q)=(¬P)∧(¬Q)も成り立つ。",k:"論理,命題,ドモルガン"},
 {c:"微分方程式",t:"指数増減の微分方程式",f:"dy/dt=k*y ⇒ y=C*exp(k*t)",d:"変化率が現在量に比例する微分方程式の一般解。初期条件でCを定める。",e:"k<0なら指数減衰、k>0なら指数成長。",k:"微分方程式,指数関数"},
 {c:"微分方程式",t:"単振動の微分方程式",f:"x''+ω^2*x=0",d:"角振動数ωの理想的な単振動を表す線形微分方程式。",e:"一般解はA cos(ωt)+B sin(ωt)。",k:"単振動,微分方程式"},
 {c:"数学定数",t:"オイラーの公式",f:"exp(i*x)=cos(x)+i*sin(x)",d:"実数xについて、複素指数関数と三角関数を結ぶ公式。x=πでオイラーの等式につながる。",e:"exp(iπ)+1=0。",k:"オイラー,複素数,数学定数"}
];
MATH_DATABASE.push(...V9_MATH_ITEMS);

function getMathDatabaseAll(){return [...MATH_DATABASE,...auroraMathUserEntries];}
function getAuroraDatabaseBackup(){return {auroraDatabase:{version:1,mathUserEntries:auroraMathUserEntries,mathFavorites:auroraMathFavorites,mathHistory:auroraMathHistory,numericUserEntries:auroraNumericUserEntries,numericFavorites:auroraNumericFavorites,numericHistory:auroraNumericHistory}};}
function applyAuroraDatabaseBackup(payload){
  if(!payload||typeof payload!=="object")return;
  const safeArray=(v,max)=>Array.isArray(v)?v.slice(0,max):null;
  const mu=safeArray(payload.mathUserEntries,2000),mf=safeArray(payload.mathFavorites,5000),mh=safeArray(payload.mathHistory,200);
  const nu=safeArray(payload.numericUserEntries,10000),nf=safeArray(payload.numericFavorites,10000),nh=safeArray(payload.numericHistory,200);
  if(mu){auroraMathUserEntries=mu.filter(x=>x&&typeof x.id==="string"&&typeof x.t==="string");saveValue(AURORA_DB_KEYS.mathUser,auroraMathUserEntries);}
  if(mf){auroraMathFavorites=mf.filter(x=>typeof x==="string");saveValue(AURORA_DB_KEYS.mathFav,auroraMathFavorites);}
  if(mh){auroraMathHistory=mh.filter(x=>typeof x==="string");saveValue(AURORA_DB_KEYS.mathHistory,auroraMathHistory);}
  if(nu){auroraNumericUserEntries=nu.filter(validNumericRecord);saveValue(AURORA_DB_KEYS.numericUser,auroraNumericUserEntries);}
  if(nf){auroraNumericFavorites=nf.filter(x=>typeof x==="string");saveValue(AURORA_DB_KEYS.numericFav,auroraNumericFavorites);}
  if(nh){auroraNumericHistory=nh.filter(x=>typeof x==="string");saveValue(AURORA_DB_KEYS.numericHistory,auroraNumericHistory);}
  if(typeof renderDatabase==="function")renderDatabase();if(typeof renderNumericDatabase==="function")renderNumericDatabase();
}
function appendUnique(list,id,max=100){return [id,...list.filter(x=>x!==id)].slice(0,max);}
function escapeText(s){return String(s??"");}
function addText(parent,tag,cls,value){const el=document.createElement(tag);if(cls)el.className=cls;el.textContent=escapeText(value);parent.append(el);return el;}
function safeSourceLink(url){try{const u=new URL(url);return (u.protocol==="https:"||u.protocol==="http:")?u.href:"";}catch(_){return "";}}

function renderDatabase(){
  const q=( $("#databaseSearch")?.value||"").trim().toLowerCase();
  const cat=$("#databaseCategory")?.value||"all";
  const pat=( $("#databasePattern")?.value||"").trim().toLowerCase();
  const inv=( $("#databaseInverse")?.value||"").trim().toLowerCase();
  const items=getMathDatabaseAll();
  let list=items.filter(d=>{
    const text=[d.t,d.f,d.d,d.e,d.c,d.k,d.vars,d.pattern,...Object.values(d.inverse||{})].join(" ").toLowerCase();
    return (cat==="all"||d.c===cat)&&(!q||text.includes(q))&&(!pat||String(d.pattern||d.f||"").toLowerCase().includes(pat))&&(!inv||((d.vars||"").toLowerCase().split(/[ ,]+/).includes(inv))||Object.prototype.hasOwnProperty.call(d.inverse||{},inv));
  });
  if(auroraMathView==="favorites")list=list.filter(d=>auroraMathFavorites.includes(d.id||`builtin:${d.t}`));
  if(auroraMathView==="history")list=list.filter(d=>auroraMathHistory.includes(d.id||`builtin:${d.t}`));
  const host=$("#databaseEntries");if(!host)return;host.replaceChildren();
  $("#databaseCount").textContent=`${list.length}件を表示（標準 ${MATH_DATABASE.length}件／自作 ${auroraMathUserEntries.length}件）`;
  if(!list.length){addText(host,"div","numeric-empty","一致する項目がありません。検索語や分野を変えてみてね。");return;}
  list.forEach(d=>{
    const id=d.id||`builtin:${d.t}`;const card=document.createElement("article");card.className=`database-entry${d.id?" user-entry":""}`;
    addText(card,"span","database-category",d.c);const titleEl=addText(card,"h3","",d.t);titleEl.tabIndex=0;titleEl.title="クリックすると閲覧履歴に追加";titleEl.addEventListener("click",()=>{auroraMathHistory=appendUnique(auroraMathHistory,id,100);saveValue(AURORA_DB_KEYS.mathHistory,auroraMathHistory);});titleEl.addEventListener("keydown",ev=>{if(ev.key==="Enter"||ev.key===" "){ev.preventDefault();titleEl.click();}});addText(card,"code","database-formula",d.displayFormula||d.f);
    addText(card,"p","",d.d||"");if(d.e)addText(card,"p","help-text",`例：${d.e}`);
    if(inv&&d.inverse&&d.inverse[inv])addText(card,"p","database-reverse",`逆引き：${inv} = ${d.inverse[inv]}`);
    if(d.condition)addText(card,"p","database-meta",`条件：${d.condition}`);
    if(d.vars)addText(card,"p","database-meta",`変数：${d.vars}`);
    const actions=document.createElement("div");actions.className="database-actions";
    const fav=document.createElement("button");fav.type="button";fav.className="secondary-button";fav.textContent=auroraMathFavorites.includes(id)?"★ お気に入り解除":"☆ お気に入り";fav.addEventListener("click",()=>{auroraMathFavorites=auroraMathFavorites.includes(id)?auroraMathFavorites.filter(x=>x!==id):appendUnique(auroraMathFavorites,id,5000);saveValue(AURORA_DB_KEYS.mathFav,auroraMathFavorites);renderDatabase();});actions.append(fav);
    const calc=d.calc||(d.f&&d.f.includes(" = ")?d.f.split(" = ").slice(1).join(" = "):"");
    if(calc){const send=document.createElement("button");send.type="button";send.className="secondary-button";send.textContent="式を電卓へ";send.addEventListener("click",()=>{$("#expressionInput").value=calc;document.querySelector('[data-tab="calculatorTab"]')?.click();focusWithoutScroll($("#expressionInput"));});actions.append(send);}
    if(d.id){const edit=document.createElement("button");edit.type="button";edit.className="secondary-button";edit.textContent="編集";edit.addEventListener("click",()=>loadMathEntryForEdit(d));actions.append(edit);const del=document.createElement("button");del.type="button";del.className="secondary-button";del.textContent="削除";del.addEventListener("click",()=>{if(!confirm(`「${d.t}」を削除しますか？`))return;auroraMathUserEntries=auroraMathUserEntries.filter(x=>x.id!==d.id);auroraMathFavorites=auroraMathFavorites.filter(x=>x!==d.id);saveValue(AURORA_DB_KEYS.mathUser,auroraMathUserEntries);saveValue(AURORA_DB_KEYS.mathFav,auroraMathFavorites);renderDatabase();});actions.append(del);}
    card.append(actions);host.append(card);
  });
}
["#databaseSearch","#databaseCategory","#databasePattern","#databaseInverse"].forEach(sel=>$(sel)?.addEventListener(sel==="#databaseCategory"?"change":"input",renderDatabase));
$("#databaseShowAll")?.addEventListener("click",()=>{auroraMathView="all";renderDatabase();});
$("#databaseShowFavorites")?.addEventListener("click",()=>{auroraMathView="favorites";renderDatabase();});
$("#databaseShowHistory")?.addEventListener("click",()=>{auroraMathView="history";renderDatabase();});
function clearMathEntryForm(){editingMathEntryId=null;["mathEntryTitle","mathEntryFormula","mathEntryCalc","mathEntryDescription","mathEntryKeywords"].forEach(id=>$("#"+id).value="");$("#saveMathEntry").textContent="公式を保存";$("#cancelMathEntryEdit").hidden=true;}
function loadMathEntryForEdit(d){editingMathEntryId=d.id;$("#mathEntryTitle").value=d.t||"";$("#mathEntryCategory").value=d.c||"代数";$("#mathEntryFormula").value=d.displayFormula||d.f||"";$("#mathEntryCalc").value=d.calc||"";$("#mathEntryDescription").value=d.d||"";$("#mathEntryKeywords").value=d.k||"";$("#saveMathEntry").textContent="変更を保存";$("#cancelMathEntryEdit").hidden=false;$("#mathEntryTitle").focus();}
$("#saveMathEntry")?.addEventListener("click",()=>{const t=$("#mathEntryTitle").value.trim(),f=$("#mathEntryFormula").value.trim(),c=$("#mathEntryCalc").value.trim(),d=$("#mathEntryDescription").value.trim(),k=$("#mathEntryKeywords").value.trim(),cat=$("#mathEntryCategory").value;if(!t||!f){$("#mathEntryMessage").textContent="タイトルと公式・内容は必須です。";return;}const item={id:editingMathEntryId||`math-user-${Date.now()}`,c,t,f,displayFormula:f,calc:c,d,e:"",k,updatedAt:new Date().toISOString()};if(editingMathEntryId)auroraMathUserEntries=auroraMathUserEntries.map(x=>x.id===editingMathEntryId?item:x);else auroraMathUserEntries.push(item);saveValue(AURORA_DB_KEYS.mathUser,auroraMathUserEntries);clearMathEntryForm();$("#mathEntryMessage").textContent="保存しました。";renderDatabase();});
$("#cancelMathEntryEdit")?.addEventListener("click",clearMathEntryForm);
$("#exportMathDatabase")?.addEventListener("click",()=>{const data={format:"aurora-math-database",version:1,exportedAt:new Date().toISOString(),userEntries:auroraMathUserEntries,favorites:auroraMathFavorites,history:auroraMathHistory};downloadText(`aurora-math-database-${timestampForFile()}.json`,JSON.stringify(data,null,2),"application/json");});
$("#importMathDatabase")?.addEventListener("click",()=>$("#importMathDatabaseFile")?.click());
$("#importMathDatabaseFile")?.addEventListener("change",async e=>{const file=e.target.files?.[0];if(!file)return;try{if(file.size>5*1024*1024)throw new Error("ファイルは5MB以下にしてください。");const data=JSON.parse(await file.text());if(data.format!=="aurora-math-database"||!Array.isArray(data.userEntries))throw new Error("Aurora数式DBのJSONではありません。");const valid=data.userEntries.filter(x=>x&&typeof x.t==="string"&&typeof x.f==="string").slice(0,2000);auroraMathUserEntries=[...auroraMathUserEntries.filter(x=>!valid.some(y=>y.id===x.id)),...valid];if(Array.isArray(data.favorites))auroraMathFavorites=[...new Set([...auroraMathFavorites,...data.favorites.filter(x=>typeof x==="string")])];saveValue(AURORA_DB_KEYS.mathUser,auroraMathUserEntries);saveValue(AURORA_DB_KEYS.mathFav,auroraMathFavorites);$("#mathEntryMessage").textContent=`${valid.length}件を読み込みました。`;renderDatabase();}catch(err){$("#mathEntryMessage").textContent=err.message||"読み込みに失敗しました。";}finally{e.target.value="";}});

/* =========================================================
   25. Aurora 数値データベース（25分野）
   - 静的な出典付きスナップショットとユーザーデータを分離
   - 外部通信なしで検索・比較・CSV/JSON入出力
   ========================================================= */
const NUMERIC_CATEGORIES=["山・山脈","川・湖・海","国・地域","人口・社会","都市・人口ランキング","建物・構造物","道路・鉄道・交通","気象・気候","地球・地質","動植物","人体・生物","宇宙・天体","経済・物価","エネルギー","スポーツ記録","歴史","世界ランキング","世界記録","日本全国ランキング","災害・地震","時系列統計","移動距離・所要距離","動植物記録","科学測定・定数","地域別ランキング","数学定数","整数・素数","数列・数表","数学的性質"];
const NUMERIC_DATABASE=[
 {id:"n-fuji-elev",category:"山・山脈",name:"富士山の標高（標高一覧の表示値）",value:3776,unit:"m",place:"日本・山梨県／静岡県",asOf:"2026-03-31版",publishedAt:"2026-03-31",status:"公式・確定",source:"国土地理院 日本の主な山岳標高（1003山）",sourceUrl:"https://web1.gsi.go.jp/kihonjohochousa/kihonjohochousa41139.html",note:"一覧はメートル位までの表示。三角点の標高値を採用する場合は小数第1位を四捨五入。",keywords:"日本一,最高峰,標高"},
 {id:"n-fuji-tri",category:"山・山脈",name:"富士山頂の二等三角点の標高",value:3775.6,unit:"m",place:"富士山頂・二等三角点「富士山」",asOf:"掲載情報確認日 2026-10-31",publishedAt:"",status:"測定・観測",source:"国土地理院 中部地方測量部",sourceUrl:"https://www.gsi.go.jp/chubu/chirijoho-chirijoho.html",note:"山全体の標高一覧にある3,776mとは表示精度・対象点が異なる値。混同しないこと。",keywords:"富士山,三角点,測量"},
 {id:"n-shinano",category:"川・湖・海",name:"信濃川の幹川流路延長",value:367,unit:"km",place:"日本・新潟県／長野県",asOf:"国土交通省掲載値",status:"公式・参考",source:"国土交通省 北陸地方整備局 信濃川河川事務所",sourceUrl:"https://www.hrr.mlit.go.jp/shinano/shinanogawa_info/naruhodo/ryusui.html",note:"同ページの河川比較表では日本の河川の第1位。",keywords:"最長,河川,日本一"},
 {id:"n-tone",category:"川・湖・海",name:"利根川の幹川流路延長",value:322,unit:"km",place:"日本・関東地方",asOf:"国土交通省掲載値",status:"公式・参考",source:"国土交通省 北陸地方整備局 信濃川河川事務所",sourceUrl:"https://www.hrr.mlit.go.jp/shinano/shinanogawa_info/naruhodo/ryusui.html",note:"同ページの河川比較表に掲載された値。",keywords:"河川,関東"},
 {id:"n-tone-area",category:"川・湖・海",name:"利根川の流域面積",value:16840,unit:"km²",place:"日本・関東地方",asOf:"国土交通省掲載値",status:"公式・参考",source:"国土交通省 北陸地方整備局 信濃川河川事務所",sourceUrl:"https://www.hrr.mlit.go.jp/shinano/shinanogawa_info/naruhodo/ryusui.html",note:"流域面積は降った雨が河川に流れ込む区域の面積。",keywords:"流域,面積"},
 {id:"n-japan-area",category:"国・地域",name:"日本の総面積",value:377975.37,unit:"km²",place:"日本",asOf:"2025年",status:"公式・参考",source:"総務省統計局 日本統計年鑑・都道府県別面積",sourceUrl:"https://www.stat.go.jp/data/nenkan/75nenkan/zenbun/jp75/book/pageindices/index54.html",note:"境界未定地域などの扱いに注記あり。公表年・面積調の版をそろえて比較すること。",keywords:"国土,面積,日本"},
 {id:"n-japan-pop-202610",category:"人口・社会",name:"日本の総人口（概算値）",value:122690000,unit:"人",place:"日本全国",asOf:"2026-10-01",publishedAt:"2026-10-20",status:"公式・概算",source:"総務省統計局 人口推計 2026年10月報",sourceUrl:"https://www.stat.go.jp/data/jinsui/new.htm",note:"1億2,269万人。2026年10月1日現在の概算値。2026年5月の確定値とは基準日・確定度が異なる。",keywords:"日本,総人口,人口推計"},
 {id:"n-japan-pop2025",category:"時系列統計",name:"日本の人口（2025年国勢調査速報集計）",value:123050000,unit:"人",place:"日本全国",asOf:"2025-10-01",publishedAt:"2026-05-29",status:"公式・速報",source:"総務省統計局 令和7年国勢調査 人口速報集計",sourceUrl:"https://www.stat.go.jp/data/kokusei/2025/kekka/pdf/outline.pdf",note:"約1億2,305万人。2025年国勢調査の速報集計値。後日公表された確定値と差が出る場合がある。",keywords:"人口,国勢調査,時系列"},
 {id:"n-age-under15",category:"人口・社会",name:"日本の15歳未満人口",value:13263000,unit:"人",place:"日本全国",asOf:"2026-05-01",publishedAt:"2026-10-20",status:"公式・確定",source:"総務省統計局 人口推計 2026年10月報",sourceUrl:"https://www.stat.go.jp/data/jinsui/new.htm",note:"2026年5月1日現在の確定値。2026年5月確定値の年齢区分。",keywords:"年少人口,年齢構成"},
 {id:"n-age-working",category:"人口・社会",name:"日本の15〜64歳人口",value:73322000,unit:"人",place:"日本全国",asOf:"2026-05-01",publishedAt:"2026-10-20",status:"公式・確定",source:"総務省統計局 人口推計 2026年10月報",sourceUrl:"https://www.stat.go.jp/data/jinsui/new.htm",note:"2026年5月1日現在の確定値。",keywords:"生産年齢人口,年齢構成"},
 {id:"n-age-65",category:"人口・社会",name:"日本の65歳以上人口",value:36227000,unit:"人",place:"日本全国",asOf:"2026-05-01",publishedAt:"2026-10-20",status:"公式・確定",source:"総務省統計局 人口推計 2026年10月報",sourceUrl:"https://www.stat.go.jp/data/jinsui/new.htm",note:"2026年5月1日現在の確定値。",keywords:"高齢者,年齢構成"},
 {id:"n-tokyo-pop2025",category:"都市・人口ランキング",name:"東京都の人口（2025年国勢調査速報）",value:14246000,unit:"人",place:"東京都",asOf:"2025-10-01",publishedAt:"2026-05-29",status:"公式・速報",source:"総務省統計局 令和7年国勢調査 人口速報集計",sourceUrl:"https://www.stat.go.jp/data/kokusei/2025/kekka/pdf/outline.pdf",note:"都道府県別で最多。約1,424万6千人。速報集計値。",keywords:"東京都,人口,都道府県ランキング"},
 {id:"n-kanagawa-pop2025",category:"都市・人口ランキング",name:"神奈川県の人口（2025年国勢調査速報）",value:9194000,unit:"人",place:"神奈川県",asOf:"2025-10-01",publishedAt:"2026-05-29",status:"公式・速報",source:"総務省統計局 令和7年国勢調査 人口速報集計",sourceUrl:"https://www.stat.go.jp/data/kokusei/2025/kekka/pdf/outline.pdf",note:"都道府県別人口第2位。速報集計値。",keywords:"神奈川県,人口,ランキング"},
 {id:"n-osaka-pop2025",category:"都市・人口ランキング",name:"大阪府の人口（2025年国勢調査速報）",value:8765000,unit:"人",place:"大阪府",asOf:"2025-10-01",publishedAt:"2026-05-29",status:"公式・速報",source:"総務省統計局 令和7年国勢調査 人口速報集計",sourceUrl:"https://www.stat.go.jp/data/kokusei/2025/kekka/pdf/outline.pdf",note:"都道府県別人口第3位。速報集計値。",keywords:"大阪府,人口,ランキング"},
 {id:"n-aichi-pop2025",category:"都市・人口ランキング",name:"愛知県の人口（2025年国勢調査速報）",value:7449000,unit:"人",place:"愛知県",asOf:"2025-10-01",publishedAt:"2026-05-29",status:"公式・速報",source:"総務省統計局 令和7年国勢調査 人口速報集計",sourceUrl:"https://www.stat.go.jp/data/kokusei/2025/kekka/pdf/outline.pdf",note:"都道府県別人口第4位。速報集計値。",keywords:"愛知県,人口,ランキング"},
 {id:"n-tokyo-density",category:"地域別ランキング",name:"東京都の人口密度（2025年国勢調査速報）",value:6475.7,unit:"人/km²",place:"東京都",asOf:"2025-10-01",publishedAt:"2026-05-29",status:"公式・速報",source:"総務省統計局 令和7年国勢調査 人口速報集計",sourceUrl:"https://www.stat.go.jp/data/kokusei/2025/kekka/pdf/outline.pdf",note:"都道府県別で最も高い人口密度。",keywords:"人口密度,東京都,ランキング"},
 {id:"n-japan-density",category:"地域別ランキング",name:"日本の人口密度（2025年国勢調査速報）",value:329.9,unit:"人/km²",place:"日本全国",asOf:"2025-10-01",publishedAt:"2026-05-29",status:"公式・速報",source:"総務省統計局 令和7年国勢調査 人口速報集計",sourceUrl:"https://www.stat.go.jp/data/kokusei/2025/kekka/pdf/outline.pdf",note:"速報集計の概要に掲載された全国平均。",keywords:"人口密度,全国平均"},
 {id:"n-burj",category:"建物・構造物",name:"ブルジュ・ハリファの高さ",value:828,unit:"m",place:"アラブ首長国連邦・ドバイ",asOf:"2010-01-04以降の記録掲載",status:"記録・ランキング",source:"Guinness World Records - Tallest building",sourceUrl:"https://www.guinnessworldrecords.com/world-records/tallest-building",note:"世界一高い建築物として掲載。ランキングは記録認定機関の定義・更新を確認すること。",keywords:"超高層ビル,世界一,建築"},
 {id:"n-tokyo-temp",category:"気象・気候",name:"東京の年平均気温（平年値）",value:15.8,unit:"°C",place:"東京都",asOf:"1991〜2020年",status:"観測・平年値",source:"気象庁 関東甲信地方の天候の特性",sourceUrl:"https://www.data.jma.go.jp/cpd/j_climate/kanto_koshin/main.html",note:"1991〜2020年の30年間の平年値。最新の単年実測値ではない。",keywords:"気温,平年値,東京"},
 {id:"n-tokyo-rain",category:"気象・気候",name:"東京の年間降水量（平年値）",value:1598.2,unit:"mm",place:"東京都",asOf:"1991〜2020年",status:"観測・平年値",source:"気象庁 関東甲信地方の天候の特性",sourceUrl:"https://www.data.jma.go.jp/cpd/j_climate/kanto_koshin/main.html",note:"1991〜2020年の30年間の平年値。",keywords:"降水量,雨,平年値"},
 {id:"n-earth-radius",category:"地球・地質",name:"地球の平均半径（体積等価半径）",value:6371.0,unit:"km",place:"地球",asOf:"NASA Fact Sheet掲載値",status:"参考値",source:"NASA NSSDC Moon Fact Sheet（地球との比較）",sourceUrl:"https://nssdc.gsfc.nasa.gov/planetary/factsheet/moonfact.html",note:"地球は完全な球ではないため、赤道半径・極半径と平均半径は異なる。",keywords:"地球,半径,惑星"},
 {id:"n-moon-radius",category:"宇宙・天体",name:"月の平均半径（体積等価半径）",value:1737.4,unit:"km",place:"月",asOf:"NASA Fact Sheet掲載値",status:"参考値",source:"NASA NSSDC Moon Fact Sheet",sourceUrl:"https://nssdc.gsfc.nasa.gov/planetary/factsheet/moonfact.html",note:"同表では地球の平均半径6,371.0kmと比較。",keywords:"月,半径,天体"},
 {id:"n-moon-g",category:"宇宙・天体",name:"月の表面重力",value:1.62,unit:"m/s²",place:"月の平均的な表面",asOf:"NASA Fact Sheet掲載値",status:"参考値",source:"NASA NSSDC Moon Fact Sheet",sourceUrl:"https://nssdc.gsfc.nasa.gov/planetary/factsheet/moonfact.html",note:"地球の表面重力9.80m/s²との比較に掲載された値。",keywords:"月,重力,天体"},
 {id:"n-bluewhale",category:"動植物記録",name:"シロナガスクジラの最大級の体長",value:31,unit:"m",place:"世界・シロナガスクジラ",asOf:"NOAA掲載情報確認日 2026-10-31",status:"参考値",source:"NOAA Fisheries - Fun Facts About Wonderful Whales",sourceUrl:"https://www.fisheries.noaa.gov/national/outreach-and-education/fun-facts-about-wonderful-whales",note:"最大で31mに達することがあるという解説値。全個体の平均ではない。",keywords:"動物,最大,体長,クジラ"},
 {id:"n-cpi-202609",category:"経済・物価",name:"日本の消費者物価指数（総合）",value:102.2,unit:"指数（2025年=100）",place:"日本全国",asOf:"2026-09",publishedAt:"2026-10-23",status:"公式・確定",source:"総務省統計局 消費者物価指数 2026年9月分",sourceUrl:"https://www.stat.go.jp/data/cpi/sokuhou/tsuki/index-z.htm",note:"総合指数。前年同月比は+2.1%。指数の基準年は2025年。",keywords:"CPI,物価,インフレ"},
 {id:"n-cpi-rate-202609",category:"時系列統計",name:"日本の消費者物価指数・前年同月比（総合）",value:2.1,unit:"%",place:"日本全国",asOf:"2026-09",publishedAt:"2026-10-23",status:"公式・確定",source:"総務省統計局 消費者物価指数 2026年9月分",sourceUrl:"https://www.stat.go.jp/data/cpi/sokuhou/tsuki/index-z.htm",note:"2025年基準の総合指数の前年同月比。",keywords:"CPI,物価上昇率,前年比"},
 {id:"n-energy-generation",category:"エネルギー",name:"日本の発電電力量",value:9911,unit:"億kWh",place:"日本全国",asOf:"2024年度",publishedAt:"2026-04-14",status:"公式・確定",source:"資源エネルギー庁 令和6年度エネルギー需給実績",sourceUrl:"https://www.meti.go.jp/press/2026/04/20260414001/20260414001.html",note:"2024年度確報。前年度比0.4%増。",keywords:"発電,電力量,電力"},
 {id:"n-energy-fossil",category:"エネルギー",name:"日本の火力（バイオマス除く）発電構成比",value:67.5,unit:"%",place:"日本全国",asOf:"2024年度",publishedAt:"2026-04-14",status:"公式・確定",source:"資源エネルギー庁 令和6年度エネルギー需給実績",sourceUrl:"https://www.meti.go.jp/press/2026/04/20260414001/20260414001.html",note:"2024年度確報の電源構成。定義上、火力（バイオマスを除く）の比率。",keywords:"火力,電源構成"},
 {id:"n-energy-renewables",category:"エネルギー",name:"日本の再生可能エネルギー（水力含む）発電構成比",value:23.1,unit:"%",place:"日本全国",asOf:"2024年度",publishedAt:"2026-04-14",status:"公式・確定",source:"資源エネルギー庁 令和6年度エネルギー需給実績",sourceUrl:"https://www.meti.go.jp/press/2026/04/20260414001/20260414001.html",note:"2024年度確報。",keywords:"再生可能エネルギー,電源構成"},
 {id:"n-energy-nuclear",category:"エネルギー",name:"日本の原子力発電構成比",value:9.4,unit:"%",place:"日本全国",asOf:"2024年度",publishedAt:"2026-04-14",status:"公式・確定",source:"資源エネルギー庁 令和6年度エネルギー需給実績",sourceUrl:"https://www.meti.go.jp/press/2026/04/20260414001/20260414001.html",note:"2024年度確報。",keywords:"原子力,電源構成"},
 {id:"n-bolt",category:"スポーツ記録",name:"男子100m世界記録",value:9.58,unit:"秒",place:"世界・陸上競技",asOf:"2009-08-16",status:"記録・ランキング",source:"World Athletics - 100 Metres",sourceUrl:"https://worldathletics.org/disciplines/race-walks/100-metres",note:"男子100mの世界記録としてWorld Athleticsが掲載。風速・公認条件などの記録規則に注意。",keywords:"陸上,短距離,世界記録"},
 {id:"n-fgj",category:"スポーツ記録",name:"女子100m世界記録",value:10.49,unit:"秒",place:"世界・陸上競技",asOf:"1988-07-16",status:"記録・ランキング",source:"World Athletics - 100 Metres",sourceUrl:"https://worldathletics.org/disciplines/race-walks/100-metres",note:"女子100mの世界記録としてWorld Athleticsが掲載。",keywords:"陸上,短距離,世界記録"},
 {id:"n-quake2011",category:"災害・地震",name:"東北地方太平洋沖地震のモーメントマグニチュード",value:9.0,unit:"Mw",place:"日本・三陸沖",asOf:"2011-03-11 14:46 JST",status:"公式・確定",source:"気象庁 平成23年（2011年）東北地方太平洋沖地震",sourceUrl:"https://www.data.jma.go.jp/eqev/data/2011_03_11_tohoku/index.html",note:"震源の深さ24km、最大震度7。気象庁マグニチュード8.4とは別の尺度。",keywords:"東日本大震災,地震,震度"},
 {id:"n-worldquake",category:"世界ランキング",name:"1900年以降で最大級の地震（モーメントマグニチュード）",value:9.5,unit:"Mw",place:"チリ・1960年5月23日",asOf:"気象庁FAQ掲載時点",status:"公式・参考",source:"気象庁 地震について（規模の大きな地震）",sourceUrl:"https://www.jma.go.jp/jma/kishou/know/faq/faq7.html",note:"気象庁の1900年以降の規模上位一覧で第1位。",keywords:"地震,最大,世界ランキング"},
 {id:"n-record-burj",category:"世界記録",name:"世界一高い建築物として掲載される高さ",value:828,unit:"m",place:"ブルジュ・ハリファ／ドバイ",asOf:"記録認定 2010-01-04",status:"記録・ランキング",source:"Guinness World Records - Tallest building",sourceUrl:"https://www.guinnessworldrecords.com/world-records/tallest-building",note:"記録タイトルは「Tallest building」。建物・構造物の分類規則を確認すること。",keywords:"世界記録,高さ,建築"},
 {id:"n-japan-highest",category:"日本全国ランキング",name:"日本の最高峰（富士山）",value:3776,unit:"m",place:"山梨県／静岡県",asOf:"2026-03-31版",status:"公式・確定",source:"国土地理院 日本の主な山岳標高（1003山）",sourceUrl:"https://web1.gsi.go.jp/kihonjohochousa/kihonjohochousa41139.html",note:"標高一覧のメートル単位表示。",keywords:"日本一,山,標高"},
 {id:"n-history-2011",category:"歴史",name:"東北地方太平洋沖地震が発生した年",value:2011,unit:"年",place:"日本・三陸沖",asOf:"2011-03-11",status:"公式・確定",source:"気象庁 平成23年（2011年）東北地方太平洋沖地震",sourceUrl:"https://www.data.jma.go.jp/eqev/data/2011_03_11_tohoku/index.html",note:"2011年3月11日14時46分（日本時間）に発生。",keywords:"歴史,災害,東日本大震災"},
 {id:"n-si-c",category:"科学測定・定数",name:"真空中の光速度 c",value:299792458,unit:"m/s",place:"SI定義定数",asOf:"2019年SI再定義以降",status:"定義値・正確",source:"NIST SP 330 - Section 2",sourceUrl:"https://www.nist.gov/pml/special-publication-330/sp-330-section-2",note:"SIにおける定義値であり、不確かさはありません。",keywords:"光速,物理定数,SI"},
 {id:"n-si-h",category:"科学測定・定数",name:"プランク定数 h",value:6.62607015e-34,unit:"J·s",place:"SI定義定数",asOf:"2019年SI再定義以降",status:"定義値・正確",source:"NIST SP 330 - Section 2",sourceUrl:"https://www.nist.gov/pml/special-publication-330/sp-330-section-2",note:"SIにおける定義値。",keywords:"プランク定数,物理定数,SI"},
 {id:"n-si-na",category:"科学測定・定数",name:"アボガドロ定数 Nₐ",value:6.02214076e23,unit:"mol⁻¹",place:"SI定義定数",asOf:"2019年SI再定義以降",status:"定義値・正確",source:"NIST SP 330 - Section 2",sourceUrl:"https://www.nist.gov/pml/special-publication-330/sp-330-section-2",note:"1 molに含まれる指定された要素粒子数を定義する定数。",keywords:"アボガドロ,物質量,物理定数"},
 {id:"n-world-blue",category:"世界ランキング",name:"シロナガスクジラの最大級の体長",value:31,unit:"m",place:"世界・海洋生物",asOf:"NOAA掲載情報確認日 2026-10-31",status:"参考値",source:"NOAA Fisheries - Fun Facts About Wonderful Whales",sourceUrl:"https://www.fisheries.noaa.gov/national/outreach-and-education/fun-facts-about-wonderful-whales",note:"最大で31mに達するという解説値。平均値ではない。",keywords:"動物,世界最大,クジラ"},
 {id:"n-shinkansen-km",category:"道路・鉄道・交通",name:"東海道新幹線の営業キロ",value:552.6,unit:"km",place:"東京〜新大阪・東海道新幹線",asOf:"JR東海掲載情報",status:"公式・参考",source:"JR東海 線区別営業キロ",sourceUrl:"https://company.jr-central.co.jp/company/area/",note:"営業キロであり、直線距離や実際の移動距離とは異なる。",keywords:"交通,鉄道,新幹線,距離"},
 {id:"n-shinkansen-distance",category:"移動距離・所要距離",name:"東海道新幹線の営業距離",value:552.6,unit:"km",place:"東京〜新大阪・東海道新幹線",asOf:"JR東海掲載情報",status:"公式・参考",source:"JR東海 線区別営業キロ",sourceUrl:"https://company.jr-central.co.jp/company/area/",note:"路線の営業キロ。駅間や乗車経路の条件で利用者の実移動距離とは一致しない。",keywords:"移動距離,営業キロ,新幹線"},
 {id:"n-human-chromosomes",category:"人体・生物",name:"ヒトの一般的な体細胞の染色体数",value:46,unit:"本",place:"ヒトの一般的な体細胞",asOf:"NHGRI掲載情報",status:"参考値",source:"米国国立ヒトゲノム研究所（NHGRI） Chromosome Abnormalities Fact Sheet",sourceUrl:"https://www.genome.gov/about-genomics/fact-sheets/Chromosome-Abnormalities-Fact-Sheet",note:"通常は23対。配偶子（卵・精子）は通常23本で、染色体数に例外・異常がある。",keywords:"人体,染色体,遺伝子"},
 {id:"n-rice-chromosomes",category:"動植物",name:"イネの染色体数",value:24,unit:"本",place:"イネ",asOf:"NHGRI掲載情報",status:"参考値",source:"米国国立ヒトゲノム研究所（NHGRI） Chromosomes Fact Sheet",sourceUrl:"https://www.genome.gov/about-genomics/fact-sheets/Chromosomes-Fact-Sheet",note:"NHGRIの解説に示されたイネの染色体数。品種ではなく基本的な種の説明値として扱う。",keywords:"植物,イネ,染色体"},
 {id:"n-history-chromosome",category:"歴史",name:"ヒトの染色体数46本が明確に示された年",value:1955,unit:"年",place:"細胞遺伝学の歴史",asOf:"1955年",status:"公式・歴史資料",source:"NHGRI - 1955: 46 Human Chromosomes",sourceUrl:"https://www.genome.gov/25520285/online-education-kit-1955-a-46-human-chromosomes",note:"Joe Hin Tjioによるヒトの染色体数の明確化に関するNHGRIの歴史解説。",keywords:"科学史,染色体,歴史"}
  ,{id:"math-pi",category:"数学定数",name:"円周率 π",value:3.141592653589793,unit:"無次元",place:"数学定数",asOf:"数学的定義",status:"定義値・近似表示",source:"円周と直径の比の定義",note:"正確な値は無理数。ここでは倍精度浮動小数点による近似値。",keywords:"pi,円周率,無理数"}
  ,{id:"math-e",category:"数学定数",name:"ネイピア数 e",value:2.718281828459045,unit:"無次元",place:"数学定数",asOf:"数学的定義",status:"定義値・近似表示",source:"自然対数の底の定義",note:"正確な値は無理数。指数関数・微積分に現れる。",keywords:"e,ネイピア数,自然対数"}
  ,{id:"math-sqrt2",category:"数学定数",name:"√2（平方根2）",value:1.4142135623730951,unit:"無次元",place:"数学定数",asOf:"数学的定義",status:"定義値・近似表示",source:"2の正の平方根",note:"正確な値は無理数。",keywords:"平方根,無理数,ルート2"}
  ,{id:"math-sqrt3",category:"数学定数",name:"√3（平方根3）",value:1.7320508075688772,unit:"無次元",place:"数学定数",asOf:"数学的定義",status:"定義値・近似表示",source:"3の正の平方根",note:"正確な値は無理数。正三角形の高さなどに現れる。",keywords:"平方根,無理数"}
  ,{id:"math-phi",category:"数学定数",name:"黄金比 φ",value:1.618033988749895,unit:"無次元",place:"数学定数",asOf:"φ=(1+√5)/2",status:"定義値・近似表示",source:"黄金比の定義",note:"正確な値は(1+√5)/2。",keywords:"黄金比,phi,無理数"}
  ,{id:"math-ln2",category:"数学定数",name:"自然対数 ln 2",value:0.6931471805599453,unit:"無次元",place:"数学定数",asOf:"数学的定義",status:"定義値・近似表示",source:"自然対数の定義",note:"eを底とする2の対数。",keywords:"対数,ln2"}
  ,{id:"math-euler-gamma",category:"数学定数",name:"オイラー・マスケローニ定数 γ",value:0.5772156649015329,unit:"無次元",place:"数学定数",asOf:"定義による近似",status:"参考値",source:"調和級数と自然対数の差の極限",note:"γ=lim(n→∞)(1+1/2+...+1/n−ln n)。",keywords:"オイラー定数,gamma"}
  ,{id:"math-apery",category:"数学定数",name:"アペリー定数 ζ(3)",value:1.202056903159594,unit:"無次元",place:"数学定数",asOf:"定義による近似",status:"参考値",source:"リーマンゼータ関数 ζ(3)",note:"ζ(3)=1+1/2³+1/3³+...。",keywords:"アペリー,ゼータ関数"}
  ,{id:"math-catalan",category:"数学定数",name:"カタラン定数 G",value:0.915965594177219,unit:"無次元",place:"数学定数",asOf:"定義による近似",status:"参考値",source:"交代級数による定義",note:"G=1−1/3²+1/5²−1/7²+...。",keywords:"カタラン定数"}
  ,{id:"math-prime-10",category:"整数・素数",name:"10番目の素数",value:29,unit:"整数",place:"正の整数",asOf:"小さい順",status:"数学的に確定",source:"素数列の定義",note:"素数列：2,3,5,7,11,13,17,19,23,29。",keywords:"素数,10番目"}
  ,{id:"math-prime-100",category:"整数・素数",name:"100番目の素数",value:541,unit:"整数",place:"正の整数",asOf:"小さい順",status:"数学的に確定",source:"素数列の定義",note:"2から数えて100番目の素数。",keywords:"素数,100番目"}
  ,{id:"math-prime-1000",category:"整数・素数",name:"1000番目の素数",value:7919,unit:"整数",place:"正の整数",asOf:"小さい順",status:"数学的に確定",source:"素数列の定義",note:"2から数えて1000番目の素数。",keywords:"素数,1000番目"}
  ,{id:"math-perfect-1",category:"整数・素数",name:"最初の完全数",value:6,unit:"整数",place:"正の整数",asOf:"小さい順",status:"数学的に確定",source:"約数和による定義",note:"自分自身を除く正の約数1,2,3の和が6になる。",keywords:"完全数,約数"}
  ,{id:"math-perfect-2",category:"整数・素数",name:"2番目の完全数",value:28,unit:"整数",place:"正の整数",asOf:"小さい順",status:"数学的に確定",source:"約数和による定義",note:"1+2+4+7+14=28。",keywords:"完全数,約数"}
  ,{id:"math-factorial-10",category:"数列・数表",name:"10の階乗 10!",value:3628800,unit:"整数",place:"階乗",asOf:"10!",status:"数学的に確定",source:"階乗の定義",note:"1×2×3×...×10。",keywords:"階乗,10!"}
  ,{id:"math-power-10",category:"数列・数表",name:"2の10乗",value:1024,unit:"整数",place:"べき乗",asOf:"2^10",status:"数学的に確定",source:"整数の累乗",note:"2を10回掛けた値。2進数の桁数・コンピューター分野でも使われる。",keywords:"累乗,2のべき乗"}
  ,{id:"math-fibonacci-10",category:"数列・数表",name:"フィボナッチ数列 F10",value:55,unit:"整数",place:"F0=0,F1=1",asOf:"n=10",status:"数学的に確定",source:"フィボナッチ漸化式",note:"F_n=F_(n−1)+F_(n−2)。F10=55。",keywords:"フィボナッチ,数列"}
  ,{id:"math-fibonacci-20",category:"数列・数表",name:"フィボナッチ数列 F20",value:6765,unit:"整数",place:"F0=0,F1=1",asOf:"n=20",status:"数学的に確定",source:"フィボナッチ漸化式",note:"F_n=F_(n−1)+F_(n−2)。F20=6765。",keywords:"フィボナッチ,数列"}
  ,{id:"math-triangular-100",category:"数列・数表",name:"100番目の三角数",value:5050,unit:"整数",place:"三角数",asOf:"n=100",status:"数学的に確定",source:"n(n+1)/2",note:"1+2+...+100=5050。",keywords:"三角数,自然数の和"}
  ,{id:"math-square-100",category:"数列・数表",name:"100の平方数",value:10000,unit:"整数",place:"平方数",asOf:"100^2",status:"数学的に確定",source:"平方数の定義",note:"100×100=10,000。",keywords:"平方数,100の2乗"}
  ,{id:"math-cube-10",category:"数列・数表",name:"10の立方数",value:1000,unit:"整数",place:"立方数",asOf:"10^3",status:"数学的に確定",source:"立方数の定義",note:"10×10×10=1,000。",keywords:"立方数,10の3乗"}
  ,{id:"math-square-sum-10",category:"数列・数表",name:"1から10までの平方和",value:385,unit:"整数",place:"平方和",asOf:"n=10",status:"数学的に確定",source:"n(n+1)(2n+1)/6",note:"1²+2²+...+10²=385。",keywords:"平方和,数列"}
  ,{id:"math-cube-sum-10",category:"数列・数表",name:"1から10までの立方和",value:3025,unit:"整数",place:"立方和",asOf:"n=10",status:"数学的に確定",source:"(n(n+1)/2)^2",note:"1³+2³+...+10³=3025。",keywords:"立方和,数列"}
  ,{id:"math-angle-circle",category:"数学的性質",name:"一周の角度",value:360,unit:"度",place:"平面幾何",asOf:"1回転",status:"数学的に確定",source:"角度の定義",note:"1回転は360°で、2πラジアンに相当する。",keywords:"角度,一周,ラジアン"}
  ,{id:"math-triangle-sum",category:"数学的性質",name:"三角形の内角の和",value:180,unit:"度",place:"ユークリッド平面",asOf:"平面幾何",status:"公理体系に依存する定理",source:"ユークリッド幾何",note:"平面上の三角形で成立。球面三角形などでは一般に180°を超える。",keywords:"三角形,内角,180度"}
  ,{id:"math-poly-hex",category:"数学的性質",name:"正六角形の内角の和",value:720,unit:"度",place:"平面幾何",asOf:"n=6",status:"数学的に確定",source:"(n−2)×180°",note:"1つの内角は120°。",keywords:"六角形,内角"}

];
function validNumericRecord(x){return !!x&&typeof x.id==="string"&&typeof x.name==="string"&&Number.isFinite(Number(x.value))&&typeof x.unit==="string"&&NUMERIC_CATEGORIES.includes(x.category);}
function getNumericAll(){return [...NUMERIC_DATABASE,...auroraNumericUserEntries];}
function fmtNumeric(v){const n=Number(v);return Number.isFinite(n)?new Intl.NumberFormat("ja-JP",{maximumSignificantDigits:12}).format(n):String(v);}
function numericCardSeries(series){if(!Array.isArray(series)||series.length<2||series.length>100)return null;const vals=series.map(x=>Number(x.value));if(vals.some(x=>!Number.isFinite(x)))return null;const min=Math.min(...vals),max=Math.max(...vals),range=max-min||1;const pts=vals.map((v,i)=>`${20+i*260/(vals.length-1)},${90-(v-min)*70/range}`).join(" ");const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");svg.setAttribute("viewBox","0 0 300 105");svg.setAttribute("class","numeric-chart");const line=document.createElementNS("http://www.w3.org/2000/svg","polyline");line.setAttribute("points",pts);svg.append(line);vals.forEach((v,i)=>{const circle=document.createElementNS("http://www.w3.org/2000/svg","circle");circle.setAttribute("cx",String(20+i*260/(vals.length-1)));circle.setAttribute("cy",String(90-(v-min)*70/range));circle.setAttribute("r","3");svg.append(circle);});return svg;}
function renderNumericDatabase(){
  const q=( $("#numericSearch")?.value||"").trim().toLowerCase(),cat=$("#numericCategory")?.value||"all",unitQ=( $("#numericUnitFilter")?.value||"").trim().toLowerCase(),sort=$("#numericSort")?.value||"default";
  let list=getNumericAll().filter(x=>{const text=[x.name,x.category,x.place,x.unit,x.asOf,x.status,x.source,x.note,x.keywords].join(" ").toLowerCase();return (cat==="all"||x.category===cat)&&(!q||text.includes(q))&&(!unitQ||x.unit.toLowerCase().includes(unitQ));});
  if(auroraNumericView==="favorites")list=list.filter(x=>auroraNumericFavorites.includes(x.id));
  if(auroraNumericView==="history")list=list.filter(x=>auroraNumericHistory.includes(x.id));
  if(sort==="value-desc")list.sort((a,b)=>Number(b.value)-Number(a.value));else if(sort==="value-asc")list.sort((a,b)=>Number(a.value)-Number(b.value));else if(sort==="name")list.sort((a,b)=>a.name.localeCompare(b.name,"ja"));else if(sort==="date")list.sort((a,b)=>String(b.asOf||"").localeCompare(String(a.asOf||"")));
  const host=$("#numericEntries");if(!host)return;host.replaceChildren();$("#numericCount").textContent=`${list.length}件を表示（標準 ${NUMERIC_DATABASE.length}件／自作 ${auroraNumericUserEntries.length}件・全${NUMERIC_CATEGORIES.length}分野）`;
  if(!list.length){addText(host,"div","numeric-empty","一致するデータがありません。この分野はまだ初期データがない場合があります。下のフォームから登録できるよ。");}
  list.forEach(x=>{
    const card=document.createElement("article");card.className=`numeric-entry${x.userEntry?" user-entry":""}`;
    addText(card,"span","database-category",x.category);const titleEl=addText(card,"h3","",x.name);titleEl.tabIndex=0;titleEl.title="クリックすると閲覧履歴に追加";titleEl.addEventListener("click",()=>{auroraNumericHistory=appendUnique(auroraNumericHistory,x.id,100);saveValue(AURORA_DB_KEYS.numericHistory,auroraNumericHistory);});titleEl.addEventListener("keydown",ev=>{if(ev.key==="Enter"||ev.key===" "){ev.preventDefault();titleEl.click();}});
    const value=addText(card,"div","numeric-value",`${fmtNumeric(x.value)} `);addText(value,"small","",x.unit);
    addText(card,"p","numeric-meta",`対象：${x.place||"—"}`);addText(card,"p","numeric-meta",`基準日・期間：${x.asOf||"未設定"}　｜　区分：${x.status||"未分類"}`);
    if(x.publishedAt)addText(card,"p","numeric-meta",`公表日：${x.publishedAt}`);
    if(x.note)addText(card,"p","",x.note);
    const src=document.createElement("p");src.className="numeric-source";src.textContent=`出典：${x.source||"ユーザー入力"} `;const url=safeSourceLink(x.sourceUrl||"");if(url){const a=document.createElement("a");a.href=url;a.target="_blank";a.rel="noopener noreferrer";a.textContent="出典を開く";src.append(a);}card.append(src);
    if(x.series){const chart=numericCardSeries(x.series);if(chart){card.append(chart);addText(card,"p","numeric-meta",`時系列：${x.series[0].date} → ${x.series[x.series.length-1].date}`);}}
    const actions=document.createElement("div");actions.className="numeric-actions";
    const id=x.id;const fav=document.createElement("button");fav.type="button";fav.className="secondary-button";fav.textContent=auroraNumericFavorites.includes(id)?"★ お気に入り解除":"☆ お気に入り";fav.addEventListener("click",()=>{auroraNumericFavorites=auroraNumericFavorites.includes(id)?auroraNumericFavorites.filter(v=>v!==id):appendUnique(auroraNumericFavorites,id,10000);saveValue(AURORA_DB_KEYS.numericFav,auroraNumericFavorites);renderNumericDatabase();});actions.append(fav);
    const send=document.createElement("button");send.type="button";send.className="secondary-button";send.textContent="数値を電卓へ";send.addEventListener("click",()=>{$("#expressionInput").value=String(x.value);document.querySelector('[data-tab="calculatorTab"]')?.click();focusWithoutScroll($("#expressionInput"));});actions.append(send);
    if(auroraNumericUserEntries.some(v=>v.id===id)){const edit=document.createElement("button");edit.type="button";edit.className="secondary-button";edit.textContent="編集";edit.addEventListener("click",()=>loadNumericEntryForEdit(x));actions.append(edit);const del=document.createElement("button");del.type="button";del.className="secondary-button";del.textContent="削除";del.addEventListener("click",()=>{if(!confirm(`「${x.name}」を削除しますか？`))return;auroraNumericUserEntries=auroraNumericUserEntries.filter(v=>v.id!==id);saveValue(AURORA_DB_KEYS.numericUser,auroraNumericUserEntries);renderNumericDatabase();});actions.append(del);}
    card.append(actions);host.append(card);
  });
  refreshNumericSelectors();
}
function refreshNumericSelectors(){
  const cat=$("#numericCategory"),entryCat=$("#numericEntryCategory");if(cat&&cat.options.length!==NUMERIC_CATEGORIES.length+1){cat.replaceChildren(new Option("すべての分野","all"));NUMERIC_CATEGORIES.forEach(c=>cat.add(new Option(c,c)));}if(entryCat&&entryCat.options.length!==NUMERIC_CATEGORIES.length){entryCat.replaceChildren();NUMERIC_CATEGORIES.forEach(c=>entryCat.add(new Option(c,c)));}
  const all=getNumericAll();["#numericCompareA","#numericCompareB"].forEach((sel,i)=>{const el=$(sel);if(!el)return;const current=el.value;el.replaceChildren();all.forEach(x=>el.add(new Option(`${x.name}（${fmtNumeric(x.value)} ${x.unit}）`,x.id)));if([...el.options].some(o=>o.value===current))el.value=current;else if(el.options.length)el.selectedIndex=Math.min(i,el.options.length-1);});
}
["#numericSearch","#numericCategory","#numericSort","#numericUnitFilter"].forEach(sel=>$(sel)?.addEventListener(sel==="#numericCategory"||sel==="#numericSort"?"change":"input",renderNumericDatabase));
$("#numericShowAll")?.addEventListener("click",()=>{auroraNumericView="all";renderNumericDatabase();});$("#numericShowFavorites")?.addEventListener("click",()=>{auroraNumericView="favorites";renderNumericDatabase();});$("#numericShowHistory")?.addEventListener("click",()=>{auroraNumericView="history";renderNumericDatabase();});
$("#numericCompareButton")?.addEventListener("click",()=>{const a=getNumericAll().find(x=>x.id===$("#numericCompareA").value),b=getNumericAll().find(x=>x.id===$("#numericCompareB").value),out=$("#numericCompareResult");if(!a||!b){out.textContent="比較する項目を選んでください。";return;}if(a.unit!==b.unit){out.textContent=`単位が異なるため比較できません（${a.unit} と ${b.unit}）。同じ単位・同じ定義の値を選んでください。`;return;}const diff=Number(a.value)-Number(b.value),ratio=Number(b.value)===0?"計算不可":`${fmtNumeric(Number(a.value)/Number(b.value))} 倍`;out.textContent=`A：${a.name} = ${fmtNumeric(a.value)} ${a.unit}\nB：${b.name} = ${fmtNumeric(b.value)} ${b.unit}\n差（A−B）：${fmtNumeric(diff)} ${a.unit}\n倍率（A/B）：${ratio}`;});
function clearNumericEntryForm(){editingNumericEntryId=null;["numericEntryName","numericEntryValue","numericEntryUnit","numericEntryPlace","numericEntryDate","numericEntrySource","numericEntryUrl","numericEntryNote","numericEntrySeries"].forEach(id=>$("#"+id).value="");$("#numericEntryStatus").value="ユーザー入力";$("#saveNumericEntry").textContent="数値を保存";$("#cancelNumericEntryEdit").hidden=true;}
function loadNumericEntryForEdit(x){editingNumericEntryId=x.id;$("#numericEntryName").value=x.name;$("#numericEntryCategory").value=x.category;$("#numericEntryValue").value=x.value;$("#numericEntryUnit").value=x.unit;$("#numericEntryPlace").value=x.place||"";$("#numericEntryDate").value=x.asOf||"";$("#numericEntrySource").value=x.source||"";$("#numericEntryUrl").value=x.sourceUrl||"";$("#numericEntryStatus").value=x.status||"ユーザー入力";$("#numericEntryNote").value=x.note||"";$("#numericEntrySeries").value=x.series?JSON.stringify(x.series):"";$("#saveNumericEntry").textContent="変更を保存";$("#cancelNumericEntryEdit").hidden=false;$("#numericEntryName").focus();}
$("#saveNumericEntry")?.addEventListener("click",()=>{try{const name=$("#numericEntryName").value.trim(),value=Number($("#numericEntryValue").value),unit=$("#numericEntryUnit").value.trim();if(!name||$("#numericEntryValue").value.trim()===""||!Number.isFinite(value)||!unit)throw new Error("項目名・数値・単位を正しく入力してください。");const sourceUrl=$("#numericEntryUrl").value.trim();if(sourceUrl&&!safeSourceLink(sourceUrl))throw new Error("出典URLは http:// または https:// で入力してください。");let series=null;const seriesText=$("#numericEntrySeries").value.trim();if(seriesText){series=JSON.parse(seriesText);if(!Array.isArray(series)||series.length>100||series.some(p=>!p||typeof p.date!=="string"||!Number.isFinite(Number(p.value))))throw new Error("時系列JSONは [{date,value}] の配列で、最大100点までです。");series=series.map(p=>({date:p.date,value:Number(p.value)}));}const id=editingNumericEntryId||`numeric-user-${Date.now()}`;const item={id,userEntry:true,category:$("#numericEntryCategory").value,name,value,unit,place:$("#numericEntryPlace").value.trim(),asOf:$("#numericEntryDate").value.trim(),source:$("#numericEntrySource").value.trim()||"ユーザー入力",sourceUrl,status:$("#numericEntryStatus").value,note:$("#numericEntryNote").value.trim(),series,updatedAt:new Date().toISOString()};if(editingNumericEntryId)auroraNumericUserEntries=auroraNumericUserEntries.map(x=>x.id===id?item:x);else auroraNumericUserEntries.push(item);saveValue(AURORA_DB_KEYS.numericUser,auroraNumericUserEntries);clearNumericEntryForm();$("#numericEntryMessage").textContent="保存しました。";renderNumericDatabase();}catch(e){$("#numericEntryMessage").textContent=e.message||"保存できませんでした。";}});
$("#cancelNumericEntryEdit")?.addEventListener("click",clearNumericEntryForm);
function exportNumericCsv(){const query=$("#numericSearch")?.value.trim().toLowerCase()||"",cat=$("#numericCategory")?.value||"all",unit=$("#numericUnitFilter")?.value.trim().toLowerCase()||"";const rows=getNumericAll().filter(x=>(cat==="all"||x.category===cat)&&[x.name,x.category,x.place,x.source,x.note,x.keywords].join(" ").toLowerCase().includes(query)&&(!unit||x.unit.toLowerCase().includes(unit)));const cols=["name","category","value","unit","place","asOf","publishedAt","status","source","sourceUrl","note"];const csv=[cols.join(","),...rows.map(x=>cols.map(k=>`"${String(x[k]??"").replace(/"/g,'""')}"`).join(","))].join("\r\n");downloadText(`aurora-numeric-database-${timestampForFile()}.csv`,"\ufeff"+csv,"text/csv;charset=utf-8");}
$("#numericExportCsv")?.addEventListener("click",exportNumericCsv);
$("#exportNumericJson")?.addEventListener("click",()=>{const data={format:"aurora-numeric-database",version:1,exportedAt:new Date().toISOString(),userEntries:auroraNumericUserEntries,favorites:auroraNumericFavorites,history:auroraNumericHistory};downloadText(`aurora-numeric-database-${timestampForFile()}.json`,JSON.stringify(data,null,2),"application/json");$("#numericBackupMessage").textContent="JSONを保存しました。";});
$("#importNumericJson")?.addEventListener("click",()=>$("#importNumericJsonFile")?.click());
$("#importNumericJsonFile")?.addEventListener("change",async e=>{const file=e.target.files?.[0];if(!file)return;try{if(file.size>10*1024*1024)throw new Error("ファイルは10MB以下にしてください。");const data=JSON.parse(await file.text());if(data.format!=="aurora-numeric-database"||!Array.isArray(data.userEntries))throw new Error("Aurora数値DBのJSONではありません。");const valid=data.userEntries.filter(validNumericRecord).slice(0,10000);auroraNumericUserEntries=[...auroraNumericUserEntries.filter(x=>!valid.some(y=>y.id===x.id)),...valid];if(Array.isArray(data.favorites))auroraNumericFavorites=[...new Set([...auroraNumericFavorites,...data.favorites.filter(x=>typeof x==="string")])];saveValue(AURORA_DB_KEYS.numericUser,auroraNumericUserEntries);saveValue(AURORA_DB_KEYS.numericFav,auroraNumericFavorites);$("#numericBackupMessage").textContent=`${valid.length}件の数値データを読み込みました。`;renderNumericDatabase();}catch(err){$("#numericBackupMessage").textContent=err.message||"読み込みに失敗しました。";}finally{e.target.value="";}});
refreshNumericSelectors();renderDatabase();renderNumericDatabase();

/* =========================================================
   25. Aurora V8 追加センター
   軽量ツール／実験・3D／データ分析／学習／研究／自動化／連携／画像解析
   追加データは既存の保存領域と分離して管理
   ========================================================= */
const AURORA_WORKSPACE_KEY = "aurora-workspace-v1";
const savedWorkspace = readSaved(AURORA_WORKSPACE_KEY, {});
const workspaceState = {
  notes: Array.isArray(savedWorkspace.notes) ? savedWorkspace.notes : [],
  accessibility: savedWorkspace.accessibility && typeof savedWorkspace.accessibility === "object" ? savedWorkspace.accessibility : {}
};
function saveWorkspace() { saveValue(AURORA_WORKSPACE_KEY, workspaceState); }
function byId(id) { return document.getElementById(id); }
function setText(id, value) { const el = byId(id); if (el) el.textContent = String(value ?? ""); }
function parseNumberList(text) {
  const parts = String(text || "").trim().split(/[\s,;、]+/).filter(Boolean);
  if (!parts.length) throw new Error("数値を1つ以上入力してください。");
  if (parts.length > 10000) throw new Error("一度に扱える数値は10,000個までです。");
  const values = parts.map(Number);
  if (values.some(v => !Number.isFinite(v))) throw new Error("数値以外の項目が含まれています。");
  return values;
}
function gcdSafe(a, b) { a = Math.abs(Math.trunc(a)); b = Math.abs(Math.trunc(b)); while (b) [a, b] = [b, a % b]; return a; }
function primeFactors(n) {
  if (!Number.isSafeInteger(n) || n < 2 || n > 1e12) throw new Error("素因数分解は2〜1兆の安全な整数にしてください。");
  const out = []; let value = n;
  for (let p = 2; p * p <= value && p <= 1e6; p += p === 2 ? 1 : 2) {
    let count = 0; while (value % p === 0) { value /= p; count++; }
    if (count) out.push(count > 1 ? `${p}^${count}` : String(p));
  }
  if (value > 1) out.push(String(value)); return out.join(" × ");
}
function divisorsOf(n) {
  if (!Number.isSafeInteger(n) || n < 1 || n > 1e10) throw new Error("約数一覧は1〜100億の整数にしてください。");
  const low = [], high = []; for (let i = 1; i * i <= n; i++) if (n % i === 0) { low.push(i); if (i !== n / i) high.push(n / i); if (low.length + high.length > 20000) throw new Error("約数が多すぎます。"); }
  return [...low, ...high.reverse()];
}
function safeLocalDate(value) { const m = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/); if (!m) throw new Error("日付を選択してください。"); const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])); if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) throw new Error("有効な日付を入力してください。"); return d; }
function dateStringLocal(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }

// 公開版バックアップには、維持するローカルメモとアクセシビリティ設定のみを含める。
const auroraOriginalGetDatabaseBackup = getAuroraDatabaseBackup;
getAuroraDatabaseBackup = function () {
  const base = auroraOriginalGetDatabaseBackup();
  return { auroraDatabase: { ...base.auroraDatabase, workspace: {
    notes: workspaceState.notes,
    accessibility: workspaceState.accessibility
  } } };
};
const auroraOriginalApplyDatabaseBackup = applyAuroraDatabaseBackup;
applyAuroraDatabaseBackup = function (payload) {
  auroraOriginalApplyDatabaseBackup(payload);
  if (payload && payload.workspace && typeof payload.workspace === "object") {
    const incoming = payload.workspace;
    if (Array.isArray(incoming.notes)) workspaceState.notes = incoming.notes.slice(-500);
    if (incoming.accessibility && typeof incoming.accessibility === "object") {
      workspaceState.accessibility = incoming.accessibility;
      saveValue(ACCESSIBILITY_KEY, workspaceState.accessibility);
      applyAccessibilitySettings(workspaceState.accessibility);
    }
    saveWorkspace();
    renderNotes();
  }
};

/* クイックツール：数値計算 */
function runQuickMath(action) {
  try {
    const a = Number(byId("qtA").value), b = Number(byId("qtB").value);
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error("AとBに有効な数値を入力してください。");
    let result = "";
    if (action === "percent") result = `${a} の ${b}% = ${formatNumber(a*b/100)}`;
    if (action === "reverse") { if (b === 0) throw new Error("Bが0の場合は計算できません。"); result = `${a} は ${b} の ${formatNumber(a/b*100)}%`; }
    if (action === "gcd" || action === "lcm") {
      if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) throw new Error("最大公約数・最小公倍数は安全な整数で入力してください。");
      const g = gcdSafe(a,b), l = g === 0 ? 0n : (BigInt(Math.abs(a/g))*BigInt(Math.abs(b))); result = action === "gcd" ? `最大公約数：${g}` : `最小公倍数：${l.toString()}`;
    }
    if (action === "prime") { if (!Number.isSafeInteger(a) || a < 0 || a > 1e12) throw new Error("Aは0〜1兆の整数にしてください。"); let prime = a >= 2; for (let i=2; prime && i*i<=a; i++) if (a%i===0) prime=false; result = `${a} は${prime?"素数です":"素数ではありません"}`; }
    if (action === "factor") result = `${a} = ${primeFactors(a)}`;
    if (action === "divisors") { const ds=divisorsOf(a); result = `約数（${ds.length}個）：\n${ds.join(", ")}`; }
    setText("qtMathResult", result);
  } catch (e) { setText("qtMathResult", e.message); }
}
[["qtPercent","percent"],["qtReversePercent","reverse"],["qtGcd","gcd"],["qtLcm","lcm"],["qtPrime","prime"],["qtFactor","factor"],["qtDivisors","divisors"]].forEach(([id,act])=>byId(id)?.addEventListener("click",()=>runQuickMath(act)));
byId("qtRandomGenerate")?.addEventListener("click",()=>{try{const min=Number(byId("qtRandomMin").value),max=Number(byId("qtRandomMax").value),count=Number(byId("qtRandomCount").value);if(!Number.isSafeInteger(min)||!Number.isSafeInteger(max)||max<min||max-min>1e9||!Number.isInteger(count)||count<1||count>100)throw new Error("最小・最大・個数を確認してください（個数1〜100）。");const values=Array.from({length:count},()=>Math.floor(Math.random()*(max-min+1))+min);setText("qtRandomResult",`抽選結果：${values.join(", ")}`);}catch(e){setText("qtRandomResult",e.message);}});
byId("qtDice")?.addEventListener("click",()=>setText("qtRandomResult",`サイコロ：${1+Math.floor(Math.random()*6)}`));
byId("qtCoin")?.addEventListener("click",()=>setText("qtRandomResult",Math.random()<.5?"コイントス：表":"コイントス：裏"));
function getDrawItems(){return byId("qtDrawList").value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);}
byId("qtPickOne")?.addEventListener("click",()=>{const a=getDrawItems();setText("qtRandomResult",a.length?`抽選結果：${a[Math.floor(Math.random()*a.length)]}`:"項目を1行に1つ入力してください。");});
byId("qtShuffle")?.addEventListener("click",()=>{const a=getDrawItems();for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}byId("qtRandomResult").textContent=a.length?a.join("\n"):"項目を1行に1つ入力してください。";});

/* タイマー */
let qtSwStartedAt=null, qtSwElapsed=0, qtSwTimer=null, qtSwLaps=[];
let qtCountdownRemaining=0, qtCountdownTimer=null;
function formatClock(ms, tenths=false){const total=Math.max(0,ms);const h=Math.floor(total/3600000),m=Math.floor(total%3600000/60000),s=Math.floor(total%60000/1000),t=Math.floor(total%1000/100);return h?`${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}${tenths?`.${t}`:""}`:`${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}${tenths?`.${t}`:""}`;}
function updateStopwatch(){const elapsed=qtSwElapsed+(qtSwStartedAt?Date.now()-qtSwStartedAt:0);setText("qtStopwatchDisplay",formatClock(elapsed,true));}
byId("qtSwStart")?.addEventListener("click",()=>{if(qtSwStartedAt){qtSwElapsed+=Date.now()-qtSwStartedAt;qtSwStartedAt=null;clearInterval(qtSwTimer);qtSwTimer=null;byId("qtSwStart").textContent="再開";}else{qtSwStartedAt=Date.now();qtSwTimer=setInterval(updateStopwatch,100);byId("qtSwStart").textContent="停止";}updateStopwatch();});
byId("qtSwLap")?.addEventListener("click",()=>{const elapsed=qtSwElapsed+(qtSwStartedAt?Date.now()-qtSwStartedAt:0);qtSwLaps.push(formatClock(elapsed,true));setText("qtSwLaps",qtSwLaps.map((v,i)=>`${i+1}. ${v}`).join("\n"));});
byId("qtSwReset")?.addEventListener("click",()=>{clearInterval(qtSwTimer);qtSwTimer=null;qtSwStartedAt=null;qtSwElapsed=0;qtSwLaps=[];byId("qtSwStart").textContent="開始";setText("qtStopwatchDisplay","00:00.0");setText("qtSwLaps","ラップ記録はありません。");});
function updateCountdown(){setText("qtTimerDisplay",formatClock(qtCountdownRemaining));if(qtCountdownRemaining<=0){clearInterval(qtCountdownTimer);qtCountdownTimer=null;setText("qtTimerDisplay","時間になりました！");return;}qtCountdownRemaining=Math.max(0,qtCountdownRemaining-1000);}
byId("qtTimerStart")?.addEventListener("click",()=>{clearInterval(qtCountdownTimer);const min=Number(byId("qtTimerMinutes").value),sec=Number(byId("qtTimerSeconds").value);if(!Number.isInteger(min)||min<0||min>999||!Number.isInteger(sec)||sec<0||sec>59){setText("qtTimerDisplay","分・秒を確認してください。");return;}qtCountdownRemaining=(min*60+sec)*1000;if(qtCountdownRemaining<=0){setText("qtTimerDisplay","1秒以上を指定してください。");return;}updateCountdown();qtCountdownTimer=setInterval(updateCountdown,1000);});
byId("qtTimerStop")?.addEventListener("click",()=>{clearInterval(qtCountdownTimer);qtCountdownTimer=null;setText("qtTimerDisplay",`停止：${formatClock(qtCountdownRemaining)}`);});

/* テキスト・リスト */
byId("qtTextCount")?.addEventListener("click",()=>{const t=byId("qtTextInput").value;setText("qtTextResult",`文字数（空白込み）：${t.length}\n文字数（空白除く）：${t.replace(/\s/g,"").length}\n行数：${t? t.split(/\r?\n/).length:0}\n単語数（空白区切り）：${t.trim()?t.trim().split(/\s+/).length:0}`);});
byId("qtTextTrim")?.addEventListener("click",()=>{byId("qtTextInput").value=byId("qtTextInput").value.split(/\r?\n/).map(x=>x.trim().replace(/[ \t]{2,}/g," ")).filter((x,i,a)=>x||i===a.length-1).join("\n");setText("qtTextResult","行頭・行末と連続空白を整理しました。");});
byId("qtTextSort")?.addEventListener("click",()=>{const a=byId("qtTextInput").value.split(/\r?\n/).filter(Boolean).sort((x,y)=>x.localeCompare(y,"ja"));byId("qtTextInput").value=a.join("\n");setText("qtTextResult",`${a.length}行を並べ替えました。`);});
byId("qtTextReverse")?.addEventListener("click",()=>{byId("qtTextInput").value=Array.from(byId("qtTextInput").value).reverse().join("");setText("qtTextResult","文字列を逆順にしました。");});
byId("qtTextReplace")?.addEventListener("click",()=>{const find=byId("qtFindText").value;if(!find){setText("qtTextResult","検索する文字を入力してください。");return;}const t=byId("qtTextInput").value,parts=t.split(find);byId("qtTextInput").value=parts.join(byId("qtReplaceText").value);setText("qtTextResult",`${parts.length-1}か所を置き換えました。`);});
byId("qtDataSummary")?.addEventListener("click",()=>{try{const a=parseNumberList(byId("qtNumberList").value),s=[...a].sort((x,y)=>x-y),sum=a.reduce((x,y)=>x+y,0),mean=sum/a.length,med=s.length%2?s[(s.length-1)/2]:(s[s.length/2-1]+s[s.length/2])/2;setText("qtDataResult",`件数：${a.length}\n合計：${formatNumber(sum)}\n平均：${formatNumber(mean)}\n中央値：${formatNumber(med)}\n最小：${s[0]}\n最大：${s.at(-1)}`);}catch(e){setText("qtDataResult",e.message);}});
byId("qtDataSort")?.addEventListener("click",()=>{try{const a=parseNumberList(byId("qtNumberList").value).sort((x,y)=>x-y);byId("qtNumberList").value=a.join(", ");setText("qtDataResult","昇順に並べ替えました。");}catch(e){setText("qtDataResult",e.message);}});
byId("qtDataUnique")?.addEventListener("click",()=>{try{const a=parseNumberList(byId("qtNumberList").value),b=[...new Set(a)];byId("qtNumberList").value=b.join(", ");setText("qtDataResult",`${a.length-b.length}件の重複を削除しました。\n${b.join(", ")}`);}catch(e){setText("qtDataResult",e.message);}});
byId("qtDataExtremes")?.addEventListener("click",()=>{try{const a=parseNumberList(byId("qtNumberList").value);setText("qtDataResult",`最大値：${Math.max(...a)}\n最小値：${Math.min(...a)}`);}catch(e){setText("qtDataResult",e.message);}});
byId("qtDateStart").value=dateStringLocal(new Date());
byId("qtDateToday")?.addEventListener("click",()=>{byId("qtDateStart").value=dateStringLocal(new Date());setText("qtDateResult","基準日を今日に設定しました。");});
byId("qtDateCalculate")?.addEventListener("click",()=>{try{const date=safeLocalDate(byId("qtDateStart").value),offset=Number(byId("qtDateOffset").value);if(!Number.isInteger(offset)||Math.abs(offset)>100000)throw new Error("日数は±100,000以内の整数にしてください。");const target=new Date(date);target.setDate(target.getDate()+offset);setText("qtDateResult",`${dateStringLocal(date)}（${"日月火水木金土"[date.getDay()]}）\n${offset>=0?"＋":""}${offset}日後・前：${dateStringLocal(target)}（${"日月火水木金土"[target.getDay()]}）`);}catch(e){setText("qtDateResult",e.message);}});

/* ローカルメモ */
function renderNotes(){const host=byId("qtMemoList");if(!host)return;host.replaceChildren();if(!workspaceState.notes.length){host.textContent="保存したメモはありません。";return;}workspaceState.notes.slice().reverse().forEach(note=>{const box=document.createElement("article");box.className="saved-item";const h=document.createElement("h4");h.textContent=note.title;const p=document.createElement("p");p.textContent=note.body;const meta=document.createElement("p");meta.className="help-text";meta.textContent=new Date(note.updatedAt).toLocaleString("ja-JP");const del=document.createElement("button");del.textContent="削除";del.addEventListener("click",()=>{workspaceState.notes=workspaceState.notes.filter(x=>x.id!==note.id);saveWorkspace();renderNotes();});const actions=document.createElement("div");actions.className="saved-actions";actions.append(del);box.append(h,p,meta,actions);host.append(box);});}
byId("qtMemoSave")?.addEventListener("click",()=>{const title=byId("qtMemoTitle").value.trim(),body=byId("qtMemoBody").value.trim();if(!title||!body){setText("qtMemoList","タイトルと内容を入力してください。");return;}workspaceState.notes.push({id:`note-${Date.now()}`,title,body,updatedAt:new Date().toISOString()});workspaceState.notes=workspaceState.notes.slice(-500);saveWorkspace();byId("qtMemoTitle").value="";byId("qtMemoBody").value="";renderNotes();});

/* 実験室：投射運動 */
function drawTrajectory(points){const canvas=byId("labTrajectoryCanvas"),ctx=canvas?.getContext("2d");if(!ctx)return;const w=canvas.width,h=canvas.height;ctx.clearRect(0,0,w,h);ctx.fillStyle=getComputedStyle(document.body).getPropertyValue("--panel").trim()||"#fff";ctx.fillRect(0,0,w,h);ctx.strokeStyle="#90a0b8";ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(36,h-28);ctx.lineTo(w-15,h-28);ctx.stroke();if(!points.length)return;const maxX=Math.max(1,...points.map(p=>p.x)),maxY=Math.max(1,...points.map(p=>p.y));ctx.strokeStyle="#3975d6";ctx.lineWidth=3;ctx.beginPath();points.forEach((p,i)=>{const x=36+p.x/(maxX||1)*(w-60),y=h-28-p.y/(maxY||1)*(h-55);if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);});ctx.stroke();}
byId("labSimulate")?.addEventListener("click",()=>{try{const v=Number(byId("labVelocity").value),deg=Number(byId("labAngle").value),h0=Number(byId("labHeight").value),g=Number(byId("labGravity").value);if(![v,deg,h0,g].every(Number.isFinite)||v<0||h0<0||g<=0||deg<=-90||deg>=90)throw new Error("入力範囲を確認してください。");const rad=deg*Math.PI/180,vx=v*Math.cos(rad),vy=v*Math.sin(rad),time=(vy+Math.sqrt(vy*vy+2*g*h0))/g,range=Math.max(0,vx*time),peak=h0+vy>0?h0+vy*vy/(2*g):h0,steps=100,pts=[];for(let i=0;i<=steps;i++){const t=time*i/steps;pts.push({x:vx*t,y:Math.max(0,h0+vy*t-.5*g*t*t)});}drawTrajectory(pts);setText("labSimulationResult",`飛行時間：約${formatNumber(time)} s\n水平到達距離：約${formatNumber(range)} m\n最高点：約${formatNumber(peak)} m\n水平速度：${formatNumber(vx)} m/s\n鉛直初速度：${formatNumber(vy)} m/s\n\n※空気抵抗を無視した放物運動の理想モデルです。`);}catch(e){setText("labSimulationResult",e.message);}});


/* =========================================================
   V9 CAD設計スタジオ
   - 寸法比を反映した基本立体メッシュ
   - 複数パーツ、配置、回転・ズーム、正投影表示
   - STL / OBJ / 3面図SVG / JSON出力
   ========================================================= */
const CAD_STORAGE_KEY = "aurora-v9-cad-scene-v1";
let cadObjects = readSaved(CAD_STORAGE_KEY, []);
if (!Array.isArray(cadObjects)) cadObjects = [];
cadObjects = cadObjects.filter(o => o && typeof o.id === "string" && ["cube","box","sphere","cylinder","cone"].includes(o.shape) && o.dims && o.position).slice(0,200);
if (!cadObjects.length) cadObjects = [{id:"cad-sample-box",name:"サンプル直方体",shape:"box",dims:{a:8,b:5,c:3},position:{x:0,y:0,z:0}}];
let cadSelectedId = cadObjects[0]?.id || null;
let cadRotation = { yaw:-0.72, pitch:0.62 };
let cadZoom = 1;
let cadDragState = null;
function cadNum(v, fallback=0) { const n=Number(v); return Number.isFinite(n)?n:fallback; }
function cadMesh(object) {
  const {a,b,c}=object.dims; const v=[], f=[];
  const add=(x,y,z)=>{v.push([x,y,z]);return v.length-1;};
  const quad=(p,q,r,s)=>{f.push([p,q,r],[p,r,s]);};
  if(object.shape==="cube"||object.shape==="box") {
    const x=(object.shape==="cube"?a:a)/2, y=(object.shape==="cube"?a:b)/2, z=(object.shape==="cube"?a:c)/2;
    [[-x,-y,-z],[x,-y,-z],[x,y,-z],[-x,y,-z],[-x,-y,z],[x,-y,z],[x,y,z],[-x,y,z]].forEach(p=>add(...p));
    quad(0,1,2,3);quad(4,7,6,5);quad(0,4,5,1);quad(1,5,6,2);quad(2,6,7,3);quad(3,7,4,0);
  } else if(object.shape==="sphere") {
    const r=a, lat=16, lon=32;
    for(let i=0;i<=lat;i++){const theta=-Math.PI/2+Math.PI*i/lat;for(let j=0;j<lon;j++){const phi=2*Math.PI*j/lon;add(r*Math.cos(theta)*Math.cos(phi),r*Math.cos(theta)*Math.sin(phi),r*Math.sin(theta));}}
    for(let i=0;i<lat;i++)for(let j=0;j<lon;j++){const n=(j+1)%lon,p=i*lon+j,q=i*lon+n,r0=(i+1)*lon+n,s=(i+1)*lon+j;f.push([p,q,r0],[p,r0,s]);}
  } else {
    const radius=a,height=c,segments=48;
    for(let j=0;j<segments;j++){const t=2*Math.PI*j/segments;add(radius*Math.cos(t),radius*Math.sin(t),-height/2);}
    if(object.shape==="cylinder")for(let j=0;j<segments;j++){const t=2*Math.PI*j/segments;add(radius*Math.cos(t),radius*Math.sin(t),height/2);}
    if(object.shape==="cone")add(0,0,height/2);
    const bottomCenter=add(0,0,-height/2);
    if(object.shape==="cylinder"){
      const topCenter=add(0,0,height/2);
      for(let j=0;j<segments;j++){const n=(j+1)%segments;f.push([j,n,segments+n],[j,segments+n,segments+j]);f.push([bottomCenter,n,j],[topCenter,segments+j,segments+n]);}
    } else {
      const tip=segments;
      for(let j=0;j<segments;j++){const n=(j+1)%segments;f.push([j,n,tip],[bottomCenter,n,j]);}
    }
  }
  return {vertices:v,faces:f};
}
function cadTransformPoint(p, rot, center, scale) {
  const [x,y,z]=p, cy=Math.cos(rot.yaw), sy=Math.sin(rot.yaw), cp=Math.cos(rot.pitch), sp=Math.sin(rot.pitch);
  const xx=x*cy-y*sy, yy=x*sy+y*cy;
  const vertical=z*cp-yy*sp, depth=z*sp+yy*cp;
  return {x:center.x+xx*scale,y:center.y-vertical*scale,depth};
}
function cadRenderCanvas(canvas, objects, options={}) {
  const ctx=canvas?.getContext("2d"); if(!ctx)return;
  const w=canvas.width,h=canvas.height,rot=options.rotation||cadRotation,zoom=options.zoom??cadZoom;
  const dark=document.body.classList.contains("dark");
  ctx.clearRect(0,0,w,h);ctx.fillStyle=dark?"#111b2a":"#f7faff";ctx.fillRect(0,0,w,h);
  // soft reference grid on the ground plane
  ctx.save();ctx.strokeStyle=dark?"rgba(160,185,220,.12)":"rgba(92,125,170,.13)";ctx.lineWidth=1;
  for(let i=-10;i<=10;i++){const a=cadTransformPoint([i*5,-50,0],rot,{x:w/2,y:h/2+40},Math.min(w,h)/220),b=cadTransformPoint([i*5,50,0],rot,{x:w/2,y:h/2+40},Math.min(w,h)/220),c=cadTransformPoint([-50,i*5,0],rot,{x:w/2,y:h/2+40},Math.min(w,h)/220),d=cadTransformPoint([50,i*5,0],rot,{x:w/2,y:h/2+40},Math.min(w,h)/220);ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.moveTo(c.x,c.y);ctx.lineTo(d.x,d.y);ctx.stroke();}ctx.restore();
  if(!objects.length){ctx.fillStyle=dark?"#d8e4f7":"#52647d";ctx.font="20px sans-serif";ctx.textAlign="center";ctx.fillText("パーツを追加してください",w/2,h/2);return;}
  let extent=1;objects.forEach(o=>{const m=cadMesh(o);m.vertices.forEach(p=>{extent=Math.max(extent,Math.abs(p[0]+cadNum(o.position.x)),Math.abs(p[1]+cadNum(o.position.y)),Math.abs(p[2]+cadNum(o.position.z)));});});
  const scale=Math.min(w,h)*0.055*zoom,center={x:w/2,y:h/2+30};
  const triangles=[];
  objects.forEach((o,oi)=>{const mesh=cadMesh(o),pos=o.position||{x:0,y:0,z:0};const world=mesh.vertices.map(p=>[p[0]+cadNum(pos.x),p[1]+cadNum(pos.y),p[2]+cadNum(pos.z)]);mesh.faces.forEach((face,fi)=>{const points=face.map(i=>cadTransformPoint(world[i],rot,center,scale));triangles.push({points,depth:points.reduce((s,p)=>s+p.depth,0)/points.length,oi,fi,selected:o.id===cadSelectedId});});});
  triangles.sort((a,b)=>a.depth-b.depth);
  triangles.forEach(t=>{const shade=Math.max(0,Math.min(1,(t.depth/Math.max(1,extent*2))+0.5));ctx.beginPath();ctx.moveTo(t.points[0].x,t.points[0].y);t.points.slice(1).forEach(p=>ctx.lineTo(p.x,p.y));ctx.closePath();const hue= t.selected?210:201,light=dark?Math.round(27+shade*18):Math.round(78-shade*13);ctx.fillStyle=`hsla(${hue},${t.selected?72:58}%,${light}%,0.86)`;ctx.strokeStyle=t.selected?(dark?"#f7c873":"#1d4f9a"):(dark?"rgba(215,230,250,.65)":"rgba(41,78,125,.62)");ctx.lineWidth=t.selected?2.2:1.1;ctx.fill();ctx.stroke();});
  // XYZ axis marker
  const origin=cadTransformPoint([0,0,0],rot,center,scale),axes=[[[1,0,0],"X","#e05252"],[[0,1,0],"Y","#20a46b"],[[0,0,1],"Z","#397de0"]];
  axes.forEach(([vec,label,color])=>{const p=cadTransformPoint(vec.map(v=>v*2),rot,center,scale);ctx.strokeStyle=color;ctx.fillStyle=color;ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(origin.x,origin.y);ctx.lineTo(p.x,p.y);ctx.stroke();ctx.font="bold 16px sans-serif";ctx.fillText(label,p.x+6,p.y-4);});
  ctx.fillStyle=dark?"#dce8f8":"#42546d";ctx.font="14px sans-serif";ctx.textAlign="left";ctx.fillText(`パーツ ${objects.length}個  |  ズーム ${cadZoom.toFixed(2)}×`,14,24);
}
function cadSaveScene(){saveValue(CAD_STORAGE_KEY,cadObjects);}
function cadSelected(){return cadObjects.find(o=>o.id===cadSelectedId)||null;}
function cadShapeLabel(shape){return ({cube:"立方体",box:"直方体",sphere:"球",cylinder:"円柱",cone:"円錐"})[shape]||shape;}
function cadRefreshSelect(){const select=byId("cadObjectSelect");if(!select)return;const old=cadSelectedId;select.replaceChildren();cadObjects.forEach((o,i)=>select.add(new Option(`${i+1}. ${o.name}（${cadShapeLabel(o.shape)}）`,o.id)));if(cadObjects.some(o=>o.id===old))select.value=old;else if(cadObjects.length){cadSelectedId=cadObjects[0].id;select.value=cadSelectedId;}else cadSelectedId=null;}
function cadFillForm(o){if(!o)return;byId("cadObjectName").value=o.name||"パーツ";byId("cadShape").value=o.shape;byId("cadDimA").value=o.dims.a;byId("cadDimB").value=o.dims.b;byId("cadDimC").value=o.dims.c;byId("cadPosX").value=o.position.x;byId("cadPosY").value=o.position.y;byId("cadPosZ").value=o.position.z;cadUpdateLabels();cadUpdateInfo();}
function cadUpdateLabels(){const shape=byId("cadShape")?.value||"box";byId("cadLabelA").textContent=shape==="sphere"?"半径 r":(shape==="cylinder"||shape==="cone"?"半径 r":"幅 X／辺 a");byId("cadLabelB").textContent=shape==="cube"?"未使用":(shape==="sphere"||shape==="cylinder"||shape==="cone"?"未使用":"奥行 Y／辺 b");byId("cadLabelC").textContent=shape==="sphere"?"未使用":"高さ Z／辺 c";}
function cadReadForm(){const shape=byId("cadShape").value,a=Number(byId("cadDimA").value),b=Number(byId("cadDimB").value),c=Number(byId("cadDimC").value),x=Number(byId("cadPosX").value),y=Number(byId("cadPosY").value),z=Number(byId("cadPosZ").value);if(![a,b,c,x,y,z].every(Number.isFinite)||a<=0||((shape==="box")&&b<=0)||((shape==="box"||shape==="cylinder"||shape==="cone")&&c<=0))throw new Error("寸法は0より大きい有限数、配置位置は有限数で入力してください。");return {name:byId("cadObjectName").value.trim()||"無名パーツ",shape,dims:{a,b:shape==="cube"?a:b,c:shape==="cube"?a:c},position:{x,y,z}};}
function cadSolidMetrics(o){const {a,b,c}=o.dims;if(o.shape==="cube")return {v:a**3,s:6*a*a};if(o.shape==="box")return {v:a*b*c,s:2*(a*b+b*c+c*a)};if(o.shape==="sphere")return {v:4*Math.PI*a**3/3,s:4*Math.PI*a*a};if(o.shape==="cylinder")return {v:Math.PI*a*a*c,s:2*Math.PI*a*(a+c)};return {v:Math.PI*a*a*c/3,s:Math.PI*a*(a+Math.sqrt(a*a+c*c))};}
function cadUpdateInfo(){const o=cadSelected(),host=byId("cadObjectInfo");if(!host)return;if(!o){host.textContent="パーツがありません。新しいパーツを追加してください。";return;}const m=cadSolidMetrics(o);host.textContent=`${o.name}（${cadShapeLabel(o.shape)}）\n寸法：A=${o.dims.a}、B=${o.dims.b}、C=${o.dims.c}\n配置：X=${o.position.x}、Y=${o.position.y}、Z=${o.position.z}\n体積：約${formatNumber(m.v)}\n表面積：約${formatNumber(m.s)}\n※すべて入力した設計単位による値。`;}
function cadRefresh(){cadRefreshSelect();cadRenderCanvas(byId("cadCanvas"),cadObjects);cadUpdateInfo();cadSaveScene();}
function cadDownload(name,content,mime){downloadText(name,content,mime);}
function cadExportSTL(){if(!cadObjects.length)throw new Error("出力するパーツがありません。");const lines=["solid aurora_v9"];cadObjects.forEach(o=>{const m=cadMesh(o),p=o.position;for(const f of m.faces){const v=f.map(i=>m.vertices[i].map((n,k)=>n+cadNum([p.x,p.y,p.z][k])));const ab=v[1].map((n,k)=>n-v[0][k]),ac=v[2].map((n,k)=>n-v[0][k]);let nx=ab[1]*ac[2]-ab[2]*ac[1],ny=ab[2]*ac[0]-ab[0]*ac[2],nz=ab[0]*ac[1]-ab[1]*ac[0],l=Math.hypot(nx,ny,nz)||1;nx/=l;ny/=l;nz/=l;lines.push(` facet normal ${nx} ${ny} ${nz}`,"  outer loop",...v.map(q=>`   vertex ${q[0]} ${q[1]} ${q[2]}`),"  endloop"," endfacet");}});lines.push("endsolid aurora_v9");cadDownload("aurora-cad-model.stl",lines.join("\n"),"model/stl");}
function cadExportOBJ(){if(!cadObjects.length)throw new Error("出力するパーツがありません。");const out=["# Aurora CAD Studio V9 OBJ"];let offset=1;cadObjects.forEach(o=>{const m=cadMesh(o),p=o.position;out.push(`o ${String(o.name).replace(/\s+/g,"_")}`);m.vertices.forEach(v=>out.push(`v ${v[0]+p.x} ${v[1]+p.y} ${v[2]+p.z}`));m.faces.forEach(f=>out.push(`f ${f.map(i=>i+offset).join(" ")}`));offset+=m.vertices.length;});cadDownload("aurora-cad-model.obj",out.join("\n"),"text/plain");}
function cadExportJSON(){cadDownload("aurora-cad-scene.json",JSON.stringify({format:"aurora-cad-scene",version:1,objects:cadObjects},null,2),"application/json");}
function cadExportSVG(){const o=cadSelected();if(!o)throw new Error("3面図にするパーツを選択してください。");const m=cadMesh(o),p=o.position;const views=[{name:"正面図",xy:v=>[v[0]+p.x,v[2]+p.z]},{name:"上面図",xy:v=>[v[0]+p.x,v[1]+p.y]},{name:"右側面図",xy:v=>[v[1]+p.y,v[2]+p.z]}];let svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="420" viewBox="0 0 1200 420"><rect width="100%" height="100%" fill="white"/><style>text{font-family:sans-serif;fill:#23344d}.edge{stroke:#243e63;stroke-width:1.5;fill:none}</style><text x="24" y="28" font-size="18">Aurora CAD V9 — ${o.name} — 寸法単位は設計入力単位</text>`;views.forEach((vw,vi)=>{const pts=m.vertices.map(v=>vw.xy(v)),xs=pts.map(p=>p[0]),ys=pts.map(p=>p[1]),minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys),sc=Math.min(280/Math.max(1e-9,maxX-minX),245/Math.max(1e-9,maxY-minY)),cx=vi*400+200,cy=230;const map=q=>[cx+(q[0]-(minX+maxX)/2)*sc,cy-(q[1]-(minY+maxY)/2)*sc];svg+=`<text x="${vi*400+200}" y="62" font-size="17" text-anchor="middle">${vw.name}</text>`;const edges=new Set();m.faces.forEach(f=>{for(let i=0;i<f.length;i++){const a=f[i],b=f[(i+1)%f.length],key=a<b?`${a}-${b}`:`${b}-${a}`;if(edges.has(key))continue;edges.add(key);const A=map(pts[a]),B=map(pts[b]);svg+=`<line class="edge" x1="${A[0]}" y1="${A[1]}" x2="${B[0]}" y2="${B[1]}"/>`;}});svg+=`<text x="${vi*400+200}" y="390" font-size="13" text-anchor="middle">${o.shape}: A=${o.dims.a}, B=${o.dims.b}, C=${o.dims.c}</text>`;});svg+="</svg>";cadDownload("aurora-cad-3views.svg",svg,"image/svg+xml");}
function cadSetView(view){if(view==="front")cadRotation={yaw:0,pitch:0};else if(view==="top")cadRotation={yaw:0,pitch:Math.PI/2};else if(view==="side")cadRotation={yaw:Math.PI/2,pitch:0};else cadRotation={yaw:-0.72,pitch:0.62};cadRenderCanvas(byId("cadCanvas"),cadObjects);}
function cadInit(){if(!byId("cadCanvas"))return;cadRefreshSelect();cadFillForm(cadSelected());cadRenderCanvas(byId("cadCanvas"),cadObjects);
  byId("cadObjectSelect").addEventListener("change",()=>{cadSelectedId=byId("cadObjectSelect").value;cadFillForm(cadSelected());cadRenderCanvas(byId("cadCanvas"),cadObjects);});
  byId("cadShape").addEventListener("change",cadUpdateLabels);
  byId("cadAddObject").addEventListener("click",()=>{try{const data=cadReadForm();data.id=`cad-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;cadObjects.push(data);cadSelectedId=data.id;cadFillForm(data);cadRefresh();byId("cadMessage").textContent=`「${data.name}」を追加しました。`;}catch(e){byId("cadMessage").textContent=e.message;}});
  byId("cadUpdateObject").addEventListener("click",()=>{try{const old=cadSelected();if(!old)throw new Error("更新するパーツを選択してください。");const next=cadReadForm();Object.assign(old,next);cadRefresh();byId("cadMessage").textContent="選択パーツを更新しました。";}catch(e){byId("cadMessage").textContent=e.message;}});
  byId("cadDeleteObject").addEventListener("click",()=>{cadObjects=cadObjects.filter(o=>o.id!==cadSelectedId);cadSelectedId=cadObjects[0]?.id||null;cadRefreshSelect();cadFillForm(cadSelected());cadRefresh();byId("cadMessage").textContent="選択パーツを削除しました。";});
  byId("cadFitView").addEventListener("click",()=>{let extent=1;cadObjects.forEach(o=>{const m=cadMesh(o);m.vertices.forEach(p=>{extent=Math.max(extent,Math.abs(p[0]+cadNum(o.position.x)),Math.abs(p[1]+cadNum(o.position.y)),Math.abs(p[2]+cadNum(o.position.z)));});});const canvas=byId("cadCanvas");cadZoom=Math.max(.05,Math.min(4,Math.min(canvas.width,canvas.height)*.34/(extent*Math.min(canvas.width,canvas.height)*.055)));cadRenderCanvas(canvas,cadObjects);});
  document.querySelectorAll("[data-cad-view]").forEach(b=>b.addEventListener("click",()=>cadSetView(b.dataset.cadView)));
  const canvas=byId("cadCanvas");canvas.addEventListener("pointerdown",e=>{cadDragState={x:e.clientX,y:e.clientY,yaw:cadRotation.yaw,pitch:cadRotation.pitch};canvas.setPointerCapture?.(e.pointerId);});
  canvas.addEventListener("pointermove",e=>{if(!cadDragState)return;const dx=e.clientX-cadDragState.x,dy=e.clientY-cadDragState.y;cadRotation.yaw=cadDragState.yaw+dx*.009;cadRotation.pitch=Math.max(-1.48,Math.min(1.48,cadDragState.pitch+dy*.009));cadRenderCanvas(canvas,cadObjects);});
  ["pointerup","pointercancel","lostpointercapture"].forEach(type=>canvas.addEventListener(type,()=>{cadDragState=null;}));
  canvas.addEventListener("wheel",e=>{e.preventDefault();cadZoom=Math.max(.25,Math.min(4,cadZoom*(e.deltaY<0?1.12:.89)));cadRenderCanvas(canvas,cadObjects);},{passive:false});
  byId("cadExportStl").addEventListener("click",()=>{try{cadExportSTL();byId("cadMessage").textContent="STLファイルを作成しました。";}catch(e){byId("cadMessage").textContent=e.message;}});
  byId("cadExportObj").addEventListener("click",()=>{try{cadExportOBJ();byId("cadMessage").textContent="OBJファイルを作成しました。";}catch(e){byId("cadMessage").textContent=e.message;}});
  byId("cadExportSvg").addEventListener("click",()=>{try{cadExportSVG();byId("cadMessage").textContent="選択パーツの3面図SVGを作成しました。";}catch(e){byId("cadMessage").textContent=e.message;}});
  byId("cadExportJson").addEventListener("click",cadExportJSON);
  byId("cadImportJsonButton").addEventListener("click",()=>byId("cadImportJson").click());
  byId("cadImportJson").addEventListener("change",async e=>{const file=e.target.files?.[0];if(!file)return;try{if(file.size>2*1024*1024)throw new Error("設計JSONは2MB以下にしてください。");const data=JSON.parse(await file.text());if(data.format!=="aurora-cad-scene"||!Array.isArray(data.objects))throw new Error("Aurora CADの設計JSONではありません。");const valid=data.objects.filter(o=>o&&typeof o.name==="string"&&["cube","box","sphere","cylinder","cone"].includes(o.shape)&&o.dims&&o.position&&[o.dims.a,o.dims.b,o.dims.c,o.position.x,o.position.y,o.position.z].every(v=>Number.isFinite(Number(v)))&&Number(o.dims.a)>0).slice(0,200);if(!valid.length)throw new Error("有効なパーツがありません。");cadObjects=valid.map((o,i)=>({...o,id:`cad-import-${Date.now()}-${i}`}));cadSelectedId=cadObjects[0].id;cadFillForm(cadSelected());cadRefresh();byId("cadMessage").textContent=`${cadObjects.length}個のパーツを読み込みました。`;}catch(err){byId("cadMessage").textContent=err.message;}finally{e.target.value="";}});
}
cadInit();

/* 3D・立体計算の模式描画 */
function drawSolidShape(type){const canvas=byId("labSolidCanvas");if(!canvas)return;const a=Math.max(.001,Number(byId("labDimA")?.value)||5),b=Math.max(.001,Number(byId("labDimB")?.value)||4),c=Math.max(.001,Number(byId("labDimC")?.value)||3);const obj={id:"lab-preview",name:"プレビュー",shape:type,dims:{a,b,c},position:{x:0,y:0,z:0}};cadRenderCanvas(canvas,[obj],{rotation:{yaw:-0.72,pitch:0.62},zoom:1});}
byId("labSolidCalc")?.addEventListener("click",()=>{try{const type=byId("labSolid").value,a=Number(byId("labDimA").value),b=Number(byId("labDimB").value),c=Number(byId("labDimC").value);if(![a,b,c].every(Number.isFinite)||a<=0||b<=0||c<=0)throw new Error("寸法は0より大きい数値にしてください。");let volume=0,area=0,desc="";if(type==="cube"){volume=a**3;area=6*a*a;desc=`辺 ${a}`;}if(type==="box"){volume=a*b*c;area=2*(a*b+b*c+c*a);desc=`辺 ${a}, ${b}, ${c}`;}if(type==="sphere"){volume=4*Math.PI*a**3/3;area=4*Math.PI*a*a;desc=`半径 ${a}`;}if(type==="cylinder"){volume=Math.PI*a*a*c;area=2*Math.PI*a*(a+c);desc=`半径 ${a}, 高さ ${c}`;}if(type==="cone"){volume=Math.PI*a*a*c/3;area=Math.PI*a*(a+Math.sqrt(a*a+c*c));desc=`半径 ${a}, 高さ ${c}`;}drawSolidShape(type);setText("labSolidResult",`${desc}\n体積：約${formatNumber(volume)}\n表面積：約${formatNumber(area)}\n※単位は入力した寸法単位の³／²です。`);}catch(e){setText("labSolidResult",e.message);}});
byId("labSolid")?.addEventListener("change",()=>drawSolidShape(byId("labSolid").value));["labDimA","labDimB","labDimC"].forEach(id=>byId(id)?.addEventListener("input",()=>drawSolidShape(byId("labSolid").value)));drawSolidShape("cube");

/* データ分析・回帰 */
byId("dataLabAnalyze")?.addEventListener("click",()=>{try{const a=parseNumberList(byId("dataLabValues").value),s=[...a].sort((x,y)=>x-y),mean=a.reduce((x,y)=>x+y,0)/a.length,variance=a.reduce((x,y)=>x+(y-mean)**2,0)/a.length,median=s.length%2?s[(s.length-1)/2]:(s[s.length/2-1]+s[s.length/2])/2;const freq=new Map();a.forEach(x=>freq.set(x,(freq.get(x)||0)+1));const maxFreq=Math.max(...freq.values()),modes=[...freq].filter(([,n])=>n===maxFreq).map(([x])=>x);const q1=s[Math.floor((s.length-1)*.25)],q3=s[Math.floor((s.length-1)*.75)],iqr=q3-q1,outliers=a.filter(x=>x<q1-1.5*iqr||x>q3+1.5*iqr);setText("dataLabStats",`件数：${a.length}\n合計：${formatNumber(a.reduce((x,y)=>x+y,0))}\n平均：${formatNumber(mean)}\n中央値：${formatNumber(median)}\n最頻値：${maxFreq>1?modes.join(", "):"なし"}\n母分散：${formatNumber(variance)}\n母標準偏差：${formatNumber(Math.sqrt(variance))}\n最小／最大：${s[0]} ／ ${s.at(-1)}\n範囲：${formatNumber(s.at(-1)-s[0])}\n四分位範囲 IQR：${formatNumber(iqr)}\n外れ値候補（1.5×IQR法）：${outliers.length?outliers.join(", "):"なし"}`);}catch(e){setText("dataLabStats",e.message);}});
byId("dataLabRegression")?.addEventListener("click",()=>{try{const rows=byId("dataLabPairs").value.trim().split(/\r?\n/).filter(Boolean).map(line=>line.split(/[\s,;、]+/).map(Number));if(rows.length<2||rows.some(r=>r.length!==2||!r.every(Number.isFinite)))throw new Error("x,yの数値ペアを2組以上入力してください。");const xs=rows.map(r=>r[0]),ys=rows.map(r=>r[1]),mx=xs.reduce((a,b)=>a+b,0)/xs.length,my=ys.reduce((a,b)=>a+b,0)/ys.length;let xx=0,yy=0,xy=0;rows.forEach(([x,y])=>{xx+=(x-mx)**2;yy+=(y-my)**2;xy+=(x-mx)*(y-my);});if(xx===0||yy===0)throw new Error("相関係数を計算するにはx・yにばらつきが必要です。");const slope=xy/xx,intercept=my-slope*mx,r=xy/Math.sqrt(xx*yy);setText("dataLabRegressionResult",`データ数：${rows.length}\n回帰直線：y = ${formatNumber(slope)}x + ${formatNumber(intercept)}\n相関係数 r：${formatNumber(r)}\n決定係数 R²：${formatNumber(r*r)}\n※単純な最小二乗法による線形回帰です。`);}catch(e){setText("dataLabRegressionResult",e.message);}});

/* グラフ可視化 */
let latestVizValues=[];
function drawViz(){const values=parseNumberList(byId("vizData").value);if(values.length>500)throw new Error("グラフは500点以内にしてください。");latestVizValues=values;const canvas=byId("vizCanvas"),ctx=canvas.getContext("2d"),w=canvas.width,h=canvas.height;ctx.clearRect(0,0,w,h);ctx.fillStyle="#ffffff";ctx.fillRect(0,0,w,h);ctx.fillStyle="#17243a";ctx.font="bold 20px sans-serif";ctx.fillText(byId("vizTitle").value||"データグラフ",24,30);const min=Math.min(0,...values),max=Math.max(1,...values),range=max-min||1,left=48,right=w-20,top=60,bottom=h-40;ctx.strokeStyle="#aab6c7";ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(left,top);ctx.lineTo(left,bottom);ctx.lineTo(right,bottom);ctx.stroke();const xAt=i=>left+(values.length===1?0:i/(values.length-1))*(right-left),yAt=v=>bottom-(v-min)/range*(bottom-top);const type=byId("vizType").value;if(type==="bar"){const gap=4,bw=Math.max(2,(right-left)/values.length-gap);values.forEach((v,i)=>{ctx.fillStyle="#4d83d8";const y0=yAt(0),yv=yAt(v);ctx.fillRect(left+i*(right-left)/values.length+gap/2,Math.min(y0,yv),bw,Math.max(1,Math.abs(y0-yv)));});}else{ctx.strokeStyle="#3975d6";ctx.lineWidth=3;ctx.beginPath();values.forEach((v,i)=>{const x=xAt(i),y=yAt(v);if(type==="line"){i?ctx.lineTo(x,y):ctx.moveTo(x,y);}else{ctx.moveTo(x+4,y);ctx.arc(x,y,4,0,Math.PI*2);}});if(type==="line")ctx.stroke();else{ctx.fillStyle="#3975d6";ctx.fill();}}ctx.fillStyle="#526176";ctx.font="12px sans-serif";ctx.fillText(`最小 ${min}`,left,bottom+20);ctx.fillText(`最大 ${max}`,left,top-8);setText("vizMessage",`${values.length}点を描画しました。`);}
byId("vizDraw")?.addEventListener("click",()=>{try{drawViz();}catch(e){setText("vizMessage",e.message);}});
byId("vizDownload")?.addEventListener("click",()=>{const c=byId("vizCanvas");if(!latestVizValues.length){setText("vizMessage","先にグラフを描いてください。");return;}const a=document.createElement("a");a.download=`aurora-chart-${timestampForFile()}.png`;a.href=c.toDataURL("image/png");a.click();});

/* アクセシビリティ設定 */
const ACCESSIBILITY_KEY = "aurora-accessibility-settings-v1";
const defaultAccessibility = { textScale:1, highContrast:false, largeTargets:false, reduceMotion:false, strongFocus:true, underlineLinks:false };
function applyAccessibilitySettings(data={}){const a={...defaultAccessibility,...data};document.body.style.setProperty("--access-font-scale",String(Math.max(.9,Math.min(1.5,Number(a.textScale)||1))));document.body.classList.toggle("access-high-contrast",!!a.highContrast);document.body.classList.toggle("access-large-targets",!!a.largeTargets);document.body.classList.toggle("access-reduce-motion",!!a.reduceMotion);document.body.classList.toggle("access-strong-focus",!!a.strongFocus);document.body.classList.toggle("access-underline-links",!!a.underlineLinks);if(byId("accessTextScale"))byId("accessTextScale").value=String(a.textScale);if(byId("accessTextScaleValue"))byId("accessTextScaleValue").textContent=`${Math.round(a.textScale*100)}%`;for(const [field,key] of [["accessHighContrast","highContrast"],["accessLargeTargets","largeTargets"],["accessReduceMotion","reduceMotion"],["accessStrongFocus","strongFocus"],["accessUnderlineLinks","underlineLinks"]])if(byId(field))byId(field).checked=!!a[key];}
workspaceState.accessibility={...defaultAccessibility,...readSaved(ACCESSIBILITY_KEY,workspaceState.accessibility||{})};
function saveAccessibility(){const a={textScale:Number(byId("accessTextScale").value),highContrast:byId("accessHighContrast").checked,largeTargets:byId("accessLargeTargets").checked,reduceMotion:byId("accessReduceMotion").checked,strongFocus:byId("accessStrongFocus").checked,underlineLinks:byId("accessUnderlineLinks").checked};workspaceState.accessibility=a;saveWorkspace();saveValue(ACCESSIBILITY_KEY,a);applyAccessibilitySettings(a);}
["accessTextScale","accessHighContrast","accessLargeTargets","accessReduceMotion","accessStrongFocus","accessUnderlineLinks"].forEach(id=>byId(id)?.addEventListener("input",saveAccessibility));
byId("accessReset")?.addEventListener("click",()=>{workspaceState.accessibility={...defaultAccessibility};saveValue(ACCESSIBILITY_KEY,workspaceState.accessibility);saveWorkspace();applyAccessibilitySettings(workspaceState.accessibility);});
applyAccessibilitySettings(workspaceState.accessibility);

/* 起動時に復元する公開版のローカルメモ */
renderNotes();

/* 印刷時は現在のタブだけを出力 */


/* V9: 追加した数学データを表示へ反映 */
refreshNumericSelectors();
renderDatabase();
renderNumericDatabase();
