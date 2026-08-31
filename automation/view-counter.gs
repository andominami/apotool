/**
 * 保険算定ルールノートの「閲覧数」を数えるための、単体のGoogle Apps Scriptプロジェクト。
 * Webアプリとして公開し、サイト側(assets/app.js)からGET通信で叩く。
 *
 * セットアップ手順は automation/view-counter-README.md を参照。
 *
 * エンドポイント（すべてGETのみ）:
 *   ?action=counts        … 全ルールの閲覧数を { "rule-001": 3, "rule-002": 10, ... } の形で返す
 *   ?action=hit&id=xxx     … 指定したルールIDの閲覧数を1増やし、増えた後の件数を返す
 *
 * 保存先はこのスクリプト自体のプロパティ(PropertiesService)。
 * スプレッドシートやGitHubへのアクセス権限は一切使わない、独立した小さな仕組み。
 */

function doGet(e) {
  const action = (e.parameter.action || "counts").trim();

  if (action === "hit") {
    const id = (e.parameter.id || "").trim();
    if (!id) {
      return jsonResponse({ error: "id is required" });
    }
    const count = incrementCount(id);
    return jsonResponse({ id, count });
  }

  return jsonResponse(getCounts());
}

/** 閲覧数を1増やす。同時アクセスでのカウントロスを防ぐためロックを取る。 */
function incrementCount(id) {
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const counts = getCounts();
    counts[id] = (counts[id] || 0) + 1;
    PropertiesService.getScriptProperties().setProperty(
      "view_counts",
      JSON.stringify(counts)
    );
    return counts[id];
  } finally {
    lock.releaseLock();
  }
}

function getCounts() {
  const raw = PropertiesService.getScriptProperties().getProperty("view_counts");
  return raw ? JSON.parse(raw) : {};
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
