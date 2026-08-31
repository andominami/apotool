(() => {
  "use strict";

  // 投稿フォームの簡易パスワード保護。
  // ※クライアント側だけのチェックのため、詳しい人には回避され得る簡易的な鍵です。
  const POST_FORM_URL =
    "https://docs.google.com/forms/d/e/1FAIpQLSfD0SRJTTP10VZE7EXKJAajHBubjdcSkEqREyyBlnC46_aUCw/viewform";
  const POST_PASSWORD_HASH =
    "66b55e8173b171a6676f99cad64a02a2ed42f78800730cd82b9c8b43eef1993c";

  // 閲覧数カウンター(Google Apps Script Webアプリ)のURL。
  // 未設定(空文字)の間は閲覧数機能を静かに無効化する。
  // セットアップ方法は automation/view-counter-README.md を参照。
  const VIEW_COUNTER_API_URL = "https://script.google.com/macros/s/AKfycbx_2WFRtn47ikqtFZQux-O1h8QZUmTkZbtg6d9mGmzGNvUVvrf8wJBGMOuBXB92CwqtzQ/exec";

  const state = {
    rules: [],
    query: "",
    activeGroup: "all",
    sort: "date-desc",
    view: "current", // "current" | "archived"
  };

  const els = {
    searchInput: document.getElementById("search-input"),
    searchClear: document.getElementById("search-clear"),
    categoryList: document.getElementById("category-list"),
    ruleList: document.getElementById("rule-list"),
    resultCount: document.getElementById("result-count"),
    emptyState: document.getElementById("empty-state"),
    sortSelect: document.getElementById("sort-select"),
    overlay: document.getElementById("detail-overlay"),
    detailBody: document.getElementById("detail-body"),
    detailClose: document.getElementById("detail-close"),
    postOpenBtn: document.getElementById("post-open-btn"),
    postOverlay: document.getElementById("post-overlay"),
    postClose: document.getElementById("post-close"),
    postForm: document.getElementById("post-form"),
    postPassword: document.getElementById("post-password"),
    postError: document.getElementById("post-error"),
    viewTabs: document.querySelectorAll(".view-tab"),
  };

  function parseDate(d) {
    // "2023/01/05" 形式を想定。パースできない場合は最古扱い。
    const t = Date.parse((d || "").replace(/\//g, "-"));
    return Number.isNaN(t) ? -Infinity : t;
  }

  function normalize(str) {
    return (str || "")
      .toString()
      .toLowerCase()
      .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) =>
        String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
      )
      .trim();
  }

  function escapeHtml(str) {
    return (str || "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[ch]));
  }

  function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function highlight(text, terms) {
    const safe = escapeHtml(text);
    if (!terms.length) return safe;
    const pattern = new RegExp(
      "(" + terms.map((t) => escapeRegExp(escapeHtml(t))).join("|") + ")",
      "gi"
    );
    return safe.replace(pattern, "<mark>$1</mark>");
  }

  function getTerms() {
    return normalize(state.query)
      .split(/\s+/)
      .filter(Boolean);
  }

  function matchesQuery(rule, terms) {
    if (!terms.length) return true;
    const haystack = normalize(
      [rule.title, rule.category, rule.group, rule.detail].join(" ")
    );
    return terms.every((term) => haystack.includes(term));
  }

  function computeGroups(rules) {
    const counts = new Map();
    rules.forEach((r) => counts.set(r.group, (counts.get(r.group) || 0) + 1));
    const groups = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
    return groups;
  }

  // 現在の表示モード(現在の情報 / アーカイブ)で絞り込んだルール一覧
  function viewRules() {
    return state.rules.filter((r) =>
      state.view === "archived" ? !!r.archived : !r.archived
    );
  }

  function renderSidebar() {
    const rules = viewRules();
    const groups = computeGroups(rules);
    const items = [["all", "すべて", rules.length], ...groups.map(
      ([name, count]) => [name, name, count]
    )];

    els.categoryList.innerHTML = items
      .map(([value, label, count]) => {
        const active = state.activeGroup === value ? "active" : "";
        return `<li><button type="button" class="${active}" data-group="${escapeHtml(
          value
        )}">
          <span>${escapeHtml(label)}</span>
          <span class="count">${count}</span>
        </button></li>`;
      })
      .join("");
  }

  function getFiltered() {
    const terms = getTerms();
    let list = viewRules().filter((r) => {
      const groupOk = state.activeGroup === "all" || r.group === state.activeGroup;
      return groupOk && matchesQuery(r, terms);
    });

    list = list.slice().sort((a, b) => {
      if (state.sort === "date-asc") return parseDate(a.date) - parseDate(b.date);
      if (state.sort === "no-asc") return a.no - b.no;
      if (state.sort === "views-desc") return (b.views || 0) - (a.views || 0);
      return parseDate(b.date) - parseDate(a.date); // date-desc (default)
    });

    return { list, terms };
  }

  function snippetFor(rule, terms) {
    if (!terms.length) return rule.detail.slice(0, 80);
    const normDetail = normalize(rule.detail);
    const idx = normDetail.indexOf(terms[0]);
    if (idx === -1) return rule.detail.slice(0, 80);
    const start = Math.max(0, idx - 20);
    const prefix = start > 0 ? "…" : "";
    return prefix + rule.detail.slice(start, start + 100);
  }

  function viewCountBadge(rule) {
    if (typeof rule.views !== "number") return "";
    return `<span class="rule-views">👁 ${rule.views}</span>`;
  }

  function renderList() {
    const { list, terms } = getFiltered();

    els.resultCount.textContent = state.query.trim()
      ? `「${state.query.trim()}」の検索結果: ${list.length}件`
      : `全${list.length}件`;

    els.emptyState.hidden = list.length !== 0;
    els.ruleList.hidden = list.length === 0;
    els.emptyState.textContent =
      state.view === "archived" && !state.query.trim()
        ? "アーカイブされたルールはまだありません。"
        : "該当するルールが見つかりませんでした。別のキーワードで検索してください。";

    els.ruleList.innerHTML = list
      .map((rule) => {
        const snippet = snippetFor(rule, terms);
        const hasPhoto = rule.images && rule.images.length > 0;
        return `<li class="rule-card">
          <button type="button" class="rule-card-btn" data-id="${rule.id}">
            <div class="rule-meta">
              <span class="rule-badge">${escapeHtml(rule.group)}</span>
              <span class="rule-date">${escapeHtml(rule.date || "")}</span>
              ${hasPhoto ? '<span class="rule-photo-badge">📷 写真あり</span>' : ""}
              ${viewCountBadge(rule)}
            </div>
            <p class="rule-title">${highlight(rule.title, terms)}</p>
            <p class="rule-snippet">${highlight(snippet, terms)}</p>
          </button>
        </li>`;
      })
      .join("");
  }

  function renderDetail(rule) {
    const terms = getTerms();
    const paragraphs = rule.detail
      .split(/(?<=。)/)
      .map((s) => s.trim())
      .filter(Boolean);
    const images = rule.images || [];

    els.detailBody.innerHTML = `
      <div class="rule-meta">
        <span class="rule-badge">${escapeHtml(rule.group)}</span>
        <span class="rule-date">${escapeHtml(rule.date || "")}</span>
        ${viewCountBadge(rule)}
      </div>
      <h2 id="detail-title">${highlight(rule.title, terms)}</h2>
      <p class="rule-no">No.${rule.no} / ${escapeHtml(rule.category)}</p>
      <div class="rule-detail-text">
        ${paragraphs.map((p) => `<p>${highlight(p, terms)}</p>`).join("")}
      </div>
      ${
        images.length
          ? `<div class="rule-images">
              ${images
                .map(
                  (src) => `<a href="${escapeHtml(src)}" target="_blank" rel="noopener">
                    <img src="${escapeHtml(src)}" alt="添付画像" loading="lazy">
                  </a>`
                )
                .join("")}
            </div>`
          : ""
      }
      <div class="detail-actions">
        <button type="button" id="copy-link-btn">このルールへのリンクをコピー</button>
      </div>
    `;

    els.overlay.hidden = false;
    document.body.style.overflow = "hidden";

    const copyBtn = document.getElementById("copy-link-btn");
    copyBtn.addEventListener("click", async () => {
      const url = `${location.origin}${location.pathname}#${rule.id}`;
      try {
        await navigator.clipboard.writeText(url);
        copyBtn.textContent = "コピーしました";
      } catch (e) {
        copyBtn.textContent = url;
      }
      setTimeout(() => {
        copyBtn.textContent = "このルールへのリンクをコピー";
      }, 1800);
    });
  }

  function closeDetail() {
    els.overlay.hidden = true;
    document.body.style.overflow = "";
    if (location.hash) {
      history.replaceState(null, "", location.pathname + location.search);
    }
  }

  function openDetailById(id) {
    const rule = state.rules.find((r) => r.id === id);
    if (!rule) return;
    renderDetail(rule);
    recordView(rule);
  }

  /** 閲覧数カウンターへ通信し、全ルール分の件数を state.rules へ merge する */
  async function loadViewCounts() {
    if (!VIEW_COUNTER_API_URL) return;
    try {
      const res = await fetch(`${VIEW_COUNTER_API_URL}?action=counts`);
      const counts = await res.json();
      state.rules.forEach((r) => {
        r.views = counts[r.id] || 0;
      });
    } catch (err) {
      console.error("閲覧数の取得に失敗しました", err);
    }
  }

  /** ルールを開いたことをカウンターに記録する(結果を待たず、失敗しても表示には影響させない) */
  function recordView(rule) {
    if (!VIEW_COUNTER_API_URL) return;
    fetch(`${VIEW_COUNTER_API_URL}?action=hit&id=${encodeURIComponent(rule.id)}`)
      .then((res) => res.json())
      .then((data) => {
        if (typeof data.count !== "number") return;
        rule.views = data.count;
        // 反映が返ってきた時点でまだそのルールの詳細を開いたままなら、表示も更新する
        if (!els.overlay.hidden && location.hash.replace(/^#\/?/, "") === rule.id) {
          renderDetail(rule);
        }
      })
      .catch((err) => console.error("閲覧数の記録に失敗しました", err));
  }

  function bindEvents() {
    els.searchInput.addEventListener("input", (e) => {
      state.query = e.target.value;
      els.searchClear.classList.toggle("visible", state.query.length > 0);
      renderList();
    });

    els.searchClear.addEventListener("click", () => {
      state.query = "";
      els.searchInput.value = "";
      els.searchClear.classList.remove("visible");
      els.searchInput.focus();
      renderList();
    });

    els.sortSelect.addEventListener("change", (e) => {
      state.sort = e.target.value;
      renderList();
    });

    els.categoryList.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-group]");
      if (!btn) return;
      state.activeGroup = btn.dataset.group;
      renderSidebar();
      renderList();
    });

    els.viewTabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        if (state.view === tab.dataset.view) return;
        state.view = tab.dataset.view;
        state.activeGroup = "all"; // 表示を切り替えたらカテゴリ絞り込みはリセット
        els.viewTabs.forEach((t) => {
          const isActive = t === tab;
          t.classList.toggle("active", isActive);
          t.setAttribute("aria-selected", String(isActive));
        });
        renderSidebar();
        renderList();
      });
    });

    els.ruleList.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-id]");
      if (!btn) return;
      location.hash = btn.dataset.id;
    });

    els.detailClose.addEventListener("click", closeDetail);

    els.overlay.addEventListener("click", (e) => {
      if (e.target === els.overlay) closeDetail();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !els.overlay.hidden) closeDetail();
    });

    window.addEventListener("hashchange", handleHash);

    els.postOpenBtn.addEventListener("click", openPostOverlay);
    els.postClose.addEventListener("click", closePostOverlay);
    els.postOverlay.addEventListener("click", (e) => {
      if (e.target === els.postOverlay) closePostOverlay();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !els.postOverlay.hidden) closePostOverlay();
    });
    els.postForm.addEventListener("submit", handlePostSubmit);
  }

  function openPostOverlay() {
    els.postOverlay.hidden = false;
    els.postError.hidden = true;
    els.postPassword.value = "";
    document.body.style.overflow = "hidden";
    els.postPassword.focus();
  }

  function closePostOverlay() {
    els.postOverlay.hidden = true;
    document.body.style.overflow = "";
  }

  async function sha256Hex(text) {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async function handlePostSubmit(e) {
    e.preventDefault();
    const input = els.postPassword.value;
    const hash = await sha256Hex(input);
    if (hash === POST_PASSWORD_HASH) {
      // 新しいタブで開くと、パスワード照合(非同期処理)を挟んだ直後の
      // window.open() がスマホのSafari等でポップアップとしてブロックされることがあるため、
      // 同じタブでフォームへ遷移する(ブラウザの「戻る」でサイトに戻れる)。
      location.href = POST_FORM_URL;
    } else {
      els.postError.hidden = false;
      els.postPassword.select();
    }
  }

  function handleHash() {
    const id = location.hash.replace(/^#\/?/, "");
    if (id) {
      openDetailById(id);
    } else {
      closeDetail();
    }
  }

  async function init() {
    bindEvents();
    try {
      const res = await fetch("data/rules.json", { cache: "no-store" });
      state.rules = await res.json();
    } catch (err) {
      els.resultCount.textContent = "データの読み込みに失敗しました。";
      console.error(err);
      return;
    }

    await loadViewCounts();

    renderSidebar();
    renderList();
    handleHash();
  }

  init();
})();
