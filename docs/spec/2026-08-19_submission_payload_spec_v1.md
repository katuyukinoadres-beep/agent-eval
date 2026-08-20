# 提出ペイロード仕様 v1（実装仕様・Leon 引き渡し用）

作成: 2026-08-19 / 起点: 設計書 v2（`2026-08-19_agent_eval_axes_v2.md`）
対象: 採点エンジン CLI が出力し、母集団 API が受け取る JSON の完全な形

---

## 0. この仕様が存在する理由

2026-08-18〜19 の2環境（Niko / Leon）での実測で、**同じデータから同じ指標を計算しているのに、定義の違いだけで値が動いた事故が4件**起きた。

| # | 何の定義 | 振れ幅 | 見つけた側 | 気づくまで |
|---|---|---|---|---|
| 1 | 走査範囲（`subagents/` を含むか） | 1.46倍 | Niko | 3日 |
| 2 | is_error の分母（tool_result 総数 か is_error キー保持数か） | 1.96倍 | Niko | 即日 |
| 3 | human 発話の定義（`origin.kind` かヒューリスティックか） | 2.63倍 | Leon | 2日 |
| 4 | 記録率の分母（暦日数か観測日の和集合か） | **6.9倍** | Leon | 1日 |

4件に共通するのは「**データは両方とも正しく取れているのに、比較だけが壊れる**」形。そして**深く潜った定義ほど振れ幅が大きく、気づきにくい**。

さらに悪いことに、4件のうち**2件は「定義を明示せよ」というルールを書いた本人が、その直後に破った**。つまり送る側の規律では止まらない。

**したがってこの仕様の中心は「受け取り側が機械的に拒否する条件」にある。** ペイロードの形を決めるのが目的ではなく、**定義が書かれていないデータを母集団に入れないこと**が目的。

---

## 1. 全体構造

```jsonc
{
  "schemaVersion": "1.0",           // 必須。バリデーションの分岐キー
  "runTimestamp": "2026-08-19T21:04:33+09:00",
  "submissionId": "<uuid v4>",      // 再送の冪等キー
  "scanManifest": { /* §2 */ },
  "metrics":      { /* §3 */ },
  "axes":         { /* §4 */ },
  "environment":  { /* §5 */ }
}
```

**送らないもの**（設計憲法・違反は受信拒否ではなくクライアント側で構造的に不可能にする）:
- 会話本文・コード・ファイル内容、およびそれらのハッシュ
- ファイルパスの実体（プロジェクト名は任意でハッシュ化可）
- メールアドレス・アカウント識別子

---

## 2. `scanManifest` — 必須

**この節の項目が1つでも欠けたら、ペイロード全体を拒否する。**（§6）

```jsonc
{
  "parserVersion": "1",              // 必須。パーサ実装のバージョン
  "scope": "all",                    // 必須。"main" | "sub" | "all"
  "rootsWalked": [                   // 必須。実際に走査したグロブを全部
    "~/.claude/projects/*/*.jsonl",
    "~/.claude/projects/*/*/subagents/**/*.jsonl"
  ],
  "recursive": true,                 // 必須
  "filesRead": 1502,                 // 必須
  "linesRead": 129873,               // 必須
  "linesParseFailed": 0,             // 必須（0 でも明示する）
  "bytesRead": 663311155,

  "mainFiles": 1094, "mainLines": 101196,
  "subFiles": 368,   "subLines": 27936,
  "subLineRatio": 0.267,             // 必須。事故#1 の再発検知に使う

  "toolVersions": {                  // 必須。行ごとの version を集計
    "2.1.234": 51914, "2.1.233": 5269, "2.1.112": 930
  },
  "toolVersionDistinct": 12,         // 必須。1環境に複数混在しうる

  "originFieldCoverage": {           // 必須。事故#3 の再発検知
    "numerator": 195,                // origin フィールドを持つ user 行
    "denominator": 5814,             // user 行の総数
    "meaning": "origin フィールドが付いている user 行の割合。低いほど human 判定が過小になる"
  },

  "window": {
    "unit": "activeDays",            // 必須。"activeDays" | "calendarDays"
    "windowDays": 10,
    "windowSource": "setting",       // "setting" | "observed"
    "cleanupPeriodDays": 14,         // null 可（キーが存在しない環境がある）
    "cleanupPeriodDaysFoundAt": "~/.claude/settings.json",  // null 可
    "calendarSpanDays": 22,
    "activeDays": 17,
    "activeDaysMethod": "human-turn-days",  // 必須。🚨 window 側は常にこれ
    "contiguousDays": 11,
    "gapDays": ["2026-07-31", "2026-08-01"]
  },

  "externalLog": {
    "exists": true,                  // 必須
    "rows": 42,
    "recordedDays": 15,
    "activeDays": 18,               // 必須。recordRate.denominator と一致（V-13）
    "activeDaysMethod": "union-of-observed(git, jsonl, externalLog)",  // 必須
    "recordRate": { "numerator": 15, "denominator": 18,
                    "meaning": "作業した証拠のある日のうち、外部ログに入っている割合" },
    "recordRateCalendar": { "numerator": 15, "denominator": 125,
                            "meaning": "暦日のうち記録がある日の割合（作業頻度を答える別指標）" }
  }
}
```

### 2.1 `activeDaysMethod` — 同じ名前の2つの量を取り違えない

🚨 `activeDays` は **2箇所に出るが別の量**。親オブジェクトを見ずに名前だけで読むと 5.9% ずれる。

| パス | 値（実測） | 意味 | `activeDaysMethod` |
|---|---|---|---|
| `window.activeDays` | 17 | 人間発話が1件以上ある日。**全軸の分母スコープ** | `"human-turn-days"` |
| `externalLog.activeDays` | 18 | 何らかの証拠がある日の和集合。**記録率の分母** | `"union-of-observed(...)"` |

`window.activeDays ≤ externalLog.activeDays` は構造的に成立する（人間発話があった日は、その発話を読んだ jsonl が残っているので和集合に必ず含まれる）。逆転したら取り違えなので、妥当性ではなく**入れ替えの検出器**として使う。

以下は `externalLog.activeDays` 側の定義。


```
activeDays = |union(git のコミット日, jsonl の日付, 外部ログの日付)|
```

`max(git, jsonl)` は **分子を下回りうる**（実測で 107.1% を返した）。外部ログにしか存在しない日があるため——生ログが刈られた後も外部ログは残る。union なら分子が分母の部分集合になり、構造的に100%を超えない。

**限界を明記する**: これは真の稼働日の**下限**でしかない。コミットもログも残さず終わった日は原理的に見えない。将来定義を変えても層別できるよう、必ず `activeDaysMethod` を添える。

---

## 3. `metrics` — 生カウントのみ。率を送らない

**🚨 率（%）を送ってはならない。** 率を送った時点で分母の定義がペイロードに埋め込まれ、受け取り側で再計算できなくなる。事故#2 と #4 はどちらもこれが原因。

すべての指標は次の3つ組で表現する。

```jsonc
"metricName": {
  "numerator": 811,
  "denominator": 27476,
  "denominatorMeaning": "window 内の tool_result ブロック総数（is_error キーの有無を問わない）",
  "availability": "available"        // §4.2 の三値
}
```

### 3.1 必須指標の一覧

| キー | numerator | denominator | denominatorMeaning |
|---|---|---|---|
| `toolError` | `is_error == true` の tool_result 数 | tool_result 総数 | window 内の tool_result ブロック総数（キーの有無を問わない） |
| `toolErrorAlt` | 同上 | `is_error` キーを持つ tool_result 数 | 🚨 事故#2 の当事者。**両方送る**。どちらが正かは受け取り側が決める |
| `skillFired` | `attributionSkill` の **distinct 値の数** | 定義スキル数（`.claude/skills/*/SKILL.md`、先頭 `_` を除く） | 書いたスキルのうち実際に発火した種類数。🚨 **行数ではない** |
| `skillRows` | `attributionSkill` を持つ行数 | — | 参考値。`skillFired` と取り違えると桁でずれる（Leon 231行→3種） |
| `mcpUsed` | `attributionMcpServer` の distinct 値の数 | 接続 MCP サーバー数 | 繋いだサーバーのうち実際に呼ばれた数 |
| `humanTurns` | `origin.kind == "human"` の行数 | — | 🚨 `originFieldCoverage` を必ず併読すること |
| `denialUserRejected` | `toolDenialKind == "user-rejected"` | `toolDenialKind` を持つ行の総数 | 権限拒否のうち人間が止めた割合 |
| `permissions` | — | — | `{allow, deny, ask}` の3つ組 + 分類内訳（§3.2） |
| `editPaths` | 2回以上編集されたファイル数 | 編集対象ファイルの distinct 数 | 🚨 手戻りではなくファイル集中度。打ち消し判定は別途 |
| `tokens` | — | — | `{input, output, cacheRead, cacheCreation}` の4つを生値で |
| `hookPushback` | `hookErrors` が非空の `stop_hook_summary` 行数 | `stop_hook_summary` の総数 | ガードレールが実際に応答を差し戻した割合。🚨 `preventedContinuation` は使わない（2環境とも全 false） |

### 3.2 `permissions` は件数だけでは危険度が逆転する

実測: Niko allow 263件 / deny 0件、Leon allow 51件 / deny 3件。**件数は5倍差だが、実質的な権限の広さは逆転している**（Niko には `Bash(python:*)` = 任意コード実行相当があり、Leon には0件）。

```jsonc
"permissions": {
  "allow": 263, "deny": 0, "ask": 0,
  "breakdown": {
    "unrestrictedExec": 4,      // Bash(python:*) / Bash(*) / Bash(sh:*) 相当
    "cliWildcard": 14,          // Bash(git push*) 等、CLI 単位の前置ワイルドカード
    "scriptPathFixed": 24,      // node scripts/foo.mjs:* 等
    "other": 221
  },
  "sourceFiles": 4              // マージ元の settings ファイル数
}
```

`ask` は2環境とも0件。列としては持つが、**採点に使うなら分布を見てから**。

---

## 4. `axes` — 軸ごとのスコアと三値

```jsonc
"axes": {
  "firstPassLanding": {
    "availability": "available",
    "numerator": 0, "denominator": 0,
    "denominatorMeaning": "...",
    "score": 72.4,
    "confidenceInterval": [68.1, 76.9],
    "belowMinDenominator": false
  }
}
```

### 4.1 軸の一覧（設計書 v2 §2 が正本）

第1弾（採点6軸）: `firstPassLanding` / `wastedMotion` / `selfVerification` / `artifactUptake` / `environmentMetabolism` / `recurrencePrevention`
第2弾（人間側3軸・`attribution: human`）: `pendingDecisions` / `userRejected` / `askUserQuestionCustomRate`
非採点: `coverageGate`（軸0）/ `safetyCheck`

### 4.2 三値 `availability` は**行ごとに判定**して集計する

| 値 | 意味 |
|---|---|
| `available` | 必要フィールドが揃い、分母が最小値以上 |
| `not_applicable` | フィールドがこの環境・このバージョンに存在しない（例: 外部 hook ログがない環境の**軸6層B′**。層B本体は jsonl だけで取れるので該当しない） |
| `parse_failed` | フィールドはあるはずだが読めなかった（バグの疑い） |

**🚨 「環境ごと」ではなく「行ごと」に判定する。** 1環境のログに **12バージョンが混在**する実測があり（2.1.112 〜 2.1.234）、`origin` フィールドは 2.1.220 以降にしか付かない。環境単位で判定すると、古い行の欠落を新しい行が覆い隠す。

集計時は `{available: N, not_applicable: M, parse_failed: K}` の内訳をそのまま送る。

### 4.3 `parse_failed` が閾値を超えたら総合点を出さない

`parse_failed / (available + not_applicable + parse_failed) > 0.05` の軸は `availability: "parse_failed"` として扱い、**総合スコアの計算から外したうえで、外したことを画面に明示する**。

理由: パーサが静かに0を返す事故が実際に起きた（Leon の非再帰 glob。**Leon 自身が「パーサが静かに0を返す」と警告した直後に、自分がそれをやった**）。ユーザーからは「スコアが低い」のか「読めていない」のか区別がつかない。

---

## 5. `environment`

```jsonc
{
  "os": "Windows 11",
  "shell": "PowerShell + Git Bash",
  "agentTools": ["claude-code"],
  "projectCount": 3,
  "projects": [                      // 🚨 全件入れる。部分提出を受け付けない（§6.3）
    {"nameHash": "sha256:...", "files": 1081, "lines": 0,
     "bytes": 855638016, "humanRows": 0, "subLineRatio": 0.27}
  ],
  "topProjectByteShare": 0.996,
  "skillsDefined": 81,
  "hooksDefined": 61
}
```

### 5.1 提出単位はマシン全体（#6 確定事項）

**プロジェクト別の内訳を全件入れる。閾値は設けない。**

n=2 の実測で **両環境とも単一プロジェクト支配**だった（Leon 100% / Niko 99.6%）。この2件から加重平均の閾値 M を決めると、分布が違う環境で破綻する式を「実測で決めた」と称することになる。しかも n=2 で仮置きした閾値は、後から変えても既提出分を再計算できない——事故#1〜4 と同じ形。

「きれいなプロジェクトだけ提出する」は、**部分提出を受け付けないこと**で防ぐ（閾値判定が不要になる）。受け取り側は内訳を持つので、後からどんな集計単位でも再計算できる。

**副次的な事実**: Leon 環境は `usage_log.csv` に5アプリの行があるのに、生ログを持つプロジェクトは1つだけ。つまり「**今見えているプロジェクト分布は実態ではなく、直近の作業履歴の影**」。保持期限がプロジェクト別比較を壊すこと自体が、提出単位をマシン全体に置く根拠になる。

---

## 6. バリデーション規則（受け取り側で機械強制）

**この節がこの仕様の中心。** 送る側の規律では止まらないことが4回証明されているので、受け取り側で拒否する。

### 6.1 拒否条件（HTTP 422 を返し、母集団に入れない）

| # | 条件 | 理由 |
|---|---|---|
| V-1 | `scanManifest` が存在しない | 定義不明のデータを母集団に入れない |
| V-2 | `scanManifest` の必須項目（§2 で「必須」と記した全項目）に欠落がある | 同上 |
| V-3 | `metrics` の任意の指標に `denominatorMeaning` が無い | 事故#2・#4 の直接の再発防止 |
| V-4 | `metrics` に率（`0〜1` の小数 or `%` 文字列）だけがあり `numerator`/`denominator` が無い | 再計算不能なデータを受けない |
| V-5 | `recordRate.numerator > recordRate.denominator` | 事故#4 の 107% を機械で弾く |
| V-6 | `environment.projects` の件数 ≠ `environment.projectCount` | 部分提出の検知 |
| V-7 | `axes` の `availability` が三値以外 | — |
| V-8 | 本文・コード・ハッシュらしき長大文字列を含む | プライバシー設計憲法 |

### 6.2 警告条件（受理するが `flags` を付けて母集団統計から除外可能にする）

| # | 条件 | 意味 |
|---|---|---|
| W-1 | `originFieldCoverage` の比が 0.1 未満 | human 系指標が過小。Leon 実測 3.4% |
| W-2 | `subLineRatio` が 0（`scope: "all"` なのに sub が0行） | 非再帰 glob の疑い。事故#1 の再発 |
| W-3 | `toolVersionDistinct` > 5 | バージョン混在が大きく、行ごと判定が効いているか要確認 |
| W-4 | `recordRate` の比が閾値未満 | データが疎。トレンドを描く前に画面へ明示 |
| W-5 | `linesParseFailed / linesRead` > 0.01 | パーサの疑い |
| W-6 | ブール由来の指標で `numerator == 0` かつ `denominator > 100` | **本当にゼロなのか、フィールドが死んでいるのかを区別できない**。V で拒否すると正当なゼロを弾くので警告に留める（閾値100は仮置き・実装しながら調整可） |

### 6.3 部分提出を受け付けない

`environment.projects` は**マシン上のログを持つ全プロジェクト**を含まなければならない。V-6 で件数の一致を検査する。

---

## 7. 実装者への注意（今日の4件の失敗から）

1. **走査は必ず再帰で**。`glob('*.jsonl')` は `subagents/` 配下を拾わない。実測で全行の 26.7〜31.2% がサブツリーにある
2. **`isSidechain` をサブエージェント判定に使わない**。メイン jsonl では常に false。**パス（`subagents/` を含むか）で判定する**
3. **`toolUseResult.interrupted` を使わない**。2環境で計 9,995 件のキー出現に対し true が **0件**。死んだフィールド
4. **`preventedContinuation` を使わない**。同じく2環境とも全件 false。🚨 **ただし実データは `hookErrors` にある**（Leon 実測: `stop_hook_summary` 278件中、`preventedContinuation` は全件 false なのに `hookErrors` 非空が9件。中身は差し戻し文そのもので、9件全部が「質問は一つずつ」ルール違反だった）。**軸6層B の分子は `hookErrors` 非空件数 / 分母は `stop_hook_summary` 総数**。両方 jsonl にあるので全環境で比率が出せる。外部ログでの warned/triggered 分解は層B′（任意）に回す
5. **`history.jsonl` を定常データ源にしない**。2環境とも 2026-04-17 で書き込みが止まっている
6. **`pr-link` を汎用軸に使わない**。ドメイン依存（Leon 284件 / Niko 0件）
7. **セッション継続時間を `max(timestamp) - min(timestamp)` で出さない**。resume で同一 sessionId が日を跨ぐため 39日のセッションが出る。アイドル上限（15〜30分）を設けた `active_minutes` 方式にする
8. **率を計算する前に分母の定義を書く**。書けないなら、その指標はまだ実装しない
9. 🚨 **ブール値が 0 / 全 false を返したら、同じ事象が別フィールドに入っていないか探す。フィールド名は意味を約束しない**

   実例が3件揃ったのでパターンとして扱う。

   | 死んでいたブール | 実データのありか |
   |---|---|
   | `isSidechain`（メイン jsonl で全 false） | パス（`subagents/` 配下かどうか） |
   | `toolUseResult.interrupted`（2環境 9,995件 全 false） | 本文の文字列パターン（Leon 実測で6件のみ） |
   | `preventedContinuation`（2環境 全 false） | **`hookErrors` 非空**（Leon 9件） |

### 参照実装

`scripts/measure_agent_env.py`（Niko 側）が §2〜§3 の一部を実装済み。`--json` で scanManifest 付きのペイロードを返す。ただし**プロジェクト別内訳（§5）は未実装**なので、そこは新規に書く必要がある。

---

## 8. 未確定（第1弾の実装は止めない）

| # | 事項 | 影響 | いつ決まるか |
|---|---|---|---|
| 8.1 | 軸3 の TodoWrite 減点項の有無 | 減点項だけ。ゼロなら全廃 | Leon 環境の実測 |
| 8.2 | 軸6層B′（外部ログでの warned/triggered 分解）が動く環境の割合 | 層B本体は jsonl で全環境から取れるため、層B′ が無くても中心軸は動く | 同上 |
| 8.3 | 規模 Tier の刻み（`scaleTier`） | 第2弾（母集団比較）の着手条件 | 母集団が育ってから |
| 8.4 | `recordRate` の疎/密の閾値 | 表示の分岐のみ。当面は閾値判定せず率をそのまま出す | 同上 |

いずれも**第1弾の実装を止めない**。`scaleTier` は `null` で提出してよい。
