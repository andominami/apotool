#!/usr/bin/env python3
"""
保険算定ルール検索サイトに、ルールを1件だけ追加するスクリプト。

Teams等に投稿された内容をコピペで受け取り、追加する運用を想定。
エクセル全体を作り直さなくても、これ1本で
    data/insurance_rules.json への追記
    site/index.html の再生成
がまとめてできる。

使い方:
    python3 scripts/add_entry.py \
        --date 2026/08/28 \
        --category "カテゴリ名" \
        --title "タイトル" \
        --content "本文"

--date は省略可(その場合「日付不明」として登録される)。
"""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_PATH = ROOT / "data" / "insurance_rules.json"
TEMPLATE_PATH = ROOT / "site" / "template.html"
OUT_PATH = ROOT / "site" / "index.html"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--date", default=None, help="例: 2026/08/28")
    parser.add_argument("--category", required=True)
    parser.add_argument("--title", required=True)
    parser.add_argument("--content", required=True)
    args = parser.parse_args()

    rules = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    existing_nos = [r["no"] for r in rules if isinstance(r.get("no"), int)]
    next_no = max(existing_nos, default=0) + 1

    rules.append(
        {
            "no": next_no,
            "date": args.date,
            "category": args.category,
            "title": args.title,
            "content": args.content,
        }
    )

    DATA_PATH.write_text(
        json.dumps(rules, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    template = TEMPLATE_PATH.read_text(encoding="utf-8")
    html = template.replace("__DATA_JSON__", json.dumps(rules, ensure_ascii=False))
    OUT_PATH.write_text(html, encoding="utf-8")

    print(f"No.{next_no} を追加しました: {args.title}")
    print(f"合計 {len(rules)} 件になりました。")


if __name__ == "__main__":
    main()
