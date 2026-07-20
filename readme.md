# 割り勘ツール仕様書

## 目的

会食やイベントなどで発生した複数の立替を集計し、各参加者の負担額と精算方法を簡単に算出する。

---

# 技術構成

- Vue 3
- TypeScript
- Tailwind CSS
- フロントエンドのみで計算
- サーバー側には会計データを保存しない
- 入力内容は `localStorage` に保存する（任意）
- 金額はすべて整数（円単位）で扱う

---

# 機能

## 参加者管理

会の参加者を登録する。

### 要件

- traP IDで指定する
- 同一ユーザーは重複登録できない
- 参加者は1人以上

### OAuthによるユーザー取得

traQ OAuthを利用してユーザー情報を取得し、参加者選択時の候補として利用する。

#### 実装

1. traQ BOT ConsoleでOAuth Clientを作成する
2. PKCEを利用したAuthorization Code Flowでログインする
3. traQ APIからユーザー一覧を取得する
4. ユーザー検索（オートコンプリート）で参加者を選択できるようにする

取得する情報

- UUID
- traP ID (`name`)
- 表示名 (`displayName`)

内部ではUUIDを保持し、画面表示・メッセージ生成にはtraP IDを利用する。

### 参考

- https://bot-console.trap.jp/docs/client
- https://q.trap.jp/api/v3

---

## 立替事項

立替事項を1件以上登録できる。

### 入力項目

#### 支払名

例

- 飲み会
- レンタカー
- 食材

#### 支払金額

- 1円以上の整数

#### 立替者

参加者から1人選択する。

#### 負担者

初期状態では参加者全員。

任意の参加者を除外できる。

最低1人は選択されている必要がある。

---

## 丸め

以下から選択できる。

- 丸めなし
- 10円切り上げ
- 10円切り捨て

丸めによる差額は立替者へ反映する。

---

# 計算

各立替について

```
1人当たり負担額 =
支払金額 ÷ 負担人数
```

各参加者について

```
負担額 =
各立替の負担額の合計

立替額 =
立替した金額の合計

収支 =
立替額 - 負担額
```

収支

- 正：受け取る
- 負：支払う
- 0：精算不要

---

# 出力

## 合計金額

表示する内容

- 支払総額
- 人数
- 精算人数

---

## 参加者ごとの結果

表示項目

- 負担額
- 立替額
- 最終収支

例

```
@sahara

負担額
2500円

立替額
6000円

受取額
3500円
```

---

## 精算一覧

送金回数が最小になるよう計算する。

例

```
@alice → @bob 1200円
@charlie → @bob 800円
```

---

# Discordメッセージ生成

精算結果から以下の文章を自動生成する。

```
:one: @alice → @bob 1200円
:two: @charlie → @bob 800円
:three: @dave → @eve 500円
```

コピーしてそのままtraQへ貼り付けられるようにする。

---

# データ構造

## Participant

```ts
type Participant = {
  id: string          // UUID
  name: string        // traP ID
  displayName: string
}
```

---

## Expense

```ts
type Expense = {
  id: string
  title: string
  amount: number
  payerId: string
  participantIds: string[]
}
```

---

## Settlement

```ts
type Settlement = {
  from: string
  to: string
  amount: number
}
```

---

# MVP

- [ ] OAuthログイン
- [ ] ユーザー検索
- [ ] 参加者追加・削除
- [ ] 複数立替登録
- [ ] 負担者選択
- [ ] 合計金額表示
- [ ] 各参加者の収支計算
- [ ] 最小送金計算
- [ ] traQメッセージ生成
- [ ] localStorage保存