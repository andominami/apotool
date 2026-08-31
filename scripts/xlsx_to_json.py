#!/usr/bin/env python3
"""
data/source.xlsx (保険算定ルール一覧シート) を data/rules.json に変換するスクリプト。

使い方:
    python3 scripts/xlsx_to_json.py

新しいルールを追加したいときは data/source.xlsx の「保険算定ルール一覧」シートに
行を追加してから、このスクリプトを実行して data/rules.json を再生成してください。

写真を付けたい場合は、Excel上でその行のセル（添付画像列あたり）に画像を
そのまま貼り付けてください。スクリプトが行に紐づく画像を自動で検出し、
assets/photos/ に書き出したうえで rules.json の "images" に登録します。
"""
import json
import re
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "source.xlsx"
DST = ROOT / "data" / "rules.json"
PHOTOS_DIR = ROOT / "assets" / "photos"

# カテゴリ表記のゆれをまとめて、サイドバーで使う大分類にするためのルール
GROUP_OVERRIDES = {
    "レセプト・カルテ運用": "レセプト・カルテ",
    "健診→治療移行の入力": "健診",
    "健診→歯管の算定": "健診",
    "健診→治療開始日": "健診",
    "健診→初再診料": "健診",
    "文書算定": "文書",
}

# 1件しかない大分類は「その他」にまとめる
MERGE_TO_OTHER_THRESHOLD = 2


def base_group(category: str) -> str:
    if category in GROUP_OVERRIDES:
        return GROUP_OVERRIDES[category]
    # 「(」や「→」より前をグループ名とする
    m = re.match(r"^([^(（→]+)", category)
    name = m.group(1).strip() if m else category
    return GROUP_OVERRIDES.get(name, name)


def slugify(no: int) -> str:
    return f"rule-{no:03d}"


def extract_images_by_rule(ws) -> dict:
    """シートに貼り付けられた画像を、アンカーされている行(=ルールNo)ごとにまとめて返す。"""
    images_by_rule: dict[int, list] = {}
    for img in getattr(ws, "_images", []):
        rule_no = img.anchor._from.row  # 0-indexed行番号 = ヘッダー分ずれてルールNoと一致
        images_by_rule.setdefault(rule_no, []).append(img)
    return images_by_rule


def write_rule_images(rule_no: int, images: list) -> list:
    """1ルール分の画像をassets/photos/に書き出し、サイトから参照する相対パスの一覧を返す。"""
    PHOTOS_DIR.mkdir(parents=True, exist_ok=True)
    paths = []
    for i, img in enumerate(images, start=1):
        ext = (img.format or "png").lower()
        ext = "jpg" if ext in ("jpeg", "jpg") else ext
        filename = f"rule-{rule_no:03d}-{i}.{ext}"
        (PHOTOS_DIR / filename).write_bytes(img._data())
        paths.append(f"assets/photos/{filename}")
    return paths


def load_existing_archived_flags() -> dict:
    """既存のrules.jsonから、ルールNoごとのarchived状態を読み取る(再生成時に維持するため)。"""
    if not DST.exists():
        return {}
    try:
        existing = json.loads(DST.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}
    return {r["no"]: bool(r.get("archived", False)) for r in existing}


def main() -> None:
    wb = openpyxl.load_workbook(SRC, data_only=True)
    ws = wb["保険算定ルール一覧"]
    images_by_rule = extract_images_by_rule(ws)
    archived_flags = load_existing_archived_flags()

    rows = []
    for row in ws.iter_rows(min_row=2, values_only=True):
        no = row[0]
        if no is None:
            continue
        date, category, title, detail = row[1], row[2], row[3], row[4]
        category = (category or "").strip()
        title = (title or "").strip()
        detail = (detail or "").strip()
        images = write_rule_images(no, images_by_rule.get(no, []))
        rows.append(
            {
                "no": no,
                "id": slugify(no),
                "date": str(date).strip() if date else "",
                "category": category,
                "group": base_group(category),
                "title": title,
                "detail": detail,
                "images": images,
                # data/rules.json 上で直接archivedをtrueにしたルールは、
                # このスクリプトを再実行してもアーカイブ状態を維持する。
                "archived": archived_flags.get(no, False),
            }
        )

    # グループの出現回数を数え、少数派グループは「その他」に統合する
    counts = {}
    for r in rows:
        counts[r["group"]] = counts.get(r["group"], 0) + 1
    for r in rows:
        if counts[r["group"]] < MERGE_TO_OTHER_THRESHOLD:
            r["group"] = "その他"

    rows.sort(key=lambda r: r["no"])

    DST.write_text(
        json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    image_count = sum(len(r["images"]) for r in rows)
    print(f"wrote {len(rows)} rules ({image_count} images) to {DST}")


if __name__ == "__main__":
    main()
