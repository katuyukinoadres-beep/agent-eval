# 他のエージェントに広げられるか

「AI エージェントを使っている人すべて」に届けるには、そのエージェントが**ローカルに、ツール呼び出しの粒度で**記録を残している必要があります。スコアの元になるのは会話文ではなく、何を呼んで何が失敗したかだからです。

調べた結果を、根拠の強さ順に並べます。

## このマシンで実測したもの

| ツール | 保存場所 | 実測 |
|---|---|---|
| **Claude Code** | `~/.claude/projects/**/*.jsonl` | **196 MB / 433 ファイル**。会話・ツール呼び出し・結果すべて。**対応済み** |
| **GitHub Copilot CLI** | `~/.copilot/logs/*.log` | **3 ファイル計 1,800 バイト。** 中身はサーバの起動と終了だけ（`Starting CLI in server mode` / `graceful shutdown`）。会話もツール呼び出しも**入っていない** |
| **VS Code のチャット** | `%APPDATA%/Code/User/globalStorage/emptyWindowChatSessions/*.jsonl` ほか | 形式は JSONL で存在する。ただしこのマシンでは 3 件とも 552 バイトの空セッション（使っていないため）。**中身の性質は判定できていない** |

Copilot CLI は「パーサを書いていない」のではなく「**書く対象が存在しない**」状態です。

## 公開情報で確認したもの（このマシンには未インストール）

| ツール | 保存場所 | 形式 | ツール呼び出し |
|---|---|---|---|
| **Codex CLI** | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | JSONL | **あり** |
| **opencode** | `~/.local/share/opencode/opencode.db` | SQLite | あり（JSON テキストで格納） |
| **pi** | `~/.pi/agent/sessions/**/*.jsonl` | JSONL | あり |
| **Amp CLI** | `~/.local/share/amp/threads/T-*.json` | JSON | 部分的。**正本はサーバ側**で、スレッド削除から 30 日で消える |
| **Cursor CLI** | `~/.cursor/chats/<id>/<uuid>/store.db` | SQLite | **不明**。スキーマが公開されていない |
| **Aider** | Markdown | — | 構造化されていない |

未インストールのものは**このマシンでは何も検証していません**。上表は公開情報であり、実測ではありません。

## 結論

**次に対応すべきは Codex CLI です。** 理由は 3 つ。

1. **形式が同じ系統**（1 行 1 JSON）で、走査の仕組みをほぼそのまま使える
2. **ツール呼び出しと結果が入っている** — 空振り率・自己検証率・再発防止がそのまま計算できる
3. 日付ディレクトリを持つので、窓の切り出しが素直

**対応しても意味がないもの**: Copilot CLI（記録が存在しない）、Aider（構造がない）。

**保留**: Cursor（スキーマ非公開のため、動いても壊れやすい）、Amp（正本がサーバ側にあり、30 日で消えるのでローカル解析の前提が崩れる）。

## 注意

`~/.claude` を読む前提が実装のあちこちに入っています。2 つ目のエージェントを入れる前に、**「どのエージェントのログか」を型で持つ**ようにしないと、片方の前提がもう片方に漏れます。これはパーサを増やす作業より先に来ます。

出典:
- [Where Six AI Coding CLIs Store Your Session Logs](https://allaboutcoding.ghinda.com/where-ai-coding-clis-store-session-logs/)
- [codex-trace — Codex CLI session log viewer](https://github.com/PixelPaw-Labs/codex-trace)
- [coding_agent_session_search — 11+ providers](https://github.com/Dicklesworthstone/coding_agent_session_search)
