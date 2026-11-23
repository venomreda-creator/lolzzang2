"use strict";

(() => {
  const QUEUE_GROUPS = {
    solo: [420],
    flex: [440],
    normal: [400, 430, 490],
  };
  const ALL_QUEUE_IDS = new Set(Object.values(QUEUE_GROUPS).flat());
  const STORAGE = {
    accounts: "riftlab.accounts.v1",
    queues: "riftlab.queues.v1",
  };
  const DD_BASE = "https://ddragon.leagueoflegends.com";
  const FALLBACK_PATCH = "오프라인";

  const KOREAN_NAMES = {
    Ahri: "아리",
    Ashe: "애쉬",
    Garen: "가렌",
    Jinx: "징크스",
    LeeSin: "리 신",
    Leona: "레오나",
    Lux: "럭스",
    Syndra: "신드라",
    Yasuo: "야스오",
  };

  const DAMAGE_TAGS = {
    Ahri: { passive: "피해 없음", q: "마법·고정 피해", w: "마법 피해", e: "마법 피해", r: "마법 피해" },
    Ashe: { passive: "물리 피해", q: "물리 피해", w: "물리 피해", e: "피해 없음", r: "마법 피해" },
    Garen: { passive: "피해 없음", q: "물리 피해", w: "피해 없음", e: "물리 피해", r: "고정 피해" },
    Jinx: { passive: "피해 없음", q: "물리 피해", w: "물리 피해", e: "마법 피해", r: "물리 피해" },
    LeeSin: { passive: "피해 없음", q: "물리 피해", w: "피해 없음", e: "마법 피해", r: "물리 피해" },
    Leona: { passive: "마법 피해", q: "물리 피해", w: "마법 피해", e: "마법 피해", r: "마법 피해" },
    Lux: { passive: "마법 피해", q: "마법 피해", w: "피해 없음", e: "마법 피해", r: "마법 피해" },
    Syndra: { passive: "피해 없음", q: "마법 피해", w: "마법 피해", e: "마법 피해", r: "마법 피해" },
    Yasuo: { passive: "피해 없음", q: "물리 피해", w: "피해 없음", e: "물리 피해", r: "물리 피해" },
  };

  const FALLBACK_CHAMPIONS = [
    makeFallbackChampion("Ahri", "103", "아리", "구미호", ["Mage", "Assassin"]),
    makeFallbackChampion("Lux", "99", "럭스", "광명의 소녀", ["Mage", "Support"]),
    makeFallbackChampion("Yasuo", "157", "야스오", "용서받지 못한 자", ["Fighter", "Assassin"]),
    makeFallbackChampion("Jinx", "222", "징크스", "난폭한 말괄량이", ["Marksman"]),
  ];

  const DEMO_PICKS = [
    { id: "Ahri", key: 103, games: 9, wins: 6, kills: 7, deaths: 4, assists: 10, cs: 181, duration: 29 },
    { id: "Jinx", key: 222, games: 7, wins: 5, kills: 8, deaths: 4, assists: 8, cs: 205, duration: 31 },
    { id: "Syndra", key: 134, games: 6, wins: 3, kills: 6, deaths: 5, assists: 9, cs: 192, duration: 30 },
    { id: "LeeSin", key: 64, games: 5, wins: 2, kills: 6, deaths: 6, assists: 11, cs: 143, duration: 28 },
    { id: "Ashe", key: 22, games: 4, wins: 3, kills: 5, deaths: 4, assists: 13, cs: 198, duration: 32 },
    { id: "Leona", key: 89, games: 3, wins: 1, kills: 2, deaths: 7, assists: 15, cs: 42, duration: 27 },
  ];

  const state = {
    accounts: loadAccounts(),
    selectedQueues: loadQueues(),
    apiConfigured: false,
    serverAvailable: false,
    actualStats: null,
    champions: FALLBACK_CHAMPIONS,
    championById: new Map(),
    patch: FALLBACK_PATCH,
    selectedChampionId: "Ahri",
    championDetailCache: new Map(),
    passiveDetailCache: new Map(),
    passiveDetailLoading: new Set(),
    passiveDetailErrors: new Map(),
    activeView: "overview",
    loadingStats: false,
  };
  let observedWeekStart = getKstWeekBounds().start;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  function makeFallbackChampion(id, key, name, title, tags) {
    const missing = "Data Dragon에 연결하면 최신 한국어 스킬 설명을 표시합니다.";
    return {
      id,
      key,
      name,
      title,
      tags,
      image: { full: "" },
      passive: { name: "패시브", description: missing, image: { full: "" } },
      spells: ["Q", "W", "E", "R"].map((slot) => ({
        name: `${slot} 스킬`,
        description: missing,
        cooldown: [],
        cooldownBurn: "",
        range: [],
        rangeBurn: "",
        image: { full: "" },
      })),
    };
  }

  function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character]);
  }

  function plainText(value) {
    return String(value ?? "")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&ndash;/gi, "–")
      .replace(/&mdash;/gi, "—")
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/{{[^}]*}}/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function loadAccounts() {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE.accounts) || "[]");
      if (!Array.isArray(value)) return [];
      return value
        .filter((account) =>
          account &&
          typeof account.gameName === "string" &&
          typeof account.tagLine === "string" &&
          ["kr", "jp1"].includes(String(account.region).toLowerCase())
        )
        .slice(0, 10)
        .map((account) => ({
          gameName: account.gameName.trim(),
          tagLine: account.tagLine.trim(),
          region: String(account.region).toLowerCase(),
        }))
        .filter((account) => account.gameName && account.tagLine);
    } catch {
      return [];
    }
  }

  function saveAccounts() {
    try {
      localStorage.setItem(STORAGE.accounts, JSON.stringify(state.accounts));
    } catch {
      showNotice("error", "브라우저 저장 실패", "브라우저 저장 공간을 확인한 뒤 다시 시도해 주세요.");
    }
  }

  function loadQueues() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE.queues) || "null");
      if (!Array.isArray(stored)) return new Set(ALL_QUEUE_IDS);
      return new Set(stored.map(Number).filter((queueId) => ALL_QUEUE_IDS.has(queueId)));
    } catch {
      return new Set(ALL_QUEUE_IDS);
    }
  }

  function saveQueues() {
    try {
      localStorage.setItem(STORAGE.queues, JSON.stringify([...state.selectedQueues]));
    } catch {
      // Queue filters remain usable for this session when storage is unavailable.
    }
  }

  function getKstWeekBounds(now = new Date()) {
    const shifted = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const weekday = shifted.getUTCDay();
    const daysSinceMonday = (weekday + 6) % 7;
    const kstMidnightAsUtc = Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate() - daysSinceMonday,
    );
    const start = kstMidnightAsUtc - 9 * 60 * 60 * 1000;
    const end = start + 7 * 24 * 60 * 60 * 1000;
    return { start, end };
  }

  function kstDateParts(date) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    return Object.fromEntries(parts.map((part) => [part.type, part.value]));
  }

  function kstDateKey(timestamp) {
    const parts = kstDateParts(new Date(timestamp));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function formatShortDate(timestamp) {
    const parts = kstDateParts(new Date(timestamp));
    return `${Number(parts.month)}.${Number(parts.day)}`;
  }

  function getKstWeekdayIndex(timestamp = Date.now()) {
    const shifted = new Date(timestamp + 9 * 60 * 60 * 1000);
    return (shifted.getUTCDay() + 6) % 7;
  }

  function updateWeekLabels() {
    const { start, end } = getKstWeekBounds();
    const startLabel = formatShortDate(start);
    const endLabel = formatShortDate(end - 1);
    const range = `${startLabel} — ${endLabel}`;
    $("#weekRangeLabel").textContent = range;
    $("#sidebarWeekLabel").textContent = range;

    const resetDate = new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul",
      month: "numeric",
      day: "numeric",
    }).format(new Date(end));
    $("#nextResetLabel").textContent = `다음 초기화 ${resetDate} 월요일 00:00`;

    const progress = Math.max(0, Math.min(100, ((Date.now() - start) / (end - start)) * 100));
    $("#weekProgress").style.width = `${progress}%`;
    $("#weekProgressText").textContent = `${Math.floor(progress)}%`;
  }

  function checkWeekBoundary() {
    const currentWeekStart = getKstWeekBounds().start;
    if (currentWeekStart === observedWeekStart) return;
    observedWeekStart = currentWeekStart;
    state.actualStats = null;
    updateWeekLabels();
    renderOverview(getDemoStats(), "demo");
    showNotice("info", "새 주가 시작됐어요", "이전 주 통계는 보관하지 않고 초기화했습니다. 이번 주 데이터를 불러옵니다.");
    if (state.apiConfigured && state.accounts.length) refreshStats();
  }

  function scheduleWeekBoundaryCheck() {
    const { end } = getKstWeekBounds();
    window.setTimeout(() => {
      checkWeekBoundary();
      scheduleWeekBoundaryCheck();
    }, Math.max(1000, end - Date.now() + 100));
  }

  function getDemoMatches() {
    const { start } = getKstWeekBounds();
    const elapsedDays = Math.max(1, Math.min(7, Math.floor((Date.now() - start) / 86400000) + 1));
    const queueCycle = [420, 440, 400, 430, 490];
    const rows = [];
    let matchIndex = 0;

    for (const pick of DEMO_PICKS) {
      for (let index = 0; index < pick.games; index += 1) {
        const dayOffset = matchIndex % elapsedDays;
        const timestamp = start + dayOffset * 86400000 + 10 * 3600000 + (matchIndex % 12) * 18 * 60000;
        const win = index < pick.wins;
        const deaths = Math.max(0, pick.deaths + ((index % 3) - 1));
        rows.push({
          championId: pick.key,
          championKey: pick.id,
          win,
          kills: Math.max(0, pick.kills + ((index % 3) - 1)),
          deaths,
          assists: Math.max(0, pick.assists + ((index % 5) - 2)),
          cs: Math.max(0, pick.cs + ((index % 5) - 2) * 6),
          duration: (pick.duration + ((index % 3) - 1)) * 60,
          timestamp,
          queueId: queueCycle[matchIndex % queueCycle.length],
        });
        matchIndex += 1;
      }
    }
    return rows;
  }

  function summarizeMatches(matches) {
    const championStats = new Map();
    const days = new Map();
    let wins = 0;
    let kills = 0;
    let deaths = 0;
    let assists = 0;
    let cs = 0;
    let duration = 0;

    for (const match of matches) {
      if (match.win) wins += 1;
      kills += Number(match.kills) || 0;
      deaths += Number(match.deaths) || 0;
      assists += Number(match.assists) || 0;
      cs += Number(match.cs) || 0;
      duration += Number(match.duration) || 0;

      const championKey = String(match.championId ?? match.championKey ?? "unknown");
      if (!championStats.has(championKey)) {
        championStats.set(championKey, {
          championId: match.championId ?? null,
          championKey: match.championKey ?? "",
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
      const champion = championStats.get(championKey);
      champion.games += 1;
      champion.wins += match.win ? 1 : 0;
      champion.losses += match.win ? 0 : 1;
      champion.kills += Number(match.kills) || 0;
      champion.deaths += Number(match.deaths) || 0;
      champion.assists += Number(match.assists) || 0;
      champion.cs += Number(match.cs) || 0;
      champion.duration += Number(match.duration) || 0;

      const dayKey = kstDateKey(match.timestamp || Date.now());
      if (!days.has(dayKey)) days.set(dayKey, { date: dayKey, games: 0, wins: 0 });
      const day = days.get(dayKey);
      day.games += 1;
      day.wins += match.win ? 1 : 0;
    }

    const games = matches.length;
    const toRate = (won, played) => played ? (won / played) * 100 : 0;
    const championRows = [...championStats.values()]
      .map((champion) => ({
        championId: champion.championId,
        championKey: champion.championKey,
        games: champion.games,
        wins: champion.wins,
        losses: champion.losses,
        winRate: toRate(champion.wins, champion.games),
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
      winRate: toRate(wins, games),
      kills,
      deaths,
      assists,
      kda: deaths ? (kills + assists) / deaths : null,
      kdaPerfect: games > 0 && deaths === 0,
      avgCs: games ? cs / games : null,
      avgDuration: games ? duration / games : null,
      championCount: championRows.length,
      champions: championRows,
      days: [...days.values()],
    };
  }

  function getDemoStats() {
    const matches = getDemoMatches().filter((match) => state.selectedQueues.has(match.queueId));
    return summarizeMatches(matches);
  }

  function renderSourceBadge(source) {
    const badge = $("#sourceBadge");
    badge.className = `source-badge ${source === "riot" ? "live" : source === "loading" ? "loading" : "demo"}`;
    const label = source === "riot" ? "Riot API" : source === "loading" ? "조회 중" : "샘플 데이터";
    badge.innerHTML = `<span class="source-dot"></span>${label}`;
  }

  function showNotice(type, title, message) {
    const region = $("#noticeRegion");
    const icon = type === "error" ? "!" : type === "warning" ? "!" : "i";
    region.className = `notice-region ${type === "error" ? "error" : type === "info" ? "info" : ""}`;
    region.innerHTML =
      `<span class="notice-icon">${icon}</span>` +
      `<span class="notice-copy"><strong>${escapeHTML(title)}</strong> ${escapeHTML(message)}</span>`;
    region.hidden = false;
  }

  function clearNotice() {
    $("#noticeRegion").hidden = true;
    $("#noticeRegion").textContent = "";
  }

  function formatWinRate(rate, games) {
    if (!games) return "—";
    return `${Number(rate || 0).toFixed(1)}%`;
  }

  function formatKda(summary) {
    if (!summary || !summary.games) return "—";
    if (summary.kdaPerfect) return "∞";
    return Number(summary.kda || 0).toFixed(2);
  }

  function formatAverageCs(value, games) {
    if (!games || value == null) return "—";
    return Number(value).toFixed(1);
  }

  function formatDuration(seconds, games) {
    if (!games || seconds == null) return "—";
    const total = Math.round(Number(seconds));
    const minutes = Math.floor(total / 60);
    const remainder = total % 60;
    return remainder ? `${minutes}분 ${String(remainder).padStart(2, "0")}초` : `${minutes}분`;
  }

  function findChampion(champion) {
    const id = String(champion.championKey || "");
    const key = String(champion.championId ?? "");
    return state.champions.find((entry) => entry.id === id || String(entry.key) === key);
  }

  function championName(champion) {
    const meta = findChampion(champion);
    return meta?.name || KOREAN_NAMES[champion.championKey] || champion.championKey || "알 수 없음";
  }

  function championImageUrl(champion) {
    const meta = findChampion(champion);
    if (!state.patch || state.patch === FALLBACK_PATCH || !meta?.image?.full) return "";
    return `${DD_BASE}/cdn/${encodeURIComponent(state.patch)}/img/champion/${encodeURIComponent(meta.image.full)}`;
  }

  function renderChampionRows(summary) {
    const body = $("#championRows");
    const empty = $("#championEmpty");
    const table = $(".performance-table");

    if (!summary.champions.length) {
      body.innerHTML = "";
      empty.hidden = false;
      table.hidden = true;
      return;
    }

    empty.hidden = true;
    table.hidden = false;
    body.innerHTML = summary.champions.map((champion) => {
      const name = championName(champion);
      const image = championImageUrl(champion);
      const title = findChampion(champion)?.title || champion.championKey || "주간 픽";
      const icon = image
        ? `<img class="champion-avatar" src="${escapeHTML(image)}" alt="" loading="lazy" data-fallback="${escapeHTML(name.slice(0, 1))}" />`
        : `<span class="champion-avatar fallback">${escapeHTML(name.slice(0, 1))}</span>`;
      const winRate = Math.max(0, Math.min(100, Number(champion.winRate) || 0));
      return `<tr>
        <td><div class="champion-cell">${icon}<span><span class="champion-name">${escapeHTML(name)}</span><span class="champion-subname">${escapeHTML(title)}</span></span></div></td>
        <td>${champion.games} <span class="table-muted">판</span></td>
        <td class="winrate-cell">
          <div class="winrate-value-row"><span class="winrate-value">${formatWinRate(champion.winRate, champion.games)}</span><span class="winrate-record">${champion.wins}W ${champion.losses}L</span></div>
          <div class="winrate-track"><span style="width:${winRate}%"></span></div>
        </td>
        <td>${formatKda(champion)}</td>
        <td>${formatAverageCs(champion.avgCs, champion.games)}</td>
      </tr>`;
    }).join("");
  }

  function renderWeekChart(summary) {
    const container = $("#weekChart");
    const { start } = getKstWeekBounds();
    const labels = ["월", "화", "수", "목", "금", "토", "일"];
    const daysByDate = new Map((summary.days || []).map((day) => [day.date, day]));
    const slots = labels.map((label, index) => {
      const date = start + index * 86400000;
      const key = kstDateKey(date);
      return { label, date, key, games: daysByDate.get(key)?.games || 0 };
    });
    const max = Math.max(1, ...slots.map((day) => day.games));
    const today = getKstWeekdayIndex();

    container.innerHTML = slots.map((day, index) => {
      const height = day.games ? Math.max(4, (day.games / max) * 55) : 2;
      const isToday = index === today;
      return `<div class="chart-day" title="${escapeHTML(`${day.label}요일 · ${day.games}경기`)}">
        <div class="chart-bar-area"><span class="chart-bar${isToday ? " today" : ""}" style="height:${height}px"></span></div>
        <span class="chart-day-label${isToday ? " today" : ""}">${day.label}</span>
      </div>`;
    }).join("");
  }

  function getAccountKey(account) {
    return `${String(account.gameName).toLocaleLowerCase()}#${String(account.tagLine).toLocaleLowerCase()}@${String(account.region).toLowerCase()}`;
  }

  function renderAccountList() {
    $("#accountCount").textContent = `${state.accounts.length} / 10`;
    const list = $("#accountList");
    if (!state.accounts.length) {
      list.innerHTML = `<div class="account-empty"><span class="account-empty-icon">＋</span><span><strong>아직 등록된 계정이 없어요</strong><span>Riot ID를 추가하면 실제 주간 전적을 불러올 수 있어요.</span></span></div>`;
      return;
    }

    const liveByKey = new Map(
      (state.actualStats?.accounts || []).map((account) => [
        `${String(account.gameName).toLocaleLowerCase()}#${String(account.tagLine).toLocaleLowerCase()}@${String(account.region).toLowerCase()}`,
        account,
      ]),
    );

    list.innerHTML = state.accounts.map((account, index) => {
      const summary = liveByKey.get(getAccountKey(account));
      const region = account.region === "jp1" ? "JP1 · 일본" : "KR · 한국";
      const displayName = `${account.gameName}#${account.tagLine}`;
      const metric = summary?.error
        ? `<span class="account-chip-metrics account-chip-error">조회 오류</span>`
        : summary
          ? `<span class="account-chip-metrics" title="${summary.games}판 · ${summary.wins}승 ${summary.losses}패">
              <strong>${summary.games}판</strong>
              <span class="account-chip-winrate">${formatWinRate(summary.winRate, summary.games)}</span>
              <small>${summary.wins}W ${summary.losses}L</small>
            </span>`
          : `<span class="account-chip-metrics account-chip-pending">조회 대기</span>`;
      return `<div class="account-chip">
        <span class="account-avatar">${escapeHTML(account.gameName.slice(0, 1).toUpperCase())}</span>
        <span class="account-chip-copy"><span class="account-chip-name" title="${escapeHTML(displayName)}">${escapeHTML(displayName)}</span><span class="account-chip-region">${region}</span></span>
        ${metric}
        <button type="button" class="account-remove" data-remove-account="${index}" aria-label="${escapeHTML(displayName)} 계정 삭제" title="계정 삭제">×</button>
      </div>`;
    }).join("");
  }

  function renderOverview(summary, source = "demo") {
    $("#metricGames").textContent = Number(summary.games || 0).toLocaleString("ko-KR");
    $("#metricWinrate").textContent = formatWinRate(summary.winRate, summary.games);
    $("#metricWins").textContent = Number(summary.wins || 0).toLocaleString("ko-KR");
    $("#metricLosses").textContent = Number(summary.losses || 0).toLocaleString("ko-KR");
    $("#metricChampionCount").textContent = Number(summary.championCount ?? summary.champions?.length ?? 0).toLocaleString("ko-KR");
    $("#metricGamesFoot").textContent = state.selectedQueues.size ? "선택 모드 기준" : "선택된 게임 모드 없음";
    $("#metricWinrateFoot").textContent = `${Number(summary.wins || 0)}승 / ${Number(summary.games || 0)}경기`;
    $("#metricRecordFoot").textContent = summary.games ? "이번 주 전적" : "경기 기록 없음";
    $("#metricChampionFoot").textContent = summary.championCount ? `${summary.championCount}개 챔피언 사용` : "아직 플레이한 챔피언이 없어요";
    $("#activityGames").textContent = Number(summary.games || 0).toLocaleString("ko-KR");
    $("#activityTrend").textContent = `KST · ${formatShortDate(getKstWeekBounds().start)} 시작`;
    $("#qualityKda").textContent = formatKda(summary);
    $("#qualityCs").textContent = formatAverageCs(summary.avgCs, summary.games);
    $("#qualityDuration").textContent = formatDuration(summary.avgDuration, summary.games);
    $("#qualityFooter").textContent = summary.games
      ? `총 ${summary.games}경기의 평균 지표 · 계정별 합산`
      : "이번 주 경기를 플레이하면 요약을 계산합니다.";
    renderChampionRows(summary);
    renderWeekChart(summary);
    renderSourceBadge(source);
    renderAccountList();
  }

  function renderQueueFilters() {
    $$(".queue-chip[data-queue-group]").forEach((button) => {
      const group = button.dataset.queueGroup;
      const selected = QUEUE_GROUPS[group].some((queueId) => state.selectedQueues.has(queueId));
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
  }

  function regionLabel(region) {
    return region === "jp1" ? "JP1 · 일본" : "KR · 한국";
  }

  function openAccountDialog() {
    const dialog = $("#accountDialog");
    $("#dialogError").hidden = true;
    $("#riotIdInput").value = "";
    $("#accountRegion").value = "kr";
    if (state.accounts.length >= 10) {
      showNotice("warning", "계정 한도에 도달했어요", "Riot ID는 최대 10개까지 등록할 수 있습니다. 기존 계정을 삭제한 뒤 추가해 주세요.");
      return;
    }
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    $("#riotIdInput").focus();
  }

  function closeAccountDialog() {
    const dialog = $("#accountDialog");
    if (typeof dialog.close === "function" && dialog.open) dialog.close();
    else dialog.removeAttribute("open");
  }

  function setDialogError(message) {
    const error = $("#dialogError");
    error.textContent = message;
    error.hidden = false;
  }

  function parseRiotId(value) {
    const separator = value.lastIndexOf("#");
    if (separator <= 0 || separator === value.length - 1) return null;
    const gameName = value.slice(0, separator).trim();
    const tagLine = value.slice(separator + 1).trim();
    if (!gameName || !tagLine) return null;
    return { gameName, tagLine };
  }

  function handleAddAccount(event) {
    event.preventDefault();
    const parsed = parseRiotId($("#riotIdInput").value.trim());
    if (!parsed) {
      setDialogError("Riot ID를 게임이름#태그라인 형식으로 입력해 주세요.");
      return;
    }
    if (state.accounts.length >= 10) {
      setDialogError("계정은 최대 10개까지 등록할 수 있습니다.");
      return;
    }
    const account = {
      ...parsed,
      region: $("#accountRegion").value,
    };
    if (state.accounts.some((existing) => getAccountKey(existing) === getAccountKey(account))) {
      setDialogError("같은 Riot ID와 지역이 이미 등록되어 있습니다.");
      return;
    }

    state.accounts.push(account);
    saveAccounts();
    state.actualStats = null;
    renderOverview(getDemoStats(), "demo");
    closeAccountDialog();

    if (state.apiConfigured) {
      showNotice("info", "계정을 추가했어요", "현재 주간 전적을 Riot API에서 불러옵니다.");
      refreshStats();
    } else {
      showNotice("info", "계정을 저장했어요", "실제 전적 조회를 위해 프로젝트의 .env에 RIOT_API_KEY를 설정한 뒤 서버를 다시 실행해 주세요. 현재 수치는 샘플 데이터입니다.");
    }
  }

  function handleRemoveAccount(index) {
    const account = state.accounts[index];
    if (!account) return;
    state.accounts.splice(index, 1);
    saveAccounts();
    state.actualStats = null;
    renderAccountList();
    if (state.apiConfigured && state.accounts.length) {
      refreshStats();
    } else {
      renderOverview(getDemoStats(), "demo");
      showNotice("info", "계정을 삭제했어요", "삭제한 Riot ID는 이 브라우저의 계정 목록에서 제거했습니다.");
    }
  }

  async function checkServerStatus() {
    try {
      const response = await fetch("/api/status", { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("서버 상태를 확인할 수 없습니다.");
      const status = await response.json();
      state.serverAvailable = true;
      state.apiConfigured = Boolean(status.apiConfigured);
      return status;
    } catch {
      state.serverAvailable = false;
      state.apiConfigured = false;
      return null;
    }
  }

  async function refreshStats() {
    if (state.loadingStats) return;
    if (!state.selectedQueues.size) {
      state.actualStats = null;
      renderOverview(summarizeMatches([]), "demo");
      showNotice("info", "게임 모드를 선택해 주세요", "통계를 보려면 솔로·듀오, 자유 랭크, 일반 게임 중 하나 이상을 선택하세요.");
      return;
    }
    if (!state.accounts.length) {
      state.actualStats = null;
      renderOverview(getDemoStats(), "demo");
      showNotice("info", "Riot ID를 먼저 등록해 주세요", "계정 관리에서 최대 10개의 Riot ID를 추가할 수 있습니다. 현재 화면은 샘플 데이터입니다.");
      return;
    }
    if (!state.apiConfigured) {
      state.actualStats = null;
      renderOverview(getDemoStats(), "demo");
      const detail = state.serverAvailable
        ? "프로젝트의 .env에 RIOT_API_KEY를 설정하고 서버를 다시 실행하면 실제 전적을 조회할 수 있습니다. 현재 화면은 샘플 데이터입니다."
        : "npm start로 로컬 서버를 실행하고 .env에 RIOT_API_KEY를 설정하면 실제 전적을 조회할 수 있습니다. 현재 화면은 샘플 데이터입니다.";
      showNotice("info", "Riot API 키가 설정되지 않았어요", detail);
      return;
    }

    state.loadingStats = true;
    const requestedWeekStart = getKstWeekBounds().start;
    const refreshButton = $("#refreshButton");
    refreshButton.disabled = true;
    refreshButton.classList.add("is-spinning");
    renderSourceBadge("loading");
    clearNotice();
    try {
      const response = await fetch("/api/weekly-stats", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          accounts: state.accounts,
          queueIds: [...state.selectedQueues],
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(result.error || "전적을 불러오지 못했습니다.");
        error.errors = result.errors;
        throw error;
      }
      if (requestedWeekStart !== getKstWeekBounds().start) return;
      state.actualStats = result;
      renderOverview(result.total || summarizeMatches([]), "riot");
      if (result.errors?.length) {
        const first = result.errors[0];
        const extra = result.errors.length > 1 ? ` 외 ${result.errors.length - 1}개 계정` : "";
        showNotice("warning", "일부 계정을 조회하지 못했어요", `${first.riotId || "계정"}${extra}: ${first.message} 나머지 조회 결과는 표시 중입니다.`);
      } else if (result.warnings?.length) {
        showNotice("warning", "조회 결과를 확인해 주세요", result.warnings.join(" "));
      }
    } catch (error) {
      state.actualStats = null;
      renderOverview(getDemoStats(), "demo");
      const details = Array.isArray(error.errors) && error.errors.length
        ? `${error.message} ${error.errors[0].message || ""}`
        : error.message;
      showNotice("error", "전적을 불러오지 못했어요", `${details} API 키와 Riot ID를 확인한 뒤 새로고침을 눌러 다시 시도해 주세요. 현재 표시는 샘플 데이터입니다.`);
    } finally {
      state.loadingStats = false;
      refreshButton.disabled = false;
      refreshButton.classList.remove("is-spinning");
      const currentWeekStart = getKstWeekBounds().start;
      if (requestedWeekStart !== currentWeekStart) {
        if (currentWeekStart !== observedWeekStart) checkWeekBoundary();
        else if (state.apiConfigured && state.accounts.length) refreshStats();
      }
    }
  }

  function setView(viewName) {
    if (!["overview", "champions"].includes(viewName)) return;
    state.activeView = viewName;
    $("#overviewView").hidden = viewName !== "overview";
    $("#championsView").hidden = viewName !== "champions";
    $$(".nav-link[data-view]").forEach((button) => {
      button.classList.toggle("active", button.dataset.view === viewName);
    });
    $("#breadcrumbTitle").textContent = viewName === "champions" ? "스킬 도감" : "주간 분석";
    if (viewName === "champions") {
      $("#championSearch").focus({ preventScroll: true });
      selectChampion(state.selectedChampionId);
    }
  }

  function dataDragonImage(kind, full) {
    if (!full || !state.patch || state.patch === FALLBACK_PATCH) return "";
    return `${DD_BASE}/cdn/${encodeURIComponent(state.patch)}/img/${kind}/${encodeURIComponent(full)}`;
  }

  function getDamageLabel(championId, key) {
    return DAMAGE_TAGS[championId]?.[key.toLowerCase()] || "피해 유형 미확인";
  }

  function damageClass(label) {
    if (label.includes("미확인")) return "type-unknown";
    if (label.includes("고정") && (label.includes("마법") || label.includes("물리"))) return "type-mixed";
    if (label.includes("고정")) return "type-true";
    if (label.includes("물리") && label.includes("마법")) return "type-mixed";
    if (label.includes("물리")) return "type-physical";
    if (label.includes("마법")) return "type-magic";
    return "type-unknown";
  }

  function formatCooldown(spell) {
    if (spell?.cooldownBurn && spell.cooldownBurn !== "0") {
      return plainText(spell.cooldownBurn).replace(/\s*\/\s*/g, " / ");
    }
    const values = Array.isArray(spell?.cooldown) ? spell.cooldown.filter((value) => Number(value) > 0) : [];
    if (!values.length) return "";
    return values.map((value) => {
      const number = Number(value);
      return Number.isInteger(number) ? String(number) : number.toFixed(1).replace(/\.0$/, "");
    }).join(" / ");
  }

  function formatRange(spell) {
    const values = Array.isArray(spell?.range) ? spell.range.filter((value) => Number(value) > 0) : [];
    const unique = [...new Set(values.map(Number))];
    if (unique.length) return unique.map((value) => String(value)).join(" / ");
    const burn = plainText(spell?.rangeBurn || "");
    if (burn && burn !== "0") return burn;
    return "";
  }

  function hasNumberAtLeast(value, threshold) {
    return (String(value || "").match(/\d+(?:\.\d+)?/g) || [])
      .map(Number)
      .some((number) => number >= threshold);
  }

  function renderPassiveDetailBlock(details, loading, error) {
    if (details?.available) {
      const detailText = String(details.description || "").trim();
      const extraLines = [];
      if (details.cooldown && !/(재사용|쿨다운)/.test(detailText)) {
        extraLines.push(`내부 재사용 대기시간: ${details.cooldown}.`);
      }
      if (details.range && !/사거리/.test(detailText)) {
        extraLines.push(`표시 사거리: ${details.range} 게임 거리.`);
      }
      const fullText = [detailText, ...extraLines].filter(Boolean).join("\n\n");
      return `<div class="passive-detail-panel">
        <div class="passive-detail-heading">
          <span><i class="passive-detail-dot"></i>숫자 포함 상세 설명</span>
          <small>${escapeHTML(details.source || "최신 게임 데이터")}</small>
        </div>
        <p class="passive-detail-copy">${escapeHTML(fullText || "패시브 상세 설명을 제공하지 않습니다.")}</p>
      </div>`;
    }

    if (loading) {
      return `<div class="passive-detail-panel passive-loading">
        <div class="passive-detail-heading"><span><i class="passive-detail-dot"></i>수치 상세 불러오는 중</span><small>최신 게임 데이터</small></div>
        <div class="passive-loading-track"><span></span></div>
      </div>`;
    }

    const message = error || details?.message || "기본 설명만 표시 중입니다. 연결을 확인한 뒤 챔피언을 다시 선택해 주세요.";
    return `<div class="passive-detail-panel passive-unavailable">
      <div class="passive-detail-heading"><span>수치 상세를 불러오지 못했습니다</span><small>기본 설명 표시 중</small></div>
      <p class="passive-detail-copy">${escapeHTML(message)}</p>
    </div>`;
  }

  function createSkillCard({
    key,
    spell,
    championId,
    passive = false,
    passiveDetails = null,
    passiveLoading = false,
    passiveError = "",
  }) {
    const slot = passive ? "passive" : key.toLowerCase();
    const damage = getDamageLabel(championId, slot);
    const imageUrl = dataDragonImage(passive ? "passive" : "spell", spell?.image?.full);
    const icon = imageUrl
      ? `<img class="skill-icon" src="${escapeHTML(imageUrl)}" alt="" loading="lazy" data-fallback="${escapeHTML(passive ? "P" : key)}" />`
      : `<span class="skill-icon">${escapeHTML(passive ? "P" : key)}</span>`;
    const abilityName = plainText(spell?.name || (passive ? "패시브" : `${key} 스킬`));
    const description = plainText(spell?.description || "설명을 제공하지 않는 스킬입니다.");
    const range = passive ? "" : formatRange(spell);
    const cooldown = passive ? "" : formatCooldown(spell);
    const damageTag = `<span class="skill-tag ${damageClass(damage)}">${escapeHTML(damage)}</span>`;
    const rangeWarning = !passive && hasNumberAtLeast(range, 650);
    const cooldownWarning = !passive && hasNumberAtLeast(cooldown, 10);
    const safeDescription = escapeHTML(description || "스킬 설명을 제공하지 않습니다.");
    const descriptionMarkup = passive
      ? passiveDetails?.available
        ? ""
        : `<p class="skill-desc">${safeDescription}</p>`
      : `<details class="skill-description-disclosure">
          <summary class="skill-description-toggle">
            <span class="skill-disclosure-label"><span class="label-closed">자세히 보기</span><span class="label-open">접기</span></span>
          </summary>
          <p class="skill-desc">${safeDescription}</p>
        </details>`;
    const skillTags = !passive
      ? `<div class="skill-tags">
          <span class="skill-tag${rangeWarning ? " is-warning" : ""}">${escapeHTML(range ? `사거리 ${range}` : "사거리 미확인")}</span>
          <span class="skill-tag${cooldownWarning ? " is-warning" : ""}">${escapeHTML(cooldown ? `재사용 ${cooldown}초` : "재사용 미확인")}</span>
          ${damageTag}
        </div>`
      : "";
    const passiveDetail = passive
      ? renderPassiveDetailBlock(passiveDetails, passiveLoading, passiveError)
      : "";

    return `<article class="skill-card${passive ? " passive-card" : ""}">
      <div class="skill-card-head">
        ${icon}
        <span class="skill-key${passive ? " passive-key" : ""}">${passive ? "PASSIVE" : key}</span>
        <span class="skill-name-wrap"><h3>${escapeHTML(abilityName)}</h3><span>${passive ? "기본 지속 효과" : `${key} 스킬 · ${key === "R" ? "최대 3레벨" : "최대 5레벨"}`}</span></span>
      </div>
       ${descriptionMarkup}
       ${skillTags}
       ${passiveDetail}
     </article>`;
  }

  function renderChampionDetails(champion) {
    if (!champion) return;
    $("#skillHeadingTitle").textContent = `${champion.name || "챔피언"} 스킬 정보`;

    const passive = champion.passive || { name: "패시브", description: "" };
    const spells = Array.isArray(champion.spells) ? champion.spells : [];
    const passiveDetails = state.passiveDetailCache.get(champion.id);
    const passiveError = state.passiveDetailErrors.get(champion.id);
    const abilityCards = [
      createSkillCard({
        key: "P",
        spell: passive,
        championId: champion.id,
        passive: true,
        passiveDetails,
        passiveLoading: state.passiveDetailLoading.has(champion.id),
        passiveError,
      }),
      ...["Q", "W", "E", "R"].map((key, index) =>
        createSkillCard({ key, spell: spells[index] || {}, championId: champion.id })
      ),
    ];
    $("#skillGrid").innerHTML = abilityCards.join("");
  }

  function renderChampionList(search = $("#championSearch").value) {
    const normalized = String(search || "").trim().toLocaleLowerCase();
    const filtered = state.champions.filter((champion) =>
      `${champion.name} ${champion.id} ${champion.title || ""}`.toLocaleLowerCase().includes(normalized)
    );
    $("#championTotal").textContent = state.champions.length;
    const list = $("#championList");
    if (!filtered.length) {
      list.innerHTML = `<div class="champion-list-empty">검색 결과가 없습니다.</div>`;
      return;
    }

    list.innerHTML = filtered.map((champion) => {
      const image = dataDragonImage("champion", champion.image?.full);
      const icon = image
        ? `<img src="${escapeHTML(image)}" alt="" loading="lazy" data-fallback="${escapeHTML(champion.name.slice(0, 1))}" />`
        : `<span class="option-fallback">${escapeHTML(champion.name.slice(0, 1))}</span>`;
      const selected = champion.id === state.selectedChampionId;
      return `<button type="button" class="champion-option${selected ? " selected" : ""}" role="option" aria-selected="${selected}" data-champion-id="${escapeHTML(champion.id)}">
        ${icon}<span>${escapeHTML(champion.name)}</span><span class="option-check">✓</span>
      </button>`;
    }).join("");
  }

  async function loadPassiveDetail(champion, fullDetail) {
    if (!champion || state.passiveDetailCache.has(champion.id) || state.passiveDetailLoading.has(champion.id)) return;
    const passiveName = fullDetail?.passive?.name || champion.passive?.name;
    if (!passiveName) return;

    state.passiveDetailLoading.add(champion.id);
    state.passiveDetailErrors.delete(champion.id);
    renderChampionDetails(fullDetail || champion);
    try {
      const url = `/api/champion-passive/${encodeURIComponent(champion.id)}?name=${encodeURIComponent(passiveName)}`;
      const response = await fetch(url, { headers: { Accept: "application/json" } });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "패시브 수치 상세를 가져오지 못했습니다.");
      state.passiveDetailCache.set(champion.id, result);
    } catch (error) {
      state.passiveDetailErrors.set(champion.id, error.message || "패시브 수치 상세를 가져오지 못했습니다.");
    } finally {
      state.passiveDetailLoading.delete(champion.id);
      if (state.selectedChampionId === champion.id) renderChampionDetails(fullDetail || champion);
    }
  }

  async function selectChampion(id) {
    const selected = state.champions.find((champion) => champion.id === id);
    if (!selected) return;
    state.selectedChampionId = id;
    renderChampionList();
    renderChampionDetails(selected);

    if (!state.patch || state.patch === FALLBACK_PATCH) return;
    const cacheKey = `${state.patch}:${id}`;
    let detail = state.championDetailCache.get(cacheKey);

    if (!detail) {
      try {
        const response = await fetch(`${DD_BASE}/cdn/${encodeURIComponent(state.patch)}/data/ko_KR/champion/${encodeURIComponent(id)}.json`);
        if (!response.ok) throw new Error("챔피언 상세 정보를 가져오지 못했습니다.");
        const result = await response.json();
        detail = result?.data?.[id];
        if (!detail) throw new Error("챔피언 상세 정보가 비어 있습니다.");
        state.championDetailCache.set(cacheKey, detail);
      } catch {
        if (state.selectedChampionId === id) {
          $("#patchVersion").textContent = `v${state.patch} · 연결 실패`;
        }
        return;
      }
    }

    if (state.selectedChampionId !== id) return;
    renderChampionDetails(detail);
    if (state.activeView === "champions") await loadPassiveDetail(selected, detail);
  }

  async function loadChampionCatalog() {
    state.champions = FALLBACK_CHAMPIONS;
    state.championById = new Map(FALLBACK_CHAMPIONS.map((champion) => [champion.id, champion]));
    renderChampionList("");
    renderChampionDetails(FALLBACK_CHAMPIONS[0]);

    try {
      const versionsResponse = await fetch(`${DD_BASE}/api/versions.json`);
      if (!versionsResponse.ok) throw new Error("패치 버전을 확인할 수 없습니다.");
      const versions = await versionsResponse.json();
      const latest = Array.isArray(versions) ? versions[0] : null;
      if (!latest) throw new Error("패치 버전 정보가 비어 있습니다.");

      const catalogResponse = await fetch(`${DD_BASE}/cdn/${encodeURIComponent(latest)}/data/ko_KR/champion.json`);
      if (!catalogResponse.ok) throw new Error("챔피언 목록을 가져오지 못했습니다.");
      const catalogJson = await catalogResponse.json();
      const champions = Object.values(catalogJson?.data || {})
        .sort((a, b) => a.name.localeCompare(b.name, "ko"));
      if (!champions.length) throw new Error("챔피언 목록이 비어 있습니다.");

      state.patch = latest;
      state.champions = champions;
      state.championById = new Map(champions.map((champion) => [champion.id, champion]));
      $("#patchVersion").textContent = `v${latest}`;
      $("#championSearch").placeholder = "챔피언 이름 검색";
      renderChampionList("");
      const defaultChampion = champions.some((champion) => champion.id === state.selectedChampionId)
        ? state.selectedChampionId
        : champions[0].id;
      await selectChampion(defaultChampion);
    } catch {
      state.patch = FALLBACK_PATCH;
      $("#patchVersion").textContent = "오프라인 모드";
      renderChampionList("");
      renderChampionDetails(FALLBACK_CHAMPIONS.find((champion) => champion.id === state.selectedChampionId) || FALLBACK_CHAMPIONS[0]);
    }
  }

  function addEventListeners() {
    $$(".nav-link[data-view], .practice-button[data-view]").forEach((button) => {
      button.addEventListener("click", () => setView(button.dataset.view));
    });
    $$(".nav-link[data-action='accounts']").forEach((button) => {
      button.addEventListener("click", openAccountDialog);
    });

    $("#refreshButton").addEventListener("click", refreshStats);
    $("#addAccountButton").addEventListener("click", openAccountDialog);
    $("#accountForm").addEventListener("submit", handleAddAccount);
    $("#closeDialogButton").addEventListener("click", closeAccountDialog);
    $("#cancelDialogButton").addEventListener("click", closeAccountDialog);
    $("#accountDialog").addEventListener("click", (event) => {
      if (event.target === $("#accountDialog")) closeAccountDialog();
    });

    $("#accountList").addEventListener("click", (event) => {
      const button = event.target.closest("[data-remove-account]");
      if (button) handleRemoveAccount(Number(button.dataset.removeAccount));
    });

    $$(".queue-chip[data-queue-group]").forEach((button) => {
      button.addEventListener("click", () => {
        const group = QUEUE_GROUPS[button.dataset.queueGroup];
        const isSelected = group.some((queueId) => state.selectedQueues.has(queueId));
        group.forEach((queueId) => {
          if (isSelected) state.selectedQueues.delete(queueId);
          else state.selectedQueues.add(queueId);
        });
        saveQueues();
        renderQueueFilters();
        if (state.apiConfigured && state.accounts.length && state.selectedQueues.size) {
          refreshStats();
        } else {
          state.actualStats = null;
          renderOverview(getDemoStats(), "demo");
        }
      });
    });

    $("#championSearch").addEventListener("input", (event) => renderChampionList(event.target.value));
    $("#championList").addEventListener("click", (event) => {
      const button = event.target.closest("[data-champion-id]");
      if (button) selectChampion(button.dataset.championId);
    });

    document.addEventListener("error", (event) => {
      const image = event.target;
      if (!(image instanceof HTMLImageElement)) return;
      image.hidden = true;
      if (image.matches(".champion-avatar")) {
        const fallback = document.createElement("span");
        fallback.className = "champion-avatar fallback";
        fallback.textContent = image.dataset.fallback || "?";
        image.insertAdjacentElement("afterend", fallback);
      } else if (image.matches(".champion-option img")) {
        const fallback = document.createElement("span");
        fallback.className = "option-fallback";
        fallback.textContent = image.dataset.fallback || "?";
        image.insertAdjacentElement("afterend", fallback);
      } else if (image.matches(".skill-icon")) {
        const fallback = document.createElement("span");
        fallback.className = "skill-icon";
        fallback.textContent = image.dataset.fallback || "?";
        image.insertAdjacentElement("afterend", fallback);
      }
    }, true);

    document.addEventListener("keydown", (event) => {
      if (event.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) {
        event.preventDefault();
        setView("champions");
        $("#championSearch").focus();
      }
      if (event.key === "Escape" && $("#accountDialog").open) closeAccountDialog();
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) checkWeekBoundary();
    });
  }

  async function initialize() {
    updateWeekLabels();
    renderQueueFilters();
    renderOverview(getDemoStats(), "demo");
    renderChampionList("");
    addEventListeners();
    scheduleWeekBoundaryCheck();

    const [status] = await Promise.all([checkServerStatus(), loadChampionCatalog()]);
    renderOverview(state.actualStats || getDemoStats(), state.actualStats ? "riot" : "demo");
    if (!state.accounts.length) {
      showNotice(
        "info",
        "샘플 데이터로 미리보기 중",
        "최대 10개의 Riot ID를 등록하고 서버에 Riot API 키를 설정하면 실제 주간 전적을 확인할 수 있습니다.",
      );
      return;
    }
    if (!status?.apiConfigured) {
      showNotice(
        "info",
        "샘플 데이터로 미리보기 중",
        "계정 목록은 이 브라우저에 저장되어 있습니다. 실제 조회를 위해 .env에 RIOT_API_KEY를 설정해 주세요.",
      );
      return;
    }
    await refreshStats();
  }

  initialize();
})();
