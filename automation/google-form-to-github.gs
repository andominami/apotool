/**
 * Googleフォームの回答（に紐づくスプレッドシート）から自動で発火し、
 * andominami/tanpopo リポジトリの data/rules.json に新しいルールを追加して、
 * GitHub Pages のサイトへ自動反映するスクリプト。
 *
 * セットアップ手順は automation/README.md を参照。
 *
 * 前提とするフォームの質問（このままの表記でOK。順番は問わない）:
 *   - タイトル                 （記述式・必須）
 *   - カテゴリ                 （プルダウン・必須。CATEGORIES と同じ選択肢にする）
 *   - 内容・詳細               （段落・必須）
 *   - 投稿者名                 （記述式・任意）
 *   - 写真                    （ファイルのアップロード・任意）
 *
 * 写真はGoogleフォームの仕様上、まず投稿者のGoogleドライブ（マイドライブ）に
 * 保存される。このスクリプトはその画像をGitHubへコピーしたうえで、
 * マイドライブの容量を圧迫しないようドライブ側のファイルを共有ドライブへ移動する
 * （DRIVE_BACKUP_FOLDER_ID が未設定の場合は、移動の代わりに完全削除する）。
 * サイトが表示する画像はGitHub上のコピーのみで、ドライブ側はあくまでバックアップ。
 *
 * 使う前に、スクリプトエディタの「プロジェクトの設定」→「スクリプト プロパティ」に
 * 以下を登録しておくこと（コードに直接書かない）:
 *   GITHUB_TOKEN          … リポジトリへの書き込み権限を持つGitHubのアクセストークン
 *   REPO_OWNER            … andominami
 *   REPO_NAME             … tanpopo
 *   DRIVE_BACKUP_FOLDER_ID … (任意) 写真の移動先にする共有ドライブ(またはフォルダ)のID。
 *                             ドライブでそのフォルダを開いたときのURL末尾の文字列。
 *                             未設定なら移動せず完全削除する。
 */

// サイドバーに表示する大分類。フォームの「カテゴリ」プルダウンと合わせること。
const CATEGORIES = [
  "歯周病治療",
  "カルテ入力",
  "レントゲン撮影",
  "口腔機能発達不全症",
  "歯科技工",
  "制度改定",
  "レセプト・カルテ",
  "健診",
  "文書",
  "その他",
];

const RULES_PATH = "data/rules.json";
const BRANCH = "main";
const MAX_RETRIES = 3;

/**
 * スプレッドシートの「フォーム送信時」トリガーから呼ばれる関数。
 * トリガーの設定方法は README 参照（onOpen等では自動発火しないため、
 * 手動でインストール型トリガーを登録する必要がある）。
 */
function onFormSubmit(e) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty("GITHUB_TOKEN");
  const owner = props.getProperty("REPO_OWNER");
  const repo = props.getProperty("REPO_NAME");

  if (!token || !owner || !repo) {
    throw new Error(
      "スクリプトプロパティに GITHUB_TOKEN / REPO_OWNER / REPO_NAME を設定してください。"
    );
  }

  const values = e.namedValues || {};
  const pick = (key) => ((values[key] || [])[0] || "").trim();

  const title = pick("タイトル");
  const category = pick("カテゴリ") || "その他";
  const detail = pick("内容・詳細");
  const author = pick("投稿者名");
  const photoAnswer = pick("写真"); // ファイルアップロード質問はDriveのURL(複数はカンマ区切り)が入る

  if (!title || !detail) {
    // 必須項目が空の場合は何もしない(フォーム側のバリデーションで基本発生しない想定)
    return;
  }

  const fullTitle = author ? `${title}【${author}】` : title;
  const date = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy/MM/dd");
  const group = CATEGORIES.includes(category) ? category : "その他";

  // GitHubへのコピーがすべて成功した後にまとめてドライブ側を削除するため、
  // 削除対象のファイルIDはここに集める(リトライ時は毎回リセットする)。
  let driveFileIdsToClean = [];

  runWithRetry(() => {
    driveFileIdsToClean = [];
    const { sha, rules } = fetchRulesJson(owner, repo, token);
    const nextNo = rules.reduce((max, r) => Math.max(max, r.no || 0), 0) + 1;
    const id = `rule-${String(nextNo).padStart(3, "0")}`;

    const { paths, fileIds } = uploadPhotos(owner, repo, token, id, photoAnswer);
    driveFileIdsToClean = fileIds;

    rules.push({
      no: nextNo,
      id,
      date,
      category: group,
      group,
      title: fullTitle,
      detail,
      images: paths,
    });

    putFile(
      owner,
      repo,
      token,
      RULES_PATH,
      JSON.stringify(rules, null, 2) + "\n",
      `フォームからルールを追加: ${title}`,
      sha
    );
  });

  // サイト側(GitHub)への保存が確定してから、マイドライブの容量を圧迫しないよう
  // アップロード元ファイルを片付ける。バックアップ先フォルダの設定があれば
  // そこへ移動(共有ドライブの容量として扱われる)、無ければ完全に削除する。
  const backupFolderId = props.getProperty("DRIVE_BACKUP_FOLDER_ID");
  driveFileIdsToClean.forEach((fileId) => {
    if (backupFolderId) {
      moveDriveFileToFolder(fileId, backupFolderId);
    } else {
      permanentlyDeleteDriveFile(fileId);
    }
  });
}

/** data/rules.json の現在の内容とshaを取得する */
function fetchRulesJson(owner, repo, token) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${RULES_PATH}?ref=${BRANCH}`;
  const res = UrlFetchApp.fetch(url, {
    headers: ghHeaders(token),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error(`rules.jsonの取得に失敗: ${res.getContentText()}`);
  }
  const meta = JSON.parse(res.getContentText());
  const content = Utilities.newBlob(
    Utilities.base64Decode(meta.content.replace(/\n/g, ""))
  ).getDataAsString("UTF-8");
  return { sha: meta.sha, rules: JSON.parse(content) };
}

/**
 * ファイルアップロード質問の回答(DriveのURL、複数はカンマ区切り)から画像をGitHubに書き出す。
 * 戻り値には、サイトが参照する相対パス一覧(paths)と、
 * コピー後にドライブから削除すべき元ファイルのID一覧(fileIds)を含める。
 */
function uploadPhotos(owner, repo, token, ruleId, photoAnswer) {
  if (!photoAnswer) return { paths: [], fileIds: [] };
  const urls = photoAnswer.split(",").map((s) => s.trim()).filter(Boolean);
  const paths = [];
  const fileIds = [];
  urls.forEach((url, i) => {
    const fileId = extractDriveFileId(url);
    if (!fileId) return;
    const file = DriveApp.getFileById(fileId);
    const blob = file.getBlob();
    const ext = extFromMimeType(blob.getContentType());
    const path = `assets/photos/${ruleId}-${i + 1}.${ext}`;
    putFile(
      owner,
      repo,
      token,
      path,
      null,
      `写真を追加 (${ruleId})`,
      null,
      Utilities.base64Encode(blob.getBytes())
    );
    paths.push(path);
    fileIds.push(fileId);
  });
  return { paths, fileIds };
}

/**
 * ドライブのファイルを指定フォルダ(共有ドライブでも可)へ移動する。
 * マイドライブから外れるので、個人の容量からは消費しなくなる。
 */
function moveDriveFileToFolder(fileId, destFolderId) {
  const file = DriveApp.getFileById(fileId);
  const destFolder = DriveApp.getFolderById(destFolderId);
  file.moveTo(destFolder);
}

/** ドライブのファイルをゴミ箱を経由せず完全に削除する(容量をすぐに解放するため) */
function permanentlyDeleteDriveFile(fileId) {
  // DriveAppの書き込み系メソッドを呼んでおくことで、スクリプトの権限スコープに
  // 書き込み権限が確実に含まれるようにする(このtry自体の成否は問わない)。
  try {
    DriveApp.getFileById(fileId).setTrashed(true);
  } catch (e) {
    // 既に削除済み・アクセス不可などは無視して次に進む
  }
  const token = ScriptApp.getOAuthToken();
  UrlFetchApp.fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: "delete",
    headers: { Authorization: `Bearer ${token}` },
    muteHttpExceptions: true,
  });
}

/**
 * GitHubにファイルを作成/更新する。
 * textContent か base64Content のどちらかを渡す。
 * sha を渡すと更新、渡さないと新規作成として扱われる。
 */
function putFile(owner, repo, token, path, textContent, message, sha, base64Content) {
  const content =
    base64Content !== undefined
      ? base64Content
      : Utilities.base64Encode(
          Utilities.newBlob(textContent, "application/json").getBytes()
        );

  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  const payload = { message, content, branch: BRANCH };
  if (sha) payload.sha = sha;

  const res = UrlFetchApp.fetch(url, {
    method: "put",
    headers: ghHeaders(token),
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const code = res.getResponseCode();
  if (code !== 200 && code !== 201) {
    throw new ConflictOrError(code, res.getContentText());
  }
}

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
  };
}

function extractDriveFileId(url) {
  const m = url.match(/[-\w]{25,}/);
  return m ? m[0] : null;
}

function extFromMimeType(mime) {
  if (mime.indexOf("png") !== -1) return "png";
  if (mime.indexOf("gif") !== -1) return "gif";
  if (mime.indexOf("webp") !== -1) return "webp";
  return "jpg";
}

/** data/rules.json は複数投稿が重なるとsha競合(409/422)することがあるため、少しだけ再試行する */
function runWithRetry(fn) {
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      fn();
      return;
    } catch (err) {
      const isConflict = err instanceof ConflictOrError && (err.code === 409 || err.code === 422);
      if (!isConflict || i === MAX_RETRIES - 1) throw err;
      Utilities.sleep(1000 * (i + 1));
    }
  }
}

class ConflictOrError extends Error {
  constructor(code, body) {
    super(`GitHub API error ${code}: ${body}`);
    this.code = code;
  }
}
