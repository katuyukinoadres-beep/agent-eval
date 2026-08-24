# 導入マニュアル

読む前に 1 つだけ。**このツールは、入れた初日には役に立ちません。** 初回は基準を作るだけで、比べる相手がまだ無いからです。逆に、**入れるのが遅れた分は取り返せません** — 生ログは Claude Code の保持ポリシーで消えるので、過去に遡って作ることはできません（実測: 稼働 121 日に対し、ログが残っていたのは 5.8%）。

だから、**評価に使う予定が無くても先に入れておく**のが正しい使い方です。

---

## 1. 必要なもの

| | |
|---|---|
| Node.js | **20 以上**（開発機での動作確認は 24.13.1） |
| Claude Code | 使用履歴。`~/.claude/projects/` にログがあること |
| OS | Windows / macOS / Linux |
| ネットワーク | **不要。** インストール後は一切通信しません |

ログがあるかどうかの確認:

```bash
# macOS / Linux
ls ~/.claude/projects/

# Windows (PowerShell)
dir $env:USERPROFILE\.claude\projects\
```

ここが空、またはディレクトリ自体が無い場合は §5 を読んでください。

---

## 2. 入れる

### 経路 A: npm から入れる（推奨）

```bash
npm install -g @katuyukinoadres-beep/agent-eval
agent-eval --version
```

> スコープが付いているのは、`agent-eval` という素の名前を別のパッケージが既に取っているためです。

### 経路 B: リポジトリを clone する

ソースが手元に残るので、[docs/PRIVACY.md](PRIVACY.md) に書いてあることを自分で確かめられます。

```bash
git clone https://github.com/katuyukinoadres-beep/agent-eval.git
cd agent-eval
npm install          # 最後に prepare が走ってビルドまで済みます
node dist/cli.js --version
```

この経路では、以降の `agent-eval` を **`node dist/cli.js`** に読み替えてください。

### 依存パッケージについて

**実行時依存はゼロ**です。`npm install` が入れるものは全部ビルドとテスト用で、`dist/` は Node の標準ライブラリしか使いません。確かめ方:

```bash
npm view @katuyukinoadres-beep/agent-eval dependencies    # 空であること
```

---

## 3. 動いていることを確かめる

```bash
agent-eval scan --summary
```

**読み取り専用です。** `--store` を付けない限り 1 バイトも書きません。

出てくるものの例（数字は環境ごとに違います）:

```
scanned    329 files, 48093 lines, 0 unparsed
window     11 human-turn days, 11 user-row days, observed
           10/11 in window (2026-07-08..2026-08-23), boundary +05:30
           scored over the window: 4/4 axes
gate       passed
axes       4/11 available
composite  56.9 (B) over 4 axes
validation passed (0 violations, 1 flags)
```

読み方は [docs/GUIDE.md](GUIDE.md) にあります。ここで見るのは 3 点だけです。

1. `scanned` の **files / lines がゼロでない**こと
2. `gate` が `passed` であること（`gated` の場合は §5）
3. `validation` に **violations がゼロ**であること（flags は警告なので出ていて構いません）

---

## 4. 続けて使う — 履歴を残す

比較は**スナップショットが 2 つ以上**あって初めて成立します。残すには `--store` を付けます。

```bash
agent-eval scan --summary --store
```

これで `~/.agent-eval/` にスナップショットと鍵ができます（中身は [docs/PRIVACY.md §4](PRIVACY.md)）。

### 毎日走らせる

**1 日 1 回**で十分です。窓は「直近 10 稼働日」なので、それ以上細かく回しても窓は動きません。

macOS / Linux（cron、平日 19:00）:

```
0 19 * * 1-5 agent-eval scan --store > /dev/null 2>&1
```

Windows（タスク スケジューラ）:

```powershell
$a = New-ScheduledTaskAction -Execute "agent-eval" `
     -Argument "scan --store"
$t = New-ScheduledTaskTrigger -Daily -At 19:00
Register-ScheduledTask -TaskName "agent-eval" -Action $a -Trigger $t
```

**同じ日に 2 回走らせても、窓は同じです。** 差分はゼロになります（それが正しい挙動です）。

### 残りの引数

| 引数 | いつ使うか |
|---|---|
| `--repo <path>` | そのリポジトリのコミット日を証拠に加える。**繰り返し指定可**。既定では git を見ません |
| `--external-log <path>` | `date` 列を持つ CSV を「記録した日」の証拠にする。`record` の分子になります |
| `--at <iso8601>` | 測定時刻を指定する。**既定は現在時刻**で、通常は触りません |
| `--state-dir <path>` | 履歴の置き場所を変える。`--store` と一緒でないとエラーになります |

`--at` は、**どの日を「今日」とみなすか**を決めます。窓の端と「書きかけの日」の判定がこれで動くので、過去の時刻を渡すとその時点の窓が再現できます。

ただし、**これは数え方（`count-basis`）を変えるものではありません。** 変わるのは「どの日を採るか」だけで、比較は成立します — ただし**中身の違う窓どうしの比較**になるので、履歴を貯める目的で `--at` を動かすのは勧めません。

### 履歴の消し方

```bash
rm -rf ~/.agent-eval        # スナップショットと連鎖
rm -f  ~/.agent-eval-key    # 鍵
```

**消すと戻せません。** 生ログが刈られている以上、後から作り直すことはできません。

---

## 5. うまくいかないとき

### ログが見つからない / `scanned 0 files`

Claude Code をまだほとんど使っていない状態です。**エラーではありません。**

このツールはクラッシュせず、次のように報告します（空のホームで実測）:

- `gate` が `too-few-active-days` で止まる
- `composite` は `null`
- 採点される軸は **0 本**
- 各軸は `unavailableReasons` に理由を持つ（`environment-gated` など）

**やることは「使い続ける」だけ**です。稼働日が貯まれば自然に採点が始まります。

### `gate` の行に `passed` 以外が出る

環境全体が採点対象外と判定された状態です。`gate` の行には、その理由がそのまま並びます（例: `gate       too-few-active-days`）。

| 理由 | 意味 | どうするか |
|---|---|---|
| `too-few-active-days` | 稼働日が **5 日**に届いていない | 使い続ける |
| `parse-failure-rate` | 読めない行が **5%** を超えた | Claude Code のバージョンを確認。issue に貼ってください |

### `axes 0/11 available` なのに `gate passed`

軸ごとの母数が足りていないだけです。理由は軸ごとに出ます（`too-few-clusters` = セッション数不足、`definition-pending` = 未実装、`no-failures` = 失敗が無いので再発を測れない）。

### `vs prev` に `count-basis-changed` と出る

**バグではありません。** 窓の定義や数え方が変わったので、**比較を意図的に拒否しています。** 数字が出ないことより、意味の違う数字が並ぶことのほうが害だからです。次のスナップショットから比較が再開します。

### `unknown argument` / `unknown scan option` で終了する

引数の綴り違いです。終了コードは `2` になります。`--help` を見てください。

**このツールは知らない引数を黙って無視しません。** 無視すると「間違った入力に対する、きれいで正しく見える実行結果」が出てしまうためです。値を取る引数（`--repo` など）に値を渡し忘れた場合も、次のフラグを値として飲み込まずに `--repo needs a value` で止まります。

### `agent-eval` が「見つかりません」

グローバル install の bin が PATH に入っていません。場所を確認して、そこを PATH に加えてください。

```powershell
npm prefix -g          # ここの直下に agent-eval.cmd がある
npm ls -g --depth=0    # パッケージが入っているかの確認
```

経路 B（clone）で使っている場合は、そもそも PATH には入りません。リポジトリ直下で `node dist/cli.js` を使ってください。

---

## 6. アンインストール

```bash
npm uninstall -g @katuyukinoadres-beep/agent-eval   # 経路 B で入れた場合
rm -rf ~/agent-eval                                 # clone したもの
rm -rf ~/.agent-eval ~/.agent-eval-key              # 履歴と鍵
```

**このツールは、上に挙げた場所以外に何も書きません。** レジストリも、設定ファイルも、常駐プロセスもありません。
