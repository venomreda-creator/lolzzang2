"use strict";

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const ALLOWED_QUEUE_IDS = new Set([420, 440, 400, 430, 490]);
const RIOT_ROUTING = "https://asia.api.riotgames.com";
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_MATCHES_PER_ACCOUNT = 500;
const MATCH_PAGE_SIZE = 100;
const CDRAGON_ROOT = "https://raw.communitydragon.org/latest";
const CDRAGON_STRINGTABLE_URL = `${CDRAGON_ROOT}/game/ko_kr/data/menu/en_us/lol.stringtable.json`;
const CDRAGON_PASSIVE_CACHE_TTL_MS = 60 * 60 * 1000;

loadDotEnv(path.join(ROOT, ".env"));

const cache = new Map();
const cdragonPassiveCache = new Map();
let cdragonStringEntriesPromise = null;
let currentCacheWeek = currentWeekKey();

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const contents = fs.readFileSync(filePath, "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || Object.prototype.hasOwnProperty.call(process.env, match[1])) continue;
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    process.env[match[1]] = value;
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

function getKstWeekBounds(now = Date.now()) {
  const shifted = new Date(now + 9 * 60 * 60 * 1000);
  const weekday = shifted.getUTCDay();
  const daysSinceMonday = (weekday + 6) % 7;
  const kstMidnightAsUtc = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() - daysSinceMonday,
  );
  const start = kstMidnightAsUtc - 9 * 60 * 60 * 1000;
  return { start, end: start + 7 * 24 * 60 * 60 * 1000 };
}

function kstDateKey(timestamp) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function currentWeekKey() {
  return String(getKstWeekBounds().start);
}

function clearCacheAfterWeekChange() {
  const nextWeek = currentWeekKey();
  if (nextWeek !== currentCacheWeek) {
    cache.clear();
    currentCacheWeek = nextWeek;
  }
}

function scheduleCacheReset() {
  const { end } = getKstWeekBounds();
  const timer = setTimeout(() => {
    cache.clear();
    currentCacheWeek = currentWeekKey();
    scheduleCacheReset();
  }, Math.max(1000, end - Date.now() + 100));
  timer.unref?.();
}

function cachedValue(key) {
  clearCacheAfterWeekChange();
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function setCachedValue(key, value) {
  clearCacheAfterWeekChange();
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

async function fetchCommunityJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error("CommunityDragon 데이터를 가져오지 못했습니다.");
  return response.json();
}

async function getCdragonStringEntries() {
  if (!cdragonStringEntriesPromise) {
    cdragonStringEntriesPromise = fetchCommunityJson(CDRAGON_STRINGTABLE_URL)
      .then((data) => {
        if (!data?.entries || typeof data.entries !== "object") {
          throw new Error("한국어 게임 문자열을 읽지 못했습니다.");
        }
        return data.entries;
      })
      .catch((error) => {
        cdragonStringEntriesPromise = null;
        throw error;
      });
  }
  return cdragonStringEntriesPromise;
}

function normalizedLabel(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .toLocaleLowerCase();
}

function getTooltipEntry(entries, key) {
  if (typeof key !== "string" || !key) return "";
  const value = entries[key.toLowerCase()];
  return typeof value === "string" ? value : "";
}

function findPassiveSpell(bin, passiveName, stringEntries) {
  const candidates = Object.entries(bin)
    .map(([pathName, object]) => {
      const tooltipData = object?.mSpell?.mClientData?.mTooltipData;
      const locKeys = tooltipData?.mLocKeys;
      if (!locKeys) return null;
      const localizedName = getTooltipEntry(stringEntries, locKeys.keyName);
      return { pathName, object, locKeys, localizedName };
    })
    .filter(Boolean);

  const expectedName = normalizedLabel(passiveName);
  const matchingNames = candidates.filter(
    (candidate) => expectedName && normalizedLabel(candidate.localizedName) === expectedName,
  );
  const preferred = matchingNames.length
    ? matchingNames
    : candidates.filter((candidate) => /passive/i.test(candidate.pathName));
  preferred.sort((left, right) => {
    const leftScore = Number(/passiveability/i.test(left.pathName)) * 2 +
      Number(/passive(marker|icon|ability)?$/i.test(left.object?.ObjectName || ""));
    const rightScore = Number(/passiveability/i.test(right.pathName)) * 2 +
      Number(/passive(marker|icon|ability)?$/i.test(right.object?.ObjectName || ""));
    return rightScore - leftScore;
  });
  return preferred[0] || null;
}

function expandLocalizedReferences(text, stringEntries, depth = 0, visited = new Set()) {
  if (depth > 5 || typeof text !== "string") return text || "";
  return text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, rawKey) => {
    const key = String(rawKey).trim().toLowerCase();
    if (visited.has(key)) return "";
    const referenced = stringEntries[key];
    if (typeof referenced !== "string") return "";
    const nextVisited = new Set(visited);
    nextVisited.add(key);
    return expandLocalizedReferences(referenced, stringEntries, depth + 1, nextVisited);
  });
}

function cleanLocalizedTooltip(text) {
  return String(text || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:mainText|rules|titleLeft|titleRight|postScriptLeft|postScriptRight)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function formatPassiveNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  const rounded = Math.round(number * 100) / 100;
  return String(rounded);
}

function compactNumberList(values, { percent = false, suffixPercent = false, levelBased = false } = {}) {
  const numbers = (Array.isArray(values) ? values : [values])
    .map(Number)
    .filter(Number.isFinite);
  if (!numbers.length) return "";
  const unique = [...new Set(numbers.map((number) => Math.round(number * 10000) / 10000))];
  const multiplier = percent ? 100 : 1;
  let formatted;
  if (unique.length === 1) {
    formatted = formatPassiveNumber(unique[0] * multiplier);
  } else if (unique.length <= 4) {
    formatted = unique.map((number) => formatPassiveNumber(number * multiplier)).join(" / ");
  } else {
    const min = Math.min(...unique) * multiplier;
    const max = Math.max(...unique) * multiplier;
    formatted = `${formatPassiveNumber(min)}~${formatPassiveNumber(max)}`;
    if (levelBased) formatted += " (레벨별)";
  }
  return `${formatted}${percent || suffixPercent ? "%" : ""}`;
}

function calculateBreakpointValues(part) {
  if (!Number.isFinite(Number(part?.mLevel1Value))) return [];
  const breakpoints = Array.isArray(part.mBreakpoints) ? part.mBreakpoints : [];
  let value = Number(part.mLevel1Value);
  let perLevel = Number(part.mInitialBonusPerLevel) || 0;
  const values = [value];

  for (let level = 2; level <= 18; level += 1) {
    for (const breakpoint of breakpoints) {
      if (Number(breakpoint.mLevel) !== level) continue;
      if (Number.isFinite(Number(breakpoint.mBonusPerLevelAtAndAfter))) {
        perLevel = Number(breakpoint.mBonusPerLevelAtAndAfter);
      }
      if (Number.isFinite(Number(breakpoint.mAdditionalBonusAtThisLevel))) {
        value += Number(breakpoint.mAdditionalBonusAtThisLevel);
      }
    }
    value += perLevel;
    values.push(value);
  }
  return values;
}

function getPassiveDataValue(spell, name) {
  if (!name) return [];
  const normalized = name.toLowerCase();
  const entry = (spell?.DataValues || []).find(
    (value) => String(value.name || "").toLowerCase() === normalized,
  );
  return Array.isArray(entry?.values) ? entry.values : [];
}

function getPassiveCalculation(spell, name) {
  if (!name) return null;
  const normalized = name.toLowerCase();
  const calculations = spell?.mSpellCalculations || {};
  const key = Object.keys(calculations).find((item) => item.toLowerCase() === normalized);
  return key ? calculations[key] : null;
}

function statLabelFor(part, dataName = "") {
  const stat = String(part?.mStat || part?.mStatType || dataName || "").toLowerCase();
  if (/mana/.test(stat)) return "마나";
  if (/energy/.test(stat)) return "기력";
  if (/bonus.?ad|attack.?damage|total.?ad/.test(stat)) return "공격력";
  if (/health|hp/.test(stat)) return "체력";
  if (/armor/.test(stat)) return "방어력";
  if (/attack.?speed/.test(stat)) return "공격 속도";
  if (/movement.?speed/.test(stat)) return "이동 속도";
  return "주문력";
}

function dataValueNumbers(spell, name) {
  return getPassiveDataValue(spell, name).map(Number).filter(Number.isFinite);
}

function getCalculationMultiplier(calculation) {
  const raw = calculation?.mMultiplier;
  if (Number.isFinite(Number(raw))) return Number(raw);
  if (Number.isFinite(Number(raw?.mNumber))) return Number(raw.mNumber);
  if (Number.isFinite(Number(raw?.mCoefficient))) return Number(raw.mCoefficient);
  return 1;
}

function formatPassiveCalculation(calculation, spell, tokenName) {
  const parts = Array.isArray(calculation?.mFormulaParts) ? calculation.mFormulaParts : [];
  const terms = [];
  const percentDamage = /damage|ratio|percent/i.test(tokenName || "");
  const calculationMultiplier = getCalculationMultiplier(calculation);
  const displayAsPercent = calculation?.mDisplayAsPercent === true;

  for (const part of parts) {
    const type = String(part.__type || "");
    if (type.includes("ByCharLevelInterpolationCalculationPart")) {
      const bounds = [part.mStartValue, part.mEndValue]
        .map(Number)
        .filter(Number.isFinite)
        .map((number) => number * calculationMultiplier);
      const asPercent = displayAsPercent || (percentDamage && bounds.length && bounds.every((number) => Math.abs(number) <= 1));
      const multiplier = asPercent ? 100 : 1;
      let range = "";
      if (bounds.length) {
        const start = formatPassiveNumber(bounds[0] * multiplier);
        const end = formatPassiveNumber(bounds[bounds.length - 1] * multiplier);
        const separator = /cooldown/i.test(tokenName || "") ? "→" : "~";
        range = `${start}${separator}${end}${asPercent ? "%" : ""}`;
      }
      terms.push(range ? `${range} (레벨에 따라)` : "");
      continue;
    }
    if (type.includes("ByCharLevelFormulaCalculationPart")) {
      const values = (Array.isArray(part.values) ? part.values : [])
        .map(Number)
        .filter(Number.isFinite)
        .map((number) => number * calculationMultiplier);
      const asPercent = displayAsPercent || (percentDamage && values.length && values.every((number) => Math.abs(number) <= 1));
      terms.push(compactNumberList(values, { percent: asPercent, levelBased: true }));
      continue;
    }
    if (type.includes("ByCharLevelBreakpointsCalculationPart")) {
      const values = calculateBreakpointValues(part).map((number) => number * calculationMultiplier);
      terms.push(compactNumberList(values, { percent: displayAsPercent, levelBased: true }));
      continue;
    }
    if (type.includes("AbilityResourceByCoefficientCalculationPart")) {
      const coefficient = Number(part.mCoefficient) * calculationMultiplier;
      const resourceName = (spell?.DataValues || []).map((entry) => entry.name).find((name) => /mana|energy/i.test(name)) || "Mana";
      if (Number.isFinite(coefficient)) {
        terms.push(`${statLabelFor(part, resourceName)} ${formatPassiveNumber(coefficient * 100)}%`);
      }
      continue;
    }
    if (type.includes("StatByCoefficientCalculationPart")) {
      const coefficient = Number(part.mCoefficient) * calculationMultiplier;
      if (Number.isFinite(coefficient)) {
        terms.push(`${statLabelFor(part)} ${formatPassiveNumber(coefficient * 100)}%`);
      }
      continue;
    }
    if (type.includes("StatByNamedDataValueCalculationPart")) {
      const name = String(part.mDataValue || "");
      const values = dataValueNumbers(spell, name).map((value) => value * calculationMultiplier);
      if (values.length) {
        const ratio = values.map((value) => Math.abs(value) <= 1 ? value * 100 : value);
        terms.push(`${statLabelFor(part, name)} ${compactNumberList(ratio)}%`);
      }
      continue;
    }
    if (type.includes("NamedDataValueCalculationPart")) {
      const name = String(part.mDataValue || "");
      const values = dataValueNumbers(spell, name).map((value) => value * calculationMultiplier);
      if (values.length) {
        const percent = displayAsPercent || (/ratio|percent|mod$/i.test(name) && values.every((value) => Math.abs(value) <= 1));
        terms.push(compactNumberList(values, { percent, levelBased: true }));
      }
      continue;
    }
    if (type.includes("NumberCalculationPart") && Number.isFinite(Number(part.mNumber))) {
      terms.push(formatPassiveNumber(Number(part.mNumber) * calculationMultiplier));
    }
  }

  return terms.filter(Boolean).join(" + ");
}

function getPassiveCooldown(spell) {
  const directValues = [
    ...(Array.isArray(spell?.cooldownTime) ? spell.cooldownTime : []),
    ...(Array.isArray(spell?.Cooldown?.values) ? spell.Cooldown.values : []),
  ].map(Number).filter((value) => Number.isFinite(value) && value > 0);
  if (directValues.length) return `${compactNumberList(directValues)}초`;

  const cooldownValue = (spell?.DataValues || []).find((entry) =>
    /cooldown/i.test(String(entry.name || "")) &&
    Array.isArray(entry.values) &&
    entry.values.some((value) => Number(value) > 0),
  );
  if (cooldownValue) return `${compactNumberList(cooldownValue.values)}초`;

  const calculations = spell?.mSpellCalculations || {};
  const key = Object.keys(calculations).find((name) => /cooldown/i.test(name));
  if (key) {
    const value = formatPassiveCalculation(calculations[key], spell, key);
    if (value) return `${value}초`;
  }
  return "";
}

function getPassiveRange(spell) {
  const values = [
    ...(Array.isArray(spell?.castRangeDisplayOverride) ? spell.castRangeDisplayOverride : []),
    ...(Array.isArray(spell?.castRange) ? spell.castRange : []),
  ].map(Number).filter((value) => Number.isFinite(value) && value > 0 && value < 10000);
  return values.length ? compactNumberList(values) : "";
}

function passiveValueLabel(name) {
  const exact = {
    maxstacks: "최대 중첩",
    takedownwindow: "처치 관여 시간",
    minionheal: "미니언 처치 회복량",
    championheal: "챔피언 처치 회복량",
    debuffduration: "표식 지속 시간",
    totaldamage: "추가 피해량",
    pdamage: "최대 체력 비례 피해",
    pcooldown: "재사용 대기시간",
    healththreshold: "발동 체력 기준",
    shieldduration: "보호막 지속 시간",
    shieldamount: "보호막 수치",
    cooldown: "재사용 대기시간",
    duration: "지속 시간",
    movementspeed: "이동 속도",
    movespeed: "이동 속도",
    asbuff: "공격 속도 증가",
    msbuff: "이동 속도 증가",
    damagetimer: "대기 시간",
    daggerduration: "단검 유지 시간",
    daggerradius: "단검 범위",
    rangedisplay: "사거리",
  };
  const key = String(name || "").toLowerCase();
  if (exact[key]) return exact[key];
  if (/heal|regen/.test(key)) return "회복량";
  if (/shield/.test(key)) return "보호막";
  if (/damage/.test(key)) return "피해량";
  if (/cooldown|cdr/.test(key)) return "재사용 대기시간";
  if (/duration|window|timer|delay/.test(key)) return "지속 시간";
  if (/stack/.test(key)) return "중첩";
  if (/range|radius/.test(key)) return "범위";
  if (/movespeed/.test(key)) return "이동 속도";
  if (/attackspeed/.test(key)) return "공격 속도";
  if (/health|threshold/.test(key)) return "체력 기준";
  if (/mana|energy/.test(key)) return "자원 수치";
  return "패시브 수치";
}

function resolvePassiveToken(expression, spell, afterText = "") {
  const token = String(expression || "").replace(/\s+/g, "");
  if (!token || /^(spellmodifierdescriptionappend|sourcename|extendedkeybind)$/i.test(token)) {
    return { text: "", label: "", value: "" };
  }
  const match = token.match(/^([a-zA-Z0-9_]+)(?:([*/])(-?\d+(?:\.\d+)?))?$/);
  if (!match) return { text: "수치 미확인", label: passiveValueLabel(token), value: "" };

  const [, name, operator, operandText] = match;
  const calculation = getPassiveCalculation(spell, name);
  const dataValues = getPassiveDataValue(spell, name).map(Number).filter(Number.isFinite);
  const multiplier = operator ? Number(operandText) : 1;
  const hasPercentSuffix = /^\s*%/.test(afterText);

  if (calculation) {
    let value = formatPassiveCalculation(calculation, spell, name);
    if (!value) value = "수치 미확인";
    return { text: value, label: passiveValueLabel(name), value };
  }

  if (!dataValues.length) {
    return { text: "수치 미확인", label: passiveValueLabel(name), value: "" };
  }

  let values = dataValues.map((value) => {
    if (operator === "*" && multiplier !== 100) return value * multiplier;
    if (operator === "/") return multiplier ? value / multiplier : value;
    return value;
  });
  let percent = operator === "*" && multiplier === 100;
  let suffixPercent = false;
  const ratioLike = /ratio|percent|threshold/i.test(name);
  if (!percent && hasPercentSuffix) {
    if (ratioLike && values.every((value) => Math.abs(value) <= 1)) {
      percent = true;
    } else if (values.every((value) => Math.abs(value) >= 1)) {
      suffixPercent = true;
    }
  }
  const value = compactNumberList(values, {
    percent,
    suffixPercent,
    levelBased: values.length > 4 && new Set(values).size > 1,
  });
  return {
    text: value || "수치 미확인",
    label: passiveValueLabel(name),
    value: value || "",
  };
}

async function buildCommunityPassiveDetail(championId, passiveName) {
  const safeId = String(championId || "");
  const folder = safeId.toLowerCase();
  const binUrl = `${CDRAGON_ROOT}/game/data/characters/${folder}/${folder}.bin.json`;
  const [bin, stringEntries] = await Promise.all([
    fetchCommunityJson(binUrl),
    getCdragonStringEntries(),
  ]);
  const passive = findPassiveSpell(bin, passiveName, stringEntries);
  if (!passive) {
    return {
      available: false,
      message: "이 챔피언의 패시브 수치 데이터를 찾지 못했습니다.",
      source: "CommunityDragon",
    };
  }

  const loc = passive.locKeys;
  const tooltipKeys = [
    loc.keyTooltipExtended,
    loc.keyTooltip,
    loc.keyTooltipExtendedBelowLine,
    loc.keySummary,
  ].filter((key, index, list) => typeof key === "string" && key && list.indexOf(key) === index);
  let template = "";
  for (const key of tooltipKeys) {
    template = getTooltipEntry(stringEntries, key);
    if (template) break;
  }
  if (!template) {
    return {
      available: false,
      message: "상세 설명을 제공하는 패시브 데이터가 없습니다.",
      source: "CommunityDragon",
    };
  }

  const expanded = expandLocalizedReferences(template, stringEntries);
  const numericValues = [];
  const seen = new Set();
  const description = expanded.replace(/@([^@]+)@/g, (placeholder, expression, index, wholeText) => {
    const afterText = wholeText.slice(index + placeholder.length);
    const resolved = resolvePassiveToken(expression, passive.object.mSpell, afterText);
    if (resolved.value) {
      const identity = `${resolved.label}:${resolved.value}`;
      if (!seen.has(identity) && /\d/.test(resolved.value)) {
        seen.add(identity);
        numericValues.push(resolved);
      }
    }
    if (/^\s*%/.test(afterText) && resolved.text.trim().endsWith("%")) {
      return resolved.text.trim().slice(0, -1);
    }
    return resolved.text;
  });

  return {
    available: true,
    description: cleanLocalizedTooltip(description),
    numericValues,
    cooldown: getPassiveCooldown(passive.object.mSpell),
    range: getPassiveRange(passive.object.mSpell),
    source: "CommunityDragon · 최신 한국어 게임 데이터",
  };
}

async function getCommunityPassiveDetail(championId, passiveName) {
  const cacheKey = String(championId).toLowerCase();
  const cached = cdragonPassiveCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  const promise = buildCommunityPassiveDetail(championId, passiveName);
  cdragonPassiveCache.set(cacheKey, {
    promise,
    expiresAt: Date.now() + CDRAGON_PASSIVE_CACHE_TTL_MS,
  });
  try {
    const value = await promise;
    cdragonPassiveCache.set(cacheKey, {
      promise: Promise.resolve(value),
      expiresAt: Date.now() + CDRAGON_PASSIVE_CACHE_TTL_MS,
    });
    return value;
  } catch {
    cdragonPassiveCache.delete(cacheKey);
    throw new Error("패시브 수치 상세 정보를 불러오지 못했습니다.");
  }
}

class RiotApiError extends Error {
  constructor(status, message, retryAfter = null) {
    super(message);
    this.name = "RiotApiError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function riotErrorMessage(status, retryAfter) {
  if (status === 401 || status === 403) return "Riot API 키가 유효하지 않거나 접근 권한이 없습니다.";
  if (status === 404) return "Riot ID 또는 이번 주 전적을 찾을 수 없습니다.";
  if (status === 429) {
    const retry = Number(retryAfter);
    return Number.isFinite(retry) && retry > 0
      ? `Riot API 호출 한도에 도달했습니다. 약 ${retry}초 뒤 다시 시도해 주세요.`
      : "Riot API 호출 한도에 도달했습니다. 잠시 뒤 다시 시도해 주세요.";
  }
  if (status >= 500) return "Riot API가 일시적으로 응답하지 않습니다. 잠시 뒤 다시 시도해 주세요.";
  return "Riot API 요청에 실패했습니다. 입력한 계정 정보를 확인해 주세요.";
}

async function riotJson(url) {
  const cached = cachedValue(url);
  if (cached !== undefined) return cached;

  let response;
  try {
    response = await fetch(url, {
      headers: {
        "X-Riot-Token": process.env.RIOT_API_KEY,
        Accept: "application/json",
      },
    });
  } catch {
    throw new RiotApiError(503, "Riot API에 연결할 수 없습니다. 네트워크 연결을 확인해 주세요.");
  }

  if (!response.ok) {
    const retryAfter = response.headers.get("Retry-After");
    throw new RiotApiError(response.status, riotErrorMessage(response.status, retryAfter), retryAfter);
  }

  let value;
  try {
    value = await response.json();
  } catch {
    throw new RiotApiError(502, "Riot API 응답을 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
  }
  setCachedValue(url, value);
  return value;
}

async function readJsonBody(request, limit = 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error("요청 데이터가 너무 큽니다.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("요청 형식이 올바른 JSON이 아닙니다.");
    error.status = 400;
    throw error;
  }
}

function validateAccounts(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) {
    const error = new Error("Riot ID는 1개 이상 10개 이하로 입력해 주세요.");
    error.status = 400;
    throw error;
  }

  return value.map((item) => {
    const gameName = typeof item?.gameName === "string" ? item.gameName.trim() : "";
    const tagLine = typeof item?.tagLine === "string" ? item.tagLine.trim() : "";
    const region = typeof item?.region === "string" ? item.region.trim().toLowerCase() : "";
    if (!gameName || !tagLine || gameName.length > 100 || tagLine.length > 25 || !["kr", "jp1"].includes(region)) {
      const error = new Error("Riot ID 또는 지역 정보가 올바르지 않습니다.");
      error.status = 400;
      throw error;
    }
    return { gameName, tagLine, region };
  });
}

function validateQueueIds(value) {
  if (!Array.isArray(value)) {
    const error = new Error("게임 모드 정보가 올바르지 않습니다.");
    error.status = 400;
    throw error;
  }
  const queueIds = [...new Set(value.map(Number).filter((queueId) => ALLOWED_QUEUE_IDS.has(queueId)))];
  if (!queueIds.length) {
    const error = new Error("게임 모드를 하나 이상 선택해 주세요.");
    error.status = 400;
    throw error;
  }
  return queueIds;
}

async function mapWithConcurrency(items, limit, callback) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        results[index] = { status: "fulfilled", value: await callback(items[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function getAccountLookupUrl(account) {
  const gameName = encodeURIComponent(account.gameName);
  const tagLine = encodeURIComponent(account.tagLine);
  return `${RIOT_ROUTING}/riot/account/v1/accounts/by-riot-id/${gameName}/${tagLine}`;
}

async function getMatchIds(puuid, weekStart, weekEnd) {
  const startTime = Math.floor(weekStart / 1000);
  const endTime = Math.floor(Math.min(weekEnd, Date.now()) / 1000);
  const ids = [];
  let start = 0;
  let truncated = false;

  while (start < MAX_MATCHES_PER_ACCOUNT) {
    const count = Math.min(MATCH_PAGE_SIZE, MAX_MATCHES_PER_ACCOUNT - start);
    const url =
      `${RIOT_ROUTING}/lol/match/v5/matches/by-puuid/${encodeURIComponent(puuid)}/ids` +
      `?startTime=${startTime}&endTime=${endTime}&start=${start}&count=${count}`;
    const page = await riotJson(url);
    if (!Array.isArray(page) || !page.length) break;
    ids.push(...page);
    start += page.length;
    if (page.length < count) break;
    if (start >= MAX_MATCHES_PER_ACCOUNT) truncated = true;
  }

  return { ids, truncated };
}

function normalizeParticipant(match, participant) {
  const info = match.info || {};
  let duration = Number(info.gameDuration) || 0;
  // Match-V5 durations are seconds for current matches; older responses may use milliseconds.
  if (duration > 24 * 60 * 60) duration /= 1000;
  const timestamp = Number(info.gameEndTimestamp || info.gameCreation) || Date.now();
  return {
    gameId: match.metadata?.matchId || "",
    championId: Number(participant.championId) || null,
    championKey: participant.championName || "",
    win: participant.win === true,
    kills: Number(participant.kills) || 0,
    deaths: Number(participant.deaths) || 0,
    assists: Number(participant.assists) || 0,
    cs: (Number(participant.totalMinionsKilled) || 0) + (Number(participant.neutralMinionsKilled) || 0),
    duration,
    timestamp,
  };
}

function summarizeMatches(matches) {
  let wins = 0;
  let kills = 0;
  let deaths = 0;
  let assists = 0;
  let cs = 0;
  let duration = 0;
  const championStats = new Map();
  const days = new Map();

  for (const match of matches) {
    wins += match.win ? 1 : 0;
    kills += match.kills;
    deaths += match.deaths;
    assists += match.assists;
    cs += match.cs;
    duration += match.duration;

    const championMapKey = String(match.championId ?? match.championKey ?? "unknown");
    if (!championStats.has(championMapKey)) {
      championStats.set(championMapKey, {
        championId: match.championId,
        championKey: match.championKey,
        games: 0,
        wins: 0,
        losses: 0,
        kills: 0,
        deaths: 0,
        assists: 0,
        cs: 0,
        duration: 0,
      });
    }
    const champion = championStats.get(championMapKey);
    champion.games += 1;
    champion.wins += match.win ? 1 : 0;
    champion.losses += match.win ? 0 : 1;
    champion.kills += match.kills;
    champion.deaths += match.deaths;
    champion.assists += match.assists;
    champion.cs += match.cs;
    champion.duration += match.duration;

    const date = kstDateKey(match.timestamp);
    if (!days.has(date)) days.set(date, { date, games: 0, wins: 0 });
    const day = days.get(date);
    day.games += 1;
    day.wins += match.win ? 1 : 0;
  }

  const games = matches.length;
  const champions = [...championStats.values()]
    .map((champion) => ({
      championId: champion.championId,
      championKey: champion.championKey,
      games: champion.games,
      wins: champion.wins,
      losses: champion.losses,
      winRate: champion.games ? (champion.wins / champion.games) * 100 : 0,
      kills: champion.kills,
      deaths: champion.deaths,
      assists: champion.assists,
      kda: champion.deaths ? (champion.kills + champion.assists) / champion.deaths : null,
      kdaPerfect: champion.games > 0 && champion.deaths === 0,
      avgCs: champion.games ? champion.cs / champion.games : null,
      avgDuration: champion.games ? champion.duration / champion.games : null,
    }))
    .sort((a, b) => b.games - a.games || String(a.championKey).localeCompare(String(b.championKey)));

  return {
    games,
    wins,
    losses: games - wins,
    winRate: games ? (wins / games) * 100 : 0,
    kills,
    deaths,
    assists,
    kda: deaths ? (kills + assists) / deaths : null,
    kdaPerfect: games > 0 && deaths === 0,
    avgCs: games ? cs / games : null,
    avgDuration: games ? duration / games : null,
    championCount: champions.length,
    champions,
    days: [...days.values()],
  };
}

function accountErrorMessage(error) {
  if (error instanceof RiotApiError) return error.message;
  return "Riot API 조회 중 문제가 발생했습니다. 잠시 뒤 다시 시도해 주세요.";
}

async function getWeeklyStats(body) {
  if (!process.env.RIOT_API_KEY) {
    const error = new Error("서버에 Riot API 키가 설정되지 않았습니다. .env에 RIOT_API_KEY를 설정해 주세요.");
    error.status = 503;
    throw error;
  }

  const accounts = validateAccounts(body.accounts);
  const queueIds = validateQueueIds(body.queueIds);
  const queueSet = new Set(queueIds);
  const { start: weekStart, end: weekEnd } = getKstWeekBounds();
  const weekKey = currentWeekKey();
  const lookupResults = await mapWithConcurrency(accounts, 4, async (account) => {
    const riotAccount = await riotJson(getAccountLookupUrl(account));
    if (!riotAccount?.puuid) throw new RiotApiError(502, "계정 정보를 Riot API에서 확인하지 못했습니다.");
    return { ...account, puuid: riotAccount.puuid };
  });

  const accountStates = lookupResults.map((result, index) => {
    const account = accounts[index];
    if (result.status === "rejected") {
      return { ...account, riotId: `${account.gameName}#${account.tagLine}`, error: accountErrorMessage(result.reason) };
    }
    return { ...result.value, riotId: `${account.gameName}#${account.tagLine}`, matchIds: [], truncated: false };
  });
  const resolved = accountStates.filter((account) => account.puuid);

  if (!resolved.length) {
    const errors = accountStates.map((account) => ({ riotId: account.riotId, message: account.error }));
    const rateLimited = lookupResults.some((result) => result.status === "rejected" && result.reason?.status === 429);
    const statusCode = rateLimited ? 429 : 502;
    const error = new Error("등록된 Riot ID를 조회하지 못했습니다.");
    error.status = statusCode;
    error.details = errors;
    throw error;
  }

  const idResults = await mapWithConcurrency(resolved, 3, (account) =>
    getMatchIds(account.puuid, weekStart, weekEnd)
  );
  const warnings = [];
  idResults.forEach((result, index) => {
    const account = resolved[index];
    if (result.status === "rejected") {
      account.error = accountErrorMessage(result.reason);
      return;
    }
    account.matchIds = result.value.ids;
    account.truncated = result.value.truncated;
    if (result.value.truncated) {
      warnings.push(`${account.riotId}의 주간 경기 목록이 ${MAX_MATCHES_PER_ACCOUNT}개에서 제한되었습니다.`);
    }
  });

  const matchIds = [...new Set(resolved.flatMap((account) => account.matchIds || []))];
  const matchResults = await mapWithConcurrency(matchIds, 4, async (matchId) => {
    const match = await riotJson(`${RIOT_ROUTING}/lol/match/v5/matches/${encodeURIComponent(matchId)}`);
    return [matchId, match];
  });
  const matchMap = new Map();
  let failedMatchDetails = 0;
  let rateLimited = false;
  for (const result of matchResults) {
    if (result.status === "fulfilled") {
      matchMap.set(result.value[0], result.value[1]);
    } else {
      failedMatchDetails += 1;
      if (result.reason?.status === 429) rateLimited = true;
    }
  }
  if (failedMatchDetails) {
    const detail = rateLimited
      ? "Riot API 호출 제한으로 일부 경기 상세 정보를 가져오지 못했습니다. 잠시 기다린 뒤 새로고침해 주세요."
      : `${failedMatchDetails}개 경기의 상세 정보를 불러오지 못했습니다.`;
    warnings.push(detail);
  }

  const weekStartSeconds = Math.floor(weekStart / 1000);
  const weekEndSeconds = Math.floor(Math.min(weekEnd, Date.now()) / 1000);
  const accountSummaries = [];
  const allAccountMatches = [];

  for (const account of accountStates) {
    const accountMatches = [];
    if (account.puuid && !account.error) {
      for (const matchId of account.matchIds || []) {
        const match = matchMap.get(matchId);
        if (!match?.info || !queueSet.has(Number(match.info.queueId))) continue;
        const info = match.info;
        const timestamp = Number(info.gameEndTimestamp || info.gameCreation) || 0;
        const matchStart = Number(info.gameCreation || info.gameStartTimestamp) || timestamp;
        if (matchStart && (Math.floor(matchStart / 1000) < weekStartSeconds || Math.floor(matchStart / 1000) >= weekEndSeconds)) {
          continue;
        }
        const participant = (info.participants || []).find((entry) => entry.puuid === account.puuid);
        if (!participant) continue;
        accountMatches.push(normalizeParticipant(match, participant));
      }
    }
    allAccountMatches.push(...accountMatches);
    const summary = summarizeMatches(accountMatches);
    accountSummaries.push({
      riotId: account.riotId,
      gameName: account.gameName,
      tagLine: account.tagLine,
      region: account.region,
      regionLabel: account.region === "jp1" ? "JP1" : "KR",
      error: account.error || null,
      ...summary,
    });
  }

  const errors = accountStates
    .filter((account) => account.error)
    .map((account) => ({ riotId: account.riotId, message: account.error }));
  const endForLabel = Math.min(weekEnd, Date.now());

  return {
    source: "riot",
    week: {
      timezone: "Asia/Seoul",
      start: new Date(weekStart).toISOString(),
      end: new Date(endForLabel).toISOString(),
      nextReset: new Date(weekEnd).toISOString(),
      key: weekKey,
    },
    queueIds,
    total: summarizeMatches(allAccountMatches),
    accounts: accountSummaries,
    errors,
    warnings: [...new Set(warnings)],
  };
}

function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
  }[extension] || "application/octet-stream";
}

async function serveStatic(pathname, response) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    response.writeHead(400);
    response.end("Bad request");
    return;
  }
  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  const filePath = path.resolve(PUBLIC_DIR, relativePath);
  const relative = path.relative(PUBLIC_DIR, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const stats = await fs.promises.stat(filePath);
    if (!stats.isFile()) throw new Error("Not a file");
    response.writeHead(200, {
      "Content-Type": contentType(filePath),
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    fs.createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  const passiveDetailPath = requestUrl.pathname.match(/^\/api\/champion-passive\/([A-Za-z0-9]+)$/);
  if (passiveDetailPath && request.method === "GET") {
    const championId = passiveDetailPath[1];
    const passiveName = requestUrl.searchParams.get("name") || "";
    if (!passiveName || passiveName.length > 100) {
      sendJson(response, 400, { error: "챔피언 패시브 이름이 올바르지 않습니다." });
      return;
    }
    try {
      const detail = await getCommunityPassiveDetail(championId, passiveName);
      sendJson(response, 200, detail);
    } catch (error) {
      sendJson(response, 502, {
        available: false,
        error: error.message || "패시브 수치 상세 정보를 불러오지 못했습니다.",
      });
    }
    return;
  }

  if (requestUrl.pathname === "/api/status" && request.method === "GET") {
    sendJson(response, 200, {
      apiConfigured: Boolean(process.env.RIOT_API_KEY),
      supportedRegions: ["kr", "jp1"],
      routing: "asia",
      timezone: "Asia/Seoul",
    });
    return;
  }

  if (requestUrl.pathname === "/api/weekly-stats" && request.method === "POST") {
    try {
      const body = await readJsonBody(request);
      const stats = await getWeeklyStats(body);
      sendJson(response, 200, stats);
    } catch (error) {
      const status = Number(error.status) || 500;
      sendJson(response, status, {
        error: error.message || "서버에서 요청을 처리하지 못했습니다.",
        errors: error.details || undefined,
      });
    }
    return;
  }

  if (requestUrl.pathname.startsWith("/api/")) {
    sendJson(response, 404, { error: "API 경로를 찾을 수 없습니다." });
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end("Method not allowed");
    return;
  }

  await serveStatic(requestUrl.pathname, response);
});

const port = Number(process.env.PORT) || 3000;
scheduleCacheReset();
server.listen(port, () => {
  const apiState = process.env.RIOT_API_KEY ? "configured" : "not configured · sample mode";
  console.log(`RIFT LAB is running at http://localhost:${port} (${apiState})`);
});
