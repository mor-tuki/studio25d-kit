# キャラクター（任意）

ここに自分の VRM（VRM 0.x / 1.0）を置き、`studio/studio.config.json` の `character.vrm` に
`"assets/character/<ファイル名>.vrm"` を書くとスタジオに立ちます。空（`null`）なら背景とスライドだけで動きます。

- 背の高さは部屋ごと（`rooms.json` の `actor.height`・m）に合わせて自動で拡大縮小されます。
- VRM 1.0 は `js/vrm1_adapt.js` が向き・腕の符号を自動で合わせます（後ろを向く・腕が上がる問題の対策）。
- 色の補正は `character.materialRules`（`js/material_tune.js` 冒頭に書式）。照明が変わると見え方も変わるので、配信で使う部屋で確かめてください。
- `.vrm` は `.gitignore` 済みです（他人のモデルを誤って公開しないため）。公開してよいモデルだけ明示的に追加してください。
