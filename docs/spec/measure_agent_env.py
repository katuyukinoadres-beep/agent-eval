# -*- coding: utf-8 -*-
"""measure_agent_env.py — Claude Code のローカルログ/設定を決定論的に実測する。

目的: **AI に測らせない**。サブエージェント/ワークフローの返り値は二次情報であり、
集計・推定の誤りが混じる（2026-08-18 Leon への返信で3件の数値を誤送信した事故）。
本スクリプトの出力は呼び出し元の tool 結果＝一次情報になる。

🚨 走査範囲と分母の定義で値が動く（実測: 走査範囲で1.26倍 / 分母定義で1.96倍）。
   そのため常に scanManifest を併記し、率ではなく分子と分母を生カウントで出す。

Usage:
    python -X utf8 scripts/measure_agent_env.py                # 人間可読サマリ
    python -X utf8 scripts/measure_agent_env.py --json         # 提出ペイロード形式
    python -X utf8 scripts/measure_agent_env.py --scope main   # main jsonl のみ
    python -X utf8 scripts/measure_agent_env.py --scope sub    # subagents サブツリーのみ
    python -X utf8 scripts/measure_agent_env.py --scope all    # 両方（既定）

正本: memory/feedback_minutes_summary_numbers_not_confirmed.md（射程拡張 2026-08-19）
"""
from __future__ import annotations

import argparse
import glob
import io
import json
import os
import sys
from collections import Counter

if sys.stdout is not None:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
if sys.stderr is not None:
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")

PROJECTS = os.path.expanduser("~/.claude/projects")
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKILLS_GLOB = os.path.join(REPO, ".claude", "skills", "*", "SKILL.md")

# 走査ルート定義（scanManifest にそのまま載せる）
ROOTS = {
    "main": ["projects/*/*.jsonl"],
    "sub": ["projects/*/*/subagents/**/*.jsonl"],
}


def collect_files(scope):
    main, sub = [], []
    for proj in glob.glob(os.path.join(PROJECTS, "*")):
        if not os.path.isdir(proj):
            continue
        main += glob.glob(os.path.join(proj, "*.jsonl"))
        sub += glob.glob(os.path.join(proj, "**", "subagents", "**", "*.jsonl"), recursive=True)
    sub = [f for f in sub if f not in set(main)]
    if scope == "main":
        return main
    if scope == "sub":
        return sub
    return main + sub


def scan(files):
    """分子と分母を生カウントで返す。率はここで計算しない（受け取り側が定義を揃える）。"""
    m = {
        "filesScanned": len(files),
        "linesScanned": 0,
        "bytesScanned": 0,
        "toolResultTotal": 0,
        "toolResultWithIsErrorKey": 0,
        "toolResultIsErrorTrue": 0,
        "attributionSkillRows": 0,
        "interruptedKeyRows": 0,
        "interruptedTrue": 0,
        "isSidechainTrue": 0,
        "isSidechainFalse": 0,
    }
    tokens = Counter()
    skills = Counter()
    models = Counter()
    versions = Counter()
    denials = Counter()

    for fp in files:
        try:
            m["bytesScanned"] += os.path.getsize(fp)
        except OSError:
            pass
        try:
            with io.open(fp, encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    line = line.strip()
                    if not line.startswith("{"):
                        continue
                    m["linesScanned"] += 1
                    try:
                        r = json.loads(line)
                    except Exception:
                        continue

                    if r.get("isSidechain") is True:
                        m["isSidechainTrue"] += 1
                    elif r.get("isSidechain") is False:
                        m["isSidechainFalse"] += 1

                    if r.get("version"):
                        versions[r["version"]] += 1
                    if r.get("attributionSkill"):
                        m["attributionSkillRows"] += 1
                        skills[r["attributionSkill"]] += 1
                    if r.get("toolDenialKind"):
                        denials[r["toolDenialKind"]] += 1

                    tur = r.get("toolUseResult")
                    if isinstance(tur, dict) and "interrupted" in tur:
                        m["interruptedKeyRows"] += 1
                        if tur.get("interrupted") is True:
                            m["interruptedTrue"] += 1

                    msg = r.get("message")
                    if not isinstance(msg, dict):
                        continue
                    if msg.get("model"):
                        models[msg["model"]] += 1
                    usage = msg.get("usage")
                    if isinstance(usage, dict):
                        for k in ("input_tokens", "output_tokens",
                                  "cache_read_input_tokens", "cache_creation_input_tokens"):
                            v = usage.get(k)
                            if isinstance(v, int):
                                tokens[k] += v
                    content = msg.get("content")
                    if isinstance(content, list):
                        for b in content:
                            if isinstance(b, dict) and b.get("type") == "tool_result":
                                m["toolResultTotal"] += 1
                                if "is_error" in b:
                                    m["toolResultWithIsErrorKey"] += 1
                                    if b.get("is_error") is True:
                                        m["toolResultIsErrorTrue"] += 1
        except Exception as e:
            print("  !! read error: %s (%s)" % (fp, e), file=sys.stderr)

    m["tokens"] = dict(tokens)
    m["tokensTotal"] = sum(tokens.values())
    m["attributionSkillDistinct"] = len(skills)
    m["skillsTop"] = skills.most_common(10)
    m["models"] = dict(models)
    m["claudeCodeVersions"] = dict(versions)
    m["toolDenialKind"] = dict(denials)
    return m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scope", choices=["main", "sub", "all"], default="all")
    ap.add_argument("--json", action="store_true", help="提出ペイロード形式で出力")
    args = ap.parse_args()

    files = collect_files(args.scope)
    metrics = scan(files)

    roots = []
    if args.scope in ("main", "all"):
        roots += ROOTS["main"]
    if args.scope in ("sub", "all"):
        roots += ROOTS["sub"]

    skills_defined = [
        d for d in glob.glob(SKILLS_GLOB)
        if not os.path.basename(os.path.dirname(d)).startswith("_")
    ]
    metrics["skillsDefined"] = len(skills_defined)

    payload = {
        "scanManifest": {
            "parserVersion": "1",
            "scope": args.scope,
            "rootsWalked": roots,
            "recursive": True,
            "filesScanned": metrics["filesScanned"],
            "linesScanned": metrics["linesScanned"],
            "claudeCodeVersions": metrics["claudeCodeVersions"],
        },
        "metrics": {k: v for k, v in metrics.items() if k != "skillsTop"},
    }

    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    m = metrics
    print("=" * 62)
    print("走査範囲: %s  |  files=%d  lines=%d  size=%.1fMB"
          % (args.scope, m["filesScanned"], m["linesScanned"], m["bytesScanned"] / 1024 / 1024))
    print("  rootsWalked: %s" % ", ".join(roots))
    print("-" * 62)
    print("■ is_error（🚨 分母を明示すること）")
    print("    tool_result 総数          = {:,}".format(m["toolResultTotal"]))
    print("    is_error キー保持          = {:,}".format(m["toolResultWithIsErrorKey"]))
    print("    is_error = true           = {:,}".format(m["toolResultIsErrorTrue"]))
    if m["toolResultTotal"]:
        print("    率[分母=tool_result総数]  = %.2f%%"
              % (m["toolResultIsErrorTrue"] * 100.0 / m["toolResultTotal"]))
    if m["toolResultWithIsErrorKey"]:
        print("    率[分母=キー保持数]        = %.2f%%"
              % (m["toolResultIsErrorTrue"] * 100.0 / m["toolResultWithIsErrorKey"]))
    print("■ トークン  総計 = {:,}".format(m["tokensTotal"]))
    for k, v in sorted(m["tokens"].items(), key=lambda x: -x[1]):
        pct = (v * 100.0 / m["tokensTotal"]) if m["tokensTotal"] else 0
        print("    %-30s %18s (%.3f%%)" % (k, "{:,}".format(v), pct))
    print("■ スキル（🚨 行数と種類数は別物）")
    print("    attributionSkill 行数     = {:,}".format(m["attributionSkillRows"]))
    print("    distinct なスキル名        = %d" % m["attributionSkillDistinct"])
    print("    定義スキル本数             = %d" % m["skillsDefined"])
    if m["skillsDefined"]:
        print("    発火率                    = %d/%d = %.1f%%"
              % (m["attributionSkillDistinct"], m["skillsDefined"],
                 m["attributionSkillDistinct"] * 100.0 / m["skillsDefined"]))
    for name, cnt in m["skillsTop"][:5]:
        print("      - %-28s %s" % (name, "{:,}".format(cnt)))
    print("■ その他")
    print("    isSidechain true/false    = {:,} / {:,}".format(m["isSidechainTrue"], m["isSidechainFalse"]))
    print("    interrupted true/キー保持  = {:,} / {:,}".format(m["interruptedTrue"], m["interruptedKeyRows"]))
    print("    toolDenialKind            = %s" % (m["toolDenialKind"] or "なし"))
    print("    モデル分布                 = %s" % m["models"])
    print("=" * 62)
    print("🚨 この数値を外に出すときは scanManifest（走査範囲・分母定義）を必ず併記する")
    return 0


if __name__ == "__main__":
    sys.exit(main())
