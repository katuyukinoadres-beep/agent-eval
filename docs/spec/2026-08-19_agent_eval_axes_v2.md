# AIエージェント性能評価ダッシュボード 測定軸 設計書 v2

作成日: 2026-08-19
前版: `2026-08-18_agent_eval_axes_v1.md`（残す。v2 は差分として読む）
対象: 個人が使っている AI エージェント環境を採点し、自己時系列の変化とエージェント側の直し方を返す製品の測定軸

v1 との関係
- v1 は Niko 単一環境の実測だけで書いた。その後、別PC の兄弟エージェント Leon と実測を交換し、v1 の共通土台（P1・P4・P8）と3軸（軸1・軸7・軸8）が同時に壊れていることが確定した。
- v2 は v1 を置き換える。ただし v1 の §15（落とした軸と理由）と §16（未解決リスク16件）は生きている。v2 で解けたのは #1 / #9 / #10 / #12 の4件と、#6 の依存箇所の特定。
- この文書の数字は、断りのない限りすべて Niko 環境または Leon 環境の実測値である。推定値には「推定」と書く。

前提となる確定方針（Leon と合意済み・変更しない）
1. 時系列を第1弾、母集団比較は第2弾（v1 §14 の段階設計と順序が入れ替わった）
2. 各軸に `available / not_applicable / parse_failed` の三値を持たせ、粒度は環境ごとではなく行ごと
3. セッション終了時に指標だけ外部ファイルへ追記（生ログは刈られるので後付けできない）
4. D-6「書いたルール vs 守られたルール」を中心軸に置く
5. 各軸に `attribution: human | agent | joint` を持たせ、人間側の画面には `human` の軸しか出さない
6. 人間側は第1弾に入れない
7. 提出ペイロードに scanManifest 必須。率ではなく生カウントを送る
8. トークン量・支出額では競わせない。ローカル解析で完結し、外部へ送るのはスコアと分類ラベルのみ（opt-in）
9. 赤の他人の環境でも同じ式で測れること

---

## 1. v1 からの変更サマリ

ここだけ読めば差分がわかる。全30件。

### 1.1 共通土台の変更（全軸に効く）

| ID | v1 | v2 | 変更の根拠（実測） |
|---|---|---|---|
| C-01 | P1 の人間発話切り出しに `isSidechain != true` を条件として置いた | 条件を捨て、「そのレコードのファイルパスが `projects/*/*/subagents/**` に属さないこと」に置換 | `isSidechain` はメイン jsonl では常に false（Niko main 76,467行 全 false）、subagents 配下では常に true（27,872行）。main では恒真で無意味、sub では人間発話が全消しになる。Leon の「全行 false」は非再帰 glob のバグと本人が認めた |
| C-02 | サブエージェント配下は「実測45個」で、join したかは軸0の任意項目 | `subagents/` サブツリーの走査を全軸で必須にし、`rootsWalked` と「サブ配下の行数比」を軸0の必須項目に昇格 | 実測はディレクトリ9・jsonl 368〜408本で、行数では全104,577行中 27,965行＝26.7%。v1 の「45個」から桁が変わっている。main のみ走査すると軸1の深度が最大3割落ちる |
| C-03 | `cleanupPeriodDays` を `~/.claude.json` から読む前提 | enterprise / user / project / local の4スコープを merge した `settings*.json` を含めて探し、無ければ jsonl の最古 timestamp を使う2段構え。出所（setting / observed）を scanManifest に必ず載せる | Niko 環境でも `~/.claude.json` は None を返し、実体は `~/.claude/settings.json` の 14 だった。Leon 環境にはキー自体が存在せず、それでも最古ログは42日前 |
| C-04 | 窓は暦日（実効窓日数14日） | 窓は稼働日で切る。「人間発話が1件以上ある日」を稼働日と数え、直近10稼働日を1窓とする | 日次行数に 07-31〜08-02（3日）と 08-08（1日）の完全な穴がある。最古 2026-07-28／最新 2026-08-19 で暦日スパン22日だが、連続稼働は 08-09〜08-19 の11日しかなく、設定値14とも一致しない |
| C-05 | 各軸のスコアと率（W、I、V、R など）が第一級の出力 | 率を第一級の出力から降格し、分子と分母を生カウントで提出する。率は画面表示のみ | is_error 率は走査範囲で1.26倍（main 2.70% ↔ sub 3.40%）、分母定義で2.08倍（tool_result 総数 27,775 を分母に 2.94% ↔ is_error キー保持 13,374 を分母に 6.10%）動く。率だけ送ると他環境と比較できない |
| C-06 | scanManifest という概念が無い | 全軸の提出ペイロードに scanManifest を必須化（§4に完全構造） | 上と同じ。加えて Leon と Niko で jsonl 1,494本/625MB 対 156本/64.1MB の約10倍差があり、層別なしの percentile は情報を持たない |
| C-07 | 欠測は軸ごとに持ち、環境単位で欠測ラベルを付けた | `available / not_applicable / parse_failed` の三値を行ごとに持つ | 1環境に12バージョンが混在する。実例として `origin` キーは 2.1.220 以降にしか無く、2.1.112 の930行では全滅している。環境単位の三値ではこれを表現できない |
| C-08 | イベント帰属表（P8）は草案6行 | E1〜E14 の14エントリと判定順序を確定（§5） | `toolDenialKind` を持つ tool_use_id 55件の100%が同時に `is_error == true` にも現れる。帰属ルールが無ければ確実に二重計上され、軸2の値が1.49倍動く（816/27,762 = 2.94% → 548/27,762 = 1.97%） |
| C-09 | 最小分母は書いたが、信頼区間の算出方法とΔの有意判定は未定（未解決リスク #9） | セッション単位クラスタ・ブートストラップ（B=4,000・パーセンタイル法）に固定。最小分母は「クラスタ数20以上 かつ 分母200以上 かつ 分子5以上」の3条件AND。Δは CI が0を跨がず、かつ MDE_floor を超えたときのみ「改善／悪化」と表示（§6） | デザイン効果（クラスタ bootstrap 幅 ÷ Wilson 幅）が7指標で 1.11〜2.69 とばらついた。固定係数では吸収できず Wilson は使えない。interrupt/human は窓の切り方で符号が反転する（7日 vs 7日で Δ=+0.834pt CI[+0.091,+1.636]、10日 vs 11日で Δ=-0.083pt CI[-1.253,+0.828]） |
| C-10 | 計算量の予算は未定（未解決リスク #10）。「必要フィールドのみで10.9秒」 | cold 90秒 / warm 20秒を上限に固定。jsonl は1回しか読まない。O(n²) は軸6のみで、既定は O(n) 正規化署名（§7） | `measure_agent_env.py --scope all` の実測は cold 69.9秒 / warm 16.3秒で4.3倍差。cold/warm を区別しない v1 の前提は成立しない。difflib 全対比較は143µs/対で、実測816件なら47.6秒（cold 予算の半分超） |

### 1.2 軸ごとの再判定（keep 1 / redefine 6 / drop 1）

| ID | 軸 | 判定 | 何が変わったか（実測） |
|---|---|---|---|
| C-11 | 軸0 測定カバレッジ | redefine | 実効窓日数の読み場所（C-03）と、subagents サブツリー走査の必須化（C-02）。I4（file-history 実バイト照合）はセッションの13%にしか実体が無いので v1 のまま維持 |
| C-12 | 軸1 一発着地率 | redefine | データ源の `[Request interrupted by user]` は main 1,502ファイル中28件しかなく、誘発判定の材料にならないので内訳表示へ降格。`toolUseResult.interrupted` への乗り換えも不可（キー保持 8,727件・true 0件、Leon も 1,268件中0件）。depth は scope=all で集計 |
| C-13 | 軸2 空振り率 | redefine | 分子を帰属表適用後の 548 に確定（816 から 1.49倍下がる。内訳は A_agent_code 345 + D_dependency 59 + T_timeout 44 + Z_other 100）。W_ref による絶対値比較は母集団が層別で揃うまで凍結 |
| C-14 | 軸3 自己検証率 | redefine | 条件(ii) の「過去窓」を `windowDays` / `windowSource` で明示（Niko 設定14日・実測15日連続、Leon 設定なし・実測42日）。編集区間の集計を scope=all にし、検証がサブエージェント側で起きた分を内訳で分離 |
| C-15 | 軸4 成果の定着 | keep | v1 全文を grep して pr-link / pr_link は0ヒット、§15 で PR 帰属は既に rejected 済み。Leon 284件 / Niko 0件 という pr-link のドメイン依存を最初から回避している。定義本体は据え置き、scope 必須化と attribution の付け替えのみ |
| C-16 | 軸5 環境の代謝 | redefine | U の分子が「行数」か「distinct 種類数」かで桁が変わる（Niko 行数 12,432 / distinct 43 / 定義81 = 53.1%、Leon 行数231 / distinct 3 / 定義27 = 11.1%）。FC の主式が cache_read 依存で、実測 cache_read は総トークンの94.7%（13.03B / 13.76B）。v1 §15 が rejected した「キャッシュ効率」に化けていた |
| C-17 | 軸6 再発防止率 | redefine | 合意4の D-6 を層Bとして新設。分子は jsonl から取れない（`preventedContinuation` は Niko 1,911件・Leon 240件がいずれも全 false）ので外部 hook ログへ移す。層A（窓跨ぎ署名再出現）は v1 のまま |
| C-18 | 軸7 依頼の設計度 | redefine + 第2弾送り | `C_obey`（制約が守られた割合）はエージェントの行動なのに human スコアの乗数になっており、「エージェントが指示を破るほど人間の設計度が下がる」符号反転を起こす。軸6 層Bへ移管。加えて Niko は UserPromptSubmit hook を5本実運用しており、v1 自身の規定に従うと human 帰属が既定で成立しない |
| C-19 | 軸8 手離れ度 | drop | 分子3本のうち2本が桁不足（生成中断28件・user-rejected 11件）。think-time は v1 自身が旧「監督バランス」を解体した理由をそのまま抱えている。最大の問題は帰属誤りで、人間発話数が増える主因はエージェントの非着地（軸1）であり、同じ現象を軸1(agent)と軸8(human)で二重に測って片方を人間の責に帰していた |
| C-20 | 安全チェック（非採点） | redefine | permissions を `(allow, deny, ask)` の3つ組で見る。Niko allow 263・deny 0（allow に `Bash(python:*)` という実質任意コード実行を含む）、Leon allow 51・deny 3・実質全許可0。allow の件数は委譲範囲を測らない（263 > 51 だが Niko のほうが粗い）。軸5 の静的欠陥 D をここへ移管 |

### 1.3 データ源の生死判定（v1 が使うと書いていたもの）

| ID | フィールド | 判定 | 実測 |
|---|---|---|---|
| C-21 | `isSidechain` | 使用禁止 | main 全 false / sub 全 true。両環境で同じ（C-01） |
| C-22 | `toolUseResult.interrupted` | 使用禁止（死指標） | Niko キー保持 8,727件・true 0件。Leon 1,268件中 true 0件。2環境で確定 |
| C-23 | `preventedContinuation` | 主源にも補助源にもしない | Niko 1,911件（main 1,730件）・Leon 240件、いずれも true ゼロ |
| C-24 | `history.jsonl` | 指標源から明示排除 | 両環境とも 2026-04-17 で書き込みが止まっている。Niko 3,516行 / Leon 56行と規模が63倍違うのに終端が同じ日。過去の検証素材としてのみ残す |
| C-25 | `pr-link` | 共通軸に置かない | Leon 284件 / Niko 0件（業務オペレーション用途では PR が発生しない）。アウトカム軸を汎用の共通軸に置けない根拠 |
| C-26 | `attributionSkill` | 使うが、行数と種類数を別フィールドで持つ | 取り違えると桁でずれる（C-16） |
| C-27 | 外部 hook ログ（`logs/hook_events.jsonl`） | 「あればそこ、無ければ not_applicable」 | 今回の実測は 185,902行・decision別 warned 2,926 / triggered 1,872。ブリーフィング記載の 563,613行（warned 2,819 / triggered 1,827）と行数が3倍食い違う。ローテーションと集計定義で値が動くので、パス・行数・decision 語彙を scanManifest に載せないと使えない |

### 1.4 製品としての順序

| ID | v1 | v2 | 根拠 |
|---|---|---|---|
| C-28 | §14 で段階1 Tier制 → 段階2 到達率（n50以上）→ 段階3 percentile（n300以上）と、母集団比較への昇格を主線に置いた | 時系列（自己の窓間Δ）を第1弾、母集団比較を第2弾に反転 | Leon と合意済み。加えて規模差が約10倍（jsonl 1,502本/632.6MB 対 156本/64.1MB、skills 81 対 27、hooks 61 対 7）で、層別なしの percentile は情報を持たない |
| C-29 | 人間側2軸（軸7・軸8）を重み12+8で総合点に組み込んだ | 人間側は第1弾に入れない。第1弾の総合点は軸1〜6のみ | 合意6。加えて軸8は drop、軸7は attribution 修正が要る |
| C-30 | 未解決リスク #1（hook がブロックした実績の記録形式）は未確定 | 確定。hook のブロックには専用の型が無く、`toolDenialKind == "permission-rule"` + `is_error == true` + 本文 `PreToolUse:<Tool> hook error: [...]` の3点セットで記録される | permission-rule 45件を本文と全件突き合わせた実測。hook が止めた31件・permissions 設定が止めた13件・基盤エラー（`Tool permission stream closed`）1件に機械的に3分できる |

### 1.5 走査実行ごとに数字が動くことの記録

同じ Niko 環境でも、走査した日と scope の違いで次のように動いた。scanManifest に `runTimestamp` を必須にする直接の根拠になる。

| 量 | 値A | 値B | 値C |
|---|---|---|---|
| jsonl 本数（all） | 1,494本 | 1,502本 | — |
| 全行数 | 104,577行 | 129,873行 | — |
| sub 配下の jsonl 本数 | 368本 | 408本 | — |
| sub 配下の行数 | 27,872行 | 27,936行 | 27,965行 |
| `PreToolUse:*` hook error | 29件 | 32件 | — |
| `[Request interrupted by user]` | 20件（v1 記載） | 28件（main 走査） | 21件（帰属表 E10） |

この幅は測定のバグではなく、窓が動いている（ログが増え、古い分が刈られる）ことの現れである。v1 が単一の数字を本文に書いていたのは誤りで、v2 では数字を書くときに必ず「いつ・どの scope で測ったか」を添える。

---

## 2. 確定した軸の一覧

### 2.1 第1弾（採点する6軸・すべて自己時系列）

重みは v1 の 15/14/14/14/10/13 を、軸7（12）と軸8（8）を外した残り80点で再正規化した。

| # | 軸名 | attribution | 弾 | 重み | 主データ源 | 走査範囲 | 三値の判定条件 |
|---|---|---|---|---|---|---|---|
| 1 | 一発着地率 | agent | 第1弾 | 18.75 | `tool_use.input.file_path`（Edit/Write/NotebookEdit）、`toolUseResult.structuredPatch`、人間発話の位置 | all（main + subagents） | 実測クラスタ131・分子135・分母1,498 で available。SA が0件なら not_applicable。`structuredPatch` のパース失敗が5%超で parse_failed |
| 2 | 空振り率 | agent | 第1弾 | 17.5 | `tool_result{is_error, content}` を `tool_use_id` で join | all | 実測クラスタ146・分子446・分母16,871 で available。フィルタ後の tool_use が50未満で not_applicable |
| 3 | 自己検証率 | agent | 第1弾 | 17.5 | tool_use の並び、`is_error`、書込系 file_path、前窓スナップショット | all（検証がサブ側で起きた分は内訳分離） | 編集区間25未満で not_applicable。条件(ii) は初回窓 not_applicable |
| 4 | 成果の定着 | joint | 第1弾 | 17.5 | SA（P6）、後続 tool_use の input、人間発話、`attachment.type == "edited_text_file"`（実測199件）、`staleRecovered`（実測98件） | all | SA 0件 または タスク束10未満で not_applicable。次窓生存は初回 not_applicable。(c) は最小分母を割ったら (c) 抜きで再正規化 |
| 5 | 環境の代謝 | agent | 第1弾 | 12.5 | `message.usage.*`、`skill_listing` attachment、`attributionSkill`（行数と distinct を別持ち）、hook 発火記録 | all | 資産数3未満で U は not_applicable（台形スコアのみ）。`skill_listing` が20,001字で截断されていたら上限側 parse_failed |
| 6 | 再発防止率（層A + D-6 層B） | joint | 第1弾 | 16.25 | 層A: 軸2のエラー署名 + 軸1の誘発再編集パス + 人間指摘クラスタ。層B: 外部 hook ログの `decision` | all（層A）／外部ログ（層B） | 層Aは初回窓 r_in で available、r_cross は2窓目から。層Bは外部ログがあれば available、無ければ not_applicable。分母だけ available で分子 not_applicable の状態を画面に出す |
|  | 合計 | | | 100.0 | | | |

### 2.2 採点しないが必ず出す2つ

| 名前 | attribution | 弾 | 何をするか |
|---|---|---|---|
| 軸0 測定カバレッジと観測整合性ゲート | agent | 第1弾 | 何稼働日ぶんを読めたか / 何行パースできなかったか / サブ配下の行数比 / 除外イベントの実名内訳。ゲートを割ったら総合点そのものを出さない |
| 安全チェック | agent | 第1弾 | permissions の3つ組、実質全許可の実名リスト、参照先が存在しない hook 登録、`hook_cancelled` によるサイレント無効化、軸5から移管した静的欠陥。順位は付けない |

### 2.3 第2弾（人間側・3軸）

| # | 軸名 | attribution | 弾 | データ源 | 三値の判定条件 | 粒度 |
|---|---|---|---|---|---|---|
| H1 | 未決の滞留 | human | 第2弾 | 主: AskUserQuestion 未応答（実測 117 − 100 = 17件）／補助: `pending_actions.md`（Niko 固有・rare） | 主データ源は universal で available。補助は rare で他環境 not_applicable | 月次 |
| H2 | user-rejected 件数 | human | 第2弾 | `toolDenialKind == "user-rejected"`（実測11件） | クラスタ10・分子11 で §6 の最小分母を割るため not_applicable。件数のみ表示し採点しない | 月次 |
| H3 | AskUserQuestion の選択肢外回答 | human | 第2弾 | `toolUseResult.{questions, answers}` | asked が floor 未満なら率をレンダリングせず counts のみ available | 月次 |

### 2.4 落とした軸

| 軸 | 扱い |
|---|---|
| 軸8 手離れ度 | drop。〈前進発話 / やり直し発話 / 生成中断〉の3分割だけを軸1の内訳表示に agent 帰属で吸収（§10） |

---

## 3. 各軸の詳細

### 3.0 軸0 測定カバレッジと観測整合性ゲート（非採点 / agent / 第1弾）

問い
そもそも何をどれだけ読めたのか。読んだログは書き換えられていないか。測定の直前だけ環境が整えられていないか。

データ源と走査範囲
- jsonl は scope=all（`projects/*/*/*.jsonl` と `projects/*/*/subagents/**/*.jsonl` の両方）。`rootsWalked` に後者が含まれていないスキャンは、それだけで軸0を parse_failed にする
- `settings*.json` の4スコープ merge（enterprise managed / user / project / local）
- 各 jsonl の最古・最新 timestamp

算出（生カウント）
```
windowDays      = 10（稼働日）
windowSource    = "setting"  if cleanupPeriodDays が4スコープ merge で見つかった
                = "observed" otherwise
                実測: Niko = setting / 14（~/.claude/settings.json）
                      Leon = observed / 最古42日前（キー自体が無い）
calendarSpanDays = 最新 timestamp − 最古 timestamp   # 実測 22（2026-07-28〜2026-08-19）
activeDays       = 人間発話が1件以上ある日の数        # 実測 17
activeDaysMethod = "human-turn-days"                  # 🚨 window 側は必ずこの値。
                   externalLog.activeDaysMethod（union-of-observed）とは別の量で、
                   同一環境で 17 と 18 に分かれる。名前だけで読まず親オブジェクトごと読む
contiguousDays   = 連続稼働の最長                     # 実測 11（08-09〜08-19）
filesRead / bytesRead / linesRead / linesParseFailed
subLineRatio     = サブ配下の行数 / 全行数            # 実測 27,965 / 104,577 = 0.267
                   🚨 導出値は必ず同じ走査の成分から算出する。走査範囲の違う
                   分子・分母を並べると、成分と比が食い違ったサンプルになる
excludedEvents   = {N_network: 141, hookDenial: 44, ...}  # §5 の帰属表の除外分を実名で
```

三値の判定
- `linesParseFailed / linesRead > 0.05` → 環境まるごと parse_failed（総合点を出さない）
- `rootsWalked` に subagents が含まれない → parse_failed
- `activeDays < 5` → not_applicable（総合点を出さず内訳のみ）
- I6（hash chain）は初回窓では常に not_applicable

初回計測時の扱い
I6 は not_applicable。I4（file-history 実バイト照合）はセッションの13%にしか実体が残っていないので、残っている分だけを検査し、不在は減点しない（v1 のまま）。

ゲーム化耐性
測定直前の環境改変の検出（v1 出力C）はそのまま維持する。ただし C-04 により窓が稼働日ベースになったので、「窓の後半20%」の判定も稼働日で数える。

低スコア時のアドバイス例
「今回のスキャンは main の jsonl 1,094本しか読んでいません。この環境は subagents 配下に jsonl が368本、行数で全体の26.7%あります。ここを読まないと、サブエージェントに書かせた編集が軸1の深度に乗らず、実際より一発で着地しているように見えます。`rootsWalked` に `projects/*/*/subagents/**/*.jsonl` を足してから測り直してください。」

---

### 3.1 軸1 一発着地率（First-Pass Landing） / agent / 第1弾 / 重み 18.75

問い
1つの成果物に着地するまで、何回書き直したか。そのうち、人間の差し戻しが原因なのは何割か。

v1 からの変更点は3つ。(a) 人間発話の切り出しを `isSidechain` からパス判定へ置換（C-01）、(b) depth を scope=all で集計（C-02）、(c) 生成中断を分子・誘発判定から外して内訳表示に降格（C-12）。

データ源と走査範囲
- `tool_use.input.file_path`（Edit / Write / NotebookEdit）— scope=all
- `toolUseResult.structuredPatch[{oldLines, newLines, lines[]}]` と `toolUseResult.originalFile`
- 人間発話の位置。切り出しは C-01 の新定義（`subagents/` サブツリーに属さないファイル由来のレコードのうち、v1 P1 の除外条件を通したもの）
- SA の存在確認（`os.path.exists` のみ。本文は読まない）
- 使わないもの: `isSidechain`、`toolUseResult.interrupted`、file-history の `version`

算出（分子と分母を生カウントで持つ）
```
# 深度（率にしない）
editPaths        = 窓内に Edit/Write/NotebookEdit の対象になった distinct パス数   # 実測 1,498
editCalls        = 同じくその呼び出し総数
deepPaths        = depth(p) >= 2 のパス数                                        # 実測 135
depth_p90 / depth_median                                                          # 分布として持つ
depthBySocpe     = {main: ..., sub: ...}   # サブ委譲の量が読めるように必ず分ける

# 誘発型（否定語辞書を使わない・行動で判定）
inducedRewrites  = p への再書込のうち、直前に人間発話1件を挟んでいるものの回数
rewriteTotal     = Σ (depth(p) - 1)
# I = inducedRewrites / rewriteTotal は画面表示のみ。提出は分子分母のまま

# 修正の大きさ
patchAdded / patchDeleted / originalLines  を組で持つ
newFileCreations = structuredPatch が空配列のもの（実測 4,090件中 1,225件 = 30%）
                   → 「新規作成」として別カテゴリ。M の計算から外す

# 内訳表示のみ（採点しない・軸8から吸収）
forwardTurns / redoTurns / generationInterrupts   # generationInterrupts 実測 28（main 1,502ファイル）
```

スコア式は v1 の係数（p90 に -4、I に -30、M に -8、median に -2）をそのまま使う。ただし I が最小分母（§6）を割ったら項ごと落として重みを再配分する。

三値の判定
- `deepPaths >= 5` かつ `editPaths >= 200` かつ クラスタ（分母>0 のセッション）>= 20 → available（実測 135 / 1,498 / 131 で available）
- SA が0件（相談・調査のみの環境）→ not_applicable。「対話中心」ラベルを付け総合点の分母から外す
- `structuredPatch` のパース失敗が5%超 → parse_failed
- `generationInterrupts` は実測28件で最小分母を割るため、常に内訳表示のみ（採点しない）

初回計測時の扱い
初回から算出できる。2回目以降は depth_p90 と inducedRewrites/rewriteTotal の前窓差分を並記する。

ゲーム化耐性
| 攻撃 | 硬化策 |
|---|---|
| サブエージェントに書かせて main の深度を落とす | scope=all で集計し、`depthByScope` を必ず併記する。v1 には無かった穴で、サブ配下が全行の26.7%ある環境では最も安い攻撃だった |
| 書込ツールを通らない経路（`sed -i`、`cp`、ビルドスクリプト）で書く | v1 のまま。窓の開始と終了でファイルシステムを実測し、書込ツールに現れていないのに変化したファイルを直接数える |
| 毎回別名の新規ファイルで作り深度を1に保つ | v1 のまま。同一ディレクトリ・同一拡張子で連番/日付サフィックスの新規パスが窓内に3件以上出たら回避パターンとして検出 |
| 1回で完璧に書く | 防御不要。望ましい行動そのもの |

低スコア時のアドバイス例
例1（誘発比率が高い）
「深度の p90 が8回、うち41%があなたの差し戻しの直後に起きています。着手前に見出しと各節1行だけを出させて、その骨子にOKを出してから本文を書かせてください。最も書き直されたのは output/xxx.md（14回）です。」

例2（サブ委譲が効いている場合）
「深度の p90 は main では3ですが、subagents 配下を合わせると7です。main だけを見ると一発で着地しているように見えますが、実際の書き直しはサブエージェント側で起きています。サブに渡す時点の指示に、出力の形（何を・何字で・どの構造で）を1つ決めて書いてください。」

---

### 3.2 軸2 空振り率（Wasted Motion） / agent / 第1弾 / 重み 17.5

問い
到達に寄与しなかった手数を、1タスクあたり何回踏んだか。

v1 からの変更点は3つ。(a) 分子を帰属表適用後に確定（816 → 548）、(b) 率を提出物から降格し分子分母を生カウントで持つ、(c) W_ref による絶対値比較を凍結。

データ源と走査範囲
- `tool_result{is_error, content}` を `tool_use_id` で join したツール名 — scope=all
- Bash / PowerShell の `toolUseResult{timedOutAfterMs, persistedOutputSize}` と content 先頭の `Exit code N`
- `tool_use.input` の正規化ハッシュ（`json.dumps` による再直列化は禁止。§7 参照）

算出（分子と分母を生カウントで持つ）
```
# 分母（3通りを全部持つ。どれを表示に使ったかを scanManifest に書く）
toolResultTotal     = 27,775   # tool_result の総数
isErrorKeyPresent   = 13,374   # is_error キーを持つレコード数
taskBundles         = タスク束数（P5）

# 分子（帰属表 §5 適用後）
wastedCalls = A_agent_code 345 + D_dependency 59 + T_timeout 44 + Z_other 100 = 548
              # 帰属前は 816。差の 268 = N_network 141 + C_contract 71 + hookDenial 44
              #                        + user-rejected 11 + hook denial 無し 1
              # main のみでは 483 → 360（270 + 26 + 30 + 34）

# 参考: 率にすると 816/27,762 = 2.94% ↔ 548/27,762 = 1.97%（1.49倍）
#       走査範囲では main 2.70% ↔ sub 3.40%（1.26倍）
#       分母定義では 2.94% ↔ 6.10%（2.08倍）

# 反復（v1 のまま）
repeatWrite  = 同一タスク束で (tool_name, 正規化input) が2回目以降の書込/実行系
repeatRead   = 同上の調査系（Read / Grep / WebSearch / WebFetch）
nonContributingSuccess = 成功したが以後どこにも現れなかった呼び出し

# 窓内再発（層Aへ供給する署名）
sig = (tool_name, error_class, target_kind)
r_in = 1 - distinct(sig) / count(errors)
```

W_ref = 3.0 での絶対値採点は、母集団が規模層別で揃うまで凍結する。第1弾は自己時系列Δと、分類別の実名上位3件のみを出す。

三値の判定
- クラスタ >= 20 かつ 分母 >= 200 かつ 分子 >= 5 → available（実測 分子446 / 分母16,871 / クラスタ146 で available）
- フィルタ後の tool_use が窓内50未満 → not_applicable
- hook 起因の分離ができない環境（外部ログも本文パターンも無い）→ 「hook 起因を分離できていない」を not_applicable として明示。parse_failed にはしない

初回計測時の扱い
初回から算出できる。

ゲーム化耐性
| 攻撃 | 硬化策 |
|---|---|
| 分母を膨らませる | 分母をタスク束数に置く（v1 のまま）。加えて `nonContributingSuccess` が分子に入るので打つほど下がる |
| 失敗を握り潰す | v1 のまま。分布で検出し、該当環境は not_applicable にして「失敗が見えていない可能性」を明示 |
| hook で止められた失敗を空振りとして計上させ、hook を外させる | §5 の E1/E2 で hook denial を軸2の分子分母から除外済み。hook を外しても軸2は動かない。v1 では PreToolUse hook error 29件が軸2の減点と安全チェックの加点に二重に効いていた |
| 分母定義を有利なほうに選ぶ | 分母3通りを全部提出させ、表示に使った定義を scanManifest に固定する |

低スコア時のアドバイス例
「Edit の失敗のうち37件が C_contract（`String to replace not found` / `File has been modified since read`）でした。これは軸3の検証欠落の証拠として扱っているので、この軸の分子には入れていません。空振りの本体は A_agent_code 345件です。うち最多は同一署名の反復で、PreToolUse の Edit フックで直前 Read を検査すると機械で止まります。」

---

### 3.3 軸3 自己検証率（Self-Verification） / agent / 第1弾 / 重み 17.5

問い
出したものを自分で確かめてから人間に返しているか。失敗したとき、人間を呼ばずに立て直せるか。

v1 からの変更点は2つ。(a) 編集区間の集計を scope=all にして「検証をサブエージェントに委譲している」ケースを内訳分離、(b) 条件(ii) の「過去窓」の定義を `windowDays` / `windowSource` として scanManifest に載せる。

データ源と走査範囲
- tool_use の並び（name と `input.file_path` / `input.command`）— scope=all
- `tool_result.is_error`
- 書き込み系ツールの file_path
- 前窓スナップショットの「非ゼロ終了したことのあるコマンド」集合

算出（分子と分母を生カウントで持つ）
```
editSpans          = 全編集区間数
verifiedSpans      = 検証ありの編集区間数
verifiedInSub      = うち検証がサブエージェント側で起きたもの   # 内訳として必ず分ける
chainNonZeroToEdit = 「非ゼロ終了 → それを受けた編集」の連鎖数
firstSeenErrors    = そのセッションで初出のエラークラス数
selfRepaired / humanRescued / unresolved   # 3分割。減点は unresolved のみ

# 条件(ii) の過去窓
windowDays   = 10（稼働日）
windowSource = "setting" | "observed"   # Niko: setting/14、Leon: observed/42
```

C_contract（E7・実測71件 = Edit 37 / Read 28 / Write 5）は、この軸の分子（検証欠落の証拠）として使う。軸2の分子からは除外し、分母には残す。

TodoWrite 未使用の固定 -5点は据え置く。ただし Leon 側の TodoWrite 利用有無を確認するまでは、内訳表示のみで減点は保留する（§9 の Leon 待ち事項）。

三値の判定
- 編集区間25未満 → not_applicable
- 条件(ii) は初回窓 not_applicable（条件を外して計算し、外した旨を行単位で明示）
- `windowSource == "observed"` の環境では、その旨を三値と別に注記する（判定基準が環境で変わっていることを隠さない）

初回計測時の扱い
初回のみ条件(ii) を外す。2回目以降から本判定。

ゲーム化耐性
| 攻撃 | 硬化策 |
|---|---|
| PostToolUse フックに常に成功する1行コマンドを仕込む | 条件(ii)。過去窓で一度も失敗したことのないコマンドは検証として数えない |
| 検証をサブエージェントに委譲して main の V を上げる／下げる | scope=all で集計し `verifiedInSub` を必ず併記する。どちらの方向にも動かせない |
| 編集のたびに意味のない Read を差し込む | v1 のまま。編集した file_path と一致するもののみ、1編集1回まで |
| 自作自演の失敗から修復して S を稼ぐ | 分子を初出エラークラスに限定（v1 のまま） |

低スコア時のアドバイス例
「編集区間のうち、書いた対象を自分で確かめたのは12%です。加えて軸2の分類で C_contract が71件出ています（Edit 37 / Read 28 / Write 5）。これは『読まずに書いた』の直接の証拠です。散文で『編集したら確認する』と書く方式はこの環境では守られていないので、PostToolUse の Edit フックで1コマンドの検査に変えてください。」

---

### 3.4 軸4 成果の定着（Artifact Uptake） / joint / 第1弾 / 重み 17.5

判定は keep。v1 の定義本体は変えない。変更は2点のみ。(a) scanManifest への scope 必須化、(b) attribution を「成果側」から joint に付け替え。

なぜ keep できたか
v1 全文を grep して `pr-link` / `pr_link` は0ヒットで、§15 で「git revert率 / マージPR帰属」は明示的に rejected 済みだった。Leon 284件 / Niko 0件という pr-link のドメイン依存を最初から回避している。8軸で唯一、成果側を汎用の共通軸として保てた設計。

なぜ attribution が joint か
「何を作れと頼んだか」は人間、「使われる形で残したか」はエージェント。判定基準「その入力は人間にしか出せないか」には該当しないので human ではない。よって第1弾に出す。

問い
作ったものは、後で実際に使われたか。手ぶらで終わった依頼はどれくらいあるか。

データ源と走査範囲
- SA（P6）と、その後の `tool_use.input` / 人間発話 / 他ファイルの参照に同じパスが現れるか — scope=all（サブエージェントが読み返した再参照が main には出ないため、scope 次第で R が下振れする）
- 前窓スナップショットの SA パス集合（次窓生存）
- `attachment.type == "edited_text_file"`（main scope 実測199件）と `toolUseResult.staleRecovered == true`（実測98件）

算出（分子と分母を生カウントで持つ）
```
saCount        = SA の件数
reReferenced   = 書込後に別タスク束で再登場した SA 件数
weightedSum    = Σ w(p)          # w は v1 P6 の log 重み × uptake
bundles        = タスク束数
abandoned      = 放棄タスク束数
humanOverwritten = edited_text_file または staleRecovered が付いた SA 件数
                   # 実測 199 / 98。最小分母を割ったら (c) 抜きで再正規化

score = 100 * (0.55 * R + 0.30 * (1 - A) + 0.15 * (1 - O))   # v1 のまま
```

三値の判定
- SA 0件 または タスク束10未満 → not_applicable
- 次窓生存は初回 not_applicable
- (c) 人手上書き率は、分子（199 / 98）が最小分母を満たさない窓では項ごと落として再正規化し、落とした旨を出す

初回計測時の扱い
(a) 再参照（窓内での再登場）、(b) 放棄率、(c) 人手上書き率は初回から出る。次窓生存だけが2窓目から。

ゲーム化耐性
| 攻撃 | 硬化策 |
|---|---|
| 自分の書いたファイルを毎回 Read して再参照率を稼ぐ | 再参照は「書込より後の別タスク束で」現れたものに限る（v1 のまま） |
| サブエージェントに読ませて再参照を水増しする | 同一タスク束内の読み戻しは軸3でカウント済みで本軸では数えない。束の判定は scope=all で親 session_id に畳む |
| 中身の薄いファイルを大量に作る | w(p) の log 重み、クラスタ丸め、束あたり3件クリップ。薄いファイルは再参照されないので R が落ちる |

低スコア時のアドバイス例
「窓内に確定した成果物のうち、後で一度でも読み返されたのは26%でした。使われなかったものの上位は output/xxx_v3.md、output/tmp_summary.md です。同じ内容が別ファイルに3回作り直されている形跡があります。作る前に置き場所を1つ決めて、既存ファイルへの追記に切り替えてください。」

---

### 3.5 軸5 環境の代謝（Environment Metabolism） / agent / 第1弾 / 重み 12.5

まず扱いの確認。v1 §15 で「静的ファイルの穴埋め問題／素の環境が最低 Tier」を理由に降格されたのは軸5ではなく旧「ガードレール実効度」である。軸5 は採点軸として現存する。

v1 からの変更点は3つ。(a) U の分子を「distinct な attributionSkill 名の数」と明記し、発火重みの回数カウントを「行数」と明記して両方を生カウントで出す、(b) FC を cache_read 含む版と含まない版の2値併記、(c) 静的欠陥 D を採点から外し安全チェックへ移管。

なぜ (a) が要るか
`attributionSkill` は行数と種類数が別物で、取り違えると桁でずれる。Niko: 行数 12,432 / distinct 43 / 定義81 = 発火率53.1%。Leon: 行数231 / distinct 3 / 定義27 = 11.1%。分母を「skill_listing に載った集合」にしただけでは足りない。

なぜ (b) が要るか
v1 の FC 主式は `input_tokens + cache_read_input_tokens` だが、実測で cache_read は総トークンの94.7%（13.03B / 13.76B）。FC はほぼ cache_read で決まる、つまり「セッションをどれだけ長く続けたか」を測る指標になっており、v1 §15 が「キャッシュ効率は指示書の質でなく働き方の癖を測る」として rejected した当のものを主式に据えていた。

問い
毎回払っている固定のコンテキスト税に見合う資産だけが残っているか。作った資産は実際に発火しているか。

データ源と走査範囲
- `message.usage.{input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens}` — scope=all
- `skill_listing` attachment の content
- `attributionSkill`（行数 / distinct を別フィールド）
- hook 発火記録、MCP ツール呼び出しの出現

算出（分子と分母を生カウントで持つ）
```
# 文脈税（率でなく4つのトークン量をそのまま出す）
inputTokens / cacheReadTokens / cacheCreationTokens / outputTokens
FC_withCache    = median(1タスク束あたり input_tokens + cache_read_input_tokens)
FC_withoutCache = median(1タスク束あたり input_tokens)
# 2値を必ず併記する。片方だけを採点根拠にしない

# 稼働率
assetsDefined      = skill_listing に載ったスキル数 + 有効 hook 数 + 有効 MCP サーバ数
                     # 実測 skills: Niko 81 / Leon 27、hooks: Niko 61 / Leon 7
attributionDistinct = distinct な attributionSkill 名の数   # Niko 43 / Leon 3
attributionLines    = attributionSkill が付いた行数         # Niko 12,432 / Leon 231
U = Σ 資産ごとの発火重み / assetsDefined
    発火重みは attributionLines ベース（0回→0 / 1回→0.3 / 2-4回→0.7 / 5回以上→1.0）
    分子の「発火した資産の数」は attributionDistinct ベース

# 死蔵税（v1 のまま）
Wd = 未発火スキルの description 文字数合計 / skill_listing の総文字数

# 静的欠陥 D は本軸から削除 → 安全チェックへ（C-20）
score = 台形スコア * (0.5 + 0.5 * U) - Wd   を 0-100 にクリップ
```

三値の判定
- 資産数3未満 → U は not_applicable（台形スコアのみ）
- `skill_listing` の content が20,001字ちょうどで切れている → 「肥大の上限側は測定不能」として上限側 parse_failed
- 規模 Tier（jsonl 本数/容量、skills 定義数、hooks 定義数）を scanManifest に載せ、層別なしの percentile を禁止する

初回計測時の扱い
初回から算出できる。第1弾は自己時系列Δのみ。約10倍の規模差（Niko 1,502本/632.6MB 対 Leon 156本/64.1MB、skills 81 対 27、hooks 61 対 7）があるため、percentile は第2弾まで出さない。

ゲーム化耐性
| 攻撃 | 硬化策 |
|---|---|
| 指示書を短くしてフック注入や別ファイルの Read に逃がす | FC を実効入力トークンで測る（v1 のまま） |
| セッションを長く続けて cache_read を膨らませ、FC を「稼いだ」ように見せる／逆に短いセッションを量産して FC を下げる | FC を cache_read 含む版と含まない版の2値で出す。片方だけを動かしても両方は動かせない |
| 1本のスキルを何百回も発火させて U を上げる | 分子を distinct 種類数で持つ。行数はあくまで発火重みの材料 |
| 測定直前に SKILL.md を500行以下に削る | 静的欠陥 D を採点から外し、安全チェックの実名警告へ移した（点にならない） |
| 使わない資産を削除して U を上げる | 正しい行動なので許容。ただし U と絶対資産数の推移を必ず並記する（v1 のまま） |

低スコア時のアドバイス例
「定義81スキルのうち、窓内に発火したのは43種（53.1%）です。発火行数は12,432行なので、発火しているものは十分に使われています。問題は未発火の38本で、これが毎セッション先頭の skill_listing に載り続けています。あわせて、1タスクあたりの実効入力は cache_read を含めると中央値168k、含めないと12k でした。この差は指示書の重さではなくセッションの長さから来ています。指示書を削っても cache_read 側は下がりません。」

---

### 3.6 軸6 再発防止率 + D-6（書いたルール vs 守られたルール） / joint / 第1弾 / 重み 16.25

合意4により、本軸を中心軸に据える。v1 の軸6 は `preventedContinuation` を使っていないので死んでいないが、D-6 を担いきれていなかった。v2 では2層構成にする。

層A: 窓跨ぎ署名再出現（両環境・汎用）
v1 の r_cross をそのまま使う。3系統の署名（E: エラー署名 / P: 誘発再編集の対象パス / H: 人間指摘クラスタ）。初回窓は r_in。

層B: D-6 本体（比率なのでゲーム化に強い。スキルを増やすと分母が増えて逆にスコアが下がる）

問い
書いたルールのうち、実際に守られた（止まった／警告が出た）のはどれだけか。

データ源と走査範囲
```
# 分母（静的・両環境で取れる）
ruleDenominator = skills 定義数 + hooks 登録数 + CLAUDE.md/rules の IF-THEN 行数
                  実測: skills Niko 81 / Leon 27、hooks Niko 61 / Leon 7

# 分子（jsonl からは取れない）
ruleEnforced = 外部 hook ログの decision ∈ {triggered, warned, blocked} の件数
               実測（logs/hook_events.jsonl 185,902行）: warned 2,926 / triggered 1,872
               ※ ブリーフィング記載の 563,613行（warned 2,819 / triggered 1,827）と
                 行数が3倍食い違う。ローテーションと集計定義で動くので、
                 externalLogPath / externalLogLines / decisionVocabulary を
                 scanManifest に必ず載せる
# 使わない: preventedContinuation（Niko 1,911件・Leon 240件がいずれも全 false）

# 軸7 から移管（C-18）
C_obey = 制約表現を含む依頼のうち、その制約が実際に守られた割合
         「tests/ は触らない」と書いた回に tests/ への編集が無かったか
         「3件まで」と書いた回の出力が3件以内だったか
         → これはエージェントの行動なので本軸（joint）で持つ。人間スコアの乗数にしない
```

三値の判定
- 層A: 初回窓は r_in で available。r_cross は2窓目から available
- 層B: 外部ログがあれば available。無ければ **分母だけ available・分子 not_applicable** の状態を画面に出す（分母は静的に取れるので、分母まで欠測にはしない）
- 三値は環境単位ではなく行単位。同じ環境でも decision 語彙が途中で変わっていれば、変わる前の行は parse_failed にする

初回計測時の扱い
層Aは r_in ベースの暫定値と「基準値を登録しました。次回はこれらが消えているかで採点します」の明示。層Bは外部ログがあれば初回から出る。

ゲーム化耐性
| 攻撃 | 硬化策 |
|---|---|
| 指摘のたびに指示書へ1行 append する | 分母（ruleDenominator）が増えるので比率が下がる。書けば書くほど点が下がる方向に働くのが D-6 を中心軸にした理由 |
| hook を大量に置いて分子を稼ぐ | 分母にも同じ hook が乗る。空 hook は decision を出さないので分子は増えない |
| decision 語彙を書き換えて分子を膨らませる | `decisionVocabulary` を scanManifest に載せ、窓間で語彙が変わったら層Bを parse_failed にする |
| 外部ログを消して分子を消す | 層Bが not_applicable になるだけで点は上がらない。層Aは jsonl だけで動く |
| 否定語を使わない話し方に切り替えて層Aの分母を消す | 層Aの主系統がエラー署名と誘発再編集パス（言い方に依存しない行動側）なので動かない（v1 のまま） |

低スコア時のアドバイス例
例1（層A）
「前の窓で2回以上出た失敗のうち、64%が今の窓でも出ています。最多は Edit の `String to replace not found` を .md に対して出しているもので、前窓23件・今窓19件。これは文章で書いても止まりません。PreToolUse の Edit フックで直前 Read を検査してください。」

例2（層B・分子が取れない環境）
「書いたルールは分母で109本（skills 27 + hooks 7 + CLAUDE.md の IF-THEN 75行）ありますが、守られた回数を記録しているログがこの環境には存在しません。D-6 は分母だけ available・分子 not_applicable の状態です。hook の decision を1行 JSON で追記するだけで、次の窓から『書いたルールのうち実際に効いた割合』が出ます。」

---

### 3.7 安全チェック（非採点 / agent / 第1弾）

v1 の3項目から、permissions の読み方を変え、軸5 の静的欠陥を受け入れ、hook denial の帰属先を確定した。

(a) permissions の3つ組
```
allowCount / denyCount / askCount を、4スコープ merge の結果として出す
  実測 Niko: user 0/0/0、project settings.json 22/9/20、settings.local.json 263/0/0
             合算 285/9/20
             ※ ブリーフィングの「Niko: allow 263件・deny 0件」は
               チェックイン側の deny 9・ask 20 を取りこぼしている
  実測 Leon: allow 51 / deny 3 / 実質全許可 0
実質全許可パターン（Bash、Bash(python:*) 等の広域 allow）を実名リストで出す
  実測 Niko: allow に Bash(python:*) を含む = 実質任意コード実行を許可
件数の多寡では順位を付けない（263 > 51 だが Niko のほうが粗い）
```

(b) 参照先が存在しない hook 登録
v1 のまま。command からスクリプトパスを解決して存在確認する。

(c) `hook_cancelled` によるサイレント無効化
v1 のまま、最も価値が高い。hookName 単位で `cancelled / (success + cancelled) > 0.3` を実名列挙する。実測 `PreToolUse:Edit` は cancelled 108 / success 27 で8割が無効化されていた。

(d) 軸5 から移管した静的欠陥（採点しない・実名警告のみ）
SKILL.md 500行超 / description が空または1024字超 / 参照が2階層以上ネスト / 100行超の reference に目次がない。測定直前の書き換えで動くので、点にはしない。

(e) hook denial の分離（未解決リスク #1 の解決）
```
permission-rule 45件を3分する:
  本文に "PreToolUse:<Tool> hook error: [...]" を含む 31件 → hook が止めた（作動証拠）
  含まない 13件                                         → permissions 設定が止めた
  "Tool permission stream closed" 1件                    → 基盤エラー
hook 側の実例は全て Bash に対する
  PreToolUse:Bash hook error: [PYTHONIOENCODING=utf-8 python "$CLAUDE_PROJECT_DIR/scripts/hooks/_pre_bash_dispatcher.py"]: ...
permissions 側13件は3型:
  Permission to use Bash with command ... has been denied.
  Remove-Item on system path ... is blocked.
  get-childitem targeting ...secrets... was blocked.
```

三値の判定
(a)(b) は `settings*.json` の4スコープ merge で両環境から available。(c) は jsonl の attachment から両環境で available。外部 hook ログによる補強は Niko のみ available、Leon は not_applicable。

低スコア時のアドバイス例
「permissions.allow に `Bash(python:*)` が入っています。これは任意の Python コード実行を無条件に通す1行で、その下の scoped エントリの意味を消します。deny は0件、ask は settings.local.json 側で0件です。allow 263件という数字は委譲の広さを表していません。まず `Bash(python:*)` を消し、必要なスクリプトだけを個別に allow してください。あわせて `PreToolUse:Edit` の hook が cancelled 108 / success 27、つまり8割の確率でサイレントに無効化されています。設定上は守られていますが、実際には守られていません。」

---

## 4. scanManifest 仕様

提出ペイロードの完全な構造。率は送らず、分子と分母を生カウントで送る。本文とそのハッシュは送らない。

### 4.0 v2.1 追記（2026-08-19・Leon AB-74 の実測を受けて）

**追加①: 記録率（`recordedDays` / `activeDays`）を必須項目にする**

> 🚨 **2026-08-19 訂正（Leon AB-76）**: 本項の初版には誤りが2つあった。①動機例に使った「記録率13%」は**分母が暦日数**で、測っていたのは記録率でなく「稼働日の密度」だった。防御できる分母では **83.3%**（差は **6.9倍**）。②`activeDays = max(git, jsonl)` の定義は **107.1% を返して破綻**した。どちらも Leon が流した数字と定義を、こちらが**検証せずに v2 へ入れた**もの。以下は訂正後の内容。

外部ログの有無を2値で分岐させる設計は不十分だった。ただし「外部ログを持つ環境ですら疎」は言い過ぎで、Leon 環境の実態は **17%の取りこぼし**（15/18）である。

疎なデータの上にトレンドを描くと値が嘘になるので、初回体験を3値にする。

| 状態 | 判定 | 見せるもの |
|---|---|---|
| 外部ログなし | `externalLog.exists == false` | 「今日から積みます」。時系列は出さない |
| 外部ログありだが**疎** | `recordedDays / activeDays` が閾値未満 | **先に「記録率 N%」を伝える**。トレンドは出すが、疎であることを画面に明示 |
| 外部ログありで**密** | 同上が閾値以上 | 通常の時系列 |

```json
"externalLog": {
  "exists": true,
  "path": "(伏せ字可)",
  "rows": 42,
  "recordedDays": 15,
  "activeDays": 18,
  "activeDaysMethod": "union-of-observed(git, jsonl, externalLog)",
  "recordRate": "15/18",
  "recordRateCalendar": "15/125"
}
```

### `activeDays` の定義（🚨 max ではなく union）

```
activeDays = |union(git のコミット日, jsonl の日付, 外部ログの日付)|
```

**max を使うと分子を下回りうる。** Leon 環境では CSV にあって git にも jsonl にも無い日が3日あった（2026-04-17/18/19 — 初コミット 04-20 より前の作業日で、当時の jsonl は既に刈られている）。まさに「外部ログは生ログより長生きする」の実例。union なら分子が分母の部分集合になるので、**構造的に100%を超えない**。

意味も明確になる ——「**作業した証拠のある日のうち、外部ログに入っている割合**」。git を使わない環境でも jsonl ∩ 外部ログで成立する。

**限界を明記する**: これは真の稼働日の**下限**でしかない。コミットもログも残さずに終わった日は原理的に見えない。だから `activeDaysMethod` をマニフェストに入れ、将来定義を変えても層別できるようにする。

**暦日数分母の値も併記する**（`recordRateCalendar`）。これは記録率ではなく作業頻度を答える別の指標だが、捨てると「なぜ実日数が少ないのか」が読めなくなる。**2つの分母を両方持ち、それぞれが何を答えているかをラベルで区別する**。

閾値は n=2 では決められないので、母集団が育つまで**閾値判定をせず記録率をそのまま表示する**。

### 追加③: `originFieldCoverage` を必須項目にする（human 発話の定義依存・2.63倍）

`origin.kind == "human"` は人間発話の唯一の機械ラベルだが、**Leon 環境では user 行 5,814 中 195 行（3.4%）にしか付いていない**。実発話の4割弱しか拾えない。しかもバージョン境界ではなく、特定の入力経路だけに付く（2.1.204 で 22/1,877、2.1.233 で 173/3,920）。

同じ環境で定義を変えると **162 対 426（2.63倍）** 動く。

指標としては `origin.kind` を採る（定義が明確で、ヒューリスティックは環境ごとにぶれる）。ただし**絶対値を環境間で並べるのは危険**なので、カバレッジを併記する。

```json
"originFieldCoverage": "195/5814"
```

**追加②: 改善アドバイスは原因を断定しない**

同じ症状を出す機序が複数あるとき、単一原因を断定するとユーザーを間違った修繕に導く。

実例（2026-08-19）: 「`usage_log.csv` が薄い」という症状に対し、Niko は「rebuild による喪失」と機序を推定し、Leon も検証せずに肯定した。実測すると Leon 環境の喪失は**全35コミットで0件**で、真の機序は「記録契機（クロージング）を踏んでいない」だった。**「rebuild を直せ」と返しても、Leon 環境の薄さは1行も改善しない。**

したがって全軸の「低スコア時のアドバイス」は次の形式に統一する。

- ❌ 「原因は X です。X を直してください」
- ✅ 「この値が低くなる機序は N 通りあります。①… ②… ③…。**区別するには〈具体的な確認手順〉を見てください**」

症状の診断（値が低い）は機械で確定できるが、機序の特定は**ユーザーの環境を見ないと決まらない**。製品が断定してよいのは前者だけ。

---



```json
{
  "schemaVersion": "2.0",
  "runTimestamp": "2026-08-19T21:04:33+09:00",

  "scan": {
    "scope": "all",
    "rootsWalked": [
      "~/.claude/projects/*/*.jsonl",
      "~/.claude/projects/*/*/subagents/**/*.jsonl"
    ],
    "filesRead": 1502,
    "bytesRead": 663311155,
    "linesRead": 129132,
    "linesParseFailed": 0,
    "mainFiles": 1094,
    "mainLines": 101196,
    "subFiles": 368,
    "subLines": 27936,
    "subLineRatio": 0.2163
  },

  "window": {
    "unit": "activeDays",
    "windowDays": 10,
    "windowSource": "setting",
    "activeDaysMethod": "human-turn-days",
    "cleanupPeriodDays": 14,
    "cleanupPeriodDaysFoundAt": "~/.claude/settings.json",
    "calendarSpanDays": 22,
    "activeDays": 17,
    "contiguousDays": 11,
    "oldestTimestamp": "2026-07-28T...",
    "newestTimestamp": "2026-08-19T...",
    "gapDays": ["2026-07-31", "2026-08-01", "2026-08-02", "2026-08-08"]
  },

  "denominators": {
    "toolResultTotal": 27775,
    "isErrorKeyPresent": 13374,
    "taskBundles": null,
    "assistantTurns": null,
    "humanTurns": 1793,
    "editPaths": 1498,
    "sessionsWithToolUse": 160,
    "sessionsTotal": 1094,
    "denominatorDefinitionUsed": {
      "axis2": "toolResultTotal",
      "axis1": "editPaths",
      "axis6B": "ruleDenominator"
    }
  },

  "scale": {
    "projectCount": 3,
    "projects": [
      {"name": "katsu-agents", "bytes": 855638016, "files": 1081},
      {"name": "C--Windows-System32", "bytes": 2097152, "files": 13},
      {"name": "slide-system", "bytes": 1048576, "files": 0}
    ],
    "topProjectByteShare": 0.996,
    "skillsDefined": 81,
    "hooksDefined": 61,
    "scaleTier": null
  },

  "permissions": {
    "merged": {"allow": 285, "deny": 9, "ask": 20},
    "byScope": {
      "user":            {"allow": 0,   "deny": 0, "ask": 0},
      "projectSettings": {"allow": 22,  "deny": 9, "ask": 20},
      "projectLocal":    {"allow": 263, "deny": 0, "ask": 0}
    },
    "effectivelyUnrestrictedPatterns": ["Bash(python:*)"],
    "permissionModeDistribution": {"bypassPermissions": 1793},
    "entrypointDistribution": {"claude-vscode": 1793}
  },

  "externalLogs": {
    "hookEvents": {
      "path": "logs/hook_events.jsonl",
      "lines": 185902,
      "decisionVocabulary": ["warned", "triggered", "blocked", "..."],
      "decisionCounts": {"warned": 2926, "triggered": 1872}
    }
  },

  "versions": {
    "distinctVersions": 12,
    "originKeyMissingLines": 930,
    "originKeyMissingVersions": ["2.1.112"]
  },

  "attribution": {
    "rulesetVersion": "v2-E1..E14",
    "evaluationOrder": ["E1","E2","E3","E4","E7","E6","E5","E8","E9"],
    "reconciliation": {
      "isErrorTotal": 816,
      "scored": 548,
      "excludedEnvNoise": 141,
      "toSafetyCheck": 44,
      "toAxis3": 71,
      "toAxis8Breakdown": 11,
      "hookDenialAbsent": 1,
      "balances": true
    }
  },

  "sampling": {
    "axis6PairwiseUsed": false,
    "axis6SignatureCount": 288,
    "samplingRate": 1.0,
    "truncatedAt": null
  },

  "axes": [
    {
      "id": "axis1",
      "name": "first_pass_landing",
      "attribution": "agent",
      "phase": 1,
      "weight": 18.75,
      "state": "available",
      "counts": {
        "editPaths": 1498,
        "deepPaths": 135,
        "inducedRewrites": null,
        "rewriteTotal": null,
        "newFileCreations": 1225,
        "generationInterrupts": 28,
        "depthByScope": {"main": null, "sub": null}
      },
      "clusters": 131,
      "ci": {"method": "cluster_bootstrap", "B": 4000, "lo": null, "hi": null},
      "notes": []
    }
  ],

  "lineStates": {
    "available": null,
    "not_applicable": null,
    "parse_failed": null
  }
}
```

必須項目のうち、Leon と合意済みのもの
`scope` / `rootsWalked` / `denominatorDefinitionUsed` / 三値（行ごと）/ `runTimestamp` / 生カウント。

Niko が追加提案する分母定義まわり
- `denominators` に3通り（`toolResultTotal` / `isErrorKeyPresent` / `taskBundles`）を全部載せ、`denominatorDefinitionUsed` で「どれを表示に使ったか」を軸ごとに固定する。分母定義だけで2.08倍動くため
- `attribution.reconciliation` に引き算の検算結果を載せ、`balances: false` なら該当軸を parse_failed にする
- `permissions.permissionModeDistribution` を必須にする。Niko の human ターンは100% bypassPermissions で許可プロンプト自体が抑制されており、他環境の user-rejected と直接比較できない
- `externalLogs.hookEvents.lines` と `decisionVocabulary` を必須にする。同じログで3倍の行数差が出た実績があるため
- `versions.originKeyMissingLines` を必須にする。三値が行ごとであることの実例（2.1.112 の930行）

---

## 5. イベントから軸への帰属表（確定）

原則は「1イベント = 1一次帰属、他軸は参照のみ（分子にも分母にも足さない）」。

### 5.1 帰属表（E1〜E14）

| ID | イベント | 実測 | 一次帰属 | 他軸での扱い |
|---|---|---|---|---|
| E1 | `toolDenialKind == "permission-rule"` かつ本文に `hook error` | 31（H_hook_fired 全32件を含む） | 安全チェック（非採点・作動証拠） | 軸2の分子分母から除外 |
| E2 | `permission-rule` かつ `hook error` なし | 13 | 安全チェック | 軸2から除外。軸8内訳に表示 |
| E3 | `toolDenialKind == "user-rejected"` | 11 | 人間側 H2 の内訳表示のみ（最小分母を割るため採点しない） | 軸2から除外 |
| E4 | `is_error` × N_network | 141（WebFetch 126 + obsidian MCP 13） | どこにも帰属させず全軸から除外 | 軸0のカバレッジ注記へ |
| E5 | D_dependency | 59 | 軸2の分子 | 安全チェックに実名列挙 |
| E6 | T_timeout | 44（Grep 27 / Bash 14） | 軸2の分子 | — |
| E7 | C_contract | 71（Edit 37 / Read 28 / Write 5） | 軸3 自己検証率の分子（検証欠落の証拠） | 軸2の分子から除外し、分母には残す |
| E8 | A_agent_code | 345 | 軸2の分子 | 軸6 層Aに署名を供給 |
| E9 | Z_other 残り | 100 | 軸2の分子 | — |
| E10 | `[Request interrupted by user]`（生成中断） | 21 | 軸1の誘発型リダイレクト判定材料 | 軸2では使わない |
| E11 | `[Request interrupted by user for tool use]` | 19 | 安全チェック | 軸1・軸2では使わない |
| E12 | `attributionSkill` 行 | 12,432行 / distinct 43 | 軸5 | 行数と種類数を別フィールドで持つ |
| E13 | 軸3が検証としてカウントした Read/Grep/Glob の tool_use_id | — | 軸3の分子 | 軸2の反復分子から除外 |
| E14 | 外部ログ `hook_events.jsonl` の `decision ∈ {warned 2,926, triggered 1,872}` | — | 軸6 層B（D-6）の分子 | 外部ログが無ければ not_applicable |

### 5.2 帰属の3原則（実装者が3人いても同じ数字が出るための規約）

1. 判定順序を固定する。`E1 → E2 → E3 → E4 → E7 → E6 → E5 → E8 → E9` の順で最初にマッチしたものに帰属させ、以後の判定に回さない。`toolDenialKind` の判定が先、本文分類が後。
2. 一次帰属は必ず1軸。参照表示は何軸に出してもよいが、参照側は分子にも分母にも足さず、画面に「（軸Xで採点済み）」の但し書きを必ず付ける。
3. 除外したイベントは軸0のカバレッジに実名で計上し、引き算が合うことを機械検証する。合わなければ parse_failed として扱い、その軸の値を出さない。

### 5.3 検算（本セッションで実証済み）

```
is_error 816件 = 採点対象 548
               + 環境ノイズ除外 141
               + 安全チェック帰属 44
               + 軸3帰属 71
               + 人間側H2帰属 11
               + hook denial 無し 1
main のみ: 483 → 360（= A_agent_code 270 + D_dependency 26 + T_timeout 30 + Z_other 34）
```

### 5.4 なぜこの表が要るか

`toolDenialKind` を持つ tool_use_id は55件で、その55件全部（100%）が同時に `is_error == true` にも現れる。内訳は permission-rule × hook error = 31、permission-rule × その他 = 13、user-rejected × `The user doesn't want to proceed` = 11 で、後者は is_error 側の U_user_rejected 11件と件数が完全に一致する。帰属ルールが無ければこの55件は確実に二重計上され、軸2の値は帰属前 816/27,762 = 2.94% に対し帰属後 548/27,762 = 1.97% と1.49倍動く（main では 2.68% → 2.00% の1.34倍）。

分類器の妥当性はツール別内訳で裏取り済み。H_hook_fired は Bash 31件のみ、U_user_rejected は AskUserQuestion 9 / Bash 2、N_network は WebFetch 126、C_contract は Edit 37 / Read 28、T_timeout は Grep 27 と、それぞれ特定ツールに集中していて的を外していない。

---

## 6. 最小分母と信頼区間

### 6.1 信頼区間の算出方法（#9-A）

セッション単位のクラスタ・ブートストラップ、B=4,000、パーセンタイル法に固定する。Wilson・正規近似は使わない。

```
resample_unit = session_id   （sub は親 session_id に畳む）
for b in 1..4000:
    セッションを |S| 個 復元抽出し
    r_b = Σ num(s) / Σ den(s)      # 比推定量＝マイクロ平均
CI = (r_[100], r_[3900])           # 2.5% / 97.5% パーセンタイル
```

マクロ平均（セッションごとの率を平均）は禁止。実行コストは実測 0.9秒/軸、6軸で 5.4秒（v1 の8軸想定では 7.2秒だった）。

根拠。デザイン効果（クラスタ bootstrap 幅 ÷ Wilson 幅）を7指標で実測したところ次のようにばらついた。

| 指標 | DEFF |
|---|---|
| interrupt / human | 1.11 |
| permission-rule / tool_use | 1.14 |
| hookErr / toolResult | 1.29 |
| is_error / tool_use | 1.50 |
| is_error / キー保持 | 1.67 |
| toolUse / assistant | 2.46 |
| editsN / toolUse | 2.69 |

固定の膨張係数では吸収できず、Wilson で出すと軸1・軸4系（DEFF 2.4〜2.7）で CI を2.7分の1に過小申告する。マクロ／マイクロは実測で 2.410% 対 2.694% と 0.28pt ずれ、マクロは小セッションに過大な重みを与える。

### 6.2 各軸の最小分母（#9-B）

「クラスタ数（分母>0 のセッション数）20以上 かつ 分母イベント数200以上 かつ 分子5以上」の3条件AND。1つでも欠けたら値を出さず not_applicable にする（0点ではない）。

この環境の窓に当てはめた判定。

| 対象 | 分子 | 分母 | クラスタ | 判定 |
|---|---|---|---|---|
| 軸2 空振り率 | 446 | 16,871 | 146 | available |
| 軸1 一発着地 | 135 | 1,498 | 131 | available |
| 安全チェック permission-rule | 41 | 17,941 | 26 | available |
| 軸1 誘発中断 | 28 | 2,952 | 22 | available（ぎりぎり） |
| hookErr | 30 | 17,991 | 18 | not_applicable |
| H2 user-rejected | 11 | 17,941 | 10 | not_applicable |
| 軸6 再発防止（層A r_cross） | — | — | — | 2窓目まで not_applicable |

根拠。クラスタ数と CI 幅の関係をサブサンプリングで実測した。

| クラスタ数 | CI 幅（中央値） | p90 |
|---|---|---|
| 5 | 2.86pt | 4.84 |
| 10 | 2.18pt | 4.54 |
| 20 | 1.82pt | 2.49 |
| 30 | 1.51pt | — |
| 50 | 1.24pt | — |
| 160 | 0.73pt | — |

20を割ると p90 が中央値の2.5倍に跳ね、環境によって幅が制御不能になる。ここが折れ点。分母200は Wilson 逆算（p=0.03 で半幅3pt以内に n=140）に DEFF 1.5 を掛けた210の丸め。分子5未満では bootstrap 下限が0に張り付き CI が [0, x] になって改善を主張できない。

この基準だと、rare event 系の軸は初回窓で値を出せない。だからこそ「測れなかった」を画面に出す必要がある。

### 6.3 Δを「変化なし」と表示する条件（#9-C）

「改善／悪化」と表示してよいのは、Δのブートストラップ CI の下限と上限が同符号（0を跨がない）かつ `|Δ| >= MDE_floor` の両方を満たすときのみ。

```
MDE_floor = 1.0pt          # 率系の軸（軸1・2・3・4・6）
          = 前窓比 10%     # 個数系の軸（軸5）
それ以外は必ず「変化なし（Δ = +0.2pt、誤差範囲 ±0.7pt）」と誤差幅ごと表示する
ΔのCIは2窓を独立にブートストラップし、差の分布から取る
```

根拠。実データを2窓に割って検証した。

| 指標 | Δ | CI | 判定 |
|---|---|---|---|
| is_error / tool_use | +0.201pt | [-0.527, +0.931] | 0を跨ぐ → 変化なし |
| editsN / tool_use | -4.267pt | [-6.899, -1.839] | 有意 |
| interrupt / human（直近7日 vs その前7日） | +0.834pt | [+0.091, +1.636] | 有意だが MDE_floor 1.0pt 未満 → 変化なし |
| interrupt / human（直近10日 vs その前11日） | -0.083pt | [-1.253, +0.828] | 非有意かつ符号が反転 |

最後の2行が決定的。有意性だけを条件にすると、窓の切り方次第で符号の逆転した「改善しました」を出す。MDE_floor 1.0pt を併用すれば前者は弾かれる。

### 6.4 窓の定義（#9-D）

窓は暦日ではなく稼働日で切る。「人間発話が1件以上ある日」を稼働日と数え、直近10稼働日を1窓とする。暦日スパンと稼働日数の両方を scanManifest に記録するが、分母には稼働日ベースのみを使う。

根拠。日次行数の実測に 07-31〜08-02（3日）と 08-08（1日）の完全な穴がある。最古 2026-07-28／最新 2026-08-19 で暦日スパン22日だが、連続稼働日は 08-09〜08-19 の11日しかなく、設定値 `cleanupPeriodDays = 14` とも一致しない。Leon 環境には `cleanupPeriodDays` キー自体が無く最古42日前なので、暦日で切ると両環境で窓幅が揃わない。稼働日ベースなら赤の他人の環境でも同じ式になる。

---

## 7. 計算量の予算

### 7.1 目標実行時間（#10-A）

初回スキャン（cold）90秒、2回目以降（warm・差分）20秒を上限とする。超えたら軸を落とすのではなくサンプリング上限（7.3）を発動する。

cold の内訳見積り（推定の積み上げ。各工程の単体実測値から算出）
```
jsonl 1パス            56.0秒   （warm 実測 12.2秒 / cold 換算）
FS 存在確認             0.9秒   （実測 1,561パスで 0.911秒）
外部 hook ログ集計       2.3秒   （実測 186,184行で 2.30秒）
逆引き再参照            6.1秒   （実測 6.06秒・hit 20,556）
bootstrap 6軸           5.4秒   （実測 0.9秒/軸）
------------------------------------
合計                   70.7秒   → 90秒予算の79%
```

根拠となる単体実測
| 工程 | 実測 |
|---|---|
| `measure_agent_env.py --scope all` cold | 69.9秒 |
| 同 warm | 16.3秒（4.3倍差） |
| IO 下限 | 12.12秒 |
| `json.loads` のみ | 17.04秒 |
| 全キー再帰走査 | 23.12秒 |
| フィールド絞り込み1パス | 12.2秒 |
| FS 存在確認 1,561パス | 0.911秒 |
| `hook_events.jsonl` 186,184行 | 2.30秒 |

cold / warm を区別せず「10.9秒」と書いた v1 の前提は成立しない。

### 7.2 パス数の仕分け（#10-B）

jsonl を2回以上読むことを禁止する。

Pass 1（jsonl 1回読み・warm 実測 12.2秒 / cold 推定 56秒）で次を全部拾う。
- 軸1・2・3・4・5・6 の全分子分母
- 編集パス集合 / 正規化エラー署名 / tool 名 / トークン / `attributionSkill` / `toolDenialKind`
- `tool_use_id` → 分類の写像
- basename 逆引きインデックス

Pass 1 内で禁止する処理を3つ明記する。
1. `json.dumps(tool_use.input)` の再直列化 — 実測 28.5秒（1パス 12.2秒の2.3倍）
2. `tool_result.content` の全文保持 — 先頭300字に切る
3. 全キー再帰走査 — 実測 23.12秒（`json.loads` のみ 17.04秒に対し +6秒）。使うキーは既知なので直接引けば足りる

Pass 2 はファイルシステムと外部ログにだけ許す。
- 2a: FS 存在確認（0.911秒 / 1,561パス）= 軸1・軸4の SA 判定
- 2b: `logs/hook_events.jsonl` 集計（2.30秒 / 186,184行）= 軸6 層B
- 2c: `settings*.json` の allow/deny/ask 3つ組と hook 登録の存在確認（0.1秒未満）= 安全チェック

Pass 3 は統計のみ（bootstrap 0.9秒/軸）。

### 7.3 O(n²) の軸とサンプリング上限（#10-C）

O(n²) は「軸6 層A のエラー署名クラスタリング」ただ1つ。

既定は O(n) の正規化署名を使う。実測 0.027秒で 816件を 288署名に畳む。全対比較は初回1回だけの診断モードに置く。

```
正規化規則（正本）:
  sig = text[:300]
  sig = re.sub(r'\d+', 'N', sig)
  sig = re.sub(r'[A-Za-z]:\\[^\s"\']+', 'PATH', sig)
  sig = re.sub(r'/[^\s"\']+', 'PATH', sig)
  sig = sig[:80]

全対比較を走らせる場合:
  n <= 1000  → 全対比較（difflib は quick_ratio のみ。ratio() 禁止）
               予算上限 71.5秒 を超えたら打ち切り、打ち切り位置を scanManifest に記録
  n >  1000  → 層化サンプリングで1,000件に落とす
               層 = 正規化署名
               各層から min(層サイズ, ceil(1000 * 層サイズ / 全件)) を抽出
               samplingRate を scanManifest と画面の両方に出す
```

根拠。difflib 全対比較の実測は 143µs/対で安定していた（n=100 で 111.9µs、n=300 で 135.2µs、n=600 で 153.1µs、n=816 で 143.0µs）。所要 = 143µs × n(n-1)/2 なので、n=816 で 47.55秒（この環境の実測値で既に90秒予算の半分超）、n=1,000 で 71.5秒、n=2,000 で 286秒、n=5,000 で 1,787秒（30分）。対して正規化署名 O(n) は同じ816件を 0.027秒で処理する（1,760倍速い）。

### 7.4 軸4 再参照検出のアルゴリズム（#10-D）

逆引き basename インデックスに固定する。素朴な全対走査は禁止。

```
Pass 1 の中で basename -> path の dict を作る
同じ Pass 1 内で、テキスト片（先頭2,000字に切る）から
  正規表現 [\w\-\.]+\.\w{1,5} で候補トークンを抽出し set に当てる
```

根拠。素朴 O(1,561パス × 39,878テキスト) = 62.2M回の部分文字列検査は、200×20,000のサブセット計測 4.04秒からの換算で63秒（推定）。逆引き basename set は同じ全量を 6.06秒（hit 20,556）で処理し 10.4倍速い。63秒は cold 90秒予算の7割を1軸で食い潰す。

### 7.5 2回目以降の差分スキャン（#10-E）

窓スナップショットに `(file_path, size, mtime)` を保存し、変化していないファイルはスキップする。jsonl は追記専用なので、size が増えた分だけ `seek(prev_size)` して読む。

size が減っていたらそのファイルは全読み直しに落とす。追記専用の前提が壊れた合図なので、静かに続けずスナップショットの当該エントリを破棄する。

根拠。warm 16.3秒のうち大半は前回窓で計算済みのファイル。日次行数の実測で直近1日に書かれたのは 3,471行、全129,873行の2.7%しかない。差分だけなら warm 20秒目標を満たす。

### 7.6 保持期間が長い環境の定常コスト上限（#10-F）

窓計算はファイルの mtime で足切りし、直近10稼働日ぶんのファイルだけを読む。窓外のファイルは初回の「アーカイブ取り込み」時に1回だけ読んでスナップショット化し、以後は読まない。これで保持期間に関わらず定常コストが10稼働日分に固定される（この環境で約480MB / cold 約53秒・推定）。

根拠。実測 632.6MB ÷ 13稼働日 = 48.7MB/稼働日。Leon 環境は `cleanupPeriodDays` キーが無く最古42日前なので、同じ密度なら 2,045MB → cold 226秒（推定）で90秒予算を2.5倍超過する。窓を稼働日で足切りしない限り、保持期間の長い環境ほど遅くなる構造が残る。

---

## 8. 人間側（第2弾）の扱い

### 8.1 結論

human 軸は3つ以上見つかった。ちょうど3本。よって人間側ダッシュボードは合意条件を満たし「出さない」にはしない。

ただし新規に見つかったのは1本だけで、内訳は次のとおり。

| # | 軸 | 由来 | 実測 |
|---|---|---|---|
| H1 | 未決の滞留 | 確定済み（データ源を差し替え） | AskUserQuestion 未応答 17/117（14.5%）。補助の `pending_actions.md` は未チェック671件 |
| H2 | user-rejected 件数 | 確定済み（注意付き） | 11件（permission-rule 45件との対比） |
| H3 | AskUserQuestion の選択肢外回答 | 今回の新規 | custom 23 / answered 100（23.0%） |

出すときは次の3条件を付ける。

1. 粒度は月次にする。新軸23件・user-rejected 11件はいずれも実測で月あたり十数件規模で、日次で出すと大半の日が空になる
2. H1 のデータ源を差し替える。`pending_actions.md` は Niko 固有（rare）で赤の他人の環境では測れない。AskUserQuestion 未応答（17/117）を普遍データ源として統合し、`pending_actions.md` は補助に落とす。なお同ファイルは `- [x]` が0件で closure が一切記録されておらず、滞留が解消されたかを測る手段が現状無い
3. H2 に `permissionMode` を必ず添える。Niko の human ターンは100% bypassPermissions で許可プロンプト自体が抑制されているため、11件は「拒否の総量」ではなく「bypass 下でもなお拒否された回数」である

### 8.2 H3 AskUserQuestion の選択肢外回答（新規）

問い
エージェントが提示した選択肢は、人間の現実に届いていたか。人間が「その他」を自分の言葉で書いた回数はどれだけか。

データ源と走査範囲
`toolUseResult.{questions, answers}`。`questions[].options[].label` と `answers{質問文: 回答文字列}` を文字列一致で突き合わせる。走査は main スコープ（sub は全項目0）。

算出（率でなく5つの生カウント）
```
asked        = 117   # questionsAsked
answered     = 100
offered      = 77    # options[].label 集合に一致した回答
custom       = 23    # 一致しなかった回答（23.0%）
avgOptions   = 3.36
（参考）AskUserQuestion tool_use = 116、sessionsWithAsk = 52、multiSelectQs = 11
asked が floor 未満なら率をレンダリングせず available のまま counts だけ出す
```

実例。「到達点は?」に4択を出したが、人間は「安心してまかせられるな、という状態」と選択肢の外で答えた。

ゲーム化耐性
エージェントは custom を自力で増減できない（答えるのは人間だけ）。確認を取るのをやめると分母が0になり、点が上がるのではなく axis が not_applicable として画面から消える。残る細いズルは2つ。(1)「その他 / おまかせ」のような広すぎる選択肢を混ぜて機械的な一致率を上げる、(2) 当たり前の質問しかせず率を良く見せる。対策は率を単独で出さず asked / answered / offered / custom を生カウントで並べ、asked に floor を設けること。

人間を責めない読み方
「自分が選択肢の外を答えた回数」は人間の失点ではなく、エージェントの枠組みが外れた記録として読む。

### 8.3 却下した候補と理由

| 候補 | 判定 | 理由（実測） |
|---|---|---|
| A. 提案への応答時間 / think-time | reject | p90=1.9時間・p99=22.9時間・max=139時間で、集計値は睡眠と離席に支配される。「滞留」と読むと H1 と完全に重複する。重複しない唯一の読み筋であるラバースタンプ検知は、長文(800字超)出力後の肯定応答230件中10秒以内が0件で信号ゼロ。加えて「速い＝良い」は責める設計 |
| B. 差し戻しに理由が付いているか | reject | 人間ターン1,793件中、否定的リダイレクト22件（1.2%）。166セッション中19本（11.4%）にしか出ない。より致命的なのは検出に言語別の否定語彙が要ること。赤の他人の英語環境で同じ式を回すと静かに0を返し、not_applicable ではなく「否定ゼロ＝良好」という検出不能な偽陰性になる |
| C. 外向き承認の粒度（APPROVED_BY_KATSUYUKI） | reject | attribution が human ではなく agent と実測で確定。出現435行（user 193 / assistant 242 / attachment 3）のうち `origin.kind == "human"` の行は0件。トークンは人間が打った発話には一度も現れず、エージェントが Bash コマンド行に書き込んだものとその tool_result のエコーだけ。人間の承認カウントとして加点すると「エージェントが自分に承認を出した回数」を人間の指標に計上することになる |
| D. セッションの開始頻度・間隔・曜日分布 | reject | 単なる利用頻度。曜日分布が保持期間のアーティファクトで、`cleanupPeriodDays = 14` により17日分しか残っておらず、Fri 74 と Mon 451 の差は行動の差ではなく「どの曜日が刈られずに残ったか」を見ているだけ。「多い＝良い」は責める設計 |
| F. AskUserQuestion の未応答（単独軸として） | needs_work → H1 に統合 | H1 と同じ問い（人間が決めていない案件がどれだけあるか）に答えており重複する。ただし H1 の現行データ源が Niko 固有なので、本候補を H1 の普遍・言語非依存のデータ源として統合するのが正しい使い道 |
| G. 人間による一次情報の投入（画像・文書の添付） | needs_work → 文脈情報に降格 | 人間ターン1,793件中、画像を含むターン77件（4.3%）、文書1件。attribution・普遍性・言語非依存・ゲーム耐性は全て満たすが方向が定義できない。ツールアクセスが豊かな環境（Outlook COM・Drive 直読み）ほど正当にスクショが不要になるため、高いことも低いことも良いと言えない。指標ではなく他軸を解釈するための文脈として持つ |
| H. permissions の3つ組と permissionMode | reject（人間軸として） | 時系列にできない（`settings.local.json` は git 追跡0コミット、エントリ単位のタイムスタンプも無し）。attribution が joint（エージェントや update-config スキルも書き換える）。human ターンの permissionMode は分散ゼロ（100% bypassPermissions）でそもそも変数になっていない。安全チェックの非採点項目としては採用（§3.7） |

### 8.4 設計上の副産物

`origin.kind == "human"` が人間発話の唯一の機械ラベルであることを特定した（Niko 1,793件）。ただし 2.1.220 以降にしか無く、2.1.112 の930行では origin キー自体が欠落している。これは合意事項2「三値は行ごと」の具体的な実装点になる。

---

## 9. Leon の返答待ちで確定できない事項

### 9.1 #6 提出単位の定義 → ✅ **確定（2026-08-19・Leon AB-76 の代替案を採用）**

**決定: 提出単位はマシン全体。ペイロードにプロジェクト別内訳を全件入れる。閾値 M は設けない。**

```json
"projects": [
  {"name": "(伏せ字可)", "mainFiles": 1081, "subFiles": 368, "mainLines": 0,
   "subLines": 27936, "bytes": 816000000, "humanRowsOrigin": 0, "humanRowsHeuristic": 0}
]
```

- 「きれいなプロジェクトだけ提出する」は、**部分提出を受け付けない**ことで防ぐ。閾値で判定する必要がない
- 受け取り側は内訳を持つので、**後からどんな集計単位でも再計算できる**（率でなく分子分母を生カウントで送る方針と一貫）
- 閾値は母集団が育ってから**実データの分布を見て決める**

**なぜ閾値を今決めないか（実測に基づく）**

当初は「窓内に人間発話が M 件以上あったプロジェクトを全部含める加重平均」の M を実測から決める計画だった。**n=2 の両環境とも単一プロジェクト支配で、M が決められないことが判明した。**

| 環境 | プロジェクト数 | ログを持つ数 | 集中度 |
|---|---|---|---|
| Niko | 3 | 2 | バイト比 **99.6%** が1プロジェクト |
| Leon | 5 | **1** | **100%**（4つは jsonl 0件・`memory/` のみ残存） |

この2件から決めた M は、分布が違う環境で破綻する式を「実測で決めた」と称することになる。しかも **n=2 で仮置きした閾値は、後で変えても既提出分を再計算できない**——定義依存で4回失敗したのと同じ形になる。

**副次的に判明したこと**: Leon 環境は `usage_log.csv` に5アプリの行が残っているのに、生ログを持つプロジェクトは1つだけ。つまり「**今見えているプロジェクト分布は実態ではなく、直近の作業履歴の影**」。保持期限がプロジェクト別の比較を壊す。この事実自体が、提出単位をマシン全体に置く根拠になる。

**実装への影響**: 小さい。全プロジェクトを走査して内訳を吐くだけ。閾値判定のロジックが不要になる分、むしろ単純になる。

### 9.2 軸3の TodoWrite 減点

Leon 側の TodoWrite 利用有無が不明。用途差を叩く可能性があるため、実測が来るまで固定 -5点は保留し、内訳表示のみとする。Leon の `attributionSkill` distinct が3種しかない（Niko 43種）ことから、資産の使い方が構造的に違う可能性が高い。

何が決まれば決まるか。Leon 環境の窓内 TodoWrite 呼び出し件数と、それを含むセッション比率。ゼロなら減点項を全廃し、内訳表示だけにする。

### 9.3 軸6 層B の分子が取れる環境の割合

Leon 環境に `hook_events.jsonl` 相当の外部ログが存在するかが不明。存在しなければ D-6 の分子は Niko のみ available、Leon は not_applicable となり、合意4で中心軸に据えた軸が2環境のうち1環境でしか動かないことになる。

何が決まれば決まるか。Leon 環境の hook ログの有無・パス・行数・`decision` 語彙。無い場合は「hook の decision を1行 JSON で追記する」を製品側の推奨セットアップとして第1弾に含めるかを決める。

### 9.4 規模 Tier の刻み（`scanManifest.scale.scaleTier`）

2環境（jsonl 1,502本/632.6MB 対 156本/64.1MB、skills 81 対 27、hooks 61 対 7）では層の境界を引けない。n=2 で刻みを決めると、その2点に合わせただけの境界になる。第2弾（母集団比較）の着手条件として、最低でも別環境がもう数件必要。

### 9.5 v1 の未解決リスクのうち、v2 でも未決のもの

| # | 論点 | v2 での状態 |
|---|---|---|
| 2 | 常時ロード層の確定集合 | 未決。実効トークンを主源にしたので致命ではないが内訳の説明が破綻する |
| 3 | `skill_listing` の 20k 截断 | 未決。三値の parse_failed（上限側）として扱うことだけ決めた |
| 4 | hook の `durationMs` のデータ源 | 未決。21倍食い違うため、確定するまでレイテンシは使わない |
| 7 | 用途プロファイル判定の閾値 | 未決。第2弾（母集団比較）の前提なので第1弾では不要 |
| 8 | タスク難易度の正規化 | 未決。3レンズとも解を出せなかった。第1弾は自己時系列のみなので影響しない |
| 11 | 他ツール（Codex / Cursor）のログ所在とスキーマ | 未決。「Claude Code 専用」と明示する |
| 13 | 複合ハック耐性の実測工程 | 未決。軸を実装する前に「アドバイスを形式的にだけ実行した環境」を作り、総合点の上がり幅を実測する工程は必須のまま |
| 14 | hash chain の預け方 | 未決だが優先度が下がった。第2弾（母集団比較）の話なので |
| 15 | C/S/V ルーブリックの効果量の扱い | 軸7が第2弾送りになったので、第1弾では不要 |
| 16 | 受領シグナルの判定に git を読むか | 未決。読まない前提で軸4を組んである |

---

## 10. v1 から落とした軸と理由

### 10.1 軸8 手離れ度（v1 §11・重み8・人間側）→ drop

3本の柱のうち2本が実測で死に、残る1本に帰属誤りがあった。

1. 生成中断 `[Request interrupted by user]` は HTC の係数3の項だが、main 走査で28件（1,502ファイル / 632.6MB 中）しかない。`toolUseResult.interrupted` への乗り換えも不可（キー保持 8,727件・true 0件、Leon も 1,268件中0件）
2. 内訳に置いた user-rejected は all 走査で11件。合意6が「human に入るのは pending の滞留数と user-rejected の2つだけで薄い」と言っている、その薄いほうの実測値がこれ
3. think-time（WT）は、v1 自身が旧「監督バランス」を解体した理由として「離席と原理的に区別できない／人の注意力を採点するのは倫理条件と衝突」と書いたものを、名前を変えて残していた。しかも自動起動セッションの除外は実測 1,108中190件（17%）しか効いておらず、残りが混ざると think-time は意味を持たない
4. 最大の問題は帰属誤り。「1成果物あたりの人間発話数」が増える主因はエージェントが着地しないこと（軸1の誘発型やり直し）であり、同じ現象を軸1（agent）と軸8（human）で二重に測って片方を人間の責に帰していた。加えて人間発話数はサブエージェント委譲で構造的に減る（サブ配下が全行の26.7%）ため、自動化を組んだ環境ほど「手離れが良い」と出て、努力量ではなく構成を測る

残したもの。〈前進発話 / やり直し発話 / 生成中断〉の3分割を軸1（一発着地率）の内訳表示に agent 帰属で吸収した。

復活の条件。「人間の張り付き量」を人間軸として復活させるのは、(1) 離席と熟読を区別できる一次データ、(2) 自動起動セッションを9割以上除外できる判定、(3) サブエージェント委譲量で正規化する式、の3つが揃ってから（第2弾以降）。

### 10.2 軸7 依頼の設計度（v1 §10・重み12・人間側）→ 第2弾送り + 定義修正

落としたのではなく第2弾に送る。合意6（人間側は第1弾に入れない）による。同時に定義を2箇所直した。

1. `C_obey` を軸7から削除し、軸6 層B へ移管した。制約が守られたかはエージェント側の行動で、これを人間スコアの乗数にすると「エージェントが指示を破るほど人間の設計度が下がる」という符号の反転が起きる
2. P1 の人間発話切り出しを `isSidechain != true` から `subagents/` サブツリー判定に置換した（C-01）

加えて、v1 自身が「UserPromptSubmit フックや CLAUDE.md にプロンプト自動整形がある環境は人間側から環境側へ付け替える」と書いているが、Niko 環境は UserPromptSubmit hook を5本実運用している（check_vault_recall / check_model_recommendation / check_tool_syntax_in_prompt / check_retrospective_trigger / check_line_bot_lookup_trigger）。この規定に従うと自環境では human 軸として成立せず、付け替えが例外ではなく既定になる。第2弾で扱うときは、付け替えの判定結果と付け替えた事実をレポートに必ず出す。

第2弾での軸7は、C/S/V の生カウント（各0-2の分布と起点発話数）だけを持ち、乗数を持たない。

### 10.3 v1 §15 で落とした軸のうち、v2 で判定が変わったもの

| 軸 | v1 の判定 | v2 | 理由 |
|---|---|---|---|
| ガードレール実効度 | 非採点の安全チェックに降格。復活条件は「hook がブロックした実績の記録形式が確定したら」 | 復活条件は満たされた（C-30）が、採点軸には戻さない | 記録形式は3点セットで確定し、hook が止めた31件を作動証拠として分離できるようになった。しかし作動証拠だけの加点軸にすると「hook を増やすほど点が上がる」量への加点に戻る。代わりに D-6（軸6 層B）として比率で持つ。分母に hook 登録数が入るので、増やしても点は上がらない |
| サブエージェント / Workflow の委譲効率 | 加点のみのバッジとして別枠。「isSidechain は全レコード false だったため検出に使えない」 | 検出方法が確定した（`subagents/` サブツリー走査）が、独立軸には戻さない | 検出はできるようになったが、委譲量は軸1の `depthByScope`・軸3の `verifiedInSub`・軸4の scope として各軸の内訳に入れるほうが情報量が多い。独立軸にすると「使っていないだけ」を低評価する v1 の懸念がそのまま残る |
| キャッシュ効率（cache_read の比率） | 軸5の内訳表示のみ | 内訳表示のまま。ただし軸5の FC がこれに化けていたことを検出し、2値併記に変更（C-16） | cache_read は総トークンの94.7%。v1 は「rejected した指標」を主式に据えていた |
| `history.jsonl` / `stats-cache.json` | 「4ヶ月以上更新が止まっている」ため排除 | 排除のまま。ただし根拠が強くなった | 両環境とも 2026-04-17 で終端が一致。規模が63倍違うのに同じ日で止まっている（Niko 3,516行 / Leon 56行） |
| git revert率 / マージPR帰属 | 分母がコード成果物に固定されるため rejected | rejected のまま。根拠が実測で裏づけられた | pr-link は Leon 284件 / Niko 0件。ドメイン依存が2環境で確認された |

---

## 11. 第1弾の実装順序

v1 §17 の Phase 0 を、v2 の確定事項で組み直したもの。

| 優先 | 何を作るか | 理由 |
|---|---|---|
| 1 | 軸0 + 共通土台（P1 の新定義・稼働日窓・scanManifest・帰属表 E1〜E14・スナップショット） | これがないと「スコアが低い」のか「測れなかった」のかを区別できない。帰属表と scanManifest は後から変えると全軸を作り直しになる |
| 2 | 軸2 空振り率 | 実測でクラスタ146・分子446・分母16,871 と最も安定している。帰属表を当てた効果（816 → 548）が最初に目に見える軸でもある |
| 3 | 軸1 一発着地率 | 深度の実名列挙が最も分かりやすい。`depthByScope` でサブ委譲の効果が見える |
| 4 | 安全チェック | 実装が最も軽く（`settings*.json` の merge と存在確認だけ）、`Bash(python:*)` や `PreToolUse:Edit` cancelled 108/success 27 のような発見のインパクトが大きい |
| 5 | 軸6 層B（D-6） | 合意4の中心軸。外部ログの集計だけなので実装は軽い（2.30秒 / 186,184行）。ただし §9.3 の Leon 待ちが解けるまでは Niko のみ available |
| 6 | 軸3 自己検証率 / 軸4 成果の定着 / 軸5 環境の代謝 | 軸4は次窓生存が2窓目から、軸6 層Aは r_cross が2窓目から。初回窓では計算だけしてスナップショットに残す |

第1弾でも、6軸すべての分子分母のスナップショットは初回から取る。後から遡れないため（合意3）。

着手前に決めること: §9.1（#6 提出単位）のみ。#9 / #10 / #12 は本 v2 で確定済み。
